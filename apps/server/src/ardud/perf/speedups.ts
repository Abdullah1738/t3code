/**
 * ardud: rollback switches for the 10 Nov architecture speed-ups. Unset means the new
 * behaviour; the listed value restores the old one without a build (the server inherits
 * the app's environment: `launchctl setenv NAME VALUE`, then a Robob restart).
 *
 * - `ROBOB_SWEEP_READS_ON_WRITER=1`: background sweep scans (threads with pull requests,
 *   usage-limit recovery candidates) run on the writer connection again. The writer is
 *   synchronous on the main thread, so every such scan freezes the whole server while it
 *   runs (0.5-6 s for the pull-request scan on the live database).
 * - `ROBOB_RUN_CONTROL_FULL_READS=1`: run-control checks (is this attempt still current,
 *   should this run finalize) read the whole runtime recovery projection again instead of
 *   the one run row they need.
 * - `ROBOB_THREAD_REPLY_LANE=0`: one thread's HTTP views queue on the shared snapshot
 *   reply lane again, behind shell pages and board snapshots.
 * - `ROBOB_SHELL_RESUME_MAX_GAP=1000`: a shell subscription that resumes more than this
 *   many events behind gets the whole thread list again (the old limit). The default
 *   lets a resume up to 20,000 events behind catch up from a list of changed threads.
 * - `ROBOB_SHELL_RESUME_MAX_THREADS=<n>`: most changed threads one such catch-up may
 *   refetch before the whole list is sent instead (default 2,000).
 * - `ROBOB_SHELL_RECENT_FIRST=0`: a client asking for the most recently updated threads
 *   as the first page of a paged thread list gets pages by thread id from the start.
 */
import * as Context from "effect/Context";

type Env = Readonly<Record<string, string | undefined>>;

const text = (env: Env, name: string): string | undefined => {
  const value = env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
};

const isOn = (env: Env, name: string): boolean => {
  const value = text(env, name)?.toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
};

const isOff = (env: Env, name: string): boolean => {
  const value = text(env, name)?.toLowerCase();
  return value === "0" || value === "false" || value === "no" || value === "off";
};

const count = (env: Env, name: string, fallback: number, min: number, max: number): number => {
  const value = text(env, name);
  if (value === undefined || !/^\d+$/.test(value)) return fallback;
  return Math.min(max, Math.max(min, Number(value)));
};

export const SHELL_RESUME_LEGACY_MAX_GAP = 1_000;

export interface Speedups {
  readonly sweepReadsOffWriter: boolean;
  readonly narrowRunControlReads: boolean;
  readonly threadReplyLane: boolean;
  readonly shellResumeMaxGap: number;
  readonly shellResumeMaxThreads: number;
  readonly shellRecentFirst: boolean;
}

export const readSpeedups = (env: Env = process.env): Speedups => ({
  sweepReadsOffWriter: !isOn(env, "ROBOB_SWEEP_READS_ON_WRITER"),
  narrowRunControlReads: !isOn(env, "ROBOB_RUN_CONTROL_FULL_READS"),
  threadReplyLane: !isOff(env, "ROBOB_THREAD_REPLY_LANE"),
  shellResumeMaxGap: count(
    env,
    "ROBOB_SHELL_RESUME_MAX_GAP",
    20_000,
    SHELL_RESUME_LEGACY_MAX_GAP,
    2_000_000,
  ),
  shellResumeMaxThreads: count(env, "ROBOB_SHELL_RESUME_MAX_THREADS", 2_000, 1, 20_000),
  shellRecentFirst: !isOff(env, "ROBOB_SHELL_RECENT_FIRST"),
});

/** Process-wide switches, read once at start. */
export const speedups: Speedups = readSpeedups();

/** The switches a service was built with: the process-wide ones unless a test provides others. */
export const Switches = Context.Reference<Speedups>("t3/ardud/perf/Switches", {
  defaultValue: () => speedups,
});

/**
 * How far behind a shell subscription may resume before it gets the whole thread list.
 * Up to `replayMaxGap` events the range is replayed; up to `changesMaxGap` it catches up
 * from the list of changed threads (off when not above `replayMaxGap`).
 */
export interface ShellResumeLimits {
  readonly replayMaxGap: number;
  readonly changesMaxGap: number;
  readonly maxThreads: number;
}

export const ShellResumeLimits = Context.Reference<ShellResumeLimits>(
  "t3/ardud/perf/ShellResumeLimits",
  {
    defaultValue: () => ({
      replayMaxGap: SHELL_RESUME_LEGACY_MAX_GAP,
      changesMaxGap: speedups.shellResumeMaxGap,
      maxThreads: speedups.shellResumeMaxThreads,
    }),
  },
);

/** Whether one thread's HTTP views have their own reply lane (off: the snapshot lane). */
export const ThreadReplyLane = Context.Reference<boolean>("t3/ardud/perf/ThreadReplyLane", {
  defaultValue: () => speedups.threadReplyLane,
});
