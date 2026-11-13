import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { AnalyticsError, LONG_TASK_HISTOGRAM_RATIO, type AnalyticsEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as BoardsDatabase from "../persistence/BoardsDatabase.ts";

import * as ServerConfig from "../../config.ts";
import * as Analytics from "./Analytics.ts";
import type { AnalyticsRollup } from "./rollup.ts";

const day = "2026-11-13";
const ts = `${day}T12:00:00.000Z`;
const event = (input: Partial<AnalyticsEvent> = {}): AnalyticsEvent => ({
  ts,
  kind: "client.click",
  surface: "web",
  route: "board",
  ...input,
});

const fixture = Effect.gen(function* () {
  yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(ts)));
  const context = yield* Layer.build(
    ServerConfig.layerTest(".", { prefix: "t3-owner-analytics-" }),
  );
  const config = Context.get(context, ServerConfig.ServerConfig);
  const fs = yield* FileSystem.FileSystem;
  const directory = `${config.logsDir}/analytics`;
  yield* fs.makeDirectory(directory, { recursive: true });
  return { config, fs, directory };
});

function open(
  setup: Effect.Success<typeof fixture>,
  options: Partial<Analytics.AnalyticsOptions> = {},
  fs = setup.fs,
  boards?: BoardsDatabase.BoardsDatabase["Service"],
) {
  return Layer.build(
    Analytics.layerWith(options).pipe(
      Layer.provide(
        boards === undefined ? Layer.empty : Layer.succeed(BoardsDatabase.BoardsDatabase, boards),
      ),
      Layer.provide(Layer.succeed(ServerConfig.ServerConfig, setup.config)),
      Layer.provide(Layer.succeed(FileSystem.FileSystem, fs)),
    ),
  ).pipe(Effect.map((context) => Context.get(context, Analytics.Analytics)));
}

