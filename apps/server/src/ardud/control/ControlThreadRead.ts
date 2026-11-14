import { ThreadId, type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ControlStore from "./ControlStore.ts";
import {
  pendingRequestSummary,
  runSummary,
  runsNewestFirst,
  shellSummary,
  stateFromRuns,
  stateFromRunStatus,
} from "./model.ts";

export class ControlThreadReadError extends Data.TaggedError("ControlThreadReadError")<{
  readonly code: "internal" | "not_found";
  readonly message: string;
}> {}

const readError = (cause: unknown) =>
  new ControlThreadReadError({
    code: "internal",
    message: cause instanceof Error ? cause.message : String(cause),
  });
const RECENT_RUNS = 5;

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const store = yield* ControlStore.ControlStore;

  const getShell = Effect.fn("ControlThreadRead.getShell")(function* (threadId: string) {
    const shell = yield* threads
      .getThreadShell(ThreadId.make(threadId))
      .pipe(Effect.mapError(readError));
    if (shell === null || shell.deletedAt !== null) {
      return yield* Effect.fail(
        new ControlThreadReadError({
          code: "not_found",
          message: `Thread ${threadId} was not found.`,
        }),
      );
    }
    return shell;
  });

  const summarize = Effect.fn("ControlHttp.summarize")(function* (
    shells: ReadonlyArray<OrchestrationV2ThreadShell>,
  ) {
    const ids = shells.map((shell) => shell.id);
    const [origins, natives, bindings] = yield* Effect.all([
      store.getOrigins(ids),
      store.nativeSessionIds(ids),
      store.nativeBindings(ids),
    ]).pipe(Effect.mapError(readError));
    const rootIds = shells
      .map((shell) => shell.lineage.rootThreadId)
      .filter((id) => !origins.has(id));
    const rootOrigins =
      rootIds.length === 0
        ? new Map<string, string>()
        : yield* store.getOrigins(rootIds).pipe(Effect.mapError(readError));
    return shells.map((shell) => ({
      ...shellSummary(shell, {
        origin:
          origins.get(shell.id) ??
          origins.get(shell.lineage.rootThreadId) ??
          rootOrigins.get(shell.lineage.rootThreadId) ??
          null,
        nativeSessionId: natives.get(shell.id) ?? null,
      }),
      native: bindings.get(shell.id) ?? null,
    }));
  });

  const readRecords = Effect.fn("ControlThreadRead.readRecords")((threadId: string) =>
    threads
      .getThreadRecords(ThreadId.make(threadId), ["runs", "runtimeRequests", "turnItems"], {
        turnItemTypes: ["approval_request", "user_input_request"],
        recentRunLimit: RECENT_RUNS,
      })
      .pipe(Effect.mapError(readError)),
  );

  const detail = Effect.fn("ControlHttp.threadDetail")(function* (threadId: string) {
    const shell = yield* getShell(threadId);
    const records = yield* readRecords(threadId);
    const pending = records.runtimeRequests.filter((request) => request.status === "pending");
    const { state, run } = stateFromRuns(records.runs, pending.length > 0);
    const [summary] = yield* summarize([shell]);
    return {
      ...summary!,
      state,
      status: run?.status ?? "idle",
      run: run === null ? null : runSummary(run),
      recentRuns: runsNewestFirst(records.runs).slice(0, RECENT_RUNS).map(runSummary),
      pendingRequests: pending.map((request) => pendingRequestSummary(request, records.turnItems)),
    };
  });

  const byNative = Effect.fn("ControlThreadRead.byNative")(function* (
    nativeId: string,
    options: { readonly driver?: string; readonly view?: "owner" } = {},
  ) {
    const started = performance.now();
    const stages: Record<string, number> = { lookup: 0, getShell: 0, readRecords: 0, summarize: 0 };
    let threadId: string | null = null;
    let loadedRunCount = 0;
    const stage = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) =>
      Effect.suspend(() => {
        const start = performance.now();
        return effect.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              stages[name] = performance.now() - start;
            }),
          ),
          Effect.withSpan(`ControlHttp.byNative.${name}`),
        );
      });
    return yield* Effect.gen(function* () {
      threadId = yield* stage(
        "lookup",
        store.threadIdForNativeSession(nativeId, options.driver).pipe(Effect.mapError(readError)),
      );
      if (threadId === null)
        return yield* Effect.fail(
          new ControlThreadReadError({
            code: "not_found",
            message: `No thread maps to session ${nativeId}.`,
          }),
        );
      if (options.view === "owner") {
        const shell = yield* stage(
          "getShell",
          store.ownerShell(threadId).pipe(Effect.mapError(readError)),
        );
        if (shell === null)
          return yield* Effect.fail(
            new ControlThreadReadError({
              code: "not_found",
              message: `Thread ${threadId} was not found.`,
            }),
          );
        return {
          id: shell.threadId,
          threadId: shell.threadId,
          title: shell.title,
          projectId: shell.projectId,
          state: stateFromRunStatus(shell.status, shell.pending),
          status: shell.status,
          archived: shell.archived,
          deleted: shell.deleted,
        };
      }
      const shell = yield* stage("getShell", getShell(threadId));
      const records = yield* stage("readRecords", readRecords(threadId));
      loadedRunCount = records.runs.length;
      const pending = records.runtimeRequests.filter((request) => request.status === "pending");
      const { state, run } = stateFromRuns(records.runs, pending.length > 0);
      const [summary] = yield* stage("summarize", summarize([shell]));
      return {
        ...summary!,
        state,
        status: run?.status ?? "idle",
        run: run === null ? null : runSummary(run),
        recentRuns: runsNewestFirst(records.runs).slice(0, RECENT_RUNS).map(runSummary),
        pendingRequests: pending.map((request) =>
          pendingRequestSummary(request, records.turnItems),
        ),
      };
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          const durationMs = performance.now() - started;
          yield* Effect.annotateCurrentSpan({ durationMs, ...stages, loadedRunCount });
          if (durationMs <= 2000) return;
          const runCount =
            threadId === null
              ? null
              : yield* store.threadRunCount(threadId).pipe(Effect.orElseSucceed(() => null));
          yield* Effect.logWarning("Slow native owner lookup", {
            durationMs,
            stages,
            driver: options.driver ?? null,
            view: options.view ?? "full",
            nativeIdPrefix: nativeId.slice(0, 8),
            runCount,
            loadedRunCount,
          });
        }),
      ),
      NodeSqliteClient.foregroundReads,
    );
  });
  return { detail, summarize, byNative };
});

export class ControlThreadRead extends Context.Service<
  ControlThreadRead,
  Effect.Success<typeof make>
>()("t3/ardud/control/ControlThreadRead") {}

export const layer = Layer.effect(ControlThreadRead, make);
