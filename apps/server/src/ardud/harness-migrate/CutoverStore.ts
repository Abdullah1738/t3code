import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as BoardsDatabase from "../persistence/BoardsDatabase.ts";

import * as ServerConfig from "../../config.ts";
import type { CutoverItem, CutoverPlan } from "./CutoverEngine.ts";

export class CutoverStoreError extends Schema.TaggedError<CutoverStoreError>()(
  "CutoverStoreError",
  {
    operation: Schema.String,
    cause: Schema.Unknown,
  },
) {
  override get message(): string {
    return `Harness cutover storage failed during ${this.operation}.`;
  }
}

export interface CutoverLedgerItem extends CutoverItem {
  readonly state: "planned" | "switched" | "briefed" | "failed";
  readonly phase: "switch" | "brief";
  readonly attempts: number;
  readonly reason: string | null;
  readonly rollbackAttempts: number;
  readonly rolledBack: boolean;
  /**
   * The stored payload is larger than the inline limit. `payload` then holds only its
   * model-selection leaves (enough for readiness rechecks); apply reads the full payload
   * with `CutoverStore.payload` and drops it afterwards.
   */
  readonly payloadDeferred?: boolean;
}

/**
 * Payloads above this many bytes are not kept in memory with the ledger. 7 Nov 2026: the
 * production ledger was 420 MB (one board selection alone 232 MB, ~2,900 pinned-card items of
 * 16-460 KB); re-decoding it every 2 s ran the server out of heap. At 16 KB the in-memory
 * ledger is ~15 MB.
 */
export const DEFAULT_MAX_INLINE_PAYLOAD_BYTES = 16 * 1024;

/** Every `{ instanceId, model, options? }` object in a payload, de-duplicated. */
export const selectionLeaves = (value: unknown): ReadonlyArray<unknown> => {
  const out = new Map<string, unknown>();
  const visit = (entry: unknown): void => {
    if (Array.isArray(entry)) {
      for (const child of entry) visit(child);
      return;
    }
    if (entry === null || typeof entry !== "object") return;
    const record = entry as Record<string, unknown>;
    if (typeof record.instanceId === "string" && typeof record.model === "string") {
      const leaf =
        record.options === undefined
          ? { instanceId: record.instanceId, model: record.model }
          : { instanceId: record.instanceId, model: record.model, options: record.options };
      out.set(JSON.stringify(leaf), leaf);
      return;
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(value);
  return [...out.values()];
};

export interface CutoverSnapshot {
  readonly items: ReadonlyArray<CutoverLedgerItem>;
  readonly refusals: CutoverPlan["refusals"];
  readonly initializing?: boolean;
}

export class CutoverStore extends Context.Service<
  CutoverStore,
  {
    readonly read: () => Effect.Effect<CutoverSnapshot | null, CutoverStoreError>;
    readonly start: (
      items: ReadonlyArray<CutoverItem>,
      refusals: CutoverPlan["refusals"],
    ) => Effect.Effect<CutoverSnapshot, CutoverStoreError>;
    readonly save: (item: CutoverLedgerItem) => Effect.Effect<void, CutoverStoreError>;
    /** The full stored payload of one item (for items read with `payloadDeferred`). */
    readonly payload?: (key: string) => Effect.Effect<unknown, CutoverStoreError>;
  }
>()("t3/ardud/harness-migrate/CutoverStore") {}

const SNAPSHOT_KEY = "__cutover_snapshot__";
const DDL = `CREATE TABLE IF NOT EXISTS ardud_harness_cutover_items (
  item_key TEXT PRIMARY KEY,
  ordinal INTEGER NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  wake INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('planned', 'switched', 'briefed', 'failed')),
  phase TEXT NOT NULL CHECK (phase IN ('switch', 'brief')),
  attempts INTEGER NOT NULL CHECK (attempts BETWEEN 0 AND 3),
  reason TEXT,
  rollback_attempts INTEGER NOT NULL CHECK (rollback_attempts BETWEEN 0 AND 3),
  rolled_back INTEGER NOT NULL CHECK (rolled_back IN (0, 1))
)`;

const Item = Schema.Struct({
  key: Schema.String,
  kind: Schema.Literals(["selection", "thread", "card", "finalize"]),
  ref: Schema.String,
  payload: Schema.Unknown,
  wake: Schema.Boolean,
  state: Schema.Literals(["planned", "switched", "briefed", "failed"]),
  phase: Schema.Literals(["switch", "brief"]),
  attempts: Schema.Int,
  reason: Schema.NullOr(Schema.String),
  rollbackAttempts: Schema.Int,
  rolledBack: Schema.Boolean,
});
const Json = Schema.fromJsonString(Schema.Unknown);
const encodePayload = Schema.encodeEffect(Json);
const decodePayload = Schema.decodeEffect(Json);
const decodeItem = Schema.decodeUnknownEffect(Item);
const Frozen = Schema.Struct({
  version: Schema.Literal(1),
  items: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      kind: Schema.Literals(["selection", "thread", "card", "finalize"]),
      ref: Schema.String,
      payload: Schema.Unknown,
      wake: Schema.Boolean,
    }),
  ),
  refusals: Schema.Array(Schema.Struct({ ref: Schema.String, reason: Schema.String })),
});
const FrozenJson = Schema.fromJsonString(Frozen);
const encodeFrozen = Schema.encodeEffect(FrozenJson);
const decodeFrozen = Schema.decodeEffect(FrozenJson);
const HeaderJson = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    count: Schema.Int,
    ready: Schema.Boolean,
    refusals: Schema.Array(Schema.Struct({ ref: Schema.String, reason: Schema.String })),
  }),
);
const encodeHeader = Schema.encodeEffect(HeaderJson);
const decodeHeader = Schema.decodeEffect(HeaderJson);
const planned = (item: CutoverItem): CutoverLedgerItem => ({
  ...item,
  state: "planned",
  phase: "switch",
  attempts: 0,
  reason: null,
  rollbackAttempts: 0,
  rolledBack: false,
});

