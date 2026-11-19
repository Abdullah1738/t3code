import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as TestClock from "effect/testing/TestClock";

import * as EventLoopMonitor from "./EventLoopMonitor.ts";
import * as FileDescriptors from "./FileDescriptorTelemetry.ts";
// @ts-expect-error The CLI helper is JavaScript without declarations; verify its runtime parser.
import { summarizeLag } from "../ardud/control/deep-health.mjs";

const quiet: EventLoopMonitor.EventLoopReadings = {
  delayMaxNs: 0,
  activeMs: 0,
  utilization: 0,
  usage: {
    userCPUTime: 0,
    systemCPUTime: 0,
    majorPageFault: 0,
    minorPageFault: 0,
    involuntaryContextSwitches: 0,
  },
  rssBytes: 1024 ** 3,
  heapUsedBytes: 0,
  heapTotalBytes: 0,
  externalBytes: 0,
  gc: { count: 0, totalMs: 0, maxMs: 0, majorCount: 0, majorMaxMs: 0 },
  elapsedMs: 30_000,
};

describe("FileDescriptorTelemetry", () => {
  it.each([
    { soft: 1048575, hard: "unlimited" },
    { soft: 1024, hard: 4096 },
    { soft: "unlimited", hard: "unlimited" },
  ] as const)("reads the effective report limits $soft / $hard", (limits) => {
    assert.deepStrictEqual(
      FileDescriptors.parseLimits({ userLimits: { open_files: limits }, environmentVariables: {} }),
      limits,
    );
  });

  it.each([{}, { userLimits: {} }, { userLimits: { open_files: { soft: "1024", hard: 4096 } } }])(
    "rejects unavailable or malformed limits: %j",
    (report) => assert.throws(() => FileDescriptors.parseLimits(report)),
  );

  it("counts numeric entries and selects only supported descriptor tables", () => {
    assert.equal(FileDescriptors.countDescriptors([".", "..", "0", "1", "42", "stdin"]), 3);
    assert.equal(FileDescriptors.descriptorDirectory("darwin"), "/dev/fd");
    assert.equal(FileDescriptors.descriptorDirectory("linux"), "/proc/self/fd");
    assert.isUndefined(FileDescriptors.descriptorDirectory("win32"));
  });

  it.effect("reports descriptor count as unknown on unsupported platforms", () =>
    Effect.gen(function* () {
      const telemetry = yield* FileDescriptors.nodeTelemetry;
      assert.isNull(yield* telemetry.count);
    }).pipe(Effect.provideService(HostProcess.Platform, "win32")),
  );

  it.effect("samples every thirty seconds and warns only on crossing 80%", () => {
    const messages: Array<{ level: string; message: unknown }> = [];
    const logger = Logger.make(({ message, logLevel }) =>
      messages.push({ level: logLevel, message }),
    );
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fd-monitor-" });
      const filePath = `${directory}/event-loop-stalls.ndjson`;
      const counts = [800, 801, 900, null, 800, 801, 700];
      const readings = [quiet, quiet, { ...quiet, delayMaxNs: 6e9, activeMs: 6000 }];
      let countCalls = 0;
      let limitCalls = 0;
      yield* Layer.build(
        EventLoopMonitor.layerWith(
          Effect.succeed(Effect.sync(() => readings.shift() ?? quiet)),
          { filePath, maxBytes: 64 * 1024 },
          undefined,
          undefined,
          undefined,
          undefined,
          {
            limits: Effect.sync(() => {
              limitCalls++;
              return { soft: 1000, hard: "unlimited" };
            }),
            count: Effect.sync(() => {
              countCalls++;
              return counts.shift() ?? null;
            }),
          },
        ),
      );
      yield* TestClock.adjust("60 seconds");
      assert.equal(countCalls, 1);
      yield* TestClock.adjust("29 seconds");
      assert.equal(countCalls, 1);
      yield* TestClock.adjust("151 seconds");
      assert.equal(countCalls, 7);
      assert.equal(limitCalls, 1);
      const lines = (yield* fs.readFileString(filePath))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const samples = lines;
      assert.deepStrictEqual(
        samples.map((row) => row.openFdCount),
        [800, 801, 900, null, 800, 801, 700],
      );
      assert.equal(samples[1].delayMaxMs, 5000);
      assert.isFalse(
        summarizeLag(
          { text: lines.map((row) => JSON.stringify(row)).join("\n"), error: null },
          240_000,
        ).reasons.includes("invalid lag records"),
      );
      assert.deepStrictEqual(
        lines.filter((row) => row.level === "WARN").map((row) => row.openFdCount),
        [801, 801],
      );
      for (const row of lines) {
        assert.equal(row.pid, process.pid);
        assert.equal(row.openFdSoftLimit, 1000);
        assert.equal(row.openFdHardLimit, "unlimited");
      }
      assert.deepStrictEqual(
        lines.filter((row) => row.fdPressureWarning === true).map((row) => row.openFdCount),
        [801, 801],
      );
      assert.lengthOf(
        messages.filter(
          (row) => Array.isArray(row.message) && row.message[0] === "server file descriptor limits",
        ),
        1,
      );
      assert.lengthOf(
        messages.filter(
          (row) =>
            row.level === "Warn" &&
            Array.isArray(row.message) &&
            row.message[0] === "server file descriptors above 80% of soft limit",
        ),
        2,
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.merge(NodeServices.layer, Logger.layer([logger], { mergeWithExisting: false })),
      ),
    );
  });

  it.effect.each([null, "unlimited", 0] as const)(
    "does not infer pressure from soft limit %s",
    (soft) => {
      const warnings: Array<unknown> = [];
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fd-monitor-" });
        const filePath = `${directory}/event-loop-stalls.ndjson`;
        yield* Layer.build(
          EventLoopMonitor.layerWith(
            Effect.succeed(Effect.succeed(quiet)),
            { filePath, maxBytes: 4096 },
            undefined,
            undefined,
            undefined,
            undefined,
            { limits: Effect.succeed({ soft, hard: null }), count: Effect.succeed(999999) },
          ),
        );
        yield* TestClock.adjust("60 seconds");
        const row = JSON.parse((yield* fs.readFileString(filePath)).trim());
        assert.equal(row.openFdSoftLimit, soft);
        assert.equal(row.openFdCount, 999999);
        assert.deepStrictEqual(warnings, []);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.merge(
            NodeServices.layer,
            Logger.layer(
              [
                Logger.make(({ message, logLevel }) => {
                  if (logLevel === "Warn") warnings.push(message);
                }),
              ],
              { mergeWithExisting: false },
            ),
          ),
        ),
      );
    },
  );
});
