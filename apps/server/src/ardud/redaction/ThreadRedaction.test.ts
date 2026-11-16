import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SharedObservability from "@t3tools/shared/observability";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
// @effect-diagnostics nodeBuiltinImport:off - Atomic fsync/rename and byte-preserving fixture verification require native file handles.
import { createReadonlyReplica } from "../persistence/readonlyExport.ts";
import * as NodeZlib from "node:zlib";
import * as NodeFS from "node:fs";
import * as NodeWorkerThreads from "node:worker_threads";
import * as Fiber from "effect/Fiber";
import * as ReadonlyReplica from "../persistence/ReadonlyReplica.ts";
import { initializeKanbanSchema } from "../persistence/kanbanSchema.ts";
import { makeEventNdjsonLogStore } from "../../provider/EventNdjsonLogger.ts";
import { filesBelow } from "./providerFiles.ts";
import * as TestClock from "effect/testing/TestClock";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as CommandOutputHub from "../../orchestration-v2/CommandOutputHub.ts";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId, EventId, ProviderInstanceId, ProviderDriverKind } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Stream from "effect/Stream";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as Logger from "effect/Logger";
import * as Config from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as Executor from "../../orchestration-v2/ThreadCommandExecutor.ts";
import * as LegacyV1ThreadImporter from "../../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as ThreadRedaction from "./ThreadRedaction.ts";
import * as ControlStore from "../control/ControlStore.ts";
import * as ServerLogFile from "../observability/serverLogFile.ts";

const writerHooks = vi.hoisted(() => ({
  before: undefined as ((sql: string) => void) | undefined,
  after: undefined as
    | ((sql: string, fiber: ReturnType<typeof Fiber.getCurrent>) => void)
    | undefined,
  fullFsync: undefined as ((value: number) => void) | undefined,
}));

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeWorkerThreads>();
  class ObservedWorker extends actual.Worker {
    readonly writer: boolean;
    readonly statements = new Map<
      number,
      { sql: string; fiber: ReturnType<typeof Fiber.getCurrent> }
    >();
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      const writer = args[1]?.workerData?.cancelled !== undefined;
      if (writer && typeof args[0] === "string") {
        args[0] = args[0].replace(
          "const entry = cached ? statements.get(sql) : undefined;",
          `if (request.testRedactionFsync) parentPort.postMessage({ testRedactionFsync: Number(db.prepare("PRAGMA fullfsync").get().fullfsync) });
const entry = cached ? statements.get(sql) : undefined;`,
        );
      }
      super(...args);
      this.writer = writer;
    }
    override postMessage(...args: Parameters<NodeWorkerThreads.Worker["postMessage"]>) {
      const [request] = args;
      if (this.writer && typeof request?.id === "number" && typeof request.sql === "string") {
        writerHooks.before?.(request.sql);
        this.statements.set(request.id, { sql: request.sql, fiber: Fiber.getCurrent() });
        if (
          writerHooks.fullFsync &&
          request.sql.startsWith("INSERT INTO ardud_thread_redaction_recovery")
        )
          args[0] = { ...request, testRedactionFsync: true };
      }
      super.postMessage(...args);
    }
    override emit(event: string | symbol, ...args: unknown[]): boolean {
      const reply = args[0];
      if (this.writer && event === "message" && typeof reply === "object" && reply !== null) {
        if ("testRedactionFsync" in reply && typeof reply.testRedactionFsync === "number") {
          writerHooks.fullFsync?.(reply.testRedactionFsync);
          return false;
        }
        if ("id" in reply && typeof reply.id === "number") {
          const statement = this.statements.get(reply.id);
          this.statements.delete(reply.id);
          if (statement && "rows" in reply) writerHooks.after?.(statement.sql, statement.fiber);
        }
      }
      return super.emit(event, ...args);
    }
  }
  return { ...actual, Worker: ObservedWorker };
});

const installWriterHooks = (hooks: Partial<typeof writerHooks>) => {
  const previous = { ...writerHooks };
  Object.assign(writerHooks, hooks);
  return () => Object.assign(writerHooks, previous);
};

const filesystemFault = vi.hoisted(() => ({
  failMode: false,
  path: "",
  inventory: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      if (String(args[0]).endsWith("harness-homes")) await filesystemFault.inventory?.();
      return actual.readdir(...args);
    },
    chmod: async (...args: Parameters<typeof actual.chmod>) => {
      if (
        filesystemFault.failMode &&
        String(args[0]).endsWith(filesystemFault.path) &&
        args[1] === 0o400
      )
        throw new Error("Fixture cleanup failure");
      return actual.chmod(...args);
    },
  };
});

const threadId = ThreadId.make("thread-fixture");
const fake = "eyJFAKE.fixture.ONLY-NOT-A-CREDENTIAL";
const fixture = {
  id: "item-fixture",
  type: "command_execution",
  input: "fixture",
  output: fake,
  nativeItemRef: { nativeId: "call-fixture" },
};
const testLayer = ThreadRedaction.layer.pipe(
  Layer.provideMerge(
    Layer.succeed(
      SharedObservability.TraceStorageMaintenance,
      SharedObservability.NoOpTraceStorageMaintenance,
    ),
  ),
  Layer.provide(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
  Layer.provide(Layer.mock(CommandOutputHub.CommandOutputHub)({ forgetThread: () => Effect.void })),
  Layer.provideMerge(ReadonlyReplica.serviceLayer),
  Layer.provideMerge(EventSink.layer.pipe(Layer.provide(ProjectionStore.layer))),
  Layer.provideMerge(EventStore.layer),
  Layer.provideMerge(Executor.layer),
  Layer.provideMerge(Sqlite.layerConfig),
  Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "thread-redaction-test-" })),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(NodeServices.layer),
);
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const config = yield* Config.ServerConfig;
    return yield* effect.pipe(
      Effect.provideService(
        HostProcess.HomeDirectory,
        NodePath.join(config.baseDir, "fixture-host-home"),
      ),
      Effect.provideService(HostProcess.Environment, {}),
    );
  }).pipe(Effect.provide(testLayer), Effect.scoped);
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO orchestration_v2_projection_turn_items (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json) VALUES ('item-fixture', ${threadId}, 1, 'command_execution', 'completed', '2026-01-01', ${JSON.stringify(fixture)})`;
  yield* sql`INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json) VALUES ('fixture-event', 'thread', ${threadId}, 0, 'fixture.tool', '2026-01-01', 'provider', ${JSON.stringify(fixture)}, '{}')`;
  yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at) VALUES ('quote', ${threadId}, 'assistant', ${`quote ${fake}`}, 0, '2026-01-01', '2026-01-01')`;
  yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at) VALUES ('other', 'other-thread', 'assistant', 'untouched', 0, '2026-01-01', '2026-01-01')`;
});

it.effect(
  "redacts events, projections, receipts and outbox, appends an event, and preserves unrelated threads",
  () =>
    run(
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO orchestration_v2_command_receipts (command_id, thread_id, command_type, accepted_at, result_sequence, status, error) VALUES ('receipt-fixture', ${threadId}, 'fixture', '2026-01-01', 0, 'ok', ${fake})`;
        yield* sql`INSERT INTO orchestration_v2_effect_outbox (effect_id, command_id, thread_id, effect_type, payload_json, status, available_at, created_at, updated_at) VALUES ('effect-fixture', 'command-fixture', ${threadId}, 'fixture', ${JSON.stringify({ quote: fake })}, 'succeeded', '2026-01-01', '2026-01-01', '2026-01-01')`;
        const service = yield* ThreadRedaction.ThreadRedaction;
        const logs: unknown[] = [];
        const result = yield* service
          .redactItem({ threadId, itemId: "call-fixture", reason: "fixture", compact: true })
          .pipe(
            Effect.provide(
              Logger.layer([
                Logger.make((entry) => {
                  logs.push(entry);
                }),
              ]),
            ),
          );
        expect(result.stores.every((s) => s.remainingAfter === 0)).toBe(true);
        expect(JSON.stringify([result, logs]).includes(fake)).toBe(false);
        expect(result.providers).toEqual([{ provider: "unknown", status: "missing" }]);
        expect(result.verify).toBe(false);
        const rows =
          yield* sql`SELECT payload_json FROM orchestration_events WHERE stream_id = ${threadId}`;
        expect(JSON.stringify(rows).includes(fake)).toBe(false);
        expect(rows.length).toBe(2);
        const item = yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id = 'item-fixture'`;
        expect(JSON.parse(item[0]!.payload_json)).toMatchObject({
          id: fixture.id,
          type: fixture.type,
          input: fixture.input,
        });
        const other = yield* sql<{
          text: string;
        }>`SELECT text FROM projection_thread_messages WHERE message_id = 'other'`;
        expect(other[0]!.text).toBe("untouched");
      }),
    ),
);

it.effect("includes redacted older messages in both control delta reads", () =>
  Effect.andThen(
    TestClock.setTime(Date.parse("2026-01-04T00:00:00.000Z")),
    run(
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const oldAt = "2026-01-01T00:00:00.000Z";
        const newerAt = "2026-01-02T00:00:00.000Z";
        const since = Date.parse("2026-01-03T00:00:00.000Z");
        const redactedAt = "2026-01-04T00:00:00.000Z";
        yield* sql`INSERT INTO orchestration_v2_projection_threads
        (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
        VALUES (${threadId}, 'fixture', 'Fixture', 'codex', 'full-access', 'default', ${oldAt}, ${newerAt}, '{}')`;
        for (const [id, text, at] of [
          ["older-message", `quoted ${fake}`, oldAt],
          ["newer-message", "untouched prompt", newerAt],
        ] as const) {
          yield* sql`INSERT INTO orchestration_v2_projection_messages ${sql.insert({
            message_id: id,
            thread_id: threadId,
            run_id: null,
            node_id: null,
            role: "user",
            streaming: 0,
            created_at: at,
            updated_at: at,
            payload_json: JSON.stringify({
              id,
              threadId,
              runId: null,
              nodeId: null,
              role: "user",
              text,
              phase: "answer",
              attachments: [],
              streaming: false,
              createdBy: "user",
              creationSource: "web",
              createdAt: at,
              updatedAt: at,
            }),
          })}`;
        }
        const store = yield* ControlStore.ControlStore;
        const pageInput = {
          threadId,
          role: null,
          runId: null,
          since,
          afterMessageId: null,
          limit: 10,
        };
        const userInput = { since, cursor: null, limit: 10 };
        expect((yield* store.messagePage(pageInput)).messages).toEqual([]);
        expect((yield* store.userMessagesSince(userInput)).messages).toEqual([]);

        const service = yield* ThreadRedaction.ThreadRedaction;
        yield* service.redactItem({ threadId, itemId: "call-fixture", reason: "fixture" });

        const rows = yield* sql<{ message_id: string; updated_at: string }>`
        SELECT message_id, updated_at FROM orchestration_v2_projection_messages ORDER BY created_at`;
        expect(rows).toEqual([
          { message_id: "older-message", updated_at: redactedAt },
          { message_id: "newer-message", updated_at: newerAt },
        ]);
        expect(Date.parse(rows[0]!.updated_at)).toBeGreaterThan(Date.parse(oldAt));
        expect(Date.parse(rows[0]!.updated_at)).toBeGreaterThan(since);
        const page = yield* store.messagePage(pageInput);
        const users = yield* store.userMessagesSince(userInput);
        for (const delta of [page, { ...users, messages: users.messages.map((m) => m.message) }]) {
          expect(delta.total).toBe(1);
          expect(delta.messages).toHaveLength(1);
          expect(delta.messages[0]!.id).toBe("older-message");
          expect(delta.messages[0]!.text).toBe(`quoted [redacted ${redactedAt}: fixture]`);
          expect(delta.messages[0]!.text).not.toContain(fake);
        }
      }).pipe(Effect.provide(ControlStore.layer)),
    ),
  ),
);

it.effect.each([
  { previous: "2026-01-01T00:00:00.000Z", expected: "2026-01-02T00:00:00.000Z" },
  { previous: "2026-01-02T00:00:00.000Z", expected: "2026-01-02T00:00:00.001Z" },
  { previous: "2026-01-03T00:00:00.000Z", expected: "2026-01-03T00:00:00.001Z" },
])("advances non-turn-item revisions monotonically from $previous", ({ previous, expected }) =>
  Effect.andThen(
    TestClock.setTime(Date.parse("2026-01-02T00:00:00.000Z")),
    run(
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE projection_thread_messages SET updated_at = ${previous} WHERE message_id = 'quote'`;
        yield* sql`INSERT INTO orchestration_v2_effect_outbox
        (effect_id, command_id, thread_id, effect_type, payload_json, status, available_at, created_at, updated_at)
        VALUES ('effect-fixture', 'command-fixture', ${threadId}, 'fixture', ${JSON.stringify({ quote: fake })}, 'succeeded', ${previous}, ${previous}, ${previous})`;
        const service = yield* ThreadRedaction.ThreadRedaction;
        yield* service.redactItem({ threadId, itemId: "call-fixture", reason: "fixture" });
        const messages = yield* sql<{ updated_at: string; text: string }>`
        SELECT updated_at, text FROM projection_thread_messages WHERE message_id = 'quote'`;
        const outbox = yield* sql<{ updated_at: string; payload_json: string }>`
        SELECT updated_at, payload_json FROM orchestration_v2_effect_outbox WHERE effect_id = 'effect-fixture'`;
        expect(messages[0]!.updated_at).toBe(expected);
        expect(outbox[0]!.updated_at).toBe(expected);
        expect(messages[0]!.text).toContain("[redacted ");
        expect(outbox[0]!.payload_json).toContain("[redacted ");
      }),
    ),
  ),
);

it.effect("scrubs retained V1 transcript rows and their imported V2 copies", () =>
  run(
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at
        ) VALUES (
          ${threadId}, 'fixture', 'Legacy thread',
          '{"instanceId":"codex","model":"gpt-6.1-sol"}', 'full-access', 'default',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `;
      const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter.pipe(
        Effect.provide(LegacyV1ThreadImporter.layer),
      );
      yield* importer.reconcileShells;
      yield* importer.ensureTranscript(threadId);
      const copies = () =>
        Effect.all([
          sql`SELECT text FROM projection_thread_messages WHERE message_id = 'quote'`,
          sql`SELECT payload_json FROM orchestration_v2_projection_messages WHERE message_id = 'quote'`,
          sql`SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id = 'migration:v1:turn-item:quote'`,
          sql`SELECT payload_json FROM orchestration_events WHERE event_id = 'migration:v1:message:quote'`,
        ]);
      const before = yield* copies();
      for (const rows of before) {
        expect(rows).toHaveLength(1);
        expect(JSON.stringify(rows)).toContain(fake);
      }
      const service = yield* ThreadRedaction.ThreadRedaction;
      const result = yield* service.redactItem({
        threadId,
        itemId: "call-fixture",
        reason: "fixture",
        compact: true,
      });
      expect(result.stores.every((store) => store.remainingAfter === 0)).toBe(true);
      for (const rows of yield* copies()) {
        expect(rows).toHaveLength(1);
        expect(JSON.stringify(rows)).not.toContain(fake);
        expect(JSON.stringify(rows)).toContain("[redacted ");
      }
    }),
  ),
);

it.effect.each(["missing", "ambiguous", "running"])("refuses %s before any rewrite", (kind) =>
  run(
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      if (kind === "ambiguous")
        yield* sql`INSERT INTO orchestration_v2_projection_turn_items (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json) VALUES ('item-second', ${threadId}, 2, 'command_execution', 'completed', '2026-01-01', ${JSON.stringify(fixture)})`;
      if (kind === "running")
        yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES ('run-fixture',${threadId},1,'claudeAgent','running','2026-01-01','{}')`;
      const service = yield* ThreadRedaction.ThreadRedaction;
      const error = yield* service
        .redactItem({
          threadId,
          itemId: kind === "missing" ? "absent" : "call-fixture",
          reason: "fixture",
          compact: true,
        })
        .pipe(Effect.flip);
      expect(error.code).toBe(kind === "missing" ? "not_found" : kind);
      expect(JSON.stringify(error).includes(fake)).toBe(false);
      const rows = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id = 'item-fixture'`;
      expect(JSON.parse(rows[0]!.payload_json).output).toBe(fake);
    }),
  ),
);

it.effect("rewrites an attached archive in the same transaction", () =>
  run(
    Effect.gen(function* () {
      yield* seed;
      const config = yield* Config.ServerConfig;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA main.secure_delete=ON`;
      yield* sql`INSERT INTO ardud_archive.ardud_turn_items(turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json) SELECT turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json FROM orchestration_v2_projection_turn_items`;
      yield* sql`DELETE FROM orchestration_v2_projection_turn_items`;
      yield* sql`INSERT INTO ardud_archive.ardud_events(sequence,event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json,application_event_version) SELECT sequence,event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json,application_event_version FROM orchestration_events`;
      yield* sql`DELETE FROM orchestration_events`;
      const service = yield* ThreadRedaction.ThreadRedaction;
      const result = yield* service.redactItem({
        threadId,
        itemId: "call-fixture",
        reason: "fixture",
        compact: true,
      });
      expect(
        result.stores
          .filter((s) => s.store.startsWith("archive."))
          .every((s) => s.replaced > 0 && s.remainingAfter === 0),
      ).toBe(true);
      const count = yield* Effect.promise(async () => {
        const db = new NodeSqlite.DatabaseSync(NodePath.join(config.stateDir, "archive.sqlite"));
        try {
          return JSON.stringify(db.prepare("SELECT * FROM ardud_events").all()).includes(fake);
        } finally {
          db.close();
        }
      });
      expect(count).toBe(false);
    }),
  ),
);

