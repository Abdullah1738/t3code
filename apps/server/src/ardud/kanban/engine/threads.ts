// @effect-diagnostics nodeBuiltinImport:off - command ids only need a random UUID.
import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  type ModelSelection,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type {
  OrchestrationV2ProviderFailure,
  OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { latestExecutedRun, latestRootProviderFailure } from "@t3tools/shared/orchestrationV2ThreadError";

import * as ThreadLaunchService from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { type ControlThreadState, stateFromRunStatus } from "../../control/model.ts";

export class KanbanThreadError extends Schema.TaggedError<KanbanThreadError>()(
  "KanbanThreadError",
  { operation: Schema.String, detail: Schema.String },
) {}

const isKanbanThreadError = Schema.is(KanbanThreadError);

export interface KanbanThreadPr {
  readonly url: string;
  readonly title: string | null;
  readonly state: "open" | "draft" | "merged" | "closed";
}

export interface KanbanThreadView {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly state: ControlThreadState;
  readonly updatedAt: string;
  /** When the thread itself last did something: its open question, else its last finished run. updatedAt also moves on shared provider-session updates. */
  readonly quietSince: string;
  /** When the current run started, or null when no run is active. */
  readonly runStartedAt: string | null;
  /** Its own subagents and background tasks still running after its turn ended. Pull-request watches don't count: they never end. */
  readonly backgroundWork: number;
  readonly prs: ReadonlyArray<KanbanThreadPr>;
  readonly archived: boolean;
}

export interface KanbanLaunchInput {
  /** Stable per logical launch so a retry finds the same thread. */
  readonly key: string;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly model: ModelSelection;
  readonly text: string;
}

export interface KanbanSendInput {
  readonly threadId: ThreadId;
  readonly text: string;
  /** Stable per logical send when a retry must not deliver a second message. */
  readonly key?: string;
  /** Switch the thread to this model for the turn the message starts. */
  readonly model?: ModelSelection;
}

/**
 * The few thread operations the board needs. Every message is delivered as a
 * steer when a run is live, otherwise it starts a turn; nothing is queued.
 */
export interface KanbanThreadsShape {
  readonly view: (threadId: ThreadId) => Effect.Effect<KanbanThreadView | null>;
  /** Like view, but a failed read fails: null means the thread is gone. */
  readonly find: (threadId: ThreadId) => Effect.Effect<KanbanThreadView | null, KanbanThreadError>;
  /** The model the thread runs now, or null when the thread is gone. */
  readonly model: (threadId: ThreadId) => Effect.Effect<ModelSelection | null>;
  /** The root provider failure of the thread's latest executed run, if that run failed. */
  // runId names the executed run, so a repeated notification of the same run is recognised.
  readonly lastFailure: (
    threadId: ThreadId,
  ) => Effect.Effect<
    | (OrchestrationV2ProviderFailure & {
        readonly runId?: string | null;
        readonly model?: ModelSelection | null;
      })
    | null
  >;
  readonly launch: (input: KanbanLaunchInput) => Effect.Effect<ThreadId, KanbanThreadError>;
  readonly send: (input: KanbanSendInput) => Effect.Effect<void, KanbanThreadError>;
  /** Switches an open thread to this model now; does nothing when it already runs it. */
  readonly setModel: (threadId: ThreadId, model: ModelSelection) => Effect.Effect<void, KanbanThreadError>;
  readonly interrupt: (threadId: ThreadId, reason: string) => Effect.Effect<void>;
}

export class KanbanThreads extends Context.Service<KanbanThreads, KanbanThreadsShape>()(
  "t3/ardud/kanban/engine/threads/KanbanThreads",
) {}

const commandId = (prefix: string) => CommandId.make(`kanban:${prefix}:${NodeCrypto.randomUUID()}`);

const detailOf = (error: unknown) =>
  error instanceof Error ? error.message : typeof error === "string" ? error : String(error);

/**
 * The state and quiet-since of a thread from the shell fields that matter here.
 * An async question (blocking false) doesn't stop the run, so it counts as no question at all.
 */
export const viewStateOf = (
  shell: Pick<
    OrchestrationV2ThreadShell,
    | "pendingRuntimeRequest"
    | "activityRunStatus"
    | "status"
    | "updatedAt"
    | "latestRunCompletedAt"
  >,
): { readonly state: ControlThreadState; readonly quietSince: DateTime.Utc } => {
  const request = shell.pendingRuntimeRequest;
  const blocking = request !== null && request.blocking !== false ? request : null;
  const state = stateFromRunStatus(shell.activityRunStatus ?? shell.status, blocking !== null);
  const quietSince = blocking?.createdAt ?? shell.latestRunCompletedAt ?? shell.updatedAt;
  return { state, quietSince };
};

/** Background work that still runs for the thread once its turn ended. */
export const backgroundWorkOf = (
  shell: Pick<OrchestrationV2ThreadShell, "pendingBackgroundTasks">,
): number =>
  (shell.pendingBackgroundTasks ?? []).filter(
    (task) =>
      !task.taskId.startsWith("pull-request-watch:") && backgroundWorkHoldsCompletion([task]),
  ).length;

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const launcher = yield* ThreadLaunchService.ThreadLaunchService;

  const find: KanbanThreadsShape["find"] = (threadId) =>
    threads.getThreadShell(threadId).pipe(
      Effect.map((shell): KanbanThreadView | null =>
        shell === null || shell.deletedAt !== null
          ? null
          : {
              threadId: shell.id,
              projectId: shell.projectId,
              title: shell.title,
              state: viewStateOf(shell).state,
              updatedAt: DateTime.formatIso(shell.updatedAt),
              quietSince: DateTime.formatIso(viewStateOf(shell).quietSince),
              runStartedAt: shell.activityRunStartedAt
                ? DateTime.formatIso(shell.activityRunStartedAt)
                : null,
              backgroundWork: backgroundWorkOf(shell),
              archived: shell.archivedAt !== null,
              prs: (shell.pullRequests ?? []).map((pr) => ({
                url: pr.url,
                title: pr.snapshot?.title ?? null,
                state:
                  pr.snapshot === null
                    ? "open"
                    : pr.snapshot.state === "open" && pr.snapshot.isDraft
                      ? "draft"
                      : pr.snapshot.state,
              })),
            },
      ),
      Effect.mapError(
        (error) => new KanbanThreadError({ operation: "view", detail: detailOf(error) }),
      ),
    );

  const view: KanbanThreadsShape["view"] = (threadId) =>
    find(threadId).pipe(Effect.catchCause(() => Effect.succeed(null)));

  const model: KanbanThreadsShape["model"] = (threadId) =>
    threads.getThreadShell(threadId).pipe(
      Effect.map((shell) =>
        shell === null || shell.deletedAt !== null ? null : shell.modelSelection,
      ),
      Effect.catchCause(() => Effect.succeed(null)),
    );

  const lastFailure: KanbanThreadsShape["lastFailure"] = (threadId) =>
    threads.getThreadRecords(threadId, ["runs", "turnItems"], { turnItemTypes: ["error"] }).pipe(
      Effect.map((records) => {
        const run = latestExecutedRun(records.runs);
        const failure = latestRootProviderFailure(run, records.turnItems);
        // A failed run can leave no error item on its root node; it still counts as failed.
        if (failure === null && run?.status === "failed") {
          return {
            class: "unknown",
            message: "The run failed without an error message.",
            code: null,
            retryable: null,
            runId: run.id,
            model: run.modelSelection,
          } as OrchestrationV2ProviderFailure & {
            readonly runId?: string | null;
            readonly model?: ModelSelection | null;
          };
        }
        return failure === null
          ? null
          : { ...failure, runId: run?.id ?? null, model: run?.modelSelection ?? null };
      }),
      Effect.catchCause(() => Effect.succeed(null)),
    );

  const launch: KanbanThreadsShape["launch"] = (input) =>
    launcher
      .launch({
        commandId: CommandId.make(`kanban:launch:${input.key}`),
        projectId: input.projectId,
        title: input.title,
        modelSelection: input.model,
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        workspaceStrategy: { type: "root" },
        initialMessage: { text: input.text, attachments: [] },
        createdBy: "system",
        creationSource: "server",
      })
      .pipe(
        Effect.map((launched) => launched.threadId),
        Effect.mapError(
          (error) => new KanbanThreadError({ operation: "launch", detail: detailOf(error) }),
        ),
      );

  const send: KanbanThreadsShape["send"] = Effect.fn("KanbanThreads.send")(
    function* (input) {
      const shell = yield* threads.getThreadShell(input.threadId);
      if (shell === null || shell.deletedAt !== null) {
        return yield* new KanbanThreadError({ operation: "send", detail: "thread not found" });
      }
      const id = input.key ?? NodeCrypto.randomUUID();
      yield* threads.sendToThread({
        projectId: shell.projectId,
        commandId: CommandId.make(`kanban:send:${id}`),
        messageId: MessageId.make(`kanban:${id}`),
        threadId: input.threadId,
        text: input.text,
        attachments: [],
        ...(input.model ? { modelSelection: input.model } : {}),
        mode: "auto",
        createdBy: "system",
        creationSource: "server",
      });
    },
    Effect.mapError((error) =>
      isKanbanThreadError(error)
        ? error
        : new KanbanThreadError({ operation: "send", detail: detailOf(error) }),
    ),
  );

  const setModel: KanbanThreadsShape["setModel"] = Effect.fn("KanbanThreads.setModel")(
    function* (threadId, model) {
      const shell = yield* threads.getThreadShell(threadId);
      if (shell === null || shell.deletedAt !== null) {
        return yield* new KanbanThreadError({ operation: "setModel", detail: "thread not found" });
      }
      if (modelSelectionsEqual(shell.modelSelection, model)) return;
      yield* threads.dispatch({
        type: model.instanceId === shell.providerInstanceId ? "thread.model-selection.set" : "provider.switch",
        commandId: commandId("model"),
        threadId,
        modelSelection: model,
      });
    },
    Effect.mapError((error) =>
      isKanbanThreadError(error)
        ? error
        : new KanbanThreadError({ operation: "setModel", detail: detailOf(error) }),
    ),
  );

  const interrupt: KanbanThreadsShape["interrupt"] = Effect.fn("KanbanThreads.interrupt")(
    function* (threadId, reason) {
      const shell = yield* threads.getThreadShell(threadId);
      if (shell === null) return;
      yield* threads.interruptThread({
        projectId: shell.projectId,
        commandId: commandId("stop"),
        threadId,
        reason,
      });
    },
    Effect.catchCause(() => Effect.void),
  );

  return KanbanThreads.of({ view, find, model, lastFailure, launch, send, setModel, interrupt });
});

export const layer = Layer.effect(KanbanThreads, make);
