// @effect-diagnostics nodeBuiltinImport:off - checks whether the restart installer still has pending resumes.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { MissionError, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as MissionRouter from "../router/MissionRouter.ts";

export type RecoveryThreadReadiness = MissionRouter.ThreadReadiness;

/**
 * How recovery reaches threads: the router's system delivery. A mission
 * member's notice goes through its control room and doorbell; anyone else
 * gets a queued direct message.
 */
export class RecoveryDelivery extends Context.Service<
  RecoveryDelivery,
  {
    readonly readiness: (threadId: ThreadId) => Effect.Effect<RecoveryThreadReadiness>;
    /**
     * Idempotent per key on the route the router picks at call time. Recovery
     * keeps its own ledger per incident and thread, because a retry after a
     * membership change takes the other route.
     */
    readonly notify: (input: {
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

/** Delivery over the router; tests supply the installer check and zone. */
export const layerWith = (options?: {
  readonly installerPending?: Effect.Effect<boolean>;
  readonly timeZone?: string;
}) =>
  Layer.effect(
    RecoveryDelivery,
    Effect.gen(function* () {
      const router = yield* MissionRouter.MissionRouter;
      return RecoveryDelivery.of({
        readiness: router.readiness,
        notify: (input) => router.notify({ ...input, producer: PRODUCER }),
        installerPending:
          options?.installerPending ?? Effect.sync(() => NodeFS.existsSync(installerFile())),
        timeZone: options?.timeZone ?? ownerTimeZone(),
      });
    }),
  );

export const layer = layerWith();
