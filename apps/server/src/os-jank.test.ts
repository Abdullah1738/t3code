import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  CommandAvailability,
  WindowsShellEnvironment,
  SpawnExecutableResolution,
} from "@t3tools/shared/shell";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as PlatformError from "effect/PlatformError";
import * as Effect from "effect/Effect";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Observe the existing synchronous shell probe without launching the user's login shell.
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import { assert, it, vi } from "vite-plus/test";

import { fixPath, hydratePosixHome } from "./os-jank.ts";

vi.mock("node:child_process", { spy: true });

it("hydrates HOME for minimal service environments from the user account", () => {
  const env: NodeJS.ProcessEnv = {};

  hydratePosixHome(env);

  assert.equal(env.HOME, NodeOS.userInfo().homedir);
});

it("hydrates HOME independently of a blank process HOME", () => {
  const originalHome = process.env.HOME;
  const env: NodeJS.ProcessEnv = { HOME: " " };

  try {
    process.env.HOME = " ";
    hydratePosixHome(env);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }

  assert.equal(env.HOME, NodeOS.userInfo().homedir);
});

it("preserves an explicitly configured HOME", () => {
  const env: NodeJS.ProcessEnv = { HOME: "/custom/home" };

  hydratePosixHome(env, () => {
    throw new Error("HOME lookup should not run");
  });

  assert.equal(env.HOME, "/custom/home");
});

effectIt.effect.each(["darwin", "linux"] as const)(
  "keeps the prepared PATH and still hydrates HOME on %s",
  (platform) =>
    Effect.acquireUseRelease(
      Effect.sync(() => vi.spyOn(NodeChildProcess, "execFileSync")),
      (probe) =>
        Effect.gen(function* () {
          probe.mockImplementation(() => {
            throw new Error("The prepared environment must not launch another shell");
          });
          const env: NodeJS.ProcessEnv = { PATH: "/prepared/bin:/usr/bin" };

          yield* fixPath({ shellEnvironmentPrepared: true }).pipe(
            Effect.provideService(HostProcess.Platform, platform),
            Effect.provideService(HostProcess.Environment, env),
            Effect.provide(NodeServices.layer),
          );

          assert.equal(probe.mock.calls.length, 0);
          assert.equal(env.PATH, "/prepared/bin:/usr/bin");
          assert.equal(env.HOME, NodeOS.userInfo().homedir);
        }),
      (probe) => Effect.sync(() => probe.mockRestore()),
    ),
);

effectIt.effect("hydrates PATH when the desktop handoff is absent", () =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      vi
        .spyOn(NodeChildProcess, "execFileSync")
        .mockReturnValue("__T3CODE_ENV_PATH_START__\n/opt/tools/bin\n__T3CODE_ENV_PATH_END__\n"),
    ),
    (probe) =>
      Effect.gen(function* () {
        const env: NodeJS.ProcessEnv = { SHELL: "/bin/bash", PATH: "/usr/bin" };

        yield* fixPath().pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(HostProcess.Environment, env),
          Effect.provide(NodeServices.layer),
        );

        assert.equal(probe.mock.calls.length, 1);
        assert.equal(env.PATH, "/opt/tools/bin:/usr/bin");
      }),
    (probe) => Effect.sync(() => probe.mockRestore()),
  ),
);

effectIt.effect("keeps mise's PATH record with the login shell PATH", () =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      vi
        .spyOn(NodeChildProcess, "execFileSync")
        .mockReturnValue(
          [
            "__T3CODE_ENV_PATH_START__",
            "/home/me/.local/bin:/mise/installs/claude/latest:/mise/shims",
            "__T3CODE_ENV_PATH_END__",
            "__T3CODE_ENV___MISE_DIFF_START__",
            "mise-diff",
            "__T3CODE_ENV___MISE_DIFF_END__",
          ].join("\n"),
        ),
    ),
    () =>
      Effect.gen(function* () {
        const env: NodeJS.ProcessEnv = { SHELL: "/bin/bash", PATH: "/usr/bin" };

        yield* fixPath().pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(HostProcess.Environment, env),
          Effect.provide(NodeServices.layer),
        );

        assert.equal(env.__MISE_DIFF, "mise-diff");
      }),
    (probe) => Effect.sync(() => probe.mockRestore()),
  ),
);

