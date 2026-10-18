import {
  type KnockId,
  MissionError,
  type MissionId,
  type MissionMessageId,
  type RoomId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
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

/** How long a send waits for the guard to come up before it is refused. */
const STARTUP_WAIT = Duration.seconds(10);
const STARTUP_POLL = Duration.millis(50);

// The scheduler is built below the missions layer, so the guard reaches every
// send path through this one late-bound slot rather than a service tag. The
// router layer installs it for the server's lifetime and has one owner at a
// time. A server that runs missions marks the guard required when its router
// module loads; from then on a send with no guard installed waits briefly
// and is refused rather than delivered. Without the mark (no missions) every
// send passes, which is the pre-missions behaviour.
let installed: SendGuard | null = null;
let required = false;

/** Called once by the server that runs missions, before any send path can fire. */
export const requireSendGuard = (): void => {
  required = true;
};

const awaitInstalled: Effect.Effect<SendGuard, MissionError> = Effect.suspend(() => {
  if (installed !== null) return Effect.succeed(installed);
  return Effect.sleep(STARTUP_POLL).pipe(Effect.andThen(Effect.suspend(() => awaitInstalled)));
}).pipe(
  Effect.timeoutOrElse({
    duration: STARTUP_WAIT,
    orElse: () =>
      Effect.fail(
        new MissionError({
          code: "conflict",
          detail: "The mission send guard is not running, so nothing is delivered into threads.",
        }),
      ),
  }),
);

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
  Effect.suspend(() => {
    if (installed !== null) return installed(request);
    if (!required) return Effect.succeed(PASS);
    return awaitInstalled.pipe(Effect.flatMap((guard) => guard(request)));
  });

/**
 * Installs the guard for the scope. There is one owner at a time: a second
 * install while one is live is a wiring bug and dies rather than silently
 * replacing the first (whose release would then leave sends unguarded).
 */
export const installSendGuard = (guard: SendGuard): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.suspend(() => {
      if (installed !== null) {
        return Effect.die(new Error("The mission send guard is already installed."));
      }
      installed = guard;
      return Effect.void;
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
