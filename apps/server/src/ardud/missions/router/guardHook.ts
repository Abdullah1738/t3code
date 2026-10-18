import type {
  KnockId,
  MissionError,
  MissionId,
  MissionMessageId,
  RoomId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import type { SendPath, SendSender } from "./model.ts";

/** One attempt to put text into a thread, as the transport saw it. */
export interface SendGuardRequest {
  readonly path: SendPath;
  readonly targetThreadId: ThreadId;
  /** Taken from the authenticated transport context, never from the request body. */
  readonly from: SendSender;
  readonly text: string;
  /** Stable per request (the transport's command id), so a retry is decided once. */
  readonly requestKey: string;
}

export type SendGuardOutcome =
  /** Deliver as asked. */
  | { readonly _tag: "pass" }
  /** Not delivered: posted as a room request addressed to the target, which gets a doorbell. */
  | {
      readonly _tag: "routed";
      readonly missionId: MissionId;
      readonly roomId: RoomId;
      readonly messageId: MissionMessageId;
      readonly seq: number;
    }
  /** Not delivered: held as a knock in the owner's inbox. */
  | { readonly _tag: "knocked"; readonly missionId: MissionId; readonly knockId: KnockId };

type SendGuard = (request: SendGuardRequest) => Effect.Effect<SendGuardOutcome, MissionError>;

const PASS: SendGuardOutcome = { _tag: "pass" };

// The scheduler is built below the missions layer, so the guard reaches every
// send path through this one late-bound slot rather than a service tag. The
// router layer installs it for the server's lifetime; without it every send
// passes, which is the pre-missions behaviour.
let installed: SendGuard | null = null;

/**
 * The single membership check every path into a thread calls before it
 * delivers: control API sends (and the coord shim riding on them),
 * `t3_thread_send`, `t3_thread_send_attachments`, `t3_queue_edit`,
 * `t3_thread_merge_back`, `t3_pending_request_respond`, scheduled task runs
 * and MCP edits of a bound schedule's prompt. Adapters live in
 * `guardPaths.ts`. Anything other than `pass` means: do not deliver.
 */
export const guardSend = (
  request: SendGuardRequest,
): Effect.Effect<SendGuardOutcome, MissionError> =>
  Effect.suspend(() => (installed === null ? Effect.succeed(PASS) : installed(request)));

export const installSendGuard = (guard: SendGuard): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      installed = guard;
    }),
    () =>
      Effect.sync(() => {
        if (installed === guard) installed = null;
      }),
  );

/** What a refused sender is told. */
export const guardRefusal = (
  outcome: Exclude<SendGuardOutcome, { readonly _tag: "pass" }>,
  targetThreadId: ThreadId,
): string =>
  outcome._tag === "routed"
    ? `Not delivered directly: thread ${targetThreadId} is in mission ${outcome.missionId}, so this was posted as request #${outcome.seq} in room ${outcome.roomId} addressed to it, and it will be woken to read it. Use mission_post for mission traffic.`
    : `Not delivered: thread ${targetThreadId} belongs to mission ${outcome.missionId}, and only the owner, its master and mission members can reach it. The message is waiting in the owner's inbox as knock ${outcome.knockId}.`;
