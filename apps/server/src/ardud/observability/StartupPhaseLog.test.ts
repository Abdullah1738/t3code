// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as StartupPhaseLog from "./StartupPhaseLog.ts";

const readRecords = (dir: string) =>
  NodeFS.readFileSync(NodePath.join(dir, "boot.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

it("includes the preceding desktop quit once in the next boot, not again on a backend restart", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "boot-quit-context-"));
  try {
    const at = Date.parse("2026-11-17T00:00:00Z");
    const old = StartupPhaseLog.makeStartupPhaseLog(dir, "old");
    old.start("boot", at - 2000);
    NodeFS.writeFileSync(
      NodePath.join(dir, "desktop-last-quit.json"),
      JSON.stringify({
        at: "2026-11-16T23:59:59.000Z",
        pid: 42,
        trigger: "before-quit",
        initiator: "installer",
        restartReason: "release .13",
        osShutdownInProgress: false,
      }),
    );
    const next = StartupPhaseLog.makeStartupPhaseLog(dir, "next");
    next.start("boot", at);
    next.start("boot", at + 1);
    const boots = readRecords(dir).filter((row) => row.bootId === "next");
    assert.deepInclude(boots[0]?.previousQuit, {
      pid: 42,
      initiator: "installer",
      restartReason: "release .13",
    });
    assert.notProperty(boots[1], "previousQuit");
    StartupPhaseLog.makeStartupPhaseLog(dir, "backend-restart").start("boot", at + 2000);
    assert.isNull(readRecords(dir).at(-1)?.previousQuit);
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

it.effect("records start, success and failure without error text", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "startup-log-"));
  return Effect.gen(function* () {
    const layer = Layer.succeed(
      StartupPhaseLog.StartupPhaseLog,
      StartupPhaseLog.makeStartupPhaseLog(dir),
    );
    yield* StartupPhaseLog.withStartupPhase("sqlite.open", Effect.succeed(42)).pipe(
      Effect.provide(layer),
    );
    const failed = yield* StartupPhaseLog.withStartupPhase(
      "sqlite.migrations",
      Effect.fail("secret SQL settings environment"),
    ).pipe(Effect.provide(layer), Effect.flip);
    assert.equal(failed, "secret SQL settings environment");
    const records = readRecords(dir);
    assert.deepEqual(
      records.map(({ phase, outcome }) => [phase, outcome]),
      [
        ["sqlite.open", "start"],
        ["sqlite.open", "success"],
        ["sqlite.migrations", "start"],
        ["sqlite.migrations", "failure"],
      ],
    );
    assert.isString(records[0]?.bootId);
    assert.equal(records[0]?.bootId, records[3]?.bootId);
    assert.equal(records[0]?.pid, process.pid);
    assert.notInclude(JSON.stringify(records), "secret");
    assert.notInclude(JSON.stringify(records), "settings environment");
  }).pipe(Effect.ensuring(Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true }))));
});

it.effect("records interruption and monotonic duration", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "startup-log-"));
  return Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const fiber = yield* StartupPhaseLog.withStartupPhase(
      "http.wait",
      Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
    ).pipe(Effect.provide(StartupPhaseLog.layer(dir)), Effect.forkChild);
    yield* Deferred.await(entered);
    yield* TestClock.adjust("3 seconds");
    yield* Fiber.interrupt(fiber);
    const records = readRecords(dir);
    assert.equal(records[1]?.outcome, "interrupted");
    assert.equal(records[1]?.durationMs, 3000);
  }).pipe(Effect.ensuring(Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true }))));
});

it.effect("retains the last twenty boots including incomplete and failed boots", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "startup-log-"));
  return Effect.sync(() => {
    for (let boot = 0; boot < 25; boot++) {
      const logger = StartupPhaseLog.makeStartupPhaseLog(dir, `boot-${boot}`);
      logger.start("sqlite.migrations", boot);
      if (boot % 2 === 0) logger.end("sqlite.migrations", boot + 1, 1, "failure");
    }
    const records = readRecords(dir);
    assert.deepEqual(
      [...new Set(records.map((record) => record.bootId))],
      Array.from({ length: 20 }, (_, index) => `boot-${index + 5}`),
    );
    assert.equal(records.at(-1)?.outcome, "failure");
    assert.deepEqual(NodeFS.readdirSync(dir), ["boot.ndjson"]);
    assert.equal(NodeFS.statSync(NodePath.join(dir, "boot.ndjson")).mode & 0o777, 0o600);
  }).pipe(Effect.ensuring(Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true }))));
});

it.effect("ignores filesystem and logger failures", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "startup-log-"));
  const notDir = NodePath.join(dir, "file");
  NodeFS.writeFileSync(notDir, "not a directory");
  return Effect.gen(function* () {
    assert.equal(
      yield* StartupPhaseLog.withStartupPhase("sqlite.open", Effect.succeed(1)).pipe(
        Effect.provide(StartupPhaseLog.layer(notDir)),
      ),
      1,
    );
    assert.equal(
      yield* StartupPhaseLog.withStartupPhase("sqlite.open", Effect.succeed(2)).pipe(
        Effect.provideService(StartupPhaseLog.StartupPhaseLog, {
          start: () => {
            throw new Error("start failed");
          },
          end: () => {
            throw new Error("end failed");
          },
          snapshot: () => ({
            bootId: "unused",
            pid: 0,
            phases: [],
            droppedRecords: 0,
            persistenceFailed: true,
          }),
        }),
      ),
      2,
    );
  }).pipe(Effect.ensuring(Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true }))));
});

