// @effect-diagnostics nodeBuiltinImport:off -- observes native spawn calls in the main isolate only.
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ProcessRunner from "./processRunner.ts";
import * as ServerProcessRuntime from "./serverProcessRuntime.ts";
import * as VcsProcess from "./vcs/VcsProcess.ts";

const native = NodeModule.createRequire(import.meta.url)(
  "node:child_process",
) as typeof NodeChildProcess;
const cases = ["startup", "application"].flatMap((phase) =>
  ["direct", "runner", "vcs"].map((kind) => ({ phase, kind })),
);

for (const { phase, kind } of cases) {
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    `keeps ${phase} ${kind} launches off main through the server runtime boundary`,
    () =>
      Effect.gen(function* () {
        const spy = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const spy = vi.spyOn(native, "spawn");
            NodeModule.syncBuiltinESMExports();
            return spy;
          }),
          (spy) =>
            Effect.sync(() => {
              spy.mockRestore();
              NodeModule.syncBuiltinESMExports();
            }),
        );
        const cliSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const args = ["-e", "process.stdout.write('proof')"];
        // A positive control catches instrumentation that would miss every launch.
        yield* cliSpawner.exitCode(ChildProcess.make(process.execPath, ["-e", ""]));
        assert.strictEqual(spy.mock.calls.length, 1);
        spy.mockClear();

        const consumer = Effect.gen(function* () {
          if (kind === "direct") {
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
            assert.strictEqual(
              yield* spawner.string(ChildProcess.make(process.execPath, args)),
              "proof",
            );
          } else if (kind === "runner") {
            const runner = yield* ProcessRunner.ProcessRunner;
            assert.strictEqual(
              (yield* runner.run({ command: process.execPath, args })).stdout,
              "proof",
            );
          } else {
            const vcs = yield* VcsProcess.VcsProcess;
            assert.strictEqual(
              (yield* vcs.run({
                operation: "server-composition-test",
                command: process.execPath,
                args,
                cwd: process.cwd(),
              })).stdout,
              "proof",
            );
          }
        });
        // Both startup acquisition and nested providers use the same boundary as
        // server.ts, beneath the CLI's ordinary NodeServices layer.
        const boot = Layer.unwrap(
          Effect.gen(function* () {
            if (phase === "startup") {
              yield* consumer;
              return Layer.empty;
            }
            return Layer.effectDiscard(consumer).pipe(
              Layer.provide(VcsProcess.layer),
              Layer.provide(ProcessRunner.layer),
            );
          }),
        ).pipe(Layer.provide(VcsProcess.layer), ServerProcessRuntime.provide);
        yield* Layer.build(boot);
        assert.strictEqual(spy.mock.calls.length, 0);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}
