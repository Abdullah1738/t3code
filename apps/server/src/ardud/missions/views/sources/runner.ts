// @effect-diagnostics nodeBuiltinImport:off - source scripts run as owner-written child processes in their own scratch dirs.
// @effect-diagnostics globalTimersInEffect:off - the child's deadline lives in the Node callback that owns the child.
// @effect-diagnostics globalDate:off - wall-clock duration of a child process, measured in its callbacks.
// @effect-diagnostics globalDateInEffect:off - same duration, started where the child is spawned.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { VIEW_SOURCE_LIMITS, type ViewSourceRuntime } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export interface ScriptSpec {
  readonly runtime: ViewSourceRuntime;
  readonly code: string;
  /** The source's scratch dir; the script runs in `<dir>/work`. */
  readonly dir: string;
  readonly timeoutMs: number;
}

export interface ScriptResult {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  /** stdout passed the output cap and the script was stopped. */
  readonly overflow: boolean;
  readonly stdout: string;
  /** The last few KB of stderr. */
  readonly stderr: string;
  readonly durationMs: number;
  /** The script could not start (missing runtime, unwritable dir). */
  readonly spawnError: string | null;
}

const RUNTIMES: Record<ViewSourceRuntime, { readonly binary: string; readonly file: string }> = {
  bash: { binary: "bash", file: "script.sh" },
  node: { binary: "node", file: "script.mjs" },
  python3: { binary: "python3", file: "script.py" },
};

const STDERR_TAIL = 8_192;

const segment = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "_");

/** A source's scratch dir under the server state dir; ids are flattened so none can climb out. */
export const sourceDir = (stateDir: string, missionId: string, sourceId: string) =>
  NodePath.join(stateDir, "mission-sources", segment(missionId), segment(sourceId));

/**
 * Robob's own credentials and wiring stay out of the script's environment.
 * The login-shell PATH (hydrated at startup) and the owner's tool configs
 * (gh, linctl) stay in, so the CLIs the scripts call work as they do in his
 * terminal.
 */
const SCRUBBED_PREFIXES = [
  "T3CODE_",
  "T3_",
  "ROBOB_",
  "OPENCODE_",
  "ELECTRON_",
  "VITE_",
  "AGENT_DEVICE_",
  "MISSION_",
];

export const scriptEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (SCRUBBED_PREFIXES.some((prefix) => key.toUpperCase().startsWith(prefix))) continue;
    clean[key] = value;
  }
  clean.NO_COLOR = "1";
  return clean;
};

const leaderRunning = (child: NodeChildProcess.ChildProcess) =>
  child.exitCode === null && child.signalCode === null;

/** detached gives the script its own process group, so pipelines it starts die with it. */
const killGroup = (child: NodeChildProcess.ChildProcess) => {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    if (leaderRunning(child)) child.kill("SIGKILL");
  }
};

const spawnScript = (spec: ScriptSpec, scriptPath: string, cwd: string) =>
  Effect.callback<ScriptResult>((resume, signal) => {
    const started = Date.now();
    const runtime = RUNTIMES[spec.runtime];
    const stdout: Array<Buffer> = [];
    let stdoutBytes = 0;
    let stderr = "";
    let timedOut = false;
    let overflow = false;
    let settled = false;
    const finish = (exitCode: number | null, spawnError: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resume(
        Effect.succeed({
          exitCode,
          timedOut,
          overflow,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr,
          durationMs: Date.now() - started,
          spawnError,
        }),
      );
    };
    const child = NodeChildProcess.spawn("nice", ["-n", "10", runtime.binary, scriptPath], {
      cwd,
      env: scriptEnv(process.env),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    // Something outside the group (a setsid daemon) can hold our pipes forever,
    // so a stopped run closes its ends instead of waiting for `close`. Once the
    // leader exited its group was already killed and its id may be reused.
    const stop = () => {
      if (leaderRunning(child)) killGroup(child);
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const timer = setTimeout(() => {
      if (settled) return;
      // A script that already exited and left only pipe holders behind did finish.
      timedOut = leaderRunning(child);
      stop();
      finish(child.exitCode, null);
    }, spec.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (overflow || settled) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > VIEW_SOURCE_LIMITS.outputBytes) {
        overflow = true;
        stop();
        finish(null, null);
        return;
      }
      stdout.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_TAIL);
    });
    child.on("error", (error) => finish(null, error.message));
    // The script is done; whatever it left in its group (`cmd &`) would hold our
    // pipes and keep `close` from coming, so it goes too. A group with members
    // keeps its id from being reused.
    child.on("exit", () => {
      if (!settled) killGroup(child);
    });
    child.on("close", (code) => finish(code, null));
    const abort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
    };
    signal.addEventListener("abort", abort, { once: true });
    return Effect.sync(abort);
  });

/**
 * Runs one script: written to the source's scratch dir, started under
 * `nice` with stdin closed, killed with its whole process group on timeout,
 * on too much output, or when the run is interrupted.
 */
export const runScript = Effect.fn("SourceRunner.run")(function* (spec: ScriptSpec) {
  const runtime = RUNTIMES[spec.runtime];
  const cwd = NodePath.join(spec.dir, "work");
  const scriptPath = NodePath.join(spec.dir, runtime.file);
  const prepared = yield* Effect.tryPromise(async () => {
    await NodeFSP.mkdir(cwd, { recursive: true });
    await NodeFSP.writeFile(scriptPath, spec.code, { mode: 0o600 });
  }).pipe(
    Effect.as(null),
    Effect.catch((error) => Effect.succeed(String(error.cause ?? error))),
  );
  if (prepared !== null) {
    const failed: ScriptResult = {
      exitCode: null,
      timedOut: false,
      overflow: false,
      stdout: "",
      stderr: "",
      durationMs: 0,
      spawnError: prepared,
    };
    return failed;
  }
  return yield* spawnScript(spec, scriptPath, cwd);
});

export class SourceRunner extends Context.Service<
  SourceRunner,
  { readonly run: (spec: ScriptSpec) => Effect.Effect<ScriptResult> }
>()("t3/ardud/missions/views/sources/runner/SourceRunner") {}

export const layer = Layer.succeed(SourceRunner, SourceRunner.of({ run: runScript }));
