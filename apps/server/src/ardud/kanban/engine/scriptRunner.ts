// @effect-diagnostics nodeBuiltinImport:off - owner-written board scripts run as child processes.
// @effect-diagnostics globalTimersInEffect:off - the child's deadline lives in the Node callback that owns the child.
// @effect-diagnostics globalDate:off - wall-clock duration of a child process, measured in its callbacks.
// @effect-diagnostics globalDateInEffect:off - same duration, started where the child is spawned.
import * as NodeChildProcess from "node:child_process";

import * as Effect from "effect/Effect";

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

const STDERR_TAIL = 8_192;

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

export interface ProcessSpec {
  /** Program and arguments; the run starts them under `nice`. */
  readonly argv: readonly [string, ...Array<string>];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  /** stdout past this many bytes stops the run (`overflow`). */
  readonly outputBytes: number;
}

/**
 * Runs one program with stdin closed in its own process group, and kills
 * the whole group on timeout, on too much output, or when the run is
 * interrupted.
 */
export const runProcess = (spec: ProcessSpec) =>
  Effect.callback<ScriptResult>((resume, signal) => {
    const started = Date.now();
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
    const child = NodeChildProcess.spawn("nice", ["-n", "10", ...spec.argv], {
      cwd: spec.cwd,
      env: spec.env,
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
      if (stdoutBytes > spec.outputBytes) {
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