effectIt.effect("keeps the prepared Windows PATH without probing", () =>
  Effect.gen(function* () {
    const env: NodeJS.ProcessEnv = { PATH: "C:\\Prepared\\Bin;C:\\Windows" };
    const commands: string[] = [];

    yield* fixPath({ shellEnvironmentPrepared: true }).pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(HostProcess.Environment, env),
      Effect.provideService(WindowsShellEnvironment, () => {
        throw new Error("The prepared environment must not launch another shell");
      }),
      Effect.provideService(CommandAvailability, (command) =>
        Effect.sync(() => {
          commands.push(command);
          return true;
        }),
      ),
      Effect.provide(NodeServices.layer),
    );

    assert.deepEqual(commands, []);
    assert.equal(env.PATH, "C:\\Prepared\\Bin;C:\\Windows");
  }),
);

effectIt.effect("replaces a Path-spelled Windows PATH instead of adding a second key", () =>
  Effect.gen(function* () {
    const env: NodeJS.ProcessEnv = { Path: "C:\\Windows" };

    yield* fixPath().pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(HostProcess.Environment, env),
      Effect.provideService(WindowsShellEnvironment, () => ({ PATH: "C:\\Tools" })),
      Effect.provideService(CommandAvailability, () => Effect.succeed(true)),
      Effect.provide(NodeServices.layer),
    );

    assert.deepEqual(env, { PATH: "C:\\Tools;C:\\Windows" });
  }),
);

effectIt.effect.each([
  { probe: "login-shell", path: "/usr/bin:/bin:/usr/sbin:/sbin" },
  { probe: "login-shell", path: "/sbin:/usr/sbin:/bin:/usr/bin" },
  { probe: "login-shell", path: "/USR/BIN:/BIN:/USR/SBIN:/SBIN" },
  { probe: "login-shell", path: ":/usr/bin::/usr/bin:/bin:" },
  { probe: "login-shell", path: "/usr/bin/:/bin/.:/usr//sbin:/sbin/" },
  { probe: "launchctl", path: "/usr/bin:/bin:/usr/sbin:/sbin" },
  { probe: "launchctl", path: "  " },
  { probe: "prepared", path: "/usr/bin:/bin:/usr/sbin:/sbin" },
  { probe: "prepared", path: "" },
  ...[
    "/System/Cryptexes/App/usr/bin",
    "/system/cryptexes/app/usr/bin",
    "/System/Volumes/Preboot/Cryptexes/App/usr/bin",
    "/var/run/com.apple.security.cryptexd/codex.system/bootstrap/usr/local/bin",
    "/private/var/run/com.apple.security.cryptexd/codex.system/bootstrap/usr/bin",
    "/Library/Apple/usr/bin",
  ].flatMap((applePath) =>
    (["login-shell", "launchctl", "prepared"] as const).map((probe) => ({
      probe,
      path: `${applePath}:/usr/bin:/bin:/usr/sbin:/sbin`,
    })),
  ),
] as const)("repairs a bare macOS PATH from %s", (scenario) =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      vi.spyOn(NodeChildProcess, "execFileSync").mockImplementation((command) => {
        if (scenario.probe === "prepared") throw new Error("prepared handoffs must not probe");
        if (command === "/bin/launchctl") return scenario.path;
        if (scenario.probe === "login-shell")
          return `__T3CODE_ENV_PATH_START__\n${scenario.path}\n__T3CODE_ENV_PATH_END__\n`;
        throw Object.assign(new Error("shell timed out"), { code: "ETIMEDOUT" });
      }),
    ),
    (probe) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.stat(NodeOS.tmpdir());
        const env = {
          HOME: "/Users/test",
          SHELL: "/bin/zsh",
          PATH: scenario.probe === "prepared" ? scenario.path : "/usr/bin:/bin:/usr/sbin:/sbin",
        };
        const statPaths: string[] = [];
        const messages: unknown[] = [];
        yield* fixPath({ shellEnvironmentPrepared: scenario.probe === "prepared" }).pipe(
          Effect.provideService(HostProcess.Platform, "darwin"),
          Effect.provideService(HostProcess.Environment, env),
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            stat: (path) => {
              statPaths.push(path);
              return path === "/usr/local/bin"
                ? Effect.fail(
                    PlatformError.systemError({
                      _tag: "NotFound",
                      module: "FileSystem",
                      method: "stat",
                    }),
                  )
                : Effect.succeed(directory);
            },
          }),
          Effect.provideService(SpawnExecutableResolution, (_command, _platform, finalEnv) =>
            finalEnv.PATH?.split(":").includes("/opt/homebrew/bin")
              ? "/opt/homebrew/bin/gh"
              : undefined,
          ),
          Effect.provide(
            Logger.layer([
              Logger.make(({ message }) => {
                messages.push(message);
              }),
            ]),
          ),
        );
        assert.deepEqual(statPaths, [
          "/opt/homebrew/bin",
          "/usr/local/bin",
          "/Users/test/.local/bin",
        ]);
        assert.include(env.PATH.split(":"), "/opt/homebrew/bin");
        assert.include(env.PATH.split(":"), "/Users/test/.local/bin");
        assert.notInclude(env.PATH.split(":"), "/usr/local/bin");
        assert.include(JSON.stringify(messages), '"source":"fallback-dirs"');
        assert.include(JSON.stringify(messages), '"ghResolves":true');
        if (scenario.probe === "prepared") assert.equal(probe.mock.calls.length, 0);
      }).pipe(Effect.provide(NodeServices.layer)),
    (probe) => Effect.sync(() => probe.mockRestore()),
  ),
);

