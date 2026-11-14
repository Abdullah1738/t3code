import * as NodeWorkerThreads from "node:worker_threads";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import { vi } from "vite-plus/test";

import { openCodeUsageReader, readOpenCodeUsage } from "./usage.ts";

const statementReads = vi.hoisted(() => ({
  current: undefined as Array<{ sql: string; size: number; window: number }> | undefined,
}));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeWorkerThreads>();
  class ObservedWorker extends actual.Worker {
    readonly statements = new Map<number, { sql: string; window: number }>();
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(...args);
      this.on("message", (reply: unknown) => {
        if (
          typeof reply !== "object" ||
          reply === null ||
          !("id" in reply) ||
          typeof reply.id !== "number"
        )
          return;
        const statement = this.statements.get(reply.id);
        this.statements.delete(reply.id);
        if (statement === undefined || !("rows" in reply) || !Array.isArray(reply.rows)) return;
        const size = reply.rows.reduce((total: number, row: unknown) => {
          const data =
            typeof row === "object" && row !== null && "data" in row ? row.data : undefined;
          return total + (typeof data === "string" ? data.length : 0);
        }, 0);
        statementReads.current?.push({ ...statement, size });
      });
    }
    override postMessage(...args: Parameters<NodeWorkerThreads.Worker["postMessage"]>) {
      const [request] = args;
      if (typeof request?.id === "number" && typeof request.sql === "string") {
        const lower = request.params?.at(-2);
        const upper = request.params?.at(-1);
        const bounded = /rowid > \? AND rowid <= \?/.test(request.sql);
        this.statements.set(request.id, {
          sql: request.sql,
          window:
            bounded && typeof lower === "number" && typeof upper === "number"
              ? upper - lower
              : Infinity,
        });
      }
      super.postMessage(...args);
    }
  }
  return { ...actual, Worker: ObservedWorker };
});

const recordReads = Effect.acquireRelease(
  Effect.sync(() => {
    const reads: Array<{ sql: string; size: number; window: number }> = [];
    statementReads.current = reads;
    return reads;
  }),
  () =>
    Effect.sync(() => {
      statementReads.current = undefined;
    }),
);

const openDatabase = (filename: string) =>
  Layer.build(NodeSqliteClient.layer({ filename })).pipe(
    Effect.map(Context.get(SqlClient.SqlClient)),
  );

