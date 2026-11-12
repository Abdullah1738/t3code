// Startup markers must reach disk before synchronous SQLite work begins.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { bootId as installBootId } from "../fast-install/report.ts";

export const STARTUP_LOG_BOOTS = 20;
export const STARTUP_LOG_BOOT_MAX_BYTES = 128 * 1024;
export const STARTUP_LOG_MAX_BYTES = STARTUP_LOG_BOOTS * STARTUP_LOG_BOOT_MAX_BYTES;

export type StartupPhase =
  | "boot"
  | "http.listen"
  | "http.control-routes"
  | "http.routes"
  | "server.dependencies"
  | "server.runtime"
  | "server.runtime-core"
  | "server.runtime-core-base"
  | "server.orchestration"
  | "server.settings"
  | "server.auth"
  | "server.secrets"
  | "server.environment"
  | "server.usage"
  | "server.background"
  | "server.diagnostics"
  | "server.providers"
  | "server.provider-hydration"
  | "server.provider-installations"
  | "server.model-catalog"
  | "server.opencode-runtime"
  | "server.opencode-import"
  | "server.kanban"
  | "server.readonly-replica"
  | "server.project-settings-sweep"
  | "server.workspace"
  | "server.vcs"
  | "server.application"
  | "boards.initialize"
  | "boards.open"
  | "boards.setup"
  | "boards.migrate"
  | "sqlite.marker"
  | "sqlite.pragmas"
  | "sqlite.archive-marker"
  | "sqlite.planner-statistics"
  | "sqlite.archive-shell-counts"
  | "sqlite.archive-events"
  | "sqlite.archive-turn-items"
  | `sqlite.migration.${number}`
  | "sqlite.initialize"
  | "sqlite.open"
  | "sqlite.setup"
  | "sqlite.migrations"
  | "sqlite.shell-indexes"
  | "sqlite.history-archive"
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

interface StartupPhaseTiming {
  readonly id: number;
  readonly phase: StartupPhase;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly durationMs: number | null;
  readonly outcome: "running" | "success" | "failure" | "interrupted";
  readonly recoveryIds?: number;
  readonly terminalizedRuns?: number;
}

export interface StartupReport {
  readonly bootId: string;
  readonly pid: number;
  readonly phases: ReadonlyArray<StartupPhaseTiming>;
  readonly droppedRecords: number;
  readonly persistenceFailed: boolean;
}

export class StartupPhaseLog extends Context.Service<
  StartupPhaseLog,
  {
    readonly start: (phase: StartupPhase, at: number) => number | void;
    readonly end: (
      phase: StartupPhase,
      at: number,
      durationMs: number,
      outcome: "success" | "failure" | "interrupted",
      counts?: RecoveryCounts,
      id?: number | void,
    ) => void;
    readonly snapshot: () => StartupReport;
  }
>()("t3/ardud/observability/StartupPhaseLog") {}

