import { VcsProcessSpawnError } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import { HttpClient } from "effect/http";

import * as ForgejoCli from "./ForgejoCli.ts";

const host = "forgejo.test";
const input = { cwd: "/repo", repository: `https://${host}/acme/web` };

it.effect.each(["missing-path", "missing-login"] as const)(
  "keeps the fj diagnosis when tea is absent (%s)",
  (scenario) => {
    const failures: VcsProcessSpawnError[] = [];
    return Effect.gen(function* () {
      const cli = yield* ForgejoCli.make;
      const error = yield* cli.resolveRepository(input).pipe(Effect.flip);
      assert.strictEqual(error.command, "fj");
      assert.strictEqual(
        error.reason,
        scenario === "missing-path" ? "missing-cli" : "authentication",
      );
      assert.include(error.detail, "fj");
      assert.include(error.detail, host);
      if (scenario === "missing-path") assert.strictEqual(error.cause, failures[0]);
      else {
        assert.include(error.detail, "No fj login matches");
        assert.notMatch(error.message, /install.*fj/i);
      }
    }).pipe(
      Effect.provideService(HostProcess.Platform, "darwin"),
      Effect.provideService(HostProcess.HomeDirectory, "/home/test"),
      Effect.provideService(HostProcess.Environment, { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }),
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          exists: () => Effect.succeed(true),
          readFileString: () =>
            Effect.succeed(
              JSON.stringify({
                hosts: {
                  [scenario === "missing-path" ? host : "other.test"]: {
                    type: "Application",
                    token: "test-token",
                  },
                },
              }),
            ),
        }),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Unexpected HTTP")),
      ),
      Effect.provide(
        TestSourceControlHost.layer({
          process: {
            run: (command) => {
              if (scenario === "missing-login" && command.command === "fj") {
                assert.deepStrictEqual(command.args, ["version"]);
                return Effect.succeed(TestSourceControlHost.processOutput("fj v0.7.0"));
              }
              const error = new VcsProcessSpawnError({
                operation: command.operation,
                command: command.command,
                cwd: command.cwd,
                cause: PlatformError.systemError({
                  _tag: "NotFound",
                  module: "ChildProcess",
                  method: "spawn",
                }),
              });
              failures.push(error);
              return Effect.fail(error);
            },
          },
        }),
      ),
    );
  },
);

it.effect("retains fj spawn failures that are not missing binaries", () =>
  Effect.gen(function* () {
    const cli = yield* ForgejoCli.make;
    const error = yield* cli.resolveRepository(input).pipe(Effect.flip);
    assert.strictEqual(error.command, "fj");
    assert.strictEqual(error.reason, undefined);
    assert.include(error.message, host);
    assert.include(error.message, "fj");
    assert.instanceOf(error.cause, VcsProcessSpawnError);
  }).pipe(
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        exists: () => Effect.succeed(true),
        readFileString: () =>
          Effect.succeed(
            JSON.stringify({ hosts: { [host]: { type: "Application", token: "test-token" } } }),
          ),
      }),
    ),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Unexpected HTTP")),
    ),
    Effect.provide(
      TestSourceControlHost.layer({
        process: {
          run: (command) => {
            assert.strictEqual(command.command, "fj");
            return Effect.fail(
              new VcsProcessSpawnError({
                operation: command.operation,
                command: command.command,
                cwd: command.cwd,
                cause: PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "ChildProcess",
                  method: "spawn",
                }),
              }),
            );
          },
        },
      }),
    ),
  ),
);
