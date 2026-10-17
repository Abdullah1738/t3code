import {
  MissionError,
  type Approval,
  type MissionActor,
  type MissionEventKind,
  type MissionId,
  type MissionRecordRef,
  type ReadPosition,
  type Room,
  type Subscription,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { MissionStore } from "../store/MissionStore.ts";
import type { MissionStoreKind, MissionStoreRecord } from "../store/recordIndex.ts";
import { actorKey, IMPORT_COMPONENT } from "./coordIds.ts";
import type { ImportPlan, MessageWithBody, RouterImport } from "./mapping.ts";

/**
 * Applies an import plan. Core records go through `MissionStore.commit`; the
 * router's rooms, messages, subscriptions and read positions go through a
 * `RouterImportSink`, written alongside an `import.applied` event so both land
 * in one transaction.
 *
 * The import only creates what is missing. A record that already exists is
 * never overwritten (it is reported as `differs` when it no longer matches),
 * so a re-run creates nothing and owner edits made in Robob survive. The one
 * update it makes is closing a still-pending crw approval the sources now show
 * as stale.
 */

export type RouterImportKind = "room" | "message" | "subscription" | "read-position";

/** What the router must provide for the import. Writes must be create-if-missing. */
export interface RouterImportSink {
  /** Which of these ids already exist. Read position ids come from `readPositionId`. */
  readonly existing: (
    kind: RouterImportKind,
    ids: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlySet<string>, MissionError>;
  /** Runs inside the store transaction of the matching `import.applied` commit. */
  readonly write: (batch: RouterImport) => Effect.Effect<void, MissionError>;
}

export const readPositionId = (p: { readonly roomId: string; readonly reader: MissionActor }) =>
  `${p.roomId}|${actorKey(p.reader)}`;

export interface KindDiff {
  readonly kind: string;
  readonly planned: number;
  readonly create: number;
  readonly unchanged: number;
  /** Exists with different content; left as it is. */
  readonly differs: number;
  /** Pending crw approvals the sources show as stale; closed on write. */
  readonly close: number;
  readonly differIds: ReadonlyArray<string>;
}

export interface ImportDiff {
  readonly kinds: ReadonlyArray<KindDiff>;
  /** Router parts are not diffed when no sink is available. */
  readonly routerAvailable: boolean;
}

export interface ApplyResult {
  readonly diff: ImportDiff;
  readonly commits: number;
  readonly created: Readonly<Record<string, number>>;
  readonly closed: number;
}

const CHUNK = 500;
const BATCH = 250;
const MESSAGE_BATCH = 1000;

const chunks = <T>(items: ReadonlyArray<T>, size: number): Array<ReadonlyArray<T>> => {
  const out: Array<ReadonlyArray<T>> = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

/** JSON with sorted keys, so records compare by content. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );

type CorePlanned = {
  readonly kind: MissionStoreKind;
  readonly records: ReadonlyArray<MissionStoreRecord>;
};

const corePlanned = (plan: ImportPlan): ReadonlyArray<CorePlanned> => {
  const c = plan.core;
  return [
    { kind: "mission", records: [{ _tag: "mission", record: c.mission }] },
    { kind: "role", records: c.roles.map((record) => ({ _tag: "role", record })) },
    {
      kind: "role-binding",
      records: c.bindings.map((record) => ({ _tag: "role-binding", record })),
    },
    { kind: "lane", records: c.lanes.map((record) => ({ _tag: "lane", record })) },
    { kind: "rule", records: c.rules.map((record) => ({ _tag: "rule", record })) },
    { kind: "work-item", records: c.workItems.map((record) => ({ _tag: "work-item", record })) },
    { kind: "approval", records: c.approvals.map((record) => ({ _tag: "approval", record })) },
  ];
};

const recordId = (entry: MissionStoreRecord): string =>
  (entry.record as { readonly id: string }).id;

interface CoreState {
  readonly diff: KindDiff;
  readonly create: ReadonlyArray<MissionStoreRecord>;
  readonly close: ReadonlyArray<Approval>;
}

const diffCore = (planned: CorePlanned) =>
  Effect.gen(function* () {
    const store = yield* MissionStore;
    const existing = new Map<string, unknown>();
    for (const ids of chunks(planned.records.map(recordId), CHUNK)) {
      const found = yield* store.list(planned.kind, { ids, limit: CHUNK });
      for (const record of found) existing.set((record as { readonly id: string }).id, record);
    }
    const create: Array<MissionStoreRecord> = [];
    const close: Array<Approval> = [];
    const differIds: Array<string> = [];
    let unchanged = 0;
    for (const entry of planned.records) {
      const id = recordId(entry);
      const current = existing.get(id);
      if (current === undefined) {
        create.push(entry);
      } else if (canonical(current) === canonical(entry.record)) {
        unchanged++;
      } else if (
        entry._tag === "approval" &&
        entry.record.status === "stale-closed" &&
        (current as Approval).status === "pending" &&
        (current as Approval).requestedBy === "crw"
      ) {
        close.push({
          ...(current as Approval),
          status: "stale-closed",
          staleReason: entry.record.staleReason,
          decidedBy: entry.record.decidedBy,
          decidedAt: entry.record.decidedAt,
        });
      } else {
        differIds.push(id);
      }
    }
    return {
      diff: {
        kind: planned.kind,
        planned: planned.records.length,
        create: create.length,
        unchanged,
        differs: differIds.length,
        close: close.length,
        differIds,
      },
      create,
      close,
    } satisfies CoreState;
  });

interface RouterState {
  readonly diffs: ReadonlyArray<KindDiff>;
  readonly create: RouterImport;
}

const diffRouter = (plan: ImportPlan, sink: RouterImportSink) =>
  Effect.gen(function* () {
    const missing = <T>(
      kind: RouterImportKind,
      items: ReadonlyArray<T>,
      idOf: (item: T) => string,
    ) =>
      Effect.gen(function* () {
        const found = new Set<string>();
        for (const part of chunks(items.map(idOf), CHUNK)) {
          for (const id of yield* sink.existing(kind, part)) found.add(id);
        }
        const create = items.filter((item) => !found.has(idOf(item)));
        const diff: KindDiff = {
          kind,
          planned: items.length,
          create: create.length,
          unchanged: items.length - create.length,
          differs: 0,
          close: 0,
          differIds: [],
        };
        return { create, diff };
      });
    const rooms = yield* missing("room", plan.router.rooms, (r: Room) => r.id);
    const messages = yield* missing(
      "message",
      plan.router.messages,
      (m: MessageWithBody) => m.message.id,
    );
    const subscriptions = yield* missing(
      "subscription",
      plan.router.subscriptions,
      (s: Subscription) => s.id,
    );
    const readPositions = yield* missing(
      "read-position",
      plan.router.readPositions,
      (p: ReadPosition) => readPositionId(p),
    );
    return {
      diffs: [rooms.diff, messages.diff, subscriptions.diff, readPositions.diff],
      create: {
        rooms: rooms.create,
        messages: messages.create,
        subscriptions: subscriptions.create,
        readPositions: readPositions.create,
      },
    } satisfies RouterState;
  });

const plan$ = (plan: ImportPlan, sink: RouterImportSink | null) =>
  Effect.gen(function* () {
    const core = yield* Effect.forEach(corePlanned(plan), diffCore);
    const router = sink === null ? null : yield* diffRouter(plan, sink);
    const diff: ImportDiff = {
      kinds: [...core.map((c) => c.diff), ...(router?.diffs ?? [])],
      routerAvailable: sink !== null,
    };
    return { core, router, diff };
  });

/** Compares the plan with what the store (and router) already hold. Writes nothing. */
export const diffImport = (plan: ImportPlan, sink: RouterImportSink | null) =>
  plan$(plan, sink).pipe(Effect.map((p) => p.diff));

const SOURCES: Readonly<Record<string, string>> = {
  mission: "coord.db",
  role: "coord.db, lane-pulse.json",
  "role-binding": "coord.db",
  lane: "coord.db, lane-pulse.json, LANE-ROSTER.md",
  rule: "STANDING-RULES.md",
  "work-item": "DEFERRED.md",
  approval: "crw.db",
  room: "coord.db",
};

const draft = (
  missionId: MissionId,
  kind: MissionEventKind,
  source: string,
  summary: string,
  payload: unknown,
  subject: MissionRecordRef | null = null,
) => ({
  missionId,
  kind,
  actor: { _tag: "system", component: IMPORT_COMPONENT } as const,
  provenance: { _tag: "import", source } as const,
  summary,
  subject,
  payload,
});

/** Writes what is missing. Re-running with the same sources commits nothing. */
export const applyImport = (plan: ImportPlan, sink: RouterImportSink | null) =>
  Effect.gen(function* () {
    const store = yield* MissionStore;
    const state = yield* plan$(plan, sink);
    const created: Record<string, number> = {};
    let commits = 0;
    let closed = 0;

    for (const { diff, create, close } of state.core) {
      for (const batch of chunks(create, BATCH)) {
        yield* store.commit({
          event: draft(
            plan.missionId,
            "import.applied",
            SOURCES[diff.kind] ?? "coord",
            `Imported ${batch.length} ${diff.kind} record${batch.length === 1 ? "" : "s"} from coord`,
            { kind: diff.kind, count: batch.length, asOf: plan.asOf },
            diff.kind === "mission" ? { kind: "mission", id: plan.missionId } : null,
          ),
          upserts: batch,
        });
        commits++;
        created[diff.kind] = (created[diff.kind] ?? 0) + batch.length;
      }
      for (const approval of close) {
        yield* store.commit({
          event: draft(
            plan.missionId,
            "approval.decided",
            "crw.db",
            `Closed as stale: ${approval.title}`,
            { status: "stale-closed", staleReason: approval.staleReason },
            { kind: "approval", id: approval.id },
          ),
          upserts: [{ _tag: "approval", record: approval }],
        });
        commits++;
        closed++;
      }
    }

    if (state.router !== null && sink !== null) {
      const r = state.router.create;
      const head = {
        rooms: r.rooms,
        subscriptions: r.subscriptions,
        readPositions: [],
        messages: [],
      };
      const writeRouter = (batch: RouterImport, summary: string, payload: unknown) =>
        store.commit({
          event: draft(plan.missionId, "import.applied", "coord.db", summary, payload),
          alongside: sink.write(batch),
        });
      if (head.rooms.length + head.subscriptions.length > 0) {
        yield* writeRouter(
          head,
          `Imported ${head.rooms.length} rooms and ${head.subscriptions.length} subscriptions from coord`,
          {
            kind: "room",
            rooms: head.rooms.length,
            subscriptions: head.subscriptions.length,
            asOf: plan.asOf,
          },
        );
        commits++;
        created.room = head.rooms.length;
        created.subscription = head.subscriptions.length;
      }
      for (const batch of chunks(r.messages, MESSAGE_BATCH)) {
        yield* writeRouter(
          { rooms: [], subscriptions: [], readPositions: [], messages: batch },
          `Imported coord messages ${batch[0]!.message.seq}-${batch.at(-1)!.message.seq}`,
          {
            kind: "message",
            count: batch.length,
            fromSeq: batch[0]!.message.seq,
            toSeq: batch.at(-1)!.message.seq,
          },
        );
        commits++;
        created.message = (created.message ?? 0) + batch.length;
      }
      // Read positions last, so they never point past an unwritten message.
      if (r.readPositions.length > 0) {
        yield* writeRouter(
          { rooms: [], subscriptions: [], messages: [], readPositions: r.readPositions },
          `Imported ${r.readPositions.length} read positions from coord acks`,
          { kind: "read-position", count: r.readPositions.length, asOf: plan.asOf },
        );
        commits++;
        created["read-position"] = r.readPositions.length;
      }
    }

    return { diff: state.diff, commits, created, closed } satisfies ApplyResult;
  });

/** In-memory sink, for tests and for dry runs that diff against an empty router. */
export const memoryRouterSink = () => {
  const rooms = new Map<string, Room>();
  const messages = new Map<string, MessageWithBody>();
  const subscriptions = new Map<string, Subscription>();
  const readPositions = new Map<string, ReadPosition>();
  const sink: RouterImportSink = {
    existing: (kind, ids) =>
      Effect.sync(() => {
        const map =
          kind === "room"
            ? rooms
            : kind === "message"
              ? messages
              : kind === "subscription"
                ? subscriptions
                : readPositions;
        return new Set(ids.filter((id) => map.has(id)));
      }),
    write: (batch) =>
      Effect.sync(() => {
        for (const r of batch.rooms) if (!rooms.has(r.id)) rooms.set(r.id, r);
        for (const m of batch.messages)
          if (!messages.has(m.message.id)) messages.set(m.message.id, m);
        for (const s of batch.subscriptions)
          if (!subscriptions.has(s.id)) subscriptions.set(s.id, s);
        for (const p of batch.readPositions) {
          const id = readPositionId(p);
          if (!readPositions.has(id)) readPositions.set(id, p);
        }
      }),
  };
  return { sink, rooms, messages, subscriptions, readPositions };
};

/** Fails the commit, for tests that check nothing is half-written. */
export const failingWrite = (detail: string) =>
  Effect.fail(new MissionError({ code: "invalid", detail }));
