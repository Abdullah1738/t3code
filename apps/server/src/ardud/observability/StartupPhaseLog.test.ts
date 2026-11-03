// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import * as StartupPhaseLog from "./StartupPhaseLog.ts";

const readRecords = (dir: string) =>
  NodeFS.readFileSync(NodePath.join(dir, "startup-phases.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

it.effect("records start, success and failure without error text", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "startup-log-"));
  return Effect.gen(function* () {
    const layer = StartupPhaseLog.layer(dir);
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

it.effect("rotates at one MiB with one backup", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "startup-log-"));
  return Effect.gen(function* () {
    const file = NodePath.join(dir, "startup-phases.ndjson");
    NodeFS.writeFileSync(file, "x".repeat(StartupPhaseLog.STARTUP_LOG_MAX_BYTES - 1));
    const logger = StartupPhaseLog.makeStartupPhaseLog(dir);
    logger.start("sqlite.open", 0);
    logger.end("sqlite.open", 1, 1, "success");
    assert.equal(NodeFS.statSync(`${file}.1`).size, StartupPhaseLog.STARTUP_LOG_MAX_BYTES - 1);
    assert.isBelow(NodeFS.statSync(file).size, StartupPhaseLog.STARTUP_LOG_MAX_BYTES);
    assert.deepEqual(
      readRecords(dir).map((record) => record.outcome),
      ["start", "success"],
    );
    assert.deepEqual(NodeFS.readdirSync(dir).sort(), [
      "startup-phases.ndjson",
      "startup-phases.ndjson.1",
    ]);
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
        }),
      ),
      2,
    );
  }).pipe(Effect.ensuring(Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true }))));
});