/** One writer per server boot; only the explicitly listed fields can reach this file. */
export function makeStartupPhaseLog(
  logsDir: string,
  bootId: string = installBootId,
): StartupPhaseLog["Service"] {
  const filePath = NodePath.join(logsDir, "boot.ndjson");
  const phases: StartupPhaseTiming[] = [];
  let bootBytes = 0;
  let droppedRecords = 0;
  let persistenceFailed = false;
  // Compact once per boot, atomically. Phase markers only append, so the start
  // of an expensive synchronous operation is visible even if it never returns.
  try {
    NodeFS.mkdirSync(logsDir, { recursive: true });
    let previous = "";
    try {
      const fd = NodeFS.openSync(filePath, "r");
      try {
        const size = NodeFS.fstatSync(fd).size;
        const offset = Math.max(0, size - STARTUP_LOG_MAX_BYTES);
        const buffer = Buffer.alloc(Math.min(size, STARTUP_LOG_MAX_BYTES));
        NodeFS.readSync(fd, buffer, 0, buffer.length, offset);
        const tail = buffer.toString("utf8");
        previous = offset === 0 ? tail : tail.slice(tail.indexOf("\n") + 1);
      } finally {
        NodeFS.closeSync(fd);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const boots = new Map<string, { lines: string[]; bytes: number }>();
    for (const line of previous.split("\n")) {
      try {
        const record = JSON.parse(line) as { bootId?: unknown };
        if (typeof record.bootId !== "string" || record.bootId === bootId) continue;
        const retained = boots.get(record.bootId) ?? { lines: [], bytes: 0 };
        const bytes = Buffer.byteLength(line) + 1;
        if (retained.bytes + bytes <= STARTUP_LOG_BOOT_MAX_BYTES) {
          retained.lines.push(`${line}\n`);
          retained.bytes += bytes;
          boots.set(record.bootId, retained);
        }
      } catch {
        // A killed append may leave a partial last line.
      }
    }
    const retained = [...boots.values()]
      .slice(-(STARTUP_LOG_BOOTS - 1))
      .flatMap((boot) => boot.lines)
      .join("");
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    try {
      NodeFS.writeFileSync(temporaryPath, retained, { mode: 0o600 });
      NodeFS.renameSync(temporaryPath, filePath);
    } finally {
      NodeFS.rmSync(temporaryPath, { force: true });
    }
  } catch {
    persistenceFailed = true;
  }
  const write = (record: object) => {
    if (persistenceFailed) return;
    try {
      const line = `${JSON.stringify(record)}\n`;
      const bytes = Buffer.byteLength(line);
      if (bootBytes + bytes > STARTUP_LOG_BOOT_MAX_BYTES) {
        droppedRecords += 1;
        return;
      }
      NodeFS.appendFileSync(filePath, line, { mode: 0o600 });
      bootBytes += bytes;
    } catch {
      persistenceFailed = true;
      // Observability is best effort, including on read-only or full disks.
    }
  };
  const iso = (at: number) => DateTime.formatIso(DateTime.makeUnsafe(at));
  return {
    start: (phase, at) => {
      if (phases.length >= 512) {
        droppedRecords += 1;
        return -1;
      }
      const id = phases.length;
      phases.push({
        id,
        phase,
        startedAt: iso(at),
        endedAt: null,
        durationMs: null,
        outcome: "running",
      });
      write({
        bootId,
        id,
        pid: process.pid,
        phase,
        at: iso(at),
        outcome: "start",
      });
      return id;
    },
    end: (phase, at, durationMs, outcome, counts, id) => {
      const index =
        typeof id === "number"
          ? id
          : phases.findLastIndex((entry) => entry.phase === phase && entry.outcome === "running");
      if (index < 0) return;
      const entry = phases[index];
      if (entry === undefined || entry.outcome !== "running") return;
      const safeCounts =
        counts === undefined
          ? {}
          : {
              recoveryIds: counts.recoveryIds,
              terminalizedRuns: counts.terminalizedRuns,
            };
      phases[index] = { ...entry, endedAt: iso(at), durationMs, outcome, ...safeCounts };
      write({
        bootId,
        id: index,
        pid: process.pid,
        phase,
        at: iso(at),
        durationMs,
        outcome,
        ...safeCounts,
      });
    },
    snapshot: () => ({
      bootId,
      pid: process.pid,
      phases: phases.map((phase) => ({ ...phase })),
      droppedRecords,
      persistenceFailed,
    }),
  };
}

export const layer = (logsDir: string) =>
  Layer.sync(StartupPhaseLog, () => makeStartupPhaseLog(logsDir));

/** Keep the caller's memo map and scope: tracing must never duplicate a pool or worker. */
export const withStartupLayer =
  (phase: StartupPhase) =>
  <A, E, R>(layer: Layer.Layer<A, E, R>) =>
    Layer.fromBuildMemo((memoMap, scope) =>
      withStartupPhase(phase, Layer.buildWithMemoMap(layer, memoMap, scope)),
    );

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
      const id = yield* Effect.sync(() => {
        try {
          return logger.value.start(phase, clock.currentTimeMillisUnsafe());
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
                id,
              );
            } catch {}
          }),
        ),
      );
    }),
  );