it.effect.each(["claudeAgent", "codex"])(
  "verifies %s provider files, spill, logs and a needle sweep without echoing content",
  (driver) =>
    run(
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const config = yield* Config.ServerConfig;
        const paths = yield* Effect.promise(async () => {
          const root = NodePath.join(
            config.baseDir,
            "harness-homes",
            driver === "codex" ? "codex" : "claude",
            driver === "codex" ? "sessions/2026/01/01" : "projects/fixture",
          );
          await NodeFSP.mkdir(root, { recursive: true });
          const file = NodePath.join(
            root,
            driver === "codex" ? "rollout-session-fixture.jsonl" : "session-fixture.jsonl",
          );
          const spill = NodePath.join(
            root,
            NodePath.basename(file, ".jsonl"),
            "tool-results",
            "call-fixture.txt",
          );
          await NodeFSP.mkdir(NodePath.dirname(spill), { recursive: true });
          await NodeFSP.writeFile(spill, fake);
          const value =
            driver === "codex"
              ? { type: "function_call_output", call_id: "call-fixture", output: fake }
              : { type: "tool_result", tool_use_id: "call-fixture", content: fake };
          await NodeFSP.writeFile(
            file,
            JSON.stringify(value) + "\n" + JSON.stringify({ summary: fake }) + "\n",
          );
          const needle = NodePath.join(config.baseDir, "needle");
          await NodeFSP.writeFile(needle, "SECOND-FAKE-TOKEN", { mode: 0o600 });
          const log = NodePath.join(config.logsDir, "fixture.log");
          await NodeFSP.writeFile(
            log,
            JSON.stringify({ output: fake, extra: "SECOND-FAKE-TOKEN" }),
          );
          return { file, spill, needle, log };
        });
        yield* sql`INSERT INTO projection_thread_sessions(thread_id,status,provider_name,provider_session_id,updated_at) VALUES (${threadId},'stopped',${driver},'session-fixture','2026-01-01')`;
        const service = yield* ThreadRedaction.ThreadRedaction;
        const result = yield* service.redactItem({
          threadId,
          itemId: "call-fixture",
          reason: "fixture",
          compact: true,
          needleFile: paths.needle,
        });
        expect(result.verify).toBe(true);
        expect(JSON.stringify(result).includes(fake)).toBe(false);
        const text = yield* Effect.promise(async () =>
          Promise.all(
            [paths.file, paths.spill, paths.log].map((file) => NodeFSP.readFile(file, "utf8")),
          ),
        );
        expect(text.join().includes(fake)).toBe(false);
        expect(text.join().includes("SECOND-FAKE-TOKEN")).toBe(false);
      }),
    ),
);

it.effect(
  "advances revisions in projections and replay events while preserving unrelated items",
  () =>
    run(
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const oldRevision = "2026-01-01T00:00:00.000Z";
        yield* sql`UPDATE orchestration_v2_projection_turn_items SET payload_json = ${JSON.stringify({ ...fixture, updatedAt: oldRevision })}, updated_at = ${oldRevision}`;
        yield* sql`INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,ordinal,type,status,updated_at,payload_json) VALUES ('untouched-item',${threadId},2,'command_execution','completed',${oldRevision},${JSON.stringify({ ...fixture, id: "untouched-item", output: "other output", nativeItemRef: null, updatedAt: oldRevision })})`;
        const service = yield* ThreadRedaction.ThreadRedaction;
        yield* service.redactItem({
          threadId,
          itemId: "call-fixture",
          reason: "fixture",
          compact: true,
        });
        const items = yield* sql<{
          turn_item_id: string;
          updated_at: string;
          payload_json: string;
        }>`SELECT * FROM orchestration_v2_projection_turn_items ORDER BY ordinal`;
        expect(items[0]!.updated_at > oldRevision).toBe(true);
        expect(JSON.parse(items[0]!.payload_json).updatedAt).toBe(items[0]!.updated_at);
        expect(items[1]!.updated_at).toBe(oldRevision);
        const event = yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM orchestration_events WHERE event_id = 'fixture-event'`;
        expect(JSON.parse(event[0]!.payload_json).updatedAt).toBe(items[0]!.updated_at);
      }),
    ),
);

// Every stage that can fail after a prior file was replaced must leave a retry source.
it.effect.each(
  ["claudeAgent", "codex"].flatMap((driver) =>
    ["provider", "log", "commit"].map((failure) => ({ driver, failure })),
  ),
)("retries after $driver $failure failure without a needle file", ({ driver, failure }) =>
  run(
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const config = yield* Config.ServerConfig;
      const root = NodePath.join(
        config.baseDir,
        "harness-homes",
        driver === "codex" ? "codex" : "claude",
        driver === "codex" ? "sessions" : "projects",
        "fixture",
      );
      const file = NodePath.join(root, "session-fixture.jsonl");
      const log = NodePath.join(config.logsDir, "fixture.log");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(root, { recursive: true });
        await NodeFSP.writeFile(
          file,
          JSON.stringify(
            driver === "codex"
              ? { type: "function_call_output", call_id: "call-fixture", output: fake }
              : { type: "tool_result", tool_use_id: "call-fixture", content: fake },
          ) + "\n",
        );
        await NodeFSP.writeFile(log, fake);
        if (failure === "provider") await NodeFSP.chmod(root, 0o500);
        if (failure === "log") await NodeFSP.chmod(config.logsDir, 0o500);
      });
      if (failure === "commit")
        yield* sql`CREATE TRIGGER fixture_redaction_failure BEFORE INSERT ON orchestration_events WHEN NEW.event_type = 'thread.item-redacted' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`;
      yield* sql`INSERT INTO projection_thread_sessions(thread_id,status,provider_name,provider_session_id,updated_at) VALUES (${threadId},'stopped',${driver},'session-fixture','2026-01-01')`;
      const service = yield* ThreadRedaction.ThreadRedaction;
      const error = yield* service
        .redactItem({ threadId, itemId: "call-fixture", reason: "fixture", compact: true })
        .pipe(
          Effect.flip,
          Effect.ensuring(
            Effect.promise(async () => {
              await NodeFSP.chmod(root, 0o700);
              await NodeFSP.chmod(config.logsDir, 0o700);
            }),
          ),
        );
      expect(error.code).toBe("failed");
      expect(JSON.stringify(error).includes(fake)).toBe(false);
      const item = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id = 'item-fixture'`;
      expect(JSON.parse(item[0]!.payload_json).output).toBe(fake);
      if (failure !== "provider")
        expect((yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"))).includes(fake)).toBe(
          false,
        );
      if (failure === "commit") yield* sql`DROP TRIGGER fixture_redaction_failure`;
      const result = yield* service.redactItem({
        threadId,
        itemId: "call-fixture",
        reason: "fixture",
        compact: true,
      });
      expect(result.verify).toBe(true);
      expect(JSON.stringify(result).includes(fake)).toBe(false);
    }),
  ),
);

it.effect.each(
  ["claudeAgent", "codex"].flatMap((driver) =>
    ["log", "commit"].map((failure) => ({ driver, failure })),
  ),
)(
  "preserves provider-only recovery strings across $driver $failure failures and refuses lost recovery state",
  ({ driver, failure }) =>
    run(
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const config = yield* Config.ServerConfig;
        const providerOnly = "eyJFAKE.PROVIDER-ONLY.NO-SIGNATURE";
        const spillOnly = "eyJFAKE.SPILL-ONLY.NO-SIGNATURE";
        const root = NodePath.join(
          config.baseDir,
          "harness-homes",
          driver === "codex" ? "codex" : "claude",
          driver === "codex" ? "sessions" : "projects",
          "fixture",
        );
        const file = NodePath.join(root, "session-fixture.jsonl");
        const spill = NodePath.join(root, "session-fixture", "tool-results", "call-fixture.txt");
        const log = NodePath.join(config.logsDir, "fixture.log");
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(NodePath.dirname(spill), { recursive: true });
          await NodeFSP.writeFile(
            file,
            JSON.stringify(
              driver === "codex"
                ? { type: "function_call_output", call_id: "call-fixture", output: providerOnly }
                : { type: "tool_result", tool_use_id: "call-fixture", content: providerOnly },
            ) + "\n",
          );
          await NodeFSP.writeFile(spill, spillOnly);
          await NodeFSP.writeFile(
            log,
            JSON.stringify({ canonical: fake, quoted: providerOnly, spill: spillOnly }),
          );
          if (failure === "log") await NodeFSP.chmod(config.logsDir, 0o500);
        });
        yield* sql`INSERT INTO projection_thread_sessions(thread_id,status,provider_name,provider_session_id,updated_at) VALUES (${threadId},'stopped',${driver},'session-fixture','2026-01-01')`;
        if (failure === "commit")
          yield* sql`CREATE TRIGGER fixture_redaction_failure BEFORE INSERT ON orchestration_events WHEN NEW.event_type = 'thread.item-redacted' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`;
        const service = yield* ThreadRedaction.ThreadRedaction;
        const error = yield* service
          .redactItem({ threadId, itemId: "call-fixture", reason: "fixture", compact: true })
          .pipe(
            Effect.flip,
            Effect.ensuring(Effect.promise(() => NodeFSP.chmod(config.logsDir, 0o700))),
          );
        expect(error.code).toBe("failed");
        const providerText = yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"));
        const spillText = yield* Effect.promise(() => NodeFSP.readFile(spill, "utf8"));
        expect(providerText.includes(providerOnly)).toBe(false);
        expect(spillText.includes(spillOnly)).toBe(false);
        const fresh = yield* ThreadRedaction.ThreadRedaction.pipe(
          Effect.provide(
            Layer.fresh(ThreadRedaction.layer).pipe(
              Layer.provide(
                Layer.succeed(
                  ProviderEventLoggers.ProviderEventLoggers,
                  ProviderEventLoggers.NoOpProviderEventLoggers,
                ),
              ),
              Layer.provide(
                Layer.mock(CommandOutputHub.CommandOutputHub)({ forgetThread: () => Effect.void }),
              ),
            ),
          ),
        );
        const refused = yield* fresh
          .redactItem({ threadId, itemId: "call-fixture", reason: "fixture", compact: true })
          .pipe(Effect.flip);
        expect(refused.code).toBe("recovery_required");
        if (failure === "commit") yield* sql`DROP TRIGGER fixture_redaction_failure`;
        const result = yield* service.redactItem({
          threadId,
          itemId: "call-fixture",
          reason: "fixture",
          compact: true,
        });
        expect(result.verify).toBe(true);
        const rewritten = yield* Effect.promise(() => NodeFSP.readFile(log, "utf8"));
        for (const token of [fake, providerOnly, spillOnly]) {
          expect(rewritten.includes(token)).toBe(false);
          expect(JSON.stringify([result, error, refused]).includes(token)).toBe(false);
        }
        const recovery = yield* sql<{
          pending: number;
        }>`SELECT pending FROM ardud_thread_redaction_recovery WHERE thread_id=${threadId}`;
        expect(recovery[0]!.pending).toBe(0);
      }),
    ),
);

it.effect(
  "drains the real buffered provider logger before redaction and keeps timer flushes clean",
  () =>
    run(
      Effect.gen(function* () {
        yield* seed;
        const config = yield* Config.ServerConfig;
        const sql = yield* SqlClient.SqlClient;
        const store = yield* makeEventNdjsonLogStore(config.providerEventLogPath, {
          batchWindowMs: 1_000,
        });
        yield* Effect.addFinalizer(() => store.close());
        yield* store.logger("native").write({ output: fake }, threadId);
        expect((yield* Effect.promise(() => filesBelow(config.logsDir))).length).toBe(0);
        const root = NodePath.join(
          config.baseDir,
          "harness-homes",
          "claude",
          "projects",
          "fixture",
        );
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(root, { recursive: true });
          await NodeFSP.writeFile(
            NodePath.join(root, "session-fixture.jsonl"),
            JSON.stringify({ type: "tool_result", tool_use_id: "call-fixture", content: fake }) +
              "\n",
          );
        });
        yield* sql`INSERT INTO projection_thread_sessions(thread_id,status,provider_name,provider_session_id,updated_at) VALUES (${threadId},'stopped','claudeAgent','session-fixture','2026-01-01')`;
        const service = yield* ThreadRedaction.ThreadRedaction.pipe(
          Effect.provide(
            Layer.fresh(ThreadRedaction.layer).pipe(
              Layer.provide(
                Layer.succeed(ProviderEventLoggers.ProviderEventLoggers, {
                  native: store.logger("native"),
                  canonical: store.logger("canonical"),
                  withMaintenance: store.withMaintenance,
                }),
              ),
              Layer.provide(
                Layer.mock(CommandOutputHub.CommandOutputHub)({ forgetThread: () => Effect.void }),
              ),
            ),
          ),
        );
        const result = yield* service.redactItem({
          threadId,
          itemId: "call-fixture",
          reason: "fixture",
          compact: true,
        });
        expect(result.verify).toBe(true);
        expect(
          result.stores.some(
            (entry) => entry.store.startsWith(config.logsDir) && entry.replaced > 0,
          ),
        ).toBe(true);
        yield* TestClock.adjust(1_000);
        yield* store.close();
        const files = yield* Effect.promise(() => filesBelow(config.logsDir));
        const contents = yield* Effect.promise(() =>
          Promise.all(files.map((file) => NodeFSP.readFile(file, "utf8"))),
        );
        expect(contents.join().includes(fake)).toBe(false);
      }),
    ),
);

it.effect("drains the buffered server log before redaction and keeps later flushes clean", () =>
  run(
    Effect.gen(function* () {
      yield* seed;
      const config = yield* Config.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const sql = yield* SqlClient.SqlClient;
      const providerRoot = NodePath.join(
        config.baseDir,
        "harness-homes",
        "claude",
        "projects",
        "fixture",
      );
      yield* fs.makeDirectory(providerRoot, { recursive: true });
      yield* fs.writeFileString(
        NodePath.join(providerRoot, "session-fixture.jsonl"),
        JSON.stringify({ type: "tool_result", tool_use_id: "call-fixture", content: fake }) + "\n",
      );
      yield* sql`INSERT INTO projection_thread_sessions(thread_id,status,provider_name,provider_session_id,updated_at) VALUES (${threadId},'stopped','claudeAgent','session-fixture','2026-01-01')`;
      const filePath = NodePath.join(config.logsDir, "server.log");
      const fileLog = yield* ServerLogFile.make({ filePath });
      yield* Effect.logInfo("redaction fixture", { output: fake }).pipe(
        Effect.provide(Logger.layer([fileLog.logger], { mergeWithExisting: false })),
      );
      const service = yield* ThreadRedaction.ThreadRedaction.pipe(
        Effect.provide(
          Layer.fresh(ThreadRedaction.layer).pipe(
            Layer.provide(
              Layer.succeed(ServerLogFile.Maintenance, {
                withMaintenance: fileLog.withMaintenance,
              }),
            ),
            Layer.provide(
              Layer.succeed(
                ProviderEventLoggers.ProviderEventLoggers,
                ProviderEventLoggers.NoOpProviderEventLoggers,
              ),
            ),
            Layer.provide(
              Layer.succeed(
                SharedObservability.TraceStorageMaintenance,
                SharedObservability.NoOpTraceStorageMaintenance,
              ),
            ),
            Layer.provide(
              Layer.mock(CommandOutputHub.CommandOutputHub)({ forgetThread: () => Effect.void }),
            ),
          ),
        ),
      );
      const result = yield* service.redactItem({
        threadId,
        itemId: "call-fixture",
        reason: "fixture",
        compact: true,
      });
      expect(result.verify).toBe(true);
      yield* TestClock.adjust(1_000);
      const contents = yield* fs.readFileString(filePath);
      expect(contents.includes(fake)).toBe(false);
      expect(contents.includes("redaction fixture")).toBe(true);
    }),
  ),
);

const extendedStores = (distinct = true) =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    const config = yield* Config.ServerConfig;
    const basePath = NodePath.join(config.stateDir, "statev2.pre-shrink-fixture.sqlite");
    const replicaPath = NodePath.join(config.stateDir, "readonly", "state.sqlite");
    const baseOnly = distinct ? "eyJFAKE.BASE-ONLY.NO-SIGNATURE" : fake;
    const replicaOnly = distinct ? "eyJFAKE.REPLICA-ONLY.NO-SIGNATURE" : fake;
    yield* sql`CREATE TABLE ardud_opencode_import (native_session_id TEXT PRIMARY KEY, thread_id TEXT)`;
    yield* initializeKanbanSchema(sql);
    yield* sql`CREATE TABLE ardud_history_base_archive (filename TEXT NOT NULL)`;
    yield* sql`INSERT INTO ardud_history_base_archive VALUES ('statev2.pre-shrink-fixture.sqlite')`;
    yield* sql`INSERT INTO projection_thread_sessions(thread_id,status,provider_name,provider_session_id,updated_at) VALUES (${threadId},'stopped','claudeAgent','session-fixture','2026-01-01')`;
    yield* sql.unsafe("VACUUM main INTO ?", [basePath]);
    yield* Effect.promise(async () => {
      const base = new NodeSqlite.DatabaseSync(basePath);
      base
        .prepare("UPDATE orchestration_v2_projection_turn_items SET payload_json=?")
        .run(JSON.stringify({ ...fixture, output: baseOnly }));
      const itemSchema = String(
        base
          .prepare(
            "SELECT sql FROM sqlite_schema WHERE name='orchestration_v2_projection_turn_items'",
          )
          .get()!.sql,
      );
      base.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE");
      base.close();
      await NodeFSP.chmod(basePath, 0o400);
      await NodeFSP.mkdir(NodePath.dirname(replicaPath), { recursive: true });
      const replica = new NodeSqlite.DatabaseSync(replicaPath);
      replica.exec(
        `PRAGMA journal_mode=WAL; CREATE TABLE orchestration_events(sequence INTEGER PRIMARY KEY,event_type TEXT,stream_id TEXT,payload_json TEXT); ${itemSchema}`,
      );
      replica
        .prepare("INSERT INTO orchestration_events VALUES (1,'fixture.tool',?,?)")
        .run(threadId, JSON.stringify(fixture));
      replica
        .prepare(
          "INSERT INTO orchestration_v2_projection_turn_items (turn_item_id,thread_id,ordinal,type,status,updated_at,payload_json) VALUES ('item-fixture',?,1,'command_execution','completed','2026-01-01',?)",
        )
        .run(threadId, JSON.stringify({ ...fixture, output: replicaOnly }));
      replica.close();
      const root = NodePath.join(config.baseDir, "harness-homes", "claude", "projects", "fixture");
      await NodeFSP.mkdir(root, { recursive: true });
      await NodeFSP.writeFile(
        NodePath.join(root, "session-fixture.jsonl"),
        JSON.stringify({ type: "tool_result", tool_use_id: "call-fixture", content: fake }) + "\n",
      );
    });
    yield* sql`DETACH DATABASE ardud_base`;
    yield* sql.unsafe("ATTACH DATABASE ? AS ardud_base", [
      new URL(`file://${basePath}`).href + "?mode=ro",
    ]);
    return { basePath, replicaPath, baseOnly, replicaOnly };
  });

