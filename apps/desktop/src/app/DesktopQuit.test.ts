import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopQuit from "./DesktopQuit.ts";
import * as DesktopState from "./DesktopState.ts";

const files = vi.hoisted(() => ({
  appendFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
  statSync: vi.fn(() => ({ size: 256 * 1024 })),
  renameSync: vi.fn(),
}));
vi.mock("node:fs", async (original) => ({ ...(await original()), ...files }));

const layer = Layer.merge(
  DesktopState.layer,
  Layer.effect(
    DesktopEnvironment.DesktopEnvironment,
    Effect.map(
      Path.Path,
      (path) => ({ logDir: "/logs", path }) as DesktopEnvironment.DesktopEnvironment["Service"],
    ),
  ).pipe(Layer.provide(Path.layer)),
);

describe("DesktopQuit", () => {
  it.effect.each([
    { trigger: "before-quit" },
    { trigger: "windowAllClosed" },
    { trigger: "will-quit" },
    { trigger: "quitAndInstall" },
    { trigger: "signal", signal: "SIGINT" },
    { trigger: "signal", signal: "SIGTERM" },
    { trigger: "signal", signal: "SIGHUP" },
    { trigger: "ipc-relaunch", reason: "localEnvironmentEnabled=false" },
  ] satisfies DesktopQuit.QuitTrigger[])("records the first quit path once: %j", (trigger) =>
    Effect.gen(function* () {
      files.appendFileSync.mockClear();
      yield* DesktopQuit.record(trigger);
      yield* DesktopQuit.record({ trigger: "before-quit" });
      yield* DesktopQuit.record({ trigger: "will-quit" });
      assert.equal(files.appendFileSync.mock.calls.length, 1);
      const [file, line] = files.appendFileSync.mock.calls[0]!;
      assert.equal(file, "/logs/desktop-quits.ndjson");
      const record = JSON.parse(line);
      assert.deepEqual(record, { ...trigger, at: record.at, pid: process.pid });
      assert.isTrue(Number.isFinite(Date.parse(record.at)));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("retains the updater cause through window closure and a failed install retry", () =>
    Effect.gen(function* () {
      files.appendFileSync.mockClear();
      yield* DesktopQuit.prepare({ trigger: "quitAndInstall" });
      yield* DesktopQuit.record({ trigger: "windowAllClosed" });
      yield* DesktopQuit.record({ trigger: "before-quit" });
      yield* DesktopQuit.reset;
      yield* DesktopQuit.record({ trigger: "before-quit" });
      assert.deepEqual(
        files.appendFileSync.mock.calls.map(([, line]) => JSON.parse(line).trigger),
        ["quitAndInstall", "before-quit"],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rotates a full quit log before writing", () =>
    Effect.gen(function* () {
      files.existsSync.mockReturnValueOnce(true);
      files.renameSync.mockClear();
      yield* DesktopQuit.record({ trigger: "before-quit" });
      assert.deepEqual(files.renameSync.mock.calls, [
        ["/logs/desktop-quits.ndjson", "/logs/desktop-quits.ndjson.1"],
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "retains receipt time through later quit callbacks and clears it after a failed quit",
    () =>
      Effect.gen(function* () {
        const state = yield* DesktopState.DesktopState;
        yield* DesktopQuit.prepare({ trigger: "quitAndInstall" });
        const first = yield* Ref.get(state.quitTrigger);
        yield* TestClock.adjust("2 seconds");
        yield* DesktopQuit.record({ trigger: "before-quit" });
        assert.deepEqual(yield* Ref.get(state.quitTrigger), first);
        assert.equal(first?.trigger, "quitAndInstall");
        assert.isTrue(Number.isFinite(Date.parse(first!.at)));
        yield* DesktopQuit.reset;
        assert.isUndefined(yield* Ref.get(state.quitTrigger));
        yield* DesktopQuit.prepare({ trigger: "before-quit" });
        const next = yield* Ref.get(state.quitTrigger);
        assert.equal(Date.parse(next!.at) - Date.parse(first!.at), 2000);
      }).pipe(Effect.provide(layer), Effect.provide(TestClock.layer())),
  );

  it.effect("does not block shutdown when the log is unwritable", () =>
    Effect.gen(function* () {
      files.appendFileSync.mockImplementationOnce(() => {
        throw new Error("disk full");
      });
      yield* DesktopQuit.record({ trigger: "before-quit" });
      const state = yield* DesktopState.DesktopState;
      assert.isTrue(yield* Ref.get(state.quitRecorded));
    }).pipe(Effect.provide(layer)),
  );
});
