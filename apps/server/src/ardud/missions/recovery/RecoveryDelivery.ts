// @effect-diagnostics nodeBuiltinImport:off - checks whether the restart installer still has pending resumes.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { MissionError, MissionId, MissionProvenance, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { clipSummary } from "../asks/shared.ts";
import { actorOf } from "../core/provenance.ts";
import { sha256 } from "../router/hash.ts";
import * as MissionRouter from "../router/MissionRouter.ts";

export type RecoveryThreadReadiness = MissionRouter.ThreadReadiness;

/**
 * How recovery reaches threads. A member of the notice's mission gets it in
 * that mission's control room, with its doorbell; recovery names the mission,
 * so a thread in two missions hears each one's notice in that mission's room.
 * A thread no longer in that mission goes through the router's system
 * delivery (another mission's room, or a queued direct message).
 */
export class RecoveryDelivery extends Context.Service<
  RecoveryDelivery,
  {
    readonly readiness: (threadId: ThreadId) => Effect.Effect<RecoveryThreadReadiness>;
    /**
     * Idempotent per key on the route taken at call time. Recovery keeps its
     * own ledger per incident and thread, because a retry after a membership
     * change takes the other route.
     */
    readonly notify: (input: {
      readonly missionId: MissionId;
      readonly threadId: ThreadId;
      readonly text: string;
      readonly key: string;
    }) => Effect.Effect<MissionRouter.SystemNoticeOutcome, MissionError>;
    /** The cutover installer is still holding its own resume messages. */
    readonly installerPending: Effect.Effect<boolean>;
    /** The owner's zone for HH:MM in notices. */
    readonly timeZone: string;
  }
>()("t3/ardud/missions/recovery/RecoveryDelivery") {}

/** The component recovery posts as. */
export const PRODUCER = "missions-recovery";

const installerFile = () =>
  NodePath.join(
    process.env.T3_RESTART_SNAPSHOTS_DIR ??
      NodePath.join(NodeOS.homedir(), ".robob", "restart-snapshots"),
    "pending.json",
  );

const ownerTimeZone = () =>
  process.env.ARDUD_OWNER_TIME_ZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";

const PROVENANCE: MissionProvenance = { _tag: "system", component: PRODUCER };

/** Delivery over the router; tests supply the installer check and zone. */
export const layerWith = (options?: {
  readonly installerPending?: Effect.Effect<boolean>;
  readonly timeZone?: string;
}) =>
  Layer.effect(
    RecoveryDelivery,
    Effect.gen(function* () {
      const router = yield* MissionRouter.MissionRouter;
      const notify = (input: {
        readonly missionId: MissionId;
        readonly threadId: ThreadId;
        readonly text: string;
        readonly key: string;
      }) =>
        Effect.gen(function* () {
          const roomId = MissionRouter.controlRoomId(input.missionId);
          // Same post and key the router's own notice would make in this room.
          const posted = yield* router
            .relay({
              input: {
                missionId: input.missionId,
                roomId,
                kind: "request",
                summary: clipSummary(input.text),
                body: input.text,
                to: [{ _tag: "thread", threadId: input.threadId }],
                key: `recovery:${sha256(input.key).slice(0, 32)}`,
              },
              provenance: PROVENANCE,
              author: actorOf(PROVENANCE),
              authorThread: null,
            })
            .pipe(
              // Not a member of that mission any more, or the mission is gone:
              // the router routes it by membership instead.
              Effect.catchIf(
                (error) => error.code === "forbidden" || error.code === "not-found",
                () => Effect.succeed(null),
              ),
            );
          if (posted === null) {
            return yield* router.notify({
              threadId: input.threadId,
              text: input.text,
              key: input.key,
              producer: PRODUCER,
            });
          }
          // A retry finds the post already made and rings nothing, so ring:
          // the doorbell only rings for deliveries still unread.
          if (!posted.fresh) {
            yield* router.poke(input.threadId).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("missions recovery: doorbell failed", {
                  threadId: input.threadId,
                  cause,
                }),
              ),
            );
          }
          return {
            _tag: "posted",
            missionId: input.missionId,
            roomId,
            messageId: posted.message.id,
            seq: posted.message.seq,
          } satisfies MissionRouter.SystemNoticeOutcome;
        });
      return RecoveryDelivery.of({
        readiness: router.readiness,
        notify,
        installerPending:
          options?.installerPending ?? Effect.sync(() => NodeFS.existsSync(installerFile())),
        timeZone: options?.timeZone ?? ownerTimeZone(),
      });
    }),
  );

export const layer = layerWith();