it.effect.each(
  [false, true].flatMap((rollback) => [false, true].map((baseOnly) => ({ rollback, baseOnly }))),
)(
  "redacts persistent stores (rollback=$rollback, baseOnly=$baseOnly), then export stays clean",
  ({ rollback, baseOnly }) =>
    run(
      Effect.gen(function* () {
        const paths = yield* extendedStores();
        const sql = yield* SqlClient.SqlClient;
        const config = yield* Config.ServerConfig;
        const service = yield* ThreadRedaction.ThreadRedaction;
        if (baseOnly)
          yield* sql`DELETE FROM orchestration_v2_projection_turn_items WHERE turn_item_id='item-fixture'`;
        if (rollback) {
          yield* sql`CREATE TRIGGER fixture_redaction_failure BEFORE INSERT ON orchestration_events WHEN NEW.event_type='thread.item-redacted' BEGIN SELECT RAISE(ABORT,'fixture'); END`;
          yield* service
            .redactItem({ threadId, itemId: "call-fixture", reason: "fixture", compact: true })
            .pipe(Effect.flip);
          const base = yield* sql<{
            payload_json: string;
          }>`SELECT payload_json FROM ardud_base.orchestration_v2_projection_turn_items WHERE turn_item_id='item-fixture'`;
          expect(base[0]!.payload_json.includes(paths.baseOnly)).toBe(true);
          yield* sql`DROP TRIGGER fixture_redaction_failure`;
        }
        const result = yield* service.redactItem({
          threadId,
          itemId: "call-fixture",
          reason: "fixture",
          compact: true,
        });
        expect(
          result.verify,
          JSON.stringify({
            checkpointed: result.checkpointed,
            providers: result.providers,
            remaining: result.stores.filter((s) => s.remainingAfter > 0),
          }),
        ).toBe(true);
        expect(result.stores.some((s) => s.store.startsWith("base.") && s.replaced > 0)).toBe(true);
        expect(result.stores.some((s) => s.store.startsWith("readonly.") && s.replaced > 0)).toBe(
          true,
        );
        const attached = yield* sql<{ name: string }>`PRAGMA database_list`;
        expect(attached.some((d) => d.name.startsWith("ardud_redaction_"))).toBe(false);
        expect((yield* Effect.promise(() => NodeFSP.stat(paths.basePath))).mode & 0o777).toBe(
          0o400,
        );
        const denied =
          yield* sql`UPDATE ardud_base.orchestration_v2_projection_turn_items SET payload_json='{}'`.pipe(
            Effect.result,
          );
        expect(denied._tag).toBe("Failure");
        yield* Effect.promise(async () => {
          const exporter = createReadonlyReplica(NodeSqlite, NodeFS, NodePath, {
            sourcePath: config.dbPath,
            replicaPath: paths.replicaPath,
            archivePath: NodePath.join(config.stateDir, "archive.sqlite"),
          });
          try {
            for (let cycle = 0; cycle < 2; cycle++) {
              let steps = 0;
              while (exporter.step())
                if (++steps > 500) throw new Error("Fixture export did not converge");
            }
          } finally {
            exporter.close();
          }
          for (const path of [config.dbPath, paths.basePath, paths.replicaPath]) {
            const data = await NodeFSP.readFile(path);
            for (const token of [fake, paths.baseOnly, paths.replicaOnly])
              expect(data.includes(Buffer.from(token))).toBe(false);
          }
        });
        for (const token of [fake, paths.baseOnly, paths.replicaOnly])
          expect(JSON.stringify(result).includes(token)).toBe(false);
      }),
    ),
);

it.effect.each(["-wal", "-journal"])("refuses an orphan readonly %s before rewriting", (suffix) =>
  run(
    Effect.gen(function* () {
      yield* seed;
      const config = yield* Config.ServerConfig;
      const sql = yield* SqlClient.SqlClient;
      const path = NodePath.join(config.stateDir, "readonly", "state.sqlite");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
        await NodeFSP.writeFile(`${path}${suffix}`, "eyJFAKE.ORPHAN-FIXTURE");
      });
      const service = yield* ThreadRedaction.ThreadRedaction;
      const failure = yield* service
        .redactItem({ threadId, itemId: "call-fixture", reason: "fixture", compact: true })
        .pipe(Effect.flip);
      expect(failure.code).toBe("maintenance_required");
      const unchanged = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id='item-fixture'`;
      expect(JSON.parse(unchanged[0]!.payload_json).output).toBe(fake);
    }),
  ),
);

it.live("redaction stops a real export worker and resumed publication stays clean", () =>
  run(
    Effect.gen(function* () {
      const paths = yield* extendedStores(false);
      const config = yield* Config.ServerConfig;
      const sql = yield* SqlClient.SqlClient;
      const startup = yield* Deferred.make<void, Error>();
      const published = yield* Deferred.make<void, Error>();
      const fail = (error: Error) => {
        Deferred.doneUnsafe(startup, Effect.fail(error));
        Deferred.doneUnsafe(published, Effect.fail(error));
      };
      let generation = 0;
      const control = yield* ReadonlyReplica.makeCoordinatedReplica(() => {
        const current = ++generation;
        const worker = new NodeWorkerThreads.Worker(
          ReadonlyReplica.exportWorkerSource(createReadonlyReplica.toString()),
          {
            eval: true,
            execArgv: [],
            workerData: {
              sourcePath: config.dbPath,
              replicaPath: paths.replicaPath,
              archivePath: NodePath.join(config.stateDir, "archive.sqlite"),
            },
          },
        );
        worker.on("message", (message: { type: string; stage?: string; error?: string }) => {
          if (message.type === "failed")
            fail(new Error(`Export worker ${current} failed (${message.stage}): ${message.error}`));
          if (current === 1 && message.type === "opened") Deferred.doneUnsafe(startup, Effect.void);
          if (current >= 2 && message.type === "published")
            Deferred.doneUnsafe(published, Effect.void);
        });
        worker.on("error", fail);
        return worker as unknown as ReadonlyReplica.ExportWorker;
      });
      const supervisor = yield* Effect.forkScoped(control.run, { startImmediately: true });
      yield* Deferred.await(startup);
      const service = yield* ThreadRedaction.ThreadRedaction.pipe(
        Effect.provide(
          Layer.fresh(ThreadRedaction.layer).pipe(
            Layer.provide(Layer.succeed(ReadonlyReplica.ReadonlyReplica, control)),
            Layer.provide(
              Layer.succeed(
                ProviderEventLoggers.ProviderEventLoggers,
                ProviderEventLoggers.NoOpProviderEventLoggers,
              ),
            ),
            Layer.provide(
              Layer.mock(CommandOutputHub.CommandOutputHub)({ forgetThread: () => Effect.void }),
            ),
          ),
        ),
      );
      const result = yield* service.redactItem({
        threadId,
        itemId: "call-fixture",
        reason: "fixture",
        compact: true,
      });
      expect(result.verify).toBe(true);
      yield* Deferred.await(published);
      yield* Fiber.interrupt(supervisor);
      const rows = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM ardud_base.orchestration_v2_projection_turn_items WHERE turn_item_id='item-fixture'`;
      expect(rows[0]!.payload_json.includes(fake)).toBe(false);
      const replica = yield* Effect.promise(() => NodeFSP.readFile(paths.replicaPath));
      expect(replica.includes(Buffer.from(fake))).toBe(false);
    }),
  ),
);

it.effect.each(["detach", "durability", "mode", "fullfsync"])(
  "retains recovery through a %s cleanup failure and retries cleanup before verification",
  (phase) =>
    run(
      Effect.gen(function* () {
        const paths = yield* extendedStores();
        const sql = yield* SqlClient.SqlClient;
        const config = yield* Config.ServerConfig;
        const service = yield* ThreadRedaction.ThreadRedaction;
        let broken = true;
        const restore = installWriterHooks({
          before(statement) {
            if (
              broken &&
              ((phase === "detach" && statement === "DETACH DATABASE ardud_redaction_base") ||
                (phase === "durability" && /^PRAGMA main.synchronous=\d/.test(statement)) ||
                (phase === "fullfsync" && /^PRAGMA fullfsync=\d/.test(statement)))
            )
              throw new Error("Fixture cleanup failure");
          },
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            broken = false;
            restore();
            filesystemFault.failMode = false;
            filesystemFault.path = "";
          }),
        );
        filesystemFault.path = NodePath.basename(paths.basePath);
        filesystemFault.failMode = phase === "mode";
        const failed = yield* service
          .redactItem({ threadId, itemId: "call-fixture", reason: "fixture", compact: true })
          .pipe(Effect.flip);
        expect(failed.code).toBe("maintenance_required");
        const pending = yield* sql<{
          pending: number;
        }>`SELECT pending FROM ardud_thread_redaction_recovery WHERE thread_id=${threadId}`;
        expect(pending[0]!.pending).toBe(1);
        yield* Effect.promise(async () => {
          expect(() =>
            createReadonlyReplica(NodeSqlite, NodeFS, NodePath, {
              sourcePath: config.dbPath,
              replicaPath: paths.replicaPath,
            }),
          ).toThrow("incomplete redaction maintenance");
        });
        broken = false;
        filesystemFault.failMode = false;
        const result = yield* service.redactItem({
          threadId,
          itemId: "call-fixture",
          reason: "fixture",
          compact: true,
        });
        expect(result.verify).toBe(true);
        expect((yield* Effect.promise(() => NodeFSP.stat(paths.basePath))).mode & 0o777).toBe(
          0o400,
        );
        const complete = yield* sql<{
          pending: number;
        }>`SELECT pending FROM ardud_thread_redaction_recovery WHERE thread_id=${threadId}`;
        expect(complete[0]!.pending).toBe(0);
        for (const token of [fake, paths.baseOnly, paths.replicaOnly])
          expect(JSON.stringify([failed, result]).includes(token)).toBe(false);
      }),
    ),
);

it.effect(
  "redacts nested multiline copies in receipts, provider summaries and logs without false verification",
  () =>
    run(
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const config = yield* Config.ServerConfig;
        const output = 'eyJFAKE.NESTED\n"quoted"\\tail';
        const nested = JSON.stringify(JSON.stringify(output));
        yield* sql`UPDATE orchestration_v2_projection_turn_items SET payload_json=${JSON.stringify({ ...fixture, output })} WHERE turn_item_id='item-fixture'`;
        yield* sql`INSERT INTO orchestration_v2_command_receipts(command_id,thread_id,command_type,accepted_at,result_sequence,status,error) VALUES ('nested',${threadId},'fixture','2026-01-01',0,'ok',${nested})`;
        yield* sql`INSERT INTO projection_thread_sessions(thread_id,status,provider_name,provider_session_id,updated_at) VALUES (${threadId},'stopped','claudeAgent','session-fixture','2026-01-01')`;
        const file = NodePath.join(
          config.baseDir,
          "harness-homes",
          "claude",
          "projects",
          "fixture",
          "session-fixture.jsonl",
        );
        const log = NodePath.join(config.logsDir, "nested.log");
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
          await NodeFSP.writeFile(
            file,
            JSON.stringify({ type: "tool_result", tool_use_id: "call-fixture", content: output }) +
              "\n" +
              JSON.stringify({ summary: nested }) +
              "\n",
          );
          await NodeFSP.writeFile(log, JSON.stringify({ quoted: nested }));
        });
        const service = yield* ThreadRedaction.ThreadRedaction;
        const result = yield* service.redactItem({
          threadId,
          itemId: "call-fixture",
          reason: "fixture",
          compact: true,
        });
        expect(result.verify).toBe(true);
        const receipt = yield* sql<{
          error: string;
        }>`SELECT error FROM orchestration_v2_command_receipts WHERE command_id='nested'`;
        const files = yield* Effect.promise(() =>
          Promise.all([file, log].map((p) => NodeFSP.readFile(p, "utf8"))),
        );
        expect(JSON.stringify([receipt, files, result]).includes("eyJFAKE.NESTED")).toBe(false);
      }),
    ),
);

const nativeIdForms = [
  "nativeItemRef",
  "toolCallId",
  "tool_use_id",
  "toolUseId",
  "callId",
  "callID",
  "call_id",
  "nested",
];
it.effect.each(
  nativeIdForms.flatMap((form) =>
    ["claudeAgent", "codex"].flatMap((driver) =>
      [true, false].map((matching) => ({ form, driver, matching })),
    ),
  ),
)(
  "requires matching provider result for activity id ($form, $driver, match=$matching)",
  ({ form, driver, matching }) =>
    run(
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const config = yield* Config.ServerConfig;
        const identity =
          form === "nativeItemRef"
            ? { nativeItemRef: { nativeId: "call-fixture" } }
            : form === "nested"
              ? { nativeItemRef: null, tool: { toolCallId: "call-fixture" } }
              : { nativeItemRef: null, [form]: "call-fixture" };
        yield* sql`UPDATE orchestration_v2_projection_turn_items SET payload_json=${JSON.stringify({ ...fixture, ...identity })}`;
        yield* sql`INSERT INTO projection_thread_sessions(thread_id,status,provider_name,provider_session_id,updated_at) VALUES (${threadId},'stopped',${driver},'session-fixture','2026-01-01')`;
        const providerOnly = "eyJFAKE.PROVIDER-ACTIVITY-ONLY";
        const file = NodePath.join(
          config.baseDir,
          "harness-homes",
          driver === "codex" ? "codex" : "claude",
          driver === "codex" ? "sessions" : "projects",
          "fixture",
          "session-fixture.jsonl",
        );
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
          const call = matching ? "call-fixture" : "different-call";
          await NodeFSP.writeFile(
            file,
            JSON.stringify(
              driver === "codex"
                ? { type: "function_call_output", call_id: call, output: providerOnly }
                : { type: "tool_result", tool_use_id: call, content: providerOnly },
            ) + "\n",
          );
        });
        const service = yield* ThreadRedaction.ThreadRedaction;
        const result = yield* service.redactItem({
          threadId,
          itemId: "item-fixture",
          reason: "fixture",
          compact: true,
        });
        expect(result.verify).toBe(matching);
        expect(result.providers[0]!.status).toBe(matching ? "rewritten" : "missing");
        expect(
          (yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"))).includes(providerOnly),
        ).toBe(!matching);
      }),
    ),
);

it.effect(
  "cancellation before rewriting clears the fresh guard after cleanup and permits retry",
  () =>
    run(
      Effect.gen(function* () {
        yield* extendedStores(false);
        const sql = yield* SqlClient.SqlClient;
        const service = yield* ThreadRedaction.ThreadRedaction;
        let entered!: () => void;
        let release!: () => void;
        const started = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const hold = new Promise<void>((resolve) => {
          release = resolve;
        });
        filesystemFault.inventory = async () => {
          entered();
          await hold;
        };
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            filesystemFault.inventory = undefined;
            release();
          }),
        );
        const operation = yield* Effect.forkScoped(
          service.redactItem({
            threadId,
            itemId: "item-fixture",
            reason: "fixture",
            compact: true,
          }),
          { startImmediately: true },
        );
        yield* Effect.promise(() => started);
        yield* Fiber.interrupt(operation);
        filesystemFault.inventory = undefined;
        release();
        const guard = yield* sql<{
          pending: number;
        }>`SELECT pending FROM ardud_thread_redaction_recovery WHERE thread_id=${threadId}`;
        expect(guard[0]!.pending).toBe(0);
        const result = yield* service.redactItem({
          threadId,
          itemId: "item-fixture",
          reason: "fixture",
          compact: true,
        });
        expect(result.verify).toBe(true);
      }),
    ),
);

it.effect("requires explicit compaction to verify erasure of fragmented overflow residue", () =>
  run(
    Effect.gen(function* () {
      yield* extendedStores(false);
      const sql = yield* SqlClient.SqlClient;
      const config = yield* Config.ServerConfig;
      const output = "eyJFAKE.OVERFLOW-SEGMENT.".repeat(5000);
      yield* sql`UPDATE orchestration_v2_projection_turn_items SET payload_json=${JSON.stringify({ ...fixture, output })}`;
      yield* sql`PRAGMA secure_delete=OFF`;
      yield* sql`CREATE TABLE freed_fixture (output TEXT)`;
      yield* sql`INSERT INTO freed_fixture VALUES (${output})`;
      yield* sql`DELETE FROM freed_fixture`;
      const service = yield* ThreadRedaction.ThreadRedaction;
      const first = yield* service.redactItem({
        threadId,
        itemId: "item-fixture",
        reason: "fixture",
      });
      expect(first.compacted).toBe(false);
      expect(first.verify).toBe(false);
      const second = yield* service.redactItem({
        threadId,
        itemId: "item-fixture",
        reason: "fixture",
        compact: true,
      });
      expect(second.compacted).toBe(true);
      expect(second.verify).toBe(true);
      const data = yield* Effect.promise(() => NodeFSP.readFile(config.dbPath));
      expect(data.includes(Buffer.from("eyJFAKE.OVERFLOW-SEGMENT."))).toBe(false);
    }),
  ),
);

it.effect(
  "publishes a committed redaction to already-open bounded and typed live thread subscriptions in sequence",
  () =>
    run(
      Effect.gen(function* () {
        yield* extendedStores(false);
        const sink = yield* EventSink.EventSinkV2;
        const service = yield* ThreadRedaction.ThreadRedaction;
        const publish = (reason: string) =>
          sink.write({
            events: [
              {
                id: EventId.make(`fixture:${reason}`),
                type: "thread.item-redacted",
                threadId,
                occurredAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
                payload: { itemId: "item-fixture", reason, at: "2026-01-01T00:00:00.000Z" },
              },
            ],
          });
        yield* publish("before");
        const boundedReady = yield* Deferred.make<void>();
        const typedReady = yield* Deferred.make<void>();
        const observe = (bounded: boolean, ready: Deferred.Deferred<void>) =>
          sink
            .stream({
              threadId,
              bounded,
              ...(bounded ? {} : { eventType: "thread.item-redacted" as const }),
            })
            .pipe(
              Stream.tap((stored) =>
                stored.event.type === "thread.item-redacted" &&
                stored.event.payload.reason === "before"
                  ? Deferred.succeed(ready, undefined)
                  : Effect.void,
              ),
              Stream.take(3),
              Stream.runCollect,
              Effect.forkScoped,
            );
        const bounded = yield* observe(true, boundedReady);
        const typed = yield* observe(false, typedReady);
        yield* Deferred.await(boundedReady);
        yield* Deferred.await(typedReady);
        const result = yield* service.redactItem({
          threadId,
          itemId: "item-fixture",
          reason: "fixture",
          compact: true,
        });
        expect(result.verify).toBe(true);
        yield* publish("after");
        for (const fiber of [bounded, typed]) {
          const events = yield* Fiber.join(fiber);
          expect(
            events.map((stored) =>
              stored.event.type === "thread.item-redacted"
                ? stored.event.payload.reason
                : "unexpected",
            ),
          ).toEqual(["before", "fixture", "after"]);
          expect(
            events[0]!.sequence < events[1]!.sequence && events[1]!.sequence < events[2]!.sequence,
          ).toBe(true);
        }
      }),
    ),
);