interface Row {
  readonly item_key: string;
  readonly kind: string;
  readonly ref: string;
  /** Null when the payload is above the inline limit; read it with `payload(key)`. */
  readonly payload_json: string | null;
  readonly payload_bytes: number;
  readonly wake: number;
  readonly state: string;
  readonly phase: string;
  readonly attempts: number;
  readonly reason: string | null;
  readonly rollback_attempts: number;
  readonly rolled_back: number;
}

const make = Effect.fn("CutoverStore.make")(function* (
  snapshotPath: string,
  maxInlinePayloadBytes: number = DEFAULT_MAX_INLINE_PAYLOAD_BYTES,
) {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lock = yield* Semaphore.make(1);
  const fail = (operation: string) => (cause: unknown) =>
    new CutoverStoreError({ operation, cause });
  const exists =
    sql`SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'ardud_harness_cutover_items'`.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(fail("read-schema")),
    );

  const loadFrozen = Effect.fn("CutoverStore.loadFrozen")(function* () {
    if (!(yield* fs.exists(snapshotPath).pipe(Effect.mapError(fail("snapshot-exists")))))
      return null;
    return yield* fs
      .readFileString(snapshotPath)
      .pipe(Effect.flatMap(decodeFrozen), Effect.mapError(fail("read-frozen-plan")));
  });

  const freeze = Effect.fn("CutoverStore.freeze")(
    function* (items: ReadonlyArray<CutoverItem>, refusals: CutoverPlan["refusals"]) {
      const text = yield* encodeFrozen({ version: 1, items, refusals }).pipe(
        Effect.mapError(fail("encode-frozen-plan")),
      );
      const directory = path.dirname(snapshotPath);
      yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
      const temporary = yield* fs.makeTempFileScoped({ directory, prefix: ".cutover-plan-" });
      yield* fs.chmod(temporary, 0o600);
      const handle = yield* fs.open(temporary, { flag: "w", mode: 0o600 });
      yield* handle.writeAll(Buffer.from(text, "utf8"));
      yield* handle.sync;
      // link publishes only a fully fsynced file and cannot replace another frozen snapshot.
      const linked = yield* fs.link(temporary, snapshotPath).pipe(Effect.result);
      if (linked._tag === "Failure") return yield* linked.failure;
      const parent = yield* fs.open(directory, { flag: "r" });
      yield* parent.sync;
    },
    Effect.scoped,
    Effect.mapError(fail("freeze-plan")),
  );

  // Stored payloads never change after import, so the selection leaves of a large one are
  // computed once per process instead of decoding hundreds of MB on every read.
  const leavesCache = new Map<string, ReadonlyArray<unknown>>();
  const payload = Effect.fn("CutoverStore.payload")(function* (key: string) {
    const rows = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM ardud_harness_cutover_items WHERE item_key = ${key} AND kind != 'snapshot'`.pipe(
      Effect.mapError(fail("read-payload")),
    );
    const row = rows[0];
    if (row === undefined)
      return yield* new CutoverStoreError({
        operation: "read-payload",
        cause: "Missing cutover item",
      });
    return yield* decodePayload(row.payload_json).pipe(Effect.mapError(fail("decode-payload")));
  });
  // SQLite walks the large payload, so it never enters the JS heap. Selections do not nest
  // (their options are { id, value } objects), so every matching object is a leaf.
  const payload_ = Effect.fn("CutoverStore.payloadLeaves")(function* (key: string) {
    const cached = leavesCache.get(key);
    if (cached !== undefined) return cached;
    const rows = yield* sql<{
      instance_id: string;
      model: string;
      options: string | null;
    }>`SELECT DISTINCT json_extract(t.value, '$.instanceId') AS instance_id,
          json_extract(t.value, '$.model') AS model,
          json_extract(t.value, '$.options') AS options
        FROM ardud_harness_cutover_items i, json_tree(i.payload_json) t
        WHERE i.item_key = ${key} AND i.kind != 'snapshot' AND t.type = 'object'
          AND json_type(t.value, '$.instanceId') = 'text' AND json_type(t.value, '$.model') = 'text'`.pipe(
      Effect.mapError(fail("read-payload-leaves")),
    );
    const leaves: Array<unknown> = [];
    for (const row of rows) {
      const options =
        row.options === null
          ? undefined
          : yield* decodePayload(row.options).pipe(Effect.mapError(fail("decode-payload-leaves")));
      leaves.push(
        options === undefined
          ? { instanceId: row.instance_id, model: row.model }
          : { instanceId: row.instance_id, model: row.model, options },
      );
    }
    leavesCache.set(key, leaves);
    return leaves;
  });

  const read = Effect.fn("CutoverStore.read")(function* () {
    if (!(yield* exists)) {
      const frozen = yield* loadFrozen();
      return frozen === null
        ? null
        : {
            items: frozen.items.map(planned),
            refusals: frozen.refusals,
            initializing: true,
          };
    }
    // Large payloads (whole-board snapshots) stay on disk: only their selection leaves are kept.
    const rows = yield* sql<Row>`SELECT item_key, kind, ref,
        CASE WHEN length(CAST(payload_json AS BLOB)) > ${maxInlinePayloadBytes} THEN NULL ELSE payload_json END AS payload_json,
        length(CAST(payload_json AS BLOB)) AS payload_bytes,
        wake, state, phase, attempts, reason, rollback_attempts, rolled_back
      FROM ardud_harness_cutover_items ORDER BY ordinal`.pipe(Effect.mapError(fail("read-items")));
    const marker = rows.find((row) => row.item_key === SNAPSHOT_KEY);
    if (!marker || marker.payload_json === null)
      return yield* new CutoverStoreError({
        operation: "read-snapshot",
        cause: "Missing snapshot marker",
      });
    const header = yield* decodeHeader(marker.payload_json).pipe(
      Effect.mapError(fail("decode-header")),
    );
    const items = yield* Effect.forEach(
      rows.filter((row) => row.item_key !== SNAPSHOT_KEY),
      (row) =>
        Effect.gen(function* () {
          const deferred = row.payload_json === null;
          const payload = deferred
            ? yield* payload_(row.item_key)
            : yield* decodePayload(row.payload_json!);
          const item = yield* decodeItem({
            key: row.item_key,
            kind: row.kind,
            ref: row.ref,
            payload,
            wake: row.wake === 1,
            state: row.state,
            phase: row.phase,
            attempts: row.attempts,
            reason: row.reason,
            rollbackAttempts: row.rollback_attempts,
            rolledBack: row.rolled_back === 1,
          });
          return deferred ? { ...item, payloadDeferred: true } : item;
        }).pipe(Effect.mapError(fail("decode-item"))),
    );
    if (header.ready) {
      if (items.length !== header.count)
        return yield* new CutoverStoreError({
          operation: "read-count",
          cause: "Snapshot row count mismatch",
        });
      return { items, refusals: header.refusals };
    }
    const frozen = yield* loadFrozen();
    if (frozen === null || frozen.items.length !== header.count)
      return yield* new CutoverStoreError({
        operation: "read-loading",
        cause: "Frozen snapshot missing or mismatched",
      });
    const byKey = new Map(items.map((item) => [item.key, item]));
    return {
      items: frozen.items.map((item) => byKey.get(item.key) ?? planned(item)),
      refusals: frozen.refusals,
      initializing: true,
    };
  });

  const start = Effect.fn("CutoverStore.start")(function* (
    items: ReadonlyArray<CutoverItem>,
    refusals: CutoverPlan["refusals"],
  ) {
    const current = yield* read();
    if (current !== null && !current.initializing) return current;
    const frozen = yield* loadFrozen();
    const sourceItems = frozen?.items ?? items;
    const sourceRefusals = frozen?.refusals ?? refusals;
    const keys = new Set(sourceItems.map((item) => item.key));
    if (keys.size !== sourceItems.length || keys.has(SNAPSHOT_KEY) || keys.has("")) {
      return yield* new CutoverStoreError({
        operation: "validate-keys",
        cause: "Duplicate or reserved item key",
      });
    }
    // Encode before DDL so malformed payloads cannot leave a partial job or claims behind.
    const encoded = yield* Effect.forEach(sourceItems, (item) =>
      encodePayload(item.payload).pipe(Effect.mapError(fail("encode-item"))),
    );
    if (frozen === null) yield* freeze(sourceItems, sourceRefusals);
    const loadingHeader = yield* encodeHeader({
      version: 1,
      count: sourceItems.length,
      ready: false,
      refusals: sourceRefusals,
    }).pipe(Effect.mapError(fail("encode-header")));
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql.unsafe(DDL);
          const present =
            yield* sql`SELECT 1 FROM ardud_harness_cutover_items WHERE item_key = ${SNAPSHOT_KEY}`;
          if (present.length > 0) return;
          // Large payloads stay outside the shared SQLite writer until bounded import batches.
          yield* sql`INSERT INTO ardud_harness_cutover_items VALUES (
        ${SNAPSHOT_KEY}, -1, 'snapshot', '', ${loadingHeader}, 0, 'planned', 'switch', 0, NULL, 0, 0
      )`;
        }),
      )
      .pipe(Effect.mapError(fail("start-snapshot")));
    for (let offset = 0; offset < sourceItems.length; offset += 8) {
      const batch = sourceItems.slice(offset, offset + 8);
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            for (const [index, item] of batch.entries()) {
              yield* sql`INSERT OR IGNORE INTO ardud_harness_cutover_items VALUES (
            ${item.key}, ${offset + index}, ${item.kind}, ${item.ref}, ${encoded[offset + index]!}, ${item.wake ? 1 : 0},
            'planned', 'switch', 0, NULL, 0, 0
          )`;
            }
          }),
        )
        .pipe(Effect.mapError(fail("import-snapshot")));
    }
    const readyHeader = yield* encodeHeader({
      version: 1,
      count: sourceItems.length,
      ready: true,
      refusals: sourceRefusals,
    }).pipe(Effect.mapError(fail("encode-header")));
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const count = yield* sql<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM ardud_harness_cutover_items WHERE item_key != ${SNAPSHOT_KEY}`;
          if (count[0]?.count !== sourceItems.length)
            return yield* new CutoverStoreError({
              operation: "import-count",
              cause: "Snapshot incomplete",
            });
          yield* sql`UPDATE ardud_harness_cutover_items SET payload_json = ${readyHeader} WHERE item_key = ${SNAPSHOT_KEY}`;
        }),
      )
      .pipe(Effect.mapError(fail("ready-snapshot")));
    return (yield* read())!;
  }, lock.withPermits(1));

  const save = Effect.fn("CutoverStore.save")(function* (item: CutoverLedgerItem) {
    const rows = yield* sql`UPDATE ardud_harness_cutover_items
      SET state = ${item.state}, phase = ${item.phase}, attempts = ${item.attempts}, reason = ${item.reason},
          rollback_attempts = ${item.rollbackAttempts}, rolled_back = ${item.rolledBack ? 1 : 0}
      WHERE item_key = ${item.key} AND kind != 'snapshot'
      RETURNING item_key`.pipe(Effect.mapError(fail("save-item")));
    if (rows.length !== 1)
      return yield* new CutoverStoreError({
        operation: "save-item",
        cause: "Missing cutover item",
      });
  });

  return CutoverStore.of({ read, start, save, payload });
});

export const layerWithOptions = (options: {
  readonly snapshotPath: string;
  readonly maxInlinePayloadBytes?: number;
}) => Layer.effect(CutoverStore, make(options.snapshotPath, options.maxInlinePayloadBytes));
export const layer = Layer.effect(
  CutoverStore,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const sql = yield* BoardsDatabase.client;
    return yield* make(path.join(config.stateDir, "harness-cutover-plan.json")).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
  }),
);
