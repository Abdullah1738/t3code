/**
 * Read-only per-thread recovery view for stream-recovery: which run and attempt
 * is current, whether the provider session is loaded, and what work it still
 * holds. The runtime probe uses `peek` only. `get`, `open` and `isLive` either
 * count as activity or load the session, which would reset idle timers.
 */
import {
  ThreadId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProviderSessionManager from "../../orchestration-v2/ProviderSessionManager.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ControlStore from "../control/ControlStore.ts";
import { runsNewestFirst, TERMINAL_RUN_STATUSES } from "../control/model.ts";
import * as ExecutionIdentity from "../identity/ExecutionIdentity.ts";

export class RecoverySnapshotError extends Schema.TaggedError<RecoverySnapshotError>()(
  "RecoverySnapshotError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to read the recovery snapshot.";
  }
}

interface RecoveryRun {
  readonly id: string;
  readonly status: string;
  readonly startedAt: string | null;
  readonly lastProgressAt: string;
}

interface RecoveryEntry {
  readonly threadId: string;
  readonly driver: string | null;
  readonly instance: string | null;
  readonly nativeId: string | null;
  readonly run: RecoveryRun | null;
  readonly attemptId: string | null;
  readonly pendingRequests: ReadonlyArray<{ readonly id: string; readonly kind: string }>;
  readonly runtime: "present" | "absent" | "unknown";
  readonly heldWork: boolean | null;
  readonly children: ReadonlyArray<{
    readonly threadId: string;
    readonly kind: string;
    readonly status: string;
  }>;
}

interface RecoveryPage {
  readonly threads: ReadonlyArray<RecoveryEntry>;
  readonly nextCursor: string | null;
}

export class RecoverySnapshot extends Context.Service<
  RecoverySnapshot,
  {
    readonly page: (input: {
      readonly active: boolean;
      readonly cursor: string | null;
      readonly limit: number;
    }) => Effect.Effect<RecoveryPage, RecoverySnapshotError>;
  }
>()("t3/ardud/recovery/RecoverySnapshot") {}

const DEFAULT_PAGE_LIMIT = 200;
const MAX_PAGE_LIMIT = 500;

const clampLimit = (limit: number): number =>
  Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, MAX_PAGE_LIMIT) : DEFAULT_PAGE_LIMIT;

/**
 * One page of ids in ascending order after the cursor. The cursor is an
 * exclusive lower bound, so a page never repeats an id when the set changes
 * between calls.
 */