const traceRecord = (name: string, output: string): SharedObservability.TraceRecord => ({
  type: "effect-span",
  name,
  traceId: "fixture-trace",
  spanId: name,
  sampled: true,
  kind: "internal",
  startTimeUnixNano: "1",
  endTimeUnixNano: "2",
  durationMs: 1,
  attributes: { output },
  events: [],
  links: [],
  exit: { _tag: "Success" },
});
it.effect("drains and fences the real trace sink including late span completions", () =>
  run(
    Effect.gen(function* () {
      yield* extendedStores(false);
      const config = yield* Config.ServerConfig;
      const trace = yield* SharedObservability.makeTraceSink({
        filePath: config.serverTracePath,
        maxBytes: 1000000,
        maxFiles: 2,
        batchWindowMs: 1000,
      });
      trace.push(traceRecord("buffered", fake));
      const late = trace.capture();
      const service = yield* ThreadRedaction.ThreadRedaction.pipe(
        Effect.provide(
          Layer.fresh(ThreadRedaction.layer).pipe(
            Layer.provide(
              Layer.succeed(SharedObservability.TraceStorageMaintenance, {
                withMaintenance: (effect) =>
                  trace.withMaintenance(
                    Effect.gen(function* () {
                      trace.push(traceRecord("during", fake));
                      return yield* effect;
                    }),
                  ),
              }),
            ),
            Layer.provide(
              Layer.succeed(
                ProviderEventLoggers.ProviderEventLoggers,
                ProviderEventLoggers.NoOpProviderEventLoggers,
              ),
            ),
            Layer.provide(
              Layer.mock(CommandOutputHub.CommandOutputHub)({ forgetThread: () => Effect.void }),
            ),
          ),
        ),
      );
      const result = yield* service.redactItem({
        threadId,
        itemId: "item-fixture",
        reason: "fixture",
        compact: true,
      });
      expect(result.verify).toBe(true);
      expect(result.stores.some((s) => s.store === config.serverTracePath && s.replaced > 0)).toBe(
        true,
      );
      late(traceRecord("late", fake));
      trace.push(traceRecord("after", "safe output"));
      yield* TestClock.adjust(1000);
      yield* trace.flush;
      const text = yield* Effect.promise(() => NodeFSP.readFile(config.serverTracePath, "utf8"));
      expect(text.includes(fake)).toBe(false);
      expect(text.includes("safe output")).toBe(true);
    }),
  ),
);

it.effect("publication completes when cancellation arrives in the actual COMMIT", () =>
  run(
    Effect.gen(function* () {
      yield* extendedStores(false);
      const sink = yield* EventSink.EventSinkV2;
      const service = yield* ThreadRedaction.ThreadRedaction;
      const sql = yield* SqlClient.SqlClient;
      const before = yield* sink.write({
        events: [
          {
            id: EventId.make("fixture:before-commit-cancel"),
            type: "thread.item-redacted",
            threadId,
            occurredAt: DateTime.makeUnsafe("2026-01-01"),
            payload: { itemId: "item-fixture", reason: "before", at: "2026-01-01" },
          },
        ],
      });
      const ready = yield* Deferred.make<void>();
      const received = yield* sink
        .stream({ threadId, afterSequence: before[0]!.sequence - 1 })
        .pipe(
          Stream.tap(() => Deferred.succeed(ready, undefined)),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkScoped,
        );
      yield* Deferred.await(ready);
      let injected = false;
      const restore = installWriterHooks({
        after(source, fiber) {
          if (source.trim() === "COMMIT" && !injected) {
            injected = true;
            fiber?.interruptUnsafe();
          }
        },
      });
      yield* Effect.addFinalizer(() => Effect.sync(restore));
      const operation = yield* Effect.forkScoped(
        service.redactItem({ threadId, itemId: "item-fixture", reason: "fixture", compact: true }),
        { startImmediately: true },
      );
      yield* Fiber.await(operation);
      restore();
      expect(injected).toBe(true);
      const events = yield* Fiber.join(received);
      expect(events[1]!.event.type).toBe("thread.item-redacted");
      const item = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id='item-fixture'`;
      expect(item[0]!.payload_json.includes(fake)).toBe(false);
    }),
  ),
);

it.effect("trace-drain failure refuses before database mutation", () =>
  run(
    Effect.gen(function* () {
      yield* extendedStores(false);
      const config = yield* Config.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const trace = yield* SharedObservability.makeTraceSink({
        filePath: config.serverTracePath,
        maxBytes: 1000000,
        maxFiles: 2,
        batchWindowMs: 1000,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          writeFile: () =>
            Effect.fail(
              new PlatformError.PlatformError(
                new PlatformError.SystemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "writeFile",
                }),
              ),
            ),
        }),
      );
      trace.push(traceRecord("blocked", fake));
      const service = yield* ThreadRedaction.ThreadRedaction.pipe(
        Effect.provide(
          Layer.fresh(ThreadRedaction.layer).pipe(
            Layer.provide(
              Layer.succeed(SharedObservability.TraceStorageMaintenance, {
                withMaintenance: trace.withMaintenance,
              }),
            ),
            Layer.provide(
              Layer.succeed(
                ProviderEventLoggers.ProviderEventLoggers,
                ProviderEventLoggers.NoOpProviderEventLoggers,
              ),
            ),
            Layer.provide(
              Layer.mock(CommandOutputHub.CommandOutputHub)({ forgetThread: () => Effect.void }),
            ),
          ),
        ),
      );
      const result = yield* service
        .redactItem({ threadId, itemId: "item-fixture", reason: "fixture", compact: true })
        .pipe(Effect.flip);
      expect(result.code).toBe("maintenance_required");
      const sql = yield* SqlClient.SqlClient;
      const item = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id='item-fixture'`;
      expect(item[0]!.payload_json.includes(fake)).toBe(true);
    }),
  ),
);

it.effect(
  "redacting a dynamic tool output preserves input content, arguments and their copies",
  () =>
    run(
      Effect.gen(function* () {
        yield* extendedStores(false);
        const sql = yield* SqlClient.SqlClient;
        const input = {
          content: "unrelated input content",
          result: "unrelated input result",
          stdout: "unrelated input stdout",
        };
        const item = {
          ...fixture,
          type: "dynamic_tool",
          input,
          arguments: { content: "unrelated arguments content" },
          output: fake,
        };
        yield* sql`UPDATE orchestration_v2_projection_turn_items SET payload_json=${JSON.stringify(item)}`;
        yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES ('input-copy',${threadId},'assistant',${JSON.stringify(input)},0,'2026-01-01','2026-01-01')`;
        const service = yield* ThreadRedaction.ThreadRedaction;
        const result = yield* service.redactItem({
          threadId,
          itemId: "item-fixture",
          reason: "fixture",
          compact: true,
        });
        expect(result.verify).toBe(true);
        const row = yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id='item-fixture'`;
        expect(JSON.parse(row[0]!.payload_json).input).toEqual(input);
        expect(JSON.parse(row[0]!.payload_json).arguments).toEqual(item.arguments);
        const copy = yield* sql<{
          text: string;
        }>`SELECT text FROM projection_thread_messages WHERE message_id='input-copy'`;
        expect(copy[0]!.text).toBe(JSON.stringify(input));
      }),
    ),
);

it.effect.each(["claudeAgent", "codex"])(
  "redacts %s alternate Unicode result spellings discovered through the native call",
  (driver) =>
    run(
      Effect.gen(function* () {
        yield* extendedStores(false);
        const config = yield* Config.ServerConfig;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE projection_thread_sessions SET provider_name=${driver}`;
        const providerOnly = "eyJFAKE/UNICODE-ONLY";
        const file = NodePath.join(
          config.baseDir,
          "harness-homes",
          driver === "codex" ? "codex" : "claude",
          driver === "codex" ? "sessions" : "projects",
          "fixture",
          "session-fixture.jsonl",
        );
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
          const result =
            driver === "codex"
              ? { type: "function_call_output", call_id: "call-fixture", output: providerOnly }
              : { type: "tool_result", tool_use_id: "call-fixture", content: providerOnly };
          await NodeFSP.writeFile(
            file,
            JSON.stringify(result).replace("eyJFAKE/", "\\u0065yJFAKE\\/") +
              "\n" +
              JSON.stringify({ summary: JSON.stringify(providerOnly) }).replace(
                "eyJFAKE/",
                "\\u0065yJFAKE/",
              ) +
              "\n",
          );
        });
        const service = yield* ThreadRedaction.ThreadRedaction;
        const result = yield* service.redactItem({
          threadId,
          itemId: "item-fixture",
          reason: "fixture",
          compact: true,
        });
        expect(result.verify).toBe(true);
        const text = yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"));
        expect(
          text
            .trim()
            .split("\n")
            .every((v) => JSON.parse(v)),
        ).toBe(true);
        expect(text.includes("UNICODE-ONLY")).toBe(false);
      }),
    ),
);

it.effect.each([
  { form: "numeric", value: "3141592653589793" },
  { form: "JSON document", value: '{"eyJFAKE":"whole-document"}' },
  { form: "quoted", value: '"eyJFAKE.quoted-plain"' },
])("redacts literal $form output in plain SQL cells, spills and logs", ({ value }) =>
  run(
    Effect.gen(function* () {
      yield* extendedStores(false);
      const sql = yield* SqlClient.SqlClient;
      const config = yield* Config.ServerConfig;
      yield* sql`UPDATE orchestration_v2_projection_turn_items SET payload_json=${JSON.stringify({ ...fixture, output: value })}`;
      yield* sql`UPDATE projection_thread_messages SET text=${value} WHERE message_id='quote'`;
      const root = NodePath.join(config.baseDir, "harness-homes", "claude", "projects", "fixture");
      const transcript = NodePath.join(root, "session-fixture.jsonl");
      const spill = NodePath.join(root, "session-fixture", "tool-results", "call-fixture.txt");
      const log = NodePath.join(config.logsDir, "plain.log");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.dirname(spill), { recursive: true });
        await NodeFSP.writeFile(
          transcript,
          JSON.stringify({ type: "tool_result", tool_use_id: "call-fixture", content: value }) +
            "\n",
        );
        await NodeFSP.writeFile(spill, value);
        await NodeFSP.writeFile(log, value);
      });
      const service = yield* ThreadRedaction.ThreadRedaction;
      const result = yield* service.redactItem({
        threadId,
        itemId: "item-fixture",
        reason: "fixture",
        compact: true,
      });
      expect(result.verify).toBe(true);
      const row = yield* sql<{
        text: string;
      }>`SELECT text FROM projection_thread_messages WHERE message_id='quote'`;
      expect(row[0]!.text).not.toBe(value);
      const files = yield* Effect.promise(() =>
        Promise.all([spill, log].map((p) => NodeFSP.readFile(p, "utf8"))),
      );
      expect(files.every((text) => !text.includes(value))).toBe(true);
    }),
  ),
);

it.effect.each(["input", "arguments", "output", "result"])(
  "an id occurring only in $s cannot select an item",
  (field) =>
    run(
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const value = {
          ...fixture,
          [field]: {
            id: "nonexistent-call",
            toolCallId: "nonexistent-call",
            nested: { nativeId: "nonexistent-call" },
          },
        };
        yield* sql`UPDATE orchestration_v2_projection_turn_items SET payload_json=${JSON.stringify(value)}`;
        const service = yield* ThreadRedaction.ThreadRedaction;
        const failure = yield* service
          .redactItem({ threadId, itemId: "nonexistent-call", reason: "fixture", compact: true })
          .pipe(Effect.flip);
        expect(failure.code).toBe("not_found");
        const row = yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id='item-fixture'`;
        expect(row[0]!.payload_json).toBe(JSON.stringify(value));
      }),
    ),
);

it.effect.each(["status", "type", "id", "toolName"])(
  "rejects a $s structural collision before any content rewrite",
  (field) =>
    run(
      Effect.gen(function* () {
        yield* extendedStores(false);
        const sql = yield* SqlClient.SqlClient;
        const value = {
          ...fixture,
          toolName: "fixture-tool",
          output:
            field === "status"
              ? "completed"
              : field === "type"
                ? fixture.type
                : field === "id"
                  ? fixture.id
                  : "fixture-tool",
          status: "completed",
        };
        yield* sql`UPDATE orchestration_v2_projection_turn_items SET payload_json=${JSON.stringify(value)}`;
        const service = yield* ThreadRedaction.ThreadRedaction;
        const failure = yield* service
          .redactItem({ threadId, itemId: "item-fixture", reason: "fixture", compact: true })
          .pipe(Effect.flip);
        expect(failure.code).toBe("invalid");
        const row = yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id='item-fixture'`;
        expect(row[0]!.payload_json).toBe(JSON.stringify(value));
        const audit =
          yield* sql`SELECT event_id FROM orchestration_events WHERE event_type='thread.item-redacted'`;
        expect(audit.length).toBe(0);
      }),
    ),
);

it.effect("refuses complete structured output erasure that would also change metadata keys", () =>
  run(
    Effect.gen(function* () {
      yield* extendedStores(false);
      const sql = yield* SqlClient.SqlClient;
      const output = {
        id: "eyJFAKE.OUTPUT-ID",
        status: "eyJFAKE.OUTPUT-STATUS",
        type: "eyJFAKE.OUTPUT-TYPE",
        text: "eyJFAKE.OUTPUT-TEXT",
      };
      yield* sql`UPDATE orchestration_v2_projection_turn_items SET payload_json=${JSON.stringify({ ...fixture, type: "dynamic_tool", output })}`;
      const service = yield* ThreadRedaction.ThreadRedaction;
      const result = yield* service
        .redactItem({
          threadId,
          itemId: "item-fixture",
          reason: "fixture",
          compact: true,
        })
        .pipe(Effect.flip);
      expect(result.code).toBe("invalid");
      const rows = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id='item-fixture'`;
      for (const token of Object.values(output))
        expect(rows[0]!.payload_json.includes(token)).toBe(true);
    }),
  ),
);

it.effect.each(["claudeAgent", "codex"])(
  "ignores %s input examples that imitate a native result",
  (driver) =>
    run(
      Effect.gen(function* () {
        yield* extendedStores(false);
        const sql = yield* SqlClient.SqlClient;
        const config = yield* Config.ServerConfig;
        yield* sql`UPDATE projection_thread_sessions SET provider_name=${driver}`;
        const unrelated = "eyJFAKE.UNRELATED-INPUT-EXAMPLE";
        const root = NodePath.join(
          config.baseDir,
          "harness-homes",
          driver === "codex" ? "codex" : "claude",
          driver === "codex" ? "sessions" : "projects",
          "fixture",
        );
        const file = NodePath.join(root, "session-fixture.jsonl");
        const result =
          driver === "codex"
            ? { type: "function_call_output", call_id: "call-fixture", output: unrelated }
            : { type: "tool_result", tool_use_id: "call-fixture", content: unrelated };
        const example =
          driver === "codex"
            ? {
                type: "response_item",
                payload: { type: "function_call", arguments: { example: result } },
              }
            : {
                type: "assistant",
                message: { content: [{ type: "tool_use", input: { example: result } }] },
              };
        const original = JSON.stringify(example) + "\n";
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(root, { recursive: true });
          await NodeFSP.writeFile(file, original);
        });
        const service = yield* ThreadRedaction.ThreadRedaction;
        const scrub = yield* service.redactItem({
          threadId,
          itemId: "item-fixture",
          reason: "fixture",
          compact: true,
        });
        expect(scrub.verify).toBe(false);
        expect(scrub.providers.find((p) => p.provider === driver)?.status).toBe("missing");
        expect(yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"))).toBe(original);
      }),
    ),
);

it.effect.each([
  { form: "number", value: "3141592653589793", copy: 3141592653589793 },
  { form: "document", value: '{"eyJFAKE":"document-copy"}', copy: { eyJFAKE: "document-copy" } },
])("redacts a complete $form embedded in JSON log values", ({ value, copy }) =>
  run(
    Effect.gen(function* () {
      yield* extendedStores(false);
      const sql = yield* SqlClient.SqlClient;
      const config = yield* Config.ServerConfig;
      yield* sql`UPDATE orchestration_v2_projection_turn_items SET payload_json=${JSON.stringify({ ...fixture, output: value })}`;
      const file = NodePath.join(config.logsDir, "embedded.log");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          file,
          JSON.stringify({ copy }) + "\nNTIVE: " + JSON.stringify({ copy }) + "\n",
        ),
      );
      const service = yield* ThreadRedaction.ThreadRedaction;
      const result = yield* service.redactItem({
        threadId,
        itemId: "item-fixture",
        reason: "fixture",
        compact: true,
      });
      expect(result.verify).toBe(true);
      const text = yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"));
      expect(text.includes(value)).toBe(false);
      expect(text.includes("document-copy")).toBe(false);
    }),
  ),
);

it.effect("a wrapper array supplies the native provider identity", () =>
  run(
    Effect.gen(function* () {
      yield* extendedStores(false);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE orchestration_v2_projection_turn_items SET payload_json=${JSON.stringify({ ...fixture, nativeItemRef: null, payload: [{ toolCallId: "call-fixture" }] })}`;
      const service = yield* ThreadRedaction.ThreadRedaction;
      const result = yield* service.redactItem({
        threadId,
        itemId: "item-fixture",
        reason: "fixture",
        compact: true,
      });
      expect(result.verify).toBe(true);
    }),
  ),
);

it.effect.each(["ardud_redaction_base", "ardud_redaction_replica"])(
  "cancellation after successful ATTACH of $s cannot leak its writable alias",
  (alias) =>
    run(
      Effect.gen(function* () {
        yield* extendedStores(false);
        const service = yield* ThreadRedaction.ThreadRedaction;
        const sql = yield* SqlClient.SqlClient;
        let injected = false;
        const restore = installWriterHooks({
          after(source, fiber) {
            if (source.startsWith("ATTACH DATABASE") && source.endsWith(alias) && !injected) {
              injected = true;
              fiber?.interruptUnsafe();
            }
          },
        });
        yield* Effect.addFinalizer(() => Effect.sync(restore));
        const task = yield* Effect.forkScoped(
          service.redactItem({
            threadId,
            itemId: "item-fixture",
            reason: "fixture",
            compact: true,
          }),
          { startImmediately: true },
        );
        yield* Fiber.await(task);
        restore();
        expect(injected).toBe(true);
        const databases = yield* sql<{ name: string }>`PRAGMA database_list`;
        expect(databases.some((d) => d.name.startsWith("ardud_redaction_"))).toBe(false);
        expect(
          (yield* service.redactItem({
            threadId,
            itemId: "item-fixture",
            reason: "fixture",
            compact: true,
          })).verify,
        ).toBe(true);
      }),
    ),
);

it.effect.each(["detach", "durability", "mode", "fullfsync"])(
  "pre-mutation recovery survives a $s cleanup failure",
  (phase) =>
    run(
      Effect.gen(function* () {
        const paths = yield* extendedStores(false);
        const service = yield* ThreadRedaction.ThreadRedaction;
        const sql = yield* SqlClient.SqlClient;
        let broken = true;
        const restore = installWriterHooks({
          before(source) {
            if (
              broken &&
              ((phase === "detach" && source === "DETACH DATABASE ardud_redaction_base") ||
                (phase === "durability" && /^PRAGMA main.synchronous=\d/.test(source)) ||
                (phase === "fullfsync" && /^PRAGMA fullfsync=\d/.test(source)))
            )
              throw new Error("Fixture cleanup failure");
          },
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            restore();
            filesystemFault.failMode = false;
            filesystemFault.inventory = undefined;
            filesystemFault.path = "";
          }),
        );
        filesystemFault.path = NodePath.basename(paths.basePath);
        filesystemFault.failMode = phase === "mode";
        filesystemFault.inventory = async () => {
          throw new Error("Fixture inventory failure");
        };
        const failure = yield* service
          .redactItem({ threadId, itemId: "item-fixture", reason: "fixture", compact: true })
          .pipe(Effect.flip);
        expect(failure.code).toBe("maintenance_required");
        const pending = yield* sql<{
          pending: number;
        }>`SELECT pending FROM ardud_thread_redaction_recovery WHERE thread_id=${threadId}`;
        expect(pending[0]!.pending).toBe(1);
        broken = false;
        filesystemFault.failMode = false;
        filesystemFault.inventory = undefined;
        const result = yield* service.redactItem({
          threadId,
          itemId: "item-fixture",
          reason: "fixture",
          compact: true,
        });
        expect(result.verify).toBe(true);
        expect((yield* Effect.promise(() => NodeFSP.stat(paths.basePath))).mode & 0o777).toBe(
          0o400,
        );
      }),
    ),
);

it.effect.each([
  {
    form: "numeric property",
    output: { "eyJFAKE.PROPERTY": 2718281828459045, "eyJFAKE.DESCRIPTION": "eyJFAKE.MIXED" },
  },
  {
    form: "nested array",
    output: [{ "eyJFAKE.ARRAY-PROPERTY": [2718281828459045, "eyJFAKE.MIXED"] }],
  },
])("covers every value and property in $form output", ({ output }) =>
  run(
    Effect.gen(function* () {
      yield* extendedStores(false);
      const sql = yield* SqlClient.SqlClient;
      const config = yield* Config.ServerConfig;
      yield* sql`UPDATE orchestration_v2_projection_turn_items SET payload_json=${JSON.stringify({ ...fixture, output })}`;
      const file = NodePath.join(config.logsDir, "structured.log");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          file,
          JSON.stringify({ copy: output }) +
            "\n" +
            "2718281828459045\neyJFAKE.PROPERTY\neyJFAKE.ARRAY-PROPERTY\neyJFAKE.MIXED\n",
        ),
      );
      const service = yield* ThreadRedaction.ThreadRedaction;
      const result = yield* service.redactItem({
        threadId,
        itemId: "item-fixture",
        reason: "fixture",
        compact: true,
      });
      expect(result.verify).toBe(true);
      const text = yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"));
      for (const token of [
        "2718281828459045",
        "eyJFAKE.MIXED",
        ...Object.keys(Array.isArray(output) ? output[0]! : output).filter((key) =>
          key.startsWith("eyJFAKE"),
        ),
      ])
        expect(text.includes(token)).toBe(false);
      const row = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id='item-fixture'`;
      expect(JSON.stringify(JSON.parse(row[0]!.payload_json).output)).toContain("[redacted ");
    }),
  ),
);

