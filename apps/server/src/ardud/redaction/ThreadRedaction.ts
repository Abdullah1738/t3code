import { resolveClaudeHomePath } from "../../provider/Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "../../provider/Drivers/CodexHomeLayout.ts";
import { resolveManagedCodexHomeLayout } from "../../provider/CodexManagedHome.ts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SharedObservability from "@t3tools/shared/observability";
import * as ServerLogFile from "../observability/serverLogFile.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import { withWriter, withStores, RedactionStoresError, makeStoreCleanup } from "./stores.ts";
import * as ReadonlyReplica from "../persistence/ReadonlyReplica.ts";
import { ArchiveSnapshotGate } from "../persistence/archiveSnapshotGate.ts";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
// @effect-diagnostics nodeBuiltinImport:off - Atomic fsync/rename and byte-preserving fixture verification require native file handles.
import * as CommandOutputHub from "../../orchestration-v2/CommandOutputHub.ts";
import {
  ClaudeSettings,
  CodexSettings,
  ProviderInstanceId,
  EventId,
  ThreadId,
  OrchestrationV2TurnItemJson,
  OrchestrationV2DomainEventJson,
  ThreadRedactionInput,
  type ThreadRedactionResult,
  type ThreadRedactionCount,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as ServerConfig from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as ThreadCommandExecutor from "../../orchestration-v2/ThreadCommandExecutor.ts";
import {
  identifies,
  parseJson,
  DuplicateJsonKeyError,
  LossyJsonNumberError,
  outputs,
  replaceText,
  replaceValue,
  providerItemIds,
  replaceScalarText,
  structuralCollision,
  sameStructure,
} from "./content.ts";
import {
  claudeTaskFiles,
  countFile,
  filesBelow,
  planFile,
  providerResult,
  readNeedle,
  readTextFile,
  rewriteFile,
} from "./providerFiles.ts";

export class ThreadRedactionError extends Schema.TaggedError<ThreadRedactionError>()(
  "ThreadRedactionError",
  {
    stage: Schema.optional(Schema.String),
    code: Schema.Literals([
      "invalid",
      "not_found",
      "ambiguous",
      "running",
      "maintenance_required",
      "recovery_required",
      "failed",
    ]),
  },
) {
  override get message() {
    switch (this.code) {
      case "running":
        return "Stop or interrupt the thread, its background work, dependent forks, and shared provider sessions before redacting an item.";
      case "not_found":
        return "No matching output item was found.";
      case "ambiguous":
        return "The item id matches more than one output item.";
      case "maintenance_required":
        return "Storage maintenance could not be acquired or completed. Stop writers and retry; incomplete operations require recovery.";
      case "recovery_required":
        return "An incomplete redaction must be recovered before continuing. Retry the same item id on the original server; after restart, explicit maintenance recovery is required.";
      case "invalid":
        return "Invalid redaction request or structural-field collision. Use a short plain reason and an owned 0600 needle file.";
      default:
        return "Redaction did not complete. Inspect count-only verification and retry after stopping writers.";
    }
  }
}

const decodeClaudeSettings = Schema.decodeUnknownEffect(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownEffect(CodexSettings);
const isThreadRedactionError = Schema.is(ThreadRedactionError);
const isTurnItemJson = Schema.is(OrchestrationV2TurnItemJson);
const isDomainEventJson = Schema.is(OrchestrationV2DomainEventJson);
const validRewrite = (before: unknown, after: unknown) =>
  sameStructure(before, after) &&
  (!isTurnItemJson(before) || isTurnItemJson(after)) &&
  (!isDomainEventJson(before) || isDomainEventJson(after));

const isStoreMaintenanceError = Schema.is(
  Schema.Union([
    RedactionStoresError,
    ReadonlyReplica.ReadonlyReplicaMaintenanceError,
    SharedObservability.TraceMaintenanceError,
  ]),
);

export class ThreadRedaction extends Context.Service<
  ThreadRedaction,
  {
    readonly redactItem: (
      input: ThreadRedactionInput,
    ) => Effect.Effect<ThreadRedactionResult, ThreadRedactionError>;
  }
>()("t3/ardud/redaction/ThreadRedaction") {}

type Row = Record<string, unknown>;
interface Table {
  db: string;
  name: string;
  columns: string[];
  fields: string[];
  jsonColumns: string[];
  scope: string[];
  keys: string[];
  label: string;
}
const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;
const fullName = (table: Table) => `${quote(table.db)}.${quote(table.name)}`;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const parse = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  try {
    return parseJson(value);
  } catch (error) {
    if (error instanceof DuplicateJsonKeyError || error instanceof LossyJsonNumberError)
      throw error;
    return value;
  }
};
const payload = (row: Row) => parse(row.payload_json);
const record = (v: unknown): Row => (v && typeof v === "object" ? (v as Row) : {});
const isTurnItemTable = (name: string) =>
  name.endsWith("projection_turn_items") || name === "ardud_turn_items";
const advanceRevision = (previous: unknown, now: string) => {
  const parsed = typeof previous === "string" ? DateTime.make(previous) : Option.none();
  return DateTime.formatIso(
    DateTime.makeUnsafe(
      Math.max(
        Option.isSome(parsed) ? DateTime.toEpochMillis(parsed.value) + 1 : 0,
        DateTime.toEpochMillis(DateTime.makeUnsafe(now)),
      ),
    ),
  );
};
interface ItemRevision {
  readonly at: string;
  readonly types: ReadonlySet<string>;
}
const itemEnvelopes = new Set([
  "payload",
  "item",
  "activity",
  "data",
  "tool",
  "state",
  "items",
  "activities",
  "turnItems",
  "visibleTurnItems",
]);
const reviseItems = (value: unknown, revisions: ReadonlyMap<string, ItemRevision>): unknown => {
  if (Array.isArray(value)) {
    const revised = value.map((v) => reviseItems(v, revisions));
    return revised.some((v, i) => v !== value[i]) ? revised : value;
  }
  if (!value || typeof value !== "object") return value;
  const fields = record(value);
  const revision =
    typeof fields.id === "string" && typeof fields.type === "string"
      ? revisions.get(fields.id)
      : undefined;
  if (revision && typeof fields.type === "string" && revision.types.has(fields.type))
    return fields.updatedAt === revision.at ? value : { ...fields, updatedAt: revision.at };
  const entries = Object.entries(fields).map(
    ([key, v]) => [key, itemEnvelopes.has(key) ? reviseItems(v, revisions) : v] as const,
  );
  const changed = entries.some(([key, v]) => v !== fields[key]);
  return changed ? Object.fromEntries(entries) : value;
};
const active = new Set([
  "preparing",
  "streaming",
  "queued",
  "pending",
  "requested",
  "starting",
  "running",
  "waiting",
  "active",
  "interrupting",
]);

const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const writer = yield* SqlClient.SqlClient;
  const replica = yield* ReadonlyReplica.ReadonlyReplica;
  const traceMaintenance = yield* SharedObservability.TraceStorageMaintenance;
  const serverLogs = yield* Effect.serviceOption(ServerLogFile.Maintenance);
  const traces = {
    withMaintenance: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      traceMaintenance.withMaintenance(
        Option.isSome(serverLogs) ? serverLogs.value.withMaintenance(effect) : effect,
      ),
  };
  const snapshotGate = yield* Effect.serviceOption(ArchiveSnapshotGate);
  const storeCleanup = makeStoreCleanup();
  const withSnapshot = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Option.isSome(snapshotGate) ? snapshotGate.value.withPermits(1)(effect) : effect;
  const config = yield* ServerConfig.ServerConfig;
  const settingsService = yield* ServerSettingsService;
  const events = yield* EventStore.EventStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const outputHub = yield* CommandOutputHub.CommandOutputHub;
  const providerLogs = yield* ProviderEventLoggers.ProviderEventLoggers;
  // Recovery strings never leave this service instance or enter durable state.
  const recoveryNeedles = new Map<
    string,
    { itemId: string; phase: "preparing" | "rewriting"; needles: readonly string[] }
  >();
  const generatedMarkers = new Map<string, Set<string>>();
  const withLogsPaused: ProviderEventLoggers.ProviderLogMaintenance =
    providerLogs.withMaintenance ??
    ((_threadId, effect) =>
      providerLogs.native || providerLogs.canonical
        ? Effect.fail(new ProviderEventLoggers.ProviderLogMaintenanceError({}))
        : effect);
  const io = <A>(f: () => Promise<A>) =>
    Effect.tryPromise({ try: f, catch: () => new ThreadRedactionError({ code: "failed" }) });

  const redactItem = Effect.fn("ThreadRedaction.redactItem")(function* (
    input: ThreadRedactionInput,
  ) {
    let stage = "prepare";
    const affectedThreads = new Set<ThreadId>([input.threadId]);
    let invalidateProviderWrites = false;
    return yield* executor
      .withLock(
        input.threadId,
        replica.withMaintenance(
          withSnapshot(
            withWriter(writer, (sql) => {
              const work = Effect.uninterruptibleMask((restore) =>
                Effect.gen(function* () {
                  if (!/^[a-zA-Z0-9 ._()-]{1,160}$/.test(input.reason))
                    return yield* new ThreadRedactionError({ code: "invalid" });
                  const now = yield* DateTime.now;
                  const at = DateTime.formatIso(now);
                  const marker = `[redacted ${at}: ${input.reason}]`;
                  const extra = input.needleFile
                    ? [yield* io(() => readNeedle(input.needleFile!))]
                    : [];
                  const replicaPath =
                    process.env.ROBOB_READONLY_DB ??
                    NodePath.join(config.stateDir, "readonly", "state.sqlite");
                  let clearEarly = false;
                  const result = yield* restore(
                    traces.withMaintenance(
                      withStores(
                        sql,
                        replicaPath,
                        (storage) => {
                          const hasArchive = storage.some((d) => d.db === "ardud_archive");
                          return Effect.gen(function* () {
                            yield* sql`CREATE TABLE IF NOT EXISTS ardud_thread_redaction_recovery (
            thread_id TEXT PRIMARY KEY, item_id TEXT NOT NULL, pending INTEGER NOT NULL)`;
                            const recovery = yield* sql<{
                              item_id: string;
                              pending: number;
                            }>`SELECT item_id,pending FROM ardud_thread_redaction_recovery WHERE thread_id = ${input.threadId}`;
                            const wasPending = recovery[0]?.pending === 1;
                            const retained = wasPending
                              ? recoveryNeedles.get(input.threadId)
                              : undefined;
                            if (
                              wasPending &&
                              (recovery[0]?.item_id !== input.itemId ||
                                retained?.itemId !== input.itemId)
                            )
                              return yield* new ThreadRedactionError({
                                code: "recovery_required",
                              });
                            clearEarly = !wasPending;
                            if (!wasPending)
                              recoveryNeedles.set(input.threadId, {
                                itemId: input.itemId,
                                phase: "preparing",
                                needles: [],
                              });
                            yield* sql`INSERT INTO ardud_thread_redaction_recovery (thread_id,item_id,pending) VALUES (${input.threadId},${input.itemId},1)
            ON CONFLICT(thread_id) DO UPDATE SET item_id=excluded.item_id,pending=1`;
                            return yield* Effect.gen(function* () {
                              const stores: ThreadRedactionCount[] = [];
                              const plans: Awaited<ReturnType<typeof planFile>>[] = [];
                              const providers: ThreadRedactionResult["providers"][number][] = [];
                              let resolvedId = input.itemId;
                              let needles: string[] = [];
                              yield* Effect.uninterruptibleMask((restore) =>
                                Effect.gen(function* () {
                                  const published = yield* sql.withTransaction(
                                    restore(
                                      Effect.gen(function* () {
                                        stage = "inventory";
                                        const tables: Table[] = [];
                                        for (const store of storage) {
                                          const db = store.db;
                                          yield* sql.unsafe(
                                            `PRAGMA ${quote(db)}.secure_delete = ON`,
                                          );
                                          const names = yield* sql.unsafe<{ name: string }>(
                                            `SELECT name FROM ${quote(db)}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
                                          );
                                          for (const { name } of names) {
                                            const cols = yield* sql.unsafe<{
                                              name: string;
                                              type: string;
                                              pk: number;
                                            }>(`PRAGMA ${quote(db)}.table_info(${quote(name)})`);
                                            const scope = cols
                                              .filter((c) =>
                                                [
                                                  "thread_id",
                                                  "stream_id",
                                                  "aggregate_id",
                                                  "source_thread_id",
                                                  "target_thread_id",
                                                ].includes(c.name),
                                              )
                                              .map((c) => c.name);
                                            if (
                                              !scope.length &&
                                              !cols.some((c) =>
                                                [
                                                  "provider_thread_id",
                                                  "provider_session_id",
                                                ].includes(c.name),
                                              )
                                            )
                                              continue;
                                            const columns = cols
                                              .filter(
                                                (c) =>
                                                  /TEXT|JSON|CHAR/i.test(c.type) &&
                                                  !/(?:_id|_at)$|^(?:id|status|kind|type|provider|driver|provider_name|adapter_key|runtime_mode|event_type|command_type|effect_type|role|tone|name)$/.test(
                                                    c.name,
                                                  ),
                                              )
                                              .map((c) => c.name);
                                            if (
                                              columns.length ||
                                              name.endsWith("provider_session_bindings")
                                            )
                                              tables.push({
                                                db,
                                                label: store.label,
                                                name,
                                                scope,
                                                columns,
                                                fields: cols.map((c) => c.name),
                                                jsonColumns: cols
                                                  .filter(
                                                    (c) =>
                                                      /JSON/i.test(c.type) ||
                                                      /(?:_json|^json)$/.test(c.name),
                                                  )
                                                  .map((c) => c.name),
                                                keys: cols
                                                  .filter((c) => c.pk > 0)
                                                  .sort((a, b) => a.pk - b.pk)
                                                  .map((c) => c.name),
                                              });
                                          }
                                        }
                                        if (
                                          hasArchive &&
                                          !tables.some((t) => t.db === "ardud_archive")
                                        )
                                          return yield* new ThreadRedactionError({
                                            code: "failed",
                                          });
                                        // Forks compose inherited source rows at read time and have independent cursors.
                                        const forkEdges: { child: ThreadId; parent: string }[] = [];
                                        for (const table of tables) {
                                          if (
                                            !table.name.endsWith("projection_threads") ||
                                            !table.jsonColumns.includes("payload_json")
                                          )
                                            continue;
                                          for (const row of yield* sql.unsafe<Row>(
                                            `SELECT thread_id,payload_json FROM ${fullName(table)}`,
                                          )) {
                                            if (typeof row.thread_id !== "string") continue;
                                            const thread = record(payload(row));
                                            const fork = record(thread.forkedFrom);
                                            const lineage = record(thread.lineage);
                                            const parent =
                                              fork.type === "run"
                                                ? fork.threadId
                                                : lineage.relationshipToParent === "fork"
                                                  ? lineage.parentThreadId
                                                  : undefined;
                                            if (typeof parent === "string")
                                              forkEdges.push({
                                                child: ThreadId.make(row.thread_id),
                                                parent,
                                              });
                                          }
                                        }
                                        const sharedSessions = new Map<string, Set<ThreadId>>();
                                        for (const table of tables) {
                                          if (
                                            !table.name.endsWith("provider_session_bindings") &&
                                            !table.name.endsWith("projection_provider_sessions")
                                          )
                                            continue;
                                          for (const row of yield* sql.unsafe<Row>(
                                            `SELECT provider_session_id,thread_id FROM ${fullName(table)}`,
                                          )) {
                                            if (
                                              typeof row.provider_session_id !== "string" ||
                                              typeof row.thread_id !== "string"
                                            )
                                              continue;
                                            const members =
                                              sharedSessions.get(row.provider_session_id) ??
                                              new Set<ThreadId>();
                                            members.add(ThreadId.make(row.thread_id));
                                            sharedSessions.set(row.provider_session_id, members);
                                          }
                                        }
                                        const providerThreadReaders = new Map<
                                          string,
                                          Set<ThreadId>
                                        >();
                                        for (const provider of tables.filter((table) =>
                                          table.name.endsWith("projection_provider_threads"),
                                        )) {
                                          const prefix = provider.name.slice(
                                            0,
                                            -"provider_threads".length,
                                          );
                                          const session = provider.fields.includes(
                                            "provider_session_id",
                                          )
                                            ? "provider.provider_session_id"
                                            : "NULL";
                                          const relations = [
                                            `SELECT provider.provider_thread_id, ${session} AS provider_session_id, provider.thread_id AS reader_thread_id FROM ${fullName(provider)} AS provider WHERE provider.thread_id IS NOT NULL`,
                                          ];
                                          for (const reference of tables) {
                                            if (!reference.fields.includes("thread_id")) continue;
                                            const node =
                                              reference.name === prefix + "nodes" &&
                                              provider.fields.includes("owner_node_id") &&
                                              reference.fields.includes("node_id");
                                            const native =
                                              (["subagents", "runs", "turn_items"].some(
                                                (name) => reference.name === prefix + name,
                                              ) ||
                                                reference.name === "ardud_turn_items") &&
                                              reference.fields.includes("provider_thread_id");
                                            if (!node && !native) continue;
                                            relations.push(
                                              `SELECT provider.provider_thread_id, ${session} AS provider_session_id, reference.thread_id AS reader_thread_id FROM ${fullName(provider)} AS provider JOIN ${fullName(reference)} AS reference ON ${node ? "reference.node_id = provider.owner_node_id" : "reference.provider_thread_id = provider.provider_thread_id"} WHERE reference.thread_id IS NOT NULL`,
                                            );
                                          }
                                          for (const row of yield* sql.unsafe<Row>(
                                            relations.join(" UNION "),
                                          )) {
                                            if (
                                              typeof row.provider_thread_id !== "string" ||
                                              typeof row.reader_thread_id !== "string"
                                            )
                                              continue;
                                            const reader = ThreadId.make(row.reader_thread_id);
                                            const members =
                                              providerThreadReaders.get(row.provider_thread_id) ??
                                              new Set<ThreadId>();
                                            members.add(reader);
                                            providerThreadReaders.set(
                                              row.provider_thread_id,
                                              members,
                                            );
                                            if (typeof row.provider_session_id === "string") {
                                              const sessions =
                                                sharedSessions.get(row.provider_session_id) ??
                                                new Set<ThreadId>();
                                              sessions.add(reader);
                                              sharedSessions.set(row.provider_session_id, sessions);
                                            }
                                          }
                                        }
                                        let grew = true;
                                        while (grew) {
                                          grew = false;
                                          for (const members of [
                                            ...sharedSessions.values(),
                                            ...providerThreadReaders.values(),
                                          ])
                                            if ([...members].some((id) => affectedThreads.has(id)))
                                              for (const id of members)
                                                if (!affectedThreads.has(id)) {
                                                  affectedThreads.add(id);
                                                  grew = true;
                                                }
                                          for (const edge of forkEdges)
                                            if (
                                              affectedThreads.has(ThreadId.make(edge.parent)) &&
                                              !affectedThreads.has(edge.child)
                                            ) {
                                              affectedThreads.add(edge.child);
                                              grew = true;
                                            }
                                        }
                                        const providerThreadIds = [...providerThreadReaders]
                                          .filter(([, readers]) =>
                                            [...readers].some((id) => affectedThreads.has(id)),
                                          )
                                          .map(([id]) => id);
                                        const providerSessionIds = [...sharedSessions]
                                          .filter(([, readers]) =>
                                            [...readers].some((id) => affectedThreads.has(id)),
                                          )
                                          .map(([id]) => id);
                                        const scopedRows = (table: Table) => {
                                          stage = `scoped-rows:${table.db}.${table.name}`;
                                          const predicates = table.scope.map(
                                            (s) =>
                                              `${quote(s)} IN (${[...affectedThreads].map(() => "?").join(",")})`,
                                          );
                                          const parameters = table.scope.flatMap(() =>
                                            [...affectedThreads].map(String),
                                          );
                                          for (const [field, ids] of [
                                            ["provider_thread_id", providerThreadIds],
                                            ["provider_session_id", providerSessionIds],
                                          ] as const)
                                            if (table.fields.includes(field) && ids.length) {
                                              predicates.push(
                                                `${quote(field)} IN (${ids.map(() => "?").join(",")})`,
                                              );
                                              parameters.push(...ids);
                                            }
                                          const binding = tables.find(
                                            (other) =>
                                              other.db === table.db &&
                                              other.name.endsWith("provider_session_bindings"),
                                          );
                                          if (
                                            table.name.endsWith("projection_provider_sessions") &&
                                            binding
                                          ) {
                                            predicates.push(
                                              `provider_session_id IN (SELECT provider_session_id FROM ${fullName(binding)} WHERE thread_id IN (${[...affectedThreads].map(() => "?").join(",")}))`,
                                            );
                                            parameters.push(...affectedThreads);
                                          }
                                          return sql.unsafe<Row>(
                                            `SELECT ${table.keys.length ? "" : "rowid AS __redaction_rowid, "}* FROM ${fullName(table)} WHERE ${predicates.join(" OR ") || "0"}`,
                                            parameters,
                                          );
                                        };
                                        stage = "scoped-rows";
                                        const inventories = yield* Effect.forEach(
                                          tables,
                                          (table) =>
                                            Effect.map(scopedRows(table), (rows) => ({
                                              table,
                                              rows,
                                            })),
                                          { concurrency: 1 },
                                        );
                                        // The transaction's writer lock plus the thread executor close the start/redact race.
                                        for (const { table, rows } of inventories) {
                                          if (
                                            table.db === "main" &&
                                            /runs$|provider_turns$|subagents$|effect_outbox$|provider_session_runtime$|provider_sessions$|thread_sessions$|turn_items$|runtime_requests$/.test(
                                              table.name,
                                            ) &&
                                            rows.some((r) =>
                                              active.has(String(r.status ?? r.state)),
                                            )
                                          ) {
                                            return yield* new ThreadRedactionError({
                                              code: "running",
                                            });
                                          }
                                        }
                                        stage = "resolve";
                                        if (
                                          inventories.some(
                                            ({ table, rows }) =>
                                              table.name.endsWith("provider_threads") &&
                                              rows.some((r) => {
                                                const tasks = record(
                                                  payload(r),
                                                ).pendingBackgroundTasks;
                                                return Array.isArray(tasks) && tasks.length > 0;
                                              }),
                                          )
                                        )
                                          return yield* new ThreadRedactionError({
                                            code: "running",
                                          });
                                        const candidates = new Map<
                                          string,
                                          { row: Row; value: Row }
                                        >();
                                        for (const { table, rows } of inventories) {
                                          if (
                                            !/projection_turn_items$|projection_thread_activities$|^ardud_turn_items$/.test(
                                              table.name,
                                            )
                                          )
                                            continue;
                                          for (const row of rows) {
                                            if (row.thread_id !== input.threadId) continue;
                                            const id = String(row.turn_item_id ?? row.activity_id);
                                            const value = record(payload(row));
                                            if (
                                              id === input.itemId ||
                                              identifies(value, input.itemId)
                                            )
                                              if (!candidates.has(id))
                                                candidates.set(id, { row, value });
                                          }
                                        }
                                        if (candidates.size !== 1)
                                          return yield* new ThreadRedactionError({
                                            code: candidates.size ? "ambiguous" : "not_found",
                                          });
                                        const [id, selected] = [...candidates][0]!;
                                        resolvedId = id;
                                        const nativeIds = providerItemIds(selected.value);
                                        if (nativeIds.length > 1)
                                          return yield* new ThreadRedactionError({
                                            code: "ambiguous",
                                          });
                                        const providerItemId =
                                          nativeIds[0] ??
                                          (input.itemId !== id ? input.itemId : undefined);
                                        needles = [
                                          ...(retained?.needles ?? []),
                                          ...extra,
                                          ...outputs(selected.value),
                                        ];
                                        // Include earlier streamed prefixes, not just the final projection's output.
                                        for (const { table, rows } of inventories) {
                                          if (
                                            !table.name.endsWith("events") &&
                                            !isTurnItemTable(table.name)
                                          )
                                            continue;
                                          for (const row of rows) {
                                            if (
                                              (row.thread_id ??
                                                row.stream_id ??
                                                row.aggregate_id) !== input.threadId
                                            )
                                              continue;
                                            const v = payload(row);
                                            if (
                                              identifies(v, id) ||
                                              (providerItemId !== undefined &&
                                                identifies(v, providerItemId))
                                            )
                                              needles.push(...outputs(v));
                                          }
                                        }
                                        stage = "bindings";
                                        const bindings = inventories.filter(({ table }) =>
                                          /provider_threads$|provider_session_runtime$|thread_sessions$/.test(
                                            table.name,
                                          ),
                                        );
                                        const selectedProviderThreadId =
                                          selected.row.provider_thread_id ??
                                          selected.value.providerThreadId;
                                        const settings = yield* settingsService.getSettings.pipe(
                                          Effect.mapError(
                                            () => new ThreadRedactionError({ code: "failed" }),
                                          ),
                                        );
                                        const sessionIds = new Set<string>();
                                        const ownerSessionIds = new Set<string>();
                                        const drivers = new Set<string>();
                                        const instanceDrivers = new Map<string, string>();
                                        for (const { rows } of bindings)
                                          for (const row of rows) {
                                            const v = record(payload(row));
                                            const ownsBinding =
                                              row.thread_id === input.threadId ||
                                              (typeof selectedProviderThreadId === "string" &&
                                                row.provider_thread_id ===
                                                  selectedProviderThreadId);
                                            const bindingDriver = String(
                                              v.driver ??
                                                row.driver ??
                                                row.provider_name ??
                                                row.provider ??
                                                "unknown",
                                            );
                                            const instanceId =
                                              row.provider_instance_id ??
                                              v.providerInstanceId ??
                                              v.instanceId ??
                                              bindingDriver;
                                            const driver =
                                              settings.providerInstances[
                                                ProviderInstanceId.make(String(instanceId))
                                              ]?.driver ?? bindingDriver;
                                            drivers.add(driver);
                                            if (typeof instanceId === "string")
                                              instanceDrivers.set(instanceId, driver);
                                            for (const value of [
                                              record(v.nativeThreadRef).nativeId,
                                              row.provider_session_id,
                                              row.provider_thread_id,
                                            ]) {
                                              if (
                                                typeof value === "string" &&
                                                /^[a-zA-Z0-9_-]+$/.test(value)
                                              ) {
                                                sessionIds.add(value);
                                                if (ownsBinding) ownerSessionIds.add(value);
                                              }
                                            }
                                            for (const p of [
                                              parse(row.resume_cursor_json),
                                              parse(row.runtime_payload_json),
                                            ]) {
                                              const r = record(p);
                                              for (const value of [r.sessionId, r.threadId])
                                                if (
                                                  typeof value === "string" &&
                                                  /^[a-zA-Z0-9_-]+$/.test(value)
                                                ) {
                                                  sessionIds.add(value);
                                                  if (ownsBinding) ownerSessionIds.add(value);
                                                }
                                            }
                                          }
                                        stage = "provider-inventory";
                                        const roots = yield* io(async () => {
                                          const root = NodePath.join(
                                            config.baseDir,
                                            "harness-homes",
                                          );
                                          const dirs = await NodeFSP.readdir(root, {
                                            withFileTypes: true,
                                          }).catch((e: NodeJS.ErrnoException) => {
                                            if (e.code === "ENOENT") return [];
                                            throw e;
                                          });
                                          return dirs
                                            .filter(
                                              (d) =>
                                                d.isDirectory() &&
                                                /^(claude|codex)(-|$)/.test(d.name),
                                            )
                                            .map((d) => ({
                                              driver: d.name.startsWith("codex")
                                                ? "codex"
                                                : "claudeAgent",
                                              dir: NodePath.join(root, d.name),
                                            }));
                                        });
                                        const baseEnvironment = yield* HostProcess.Environment;
                                        for (const [id, boundDriver] of instanceDrivers) {
                                          const instanceId = ProviderInstanceId.make(id);
                                          const instance = settings.providerInstances[instanceId];
                                          const driver = instance?.driver ?? boundDriver;
                                          if (driver !== "codex" && driver !== "claudeAgent")
                                            continue;
                                          const environment =
                                            yield* mergeProviderInstanceEnvironment(
                                              instance?.environment,
                                              baseEnvironment,
                                            );
                                          if (driver === "claudeAgent") {
                                            const typed = yield* decodeClaudeSettings(
                                              instance?.config ?? {},
                                            ).pipe(
                                              Effect.mapError(
                                                () => new ThreadRedactionError({ code: "failed" }),
                                              ),
                                            );
                                            // Relative inherited homes are resolved by the CLI from its session cwd.
                                            if (
                                              !typed.homePath.trim() &&
                                              environment.CLAUDE_CONFIG_DIR?.trim() &&
                                              !NodePath.isAbsolute(
                                                environment.CLAUDE_CONFIG_DIR.trim(),
                                              )
                                            )
                                              return yield* new ThreadRedactionError({
                                                code: "invalid",
                                              });
                                            const defaultHome =
                                              !typed.homePath.trim() &&
                                              !environment.CLAUDE_CONFIG_DIR?.trim()
                                                ? environment.HOME
                                                : undefined;
                                            if (defaultHome && !NodePath.isAbsolute(defaultHome))
                                              return yield* new ThreadRedactionError({
                                                code: "invalid",
                                              });
                                            roots.push({
                                              driver,
                                              dir: defaultHome
                                                ? NodePath.join(defaultHome, ".claude")
                                                : yield* resolveClaudeHomePath(typed, environment),
                                            });
                                          } else {
                                            const typed = yield* decodeCodexSettings(
                                              instance?.config ?? {},
                                            ).pipe(
                                              Effect.mapError(
                                                () => new ThreadRedactionError({ code: "failed" }),
                                              ),
                                            );
                                            if (
                                              typed.setupMode !== "managed" &&
                                              !typed.homePath.trim() &&
                                              !typed.shadowHomePath.trim() &&
                                              environment.CODEX_HOME?.trim() &&
                                              !NodePath.isAbsolute(environment.CODEX_HOME.trim())
                                            )
                                              return yield* new ThreadRedactionError({
                                                code: "invalid",
                                              });
                                            const defaultHome =
                                              typed.setupMode !== "managed" &&
                                              !typed.homePath.trim() &&
                                              !typed.shadowHomePath.trim() &&
                                              !environment.CODEX_HOME?.trim()
                                                ? environment.HOME
                                                : undefined;
                                            if (defaultHome && !NodePath.isAbsolute(defaultHome))
                                              return yield* new ThreadRedactionError({
                                                code: "invalid",
                                              });
                                            const layout = yield* typed.setupMode === "managed"
                                              ? resolveManagedCodexHomeLayout(
                                                  config.stateDir,
                                                  instanceId,
                                                  typed,
                                                )
                                              : resolveCodexHomeLayout(
                                                  !typed.homePath.trim() &&
                                                    !typed.shadowHomePath.trim() &&
                                                    environment.CODEX_HOME?.trim()
                                                    ? {
                                                        ...typed,
                                                        homePath: environment.CODEX_HOME.trim(),
                                                      }
                                                    : defaultHome
                                                      ? {
                                                          ...typed,
                                                          homePath: NodePath.join(
                                                            defaultHome,
                                                            ".codex",
                                                          ),
                                                        }
                                                      : typed,
                                                );
                                            roots.push({ driver, dir: layout.sharedHomePath });
                                            if (layout.effectiveHomePath)
                                              roots.push({
                                                driver,
                                                dir: layout.effectiveHomePath,
                                              });
                                          }
                                        }
                                        const uniqueRoots = [
                                          ...new Map(
                                            roots.map((root) => [
                                              `${root.driver}\0${root.dir}`,
                                              root,
                                            ]),
                                          ).values(),
                                        ];
                                        const providerPaths = new Set<string>();
                                        const taskRefs = new Set<string>();
                                        for (const root of uniqueRoots) {
                                          const all = yield* io(async () =>
                                            (
                                              await Promise.all(
                                                (root.driver === "codex"
                                                  ? ["sessions", "archived_sessions"]
                                                  : ["projects"]
                                                ).map((directory) =>
                                                  filesBelow(NodePath.join(root.dir, directory)),
                                                ),
                                              )
                                            ).flat(),
                                          );
                                          const belongsTo = (
                                            file: string,
                                            ids: ReadonlySet<string>,
                                          ) =>
                                            [...ids].some(
                                              (session) =>
                                                NodePath.basename(file) === `${session}.jsonl` ||
                                                (root.driver === "codex" &&
                                                  (() => {
                                                    const name = NodePath.basename(file);
                                                    const suffix = `-${session}.jsonl`;
                                                    if (!name.endsWith(suffix)) return false;
                                                    const prefix = name.slice(0, -suffix.length);
                                                    return (
                                                      prefix === "rollout" ||
                                                      /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:\.\d+)?Z?$/.test(
                                                        prefix,
                                                      )
                                                    );
                                                  })()) ||
                                                (root.driver === "claudeAgent" &&
                                                  NodePath.relative(
                                                    NodePath.join(root.dir, "projects"),
                                                    file,
                                                  ).split(NodePath.sep)[1] === session),
                                            );
                                          const transcripts = all.filter(
                                            (file) =>
                                              file.endsWith(".jsonl") &&
                                              belongsTo(file, sessionIds),
                                          );
                                          let matchedResults = 0;
                                          for (const file of transcripts) {
                                            providerPaths.add(file);
                                            const ownerTranscript = belongsTo(
                                              file,
                                              ownerSessionIds,
                                            );
                                            if (providerItemId && ownerTranscript) {
                                              const result = yield* io(() =>
                                                providerResult(file, providerItemId),
                                              );
                                              needles.push(...result.outputs);
                                              matchedResults += result.matched;
                                              for (const session of ownerSessionIds)
                                                if (belongsTo(file, new Set([session])))
                                                  for (const taskId of result.taskIds)
                                                    taskRefs.add(`${session}\0${taskId}`);
                                            }
                                            const spillRoot = NodePath.join(
                                              NodePath.dirname(file),
                                              NodePath.basename(file, ".jsonl"),
                                              "tool-results",
                                            );
                                            for (const spill of all.filter((f) =>
                                              f.startsWith(`${spillRoot}${NodePath.sep}`),
                                            )) {
                                              providerPaths.add(spill);
                                              if (
                                                needles.some((n) => n.includes(spill)) ||
                                                (ownerTranscript &&
                                                  NodePath.basename(spill) ===
                                                    `${providerItemId}.txt`)
                                              ) {
                                                needles.push(yield* io(() => readTextFile(spill)));
                                              }
                                            }
                                          }
                                          if (transcripts.length)
                                            providers.push({
                                              provider: root.driver,
                                              status: matchedResults > 0 ? "rewritten" : "missing",
                                            });
                                        }
                                        if (drivers.has("claudeAgent")) {
                                          const tmpBases = new Set([
                                            "/tmp",
                                            process.env.CLAUDE_CODE_TMPDIR?.trim() || "/tmp",
                                          ]);
                                          for (const instance of Object.values(
                                            settings.providerInstances,
                                          ))
                                            if (instance.driver === "claudeAgent")
                                              for (const variable of instance.environment ?? [])
                                                if (variable.name === "CLAUDE_CODE_TMPDIR")
                                                  tmpBases.add(variable.value.trim() || "/tmp");
                                          const uid = process.getuid?.();
                                          const taskFiles =
                                            uid === undefined
                                              ? []
                                              : yield* io(() =>
                                                  claudeTaskFiles(
                                                    [...tmpBases].map((base) =>
                                                      NodePath.join(base, `claude-${uid}`),
                                                    ),
                                                    sessionIds,
                                                  ),
                                                );
                                          for (const file of taskFiles) {
                                            providerPaths.add(file.path);
                                            if (taskRefs.has(`${file.sessionId}\0${file.taskId}`))
                                              needles.push(
                                                yield* io(() => readTextFile(file.path)),
                                              );
                                          }
                                          if (taskFiles.length && !taskRefs.size)
                                            providers.push({
                                              provider: "claudeAgent",
                                              status: "missing",
                                            });
                                        }
                                        for (const driver of drivers) {
                                          if (!providers.some((p) => p.provider === driver))
                                            providers.push({
                                              provider: driver,
                                              status:
                                                driver === "claudeAgent" || driver === "codex"
                                                  ? "missing"
                                                  : "unsupported",
                                            });
                                        }
                                        if (!drivers.size)
                                          providers.push({
                                            provider: "unknown",
                                            status: "missing",
                                          });
                                        const markerKey = `${input.threadId}\0${resolvedId}`;
                                        const knownMarkers = generatedMarkers.get(markerKey);
                                        needles = [
                                          ...new Set([
                                            ...needles.filter((n) => !knownMarkers?.has(n)),
                                            ...extra,
                                          ]),
                                        ].filter(Boolean);
                                        if (
                                          !needles.length ||
                                          needles.some((n) => marker.includes(n))
                                        )
                                          return yield* new ThreadRedactionError({
                                            code: "invalid",
                                          });
                                        const valid = yield* Effect.try({
                                          try: () => {
                                            for (const { table, rows } of inventories)
                                              for (const row of rows)
                                                for (const column of table.columns) {
                                                  const value = row[column];
                                                  if (typeof value !== "string") continue;
                                                  if (table.jsonColumns.includes(column)) {
                                                    const before = parse(value);
                                                    if (
                                                      structuralCollision(before, needles) ||
                                                      !validRewrite(
                                                        before,
                                                        replaceValue(before, needles, marker),
                                                      )
                                                    )
                                                      return false;
                                                    replaceText(value, needles, marker);
                                                  } else replaceScalarText(value, needles, marker);
                                                }
                                            return true;
                                          },
                                          catch: () =>
                                            new ThreadRedactionError({ code: "invalid" }),
                                        });
                                        if (!valid)
                                          return yield* new ThreadRedactionError({
                                            code: "invalid",
                                          });
                                        // File preparation is read-only. No original content is saved to temporary files.
                                        stage = "file-preparation";
                                        const logPaths = yield* io(() =>
                                          filesBelow(config.logsDir),
                                        );
                                        const physicalPaths = yield* io(async () => [
                                          ...new Set(
                                            await Promise.all(
                                              [...providerPaths, ...logPaths].map((file) =>
                                                NodeFSP.realpath(file),
                                              ),
                                            ),
                                          ),
                                        ]);
                                        for (const file of physicalPaths)
                                          plans.push(
                                            yield* io(() => planFile(file, needles, marker)),
                                          );
                                        // Canonical output may omit spill-only text. Retain the complete set
                                        // until verification, and refuse recovery after a process restart.
                                        recoveryNeedles.set(input.threadId, {
                                          itemId: input.itemId,
                                          phase: "rewriting",
                                          needles,
                                        });
                                        generatedMarkers.set(
                                          markerKey,
                                          new Set([...(knownMarkers ?? []), marker]),
                                        );
                                        invalidateProviderWrites = true;
                                        clearEarly = false;
                                        stage = "file-rewrite";
                                        for (const plan of plans)
                                          stores.push(yield* rewriteFile(plan, needles, marker));
                                        const revisions = new Map<string, ItemRevision>();
                                        for (const { table, rows } of inventories) {
                                          if (!isTurnItemTable(table.name)) continue;
                                          for (const row of rows) {
                                            if (
                                              typeof row.payload_json !== "string" ||
                                              !replaceText(row.payload_json, needles, marker).count
                                            )
                                              continue;
                                            const itemId = String(row.turn_item_id);
                                            const previous =
                                              record(payload(row)).updatedAt ?? row.updated_at;
                                            revisions.set(itemId, {
                                              at: advanceRevision(
                                                previous,
                                                revisions.get(itemId)?.at ?? at,
                                              ),
                                              types: new Set([
                                                ...(revisions.get(itemId)?.types ?? []),
                                                String(record(payload(row)).type ?? row.type),
                                              ]),
                                            });
                                          }
                                        }
                                        stage = "database-rewrite";
                                        for (const { table, rows } of inventories) {
                                          let matchedBefore = 0;
                                          let remainingAfter = 0;
                                          for (const row of rows) {
                                            const updates: [string, string][] = [];
                                            for (const column of table.columns) {
                                              const value = row[column];
                                              if (typeof value !== "string") continue;
                                              const replaced = (
                                                table.jsonColumns.includes(column)
                                                  ? replaceText
                                                  : replaceScalarText
                                              )(value, needles, marker);
                                              matchedBefore += replaced.count;
                                              const decoded = table.jsonColumns.includes(column)
                                                ? parse(value)
                                                : value;
                                              const revised =
                                                typeof decoded === "object" && decoded !== null
                                                  ? reviseItems(decoded, revisions)
                                                  : decoded;
                                              if (!replaced.count && revised === decoded) continue;
                                              const next =
                                                typeof decoded === "object" && decoded !== null
                                                  ? encodeJson(
                                                      replaceValue(revised, needles, marker),
                                                    )
                                                  : replaced.text;
                                              if (
                                                table.jsonColumns.includes(column) &&
                                                !validRewrite(decoded, parse(next))
                                              )
                                                return yield* new ThreadRedactionError({
                                                  code: "invalid",
                                                });
                                              updates.push([column, next]);
                                            }
                                            if (
                                              isTurnItemTable(table.name) &&
                                              revisions.has(String(row.turn_item_id))
                                            )
                                              updates.push([
                                                "updated_at",
                                                revisions.get(String(row.turn_item_id))!.at,
                                              ]);
                                            else if (
                                              !isTurnItemTable(table.name) &&
                                              updates.length > 0 &&
                                              table.fields.includes("updated_at")
                                            )
                                              updates.push([
                                                "updated_at",
                                                advanceRevision(row.updated_at, at),
                                              ]);
                                            if (updates.length) {
                                              const keys = table.keys.length
                                                ? table.keys
                                                : ["rowid"];
                                              const keyValues = table.keys.length
                                                ? keys.map((key) => row[key])
                                                : [row.__redaction_rowid];
                                              yield* sql.unsafe(
                                                `UPDATE ${fullName(table)} SET ${updates.map(([c]) => `${quote(c)} = ?`).join(", ")} WHERE ${keys.map((key) => `${quote(key)} IS ?`).join(" AND ")}`,
                                                [...updates.map(([, v]) => v), ...keyValues] as (
                                                  | string
                                                  | number
                                                  | null
                                                )[],
                                              );
                                            }
                                          }
                                          for (const row of yield* scopedRows(table))
                                            for (const column of table.columns) {
                                              if (typeof row[column] === "string")
                                                remainingAfter += (
                                                  table.jsonColumns.includes(column)
                                                    ? replaceText
                                                    : replaceScalarText
                                                )(row[column], needles, marker).count;
                                            }
                                          stores.push({
                                            store: `${table.label}.${table.name}`,
                                            matchedBefore,
                                            replaced: matchedBefore,
                                            remainingAfter,
                                          });
                                        }
                                        stage = "append";
                                        return yield* events.append({
                                          events: [...affectedThreads].map((threadId) => ({
                                            id: EventId.make(
                                              `redaction:${NodeCrypto.randomUUID()}`,
                                            ),
                                            type: "thread.item-redacted" as const,
                                            threadId,
                                            occurredAt: now,
                                            payload: { itemId: id, reason: input.reason, at },
                                          })),
                                        });
                                      }),
                                    ),
                                  );
                                  for (const threadId of affectedThreads)
                                    yield* outputHub.forgetThread(threadId);
                                  yield* eventSink.publishCommitted(published);
                                }),
                              );
                              if (input.compact) {
                                for (const store of storage)
                                  yield* sql.unsafe(`VACUUM ${quote(store.db)}`);
                              }
                              let checkpointed = true;
                              for (const store of storage) {
                                const checkpoint = yield* sql
                                  .unsafe<{ busy: number }>(
                                    `PRAGMA ${quote(store.db)}.wal_checkpoint(TRUNCATE)`,
                                  )
                                  .pipe(Effect.option);
                                checkpointed &&=
                                  checkpoint._tag === "Some" &&
                                  checkpoint.value.every((r) => r.busy === 0);
                              }
                              const databasePaths = storage.map((d) => d.path).filter(Boolean);
                              for (const file of databasePaths)
                                for (const physical of [file, `${file}-wal`, `${file}-journal`]) {
                                  const remainingAfter = yield* io(() =>
                                    countFile(physical, needles, true),
                                  );
                                  stores.push({
                                    store: physical,
                                    matchedBefore: 0,
                                    replaced: 0,
                                    remainingAfter,
                                  });
                                }
                              for (const plan of plans) {
                                const index = stores.findIndex(
                                  (store) => store.store === plan.path,
                                );
                                if (index >= 0)
                                  stores[index] = {
                                    ...stores[index]!,
                                    remainingAfter: yield* io(() => countFile(plan.path, needles)),
                                  };
                              }
                              const verify =
                                input.compact === true &&
                                checkpointed &&
                                providers.every((p) => p.status === "rewritten") &&
                                stores.every((s) => s.remainingAfter === 0);
                              return {
                                threadId: input.threadId,
                                itemId: resolvedId,
                                stores,
                                providers,
                                checkpointed,
                                compacted: input.compact === true,
                                verify,
                              };
                            });
                          });
                        },
                        storeCleanup,
                      ),
                    ),
                  ).pipe(Effect.exit);
                  if (Exit.isFailure(result)) {
                    const error = Cause.findErrorOption(result.cause);
                    if (
                      clearEarly &&
                      !(Option.isSome(error) && isStoreMaintenanceError(error.value))
                    )
                      yield* sql`UPDATE ardud_thread_redaction_recovery SET pending=0 WHERE thread_id=${input.threadId}`.pipe(
                        Effect.tap(() => Effect.sync(() => recoveryNeedles.delete(input.threadId))),
                        Effect.ignore,
                      );
                    return yield* Effect.failCause(result.cause);
                  }
                  if (result.value.verify) {
                    yield* sql`UPDATE ardud_thread_redaction_recovery SET pending=0 WHERE thread_id=${input.threadId}`.pipe(
                      Effect.tap(() => Effect.sync(() => recoveryNeedles.delete(input.threadId))),
                      Effect.uninterruptible,
                    );
                  }
                  return result.value;
                }),
              );
              return withLogsPaused(input.threadId, work, {
                relatedThreadIds: affectedThreads,
                shouldInvalidate: () => invalidateProviderWrites,
              });
            }),
          ),
        ),
      )
      .pipe(
        // SQL driver errors can include bound payloads. Discard all underlying causes.
        Effect.catchCause((cause) => {
          if (Cause.hasInterrupts(cause)) return Effect.interrupt;
          const error = Cause.findErrorOption(cause);
          const e = Option.isSome(error) ? error.value : undefined;
          return Effect.fail(
            isThreadRedactionError(e)
              ? e
              : new ThreadRedactionError({
                  code: isStoreMaintenanceError(e) ? "maintenance_required" : "failed",
                  stage,
                }),
          );
        }),
        Effect.withTracerEnabled(false),
        Effect.provideService(Path.Path, path),
      );
  });
  return ThreadRedaction.of({ redactItem });
});
export const layer = Layer.effect(ThreadRedaction, make);