for (const failure of ["ETIMEDOUT", "ENOENT", "empty"] as const) {
  effectIt.effect(`appends existing Darwin CLI directories after ${failure} probes`, () =>
    Effect.acquireUseRelease(
      Effect.sync(() =>
        vi.spyOn(NodeChildProcess, "execFileSync").mockImplementation((command) => {
          if (command === "/bin/launchctl" || failure === "empty") return "";
          throw Object.assign(new Error("probe failed"), { code: failure });
        }),
      ),
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.stat(NodeOS.tmpdir());
          const statPaths: string[] = [];
          const messages: unknown[] = [];
          const env: NodeJS.ProcessEnv = {
            HOME: "/Users/test",
            SHELL: "/bin/zsh",
            PATH: "/custom/bin:/usr/bin:/opt/homebrew/bin",
          };
          yield* fixPath({
            shellEnvironmentPrepared: false,
            shellPathHydration: {
              source: "none",
              probes: [
                {
                  probe: "login-shell",
                  failureTag: "DesktopShellEnvironmentCommandTimeoutError",
                  timedOut: true,
                  elapsedMs: 5360,
                },
              ],
            },
          }).pipe(
            Effect.provideService(HostProcess.Platform, "darwin"),
            Effect.provideService(HostProcess.Environment, env),
            Effect.provideService(FileSystem.FileSystem, {
              ...fs,
              stat: (path) => {
                statPaths.push(path);
                // A regular file at a candidate path must not become a PATH directory.
                return Effect.succeed({
                  ...directory,
                  type: path === "/usr/local/bin" ? "File" : "Directory",
                });
              },
            }),
            Effect.provideService(SpawnExecutableResolution, (command, platform, finalEnv) => {
              assert.equal(command, "gh");
              assert.equal(platform, "darwin");
              assert.equal(
                finalEnv.PATH,
                "/custom/bin:/usr/bin:/opt/homebrew/bin:/Users/test/.local/bin",
              );
              return "/opt/homebrew/bin/gh";
            }),
            Effect.provide(
              Logger.layer([
                Logger.make(({ message }) => {
                  messages.push(message);
                }),
              ]),
            ),
          );
          assert.deepEqual(statPaths, [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/Users/test/.local/bin",
          ]);
          assert.equal(env.PATH, "/custom/bin:/usr/bin:/opt/homebrew/bin:/Users/test/.local/bin");
          const flat = messages.flatMap((message) =>
            Array.isArray(message) ? message : [message],
          );
          assert.include(flat, "Server PATH hydration");
          const outcome = flat.find(
            (message) => typeof message === "object" && message !== null && "source" in message,
          );
          assert.deepInclude(outcome, {
            source: "fallback-dirs",
            timedOut: true,
            elapsedMs: 5360,
            ghResolves: true,
            pathEntryCount: 4,
          });
          assert.notInclude(JSON.stringify(outcome), "/custom/bin");
          if (failure !== "empty") assert.include(JSON.stringify(outcome), failure);
        }).pipe(Effect.provide(NodeServices.layer)),
      (probe) => Effect.sync(() => probe.mockRestore()),
    ),
  );
}