it.effect.each(["output", "needleFile"])("never ignores genuine marker-prefixed %s", (source) =>
  run(
    Effect.gen(function* () {
      yield* extendedStores(false);
      const sql = yield* SqlClient.SqlClient;
      const config = yield* Config.ServerConfig;
      const value = "[redacted eyJFAKE.GENUINE-OUTPUT]";
      const file = NodePath.join(config.logsDir, "prefixed.log");
      const needleFile = NodePath.join(config.baseDir, "explicit-needle");
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(file, JSON.stringify({ copy: value }));
        await NodeFSP.writeFile(needleFile, value, { mode: 0o600 });
      });
      if (source === "output")
        yield* sql`UPDATE orchestration_v2_projection_turn_items SET payload_json=${JSON.stringify({ ...fixture, output: value })}`;
      const service = yield* ThreadRedaction.ThreadRedaction;
      const result = yield* service.redactItem({
        threadId,
        itemId: "item-fixture",
        reason: "fixture",
        compact: true,
        ...(source === "needleFile" ? { needleFile } : {}),
      });
      expect(result.verify).toBe(true);
      expect((yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"))).includes(value)).toBe(
        false,
      );
      expect(JSON.stringify(result).includes(value)).toBe(false);
    }),
  ),
);

it.effect("unchanged object-valued arguments do not fail structural validation", () =>
  run(
    Effect.gen(function* () {
      yield* extendedStores(false);
      const sql = yield* SqlClient.SqlClient;
      const input = {
        provider: { id: "unrelated-provider", nested: ["other"] },
        status: { map: { a: 1 } },
      };
      yield* sql`UPDATE orchestration_v2_projection_turn_items SET payload_json=${JSON.stringify({ ...fixture, input })}`;
      const service = yield* ThreadRedaction.ThreadRedaction;
      const result = yield* service.redactItem({
        threadId,
        itemId: "item-fixture",
        reason: "fixture",
        compact: true,
      });
      expect(result.verify).toBe(true);
      const row = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id='item-fixture'`;
      expect(JSON.parse(row[0]!.payload_json).input).toEqual(input);
    }),
  ),
);

it.effect.each([true, false])(
  "inventories Claude foreground task output (native mapping=%s)",
  (mapped) =>
    run(
      Effect.gen(function* () {
        yield* extendedStores(false);
        const settings = yield* ServerSettingsService;
        const config = yield* Config.ServerConfig;
        const tmpBase = NodePath.join(config.baseDir, "claude-task-temp");
        yield* settings.updateProviderInstance({
          operation: "upsert",
          instanceId: ProviderInstanceId.make("claude-fixture"),
          instance: {
            driver: ProviderDriverKind.make("claudeAgent"),
            environment: [{ name: "CLAUDE_CODE_TMPDIR", value: tmpBase, sensitive: false }],
          },
        });
        const root = NodePath.join(
          config.baseDir,
          "harness-homes",
          "claude",
          "projects",
          "fixture",
        );
        const file = NodePath.join(root, "session-fixture.jsonl");
        const taskDir = NodePath.join(
          tmpBase,
          `claude-${process.getuid?.()}`,
          "fixture-project",
          "session-fixture",
          "tasks",
        );
        const taskFile = NodePath.join(taskDir, "task-fixture.output");
        const otherFile = NodePath.join(taskDir, "task-other.output");
        const unique = "eyJFAKE.TASK-ONLY";
        const log = NodePath.join(config.logsDir, "task-copy.log");
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(taskDir, { recursive: true });
          await NodeFSP.writeFile(taskFile, mapped ? unique : fake, { mode: 0o640 });
          await NodeFSP.writeFile(otherFile, "unrelated task stays byte-identical");
          await NodeFSP.writeFile(log, JSON.stringify({ copy: mapped ? unique : fake }));
          if (mapped)
            await NodeFSP.appendFile(
              file,
              JSON.stringify({
                type: "system",
                subtype: "task_started",
                tool_use_id: "call-fixture",
                task_id: "task-fixture",
                session_id: "session-fixture",
              }) + "\n",
            );
        });
        const service = yield* ThreadRedaction.ThreadRedaction;
        const result = yield* service.redactItem({
          threadId,
          itemId: "item-fixture",
          reason: "fixture",
          compact: true,
        });
        expect(result.verify).toBe(mapped);
        expect(
          result.stores.some(
            (s) => s.store === taskFile && s.replaced > 0 && s.remainingAfter === 0,
          ),
        ).toBe(true);
        expect(
          (yield* Effect.promise(() => NodeFSP.readFile(taskFile, "utf8"))).includes(
            mapped ? unique : fake,
          ),
        ).toBe(false);
        expect((yield* Effect.promise(() => NodeFSP.stat(taskFile))).mode & 0o777).toBe(0o640);
        expect(yield* Effect.promise(() => NodeFSP.readFile(otherFile, "utf8"))).toBe(
          "unrelated task stays byte-identical",
        );
        expect(
          (yield* Effect.promise(() => NodeFSP.readFile(log, "utf8"))).includes(
            mapped ? unique : fake,
          ),
        ).toBe(false);
      }),
    ),
);

it.effect("an explicit needle includes even a known generated marker", () =>
  run(
    Effect.gen(function* () {
      yield* extendedStores(false);
      const sql = yield* SqlClient.SqlClient;
      const config = yield* Config.ServerConfig;
      const service = yield* ThreadRedaction.ThreadRedaction;
      const first = yield* service.redactItem({
        threadId,
        itemId: "item-fixture",
        reason: "first fixture",
      });
      expect(first.verify).toBe(false);
      const row = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id='item-fixture'`;
      const known = String(JSON.parse(row[0]!.payload_json).output);
      const needleFile = NodePath.join(config.baseDir, "known-marker-needle");
      const log = NodePath.join(config.logsDir, "known-marker-copy.log");
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(needleFile, known, { mode: 0o600 });
        await NodeFSP.writeFile(log, JSON.stringify({ copy: known }));
      });
      const second = yield* service.redactItem({
        threadId,
        itemId: "item-fixture",
        reason: "second fixture",
        compact: true,
        needleFile,
      });
      expect(second.verify).toBe(true);
      expect((yield* Effect.promise(() => NodeFSP.readFile(log, "utf8"))).includes(known)).toBe(
        false,
      );
    }),
  ),
);

it.effect.each([
  { form: "numeric equivalent", needle: "3.141592653589793e15", copy: 3141592653589793 },
  {
    form: "reordered document",
    needle: '{"eyJFAKE":"logger-copy","parts":[1,2]}',
    copy: { parts: [1, 2], eyJFAKE: "logger-copy" },
  },
])("redacts $form in frames emitted by the real provider logger", ({ needle, copy }) =>
  run(
    Effect.gen(function* () {
      yield* extendedStores(false);
      const config = yield* Config.ServerConfig;
      const store = yield* makeEventNdjsonLogStore(config.providerEventLogPath, {
        batchWindowMs: 1_000,
      });
      yield* Effect.addFinalizer(() => store.close());
      const needleFile = NodePath.join(config.baseDir, "logger-needle");
      yield* Effect.promise(() => NodeFSP.writeFile(needleFile, needle, { mode: 0o600 }));
      yield* store.logger("native").write({ copy }, threadId);
      const service = yield* ThreadRedaction.ThreadRedaction.pipe(
        Effect.provide(
          Layer.fresh(ThreadRedaction.layer).pipe(
            Layer.provide(
              Layer.succeed(ProviderEventLoggers.ProviderEventLoggers, {
                native: store.logger("native"),
                canonical: store.logger("canonical"),
                withMaintenance: store.withMaintenance,
              }),
            ),
            Layer.provide(
              Layer.mock(CommandOutputHub.CommandOutputHub)({ forgetThread: () => Effect.void }),
            ),
          ),
        ),
      );
      const result = yield* service.redactItem({
        threadId,
        itemId: "item-fixture",
        reason: "fixture",
        compact: true,
        needleFile,
      });
      expect(result.verify).toBe(true);
      const files = yield* Effect.promise(() => filesBelow(config.logsDir));
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const text = yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"));
        for (const line of text.trim().split("\n"))
          expect(JSON.parse(line.replace(/^\[[^\]]+\] NTIVE: /, "")).copy).toContain("[redacted ");
      }
    }),
  ),
);

it.effect.each(["separate lines", "prefix", "suffix", "both"])(
  "mixed %s logs verify and resume export on the first pass",
  (layout) =>
    run(
      Effect.gen(function* () {
        yield* extendedStores(false);
        const config = yield* Config.ServerConfig;
        const sql = yield* SqlClient.SqlClient;
        const file = NodePath.join(config.logsDir, "mixed-format.log");
        const json = JSON.stringify({ copy: fake });
        const framed = "[2026-11-12T00:00:00.000Z] NTIVE: " + json;
        const source =
          layout === "separate lines"
            ? framed + "\nplain copy: " + fake
            : layout === "prefix"
              ? fake + " " + json
              : layout === "suffix"
                ? framed + " " + fake
                : fake + " " + json + " " + fake;
        const copies = layout === "both" ? 3 : 2;
        yield* Effect.promise(() => NodeFSP.writeFile(file, source + "\nunrelated line\n"));
        const service = yield* ThreadRedaction.ThreadRedaction;
        const result = yield* service.redactItem({
          threadId,
          itemId: "item-fixture",
          reason: "fixture",
          compact: true,
        });
        expect(result.verify).toBe(true);
        const rewritten = yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"));
        expect(rewritten.includes(fake)).toBe(false);
        expect(rewritten.endsWith("unrelated line\n")).toBe(true);
        expect(result.stores.find((store) => store.store === file)).toMatchObject({
          matchedBefore: copies,
          replaced: copies,
          remainingAfter: 0,
        });
        const pending = yield* sql<{
          pending: number;
        }>`SELECT pending FROM ardud_thread_redaction_recovery WHERE thread_id=${threadId}`;
        expect(pending[0]?.pending).toBe(0);
      }),
    ),
);

it.effect.each([
  {
    form: "inline JSON output",
    value: 'before {"part":"eyJFAKE.inline"} after',
    copy: 'prefix before {"part":"eyJFAKE.inline"} after suffix\n',
  },
  {
    form: "framed scalar",
    value: "1000000000000000000000",
    copy: "[2026-11-12T00:00:00.000Z] NTIVE: 1e+21\n",
  },
])("verifies complete erasure of $form copies", ({ value, copy }) =>
  run(
    Effect.gen(function* () {
      yield* extendedStores(false);
      const sql = yield* SqlClient.SqlClient;
      const config = yield* Config.ServerConfig;
      yield* sql`UPDATE orchestration_v2_projection_turn_items SET payload_json=${JSON.stringify({ ...fixture, output: value })}`;
      const file = NodePath.join(config.logsDir, "complete-copy.log");
      yield* Effect.promise(() => NodeFSP.writeFile(file, copy));
      const service = yield* ThreadRedaction.ThreadRedaction;
      const result = yield* service.redactItem({
        threadId,
        itemId: "item-fixture",
        reason: "fixture",
        compact: true,
      });
      expect(result.verify).toBe(true);
      expect(result.stores.find((entry) => entry.store === file)).toMatchObject({
        matchedBefore: 1,
        replaced: 1,
        remainingAfter: 0,
      });
      const rewritten = yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"));
      expect(rewritten.includes(value)).toBe(false);
      expect(rewritten).toContain("[redacted ");
    }),
  ),
);

