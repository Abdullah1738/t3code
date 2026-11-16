import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as FileSystem from "effect/FileSystem";
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
    Layer.provide(NodeCrypto.layer),
    Layer.provide(NodeFileSystem.layer),
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
    { resolved: "/hydrated/bin/gh", cwdExists: true, expected: "GitHubCliFailedError" },
    { resolved: undefined, cwdExists: true, expected: "GitHubCliMissingError" },
    { resolved: "/hydrated/bin/gh", cwdExists: false, expected: "GitHubCliFailedError" },
    { resolved: undefined, cwdExists: false, expected: "GitHubCliFailedError" },
  ])("classifies ENOENT with $resolved and cwdExists=$cwdExists", (row) => {
    const messages: unknown[] = [];
    let attempts = 0;
    const native = Object.assign(new Error("must not log raw cause or token-secret"), {
      code: "ENOENT",
      errno: -2,
      syscall: "spawn gh",
    });
    const layer = GitHubCredentials.layer.pipe(
      Layer.provide(
        TestSourceControlHost.layer({
          process: {
            run: (input) =>
              ++attempts === 1
                ? Effect.fail(
                    new VcsProcessSpawnError({
                      operation: input.operation,
                      command: input.command,
                      cwd: input.cwd,
                      cause: PlatformError.systemError({
                        _tag: "NotFound",
                        module: "ChildProcess",
                        method: "spawn",
                        syscall: "spawn",
                        cause: native,
                      }),
                    }),
                  )
                : Effect.succeed(TestSourceControlHost.processOutput("recovered-token")),
          },
        }),
      ),
      Layer.provide(NodeCrypto.layer),
      Layer.provide(
        FileSystem.layerNoop({
          stat: () =>
            row.cwdExists
              ? Effect.succeed({ type: "Directory" } as FileSystem.File.Info)
              : Effect.fail(
                  PlatformError.systemError({
                    _tag: "NotFound",
                    module: "FileSystem",
                    method: "stat",
                  }),
                ),
        }),
      ),
    );
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      expect((yield* Effect.flip(credentials.get("github.com")))._tag).toBe(row.expected);
      if (row.expected === "GitHubCliFailedError") {
        expect(Redacted.value((yield* credentials.get("github.com")).token)).toBe(
          "recovered-token",
        );
        expect(attempts).toBe(2);
      }
      const flat = messages.flatMap((message) => (Array.isArray(message) ? message : [message]));
      expect(flat).toContain("GitHubCredentials.get spawn failed");
      expect(flat).toContainEqual(
        expect.objectContaining({
          command: "gh",
          host: "github.com",
          path: "/hydrated/bin:/usr/bin",
          cwd: "/credential-cwd",
          cwdExists: row.cwdExists,
          resolvedCommand: row.resolved ?? null,
          code: "ENOENT",
          errno: -2,
          syscall: "spawn gh",
        }),
      );
      expect(JSON.stringify(flat)).not.toContain("token-secret");
      expect(JSON.stringify(flat)).not.toContain("recovered-token");
    }).pipe(
      Effect.provide(layer),
      Effect.provideService(HostProcess.Environment, {
        PATH: "/hydrated/bin:/usr/bin",
        OTHER_SECRET: "token-secret",
      }),
      Effect.provideService(HostProcess.WorkingDirectory, "/credential-cwd"),
      Effect.provideService(SpawnExecutableResolution, (_command, _platform, env) => {
        expect(env.PATH).toBe("/hydrated/bin:/usr/bin");
        return row.resolved;
      }),
      Effect.provide(
        Logger.layer([
          Logger.make(({ message }) => {
            messages.push(message);
          }),
        ]),
      ),
    );
  });

  it.effect.each([true, false])("checks the hydrated PATH on disk (installed=%s)", (installed) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const platform = yield* HostProcess.Platform;
      const cwd = yield* fs.makeTempDirectoryScoped();
      if (installed) {
        const executable = `${cwd}/${platform === "win32" ? "gh.exe" : "gh"}`;
        yield* fs.writeFileString(executable, "#!/bin/sh\n");
        if (platform !== "win32") yield* fs.chmod(executable, 0o755);
      }
      const layer = GitHubCredentials.layer.pipe(
        Layer.provide(
          TestSourceControlHost.layer({
            process: {
              run: (input) =>
                Effect.fail(
                  new VcsProcessSpawnError({
                    operation: input.operation,
                    command: input.command,
                    cwd: input.cwd,
                    cause: PlatformError.systemError({
                      _tag: "NotFound",
                      module: "ChildProcess",
                      method: "spawn",
                    }),
                  }),
                ),
            },
          }),
        ),
        Layer.provide(NodeCrypto.layer),
      );
      const error = yield* Effect.gen(function* () {
        return yield* Effect.flip((yield* GitHubCredentials.GitHubCredentials).get("github.com"));
      }).pipe(
        Effect.provide(layer),
        Effect.provideService(HostProcess.Environment, { PATH: cwd }),
        Effect.provideService(HostProcess.WorkingDirectory, cwd),
      );
      expect(error._tag).toBe(installed ? "GitHubCliFailedError" : "GitHubCliMissingError");
    }).pipe(Effect.provide(NodeFileSystem.layer), Effect.scoped),
  );

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
