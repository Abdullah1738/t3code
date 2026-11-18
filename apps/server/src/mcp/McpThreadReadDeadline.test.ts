import { expect, it } from "@effect/vitest";
import { AnalyticsEvent, EnvironmentId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";
import * as Analytics from "../ardud/analytics/Analytics.ts";
import * as ThreadReadMetrics from "../ardud/analytics/ThreadReadMetrics.ts";
import * as ReplyBuilders from "../ardud/http/ReplyBuilders.ts";
import * as McpDeadline from "./McpDeadline.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import { ThreadReadTimeoutError } from "./ThreadReadDeadline.ts";

const decodeTimeout = Schema.decodeUnknownSync(ThreadReadTimeoutError);
const isAnalyticsEvent = Schema.is(AnalyticsEvent);

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "read-deadline-test", version: "1" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "read-deadline-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const callRead = Effect.gen(function* () {
  const server = yield* McpServer.McpServer;
  return yield* server.callTool({ name: "t3_thread_read", arguments: {} });
}).pipe(
  Effect.provideService(McpSchema.McpServerClient, client),
  Effect.provideService(McpInvocationContext.McpInvocationContext, {
    environmentId: EnvironmentId.make("read-deadline-test"),
    requestNamespace: "read-deadline-test",
    thread: undefined,
    client: undefined,
    capabilities: new Set<never>(),
    issuedAt: 0,
  }),
);
const toolkit = Toolkit.make(
  Tool.make("t3_thread_read", {
    description: "Synthetic thread read.",
    success: Schema.Struct({ ready: Schema.Boolean }),
  }),
);
const readLayer = (handler: Effect.Effect<{ ready: boolean }>, rows: Queue.Queue<AnalyticsEvent>) =>
  McpHttpServer.toolkitRegistration(
    toolkit,
    McpToolAccess.toLayer(toolkit, {
      t3_thread_read: McpToolAccess.reads(() => handler),
    }),
  ).pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(ReplyBuilders.layer),
    Layer.provide(
      Layer.mock(Analytics.Analytics)({
        record: (row) =>
          row.kind === "mcp.call" ? Queue.offer(rows, row).pipe(Effect.asVoid) : Effect.void,
      }),
    ),
  );

it.effect.each(["query", "render"] as const)(
  "times out a stuck %s with a typed reply and analytics row",
  (phase) =>
    Effect.gen(function* () {
      const rows = yield* Queue.unbounded<AnalyticsEvent>();
      const entered = yield* Deferred.make<void>();
      const never = yield* Deferred.make<{ ready: boolean }>();
      const cancelled = yield* Deferred.make<void>();
      const reader = yield* Semaphore.make(1);
      const handler = reader
        .withPermits(1)(
          (phase === "render" ? ThreadReadMetrics.enterPhase("render") : Effect.void).pipe(
            Effect.andThen(Deferred.succeed(entered, undefined)),
            Effect.andThen(Deferred.await(never)),
          ),
        )
        .pipe(Effect.ensuring(Deferred.succeed(cancelled, undefined)));
      yield* Effect.gen(function* () {
        const pending = yield* callRead.pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* TestClock.adjust(McpDeadline.READ_TIMEOUT);
        const result = yield* Fiber.join(pending);
        expect(result.isError).toBe(true);
        const content = result.structuredContent;
        expect(content).toMatchObject({
          _tag: "ThreadReadTimeoutError",
          phase,
          phaseMs: {
            lane_wait: 0,
            query: phase === "query" ? 45000 : 0,
            render: phase === "render" ? 45000 : 0,
          },
        });
        expect(decodeTimeout(content).message).toContain(`during ${phase}`);
        expect(JSON.stringify(content)).toContain(
          "Read-only, nothing changed; retry with a smaller limit",
        );
        expect(JSON.stringify(content)).toContain("task_status");
        const row = yield* Queue.take(rows);
        expect(row).toMatchObject({
          tool: "t3_thread_read",
          outcome: "timeout",
          errorTag: "ThreadReadTimeoutError",
          errorPhase: phase,
          durationMs: 45000,
        });
        // Schema validation catches a phase that analytics would silently discard.
        expect(isAnalyticsEvent(row)).toBe(true);
        yield* Deferred.await(cancelled);
        expect(yield* reader.takeIfAvailable(1)).toBe(true);
        yield* reader.release(1);
        const builders = yield* ReplyBuilders.ReplyBuilders;
        expect(yield* builders.mcp.takeIfAvailable(ReplyBuilders.PERMITS.mcp)).toBe(true);
        yield* builders.mcp.release(ReplyBuilders.PERMITS.mcp);
      }).pipe(Effect.provide(readLayer(handler, rows)));
    }),
);