it.effect.each(["file", "database"])(
  "key collisions in %s refuse before any content mutation",
  (surface) =>
    run(
      Effect.gen(function* () {
        yield* extendedStores(false);
        const config = yield* Config.ServerConfig;
        const sql = yield* SqlClient.SqlClient;
        const output = { fixtureAlpha: "eyJFAKE.alpha", fixtureBeta: "eyJFAKE.beta" };
        const original = JSON.stringify({ ...fixture, output });
        yield* sql`UPDATE orchestration_v2_projection_turn_items SET payload_json=${original}`;
        const collision = JSON.stringify({ ...output, keep: true });
        const file = NodePath.join(config.logsDir, "key-collision.log");
        const before = surface === "file" ? "prefix " + collision + " suffix\n" : fake;
        yield* Effect.promise(() => NodeFSP.writeFile(file, before));
        if (surface === "database")
          yield* sql`UPDATE projection_thread_messages SET text=${collision} WHERE message_id='quote'`;
        const service = yield* ThreadRedaction.ThreadRedaction;
        const failure = yield* service
          .redactItem({ threadId, itemId: "item-fixture", reason: "fixture", compact: true })
          .pipe(Effect.flip);
        expect(JSON.stringify(failure).includes("fixtureAlpha")).toBe(false);
        const rows = yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id='item-fixture'`;
        expect(rows[0]?.payload_json).toBe(original);
        expect(yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"))).toBe(before);
        const pending = yield* sql<{
          pending: number;
        }>`SELECT pending FROM ardud_thread_redaction_recovery WHERE thread_id=${threadId}`;
        expect(pending[0]?.pending).toBe(0);
      }),
    ),
);

it.effect("incomplete framed JSON refuses before any content mutation", () =>
  run(
    Effect.gen(function* () {
      yield* extendedStores(false);
      const config = yield* Config.ServerConfig;
      const sql = yield* SqlClient.SqlClient;
      const file = NodePath.join(config.logsDir, "incomplete-frame.log");
      const before = '[2026-11-12T00:00:00.000Z] NTIVE: "' + fake.replace("e", "\\u0065") + " []";
      yield* Effect.promise(() => NodeFSP.writeFile(file, before));
      const service = yield* ThreadRedaction.ThreadRedaction;
      yield* service
        .redactItem({ threadId, itemId: "item-fixture", reason: "fixture", compact: true })
        .pipe(Effect.flip);
      const rows = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id='item-fixture'`;
      expect(rows[0]?.payload_json).toBe(JSON.stringify(fixture));
      expect(yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"))).toBe(before);
      const pending = yield* sql<{
        pending: number;
      }>`SELECT pending FROM ardud_thread_redaction_recovery WHERE thread_id=${threadId}`;
      expect(pending[0]?.pending).toBe(0);
    }),
  ),
);

it.effect.each([
  { form: "solidus", value: "fixture/output", encoded: String.raw`fixture\/output` },
  { form: "reverse solidus", value: "fixture\\output", encoded: String.raw`fixture\\output` },
  { form: "quotation mark", value: 'fixture"output', encoded: String.raw`fixture\"output` },
  { form: "backspace", value: "fixture\boutput", encoded: String.raw`fixture\boutput` },
  { form: "form feed", value: "fixture\foutput", encoded: String.raw`fixture\foutput` },
  { form: "line feed", value: "fixture\noutput", encoded: String.raw`fixture\noutput` },
  { form: "carriage return", value: "fixture\routput", encoded: String.raw`fixture\routput` },
  { form: "tab", value: "fixture\toutput", encoded: String.raw`fixture\toutput` },
])("incomplete $form log refuses without mutation and permits retry", ({ value, encoded }) =>
  run(
    Effect.gen(function* () {
      yield* extendedStores(false);
      const config = yield* Config.ServerConfig;
      const sql = yield* SqlClient.SqlClient;
      const original = JSON.stringify({ ...fixture, output: value });
      yield* sql`UPDATE orchestration_v2_projection_turn_items SET payload_json=${original} WHERE turn_item_id='item-fixture'`;
      const file = NodePath.join(config.logsDir, "incomplete-escape.log");
      const before = 'NTIVE: "' + encoded;
      yield* Effect.promise(() => NodeFSP.writeFile(file, before));
      const logs: unknown[] = [];
      const service = yield* ThreadRedaction.ThreadRedaction;
      const error = yield* service
        .redactItem({ threadId, itemId: "item-fixture", reason: "fixture", compact: true })
        .pipe(
          Effect.provide(Logger.layer([Logger.make((entry) => logs.push(entry))])),
          Effect.flip,
        );
      const rows = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id='item-fixture'`;
      expect(rows[0]?.payload_json).toBe(original);
      expect(yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"))).toBe(before);
      const pending = yield* sql<{
        pending: number;
      }>`SELECT pending FROM ardud_thread_redaction_recovery WHERE thread_id=${threadId}`;
      expect(pending[0]?.pending).toBe(0);
      expect(JSON.stringify([error, logs]).includes(encoded)).toBe(false);
      expect(JSON.stringify([error, logs]).includes(value)).toBe(false);
      yield* Effect.promise(() => NodeFSP.writeFile(file, "NTIVE: " + JSON.stringify(value)));
      const retried = yield* service.redactItem({
        threadId,
        itemId: "item-fixture",
        reason: "fixture",
        compact: true,
      });
      expect(retried.verify).toBe(true);
      expect((yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"))).includes(encoded)).toBe(
        false,
      );
    }),
  ),
);

it.effect.each([
  { form: "solidus", value: "fixture/output", encoded: String.raw`fixture\/output` },
  { form: "Unicode", value: "fixture/output", encoded: String.raw`fixture\u002foutput` },
  { form: "numeric", value: "1000000000000000000000", encoded: String.raw`\u0031e+21` },
  {
    form: "document",
    value: '{"a":1,"b":2}',
    encoded: String.raw`\u007b\u0022b\u0022:2,\u0022a\u0022:1\u007d`,
  },
])(
  "unquoted alternate $form log refuses without mutation and permits retry",
  ({ value, encoded }) =>
    run(
      Effect.gen(function* () {
        yield* extendedStores(false);
        const config = yield* Config.ServerConfig;
        const sql = yield* SqlClient.SqlClient;
        const original = JSON.stringify({ ...fixture, output: value });
        yield* sql`UPDATE orchestration_v2_projection_turn_items SET payload_json=${original} WHERE turn_item_id='item-fixture'`;
        const file = NodePath.join(config.logsDir, "bare-escape.log");
        const before = "NTIVE: " + encoded;
        yield* Effect.promise(() => NodeFSP.writeFile(file, before));
        const logs: unknown[] = [];
        const service = yield* ThreadRedaction.ThreadRedaction;
        const error = yield* service
          .redactItem({ threadId, itemId: "item-fixture", reason: "fixture", compact: true })
          .pipe(
            Effect.provide(Logger.layer([Logger.make((entry) => logs.push(entry))])),
            Effect.flip,
          );
        const rows = yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id='item-fixture'`;
        expect(rows[0]?.payload_json).toBe(original);
        expect(yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"))).toBe(before);
        const pending = yield* sql<{
          pending: number;
        }>`SELECT pending FROM ardud_thread_redaction_recovery WHERE thread_id=${threadId}`;
        expect(pending[0]?.pending).toBe(0);
        expect(JSON.stringify([error, logs]).includes(encoded)).toBe(false);
        expect(JSON.stringify([error, logs]).includes(value)).toBe(false);
        yield* Effect.promise(() => NodeFSP.writeFile(file, "NTIVE: " + JSON.stringify(value)));
        const retried = yield* service.redactItem({
          threadId,
          itemId: "item-fixture",
          reason: "fixture",
          compact: true,
        });
        expect(retried.verify).toBe(true);
        expect(
          (yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"))).includes(encoded),
        ).toBe(false);
      }),
    ),
);

it.effect("invalid log encoding refuses before any content mutation", () =>
  run(
    Effect.gen(function* () {
      yield* extendedStores(false);
      const config = yield* Config.ServerConfig;
      const sql = yield* SqlClient.SqlClient;
      const log = NodePath.join(config.logsDir, "invalid-encoding.log");
      const original = Buffer.concat([Buffer.from([0x80]), Buffer.from("\n" + fake)]);
      yield* Effect.promise(() => NodeFSP.writeFile(log, original));
      const service = yield* ThreadRedaction.ThreadRedaction;
      const failure = yield* service
        .redactItem({ threadId, itemId: "item-fixture", reason: "fixture", compact: true })
        .pipe(Effect.flip);
      expect(failure.code).toBe("failed");
      expect(JSON.stringify(failure).includes(fake)).toBe(false);
      expect(yield* Effect.promise(() => NodeFSP.readFile(log))).toEqual(original);
      const rows = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id='item-fixture'`;
      expect(JSON.parse(rows[0]!.payload_json).output).toBe(fake);
      const audit =
        yield* sql`SELECT event_id FROM orchestration_events WHERE event_type='thread.item-redacted'`;
      expect(audit.length).toBe(0);
    }),
  ),
);

it.effect.each([
  "subagents/agent-fixture.jsonl",
  "subagents/workflows/wf-fixture/agent-fixture.jsonl",
  "workflows/wf-fixture/transcript.jsonl",
])("redacts associated Claude transcript %s", (relative) =>
  run(
    Effect.gen(function* () {
      yield* extendedStores(false);
      const config = yield* Config.ServerConfig;
      const root = NodePath.join(config.baseDir, "harness-homes", "claude", "projects", "fixture");
      const file = NodePath.join(root, "session-fixture", relative);
      const other = NodePath.join(root, "session-other", relative);
      const unique = "eyJFAKE.NESTED-TRANSCRIPT-ONLY";
      const unchanged = '{ "unrelated": "byte-identical" }\n';
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
        await NodeFSP.mkdir(NodePath.dirname(other), { recursive: true });
        await NodeFSP.writeFile(
          file,
          unchanged +
            JSON.stringify({ type: "tool_result", tool_use_id: "call-fixture", content: unique }) +
            "\n" +
            JSON.stringify({ summary: fake }) +
            "\n",
        );
        await NodeFSP.writeFile(
          other,
          unchanged + JSON.stringify({ summary: "unrelated-session-output" }) + "\n",
        );
      });
      const service = yield* ThreadRedaction.ThreadRedaction;
      const result = yield* service.redactItem({
        threadId,
        itemId: "item-fixture",
        reason: "fixture",
        compact: true,
      });
      expect(result.verify).toBe(true);
      expect(result.stores.some((s) => s.store === file && s.replaced === 2)).toBe(true);
      const text = yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"));
      expect(text.startsWith(unchanged)).toBe(true);
      expect(text.includes(unique) || text.includes(fake)).toBe(false);
      expect(yield* Effect.promise(() => NodeFSP.readFile(other, "utf8"))).toBe(
        unchanged + JSON.stringify({ summary: "unrelated-session-output" }) + "\n",
      );
    }),
  ),
);

const seedForks = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const child = ThreadId.make("fork-fixture");
  const grandchild = ThreadId.make("fork-grandchild-fixture");
  for (const [id, parent] of [
    [child, threadId],
    [grandchild, child],
  ] as const)
    yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES (${id},'fixture','fork','claudeAgent','full-access','default','2026-01-01','2026-01-01',${JSON.stringify({ id, forkedFrom: { type: "run", threadId: parent, runId: "run-fixture" } })})`;
  yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES ('fork-copy',${child},'assistant',${fake},0,'2026-01-01','2026-01-01')`;
  return { child, grandchild };
});

it.effect("invalidates an already-open descendant fork and its cached resume cursor", () =>
  run(
    Effect.gen(function* () {
      yield* extendedStores(false);
      const { child, grandchild } = yield* seedForks;
      const sink = yield* EventSink.EventSinkV2;
      const before = yield* sink.write({
        events: [
          {
            id: EventId.make("fork-before"),
            type: "thread.item-redacted",
            threadId: child,
            occurredAt: DateTime.makeUnsafe("2026-01-01"),
            payload: { itemId: "fixture", reason: "before", at: "2026-01-01" },
          },
        ],
      });
      const cursor = before[0]!.sequence;
      const ready = yield* Deferred.make<void>();
      const open = yield* sink.stream({ threadId: child, bounded: true }).pipe(
        Stream.tap((stored) =>
          stored.event.id === EventId.make("fork-before")
            ? Deferred.succeed(ready, undefined)
            : Effect.void,
        ),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Deferred.await(ready);
      const service = yield* ThreadRedaction.ThreadRedaction;
      const result = yield* service.redactItem({
        threadId,
        itemId: "item-fixture",
        reason: "fixture",
        compact: true,
      });
      expect(result.verify).toBe(true);
      const observed = yield* Fiber.join(open);
      expect(observed[1]!.event.threadId).toBe(child);
      expect(observed[1]!.event.type).toBe("thread.item-redacted");
      const replay = yield* sink
        .stream({ threadId: child, afterSequence: cursor, bounded: true })
        .pipe(Stream.take(1), Stream.runCollect);
      expect(replay[0]!.sequence).toBe(observed[1]!.sequence);
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        stream_id: string;
      }>`SELECT stream_id FROM orchestration_events WHERE event_type='thread.item-redacted' AND json_extract(payload_json,'$.reason')='fixture'`;
      expect(new Set(rows.map((row) => row.stream_id))).toEqual(
        new Set([threadId, child, grandchild]),
      );
      const copy = yield* sql<{
        text: string;
      }>`SELECT text FROM projection_thread_messages WHERE message_id='fork-copy'`;
      expect(copy[0]!.text.includes(fake)).toBe(false);
    }),
  ),
);

it.effect("refuses a running descendant before changing the source", () =>
  run(
    Effect.gen(function* () {
      yield* extendedStores(false);
      const { grandchild } = yield* seedForks;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES ('fork-running',${grandchild},1,'claudeAgent','running','2026-01-01','{}')`;
      const service = yield* ThreadRedaction.ThreadRedaction;
      const failure = yield* service
        .redactItem({ threadId, itemId: "item-fixture", reason: "fixture", compact: true })
        .pipe(Effect.flip);
      expect(failure.code).toBe("running");
      const row = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id='item-fixture'`;
      expect(JSON.parse(row[0]!.payload_json).output).toBe(fake);
    }),
  ),
);

it.effect.each(["selected payload", "outbox copy"])(
  "duplicate keys in %s refuse before content mutation",
  (surface) =>
    run(
      Effect.gen(function* () {
        yield* extendedStores(false);
        const sql = yield* SqlClient.SqlClient;
        if (surface === "selected payload") {
          const duplicate = JSON.stringify(fixture).slice(0, -1) + ',"output":"other"}';
          yield* sql`UPDATE orchestration_v2_projection_turn_items SET payload_json=${duplicate}`;
        } else {
          yield* sql`INSERT INTO orchestration_v2_effect_outbox(effect_id,command_id,thread_id,effect_type,payload_json,status,available_at,created_at,updated_at) VALUES ('duplicate-copy','fixture',${threadId},'fixture','{"copy":3.141592653589793e15,"copy":0}','succeeded','2026-01-01','2026-01-01','2026-01-01')`;
        }
        const before = yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id='item-fixture'`;
        const service = yield* ThreadRedaction.ThreadRedaction;
        const failure = yield* service
          .redactItem({ threadId, itemId: "item-fixture", reason: "fixture", compact: true })
          .pipe(Effect.flip);
        expect(failure.code).toBe(surface === "outbox copy" ? "invalid" : "failed");
        expect(JSON.stringify(failure).includes(fake)).toBe(false);
        const after = yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id='item-fixture'`;
        expect(after).toEqual(before);
        const audit =
          yield* sql`SELECT event_id FROM orchestration_events WHERE event_type='thread.item-redacted'`;
        expect(audit.length).toBe(0);
      }),
    ),
);

it.effect.each(
  [false, true].flatMap((ownerPresent) =>
    [false, true].map((nested) => ({ ownerPresent, nested })),
  ),
)(
  "Codex archived source coverage ignores a fork's reused call ID (owner=$ownerPresent nested=$nested)",
  ({ ownerPresent, nested }) =>
    run(
      Effect.gen(function* () {
        yield* extendedStores(false);
        const { child } = yield* seedForks;
        const sql = yield* SqlClient.SqlClient;
        const config = yield* Config.ServerConfig;
        yield* sql`UPDATE projection_thread_sessions SET provider_name='codex' WHERE thread_id=${threadId}`;
        yield* sql`INSERT INTO projection_thread_sessions(thread_id,status,provider_name,provider_session_id,updated_at) VALUES (${child},'stopped','codex','fork-session-fixture','2026-01-01')`;
        const wrong = "eyJFAKE.UNRELATED-LOCAL-FORK-OUTPUT";
        const local = { ...fixture, id: "fork-local-item", output: wrong };
        yield* sql`INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,ordinal,type,status,updated_at,payload_json) VALUES ('fork-local-item',${child},1,'command_execution','completed','2026-01-01',${JSON.stringify(local)})`;
        const root = NodePath.join(config.baseDir, "harness-homes", "codex");
        const archive = NodePath.join(
          root,
          "archived_sessions",
          ...(nested ? ["2026", "11"] : []),
          "rollout-session-fixture.jsonl",
        );
        const fork = NodePath.join(root, "sessions", "rollout-fork-session-fixture.jsonl");
        const archivedOnly = "eyJFAKE.ARCHIVED-ROLLOUT-ONLY";
        const log = NodePath.join(config.logsDir, "archive-copy.log");
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(NodePath.dirname(fork), { recursive: true });
          await NodeFSP.writeFile(
            fork,
            JSON.stringify({
              type: "response_item",
              payload: { type: "function_call_output", call_id: "call-fixture", output: wrong },
            }) +
              "\n" +
              JSON.stringify({ summary: fake }) +
              "\n",
          );
          if (ownerPresent) {
            await NodeFSP.mkdir(NodePath.dirname(archive), { recursive: true });
            await NodeFSP.writeFile(
              archive,
              JSON.stringify({
                type: "response_item",
                payload: {
                  type: "function_call_output",
                  call_id: "call-fixture",
                  output: archivedOnly,
                },
              }) + "\n",
            );
            await NodeFSP.writeFile(log, JSON.stringify({ copy: archivedOnly }));
          }
        });
        const service = yield* ThreadRedaction.ThreadRedaction;
        const result = yield* service.redactItem({
          threadId,
          itemId: "item-fixture",
          reason: "fixture",
          compact: true,
        });
        expect(result.verify).toBe(ownerPresent);
        const localRows = yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id='fork-local-item'`;
        expect(JSON.parse(localRows[0]!.payload_json).output).toBe(wrong);
        const forkText = yield* Effect.promise(() => NodeFSP.readFile(fork, "utf8"));
        expect(forkText.includes(wrong)).toBe(true);
        expect(forkText.includes(fake)).toBe(false);
        if (ownerPresent) {
          expect(
            (yield* Effect.promise(() => NodeFSP.readFile(archive, "utf8"))).includes(archivedOnly),
          ).toBe(false);
          expect(
            (yield* Effect.promise(() => NodeFSP.readFile(log, "utf8"))).includes(archivedOnly),
          ).toBe(false);
          expect(result.stores.some((s) => s.store === archive && s.replaced > 0)).toBe(true);
        } else
          expect(
            result.providers.some((p) => p.provider === "codex" && p.status === "missing"),
          ).toBe(true);
      }),
    ),
);

it.effect.each([
  { name: "session-fixture.jsonl", match: true },
  { name: "rollout-session-fixture.jsonl", match: true },
  { name: "rollout-2026-11-12T14-10-20-session-fixture.jsonl", match: true },
  { name: "rollout-2026-11-12T14-10-20.123Z-session-fixture.jsonl", match: true },
  { name: "rollout-prefix-session-fixture.jsonl", match: false },
  { name: "rollout-2026-11-12T14-10-session-fixture.jsonl", match: false },
])("Codex session filename boundary $name", ({ name, match }) =>
  run(
    Effect.gen(function* () {
      yield* extendedStores(false);
      const sql = yield* SqlClient.SqlClient;
      const config = yield* Config.ServerConfig;
      yield* sql`UPDATE projection_thread_sessions SET provider_name='codex' WHERE thread_id=${threadId}`;
      const file = NodePath.join(config.baseDir, "harness-homes", "codex", "sessions", name);
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
        await NodeFSP.writeFile(
          file,
          JSON.stringify({ type: "function_call_output", call_id: "call-fixture", output: fake }) +
            "\n",
        );
      });
      const service = yield* ThreadRedaction.ThreadRedaction;
      const result = yield* service.redactItem({
        threadId,
        itemId: "item-fixture",
        reason: "fixture",
        compact: true,
      });
      expect(result.verify).toBe(match);
      expect((yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"))).includes(fake)).toBe(
        !match,
      );
    }),
  ),
);

it.effect.each(
  ["foreign", "null"].flatMap((latest) => [false, true].map((running) => ({ latest, running }))),
)("shared session binding covers latest=$latest running=$running", ({ latest, running }) =>
  run(
    Effect.gen(function* () {
      yield* extendedStores(false);
      const sql = yield* SqlClient.SqlClient;
      const foreign = ThreadId.make("shared-session-other-thread");
      const value = '{"eyJFAKE":"shared-session-copy","parts":[1,2]}';
      const copy = '{"parts":[1,2],"eyJFAKE":"shared-session-copy"}';
      yield* sql`UPDATE orchestration_v2_projection_turn_items SET payload_json=${JSON.stringify({ ...fixture, output: value })}`;
      yield* sql`INSERT INTO orchestration_v2_projection_provider_sessions(provider_session_id,thread_id,provider,status,updated_at,payload_json) VALUES ('shared-provider-session',${latest === "null" ? null : foreign},'claudeAgent',${running ? "running" : "stopped"},'2026-01-01',${JSON.stringify({ id: "shared-provider-session", status: running ? "running" : "stopped", lastError: copy })})`;
      for (const id of [threadId, foreign])
        yield* sql`INSERT INTO orchestration_v2_projection_provider_session_bindings(provider_session_id,thread_id) VALUES ('shared-provider-session',${id})`;
      const service = yield* ThreadRedaction.ThreadRedaction;
      if (running) {
        const failure = yield* service
          .redactItem({ threadId, itemId: "item-fixture", reason: "fixture", compact: true })
          .pipe(Effect.flip);
        expect(failure.code).toBe("running");
        const rows = yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM orchestration_v2_projection_provider_sessions WHERE provider_session_id='shared-provider-session'`;
        expect(JSON.parse(rows[0]!.payload_json).lastError).toBe(copy);
      } else {
        const result = yield* service.redactItem({
          threadId,
          itemId: "item-fixture",
          reason: "fixture",
          compact: true,
        });
        expect(result.verify).toBe(true);
        const rows = yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM orchestration_v2_projection_provider_sessions WHERE provider_session_id='shared-provider-session'`;
        expect(rows[0]!.payload_json.includes("eyJFAKE")).toBe(false);
        const audit =
          yield* sql`SELECT event_id FROM orchestration_events WHERE stream_id=${foreign} AND event_type='thread.item-redacted'`;
        expect(audit.length).toBe(1);
      }
    }),
  ),
);

it.effect("a fork task with the owner's task basename never contributes needles", () =>
  run(
    Effect.gen(function* () {
      yield* extendedStores(false);
      const { child } = yield* seedForks;
      const sql = yield* SqlClient.SqlClient;
      const config = yield* Config.ServerConfig;
      const settings = yield* ServerSettingsService;
      yield* sql`INSERT INTO projection_thread_sessions(thread_id,status,provider_name,provider_session_id,updated_at) VALUES (${child},'stopped','claudeAgent','fork-session-fixture','2026-01-01')`;
      const tmp = NodePath.join(config.baseDir, "qualified-tasks");
      yield* settings.updateProviderInstance({
        operation: "upsert",
        instanceId: ProviderInstanceId.make("claude-qualified-tasks"),
        instance: {
          driver: ProviderDriverKind.make("claudeAgent"),
          environment: [{ name: "CLAUDE_CODE_TMPDIR", value: tmp, sensitive: false }],
        },
      });
      const root = NodePath.join(config.baseDir, "harness-homes", "claude", "projects", "fixture");
      const transcript = NodePath.join(root, "session-fixture.jsonl");
      const owner = NodePath.join(
        tmp,
        `claude-${process.getuid?.()}`,
        "fixture",
        "session-fixture",
        "tasks",
        "same-task.output",
      );
      const fork = NodePath.join(
        tmp,
        `claude-${process.getuid?.()}`,
        "fixture",
        "fork-session-fixture",
        "tasks",
        "same-task.output",
      );
      const local = "eyJFAKE.UNRELATED-FORK-TASK";
      const owned = "eyJFAKE.OWNER-TASK-ONLY";
      const log = NodePath.join(config.logsDir, "qualified-tasks.log");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.dirname(owner), { recursive: true });
        await NodeFSP.mkdir(NodePath.dirname(fork), { recursive: true });
        await NodeFSP.writeFile(owner, owned);
        await NodeFSP.writeFile(fork, local);
        await NodeFSP.appendFile(
          transcript,
          JSON.stringify({
            type: "system",
            subtype: "task_started",
            tool_use_id: "call-fixture",
            task_id: "same-task",
            session_id: "session-fixture",
          }) + "\n",
        );
        await NodeFSP.writeFile(log, JSON.stringify({ owner: owned, fork: local }));
      });
      const service = yield* ThreadRedaction.ThreadRedaction;
      const result = yield* service.redactItem({
        threadId,
        itemId: "item-fixture",
        reason: "fixture",
        compact: true,
      });
      expect(result.verify).toBe(true);
      expect((yield* Effect.promise(() => NodeFSP.readFile(owner, "utf8"))).includes(owned)).toBe(
        false,
      );
      expect(yield* Effect.promise(() => NodeFSP.readFile(fork, "utf8"))).toBe(local);
      const copied = JSON.parse(yield* Effect.promise(() => NodeFSP.readFile(log, "utf8")));
      expect(copied.owner.includes(owned)).toBe(false);
      expect(copied.fork).toBe(local);
    }),
  ),
);

