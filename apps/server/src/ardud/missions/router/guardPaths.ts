/**
 * Thin adapters between each transport that can put text into a thread and
 * the one send guard. Every path builds its sender from its own
 * authenticated context (MCP invocation scope, control-API session,
 * scheduled task row) and calls `guardSend`; nothing here reads identity
 * from a request body.
 */
import { OrchestratorMcpFailure, type MissionProvenance, type ThreadId } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import {
  recordedSender,
  sessionPrincipal,
  type GuardPrincipal,
  type WsSession,
} from "../guard/principal.ts";
import { guardRefusal, guardSend, type SendGuardOutcome } from "./guardHook.ts";
import type { SendPath, SendSender } from "./model.ts";

type Refusal = Exclude<SendGuardOutcome, { readonly _tag: "pass" }>;

/** The send was not delivered: it was routed into a room or held as a knock. */
export class SendRefused extends Data.TaggedError("SendRefused")<{
  readonly message: string;
  readonly outcome: Refusal;
}> {}

/** The guard itself failed; the send is not delivered (fail closed). */
export class SendGuardFailed extends Data.TaggedError("SendGuardFailed")<{
  readonly message: string;
}> {}

/**
 * One guarded send as `from`. Callers that already hold a principal (WS
 * session, schedule authority, pull request watch initiator) use this
 * directly; the adapters below build theirs from their transport.
 */
export const guardSender = (input: {
  readonly path: SendPath;
  readonly targetThreadId: ThreadId;
  readonly from: SendSender;
  readonly text: string;
  readonly requestKey: string;
}): Effect.Effect<void, SendRefused | SendGuardFailed> =>
  decide(input.path, input.targetThreadId, input.from, input.text, input.requestKey);

const decide = (
  path: SendPath,
  targetThreadId: ThreadId,
  from: SendSender,
  text: string,
  requestKey: string,
): Effect.Effect<void, SendRefused | SendGuardFailed> =>
  guardSend({ path, targetThreadId, from, text, requestKey }).pipe(
    Effect.mapError(
      (error) => new SendGuardFailed({ message: `Send guard failed: ${error.detail}` }),
    ),
    Effect.flatMap((outcome) =>
      outcome._tag === "pass"
        ? Effect.void
        : Effect.fail(new SendRefused({ message: guardRefusal(outcome, targetThreadId), outcome })),
    ),
  );

/** Who an MCP call comes from: the calling thread, else the OAuth client. */
export interface McpSendCaller {
  readonly thread: { readonly id: ThreadId; readonly title: string } | undefined;
  readonly client: { readonly sessionId: string; readonly label: string } | undefined;
}

export const mcpSender = (caller: McpSendCaller): GuardPrincipal =>
  caller.thread !== undefined
    ? { _tag: "thread", threadId: caller.thread.id, title: caller.thread.title }
    : {
        _tag: "mcp-client",
        sessionId: caller.client?.sessionId ?? "unknown",
        label: caller.client?.label ?? "unidentified MCP caller",
      };

/**
 * MCP paths (`t3_thread_send`, `t3_thread_send_attachments`, `t3_queue_edit`,
 * `t3_thread_merge_back`, `t3_pending_request_respond`, schedule edits).
 * A refusal becomes `capability_denied` with the explanation.
 */
export const guardMcpWrite = (input: {
  readonly path: SendPath;
  readonly targetThreadId: ThreadId;
  readonly caller: McpSendCaller;
  readonly text: string;
  readonly requestKey: string;
}): Effect.Effect<void, OrchestratorMcpFailure> =>
  decide(
    input.path,
    input.targetThreadId,
    mcpSender(input.caller),
    input.text,
    input.requestKey,
  ).pipe(
    Effect.mapError(
      (error) =>
        new OrchestratorMcpFailure({
          code: error._tag === "SendRefused" ? "capability_denied" : "orchestration_error",
          message: error.message,
        }),
    ),
  );

/** Control-API sends. Coord's pump marks its wakes with `coord:` request ids. */
export const controlSendPath = (clientRequestId: string | undefined): SendPath =>
  clientRequestId?.startsWith("coord:") === true ? "coord-shim" : "control-api";

/**
 * A control session's send. `owner` is set only when the iMessage bridge
 * relays an inbound that verified as the owner's or Moni's (see
 * `guard/imessage.ts`); every other control send is the session itself,
 * named by its component when it has one (`sessionPrincipal`).
 */
export const guardControlSend = (input: {
  readonly session: WsSession;
  readonly owner?: MissionProvenance | null | undefined;
  readonly targetThreadId: ThreadId;
  readonly text: string;
  readonly commandId: string;
  readonly clientRequestId: string | undefined;
}): Effect.Effect<void, SendRefused | SendGuardFailed> =>
  decide(
    controlSendPath(input.clientRequestId),
    input.targetThreadId,
    input.owner == null
      ? sessionPrincipal(input.session)
      : { _tag: "owner", provenance: input.owner },
    input.text,
    input.commandId,
  );

/**
 * A scheduled task firing into its bound thread, speaking as whoever
 * authorized it (see `recordedSender`): the invoker for a manual run, else
 * the recorded authority. A task with nothing recorded is never self.
 */
export const guardScheduledRun = (input: {
  readonly task: { readonly id: string; readonly title: string };
  readonly authority: GuardPrincipal | null;
  readonly targetThreadId: ThreadId;
  readonly text: string;
  readonly commandId: string;
}): Effect.Effect<void, SendRefused | SendGuardFailed> =>
  decide(
    "scheduled-task",
    input.targetThreadId,
    recordedSender({
      authority: input.authority,
      targetThreadId: input.targetThreadId,
      scheduledTaskId: input.task.id,
      title: input.task.title,
    }),
    input.text,
    input.commandId,
  );
