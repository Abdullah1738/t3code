/**
 * `imessage_send`: an iMessage thread (or any subagent or delegated child
 * under one) texts its chat through the bridge CLI. The thread's final
 * message is not sent in tool-reply mode, so this is how it replies.
 */
import {
  type ImessageSendMcpInput,
  type ImessageSendMcpResult,
  OrchestratorMcpFailure,
  type OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ControlStore from "../control/ControlStore.ts";
import * as ImessageBridgeCli from "./ImessageBridgeCli.ts";
import { bridgeCliArgs, bridgeCliError, defaultSendKey, parseBridgeAck } from "./send.ts";

export const IMESSAGE_ORIGIN = "imessage";
export const NOT_IMESSAGE_THREAD = "imessage_send only works in iMessage chat threads.";
/** Parent links walked from the caller, at most. */
const MAX_ANCESTORS = 32;

export class ImessageSendService extends Context.Service<
  ImessageSendService,
  {
    readonly send: (
      scope: McpInvocationScope,
      input: ImessageSendMcpInput,
    ) => Effect.Effect<ImessageSendMcpResult, OrchestratorMcpFailure>;
  }
>()("t3/ardud/imessage/ImessageSendService") {}

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

/**
 * The thread whose chat a caller serves: its root when the root has the
 * `imessage` origin. A root with no origin row falls back to the nearest
 * thread on the way up that has one (as the control API reads origins).
 * `null` when that origin is not `imessage`.
 */
export const imessageThreadOf = (
  chain: ReadonlyArray<OrchestrationV2ThreadShell>,
  rootThreadId: string,
  origins: ReadonlyMap<string, string>,
): string | null => {
  const rootOrigin = origins.get(rootThreadId);
  if (rootOrigin !== undefined) return rootOrigin === IMESSAGE_ORIGIN ? rootThreadId : null;
  for (const shell of chain) {
    const origin = origins.get(shell.id);
    if (origin !== undefined) return origin === IMESSAGE_ORIGIN ? shell.id : null;
  }
  return null;
};

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const store = yield* ControlStore.ControlStore;
  const bridge = yield* ImessageBridgeCli.ImessageBridgeCli;

  const shellOf = (threadId: string) =>
    threads
      .getThreadShell(ThreadId.make(threadId))
      .pipe(
        Effect.mapError(() => failure("orchestration_error", `Could not read thread ${threadId}.`)),
      );

  /** The caller, then its parents up to the top, nearest first. */
  const ancestry = Effect.fn("ImessageSendService.ancestry")(function* (threadId: string) {
    const caller = yield* shellOf(threadId);
    if (caller === null || caller.deletedAt !== null) {
      return yield* failure("thread_not_found", `Calling thread ${threadId} was not found.`);
    }
    const chain: Array<OrchestrationV2ThreadShell> = [caller];
    const seen = new Set<string>([caller.id]);
    let parentId = caller.lineage.parentThreadId;
    while (parentId !== null && chain.length <= MAX_ANCESTORS && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = yield* shellOf(parentId);
      if (parent === null) break;
      chain.push(parent);
      parentId = parent.lineage.parentThreadId;
    }
    return chain;
  });

  const send = Effect.fn("ImessageSendService.send")(function* (
    scope: McpInvocationScope,
    input: ImessageSendMcpInput,
  ) {
    const caller = scope.thread;
    if (caller === undefined) {
      return yield* failure(
        "thread_credential_required",
        "imessage_send texts the chat of the calling T3 thread, so it needs an agent running inside T3 Code.",
      );
    }
    const text = input.text !== undefined && input.text.trim().length > 0 ? input.text : undefined;
    if (text === undefined && input.file === undefined) {
      return yield* failure("invalid_request", "Pass `text`, `file`, or both.");
    }

    const chain = yield* ancestry(caller.threadId);
    const self = chain[0]!;
    const rootThreadId = self.lineage.rootThreadId;
    const origins = yield* store
      .getOrigins([rootThreadId, ...chain.map((shell) => shell.id)])
      .pipe(
        Effect.mapError(() => failure("orchestration_error", "Could not read thread origins.")),
      );
    const chatThreadId = imessageThreadOf(chain, rootThreadId, origins);
    if (chatThreadId === null) return yield* failure("capability_denied", NOT_IMESSAGE_THREAD);

    const request = {
      text,
      file: input.file,
      to: input.to,
      effect: input.effect,
      session: input.session ?? chatThreadId,
      key:
        input.key ??
        defaultSendKey({
          threadId: caller.threadId,
          providerSessionId: caller.providerSessionId,
          runId: self.activeRunId,
          to: input.to,
          text,
          file: input.file,
        }),
    };
    const kind = request.file === undefined ? "send" : "file";
    const result = yield* bridge
      .run(bridgeCliArgs(request))
      .pipe(Effect.mapError((error) => failure("orchestration_error", error.reason)));
    if (result.timedOut) {
      return yield* failure(
        "orchestration_error",
        "The iMessage bridge CLI timed out after 30s; the message may still have been queued. Retrying this same call will not send it twice.",
      );
    }
    if (result.exitCode !== 0) {
      return yield* failure("orchestration_error", bridgeCliError(result.stderr, result.exitCode));
    }
    const ack = parseBridgeAck(result.stdout, kind);
    if (ack === undefined) {
      return yield* failure(
        "orchestration_error",
        "The iMessage bridge CLI returned an unexpected reply; the message may still have been queued.",
      );
    }
    return { id: ack.id, created: ack.created, chat: input.to ?? "owner" };
  });

  return ImessageSendService.of({ send });
});

export const layer = Layer.effect(ImessageSendService, make);
