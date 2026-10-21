import {
  CommandId,
  MessageId,
  MissionError,
  type OrchestrationV2UserInputQuestion,
  type ProviderApprovalDecision,
  RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { stateFromShell } from "../../control/model.ts";
import { optionalAuthorityStore } from "../guard/authority.ts";
import { forkCreator } from "../guard/forks.ts";
import type { GuardPrincipal } from "../guard/principal.ts";
import type { PendingApproval } from "./leadApprovals.ts";
import type { ThreadActivity } from "./model.ts";

/** What the router needs to know about a thread. */
export interface ThreadFacts {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly activity: ThreadActivity;
  readonly parentThreadId: ThreadId | null;
  readonly rootThreadId: ThreadId | null;
  /** Archived threads take no deliveries. */
  readonly archived: boolean;
}

/**
 * The router's only way to touch real threads: read their state and put a
 * line in their queue. Tests use a fake so nothing they run reaches a thread.
 * Sends made here are internal (doorbell wakes, owner-forwarded knocks) and
 * never pass through the send guard.
 */
export class RouterThreads extends Context.Service<
  RouterThreads,
  {
    readonly facts: (threadId: ThreadId) => Effect.Effect<ThreadFacts | null, MissionError>;
    /**
     * Who made the thread, as the guard recorded it when the thread was
     * forked. `null` when a successful read found nothing (legacy forks):
     * lineage alone never makes such a thread a mission member. A record
     * that cannot be read fails, and membership fails with it.
     */
    readonly creator: (threadId: ThreadId) => Effect.Effect<GuardPrincipal | null, MissionError>;
    /** Queues `text` in the thread. `key` makes retries land once. */
    readonly send: (input: {
      readonly threadId: ThreadId;
      readonly text: string;
      readonly key: string;
      readonly asOwner: boolean;
    }) => Effect.Effect<void, MissionError>;
    // --- routing additions ---
    /**
     * A question the thread is waiting on: its questions (empty when the
     * question item is not recorded yet), or null once it is answered or gone.
     */
    readonly question: (input: {
      readonly threadId: ThreadId;
      readonly requestId: string;
    }) => Effect.Effect<ReadonlyArray<OrchestrationV2UserInputQuestion> | null, MissionError>;
    // --- end routing additions ---
    // --- permissions additions ---
    /**
     * A permission request the thread is waiting on, as far as it is
     * recorded, or null once it is answered or gone (or it is a question).
     */
    readonly approval: (input: {
      readonly threadId: ThreadId;
      readonly requestId: string;
    }) => Effect.Effect<PendingApproval | null, MissionError>;
    /**
     * Answers a pending permission request. `key` makes retries land once; a
     * request that is no longer pending fails `conflict`.
     */
    readonly respondApproval: (input: {
      readonly threadId: ThreadId;
      readonly requestId: string;
      readonly decision: ProviderApprovalDecision;
      readonly key: string;
    }) => Effect.Effect<void, MissionError>;
    // --- end permissions additions ---
  }
>()("t3/ardud/missions/router/ports/RouterThreads") {}

const threadFailure = (what: string) => (error: unknown) =>
  new MissionError({
    code: "conflict",
    detail: `${what}: ${error instanceof Error ? error.message : String(error)}`,
  });

export const threadsLayer = Layer.effect(
  RouterThreads,
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const authority = yield* optionalAuthorityStore;
    const shellOf = (threadId: ThreadId) =>
      threads
        .getThreadShell(threadId)
        .pipe(Effect.mapError(threadFailure("Cannot read the thread")));
    return RouterThreads.of({
      facts: (threadId) =>
        shellOf(threadId).pipe(
          Effect.map((shell) =>
            shell === null
              ? null
              : {
                  threadId,
                  title: shell.title,
                  activity:
                    shell.deletedAt !== null && shell.deletedAt !== undefined
                      ? "missing"
                      : stateFromShell(shell),
                  parentThreadId: shell.lineage.parentThreadId,
                  rootThreadId: shell.lineage.rootThreadId,
                  archived: shell.archivedAt !== null && shell.archivedAt !== undefined,
                },
          ),
        ),
      creator: (threadId) => forkCreator(authority, threadId),
      send: ({ threadId, text, key, asOwner }) =>
        Effect.gen(function* () {
          const shell = yield* shellOf(threadId);
          if (shell === null) {
            return yield* new MissionError({ code: "not-found", detail: `No thread ${threadId}.` });
          }
          const id = `ardud-missions:${key}`;
          yield* threads
            .sendToThread({
              projectId: shell.projectId,
              commandId: CommandId.make(id),
              messageId: MessageId.make(id),
              threadId,
              text,
              attachments: [],
              mode: "queue",
              createdBy: asOwner ? "user" : "system",
              creationSource: "server",
            })
            .pipe(Effect.mapError(threadFailure("Cannot send to the thread")));
        }),
      question: Effect.fn("RouterThreads.question")(function* ({
        threadId,
        requestId,
      }: {
        readonly threadId: ThreadId;
        readonly requestId: string;
      }) {
        const shell = yield* shellOf(threadId);
        if (shell === null) return null;
        const records = yield* threads
          .getProjectThreadRecords(
            { projectId: shell.projectId, threadId },
            ["runtimeRequests", "turnItems"],
            { turnItemTypes: ["user_input_request"] },
          )
          .pipe(Effect.mapError(threadFailure("Cannot read the thread's question")));
        const pending = records.runtimeRequests.some(
          (request) =>
            request.id === requestId &&
            request.kind === "user_input" &&
            request.status === "pending",
        );
        const item = records.turnItems.find(
          (each) => each.type === "user_input_request" && each.requestId === requestId,
        );
        if (!pending) return null;
        return item?.type === "user_input_request" ? item.questions : [];
      }),
      // --- permissions additions ---
      approval: Effect.fn("RouterThreads.approval")(function* ({
        threadId,
        requestId,
      }: {
        readonly threadId: ThreadId;
        readonly requestId: string;
      }) {
        const shell = yield* shellOf(threadId);
        if (shell === null) return null;
        const records = yield* threads
          .getProjectThreadRecords(
            { projectId: shell.projectId, threadId },
            ["runtimeRequests", "turnItems"],
            { turnItemTypes: ["approval_request"] },
          )
          .pipe(Effect.mapError(threadFailure("Cannot read the thread's permission request")));
        const request = records.runtimeRequests.find(
          (each) =>
            each.id === requestId && each.kind !== "user_input" && each.status === "pending",
        );
        if (request === undefined) return null;
        const item = records.turnItems.find(
          (each) => each.type === "approval_request" && each.requestId === requestId,
        );
        return {
          requestKind: request.kind,
          title: item?.title ?? null,
          prompt: item?.type === "approval_request" ? (item.prompt ?? null) : null,
          options: item?.type === "approval_request" ? (item.options ?? null) : null,
        } satisfies PendingApproval;
      }),
      respondApproval: ({ threadId, requestId, decision, key }) =>
        threads
          .dispatch({
            type: "runtime-request.respond",
            commandId: CommandId.make(`ardud-missions:${key}`),
            threadId,
            requestId: RuntimeRequestId.make(requestId),
            decision,
            createdBy: "agent",
          })
          .pipe(
            Effect.asVoid,
            Effect.mapError(threadFailure("Cannot answer the thread's permission request")),
          ),
      // --- end permissions additions ---
    });
  }),
);
