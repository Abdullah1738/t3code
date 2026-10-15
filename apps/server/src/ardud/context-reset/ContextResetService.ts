import {
  CommandId,
  type ContextResetMcpInput,
  type ContextResetMcpResult,
  isOrchestrationV2WorkActive,
  MessageId,
  OrchestratorMcpFailure,
  ProviderSessionId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type {
  McpInvocationScope,
  McpThreadInvocationScope,
} from "../../mcp/McpInvocationContext.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";

export class ContextResetService extends Context.Service<
  ContextResetService,
  {
    readonly reset: (
      scope: McpInvocationScope,
      input: ContextResetMcpInput,
    ) => Effect.Effect<ContextResetMcpResult, OrchestratorMcpFailure>;
  }
>()("t3/ardud/context-reset/ContextResetService") {}

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

const errorMessage = (error: unknown) =>
  typeof error === "object" && error !== null && "message" in error
    ? String(error.message)
    : String(error);

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;

  // One reset per thread at a time: a second call would queue a second note
  // and mint a second fresh provider thread.
  const resetsInFlight = new Set<string>();

  const requireThreadScope = (scope: McpInvocationScope) =>
    scope.thread === undefined
      ? Effect.fail(
          failure(
            "thread_credential_required",
            "t3_context_reset resets the calling T3 thread, so it needs an agent running inside T3 Code.",
          ),
        )
      : Effect.succeed(scope as McpThreadInvocationScope);

  const requireCapability = (scope: McpInvocationScope) =>
    scope.capabilities.has("orchestration")
      ? Effect.void
      : Effect.fail(
          failure("capability_denied", "This MCP credential does not grant orchestration."),
        );

  const ids = (scope: McpThreadInvocationScope) =>
    crypto.randomUUIDv4().pipe(
      Effect.map((uuid) => {
        const part = (kind: string, operation: string) =>
          [kind, "mcp", encodeURIComponent(scope.thread.providerSessionId), operation, uuid].join(
            ":",
          );
        return {
          noteCommandId: CommandId.make(part("command", "context-reset-note")),
          noteMessageId: MessageId.make(part("message", "context-reset-note")),
          detachCommandId: CommandId.make(part("command", "context-reset-detach")),
        };
      }),
      Effect.orDie,
    );

  const performReset = Effect.fn("ContextResetService.performReset")(function* (
    scope: McpThreadInvocationScope,
    input: ContextResetMcpInput,
  ) {
    const threadId = scope.thread.threadId;
    const projection = yield* threadManagement
      .getThreadRecords(threadId, ["subagents", "providerThreads"])
      .pipe(
        Effect.mapError((error) =>
          error._tag === "OrchestratorProjectionError"
            ? failure("thread_not_found", `Thread '${threadId}' was not found.`)
            : failure(
                "orchestration_error",
                `Unable to read thread ${threadId}: ${errorMessage(error)}`,
              ),
        ),
      );
    if (projection.thread.deletedAt !== null) {
      return yield* failure("thread_not_found", `Thread '${threadId}' was not found.`);
    }
    if (projection.thread.archivedAt !== null) {
      return yield* failure("thread_not_sendable", `Thread '${threadId}' is archived.`);
    }

    // A fresh session cannot take over background work the old one started:
    // its results would land in a session that no longer exists.
    const activeSubagents = projection.subagents.filter((subagent) =>
      isOrchestrationV2WorkActive(subagent.status),
    );
    const activeProviderThread = projection.providerThreads.find(
      (providerThread) => providerThread.id === projection.thread.activeProviderThreadId,
    );
    const pendingBackgroundTasks = activeProviderThread?.pendingBackgroundTasks ?? [];
    if (activeSubagents.length > 0 || pendingBackgroundTasks.length > 0) {
      const count = activeSubagents.length + pendingBackgroundTasks.length;
      return yield* failure(
        "invalid_request",
        `This thread still has ${count} running background task${count === 1 ? "" : "s"}. Wait for them to finish (or stop them) before resetting context.`,
      );
    }

    const { noteCommandId, noteMessageId, detachCommandId } = yield* ids(scope);

    // Queue the note first: it runs on a fresh provider thread once the
    // current turn ends, so a failed detach below still resets context.
    const sent = yield* threadManagement
      .sendToThread({
        projectId: projection.thread.projectId,
        commandId: noteCommandId,
        threadId,
        messageId: noteMessageId,
        text: input.note,
        attachments: [],
        mode: "queue",
        contextReset: true,
        createdBy: "agent",
        creationSource: "mcp",
      })
      .pipe(
        Effect.mapError((error) =>
          failure("orchestration_error", `Unable to queue the resume note: ${errorMessage(error)}`),
        ),
      );

    const detached = yield* threadManagement
      .dispatch({
        type: "provider-session.detach",
        commandId: detachCommandId,
        threadId,
        providerSessionId: ProviderSessionId.make(scope.thread.providerSessionId),
        reason: "Context reset.",
      })
      .pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logWarning("context reset could not detach the provider session", {
            threadId,
            cause,
          }).pipe(Effect.as(false)),
        ),
      );

    const result: ContextResetMcpResult = {
      delivery: sent.delivery,
      note: detached
        ? "Context reset scheduled. Your current turn ends now; a fresh session starts with the resume note as its only context. Do not do any more work in this turn."
        : "Resume note queued for a fresh session, but the current session could not be ended. End your turn now; the fresh session starts when it ends.",
    };
    return result;
  });

  const reset: ContextResetService["Service"]["reset"] = Effect.fn("ContextResetService.reset")(
    function* (callerScope, input) {
      yield* requireCapability(callerScope);
      const scope = yield* requireThreadScope(callerScope);
      const threadId = scope.thread.threadId;
      return yield* Effect.uninterruptibleMask((restore) => {
        if (resetsInFlight.has(threadId)) {
          return Effect.fail(
            failure("invalid_request", "A context reset for this thread is already in progress."),
          );
        }
        resetsInFlight.add(threadId);
        return restore(performReset(scope, input)).pipe(
          Effect.ensuring(Effect.sync(() => resetsInFlight.delete(threadId))),
        );
      });
    },
  );

  return ContextResetService.of({ reset });
});

export const layer: Layer.Layer<
  ContextResetService,
  never,
  Crypto.Crypto | ThreadManagementService.ThreadManagementService
> = Layer.effect(ContextResetService, make);