effectIt.effect.each([
  { platform: "darwin", path: "/custom/bin:/usr/bin" },
  { platform: "darwin", path: "/System/Cryptexes-tools/bin:/usr/bin" },
  { platform: "darwin", path: "/var/run/com.apple.security.cryptexd-tools/bin:/usr/bin" },
  { platform: "darwin", path: "/System/Volumes/Data/opt/homebrew/bin:/usr/bin" },
  { platform: "linux", path: "/custom/bin:/usr/bin" },
] as const)("uses a real shell PATH without appending fallback directories: %s", (scenario) =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      vi
        .spyOn(NodeChildProcess, "execFileSync")
        .mockReturnValue(`__T3CODE_ENV_PATH_START__\n${scenario.path}\n__T3CODE_ENV_PATH_END__\n`),
    ),
    () =>
      Effect.gen(function* () {
        const env: NodeJS.ProcessEnv = {
          HOME: "/Users/test",
          PATH: "/usr/bin",
          SHELL: "/bin/zsh",
        };
        const fs = yield* FileSystem.FileSystem;
        yield* fixPath({ shellEnvironmentPrepared: false }).pipe(
          Effect.provideService(HostProcess.Platform, scenario.platform),
          Effect.provideService(HostProcess.Environment, env),
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            stat: () => Effect.die("fallback stat must not run"),
          }),
          Effect.provideService(SpawnExecutableResolution, () => undefined),
        );
        assert.equal(env.PATH, scenario.path);
      }).pipe(Effect.provide(NodeServices.layer)),
    (probe) => Effect.sync(() => probe.mockRestore()),
  ),
);

for (const scenario of [
  { platform: "darwin", launchctl: "/launchctl/bin:/usr/bin", source: "server-launchctl" },
  { platform: "darwin", launchctl: "", source: "none" },
  { platform: "linux", launchctl: "", source: "none" },
] as const) {
  effectIt.effect(`reports ${scenario.source} on ${scenario.platform} with no shell PATH`, () =>
    Effect.acquireUseRelease(
      Effect.sync(() =>
        vi
          .spyOn(NodeChildProcess, "execFileSync")
          .mockImplementation((command) =>
            command === "/bin/launchctl" ? scenario.launchctl : "",
          ),
      ),
      () =>
        Effect.gen(function* () {
          const env: NodeJS.ProcessEnv = {
            HOME: "/Users/test",
            PATH: "/usr/bin",
            SHELL: "/bin/zsh",
          };
          const messages: unknown[] = [];
          const fs = yield* FileSystem.FileSystem;
          const regularFile = yield* fs.stat(import.meta.filename);
          yield* fixPath({ shellEnvironmentPrepared: false }).pipe(
            Effect.provideService(HostProcess.Platform, scenario.platform),
            Effect.provideService(HostProcess.Environment, env),
            Effect.provideService(FileSystem.FileSystem, {
              ...fs,
              stat: () => Effect.succeed(regularFile),
            }),
            Effect.provideService(SpawnExecutableResolution, () => undefined),
            Effect.provide(
              Logger.layer([
                Logger.make(({ message }) => {
                  messages.push(message);
                }),
              ]),
            ),
          );
          assert.equal(env.PATH, scenario.launchctl || "/usr/bin");
          const flat = messages.flatMap((message) =>
            Array.isArray(message) ? message : [message],
          );
          assert.deepInclude(
            flat.find(
              (message) => typeof message === "object" && message !== null && "source" in message,
            ),
            { source: scenario.source, ghResolves: false, timedOut: false },
          );
        }).pipe(Effect.provide(NodeServices.layer)),
      (probe) => Effect.sync(() => probe.mockRestore()),
    ),
  );
}
