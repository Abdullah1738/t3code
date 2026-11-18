// @effect-diagnostics nodeBuiltinImport:off -- observes native spawn calls in the main isolate only.
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as GitHubCredentials from "@t3tools/source-control-github/server/GitHubCredentials";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import { assert, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
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

it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "logs native credential spawn diagnostics through the server worker and recovers without leaking output",
  () => {
    const messages: unknown[] = [];
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-credential-spawn-" });
      const gh = path.join(cwd, "gh");
      // A present executable with a missing interpreter reproduces native ENOENT
      // without requiring a real gh installation or touching the machine's login.
      yield* fs.writeFileString(gh, `#!${path.join(cwd, "missing-interpreter")}\n`);
      yield* fs.chmod(gh, 0o700);
      const host = Layer.unwrap(
        Effect.gen(function* () {
          const vcs = yield* VcsProcess.VcsProcess;
          return TestSourceControlHost.layer({ process: { run: vcs.run } });
        }),
      ).pipe(Layer.provide(VcsProcess.layer));
      const boot = Layer.effectDiscard(
        Effect.gen(function* () {
          const credentials = yield* GitHubCredentials.GitHubCredentials;
          const error = yield* credentials.get("github.com").pipe(Effect.flip);
          assert.strictEqual(error._tag, "GitHubCliFailedError");
          const flat = messages.flatMap((message) =>
            Array.isArray(message) ? message : [message],
          );
          expect(flat).toContainEqual(
            expect.objectContaining({
              operation: "GitHubCredentials.get",
              command: gh,
              credentialErrorTag: "GitHubCliFailedError",
              platformReason: "NotFound",
              errno: -2,
              code: "ENOENT",
              syscall: `spawn ${gh}`,
              path: gh,
              cwd,
              cwdExists: true,
              resolvedGh: gh,
              pathDirs: [cwd],
            }),
          );
          yield* fs.writeFileString(gh, "#!/bin/sh\nprintf '%s' 'private-worker-token'\n");
          const recovered = yield* credentials.get("github.com");
          assert.strictEqual(Redacted.value(recovered.token), "private-worker-token");
          assert.notInclude(JSON.stringify(messages), "private-worker-token");
        }),
      ).pipe(
        Layer.provide(GitHubCredentials.layer.pipe(Layer.provide(host))),
        ServerProcessRuntime.provide,
      );
      yield* Layer.build(boot).pipe(
        Effect.provideService(HostProcess.Environment, {
          PATH: cwd,
          OTHER_SECRET: "private-worker-token",
        }),
        Effect.provideService(HostProcess.WorkingDirectory, cwd),
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.merge(
          NodeServices.layer,
          Logger.layer([
            Logger.make(({ message }) => {
              messages.push(message);
            }),
          ]),
        ),
      ),
    );
  },
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
