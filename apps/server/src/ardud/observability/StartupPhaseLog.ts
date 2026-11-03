// Startup markers must reach disk before synchronous SQLite work begins.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { randomUUID } from "node:crypto";

import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

export const STARTUP_LOG_MAX_BYTES = 1024 * 1024;

export type StartupPhase =
  | "sqlite.initialize"
  | "sqlite.open"
  | "sqlite.setup"
  | "sqlite.migrations"
  | "sqlite.shell-indexes"
  | "projection.bootstrap"
  | "projection.rebuild"
  | "keybindings.start"
  | "settings.start"
  | "orchestration-v2.legacy-v1.import-shells"
  | "orchestration-v2.recovery"
  | "orchestration-v2.recovery.reconcile"
  | "orchestration-v2.delegated-tasks.recover"
  | "orchestration-v2.effect-worker.start"
  | "welcome.autobootstrap"
  | "projects.auto-pull"
  | "headless.output"
  | "browser.open"
  | "http.wait"
  | "auxiliary-roots.parked"
  | "welcome.publish"
  | "ready.publish";

export interface RecoveryCounts {
  readonly recoveryIds: number;
  readonly terminalizedRuns: number;
}

export class StartupPhaseLog extends Context.Service<
  StartupPhaseLog,
  {
    readonly start: (phase: StartupPhase, at: number) => void;
    readonly end: (
      phase: StartupPhase,
      at: number,
      durationMs: number,
      outcome: "success" | "failure" | "interrupted",
      counts?: RecoveryCounts,
    ) => void;
  }
>()("t3/ardud/observability/StartupPhaseLog") {}

/** One writer per server boot; only the explicitly listed fields can reach this file. */
export function makeStartupPhaseLog(logsDir: string): StartupPhaseLog["Service"] {
  const filePath = NodePath.join(logsDir, "startup-phases.ndjson");
  const bootId = randomUUID();
  const write = (record: object) => {
    try {
      const line = `${JSON.stringify(record)}\n`;
      const bytes = Buffer.byteLength(line);
      NodeFS.mkdirSync(logsDir, { recursive: true });
      let size = 0;
      try {
        size = NodeFS.statSync(filePath).size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (size + bytes > STARTUP_LOG_MAX_BYTES && size > 0) {
        NodeFS.renameSync(filePath, `${filePath}.1`);
      }
      NodeFS.appendFileSync(filePath, line, { mode: 0o600 });
    } catch {
      // Observability is best effort, including on read-only or full disks.
    }
  };
  return {
    start: (phase, at) =>
      write({
        bootId,
        pid: process.pid,
        phase,
        at: DateTime.formatIso(DateTime.makeUnsafe(at)),
        outcome: "start",
      }),
    end: (phase, at, durationMs, outcome, counts) =>
      write({
        bootId,
        pid: process.pid,
        phase,
        at: DateTime.formatIso(DateTime.makeUnsafe(at)),
        durationMs,
        outcome,
        ...(counts === undefined
          ? {}
          : { recoveryIds: counts.recoveryIds, terminalizedRuns: counts.terminalizedRuns }),
      }),
  };
}

export const layer = (logsDir: string) =>
  Layer.succeed(StartupPhaseLog, makeStartupPhaseLog(logsDir));

/** Starts and finishes on the calling fiber, even when the phase is interrupted. */
export const withStartupPhase = <A, E, R>(
  phase: StartupPhase,
  effect: Effect.Effect<A, E, R>,
  recoveryCounts?: (value: A) => RecoveryCounts,
): Effect.Effect<A, E, R> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const logger = yield* Effect.serviceOption(StartupPhaseLog);
      if (Option.isNone(logger)) return yield* restore(effect);
      const clock = yield* Clock.Clock;
      const startedAt = clock.monotonicTimeNanosUnsafe();
      // Protect the startup itself even if a supplied logger fails.
      yield* Effect.sync(() => {
        try {
          logger.value.start(phase, clock.currentTimeMillisUnsafe());
        } catch {}
      });
      return yield* restore(effect).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            try {
              const outcome = Exit.isSuccess(exit)
                ? "success"
                : Cause.hasInterruptsOnly(exit.cause)
                  ? "interrupted"
                  : "failure";
              logger.value.end(
                phase,
                clock.currentTimeMillisUnsafe(),
                Math.max(0, Number(clock.monotonicTimeNanosUnsafe() - startedAt) / 1_000_000),
                outcome,
                Exit.isSuccess(exit) ? recoveryCounts?.(exit.value) : undefined,
              );
            } catch {}
          }),
        ),
      );
    }),
  );