it.effect("lossy numeric arguments refuse before DB or provider mutation", () =>
  run(
    Effect.gen(function* () {
      yield* extendedStores(false);
      const sql = yield* SqlClient.SqlClient;
      const raw = JSON.stringify({ ...fixture, input: "number-placeholder" }).replace(
        '"number-placeholder"',
        '{"untouched":9007199254740993}',
      );
      yield* sql`UPDATE orchestration_v2_projection_turn_items SET payload_json=${raw}`;
      const service = yield* ThreadRedaction.ThreadRedaction;
      const failure = yield* service
        .redactItem({ threadId, itemId: "item-fixture", reason: "fixture", compact: true })
        .pipe(Effect.flip);
      expect(failure.code).toBe("failed");
      const rows = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id='item-fixture'`;
      expect(rows[0]!.payload_json).toBe(raw);
      const audit =
        yield* sql`SELECT event_id FROM orchestration_events WHERE event_type='thread.item-redacted'`;
      expect(audit.length).toBe(0);
    }),
  ),
);

it.effect("running refusal preserves queued provider output through the real barrier", () =>
  run(
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const config = yield* Config.ServerConfig;
      yield* sql`INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES ('active-refusal',${threadId},1,'claudeAgent','running','2026-01-01','{}')`;
      const store = yield* makeEventNdjsonLogStore(config.providerEventLogPath, {
        batchWindowMs: 1000,
      });
      yield* Effect.addFinalizer(() => store.close());
      const scope = yield* Effect.scope;
      let pending: Effect.Effect<void> = Effect.void;
      const service = yield* ThreadRedaction.ThreadRedaction.pipe(
        Effect.provide(
          Layer.fresh(ThreadRedaction.layer).pipe(
            Layer.provide(
              Layer.succeed(ProviderEventLoggers.ProviderEventLoggers, {
                native: store.logger("native"),
                canonical: store.logger("canonical"),
                withMaintenance: (id, effect, maintenance) =>
                  store.withMaintenance(
                    id,
                    Effect.gen(function* () {
                      const fiber = yield* Effect.forkIn(
                        store
                          .logger("native")
                          .write({ message: "queued active output stays" }, threadId),
                        scope,
                        { startImmediately: true },
                      );
                      pending = Fiber.join(fiber);
                      return yield* effect;
                    }),
                    maintenance,
                  ),
              }),
            ),
            Layer.provide(
              Layer.mock(CommandOutputHub.CommandOutputHub)({ forgetThread: () => Effect.void }),
            ),
          ),
        ),
      );
      const failure = yield* service
        .redactItem({ threadId, itemId: "item-fixture", reason: "fixture", compact: true })
        .pipe(Effect.flip);
      expect(failure.code).toBe("running");
      yield* pending;
      yield* store.close();
      const files = yield* Effect.promise(() => filesBelow(config.logsDir));
      const text = yield* Effect.promise(async () =>
        (await Promise.all(files.map((file) => NodeFSP.readFile(file, "utf8")))).join("\n"),
      );
      expect(text.includes("queued active output stays")).toBe(true);
    }),
  ),
);

it.effect("large numeric strings in arguments keep their exact text", () =>
  run(
    Effect.gen(function* () {
      yield* extendedStores(false);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE orchestration_v2_projection_turn_items SET payload_json=${JSON.stringify({ ...fixture, input: { exactId: "9007199254740993" } })}`;
      const service = yield* ThreadRedaction.ThreadRedaction;
      const result = yield* service.redactItem({
        threadId,
        itemId: "item-fixture",
        reason: "fixture",
        compact: true,
      });
      expect(result.verify).toBe(true);
      const rows = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id='item-fixture'`;
      expect(JSON.parse(rows[0]!.payload_json).input.exactId).toBe("9007199254740993");
    }),
  ),
);

it.effect.each([
  { form: "large integer", output: "9007199254740993", neighbor: 9007199254740992 },
  { form: "precise decimal", output: "0.10000000000000001", neighbor: 0.1 },
  { form: "large exponent", output: "1e10000", neighbor: 1e300 },
])("redacts $form output strings without rounding neighboring values", ({ output, neighbor }) =>
  run(
    Effect.gen(function* () {
      yield* extendedStores(false);
      const sql = yield* SqlClient.SqlClient;
      const config = yield* Config.ServerConfig;
      const input = { neighbor, neighborText: String(neighbor) };
      yield* sql`UPDATE orchestration_v2_projection_turn_items SET payload_json=${JSON.stringify({ ...fixture, input, output })}`;
      const file = NodePath.join(config.logsDir, "precise-string-copy.log");
      yield* Effect.promise(() => NodeFSP.writeFile(file, JSON.stringify({ output, ...input })));
      const service = yield* ThreadRedaction.ThreadRedaction;
      const result = yield* service.redactItem({
        threadId,
        itemId: "item-fixture",
        reason: "fixture",
        compact: true,
      });
      expect(result.verify).toBe(true);
      const rows = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id='item-fixture'`;
      expect(JSON.parse(rows[0]!.payload_json).input).toEqual(input);
      expect(JSON.parse(rows[0]!.payload_json).output).toContain("[redacted ");
      const copied = JSON.parse(yield* Effect.promise(() => NodeFSP.readFile(file, "utf8")));
      expect(copied.output).toContain("[redacted ");
      expect(copied.neighbor).toBe(neighbor);
      expect(copied.neighborText).toBe(input.neighborText);
    }),
  ),
);

it.effect.each(
  ["node", "subagent", "run", "item", "archive-item"].flatMap((reference) =>
    ["main", "base"].flatMap((store) =>
      [false, true].flatMap((foreign) =>
        [false, true].map((pending) => ({ reference, store, foreign, pending })),
      ),
    ),
  ),
)(
  "linked provider reader $reference store=$store foreign=$foreign pending=$pending",
  ({ reference, store, foreign, pending }) =>
    run(
      Effect.gen(function* () {
        const paths = yield* extendedStores(false);
        const sql = yield* SqlClient.SqlClient;
        const config = yield* Config.ServerConfig;
        if (reference === "node")
          yield* sql`INSERT INTO orchestration_v2_projection_nodes(node_id,thread_id,root_node_id,kind,status,payload_json) VALUES ('linked-node',${threadId},'linked-node','tool','completed','{}')`;
        if (reference === "subagent")
          yield* sql`INSERT INTO orchestration_v2_projection_subagents(subagent_id,thread_id,parent_node_id,provider,provider_thread_id,origin,status,updated_at,payload_json) VALUES ('linked-agent',${threadId},'linked-node','claudeAgent','linked-provider','native','completed','2026-01-01','{}')`;
        if (reference === "run")
          yield* sql`INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,provider_thread_id,status,requested_at,payload_json) VALUES ('linked-run',${threadId},2,'claudeAgent','linked-provider','completed','2026-01-01','{}')`;
        if (reference === "item")
          yield* sql`INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,provider_thread_id,ordinal,type,status,updated_at,payload_json) VALUES ('linked-item',${threadId},'linked-provider',2,'command_execution','completed','2026-01-01','{}')`;
        if (reference === "archive-item")
          yield* sql`INSERT INTO ardud_archive.ardud_turn_items(turn_item_id,thread_id,provider_thread_id,ordinal,type,status,updated_at,payload_json) VALUES ('linked-archive-item',${threadId},'linked-provider',2,'command_execution','completed','2026-01-01','{}')`;
        const linked = JSON.stringify({
          id: "linked-provider",
          driver: "claudeAgent",
          nativeThreadRef: { nativeId: "linked-session" },
          status: "idle",
          pendingBackgroundTasks: pending ? [{ taskId: "task-fixture" }] : [],
          copy: fake,
        }).replace(fake, fake.replace("e", "\\u0065"));
        const values = [
          foreign ? "other-reader-fixture" : null,
          reference === "node" ? "linked-node" : null,
          linked,
        ];
        const statement =
          "INSERT INTO orchestration_v2_projection_provider_threads(provider_thread_id,thread_id,owner_node_id,provider,provider_session_id,status,updated_at,payload_json) VALUES ('linked-provider',?,?,'claudeAgent','linked-session','idle','2026-01-01',?)";
        if (store === "main") yield* sql.unsafe(statement, values);
        else
          yield* Effect.sync(() => {
            const mode = NodeFS.statSync(paths.basePath).mode & 0o777;
            NodeFS.chmodSync(paths.basePath, mode | 0o200);
            try {
              const database = new NodeSqlite.DatabaseSync(paths.basePath);
              try {
                database.prepare(statement).run(...values);
              } finally {
                database.close();
              }
            } finally {
              NodeFS.chmodSync(paths.basePath, mode);
            }
          });
        const unrelated = "eyJFAKE.UNRELATED-LINKED";
        const file = NodePath.join(
          config.baseDir,
          "harness-homes",
          "claude",
          "projects",
          "fixture",
          "linked-session.jsonl",
        );
        const before =
          JSON.stringify({ copy: fake }).replace(fake, fake.replace("e", "\\u0065")) +
          "\n" +
          JSON.stringify({ type: "tool_result", tool_use_id: "call-fixture", content: unrelated }) +
          "\n";
        yield* Effect.promise(() => NodeFSP.writeFile(file, before));
        const service = yield* ThreadRedaction.ThreadRedaction;
        const result = yield* service
          .redactItem({ threadId, itemId: "item-fixture", reason: "fixture", compact: true })
          .pipe(Effect.result);
        if (pending) {
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure") expect(result.failure.code).toBe("running");
          expect(yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"))).toBe(before);
        } else {
          expect(result._tag).toBe("Success");
          if (result._tag === "Success") expect(result.success.verify).toBe(true);
          const rows = yield* sql.unsafe<{ payload_json: string }>(
            `SELECT payload_json FROM ${store === "main" ? "main" : "ardud_base"}.orchestration_v2_projection_provider_threads WHERE provider_thread_id='linked-provider'`,
          );
          expect(JSON.parse(rows[0]!.payload_json).copy).toContain("[redacted ");
          const text = yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"));
          expect(JSON.parse(text.split("\n")[0]!).copy).toContain("[redacted ");
          expect(JSON.parse(text.split("\n")[1]!).content).toBe(unrelated);
          if (foreign) {
            const audits =
              yield* sql`SELECT event_id FROM orchestration_events WHERE stream_id='other-reader-fixture' AND event_type='thread.item-redacted'`;
            expect(audits.length).toBe(1);
          }
        }
      }),
    ),
);

it.effect.each([0, 1].flatMap((original) => [false, true].map((failed) => ({ original, failed }))))(
  "fullfsync protects pending marker and restores original=$original failed=$failed",
  ({ original, failed }) =>
    run(
      Effect.gen(function* () {
        yield* extendedStores(false);
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`PRAGMA fullfsync=${original}`);
        if (failed)
          yield* sql`CREATE TRIGGER fixture_sync_failure BEFORE INSERT ON orchestration_events WHEN NEW.event_type='thread.item-redacted' BEGIN SELECT RAISE(ABORT,'fixture'); END`;
        const observed: number[] = [];
        const restore = installWriterHooks({ fullFsync: (value) => observed.push(value) });
        yield* Effect.addFinalizer(() => Effect.sync(restore));
        const service = yield* ThreadRedaction.ThreadRedaction;
        const result = yield* service
          .redactItem({ threadId, itemId: "item-fixture", reason: "fixture", compact: true })
          .pipe(Effect.result);
        expect(result._tag).toBe(failed ? "Failure" : "Success");
        expect(observed).toEqual([1]);
        const restored = yield* sql.unsafe<{ fullfsync: number }>("PRAGMA fullfsync");
        expect(restored[0]?.fullfsync).toBe(original);
      }),
    ),
);

it.effect.each(
  ["native-ref", "session-column", "thread-column"].flatMap((form) =>
    [false, true].map((foreign) => ({ form, foreign })),
  ),
)("selected provider owns $form native output with foreign=$foreign", ({ form, foreign }) =>
  run(
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const config = yield* Config.ServerConfig;
      const providerId = form === "thread-column" ? "owned-session" : "provider-thread:owned";
      const sessionId = form === "session-column" ? "owned-session" : null;
      yield* sql`UPDATE orchestration_v2_projection_turn_items SET provider_thread_id=${providerId} WHERE turn_item_id='item-fixture'`;
      const provider = {
        id: providerId,
        driver: "claudeAgent",
        nativeThreadRef: form === "native-ref" ? { nativeId: "owned-session" } : null,
        pendingBackgroundTasks: [],
      };
      yield* sql`INSERT INTO orchestration_v2_projection_provider_threads(provider_thread_id,thread_id,provider,provider_session_id,status,updated_at,payload_json) VALUES (${providerId},${foreign ? "foreign-reader" : null},'claudeAgent',${sessionId},'idle','2026-01-01',${JSON.stringify(provider)})`;
      const root = NodePath.join(config.baseDir, "harness-homes", "claude", "projects", "fixture");
      const file = NodePath.join(root, "owned-session.jsonl");
      const only = "eyJFAKE.EXACT-PROVIDER-ONLY";
      const log = NodePath.join(config.logsDir, "owned-provider-copy.log");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(root, { recursive: true });
        await NodeFSP.mkdir(config.logsDir, { recursive: true });
        await NodeFSP.writeFile(
          file,
          JSON.stringify({ type: "tool_result", tool_use_id: "call-fixture", content: only }) +
            "\n",
        );
        await NodeFSP.writeFile(log, JSON.stringify({ copy: only }));
      });
      const service = yield* ThreadRedaction.ThreadRedaction;
      const result = yield* service.redactItem({
        threadId,
        itemId: "item-fixture",
        reason: "fixture",
        compact: true,
      });
      expect(result.verify).toBe(true);
      expect(result.providers).toContainEqual({ provider: "claudeAgent", status: "rewritten" });
      expect((yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"))).includes(only)).toBe(
        false,
      );
      expect((yield* Effect.promise(() => NodeFSP.readFile(log, "utf8"))).includes(only)).toBe(
        false,
      );
      expect(JSON.stringify(result).includes(only)).toBe(false);
    }),
  ),
);