describe("readOpenCodeUsage", () => {
  it.effect("bounds raw history allocations while counting every eligible message once", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usage-reader-large-test-" });
      const db = yield* openDatabase(path.join(dir, "opencode.db"));
      yield* db.unsafe(
        "CREATE TABLE message (id TEXT, session_id TEXT, data TEXT, time_created INTEGER)",
      );
      const sinceMs = 1780000000000;
      const message = {
        role: "assistant",
        modelID: "claude-sonnet-4-5",
        time: { created: sinceMs },
        tokens: { input: 100, output: 20 },
        body: "x".repeat(64 * 1024),
      };
      const data = JSON.stringify(message);
      const insert = (rowId: number, id: string, payload: string, created = sinceMs) =>
        db.unsafe(
          "INSERT INTO message (rowid, id, session_id, data, time_created) VALUES (?, ?, ?, ?, ?)",
          [rowId, id, "session-1", payload, created],
        );
      for (let index = 0; index < 130; index++) {
        yield* insert(index * 2 - 10, `msg-${index}`, data);
      }
      yield* insert(300, "old", data, sinceMs - 1);
      yield* insert(301, "user", JSON.stringify({ ...message, role: "user" }));
      yield* insert(302, "invalid", "{invalid");
      yield* insert(303, "msg-0", data);

      const reads = yield* recordReads;
      const result = yield* readOpenCodeUsage(dir, sinceMs);
      assert.isFalse(result.error);
      const records = result.files.flatMap((file) => file.records);
      assert.deepStrictEqual(
        records.map((record) => record.dedupeKey),
        Array.from({ length: 130 }, (_, index) => `opencode:msg-${index}`),
      );
      assert.strictEqual(
        records.reduce((total, record) => total + record.totals.uncachedInputTokens, 0),
        13000,
      );
      const largestRawResult = Math.max(...reads.map((read) => read.size));
      assert.isAbove(largestRawResult, 0);
      assert.isBelow(largestRawResult, 6 * 1024 * 1024);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reads at most 64 OpenCode rowids per statement however much history is older", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usage-reader-test-" });
      const db = yield* openDatabase(path.join(dir, "opencode.db"));
      yield* db.unsafe(
        "CREATE TABLE message (id TEXT, session_id TEXT, data TEXT, time_created INTEGER)",
      );
      const sinceMs = 1780000000000;
      const data = JSON.stringify({
        role: "assistant",
        modelID: "claude-sonnet-4-5",
        tokens: { input: 100, output: 20 },
      });
      yield* db.unsafe("BEGIN");
      for (let index = 0; index < 305; index++) {
        yield* db.unsafe("INSERT INTO message VALUES (?, ?, ?, ?)", [
          `msg-${index}`,
          "session-1",
          data,
          sinceMs + index - 300,
        ]);
      }
      yield* db.unsafe("COMMIT");

      const reads = yield* recordReads;
      const result = yield* readOpenCodeUsage(dir, sinceMs);
      assert.isFalse(result.error);
      assert.deepStrictEqual(
        result.files.flatMap((file) => file.records).map((record) => record.dedupeKey),
        Array.from({ length: 5 }, (_, index) => `opencode:msg-${index + 300}`),
      );
      const windows = reads
        .filter((read) => read.sql.includes("FROM message WHERE"))
        .map((read) => read.window);
      assert.isNotEmpty(windows);
      assert.isAtMost(Math.max(...windows), 64);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("counts migrated OpenCode messages once and sees subsequent WAL writes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usage-reader-test-" });
      const db = yield* openDatabase(path.join(dir, "opencode.db"));
      yield* db.unsafe("PRAGMA journal_mode = WAL");
      yield* db.unsafe("PRAGMA wal_autocheckpoint = 0");
      yield* db.unsafe("CREATE TABLE message (id TEXT, session_id TEXT, data TEXT)");
      const message = {
        id: "msg-1",
        sessionID: "session-1",
        role: "assistant",
        modelID: "claude-sonnet-4-5",
        time: { created: 1780000000000 },
        cost: 0.25,
        tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 30, write: 10 } },
      };
      const insert = (id: string, sessionId: string, data: string) =>
        db.unsafe("INSERT INTO message VALUES (?, ?, ?)", [id, sessionId, data]);
      yield* insert(message.id, message.sessionID, JSON.stringify(message));
      const legacy = path.join(dir, "storage", "message", message.sessionID);
      yield* fileSystem.makeDirectory(legacy, { recursive: true });
      yield* fileSystem.writeFileString(path.join(legacy, "msg-1.json"), JSON.stringify(message));
      const first = yield* readOpenCodeUsage(dir, 0);
      assert.isFalse(first.error);
      const records = first.files.flatMap((file) => file.records);
      assert.strictEqual(records.length, 1);
      assert.deepStrictEqual(records[0]?.totals, {
        uncachedInputTokens: 100,
        cachedInputTokens: 30,
        cacheCreationTokens: 10,
        outputTokens: 25,
        reasoningTokens: 5,
      });
      assert.strictEqual(records[0]?.reportedCostUsd, 0.25);
      yield* insert(
        "msg-2",
        message.sessionID,
        JSON.stringify({ ...message, id: "msg-2", time: { created: 1780000001000 } }),
      );
      const next = yield* readOpenCodeUsage(dir, 1780000001000);
      assert.isFalse(next.error);
      assert.deepStrictEqual(
        next.files.flatMap((file) => file.records).map((record) => record.dedupeKey),
        ["opencode:msg-2"],
      );
      assert.isAbove(Number((yield* fileSystem.stat(path.join(dir, "opencode.db-wal"))).size), 0);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reads only legacy OpenCode messages written since the window opened", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usage-reader-test-" });
      const sinceMs = 1780000000000;
      const legacy = path.join(dir, "storage", "message", "session-1");
      yield* fileSystem.makeDirectory(legacy, { recursive: true });
      const write = Effect.fn(function* (id: string, mtimeMs: number) {
        const file = path.join(legacy, `${id}.json`);
        yield* fileSystem.writeFileString(
          file,
          JSON.stringify({
            id,
            sessionID: "session-1",
            role: "assistant",
            modelID: "claude-sonnet-4-5",
            time: { created: sinceMs + 1000 },
            tokens: { input: 100, output: 20 },
          }),
        );
        yield* fileSystem.utimes(file, mtimeMs / 1000, mtimeMs / 1000);
        return file;
      });
      yield* write("msg-old", sinceMs - 60_000);

      const stale = yield* readOpenCodeUsage(dir, sinceMs);
      assert.deepStrictEqual(stale, { files: [], missing: false, error: false });

      const recent = yield* write("msg-new", sinceMs + 60_000);
      const result = yield* readOpenCodeUsage(dir, sinceMs);
      assert.isFalse(result.missing);
      assert.isFalse(result.error);
      assert.deepStrictEqual(
        result.files.map((file) => file.path),
        [recent],
      );
      assert.deepStrictEqual(
        result.files.flatMap((file) => file.records).map((record) => record.dedupeKey),
        ["opencode:msg-new"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("never follows symlinks in the legacy OpenCode store", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usage-reader-test-" });
      const outside = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usage-reader-test-" });
      const sinceMs = 1780000000000;
      const store = path.join(dir, "storage", "message");
      const session = path.join(store, "session-1");
      yield* fileSystem.makeDirectory(session, { recursive: true });
      const write = Effect.fn(function* (directory: string, id: string, mtimeMs: number) {
        const file = path.join(directory, `${id}.json`);
        yield* fileSystem.writeFileString(
          file,
          JSON.stringify({
            id,
            sessionID: "session-1",
            role: "assistant",
            modelID: "claude-sonnet-4-5",
            time: { created: sinceMs + 1000 },
            tokens: { input: 100, output: 20 },
          }),
        );
        yield* fileSystem.utimes(file, mtimeMs / 1000, mtimeMs / 1000);
        return file;
      });
      const target = yield* write(outside, "msg-linked", sinceMs + 60_000);
      const stale = yield* write(outside, "msg-stale", sinceMs - 60_000);
      yield* fileSystem.symlink(target, path.join(session, "msg-linked.json"));
      yield* fileSystem.symlink(stale, path.join(session, "msg-stale.json"));
      yield* fileSystem.symlink(outside, path.join(store, "session-linked"));
      yield* fileSystem.symlink(store, path.join(session, "cycle"));
      yield* fileSystem.symlink(path.join(outside, "gone.json"), path.join(session, "gone.json"));
      yield* fileSystem.symlink(path.join(session, "loop.json"), path.join(session, "loop.json"));

      const linksOnly = yield* readOpenCodeUsage(dir, sinceMs);
      assert.deepStrictEqual(linksOnly, { files: [], missing: true, error: false });

      const real = yield* write(session, "msg-real", sinceMs + 60_000);
      const result = yield* readOpenCodeUsage(dir, sinceMs);
      assert.isFalse(result.missing);
      assert.isFalse(result.error);
      assert.deepStrictEqual(
        result.files.map((file) => file.path),
        [real],
      );
      assert.deepStrictEqual(
        result.files.flatMap((file) => file.records).map((record) => record.dedupeKey),
        ["opencode:msg-real"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reads a large legacy OpenCode session in directory order", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usage-reader-test-" });
      const session = path.join(dir, "storage", "message", "session-1");
      yield* fileSystem.makeDirectory(session, { recursive: true });
      yield* Effect.forEach(
        Array.from({ length: 600 }, (_, index) => `msg-${index}`),
        (id) =>
          fileSystem.writeFileString(
            path.join(session, `${id}.json`),
            JSON.stringify({
              id,
              sessionID: "session-1",
              role: "assistant",
              modelID: "claude-sonnet-4-5",
              time: { created: 1780000000000 },
              tokens: { input: 100, output: 20 },
            }),
          ),
        { concurrency: 16, discard: true },
      );
      const names = yield* fileSystem.readDirectory(session);

      const result = yield* readOpenCodeUsage(dir, 0);
      assert.isFalse(result.error);
      assert.deepStrictEqual(
        result.files.map((file) => file.path),
        names.map((name) => path.join(session, name)),
      );
      assert.strictEqual(result.files.flatMap((file) => file.records).length, 600);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("openCodeUsageReader", () => {
  it.effect("scans canonical instance roots once, including XDG and home defaults", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usage-instances-test-" });
      const home = yield* fileSystem.realPath(temp);
      const defaultRoot = path.join(home, ".local", "share", "opencode");
      const instanceRoot = path.join(home, "instance");
      const dataHome = path.join(home, "xdg");
      const xdgRoot = path.join(dataHome, "opencode");
      const alias = path.join(home, "default-alias");
      for (const root of [defaultRoot, instanceRoot, xdgRoot]) {
        yield* fileSystem.makeDirectory(root, { recursive: true });
      }
      yield* fileSystem.symlink(defaultRoot, alias);
      const instances = [
        { id: "opencode", environment: {}, configured: false },
        {
          id: "opencode-list",
          environment: { OPENCODE_DATA_DIR: ` ${instanceRoot}, ${alias}, ${defaultRoot}, , ` },
          configured: true,
        },
        {
          id: "opencode-xdg",
          environment: { XDG_DATA_HOME: dataHome },
          configured: true,
        },
      ];
      if (openCodeUsageReader.kind !== "scan") throw new Error("Expected an OpenCode scan reader");
      const sources = yield* openCodeUsageReader
        .scan({
          instances: instances.map(({ id, environment, configured }) => ({
            instanceId: ProviderInstanceId.make(id),
            config: undefined,
            environment,
            configured,
          })),
          settings: DEFAULT_SERVER_SETTINGS,
          windowStartMs: 0,
          retentionCutoffMs: 0,
          awaitRefresh: true,
        })
        .pipe(
          Effect.provideService(HostProcess.Environment, {}),
          Effect.provideService(HostProcess.HomeDirectory, home),
        );
      assert.deepStrictEqual(
        sources.map((source) => source.dir).sort(),
        [defaultRoot, instanceRoot, xdgRoot].sort(),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
