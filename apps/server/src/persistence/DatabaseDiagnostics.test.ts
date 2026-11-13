import * as TestClock from "effect/testing/TestClock";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import { ErrorObserver } from "@t3tools/shared/nodeSqliteErrors";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../config.ts";
import * as DatabaseDiagnostics from "./DatabaseDiagnostics.ts";
// @effect-diagnostics nodeBuiltinImport:off -- isolated fixtures exercise the native durable log boundary.
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SqlClient from "effect/sql/SqlClient";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodePath from "node:path";
import * as NodeFSP from "node:fs/promises";
import { vi } from "vite-plus/test";
import { createDatabaseMonitor, writeDatabaseError } from "./DatabaseDiagnostics.ts";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
}));

const context = {
  file: "/isolated/state.sqlite",
  role: "primary",
  connection: "reader",
  operation: "execute",
  span: "sqlite.reader.execute",
} as const;
const error = (errcode: number) => ({ errcode, errstr: "database disk image is malformed" });

describe("database error evidence", () => {
  it("keeps the full extended code and role, rate limits per file/code, and flushes suppressed counts", () => {
    let now = 0;
    const lines: string[] = [];
    const monitor = createDatabaseMonitor(
      () => now,
      (line) => lines.push(line),
    );
    monitor.observe(error(779), context);
    monitor.observe(error(779), context);
    monitor.observe(error(779), context);
    monitor.observe(error(11), context);
    monitor.observe(error(779), { ...context, file: "/isolated/boards.sqlite" });
    assert.equal(lines.length, 3);
    assert.include(JSON.parse(lines[0]!), {
      errcode: 779,
      primaryName: "SQLITE_CORRUPT",
      role: "primary",
      count: 1,
      span: "sqlite.reader.execute",
    });
    now = 60_000;
    monitor.flush();
    assert.equal(lines.length, 4);
    assert.equal(JSON.parse(lines[3]!).count, 2);
  });

  it.each([11, 779, 26])("never calls primary error %i healthy after the recent window", (code) => {
    let now = 1000;
    const monitor = createDatabaseMonitor(
      () => now,
      () => {},
    );
    monitor.observe(error(code), context);
    assert.equal(monitor.health().status, "degraded");
    now += 300_000;
    assert.equal(monitor.health().status, "recovered-unverified");
    assert.include(monitor.health().databaseErrors[0], {
      errcode: code,
      firstAt: "1970-01-01T00:00:01.000Z",
      lastAt: "1970-01-01T00:00:01.000Z",
    });
    monitor.observe(error(5), context);
    assert.equal(monitor.health().status, "recovered-unverified");
  });

  it.each([5, 10, 11, 26])("transient replica error %i can age back to healthy", (code) => {
    let now = 0;
    const monitor = createDatabaseMonitor(
      () => now,
      () => {},
    );
    monitor.observe(error(code), { ...context, role: "replica" });
    assert.equal(monitor.health().status, code === 5 ? "healthy" : "degraded");
    now = 300_000;
    assert.equal(monitor.health().status, "healthy");
  });

  it("flushes the final minute on close and retains active degradation under capacity pressure", () => {
    let now = 0;
    const lines: string[] = [];
    const monitor = createDatabaseMonitor(
      () => now,
      (line) => lines.push(line),
    );
    monitor.observe(error(10), context);
    monitor.observe(error(10), context);
    for (let i = 0; i < 128; i++) monitor.observe(error(5), { ...context, file: `file-${i}` });
    assert.equal(monitor.health().status, "degraded");
    assert.equal(monitor.health().databaseErrors[0]?.errcode, 10);
    now = 1000;
    monitor.flush(true);
    assert.equal(
      lines
        .map((line) => JSON.parse(line))
        .filter((row) => row.errcode === 10)
        .reduce((sum, row) => sum + row.count, 0),
      2,
    );
    now = 300_000;
    assert.equal(monitor.health().status, "healthy");
  });

  it("keeps an owner-deferred integrity check unverified after requests recover", () => {
    let now = 0;
    const monitor = createDatabaseMonitor(
      () => now,
      () => {},
    );
    monitor.markUnverified(context.file, "Owner deferred the statev2 check after 8 Nov");
    assert.equal(monitor.health().status, "recovered-unverified");
    monitor.observe(error(10), context);
    assert.equal(monitor.health().status, "degraded");
    now = 300_000;
    assert.equal(monitor.health().status, "recovered-unverified");
    assert.equal(monitor.health().unverifiedDatabases[0]?.file, context.file);
  });

  it("records a new primary corruption key after the rate windows saturate", () => {
    const lines: string[] = [];
    const monitor = createDatabaseMonitor(
      () => 0,
      (line) => lines.push(line),
    );
    for (let i = 0; i < 128; i++) monitor.observe(error(5), { ...context, file: `busy-${i}` });
    monitor.observe(error(779), context);
    monitor.observe(error(779), context);
    monitor.flush(true);
    const corruption = lines.map((line) => JSON.parse(line)).filter((row) => row.errcode === 779);
    assert.equal(
      corruption.reduce((sum, row) => sum + row.count, 0),
      2,
    );
    assert.equal(corruption[0].errstr, "database disk image is malformed");
    assert.equal(corruption[0].span, "sqlite.reader.execute");
  });

  it.effect("records a real driver failure with its DB file and primary role", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const filename = NodePath.join(directory, "broken.sqlite");
      yield* fs.writeFileString(filename, "invalid SQLite file".repeat(1024));
      const lines: string[] = [];
      const monitor = createDatabaseMonitor(
        () => 1000,
        (line) => lines.push(line),
      );
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`SELECT * FROM sqlite_schema`;
      }).pipe(
        Effect.provide(NodeSqliteClient.layer({ filename, errorObserver: monitor.observe })),
        Effect.flip,
      );
      assert.equal(lines.length, 1);
      assert.include(JSON.parse(lines[0]!), {
        file: filename,
        role: "primary",
        errcode: 26,
        primaryName: "SQLITE_NOTADB",
      });
      assert.equal(monitor.health().status, "degraded");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "persists separately from the trace and falls back to stderr when the directory is unwritable",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        const line = '{"errcode":779,"role":"primary"}\n';
        yield* writeDatabaseError(directory, line, Date.parse("2026-11-12T10:00Z"));
        assert.equal(
          yield* fs.readFileString(NodePath.join(directory, "db-errors.2026-11-12.ndjson")),
          line,
        );
        const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
        try {
          yield* writeDatabaseError(
            NodePath.join(directory, "db-errors.2026-11-12.ndjson", "missing"),
            line,
            0,
          );
          assert.equal(spy.mock.calls[0]?.[0], line);
        } finally {
          spy.mockRestore();
        }
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("bounds each day's file and retains days of history", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const day = Date.parse("2026-11-12T10:00Z");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(directory, "db-errors.2026-11-12.ndjson"),
          "x".repeat(1024 * 1024),
        ),
      );
      yield* fs.writeFileString(NodePath.join(directory, "db-errors.2026-11-01.ndjson"), "old");
      yield* fs.writeFileString(NodePath.join(directory, "db-errors.2026-11-10.ndjson"), "keep");
      yield* writeDatabaseError(directory, "new\n", day);
      assert.equal(
        yield* fs.readFileString(NodePath.join(directory, "db-errors.2026-11-12.ndjson")),
        "new\n",
      );
      assert.isTrue(yield* fs.exists(NodePath.join(directory, "db-errors.2026-11-12.ndjson.1")));
      assert.isTrue(yield* fs.exists(NodePath.join(directory, "db-errors.2026-11-10.ndjson")));
      assert.isFalse(yield* fs.exists(NodePath.join(directory, "db-errors.2026-11-01.ndjson")));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

