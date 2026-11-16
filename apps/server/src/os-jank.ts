import type { DesktopBackendBootstrap } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  isBareMacosPath,
  listLoginShellCandidates,
  mergePathEntries,
  readEnvironmentFromLoginShell,
  readPathFromLaunchctl,
  resolveWindowsEnvironment,
  SpawnExecutableResolution,
  setWindowsPath,
} from "@t3tools/shared/shell";
import * as Clock from "effect/Clock";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Observe errors swallowed by the existing synchronous launchctl reader.
import * as NodeChildProcess from "node:child_process";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeOS from "node:os";

function logPathHydrationWarning(message: string, error?: unknown): void {
  process.stderr.write(
    `[server] ${message} ${error instanceof Error ? error.message : (error ?? "")}\n`,
  );
}

type DesktopPathHydration = NonNullable<DesktopBackendBootstrap["shellPathHydration"]>;
type ProbeOutcome = DesktopPathHydration["probes"][number];

const appendMacosCliDirectories = Effect.fn("server.pathHydration.appendMacosCliDirectories")(
  function* (env: NodeJS.ProcessEnv) {
    const fileSystem = yield* FileSystem.FileSystem;
    const candidates = [
      "/opt/homebrew/bin",
      "/usr/local/bin",
      ...(env.HOME ? [`${env.HOME}/.local/bin`] : []),
    ];
    const existing: string[] = [];
    for (const candidate of candidates) {
      const stat = yield* fileSystem.stat(candidate).pipe(Effect.orElseSucceed(() => undefined));
      if (stat?.type === "Directory") existing.push(candidate);
    }
    const inherited = mergePathEntries(env.PATH, undefined, "darwin");
    const withFallback = mergePathEntries(inherited, existing.join(":"), "darwin");
    const changed = withFallback !== inherited;
    if (withFallback) env.PATH = withFallback;
    return changed;
  },
);

const runPathProbe = Effect.fn("server.pathHydration.probe")(function* <A>(
  probe: ProbeOutcome["probe"],
  read: () => A,
) {
  const started = yield* Clock.monotonicTimeNanos;
  let failureTag = "none";
  let timedOut = false;
  const value = yield* Effect.try(read).pipe(
    Effect.catch((error) => {
      const cause = error.cause;
      const code =
        typeof cause === "object" && cause !== null && "code" in cause
          ? String(cause.code)
          : undefined;
      failureTag = code ?? (cause instanceof Error ? cause.name : "UnknownError");
      timedOut = code === "ETIMEDOUT";
      return Effect.succeed(undefined);
    }),
  );
  const elapsedMs = Number((yield* Clock.monotonicTimeNanos) - started) / 1_000_000;
  const outcome = { probe, failureTag, timedOut, elapsedMs };
  yield* Effect.annotateCurrentSpan(outcome);
  return { value, outcome };
});

const hydratePosixPath = Effect.fn("server.pathHydration.hydratePosixPath")(function* (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
) {
  const probes: ProbeOutcome[] = [];
  let shellEnvironment: Partial<Record<string, string>> = {};
  for (const shell of listLoginShellCandidates(platform, env.SHELL)) {
    const result = yield* runPathProbe("login-shell", () =>
      // mise's PATH record must travel with PATH or `mise x` can put a wrapper
      // ahead of its target and recursively spawn itself.
      readEnvironmentFromLoginShell(shell, ["PATH", "__MISE_DIFF"]),
    );
    probes.push(result.outcome);
    shellEnvironment = result.value ?? {};
    if (shellEnvironment.PATH?.trim()) break;
  }

  const shellPath = shellEnvironment.PATH?.trim() || undefined;
  let launchctlPath: string | undefined;
  if (platform === "darwin" && !shellPath) {
    let launchctlError: unknown;
    const result = yield* runPathProbe("launchctl-path", () => {
      const value = readPathFromLaunchctl((...args) => {
        // The shared reader tolerates errors. Retain the failure for startup diagnostics.
        try {
          return NodeChildProcess.execFileSync(...args);
        } catch (error) {
          launchctlError = error;
          throw error;
        }
      });
      if (launchctlError !== undefined) throw launchctlError;
      return value;
    });
    probes.push(result.outcome);
    launchctlPath = result.value;
  }
  let source:
    | DesktopPathHydration["source"]
    | "server-shell"
    | "server-launchctl"
    | "fallback-dirs" = shellPath ? "server-shell" : launchctlPath ? "server-launchctl" : "none";
  const mergedPath = mergePathEntries(shellPath ?? launchctlPath, env.PATH, platform);
  if (mergedPath) env.PATH = mergedPath;
  if (
    platform === "darwin" &&
    ((!shellPath && !launchctlPath) || isBareMacosPath(env.PATH)) &&
    (yield* appendMacosCliDirectories(env))
  )
    source = "fallback-dirs";
  if (shellPath && shellEnvironment.__MISE_DIFF) env.__MISE_DIFF = shellEnvironment.__MISE_DIFF;
  return { source, probes };
});