describe("Analytics", () => {
  it.effect("reads filtered tick phase percentiles and persists the complete day", () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      const analytics = yield* open(setup);
      for (const [boardId, durationMs] of [
        ["a", 10],
        ["a", 20],
        ["a", 90],
        ["b", 1_000],
      ] as const)
        yield* analytics.record(
          event({
            kind: "kanban.tick_phase",
            surface: "server",
            route: "kanban",
            boardId,
            durationMs,
            props: { tickId: "tick-1", phase: "thread_status", count: 1 },
          }),
        );
      yield* analytics.record(
        event({
          kind: "kanban.tick_overlap",
          surface: "server",
          route: "kanban",
          boardId: "a",
          props: { tickId: "tick-2", activeTickId: "tick-1", reason: "local_waits_only" },
        }),
      );
      const result = yield* analytics.read({
        day,
        kind: "kanban.tick_phase",
        boardId: "a",
        limit: 1,
      });
      assert.equal(result.rollup.total, 3);
      assert.lengthOf(result.samples, 1);
      assert.deepEqual(result.rollup.tickPhases, [
        {
          boardId: "a",
          phase: "thread_status",
          count: 3,
          p50Ms: 20,
          p95Ms: 90,
          maxMs: 90,
          approximate: false,
        },
      ]);
      const full = JSON.parse(
        yield* setup.fs.readFileString(`${setup.directory}/rollup-${day}.json`),
      ) as AnalyticsRollup;
      assert.equal(full.total, 5);
      assert.equal(full.tickPhases?.length, 2);
      assert.equal(full.kindCounts["kanban.tick_overlap"], 1);
      assert.isFalse(yield* setup.fs.exists(`${setup.directory}/rollup-${day}.json.tmp`));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps a minute summary delivered after midnight in the task's UTC day", () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      const analytics = yield* open(setup);
      yield* TestClock.setTime(
        DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-14T00:00:01.000Z")),
      );
      yield* analytics.ingest({
        events: [
          event({
            ts: "2026-11-13T23:59:00.000Z",
            kind: "performance.long-task-summary",
            surface: "desktop",
            route: "board",
            props: {
              count: 1,
              totalMs: 500,
              maxMs: 500,
              wallTimeMs: 60_000,
              histogram: [[Math.ceil(Math.log(500) / Math.log(LONG_TASK_HISTOGRAM_RATIO)), 1]],
            },
          }),
        ],
      });
      const previous = yield* analytics.read({ day });
      assert.deepInclude(previous.rollup.longTasksByRoute[0], {
        route: "board",
        count: 1,
        totalMs: 500,
        maxMs: 500,
        p95Ms: 500,
        wallTimeShare: 500 / 60_000,
      });
      assert.lengthOf((yield* analytics.read({ day: "2026-11-14" })).rollup.longTasksByRoute, 0);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect(
    "reads the ask split from existing records and filters by board without recording text",
    () =>
      Effect.gen(function* () {
        const setup = yield* fixture;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE ardud_kanban_cards (id TEXT, board_id TEXT, json TEXT)`;
        const ask = {
          id: "q1",
          text: "private question",
          at: `${day}T01:00:00.000Z`,
          blocking: true,
          closedAt: `${day}T03:00:00.000Z`,
          answer: {
            at: `${day}T03:00:00.000Z`,
            by: { _tag: "owner" },
            verdict: "approved",
            text: "private answer",
          },
          timing: {
            kind: "approve",
            notified: { telegram: `${day}T01:10:00.000Z` },
            firstSeen: { web: `${day}T02:00:00.000Z`, mobile: `${day}T02:30:00.000Z` },
          },
        };
        for (const board of ["board-a", "board-b"])
          yield* sql`INSERT INTO ardud_kanban_cards VALUES (${board}, ${board}, ${JSON.stringify({ asks: [ask] })})`;
        const analytics = yield* open(setup, {}, setup.fs, {
          sql,
          ready: Effect.void,
          path: ":memory:",
        });
        yield* analytics.ingest({
          events: [event({ kind: "ask.answered" }), event({ kind: "ask.seen" })],
        });
        const result = yield* analytics.read({ day, boardId: "board-a" });
        assert.equal(result.rollup.askLatency.createdToAnswered.count, 1);
        assert.equal(result.rollup.askLatency.sentToSeen.p50Ms, 50 * 60_000);
        assert.equal(result.rollup.askLatency.seenToAnswered.p50Ms, 60 * 60_000);
        assert.equal(result.rollup.askLatency.source, "stored-asks");
        assert.equal((yield* analytics.read({ day })).rollup.askLatency.createdToAnswered.count, 2);
        assert.lengthOf(result.samples, 0);
        assert.isFalse(JSON.stringify(result).includes("private"));
      }).pipe(Effect.provide(Sqlite.layerMemory.pipe(Layer.provideMerge(NodeServices.layer)))),
  );
  it.effect(
    "filters MCP samples and rollups by tool and outcome while persisting the full day",
    () =>
      Effect.gen(function* () {
        const setup = yield* fixture;
        const analytics = yield* open(setup);
        yield* analytics.record(
          event({
            kind: "mcp.call",
            surface: "server",
            tool: "card_update",
            outcome: "timeout",
            errorPhase: "caller",
            durationMs: 10,
          }),
        );
        yield* analytics.record(
          event({
            kind: "mcp.call",
            surface: "server",
            tool: "card_update",
            outcome: "ok",
            durationMs: 1,
          }),
        );
        yield* analytics.record(
          event({
            kind: "mcp.call",
            surface: "server",
            tool: "card_get",
            outcome: "timeout",
            durationMs: 20,
          }),
        );
        const result = yield* analytics.read({
          day,
          kind: "mcp.call",
          tool: "card_update",
          outcome: "timeout",
        });
        assert.equal(result.rollup.total, 1);
        assert.lengthOf(result.samples, 1);
        assert.deepInclude(result.rollup.mcpCalls[0], {
          tool: "card_update",
          failures: 1,
          failureRate: 1,
        });
        const full = JSON.parse(
          yield* setup.fs.readFileString(`${setup.directory}/rollup-${day}.json`),
        );
        assert.equal(full.total, 3);
        assert.lengthOf(full.mcpCalls, 2);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect("flushes before reads, filters samples, and atomically saves the full rollup", () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      const analytics = yield* open(setup);
      yield* analytics.record(
        event({
          surface: "server",
          kind: "server.rpc",
          durationMs: 50,
          props: { method: "kanban.list" },
        }),
      );
      yield* analytics.ingest({
        events: [event({ boardId: "robob" }), event({ boardId: "orders" })],
      });
      const result = yield* analytics.read({ day, boardId: "robob", limit: 1 });
      assert.lengthOf(result.samples, 1);
      assert.equal(result.samples[0]!.boardId, "robob");
      assert.equal((result.rollup as AnalyticsRollup).total, 1);
      const persisted = JSON.parse(
        yield* setup.fs.readFileString(`${setup.directory}/rollup-${day}.json`),
      );
      assert.equal(persisted.total, 3);
      assert.equal(persisted.topSlowRpcs[0].method, "kanban.list");
      assert.isFalse(yield* setup.fs.exists(`${setup.directory}/rollup-${day}.json.tmp`));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("drains accepted events on scope closure and snapshots mutable caller objects", () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      yield* Effect.gen(function* () {
        const analytics = yield* open(setup);
        const mutable = { ...event(), props: { method: "before" } };
        yield* analytics.ingest({ events: [mutable] });
        mutable.props.method = "after";
        yield* analytics.record(
          event({ kind: "server.error", surface: "server", props: { errorTag: "StorageError" } }),
        );
      }).pipe(Effect.scoped);
      const rows = (yield* setup.fs.readFileString(`${setup.directory}/${day}.ndjson`))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.lengthOf(rows, 2);
      assert.equal(rows[0]!.props.method, "before");
      const rollup = JSON.parse(
        yield* setup.fs.readFileString(`${setup.directory}/rollup-${day}.json`),
      );
      assert.equal(rollup.total, 2);
      assert.deepStrictEqual(rollup.errorCounts, { StorageError: 1 });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rotates at the byte limit and keeps a finite number of newest segments", () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      const events = Array.from({ length: 7 }, (_, index) => event({ kind: `click.${index}` }));
      const lineBytes = new TextEncoder().encode(`${JSON.stringify(events[0])}\n`).byteLength;
      const analytics = yield* open(setup, { maxFileBytes: lineBytes * 2, maxSegmentsPerDay: 2 });
      yield* analytics.ingest({ events });
      const result = yield* analytics.read({ day });
      assert.deepStrictEqual(
        result.samples.map(({ kind }) => kind),
        ["click.6", "click.5", "click.4"],
      );
      assert.equal((result.rollup as AnalyticsRollup).total, 3);
      const logs = (yield* setup.fs.readDirectory(setup.directory)).filter((name) =>
        name.endsWith(".ndjson"),
      );
      assert.deepStrictEqual(logs.toSorted(), [`${day}.1.ndjson`, `${day}.ndjson`]);
      for (const file of logs)
        assert.isAtMost(
          Number((yield* setup.fs.stat(`${setup.directory}/${file}`)).size),
          lineBytes * 2,
        );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("retains exactly the configured UTC days and touches analytics files only", () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      for (const file of [
        "2026-11-10.ndjson",
        "2026-11-10.1.ndjson",
        "rollup-2026-11-10.json",
        "rollup-2026-11-10.json.tmp",
      ]) {
        yield* setup.fs.writeFileString(`${setup.directory}/${file}`, "{}");
      }
      yield* setup.fs.writeFileString(
        `${setup.directory}/2026-11-11.ndjson`,
        `${JSON.stringify(event({ ts: "2026-11-11T00:00:00.000Z" }))}\n`,
      );
      yield* setup.fs.writeFileString(`${setup.directory}/2026-11-10.txt`, "keep");
      yield* setup.fs.writeFileString(`${setup.config.logsDir}/2026-11-10.ndjson`, "keep");
      const analytics = yield* open(setup, { retentionDays: 3 });
      yield* analytics.read({ day });
      assert.deepStrictEqual((yield* setup.fs.readDirectory(setup.directory)).toSorted(), [
        "2026-11-10.txt",
        "2026-11-11.ndjson",
        "rollup-2026-11-11.json",
      ]);
      assert.equal(
        yield* setup.fs.readFileString(`${setup.config.logsDir}/2026-11-10.ndjson`),
        "keep",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "rejects old, future, malformed and server-supplied client timestamps without accepting part of a batch",
    () =>
      Effect.gen(function* () {
        const setup = yield* fixture;
        const analytics = yield* open(setup);
        for (const invalid of [
          event({ ts: "2026-10-14T23:59:59.999Z" }),
          event({ ts: "2026-11-13T12:05:00.001Z" }),
          event({ ts: "2026-11-14T00:00:00.000Z" }),
          event({ ts: "yesterday" }),
          event({ surface: "server" }),
        ]) {
          const error = yield* analytics.ingest({ events: [event(), invalid] }).pipe(Effect.flip);
          assert.instanceOf(error, AnalyticsError);
          assert.equal(error.operation, "ingest");
        }
        yield* analytics.record(event({ ts: "invalid", surface: "server" }));
        assert.lengthOf((yield* analytics.read({ day })).samples, 0);
        yield* analytics.ingest({ events: [event({ ts: "2026-10-15T00:00:00.000Z" })] });
        assert.lengthOf((yield* analytics.read({ day: "2026-10-15" })).samples, 1);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("caps event bytes, total encoded batch bytes, and batch count", () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      const lineBytes = new TextEncoder().encode(`${JSON.stringify(event())}\n`).byteLength;
      const analytics = yield* open(setup, { maxEventBytes: 512, maxBatchBytes: lineBytes });
      for (const events of [
        [event(), event()],
        [event({ threadId: "x".repeat(512) })],
        Array.from({ length: 101 }, () => event()),
        [],
      ]) {
        assert.equal((yield* analytics.ingest({ events }).pipe(Effect.flip)).operation, "ingest");
      }
      assert.lengthOf((yield* analytics.read({ day })).samples, 0);
      yield* analytics.ingest({ events: [event()] });
      assert.lengthOf((yield* analytics.read({ day })).samples, 1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects free-form payloads, query strings, and invalid measurements", () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      const analytics = yield* open(setup);
      const badInputs = [
        { ...event(), text: "private message" },
        { ...event(), props: { method: "read", payload: "private prompt" } },
        event({ route: "/board?token=private" }),
        event({ props: { reason: "free form contents" } }),
        event({ durationMs: Infinity }),
        event({ props: { bytes: -1 } }),
      ];
      for (const raw of badInputs) {
        const error = yield* analytics
          .ingest({ events: [raw as AnalyticsEvent] })
          .pipe(Effect.flip);
        assert.equal(error.operation, "ingest");
      }
      const result = yield* analytics.read({ day });
      assert.equal((result.rollup as AnalyticsRollup).total, 0);
      assert.isFalse(yield* setup.fs.exists(`${setup.directory}/${day}.ndjson`));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "records without backpressure while disk is blocked, and rejects a full ingest queue",
    () =>
      Effect.gen(function* () {
        const setup = yield* fixture;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const blocked = FileSystem.FileSystem.of({
          ...setup.fs,
          writeFileString: (file, data, options) =>
            file.endsWith(".ndjson")
              ? Effect.gen(function* () {
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(release);
                  yield* setup.fs.writeFileString(file, data, options);
                })
              : setup.fs.writeFileString(file, data, options),
        });
        const analytics = yield* open(setup, { queueCapacity: 2 }, blocked);
        yield* Effect.gen(function* () {
          yield* analytics.record(event({ kind: "first" }));
          yield* Deferred.await(entered);
          yield* analytics.record(event({ kind: "second" }));
          yield* analytics.record(event({ kind: "dropped" }));
          assert.equal(
            (yield* analytics.ingest({ events: [event()] }).pipe(Effect.flip)).operation,
            "ingest",
          );
        }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
        assert.deepStrictEqual(
          (yield* analytics.read({ day })).samples.map(({ kind }) => kind),
          ["second", "first"],
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "streams damaged logs in bounded chunks and continues after invalid or oversized lines",
    () =>
      Effect.gen(function* () {
        const setup = yield* fixture;
        yield* setup.fs.writeFileString(
          `${setup.directory}/${day}.ndjson`,
          [
            "not-json",
            "x".repeat(100_000),
            JSON.stringify(event({ kind: "one" })),
            JSON.stringify(event({ kind: "two" })),
            '{"truncated":',
          ].join("\n"),
        );
        let chunks = 0;
        const streaming = FileSystem.FileSystem.of({
          ...setup.fs,
          readFileString: (file, encoding) => {
            assert.isFalse(file.endsWith(".ndjson"));
            return setup.fs.readFileString(file, encoding);
          },
          stream: (file, options) =>
            setup.fs.stream(file, options).pipe(
              Stream.tap(() =>
                Effect.sync(() => {
                  chunks++;
                }),
              ),
            ),
        });
        const analytics = yield* open(setup, {}, streaming);
        const result = yield* analytics.read({ day, limit: 1 });
        assert.isAbove(chunks, 1);
        assert.equal((result.rollup as AnalyticsRollup).total, 2);
        assert.equal((result.rollup as AnalyticsRollup).invalidLines, 3);
        assert.deepStrictEqual(
          result.samples.map(({ kind }) => kind),
          ["two"],
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves the last rollup if replacement fails and reports typed read errors", () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      let failRename = false;
      const fs = FileSystem.FileSystem.of({
        ...setup.fs,
        rename: (source, target) =>
          failRename && target.endsWith(".json")
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "rename",
                  pathOrDescriptor: target,
                }),
              )
            : setup.fs.rename(source, target),
      });
      const analytics = yield* open(setup, {}, fs);
      yield* analytics.ingest({ events: [event()] });
      yield* analytics.read({ day });
      const original = yield* setup.fs.readFileString(`${setup.directory}/rollup-${day}.json`);
      yield* analytics.ingest({ events: [event()] });
      failRename = true;
      assert.equal((yield* analytics.read({ day }).pipe(Effect.flip)).operation, "read");
      assert.equal(
        yield* setup.fs.readFileString(`${setup.directory}/rollup-${day}.json`),
        original,
      );
      assert.equal(
        (yield* analytics.read({ day: "../../outside" }).pipe(Effect.flip)).operation,
        "read",
      );
      assert.equal(
        (yield* analytics.read({ day: "2026-02-30" }).pipe(Effect.flip)).operation,
        "read",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("builds the previous day's rollup on the daily maintenance tick", () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(`${day}T23:30:00.000Z`)));
      const written = yield* Deferred.make<void>();
      const rolled = yield* Deferred.make<void>();
      const fs = FileSystem.FileSystem.of({
        ...setup.fs,
        writeFileString: (file, data, options) =>
          setup.fs
            .writeFileString(file, data, options)
            .pipe(
              Effect.tap(() =>
                file.endsWith(".ndjson") ? Deferred.succeed(written, undefined) : Effect.void,
              ),
            ),
        rename: (source, target) =>
          setup.fs
            .rename(source, target)
            .pipe(
              Effect.tap(() =>
                target.endsWith(`rollup-${day}.json`)
                  ? Deferred.succeed(rolled, undefined)
                  : Effect.void,
              ),
            ),
      });
      const analytics = yield* open(setup, {}, fs);
      yield* analytics.record(event());
      yield* Deferred.await(written);
      yield* TestClock.adjust("1 hour");
      yield* Deferred.await(rolled);
      assert.equal(
        JSON.parse(yield* setup.fs.readFileString(`${setup.directory}/rollup-${day}.json`)).total,
        1,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