const pageIds = (
  ids: ReadonlyArray<string>,
  cursor: string | null,
  limit: number,
): { readonly ids: ReadonlyArray<string>; readonly nextCursor: string | null } => {
  const sorted = [...new Set(ids)].toSorted((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const remaining = cursor === null ? sorted : sorted.filter((id) => id > cursor);
  const page = remaining.slice(0, limit);
  const last = page[page.length - 1];
  return {
    ids: page,
    nextCursor: remaining.length > page.length && last !== undefined ? last : null,
  };
};

/** The newest non-terminal run, else the newest run. */
const currentRun = (runs: ReadonlyArray<OrchestrationV2Run>): OrchestrationV2Run | null => {
  const ordered = runsNewestFirst(runs);
  return ordered.find((run) => !TERMINAL_RUN_STATUSES.has(run.status)) ?? ordered[0] ?? null;
};

const activeProviderThread = (
  providerThreads: ReadonlyArray<OrchestrationV2ProviderThread>,
  activeId: string | null,
): OrchestrationV2ProviderThread | null =>
  activeId === null
    ? null
    : (providerThreads.find((providerThread) => providerThread.id === activeId) ?? null);

// Unlike archive-if-idle, recovery must distinguish an unsuccessful probe from
// confirmed held work. Preserve the same probe order and thread-wide fallback.
const snapshotHoldsWork = Effect.fn("RecoverySnapshot.holdsWork")(function* (
  runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime,
  providerThread: OrchestrationV2ProviderThread,
) {
  const threadProbes = [
    runtime.hasPendingBackgroundWorkForThread?.(providerThread),
    runtime.holdsWorkForThread?.(providerThread),
  ].filter((probe) => probe !== undefined);
  const probes =
    threadProbes.length > 0
      ? threadProbes
      : runtime.hasPendingBackgroundWork === undefined
        ? []
        : [runtime.hasPendingBackgroundWork];
  const holding = yield* Effect.findFirst(probes, (probe) => probe);
  return Option.isSome(holding);
});

/**
 * Runtime state of the active provider thread. A failed or missing `peek` is
 * "unknown", never "absent": only a confirmed missing session counts as absent.
 */
const probeRuntime = Effect.fn("RecoverySnapshot.probeRuntime")(function* (
  providerSessions: ProviderSessionManager.ProviderSessionManagerV2Shape,
  providerThread: OrchestrationV2ProviderThread | null,
) {
  if (providerThread === null || providerThread.providerSessionId === null) {
    return { runtime: "absent", heldWork: null } as const;
  }
  const peek = providerSessions.peek;
  if (peek === undefined) return { runtime: "unknown", heldWork: null } as const;
  const peeked = yield* peek(providerThread.providerSessionId).pipe(
    Effect.map((session) => ({ readable: true as const, session })),
    Effect.catchCause(() => Effect.succeed({ readable: false as const })),
  );
  if (!peeked.readable) return { runtime: "unknown", heldWork: null } as const;
  if (Option.isNone(peeked.session)) return { runtime: "absent", heldWork: null } as const;
  const heldWork = yield* snapshotHoldsWork(peeked.session.value, providerThread).pipe(
    Effect.catchCause(() => Effect.succeed(null)),
  );
  return { runtime: "present", heldWork } as const;
});

/**
 * An entry for a thread whose records can't be read. It keeps the thread in
 * the page with runtime unknown, so one bad thread doesn't fail the others.
 */
const unknownEntry = (
  threadId: string,
  nativeId: string | null,
  instance: string | null,
): RecoveryEntry => ({
  threadId,
  driver: null,
  instance,
  nativeId,
  run: null,
  attemptId: null,
  pendingRequests: [],
  runtime: "unknown",
  heldWork: null,
  children: [],
});

const make = Effect.gen(function* () {
  const control = yield* ControlStore.ControlStore;
  const identity = yield* ExecutionIdentity.ExecutionIdentity;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;

  const threadIds = Effect.fn("RecoverySnapshot.threadIds")(function* (active: boolean) {
    if (active) {
      return yield* control
        .liveThreadIds()
        .pipe(
          Effect.mapError(
            (cause) => new RecoverySnapshotError({ operation: "list-live-threads", cause }),
          ),
        );
    }
    const snapshot = yield* threads
      .getShellSnapshot({ location: "active" })
      .pipe(
        Effect.mapError(
          (cause) => new RecoverySnapshotError({ operation: "list-active-threads", cause }),
        ),
      );
    return snapshot.threads.map((shell) => shell.id);
  });

  const entryFor = Effect.fn("RecoverySnapshot.entryFor")(function* (
    threadId: string,
    nativeId: string | null,
  ) {
    const id = ThreadId.make(threadId);
    const shellRead = yield* threads.getThreadShell(id).pipe(Effect.option);
    const shell: OrchestrationV2ThreadShell | null = Option.getOrNull(shellRead) ?? null;
    if (shell === null) return unknownEntry(threadId, nativeId, null);
    // ThreadManagementService hydrates legacy transcripts on record reads;
    // recovery must read the existing projection without loading a session.
    const recordsRead = yield* orchestrator
      .getThreadRecords(id, ["runs", "runtimeRequests", "providerThreads", "subagents"])
      .pipe(Effect.option);
    if (Option.isNone(recordsRead)) {
      return unknownEntry(threadId, nativeId, shell.modelSelection.instanceId);
    }
    const records = recordsRead.value;
    const providerThread = activeProviderThread(
      records.providerThreads,
      shell.activeProviderThreadId,
    );
    const run = currentRun(records.runs);
    const probe = yield* probeRuntime(providerSessions, providerThread);
    return {
      threadId,
      driver: providerThread?.driver ?? null,
      instance: providerThread?.providerInstanceId ?? shell.modelSelection.instanceId,
      nativeId,
      run:
        run === null
          ? null
          : {
              id: run.id,
              status: run.status,
              startedAt: run.startedAt === null ? null : DateTime.formatIso(run.startedAt),
              lastProgressAt: DateTime.formatIso(shell.updatedAt),
            },
      attemptId: run?.activeAttemptId ?? null,
      pendingRequests: records.runtimeRequests
        .filter((request) => request.status === "pending")
        .map((request) => ({ id: request.id, kind: request.kind })),
      runtime: probe.runtime,
      heldWork: probe.heldWork,
      children: records.subagents.flatMap((subagent) =>
        subagent.childThreadId === null
          ? []
          : [{ threadId: subagent.childThreadId, kind: subagent.origin, status: subagent.status }],
      ),
    } satisfies RecoveryEntry;
  });

  const page = Effect.fn("RecoverySnapshot.page")(function* (input: {
    readonly active: boolean;
    readonly cursor: string | null;
    readonly limit: number;
  }) {
    const ids = yield* threadIds(input.active);
    const window = pageIds(ids, input.cursor, clampLimit(input.limit));
    const natives = yield* identity
      .currentNative(window.ids)
      .pipe(
        Effect.mapError(
          (cause) => new RecoverySnapshotError({ operation: "read-native-ids", cause }),
        ),
      );
    const entries = yield* Effect.forEach(window.ids, (threadId) => {
      const nativeId = natives.get(threadId)?.nativeId ?? null;
      return entryFor(threadId, nativeId).pipe(
        Effect.catchCause(() => Effect.succeed(unknownEntry(threadId, nativeId, null))),
      );
    });
    return { threads: entries, nextCursor: window.nextCursor } satisfies RecoveryPage;
  });

  return RecoverySnapshot.of({ page });
});

export const layer = Layer.effect(RecoverySnapshot, make);
