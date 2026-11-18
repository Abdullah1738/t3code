// @effect-diagnostics globalTimers:off -- Escalation and the quit deadline must survive closure of the Effect scopes they supervise.

export const BACKEND_TERMINATE_GRACE_MS = 10_000;
export const BACKEND_STOP_DEADLINE_MS = BACKEND_TERMINATE_GRACE_MS + 3_000;

export interface BackendProcessAction {
  readonly message: string;
  readonly pid: number;
  readonly elapsedMs: number;
  readonly signals: readonly string[];
  readonly evidence?: unknown;
  readonly error?: string;
}

const captured = new Set<ReturnType<typeof captureBackendProcess>>();
let reporter: (action: BackendProcessAction) => void = () => {};

export function setBackendProcessReporter(report: typeof reporter) {
  reporter = report;
}

export function reportBackendProcessAction(action: BackendProcessAction) {
  // Logging must never prevent the final signal or Electron's updater quit.
  try {
    reporter(action);
  } catch {
    /* The quit backstop must still run. */
  }
}

/** Owns only a PID returned by our spawner, and forgets it on observed exit. */
export function captureBackendProcess(
  pid: number,
  exited: Promise<unknown>,
  graceMs = BACKEND_TERMINATE_GRACE_MS,
  deadlineMs = graceMs + 3_000,
) {
  let alive = true;
  let startedAt: number | undefined;
  let stopping: Promise<void> | undefined;
  const signals: string[] = [];
  const signal = (name: "SIGTERM" | "SIGKILL") => {
    if (!alive) return;
    startedAt ??= performance.now();
    try {
      process.kill(pid, name);
      signals.push(name);
      reportBackendProcessAction({
        message: name === "SIGKILL" ? "backend force-killed at quit" : "backend stop requested",
        pid,
        elapsedMs: performance.now() - startedAt,
        signals: [...signals],
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        alive = false;
        captured.delete(guard);
      } else {
        reportBackendProcessAction({
          message: "backend signal failed",
          pid,
          elapsedMs: performance.now() - startedAt,
          signals: [...signals],
          error: String(error),
        });
      }
    }
  };
  // The observer is independent of the run scope that stop() is closing.
  const observedExit = exited.then(() => {
    alive = false;
    captured.delete(guard);
    if (startedAt !== undefined) {
      reportBackendProcessAction({
        message: "backend exit observed",
        pid,
        elapsedMs: performance.now() - startedAt,
        signals: [...signals],
      });
    }
  });
  const guard = {
    forceKill: () => signal("SIGKILL"),
    stop: () =>
      (stopping ??= new Promise<void>((resolve) => {
        if (!alive) {
          resolve();
          return;
        }
        signal("SIGTERM");
        const escalation = setTimeout(() => signal("SIGKILL"), graceMs);
        const deadline = setTimeout(() => {
          signal("SIGKILL");
          finish();
        }, deadlineMs);
        function finish() {
          clearTimeout(escalation);
          clearTimeout(deadline);
          resolve();
        }
        void observedExit.then(finish);
      })),
  };
  captured.add(guard);
  return guard;
}

export function forceKillCapturedBackends() {
  for (const child of captured) child.forceKill();
}

/** A detached shutdown can outlive its deadline; the final signal cannot. */
export async function waitForBackendShutdown(
  shutdown: Promise<unknown>,
  deadlineMs = BACKEND_STOP_DEADLINE_MS,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      shutdown,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, deadlineMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    forceKillCapturedBackends();
  }
}