it.effect("exposes unfinished phases and matches overlapping instances by id", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "startup-log-"));
  return Effect.sync(() => {
    const log = StartupPhaseLog.makeStartupPhaseLog(dir);
    const first = log.start("sqlite.open", 0);
    const second = log.start("sqlite.open", 1000);
    const pending = log.snapshot();
    log.end("sqlite.open", 2000, 2000, "success", undefined, first);
    log.end("sqlite.open", 3000, 2000, "failure", undefined, second);
    assert.deepEqual(
      pending.phases.map((phase) => phase.outcome),
      ["running", "running"],
    );
    assert.deepEqual(
      log
        .snapshot()
        .phases.map((phase) => [phase.startedAt, phase.endedAt, phase.durationMs, phase.outcome]),
      [
        ["1970-01-01T00:00:00.000Z", "1970-01-01T00:00:02.000Z", 2000, "success"],
        ["1970-01-01T00:00:01.000Z", "1970-01-01T00:00:03.000Z", 2000, "failure"],
      ],
    );
  }).pipe(Effect.ensuring(Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true }))));
});

it.effect("bounds boot bytes and memory, and recovers from a truncated append", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "startup-log-"));
  return Effect.sync(() => {
    const log = StartupPhaseLog.makeStartupPhaseLog(dir, "older");
    for (let index = 0; index < 2000; index++) {
      log.start("orchestration-v2.legacy-v1.import-shells", index);
      log.end("orchestration-v2.legacy-v1.import-shells", index + 1, 1, "success");
    }
    assert.isAtMost(log.snapshot().phases.length, 512);
    assert.isAbove(log.snapshot().droppedRecords, 0);
    const file = NodePath.join(dir, "boot.ndjson");
    assert.isAtMost(NodeFS.statSync(file).size, StartupPhaseLog.STARTUP_LOG_BOOT_MAX_BYTES);
    NodeFS.appendFileSync(file, '{"bootId":"partial');
    const next = StartupPhaseLog.makeStartupPhaseLog(dir, "next");
    next.start("sqlite.open", 1);
    assert.equal(readRecords(dir).at(-1)?.bootId, "next");
    assert.isAtMost(NodeFS.statSync(file).size, StartupPhaseLog.STARTUP_LOG_MAX_BYTES);
  }).pipe(Effect.ensuring(Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true }))));
});

it.effect(
  "preserves shared layer acquisition and scoped cleanup while a dependency is blocked",
  () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "startup-log-"));
    class Shared extends Context.Service<Shared, number>()(
      "t3/ardud/observability/StartupPhaseLog.test/Shared",
    ) {}
    return Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let acquired = 0;
      let closed = 0;
      const shared = Layer.effect(
        Shared,
        Effect.acquireRelease(
          Effect.sync(() => ++acquired).pipe(
            Effect.tap(() => Deferred.succeed(entered, undefined)),
            Effect.andThen(Deferred.await(release)),
            Effect.as(42),
          ),
          () =>
            Effect.sync(() => {
              closed++;
            }),
        ),
      );
      const first = shared.pipe(StartupPhaseLog.withStartupLayer("server.dependencies"));
      const second = shared.pipe(StartupPhaseLog.withStartupLayer("server.application"));
      const fiber = yield* Effect.scoped(Layer.build(Layer.merge(first, second))).pipe(
        Effect.provide(StartupPhaseLog.layer(dir)),
        Effect.forkChild,
      );
      yield* Deferred.await(entered);
      assert.includeMembers(
        readRecords(dir).map((record) => record.outcome),
        ["start"],
      );
      assert.notInclude(
        readRecords(dir).map((record) => record.outcome),
        "success",
      );
      yield* Deferred.succeed(release, undefined);
      const context = yield* Fiber.join(fiber);
      assert.equal(Context.get(context, Shared), 42);
      assert.equal(acquired, 1);
      assert.equal(closed, 1);
      assert.equal(readRecords(dir).filter((record) => record.outcome === "success").length, 2);
    }).pipe(
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true }))),
    );
  },
);

it.effect("records delegated recovery counts and the slowest item without extra fields", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "startup-delegated-log-"));
  const counts = {
    subagentResultThreads: 2,
    delegatedCompletionThreads: 1,
    timedOut: 1,
    slowestItemId: "thread:stuck-child",
    slowestItemMs: 30_000,
    secret: "must not persist",
  };
  const logger = StartupPhaseLog.makeStartupPhaseLog(dir);
  return StartupPhaseLog.withStartupPhase(
    "orchestration-v2.delegated-tasks.recover",
    Effect.succeed(counts),
    (value) => value,
  ).pipe(
    Effect.provideService(StartupPhaseLog.StartupPhaseLog, logger),
    Effect.tap(() =>
      Effect.sync(() => {
        const record = readRecords(dir)[1]!;
        assert.equal(record.subagentResultThreads, 2);
        assert.equal(record.delegatedCompletionThreads, 1);
        assert.equal(record.timedOut, 1);
        assert.equal(record.slowestItemId, "thread:stuck-child");
        assert.equal(record.slowestItemMs, 30_000);
        assert.isUndefined(record.secret);
        assert.equal(logger.snapshot().phases[0]?.timedOut, 1);
      }),
    ),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true }))),
  );
});