it.effect("a fifth large read times out in lane_wait without stealing or leaking a permit", () =>
  Effect.gen(function* () {
    const rows = yield* Queue.unbounded<AnalyticsEvent>();
    const held = yield* Deferred.make<void>();
    const releases = yield* Effect.forEach(Array.from({ length: ReplyBuilders.PERMITS.mcp }), () =>
      Deferred.make<void>(),
    );
    let admitted = 0;
    let readCalls = 0;
    yield* Effect.gen(function* () {
      const holders = yield* Effect.forEach(releases, (release) =>
        ReplyBuilders.bounded(
          Effect.gen(function* () {
            admitted++;
            if (admitted === ReplyBuilders.PERMITS.mcp) yield* Deferred.succeed(held, undefined);
            yield* Deferred.await(release);
            return "finished";
          }),
          "mcp",
        ).pipe(Effect.forkChild),
      );
      yield* Deferred.await(held);
      const fifth = yield* callRead.pipe(Effect.forkChild);
      yield* TestClock.adjust(McpDeadline.READ_TIMEOUT);
      expect((yield* Fiber.join(fifth)).structuredContent).toMatchObject({
        _tag: "ThreadReadTimeoutError",
        phase: "lane_wait",
        phaseMs: { lane_wait: 45000, query: 0, render: 0 },
      });
      expect(readCalls).toBe(0);
      expect(yield* Queue.take(rows)).toMatchObject({
        outcome: "timeout",
        errorPhase: "lane_wait",
      });
      yield* Deferred.succeed(releases[0]!, undefined);
      expect(yield* Fiber.join(holders[0]!)).toBe("finished");
      expect((yield* callRead).structuredContent).toEqual({ ready: true });
      expect(readCalls).toBe(1);
      for (let index = 1; index < holders.length; index++) {
        yield* Deferred.succeed(releases[index]!, undefined);
        expect(yield* Fiber.join(holders[index]!)).toBe("finished");
      }
      const builders = yield* ReplyBuilders.ReplyBuilders;
      expect(yield* builders.mcp.takeIfAvailable(ReplyBuilders.PERMITS.mcp)).toBe(true);
      yield* builders.mcp.release(ReplyBuilders.PERMITS.mcp);
    }).pipe(
      Effect.provide(
        readLayer(
          Effect.sync(() => {
            readCalls++;
            return { ready: true };
          }),
          rows,
        ),
      ),
    );
  }),
);

it.effect("uses one budget across admission, query and render", () =>
  Effect.gen(function* () {
    const rows = yield* Queue.unbounded<AnalyticsEvent>();
    const queryEntered = yield* Deferred.make<void>();
    const renderEntered = yield* Deferred.make<void>();
    const render = yield* Deferred.make<void>();
    const never = yield* Deferred.make<{ ready: boolean }>();
    const handler = Deferred.succeed(queryEntered, undefined).pipe(
      Effect.andThen(Deferred.await(render)),
      Effect.andThen(ThreadReadMetrics.enterPhase("render")),
      Effect.andThen(Deferred.succeed(renderEntered, undefined)),
      Effect.andThen(Deferred.await(never)),
    );
    yield* Effect.gen(function* () {
      const builders = yield* ReplyBuilders.ReplyBuilders;
      yield* builders.mcp.take(ReplyBuilders.PERMITS.mcp);
      const pending = yield* callRead.pipe(Effect.forkChild);
      yield* TestClock.adjust("15 seconds");
      yield* builders.mcp.release(ReplyBuilders.PERMITS.mcp);
      yield* Deferred.await(queryEntered);
      yield* TestClock.adjust("20 seconds");
      yield* Deferred.succeed(render, undefined);
      yield* Deferred.await(renderEntered);
      yield* TestClock.adjust("10 seconds");
      expect((yield* Fiber.join(pending)).structuredContent).toMatchObject({
        phase: "render",
        phaseMs: { lane_wait: 15000, query: 20000, render: 10000 },
      });
    }).pipe(Effect.provide(readLayer(handler, rows)));
  }),
);