export function hydratePosixHome(
  env: NodeJS.ProcessEnv,
  resolveHomeDir = () => NodeOS.userInfo().homedir,
): void {
  if ((env.HOME?.trim() ?? "").length > 0) return;

  const homeDir = resolveHomeDir();
  if (homeDir.length > 0) {
    env.HOME = homeDir;
  }
}

export const fixPath = Effect.fn("fixPath")(function* (options?: {
  readonly shellEnvironmentPrepared?: boolean | undefined;
  readonly shellPathHydration?: DesktopPathHydration | undefined;
}): Effect.fn.Return<void, never, FileSystem.FileSystem | Path.Path> {
  const platform = yield* HostProcess.Platform;
  const env = yield* HostProcess.Environment;

  if (platform === "win32") {
    // The desktop already ran both PowerShell probes into the env this child
    // extends. Repeating them here costs seconds of startup on Windows.
    if (options?.shellEnvironmentPrepared === true) return;
    const repairedEnvironment = yield* resolveWindowsEnvironment(env).pipe(
      Effect.catchDefect((defect) =>
        Effect.sync(() => {
          logPathHydrationWarning("Failed to hydrate PATH from the user environment.", defect);
          return {} as Partial<NodeJS.ProcessEnv>;
        }),
      ),
    );
    for (const [key, value] of Object.entries(repairedEnvironment)) {
      if (value === undefined) continue;
      if (key === "PATH") {
        setWindowsPath(env, value);
      } else {
        env[key] = value;
      }
    }
    return;
  }

  if (platform !== "darwin" && platform !== "linux") return;

  yield* Effect.sync(() => hydratePosixHome(env)).pipe(
    Effect.catchDefect((defect) =>
      Effect.sync(() => {
        logPathHydrationWarning("Failed to hydrate HOME from the user account.", defect);
      }),
    ),
  );
  const desktop = options?.shellPathHydration;
  const result =
    options?.shellEnvironmentPrepared === true
      ? { source: desktop?.source ?? "none", probes: [] }
      : yield* hydratePosixPath(env, platform).pipe(
          Effect.catchDefect(() => Effect.succeed({ source: "none" as const, probes: [] })),
        );
  // Older desktops can mark a system-only probe as prepared.
  if (
    options?.shellEnvironmentPrepared === true &&
    platform === "darwin" &&
    isBareMacosPath(env.PATH) &&
    (yield* appendMacosCliDirectories(env))
  )
    result.source = "fallback-dirs";
  const probes = [
    ...(desktop?.probes.map((probe) => ({ stage: "desktop", ...probe })) ?? []),
    ...result.probes.map((probe) => ({ stage: "server", ...probe })),
  ];
  const resolveExecutable = yield* SpawnExecutableResolution;
  const outcome = {
    source: result.source,
    probeFailures: probes.filter((probe) => probe.failureTag !== "none"),
    timedOut: probes.some((probe) => probe.timedOut),
    elapsedMs: probes.reduce((sum, probe) => sum + probe.elapsedMs, 0),
    ghResolves: resolveExecutable("gh", platform, env) !== undefined,
    pathEntryCount: (env.PATH ?? "").split(":").filter((entry) => entry.trim()).length,
  };
  yield* Effect.annotateCurrentSpan({
    "pathHydration.source": outcome.source,
    "pathHydration.timedOut": outcome.timedOut,
    "pathHydration.elapsedMs": outcome.elapsedMs,
    "pathHydration.ghResolves": outcome.ghResolves,
    "pathHydration.pathEntryCount": outcome.pathEntryCount,
    "pathHydration.probeFailures": outcome.probeFailures.map(
      (probe) => `${probe.stage}:${probe.probe}:${probe.failureTag}`,
    ),
    "pathHydration.probeFailureElapsedMs": outcome.probeFailures.map((probe) => probe.elapsedMs),
  });
  yield* Effect.logInfo("Server PATH hydration", outcome);
});

export const expandHomePath = Effect.fn(function* (input: string) {
  const { join } = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  if (input === "~") {
    return home;
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return join(home, input.slice(2));
  }
  return input;
});

export const resolveBaseDir = Effect.fn(function* (raw: string | undefined) {
  const { join, resolve } = yield* Path.Path;
  if (!raw || raw.trim().length === 0) {
    return join(yield* HostProcess.HomeDirectory, ".robob");
  }
  return resolve(yield* expandHomePath(raw.trim()));
});