it.effect.each(
  ["example", "dynamic_tool"].flatMap((exampleType) =>
    [
      "direct",
      "payload",
      "item",
      "activity",
      "data",
      "tool",
      "state",
      "turnItems",
      "visibleTurnItems",
    ].map((envelope) => ({ exampleType, envelope })),
  ),
)(
  "revision preserves $exampleType argument examples inside $envelope copies",
  ({ exampleType, envelope }) =>
    run(
      Effect.gen(function* () {
        yield* extendedStores(false);
        const sql = yield* SqlClient.SqlClient;
        const old = "2026-01-01T00:00:00.000Z";
        const example = { id: "item-fixture", type: exampleType, updatedAt: old };
        const input = {
          example,
          payload: example,
          item: [example],
          arguments: [{ data: example }],
        };
        const item = {
          ...fixture,
          type: "dynamic_tool",
          input,
          arguments: { example },
          providerMetadata: { example },
          updatedAt: old,
        };
        const wrapped = envelope === "direct" ? item : { [envelope]: [item] };
        yield* sql`UPDATE orchestration_v2_projection_turn_items SET payload_json=${JSON.stringify(item)},updated_at=${old} WHERE turn_item_id='item-fixture'`;
        yield* sql`UPDATE orchestration_events SET payload_json=${JSON.stringify(wrapped)} WHERE event_id='fixture-event'`;
        const service = yield* ThreadRedaction.ThreadRedaction;
        const result = yield* service.redactItem({
          threadId,
          itemId: "item-fixture",
          reason: "fixture",
          compact: true,
        });
        expect(result.verify).toBe(true);
        const rows = yield* sql<{
          payload_json: string;
          updated_at: string;
        }>`SELECT payload_json,updated_at FROM orchestration_v2_projection_turn_items WHERE turn_item_id='item-fixture'`;
        const revised = JSON.parse(rows[0]!.payload_json);
        expect(revised.updatedAt).toBe(rows[0]!.updated_at);
        expect(revised.updatedAt > old).toBe(true);
        expect(revised.input).toEqual(input);
        expect(revised.arguments).toEqual(item.arguments);
        expect(revised.providerMetadata).toEqual(item.providerMetadata);
        const events = yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM orchestration_events WHERE event_id='fixture-event'`;
        const payload = JSON.parse(events[0]!.payload_json);
        const copied = envelope === "direct" ? payload : payload[envelope][0];
        expect(copied.updatedAt).toBe(revised.updatedAt);
        expect(copied.input).toEqual(input);
        expect(copied.arguments).toEqual(item.arguments);
        expect(copied.providerMetadata).toEqual(item.providerMetadata);
      }),
    ),
);

it.effect.each([false, true])(
  "streamed prefix cannot hide quoted=$quoted escaped output",
  (quoted) =>
    run(
      Effect.gen(function* () {
        yield* extendedStores(false);
        const sql = yield* SqlClient.SqlClient;
        const config = yield* Config.ServerConfig;
        const output = "heading fixture/output";
        const item = { ...fixture, output };
        yield* sql`UPDATE orchestration_v2_projection_turn_items SET payload_json=${JSON.stringify(item)} WHERE turn_item_id='item-fixture'`;
        yield* sql`UPDATE orchestration_events SET payload_json=${JSON.stringify({ ...fixture, output: "heading " })} WHERE event_id='fixture-event'`;
        const file = NodePath.join(config.logsDir, "overlap.log");
        const encoded = String.raw`heading fixture\/output`;
        const before = quoted ? 'prefix "' + encoded + '" suffix' : "NTIVE: " + encoded;
        yield* Effect.promise(() => NodeFSP.writeFile(file, before));
        const service = yield* ThreadRedaction.ThreadRedaction;
        const result = yield* service
          .redactItem({ threadId, itemId: "item-fixture", reason: "fixture", compact: true })
          .pipe(Effect.result);
        if (quoted) {
          expect(result._tag).toBe("Success");
          if (result._tag === "Success") expect(result.success.verify).toBe(true);
          const after = yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"));
          expect(after.includes("fixture/output")).toBe(false);
          expect(after.includes(encoded)).toBe(false);
        } else {
          expect(result._tag).toBe("Failure");
          expect(yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"))).toBe(before);
          const rows = yield* sql<{
            payload_json: string;
          }>`SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id='item-fixture'`;
          expect(rows[0]!.payload_json).toBe(JSON.stringify(item));
        }
      }),
    ),
);

it.effect.each([
  { form: "object", body: '{"copy":3.141592653589793e15' },
  { form: "array", body: "[3.141592653589793e15" },
  { form: "trailing comma", body: '{"copy":3.141592653589793e15,}' },
  { form: "nested", body: '{"copy":[3.141592653589793e15' },
])("malformed $form log refuses before any mutation", ({ body }) =>
  run(
    Effect.gen(function* () {
      yield* extendedStores(false);
      const sql = yield* SqlClient.SqlClient;
      const config = yield* Config.ServerConfig;
      const item = { ...fixture, output: "3141592653589793" };
      yield* sql`UPDATE orchestration_v2_projection_turn_items SET payload_json=${JSON.stringify(item)} WHERE turn_item_id='item-fixture'`;
      const file = NodePath.join(config.logsDir, "malformed-container.log");
      const before = "NTIVE: " + body;
      yield* Effect.promise(() => NodeFSP.writeFile(file, before));
      const service = yield* ThreadRedaction.ThreadRedaction;
      const error = yield* service
        .redactItem({ threadId, itemId: "item-fixture", reason: "fixture", compact: true })
        .pipe(Effect.flip);
      expect(JSON.stringify(error).includes(item.output)).toBe(false);
      expect(yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"))).toBe(before);
      const rows = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id='item-fixture'`;
      expect(rows[0]!.payload_json).toBe(JSON.stringify(item));
      const pending = yield* sql<{
        pending: number;
      }>`SELECT pending FROM ardud_thread_redaction_recovery WHERE thread_id=${threadId}`;
      expect(pending[0]?.pending).toBe(0);
    }),
  ),
);

it.effect("redacts an equivalent numeric token beside JSON and ordinary log text", () =>
  run(
    Effect.gen(function* () {
      yield* extendedStores(false);
      const sql = yield* SqlClient.SqlClient;
      const config = yield* Config.ServerConfig;
      yield* sql`UPDATE orchestration_v2_projection_turn_items SET payload_json=${JSON.stringify({ ...fixture, output: "3141592653589793" })} WHERE turn_item_id='item-fixture'`;
      const file = NodePath.join(config.logsDir, "raw-number.log");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(file, '{"unrelated":"kept"} 3.141592653589793e15 total'),
      );
      const service = yield* ThreadRedaction.ThreadRedaction;
      const result = yield* service.redactItem({
        threadId,
        itemId: "item-fixture",
        reason: "fixture",
        compact: true,
      });
      expect(result.verify).toBe(true);
      const after = yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"));
      expect(after.startsWith('{"unrelated":"kept"} ')).toBe(true);
      expect(after.endsWith(" total")).toBe(true);
      expect(after.includes("3.141592653589793e15")).toBe(false);
    }),
  ),
);

it.effect.each(["1e10000000", "1e-1000000"])(
  "unverifiable numeric %s refuses before mutation",
  (output) =>
    run(
      Effect.gen(function* () {
        yield* extendedStores(false);
        const sql = yield* SqlClient.SqlClient;
        const config = yield* Config.ServerConfig;
        const item = { ...fixture, output };
        yield* sql`UPDATE orchestration_v2_projection_turn_items SET payload_json=${JSON.stringify(item)} WHERE turn_item_id='item-fixture'`;
        const file = NodePath.join(config.logsDir, "numeric-bound.log");
        const before =
          "amount " + (output.startsWith("1e-") ? "10e-1000001" : "10e9999999") + " total";
        yield* Effect.promise(() => NodeFSP.writeFile(file, before));
        const service = yield* ThreadRedaction.ThreadRedaction;
        const error = yield* service
          .redactItem({ threadId, itemId: "item-fixture", reason: "fixture", compact: true })
          .pipe(Effect.flip);
        expect(JSON.stringify(error).includes(output)).toBe(false);
        expect(yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"))).toBe(before);
        const rows = yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id='item-fixture'`;
        expect(rows[0]!.payload_json).toBe(JSON.stringify(item));
        const audit =
          yield* sql`SELECT event_id FROM orchestration_events WHERE event_type='thread.item-redacted'`;
        expect(audit.length).toBe(0);
        const pending = yield* sql<{
          pending: number;
        }>`SELECT pending FROM ardud_thread_redaction_recovery WHERE thread_id=${threadId}`;
        expect(pending[0]?.pending).toBe(0);
      }),
    ),
);

it.effect.each([
  { output: "1e999999", copy: "0.1e1000000" },
  { output: "1e-999999", copy: "10e-1000000" },
  { output: "-1e999999", copy: "-0.1e1000000" },
  { output: "-1e-999999", copy: "-10e-1000000" },
])("unverifiable source numeric for $output refuses before mutation", ({ output, copy }) =>
  run(
    Effect.gen(function* () {
      yield* extendedStores(false);
      const sql = yield* SqlClient.SqlClient;
      const config = yield* Config.ServerConfig;
      const item = { ...fixture, output };
      yield* sql`UPDATE orchestration_v2_projection_turn_items SET payload_json=${JSON.stringify(item)} WHERE turn_item_id='item-fixture'`;
      const file = NodePath.join(config.logsDir, "numeric-source-bound.log");
      const before = "NTIVE: amount " + copy + " total";
      yield* Effect.promise(() => NodeFSP.writeFile(file, before));
      const service = yield* ThreadRedaction.ThreadRedaction;
      const error = yield* service
        .redactItem({ threadId, itemId: "item-fixture", reason: "fixture", compact: true })
        .pipe(Effect.flip);
      expect(JSON.stringify(error).includes(output)).toBe(false);
      expect(JSON.stringify(error).includes(copy)).toBe(false);
      expect(yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"))).toBe(before);
      const rows = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id='item-fixture'`;
      expect(rows[0]!.payload_json).toBe(JSON.stringify(item));
      const audit =
        yield* sql`SELECT event_id FROM orchestration_events WHERE event_type='thread.item-redacted'`;
      expect(audit.length).toBe(0);
      const pending = yield* sql<{
        pending: number;
      }>`SELECT pending FROM ardud_thread_redaction_recovery WHERE thread_id=${threadId}`;
      expect(pending[0]?.pending).toBe(0);
    }),
  ),
);

it.effect.each(
  ["claudeAgent", "codex"].flatMap((driver) =>
    [
      "config",
      "environment",
      "inherited",
      "default",
      "tilde",
      "shadow",
      "managed",
      "home-environment",
      "home-inherited",
      "home-whitespace-environment",
      "home-whitespace-inherited",
    ]
      .filter((source) => driver === "codex" || (source !== "shadow" && source !== "managed"))
      .map((source) => ({ driver, source })),
  ),
)(
  "covers owning provider home $driver via $source despite an old harness copy",
  ({ driver, source }) =>
    run(
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const config = yield* Config.ServerConfig;
        const settings = yield* ServerSettingsService;
        const instanceId = ProviderInstanceId.make(driver + "-custom");
        const home = yield* HostProcess.HomeDirectory;
        const variable = source.startsWith("home-")
          ? "HOME"
          : driver === "codex"
            ? "CODEX_HOME"
            : "CLAUDE_CONFIG_DIR";
        const custom =
          source === "default" || source === "managed"
            ? NodePath.join(home, driver === "codex" ? ".codex" : ".claude")
            : source.startsWith("home-")
              ? NodePath.join(
                  home,
                  source.includes("whitespace") ? "provider-account " : "provider-account",
                  driver === "codex" ? ".codex" : ".claude",
                )
              : NodePath.join(home, "custom-" + driver);
        yield* settings.updateProviderInstance({
          operation: "upsert",
          instanceId,
          instance: {
            driver: ProviderDriverKind.make(driver),
            config: {
              ...(driver === "codex"
                ? { setupMode: source === "managed" ? "managed" : "existing" }
                : {}),
              ...(source === "config" || source === "tilde" || source === "shadow"
                ? { homePath: source === "tilde" ? "~/custom-" + driver : custom }
                : {}),
              ...(source === "shadow"
                ? { shadowHomePath: NodePath.join(home, "shadow-codex") }
                : {}),
            },
            ...(source === "environment" ||
            (source.startsWith("home-") && source.endsWith("environment"))
              ? {
                  environment: [
                    {
                      name:
                        source.startsWith("home-") && source.endsWith("environment")
                          ? "HOME"
                          : variable,
                      value:
                        source.startsWith("home-") && source.endsWith("environment")
                          ? NodePath.dirname(custom)
                          : custom,
                      sensitive: false,
                    },
                  ],
                }
              : {}),
          },
        });
        yield* sql`INSERT INTO projection_thread_sessions(thread_id,status,provider_name,provider_session_id,provider_instance_id,updated_at) VALUES (${threadId},'stopped',${driver},'session-fixture',${instanceId},'2026-01-01')`;
        const relative =
          driver === "codex"
            ? "sessions/rollout-session-fixture.jsonl"
            : "projects/fixture/session-fixture.jsonl";
        const old = NodePath.join(
          config.baseDir,
          "harness-homes",
          driver === "codex" ? "codex" : "claude",
          relative,
        );
        const actual = NodePath.join(custom, relative);
        const providerOnly = "eyJFAKE.ONLY-ACTUAL-PROVIDER-HOME";
        const line = (output: string) =>
          JSON.stringify(
            driver === "codex"
              ? {
                  type: "response_item",
                  payload: { type: "function_call_output", call_id: "call-fixture", output },
                }
              : { type: "tool_result", tool_use_id: "call-fixture", content: output },
          ) + "\n";
        yield* Effect.promise(async () => {
          for (const path of [old, actual])
            await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
          await NodeFSP.writeFile(old, line(fake));
          await NodeFSP.writeFile(
            actual,
            line(providerOnly) + JSON.stringify({ summary: providerOnly }) + "\n",
          );
          if (source === "shadow") {
            const shadow = NodePath.join(home, "shadow-codex");
            await NodeFSP.mkdir(shadow, { recursive: true });
            await NodeFSP.symlink(
              NodePath.join(custom, "sessions"),
              NodePath.join(shadow, "sessions"),
              "dir",
            );
          }
        });
        const service = yield* ThreadRedaction.ThreadRedaction;
        const result = yield* service
          .redactItem({ threadId, itemId: "call-fixture", reason: "fixture", compact: true })
          .pipe(
            Effect.provideService(
              HostProcess.Environment,
              source === "inherited"
                ? { [variable]: custom }
                : source.startsWith("home-") && source.endsWith("inherited")
                  ? { HOME: NodePath.dirname(custom) }
                  : {},
            ),
          );
        expect(result.verify).toBe(true);
        for (const path of [old, actual]) {
          const after = yield* Effect.promise(() => NodeFSP.readFile(path, "utf8"));
          expect(after.includes(fake)).toBe(false);
          expect(after.includes(providerOnly)).toBe(false);
        }
        expect(JSON.stringify(result).includes(providerOnly)).toBe(false);
      }),
    ),
);

it.effect.each(
  ["claudeAgent", "codex"].flatMap((driver) =>
    ["environment", "inherited", "home-environment", "home-inherited"].flatMap((source) =>
      ["./provider-home", "../provider-home", "provider-home"].map((home) => ({
        driver,
        source,
        home,
      })),
    ),
  ),
)("refuses ambiguous relative home $driver $source $home", ({ driver, source, home }) =>
  run(
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const config = yield* Config.ServerConfig;
      const settings = yield* ServerSettingsService;
      const instanceId = ProviderInstanceId.make(driver + "-relative");
      const variable = source.startsWith("home-")
        ? "HOME"
        : driver === "codex"
          ? "CODEX_HOME"
          : "CLAUDE_CONFIG_DIR";
      yield* settings.updateProviderInstance({
        operation: "upsert",
        instanceId,
        instance: {
          driver: ProviderDriverKind.make(driver),
          config: driver === "codex" ? { setupMode: "existing" } : {},
          ...(source === "environment" || source === "home-environment"
            ? { environment: [{ name: variable, value: home, sensitive: false }] }
            : {}),
        },
      });
      yield* sql`INSERT INTO projection_thread_sessions(thread_id,status,provider_name,provider_session_id,provider_instance_id,updated_at) VALUES (${threadId},'stopped',${driver},'session-fixture',${instanceId},'2026-01-01')`;
      const relative =
        driver === "codex"
          ? "sessions/rollout-session-fixture.jsonl"
          : "projects/fixture/session-fixture.jsonl";
      const old = NodePath.join(
        config.baseDir,
        "harness-homes",
        driver === "codex" ? "codex" : "claude",
        relative,
      );
      const actual = NodePath.join(
        config.baseDir,
        "session-cwd",
        home,
        ...(source.startsWith("home-") ? [driver === "codex" ? ".codex" : ".claude"] : []),
        relative,
      );
      const line =
        JSON.stringify(
          driver === "codex"
            ? {
                type: "response_item",
                payload: { type: "function_call_output", call_id: "call-fixture", output: fake },
              }
            : { type: "tool_result", tool_use_id: "call-fixture", content: fake },
        ) + "\n";
      yield* Effect.promise(async () => {
        for (const path of [old, actual]) {
          await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
          await NodeFSP.writeFile(path, line);
        }
      });
      const service = yield* ThreadRedaction.ThreadRedaction;
      const error = yield* service
        .redactItem({ threadId, itemId: "call-fixture", reason: "fixture", compact: true })
        .pipe(
          Effect.provideService(
            HostProcess.Environment,
            source === "inherited" || source === "home-inherited" ? { [variable]: home } : {},
          ),
          Effect.flip,
        );
      expect(error.code).toBe("invalid");
      for (const file of [old, actual])
        expect(yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"))).toBe(line);
      const rows = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id='item-fixture'`;
      expect(rows[0]!.payload_json).toBe(JSON.stringify(fixture));
      const audit =
        yield* sql`SELECT event_id FROM orchestration_events WHERE event_type='thread.item-redacted'`;
      expect(audit.length).toBe(0);
    }),
  ),
);

it.effect.each(["truncated gzip", "invalid UTF-8", "incomplete log frame"])(
  "refuses a later archive with %s before rewriting any file or database row",
  (invalid) =>
    run(
      Effect.gen(function* () {
        yield* extendedStores(false);
        const config = yield* Config.ServerConfig;
        const sql = yield* SqlClient.SqlClient;
        const first = NodePath.join(config.logsDir, "00-first.trace.ndjson.1.gz");
        const last = NodePath.join(config.logsDir, "zz-last.trace.ndjson.2.gz");
        const source = NodeZlib.gzipSync(JSON.stringify({ output: fake }) + "\n");
        const corrupt =
          invalid === "truncated gzip"
            ? source.subarray(0, source.length - 6)
            : NodeZlib.gzipSync(
                invalid === "invalid UTF-8"
                  ? Buffer.from([0xff])
                  : String.raw`NTIVE: "unrelated\u0061`,
              );
        yield* Effect.promise(async () => {
          await NodeFSP.writeFile(first, source);
          await NodeFSP.writeFile(last, corrupt);
        });
        const service = yield* ThreadRedaction.ThreadRedaction;
        const result = yield* service
          .redactItem({
            threadId,
            itemId: "item-fixture",
            reason: "fixture",
            compact: true,
          })
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(yield* Effect.promise(() => NodeFSP.readFile(first))).toEqual(source);
        expect(yield* Effect.promise(() => NodeFSP.readFile(last))).toEqual(corrupt);
        const rows = yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id='item-fixture'`;
        expect(rows[0]!.payload_json).toBe(JSON.stringify(fixture));
        const pending = yield* sql<{
          pending: number;
        }>`SELECT pending FROM ardud_thread_redaction_recovery WHERE thread_id=${threadId}`;
        expect(pending[0]?.pending).toBe(0);
      }),
    ),
);

it.effect("scrubs compressed trace backups without changing other spans or summaries", () =>
  run(
    Effect.gen(function* () {
      yield* extendedStores(false);
      const config = yield* Config.ServerConfig;
      const file = NodePath.join(config.logsDir, "server.trace.ndjson.1.gz");
      const unrelated = JSON.stringify({
        type: "span-summary",
        windowStart: 0,
        windowEnd: 60000,
        spans: { sqlite: { count: 2, totalMs: 1, maxMs: 0.5 } },
      });
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          file,
          NodeZlib.gzipSync(
            JSON.stringify({ type: "effect-span", attributes: { output: fake } }) +
              "\n" +
              unrelated +
              "\n",
          ),
          { mode: 0o640 },
        ),
      );
      const service = yield* ThreadRedaction.ThreadRedaction;
      const result = yield* service.redactItem({
        threadId,
        itemId: "item-fixture",
        reason: "fixture",
        compact: true,
      });
      expect(result.verify).toBe(true);
      expect(
        result.stores.some((s) => s.store === file && s.replaced > 0 && s.remainingAfter === 0),
      ).toBe(true);
      const text = NodeZlib.gunzipSync(
        yield* Effect.promise(() => NodeFSP.readFile(file)),
      ).toString("utf8");
      expect(text.includes(fake)).toBe(false);
      expect(text.split("\n")[1]).toBe(unrelated);
      expect((yield* Effect.promise(() => NodeFSP.stat(file))).mode & 0o777).toBe(0o640);
    }),
  ),
);