it.effect("loads a release-installed unverified marker without querying a database", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(config.logsDir, { recursive: true });
    yield* fs.writeFileString(
      NodePath.join(config.logsDir, "db-integrity-unverified.json"),
      '{"unverified":true,"reason":"Owner deferred statev2 integrity check"}',
    );
    const context = yield* Layer.build(DatabaseDiagnostics.layer);
    const health = yield* Context.get(context, DatabaseDiagnostics.DatabaseDiagnostics).health;
    assert.equal(health.status, "recovered-unverified");
    assert.equal(health.unverifiedDatabases[0]?.file, config.dbPath);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "db-diag-marker-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("scope closure persists suppressed occurrences before the minute expires", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const contextServices = yield* Layer.build(DatabaseDiagnostics.layer);
        const observe = Context.get(contextServices, ErrorObserver)!;
        observe(error(779), context);
        observe(error(779), context);
      }),
    );
    const names = yield* fs.readDirectory(config.logsDir);
    const filename = names.find((name) => /^db-errors.*ndjson$/.test(name))!;
    const lines = (yield* fs.readFileString(NodePath.join(config.logsDir, filename)))
      .trim()
      .split("\n");
    assert.equal(lines.length, 2);
    assert.isTrue(lines.every((line) => line.includes('"count":1')));
  }).pipe(
    Effect.scoped,
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "db-diag-close-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("closing the service waits for an active append to sync and close", () =>
  Effect.gen(function* () {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const keepOpen = yield* Deferred.make<void>();
    const open = NodeFSP.open;
    let synced = 0;
    let closedHandle = 0;
    let scopeClosed = false;
    const spy = vi.spyOn(NodeFSP, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      const write = handle.writeFile.bind(handle);
      const sync = handle.sync.bind(handle);
      const close = handle.close.bind(handle);
      handle.writeFile = async (data, options) => {
        started.resolve();
        await release.promise;
        return write(data, options);
      };
      handle.sync = async () => {
        synced++;
        return sync();
      };
      handle.close = async () => {
        closedHandle++;
        return close();
      };
      return handle;
    });
    try {
      const service = yield* Effect.scoped(
        Effect.gen(function* () {
          const services = yield* Layer.build(DatabaseDiagnostics.layer);
          Context.get(services, ErrorObserver)!(error(779), context);
          yield* Deferred.await(keepOpen);
        }),
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            scopeClosed = true;
          }),
        ),
        Effect.forkChild,
      );
      yield* TestClock.adjust("1 second");
      yield* Effect.promise(() => started.promise);
      const stopping = yield* Fiber.interrupt(service).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.isFalse(scopeClosed);
      release.resolve();
      yield* Fiber.join(stopping);
      assert.isTrue(scopeClosed);
      assert.equal(synced, 1);
      assert.equal(closedHandle, 1);
    } finally {
      release.resolve();
      spy.mockRestore();
    }
  }).pipe(
    Effect.scoped,
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "db-diag-active-close-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);
