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

import type { OrchestrationV2ProviderFailure } from "@t3tools/contracts";
import { latestExecutedRun, latestRootProviderFailure } from "@t3tools/shared/orchestrationV2ThreadError";

import * as ThreadLaunchService from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { type ControlThreadState, stateFromShell } from "../../control/model.ts";

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
  readonly prs: ReadonlyArray<KanbanThreadPr>;
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
  /** Switch the thread to this model for the turn the message starts. */
  readonly model?: ModelSelection;
}

/**
 * The few thread operations the board needs. Every message is delivered as a
 * steer when a run is live, otherwise it starts a turn; nothing is queued.
 */
export interface KanbanThreadsShape {
  readonly view: (threadId: ThreadId) => Effect.Effect<KanbanThreadView | null>;
  /** The root provider failure of the thread's latest executed run, if that run failed. */
  readonly lastFailure: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationV2ProviderFailure | null>;
  readonly launch: (input: KanbanLaunchInput) => Effect.Effect<ThreadId, KanbanThreadError>;
  readonly send: (input: KanbanSendInput) => Effect.Effect<void, KanbanThreadError>;
  readonly interrupt: (threadId: ThreadId, reason: string) => Effect.Effect<void>;
}

export class KanbanThreads extends Context.Service<KanbanThreads, KanbanThreadsShape>()(
  "t3/ardud/kanban/engine/threads/KanbanThreads",
) {}

const commandId = (prefix: string) => CommandId.make(`kanban:${prefix}:${NodeCrypto.randomUUID()}`);

const detailOf = (error: unknown) =>
  error instanceof Error ? error.message : typeof error === "string" ? error : String(error);

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const launcher = yield* ThreadLaunchService.ThreadLaunchService;

  const view: KanbanThreadsShape["view"] = (threadId) =>
    threads.getThreadShell(threadId).pipe(
      Effect.map((shell): KanbanThreadView | null =>
        shell === null || shell.deletedAt !== null
          ? null
          : {
              threadId: shell.id,
              projectId: shell.projectId,
              title: shell.title,
              state: stateFromShell(shell),
              updatedAt: DateTime.formatIso(shell.updatedAt),
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
      Effect.catchCause(() => Effect.succeed(null)),
    );

  const lastFailure: KanbanThreadsShape["lastFailure"] = (threadId) =>
    threads.getThreadRecords(threadId, ["runs", "turnItems"], { turnItemTypes: ["error"] }).pipe(
      Effect.map((records) =>
        latestRootProviderFailure(latestExecutedRun(records.runs), records.turnItems),
      ),
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
      const id = NodeCrypto.randomUUID();
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

  return KanbanThreads.of({ view, lastFailure, launch, send, interrupt });
});

export const layer = Layer.effect(KanbanThreads, make);
