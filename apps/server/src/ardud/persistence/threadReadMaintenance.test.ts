// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { AnalyticsEvent } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../../persistence/Sqlite.ts";
import { forkParkedFiber, ServerActivation } from "../../serverActivation.ts";
import { maintainThreadReadIndexes } from "./threadReadMaintenance.ts";
import { Analytics } from "../analytics/Analytics.ts";
import { readThreadIndexAvailability } from "./threadReadCount.ts";

const isAnalyticsEvent = Schema.is(AnalyticsEvent);

it.live("builds after the quiet window even when every read uses the writer", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "thread-index-fallback-"));
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE orchestration_v2_projection_turn_items(
      turn_item_id TEXT, thread_id TEXT, run_id TEXT, node_id TEXT, type TEXT, payload_json TEXT)`;
    yield* sql`ATTACH DATABASE ${NodePath.join(dir, "archive.sqlite")} AS ardud_archive`;
    yield* sql`CREATE TABLE ardud_archive.ardud_turn_items(
      turn_item_id TEXT, thread_id TEXT, run_id TEXT, node_id TEXT, type TEXT, payload_json TEXT)`;
    clock.mockReturnValue(60_001);
    yield* maintainThreadReadIndexes({ idleMs: 60_000, retryMs: 1 });
    assert.deepEqual(yield* readThreadIndexAvailability(sql), { main: true, ardud_archive: true });
  }).pipe(
    Effect.provide(
      NodeSqliteClient.layer({ filename: NodePath.join(dir, "state.sqlite"), readerWorker: false }),
    ),
    Effect.ensuring(
      Effect.sync(() => {
        clock.mockRestore();
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }),
    ),
  );
});

it.live("reaches activation without indexes, then builds all six after ready", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "thread-index-"));
  const events: AnalyticsEvent[] = [];
  const analytics = Analytics.of({
    record: (event) =>
      Effect.sync(() => {
        assert.isTrue(isAnalyticsEvent(event));
        events.push(event);
      }),
    flush: Effect.void,
    ingest: () => Effect.void,
    read: () => Effect.die("Unused analytics read"),
  });
  return Effect.gen(function* () {
    const activation = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const names = () => sql<{ name: string }>`
        SELECT name FROM main.sqlite_schema WHERE name LIKE 'ardud_thread_read_%'
        UNION ALL SELECT name FROM ardud_archive.sqlite_schema WHERE name LIKE 'ardud_thread_read_%'`;
      assert.lengthOf(yield* names(), 0);
      assert.deepEqual(yield* readThreadIndexAvailability(sql), {
        main: false,
        ardud_archive: false,
      });
      const job = yield* forkParkedFiber(maintainThreadReadIndexes({ idleMs: 0, retryMs: 1 }));
      assert.lengthOf(yield* names(), 0);
      yield* Deferred.succeed(activation, undefined);
      yield* Fiber.join(job);
      assert.lengthOf(yield* names(), 6);
      assert.deepEqual(yield* readThreadIndexAvailability(sql), {
        main: true,
        ardud_archive: true,
      });
      assert.lengthOf(events, 12);
      for (const event of events) {
        assert.equal(event.kind, "db.maintenance.index");
        assert.isTrue(event.route.includes("turn_items"));
        assert.isDefined(event.startedAt);
        assert.isAtLeast(event.durationMs!, 0);
      }
      assert.equal(events.filter((event) => event.outcome === "ok").length, 6);
      yield* maintainThreadReadIndexes({ idleMs: 0, retryMs: 1 });
      assert.lengthOf(yield* names(), 6);
    }).pipe(
      Effect.provide(Sqlite.layerFromPath(NodePath.join(dir, "state.sqlite"))),
      Effect.provideService(ServerActivation, Deferred.await(activation)),
      Effect.provideService(Analytics, analytics),
    );
  }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true }))),
  );
});

it.live.each([false, true])(
  "preempts maintenance for a foreground writer (transaction=%s) and retries",
  (transaction) => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "thread-index-"));
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT)`;
      yield* sql`INSERT INTO items VALUES (1, 'one')`;
      assert.isTrue(
        Option.isNone(
          yield* NodeSqliteClient.idleIndexBuild(
            sql,
            "CREATE INDEX IF NOT EXISTS items_value ON items(value)",
            60_000,
          ),
        ),
      );
      const started = yield* Deferred.make<void>();
      const work = yield* NodeSqliteClient.idleIndexBuild(
        sql,
        "CREATE INDEX IF NOT EXISTS items_value ON items(value)",
        0,
        (signal) =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(
              Effect.callback<void>((resume) => {
                const abort = () => resume(Effect.void);
                signal.addEventListener("abort", abort, { once: true });
                if (signal.aborted) abort();
                return Effect.sync(() => signal.removeEventListener("abort", abort));
              }),
            ),
          ),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const write = sql`INSERT INTO items VALUES (2, 'two')`;
      const command = yield* (transaction ? sql.withTransaction(write) : write).pipe(
        Effect.forkChild,
      );
      yield* Fiber.join(command);
      assert.deepEqual(yield* Fiber.join(work), Option.some(false));
      assert.deepEqual(
        yield* NodeSqliteClient.idleIndexBuild(
          sql,
          "CREATE INDEX IF NOT EXISTS items_value ON items(value)",
          0,
        ),
        Option.some(true),
      );
      assert.equal((yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM items`)[0]?.n, 2);
    }).pipe(
      Effect.provide(
        NodeSqliteClient.layer({
          filename: NodePath.join(dir, "state.sqlite"),
          checkpointWorker: true,
        }),
      ),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true }))),
    );
  },
);

it.live(
  "stops a native index build before a foreground write and rebuilds after rollback",
  () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "thread-index-native-"));
    let notifyStarted = () => {};
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE items (id INTEGER PRIMARY KEY)`;
      yield* sql`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i + 1 FROM n WHERE i < 10000)
      INSERT INTO items SELECT i FROM n`;
      const statement = "CREATE INDEX IF NOT EXISTS wide_idx ON items(printf('%05000d', id))";
      const work = yield* NodeSqliteClient.idleIndexBuild(sql, statement, 0).pipe(
        Effect.provideService(NodeSqliteClient.IndexBuildStarted, notifyStarted),
        Effect.forkChild,
      );
      yield* Effect.promise(() => started);
      yield* sql.withTransaction(sql`INSERT INTO items VALUES (10001)`);
      assert.deepEqual(yield* Fiber.join(work), Option.some(false));
      assert.lengthOf(yield* sql`SELECT 1 FROM sqlite_schema WHERE name = 'wide_idx'`, 0);
      assert.deepEqual(
        yield* NodeSqliteClient.idleIndexBuild(sql, statement, 0),
        Option.some(true),
      );
      assert.equal(
        (yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM items INDEXED BY wide_idx`)[0]?.n,
        10001,
      );
    }).pipe(
      Effect.provide(
        NodeSqliteClient.layer({
          filename: NodePath.join(dir, "state.sqlite"),
          checkpointWorker: true,
        }),
      ),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true }))),
    );
  },
  30000,
);
