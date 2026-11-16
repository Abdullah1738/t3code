import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as PlatformError from "effect/PlatformError";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Redacted from "effect/Redacted";
import { ChildProcessSpawner } from "effect/process";

import { DEFAULT_SERVER_SETTINGS, VcsProcessSpawnError } from "@t3tools/contracts";
import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as GitHubCredentials from "./GitHubCredentials.ts";
import { gitHubProviderFailure } from "./GitHubPullRequestProvider.ts";

const TOKEN_VARIABLES = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
] as const;

const hostSettings = (
  hosts: Record<string, { readonly account?: string; readonly enabled?: boolean }>,
) =>
  Object.fromEntries(
    Object.entries(hosts).map(([host, choice]) => [host, { enabled: true, ...choice }]),
  );

function harness(
  hosts: Record<string, { readonly account?: string; readonly enabled?: boolean }> = {},
  signedOut: ReadonlyArray<string> = [],
  tokens: Record<string, string> = {},
) {
  const calls: Array<ReadonlyArray<string>> = [];
  const run: SourceControlHost.SourceControlHost["Service"]["process"]["run"] = (input) =>
    Effect.sync(() => {
      calls.push(input.args);
      const user = input.args[input.args.indexOf("--user") + 1];
      if (input.args.includes("--user") && user !== undefined && signedOut.includes(user)) {
        return {
          exitCode: ChildProcessSpawner.ExitCode(0),
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      }
      return {
        exitCode: ChildProcessSpawner.ExitCode(0),
        stdout: input.args.includes("--user") ? `token-for-${user}\n` : "active-token\n",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    });
  const layer = GitHubCredentials.layer.pipe(
    Layer.provideMerge(
      TestSourceControlHost.layer({
        settings: applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
          sourceControlHosts: { github: { hosts: hostSettings(hosts), tokens } },
        }),
        process: { run },
      }),
    ),
    Layer.provide(Layer.merge(NodeCrypto.layer, NodeFileSystem.layer)),
  );
  return { layer, calls };
}