it.effect.each([
  { operation: "transaction", mask: "inside" },
  { operation: "transaction", mask: "outside" },
  { operation: "statement", mask: "inside" },
  { operation: "statement", mask: "outside" },
] as const)(
  "preserves an explicit mask $mask readOnly while $operation waits for the snapshot gate",
  ({ operation, mask }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "thread-read-masked-" });
      const rows = yield* Queue.unbounded<AnalyticsEvent>();
      const gate = yield* Semaphore.make(1);
      const gateHeld = yield* Deferred.make<void>();
      const openGate = yield* Deferred.make<void>();
      const waiting = yield* Deferred.make<void>();
      const cleaned = yield* Deferred.make<void>();
      const readFinished = yield* Deferred.make<void>();
      const readerSnapshotLock = {
        ...gate,
        withPermits:
          (permits: number) =>
          <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            Deferred.succeed(waiting, undefined).pipe(
              Effect.andThen(gate.withPermits(permits)(effect)),
            ),
      };
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA journal_mode = WAL`;
        yield* sql`CREATE TABLE ardud_turn_items (value INTEGER)`;
        const holder = yield* gate
          .withPermits(1)(
            Deferred.succeed(gateHeld, undefined).pipe(Effect.andThen(Deferred.await(openGate))),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(gateHeld);
        const query = sql`SELECT * FROM ardud_turn_items`;
        const read = (operation === "transaction" ? sql.withTransaction(query) : query).pipe(
          Effect.andThen(Deferred.succeed(readFinished, undefined)),
        );
        const handler = (
          mask === "inside"
            ? read.pipe(Effect.uninterruptible, NodeSqliteClient.requireReader)
            : read.pipe(NodeSqliteClient.requireReader, Effect.uninterruptible)
        ).pipe(
          NodeSqliteClient.foregroundReads,
          Effect.orDie,
          Effect.as({ ready: true }),
          Effect.ensuring(Deferred.succeed(cleaned, undefined)),
        );
        yield* Effect.gen(function* () {
          const pending = yield* callRead.pipe(Effect.forkChild);
          yield* Deferred.await(waiting);
          yield* TestClock.adjust(McpDeadline.READ_TIMEOUT);
          expect((yield* Fiber.join(pending)).isError).toBe(true);
          expect(yield* Deferred.isDone(readFinished)).toBe(false);
          yield* Deferred.succeed(openGate, undefined);
          yield* Deferred.await(cleaned);
          expect(yield* Deferred.isDone(readFinished)).toBe(true);
          yield* sql`SELECT 1`.pipe(
            NodeSqliteClient.requireReader,
            NodeSqliteClient.foregroundReads,
          );
        }).pipe(
          Effect.provide(readLayer(handler, rows)),
          Effect.ensuring(Deferred.succeed(openGate, undefined)),
        );
        yield* Fiber.join(holder);
      }).pipe(
        Effect.provide(
          NodeSqliteClient.layer({
            filename: path.join(directory, "test.sqlite"),
            readerWorker: true,
            foregroundReaderSlots: 1,
            readerSnapshotSql: ["SELECT rootpage FROM main.sqlite_schema LIMIT 1"],
            readerSnapshotLock,
          }),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each(["deadline", "disconnect"] as const)(
  "releases admission on %s even when handler cleanup is masked",
  (exit) =>
    Effect.gen(function* () {
      const rows = yield* Queue.unbounded<AnalyticsEvent>();
      const entered = yield* Deferred.make<void>();
      const cleanupEntered = yield* Deferred.make<void>();
      const releaseCleanup = yield* Deferred.make<void>();
      const cleanupDone = yield* Deferred.make<void>();
      const never = yield* Deferred.make<{ ready: boolean }>();
      const handler = Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(never)),
        Effect.ensuring(
          Deferred.succeed(cleanupEntered, undefined).pipe(
            Effect.andThen(Deferred.await(releaseCleanup)),
            Effect.andThen(Deferred.succeed(cleanupDone, undefined)),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const pending = yield* callRead.pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        if (exit === "deadline") {
          yield* TestClock.adjust(McpDeadline.READ_TIMEOUT);
          expect((yield* Fiber.join(pending)).isError).toBe(true);
        } else yield* Fiber.interrupt(pending);
        yield* Deferred.await(cleanupEntered);
        const builders = yield* ReplyBuilders.ReplyBuilders;
        expect(yield* builders.mcp.takeIfAvailable(ReplyBuilders.PERMITS.mcp)).toBe(true);
        yield* builders.mcp.release(ReplyBuilders.PERMITS.mcp);
        yield* Deferred.succeed(releaseCleanup, undefined);
        yield* Deferred.await(cleanupDone);
      }).pipe(Effect.provide(readLayer(handler, rows)));
    }),
);

it.effect("cancels a SQLite foreground transaction and makes its reader slot reusable", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "thread-read-deadline-" });
    const rows = yield* Queue.unbounded<AnalyticsEvent>();
    const entered = yield* Deferred.make<void>();
    const cleaned = yield* Deferred.make<void>();
    const never = yield* Deferred.make<{ ready: boolean }>();
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`CREATE TABLE entries (value INTEGER)`;
      let calls = 0;
      const handler = Effect.suspend(() => {
        calls++;
        return calls === 1
          ? sql
              .withTransaction(
                sql`SELECT * FROM entries`.pipe(
                  Effect.andThen(Deferred.succeed(entered, undefined)),
                  Effect.andThen(Deferred.await(never)),
                ),
              )
              .pipe(Effect.ensuring(Deferred.succeed(cleaned, undefined)))
          : sql`SELECT * FROM entries`.pipe(Effect.as({ ready: true }));
      }).pipe(NodeSqliteClient.readOnly, NodeSqliteClient.foregroundReads, Effect.orDie);
      yield* Effect.gen(function* () {
        const pending = yield* callRead.pipe(Effect.forkChild);
        yield* Deferred.await(entered).pipe(
          Effect.raceFirst(
            Fiber.join(pending).pipe(
              Effect.flatMap((result) => Effect.die(new Error(JSON.stringify(result)))),
            ),
          ),
        );
        yield* TestClock.adjust(McpDeadline.READ_TIMEOUT);
        expect((yield* Fiber.join(pending)).structuredContent).toMatchObject({ phase: "query" });
        yield* Deferred.await(cleaned);
        expect((yield* callRead).structuredContent).toEqual({ ready: true });
      }).pipe(Effect.provide(readLayer(handler, rows)));
    }).pipe(
      Effect.provide(
        NodeSqliteClient.layer({
          filename: path.join(directory, "test.sqlite"),
          readerWorker: true,
          foregroundReaderSlots: 1,
        }),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each([
  { operation: "transaction", stop: "deadline" },
  { operation: "transaction", stop: "disconnect" },
  { operation: "statement", stop: "deadline" },
  { operation: "statement", stop: "disconnect" },
] as const)(
  "reuses the foreground reader before opening the snapshot gate after $operation $stop",
  ({ operation, stop }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "thread-read-snapshot-" });
      const rows = yield* Queue.unbounded<AnalyticsEvent>();
      const gate = yield* Semaphore.make(1);
      const gateHeld = yield* Deferred.make<void>();
      const openGate = yield* Deferred.make<void>();
      const waiting = yield* Deferred.make<void>();
      const cleaned = yield* Deferred.make<void>();
      const readFinished = yield* Deferred.make<void>();
      const readerSnapshotLock = {
        ...gate,
        withPermits:
          (permits: number) =>
          <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            Deferred.succeed(waiting, undefined).pipe(
              Effect.andThen(gate.withPermits(permits)(effect)),
            ),
      };
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA journal_mode = WAL`;
        yield* sql`CREATE TABLE ardud_turn_items (value INTEGER)`;
        const holder = yield* gate
          .withPermits(1)(
            Deferred.succeed(gateHeld, undefined).pipe(Effect.andThen(Deferred.await(openGate))),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(gateHeld);
        let calls = 0;
        const handler = Effect.suspend(() => {
          if (++calls !== 1) return sql`SELECT 1`.pipe(Effect.as({ ready: true }));
          const query = sql`SELECT * FROM ardud_turn_items`;
          return (operation === "transaction" ? sql.withTransaction(query) : query).pipe(
            Effect.andThen(Deferred.succeed(readFinished, undefined)),
            Effect.as({ ready: true }),
            Effect.ensuring(Deferred.succeed(cleaned, undefined)),
          );
        }).pipe(NodeSqliteClient.requireReader, NodeSqliteClient.foregroundReads, Effect.orDie);
        yield* Effect.gen(function* () {
          const pending = yield* callRead.pipe(Effect.forkChild);
          yield* Deferred.await(waiting);
          if (stop === "deadline") {
            yield* TestClock.adjust(McpDeadline.READ_TIMEOUT);
            expect((yield* Fiber.join(pending)).structuredContent).toMatchObject({
              _tag: "ThreadReadTimeoutError",
              phase: "query",
            });
          } else yield* Fiber.interrupt(pending);
          yield* Deferred.await(cleaned);
          expect(yield* Deferred.isDone(openGate)).toBe(false);
          expect(yield* Deferred.isDone(readFinished)).toBe(false);
          expect((yield* callRead).structuredContent).toEqual({ ready: true });
          expect(yield* gate.takeIfAvailable(1)).toBe(false);
        }).pipe(
          Effect.provide(readLayer(handler, rows)),
          Effect.ensuring(Deferred.succeed(openGate, undefined)),
        );
        yield* Fiber.join(holder);
      }).pipe(
        Effect.provide(
          NodeSqliteClient.layer({
            filename: path.join(directory, "test.sqlite"),
            readerWorker: true,
            foregroundReaderSlots: 1,
            readerSnapshotSql: ["SELECT rootpage FROM main.sqlite_schema LIMIT 1"],
            readerSnapshotLock,
          }),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each(["deadline", "disconnect"] as const)(
  "restores snapshot protection after cancellation during admitted BEGIN on %s",
  (stop) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "thread-read-pinned-" });
      const rows = yield* Queue.unbounded<AnalyticsEvent>();
      const gate = yield* Semaphore.make(1);
      const pinned = yield* Deferred.make<void>();
      const finishSetup = yield* Deferred.make<void>();
      const cleaned = yield* Deferred.make<void>();
      const waiting = yield* Deferred.make<void>();
      let snapshots = 0;
      const readerSnapshotLock = {
        ...gate,
        withPermits:
          (permits: number) =>
          <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            Effect.suspend(() => {
              const first = ++snapshots === 1;
              return (first ? Effect.void : Deferred.succeed(waiting, undefined)).pipe(
                Effect.andThen(
                  gate.withPermits(permits)(
                    effect.pipe(
                      Effect.tap(() =>
                        first
                          ? Deferred.succeed(pinned, undefined).pipe(
                              Effect.andThen(Deferred.await(finishSetup)),
                            )
                          : Effect.void,
                      ),
                      Effect.uninterruptible,
                    ),
                  ),
                ),
              );
            }),
      };
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA journal_mode = WAL`;
        yield* sql`CREATE TABLE ardud_turn_items (value INTEGER)`;
        let calls = 0;
        const handler = Effect.suspend(() => {
          const query = sql`SELECT * FROM ardud_turn_items`;
          return (
            ++calls === 1
              ? sql
                  .withTransaction(query)
                  .pipe(Effect.ensuring(Deferred.succeed(cleaned, undefined)))
              : query
          ).pipe(Effect.as({ ready: true }));
        }).pipe(NodeSqliteClient.requireReader, NodeSqliteClient.foregroundReads, Effect.orDie);
        yield* Effect.gen(function* () {
          const pending = yield* callRead.pipe(Effect.forkChild);
          yield* Deferred.await(pinned);
          if (stop === "deadline") {
            yield* TestClock.adjust(McpDeadline.READ_TIMEOUT);
            expect((yield* Fiber.join(pending)).isError).toBe(true);
          } else yield* Fiber.interrupt(pending);
          yield* Deferred.succeed(finishSetup, undefined);
          yield* Deferred.await(cleaned);
          const next = yield* gate.withPermits(1)(
            Effect.gen(function* () {
              const next = yield* callRead.pipe(Effect.forkChild);
              yield* Deferred.await(waiting).pipe(
                Effect.raceFirst(
                  Fiber.join(next).pipe(
                    Effect.flatMap(() => Effect.die(new Error("Read bypassed the snapshot gate"))),
                  ),
                ),
              );
              expect(next.pollUnsafe()).toBeUndefined();
              return next;
            }),
          );
          expect((yield* Fiber.join(next)).structuredContent).toEqual({ ready: true });
        }).pipe(
          Effect.provide(readLayer(handler, rows)),
          Effect.ensuring(Deferred.succeed(finishSetup, undefined)),
        );
      }).pipe(
        Effect.provide(
          NodeSqliteClient.layer({
            filename: path.join(directory, "test.sqlite"),
            readerWorker: true,
            foregroundReaderSlots: 1,
            readerSnapshotSql: ["SELECT rootpage FROM main.sqlite_schema LIMIT 1"],
            readerSnapshotLock,
          }),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each(["during commit", "after commit"] as const)(
  "reports a delegated result acknowledgement timeout %s without promising nothing changed",
  (when) =>
    Effect.gen(function* () {
      const rows = yield* Queue.unbounded<AnalyticsEvent>();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const committed = yield* Deferred.make<void>();
      const acknowledged = yield* Deferred.make<void>();
      const never = yield* Deferred.make<{ ready: boolean }>();
      const commit = Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.andThen(Deferred.succeed(committed, undefined)),
        Effect.uninterruptible,
      );
      const handler = ThreadReadMetrics.acknowledge(commit).pipe(
        Effect.andThen(Deferred.succeed(acknowledged, undefined)),
        Effect.andThen(Deferred.await(never)),
      );
      yield* Effect.gen(function* () {
        const pending = yield* callRead.pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        if (when === "after commit") {
          yield* Deferred.succeed(release, undefined);
          yield* Deferred.await(acknowledged);
        }
        yield* TestClock.adjust(McpDeadline.READ_TIMEOUT);
        const result = yield* Fiber.join(pending);
        expect(result.structuredContent).toMatchObject({
          _tag: "ThreadReadTimeoutError",
          phase: "query",
          acknowledgement: when === "during commit" ? "may_have_completed" : "completed",
          saved: when === "during commit" ? "unknown" : true,
        });
        expect(JSON.stringify(result)).not.toContain("nothing changed");
        expect(JSON.stringify(result)).toContain("Retry this read to recover the result");
        expect(yield* Queue.take(rows)).toMatchObject({ outcome: "timeout", errorPhase: "query" });
        if (when === "during commit") {
          expect(yield* Deferred.isDone(committed)).toBe(false);
          yield* Deferred.succeed(release, undefined);
        }
        yield* Deferred.await(committed);
      }).pipe(Effect.provide(readLayer(handler, rows)));
    }),
);
