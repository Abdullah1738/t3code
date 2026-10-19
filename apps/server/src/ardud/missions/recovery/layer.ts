import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { forkParked } from "../../../serverActivation.ts";
import * as MissionService from "../MissionService.ts";
import { installContinuationGate } from "./continuationGate.ts";
import * as RecoveryDelivery from "./RecoveryDelivery.ts";
import * as RecoveryService from "./RecoveryService.ts";
import * as RecoveryStore from "./RecoveryStore.ts";

/**
 * On by default. T3CODE_ARDUD_MISSIONS_RECOVERY=0 turns off detection and
 * notices; the overview and tools still read what was recorded.
 */
const enabled = Config.Boolean("T3CODE_ARDUD_MISSIONS_RECOVERY").pipe(Config.withDefault(true));

/**
 * The server settles the runs a restart cut right after boot, and continues
 * those of threads outside missions. Waiting this long lets that land, so the
 * plan sees final run states (and any continuation the gate did not stop).
 */
const BOOT_DELAY = "45 seconds";
const TICK_EVERY = "15 seconds";
const SCAN_EVERY = "1 minute";

const logged =
  (what: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.asVoid,
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning(`missions recovery: ${what} failed`, { cause: Cause.pretty(cause) }),
      ),
    );

/** The loops alone, over a provided RecoveryService (tests use a fake delivery). */
export const RecoveryLoops = Layer.effectDiscard(
  Effect.gen(function* () {
    const missions = yield* MissionService.MissionService;
    const recovery = yield* RecoveryService.RecoveryService;
    yield* missions.registerRecovery({ state: recovery.state });
    if (!(yield* enabled.pipe(Effect.orElseSucceed(() => true)))) return;

    // Robob's own restart continuation leaves member threads to recovery,
    // which wakes them in order with what was lost.
    yield* installContinuationGate((threadId) =>
      recovery.members([threadId]).pipe(Effect.map((members) => members.length > 0)),
    );

    const ticks = recovery.tick.pipe(
      logged("notice round"),
      Effect.repeat(Schedule.spaced(TICK_EVERY)),
    );
    const scans = recovery.beat.pipe(
      Effect.andThen(recovery.scan),
      logged("scan"),
      Effect.repeat(Schedule.spaced(SCAN_EVERY)),
    );
    yield* forkParked(
      recovery.beat.pipe(
        logged("heartbeat"),
        Effect.andThen(Effect.sleep(BOOT_DELAY)),
        Effect.andThen(recovery.detectBoot.pipe(logged("boot check"))),
        Effect.andThen(Effect.all([ticks, scans], { concurrency: "unbounded", discard: true })),
      ),
    );

    // Successions: the new holder learns about the old thread's children.
    yield* forkParked(
      missions.changes.pipe(
        Stream.runForEach((item) =>
          item._tag === "upsert" &&
          item.missionId !== null &&
          item.record._tag === "role-binding" &&
          item.record.record.reason === "succession" &&
          item.record.record.endedAt === null
            ? recovery.onSuccession(item.record.record, item.missionId).pipe(logged("handoff"))
            : Effect.void,
        ),
        logged("handoff watch"),
      ),
    );
  }),
);

/** Restart and interruption recovery for mission threads. Needs MissionService. */
export const RecoveryLive = RecoveryLoops.pipe(
  Layer.provideMerge(RecoveryService.layer),
  Layer.provideMerge(Layer.mergeAll(RecoveryStore.layer, RecoveryDelivery.layer)),
);