describe("GitHubCredentials", () => {
  beforeEach(() => {
    for (const name of TOKEN_VARIABLES) vi.stubEnv(name, "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.effect.each([
    { cwd: "/", gh: undefined, expected: "GitHubCliMissingError" },
    { cwd: "/missing-pr-watch-cwd", gh: "/tools/gh", expected: "GitHubCliFailedError" },
    { cwd: "/missing-pr-watch-cwd", gh: undefined, expected: "GitHubCliFailedError" },
    { cwd: "/", gh: "/tools/gh", expected: "GitHubCliFailedError" },
  ])("classifies spawn NotFound with cwd=$cwd gh=$gh", ({ cwd, gh, expected }) => {
    const messages: unknown[] = [];
    let calls = 0;
    const layer = GitHubCredentials.layer.pipe(
      Layer.provide(
        TestSourceControlHost.layer({
          process: {
            run: (input) => {
              calls++;
              if (calls > 1)
                return Effect.succeed(TestSourceControlHost.processOutput("recovered-token"));
              return Effect.fail(
                new VcsProcessSpawnError({
                  operation: input.operation,
                  command: input.command,
                  cwd: input.cwd,
                  cause: PlatformError.systemError({
                    _tag: "NotFound",
                    module: "ChildProcess",
                    method: "spawn",
                    syscall: "spawn gh",
                    cause: Object.assign(new Error("private-token-must-not-be-logged"), {
                      errno: -2,
                      code: "ENOENT",
                      syscall: "spawn gh",
                      path: "gh",
                      stdout: "private-token-must-not-be-logged",
                      stderr: "private-token-must-not-be-logged",
                    }),
                  }),
                }),
              );
            },
          },
        }),
      ),
      Layer.provide(Layer.merge(NodeCrypto.layer, NodeFileSystem.layer)),
    );
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const failure = yield* Effect.flip(credentials.get("github.com"));
      expect(failure._tag).toBe(expected);
      expect(gitHubProviderFailure(failure).reason).toBe(
        expected === "GitHubCliMissingError" ? "missing-tool" : "failed",
      );
      if (expected === "GitHubCliFailedError") {
        expect(Redacted.value((yield* credentials.get("github.com")).token)).toBe(
          "recovered-token",
        );
      } else {
        expect((yield* Effect.flip(credentials.get("github.com")))._tag).toBe(expected);
      }
      expect(calls).toBe(expected === "GitHubCliFailedError" ? 2 : 1);
      const flat = messages.flatMap((message) => (Array.isArray(message) ? message : [message]));
      expect(flat).toContain("GitHub credential CLI failed");
      expect(flat).toContainEqual(
        expect.objectContaining({
          operation: "GitHubCredentials.get",
          host: "github.com",
          errno: -2,
          code: "ENOENT",
          syscall: "spawn gh",
          path: "gh",
          cwd,
          cwdExists: cwd === "/",
          resolvedGh: gh ?? null,
          pathDirs: ["/private/bin", "/usr/bin"],
          credentialErrorTag: expected,
          command: gh ?? "gh",
        }),
      );
      expect(JSON.stringify(flat)).not.toContain("private-token-must-not-be-logged");
      expect(JSON.stringify(flat)).not.toContain("recovered-token");
    }).pipe(
      Effect.provide(layer),
      Effect.provideService(HostProcess.Environment, { PATH: "/private/bin:/usr/bin" }),
      Effect.provideService(HostProcess.WorkingDirectory, cwd),
      Effect.provideService(HostProcess.Platform, "darwin"),
      Effect.provideService(SpawnExecutableResolution, () => gh),
      Effect.provide(
        Logger.layer([
          Logger.make(({ message }) => {
            messages.push(message);
          }),
        ]),
      ),
    );
  });

  it.effect("asks gh for the active login when Settings pin nothing", () => {
    const { layer, calls } = harness();
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const credential = yield* credentials.get("GitHub.com");
      expect(Redacted.value(credential.token)).toBe("active-token");
      expect(calls).toEqual([["auth", "token", "--hostname", "github.com"]]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("passes --user for an account pinned in Settings", () => {
    const { layer, calls } = harness({ "github.com": { account: "work" } });
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const credential = yield* credentials.get("github.com");
      expect(Redacted.value(credential.token)).toBe("token-for-work");
      expect(calls).toEqual([["auth", "token", "--hostname", "github.com", "--user", "work"]]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails a host turned off in Settings without asking gh", () => {
    const { layer, calls } = harness({ "github.com": { enabled: false } });
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const error = yield* Effect.flip(credentials.get("github.com"));
      expect(error._tag).toBe("GitHubHostDisabledError");
      expect(error.message).toBe(
        "GitHub host github.com is turned off in Settings → Source Control.",
      );
      expect(calls).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("lets an environment token win over a pinned account, as gh does", () => {
    vi.stubEnv("GH_TOKEN", "from-env");
    const { layer, calls } = harness({ "github.com": { account: "work" } });
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const credential = yield* credentials.get("github.com");
      expect(Redacted.value(credential.token)).toBe("from-env");
      expect(credential.source).toBe("env");
      expect(calls).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("picks up a changed account on the next request without a restart", () => {
    const { layer, calls } = harness();
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const settings = yield* TestSourceControlHost.TestSourceControlHostSettings;
      expect(Redacted.value((yield* credentials.get("github.com")).token)).toBe("active-token");

      yield* settings.update({
        sourceControlHosts: {
          github: { hosts: { "github.com": { account: "work", enabled: true } } },
        },
      });
      expect(Redacted.value((yield* credentials.get("github.com")).token)).toBe("token-for-work");

      yield* settings.update({
        sourceControlHosts: { github: { hosts: { "github.com": { enabled: false } } } },
      });
      expect((yield* Effect.flip(credentials.get("github.com")))._tag).toBe(
        "GitHubHostDisabledError",
      );

      yield* settings.update({ sourceControlHosts: { github: { hosts: {} } } });
      expect(Redacted.value((yield* credentials.get("github.com")).token)).toBe("active-token");
      expect(calls).toHaveLength(2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("falls back to the active login when the pinned one is no longer signed in", () => {
    const { layer, calls } = harness({ "github.com": { account: "gone" } }, ["gone"]);
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      expect(Redacted.value((yield* credentials.get("github.com")).token)).toBe("active-token");
      expect(calls).toEqual([
        ["auth", "token", "--hostname", "github.com", "--user", "gone"],
        ["auth", "token", "--hostname", "github.com"],
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("uses a token saved in Settings before GH_TOKEN and gh", () => {
    vi.stubEnv("GH_TOKEN", "env-token");
    const { layer, calls } = harness({}, [], { "github.com": "saved-token" });
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const credential = yield* credentials.get("github.com");
      expect(Redacted.value(credential.token)).toBe("saved-token");
      expect(credential.source).toBe("settings");
      expect(calls).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps a host turned off even with a token saved in Settings", () => {
    const { layer } = harness({ "github.com": { enabled: false } }, [], {
      "github.com": "saved-token",
    });
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      expect((yield* Effect.flip(credentials.get("github.com")))._tag).toBe(
        "GitHubHostDisabledError",
      );
    }).pipe(Effect.provide(layer));
  });
});
