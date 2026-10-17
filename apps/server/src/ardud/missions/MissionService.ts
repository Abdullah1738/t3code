import type { MissionError, MissionEvent, MissionId, MissionStreamItem } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as MissionStore from "./store/MissionStore.ts";

/**
 * The missions domain: records, owner actions and the snapshots clients read.
 * Transports (WS, HTTP, MCP) call these methods and stay thin.
 */
export class MissionService extends Context.Service<
  MissionService,
  {
    /** Every committed change, in commit order. */
    readonly changes: Stream.Stream<MissionStreamItem>;
    readonly eventsSince: (
      missionId: MissionId,
      afterSeq: number,
      limit?: number,
    ) => Effect.Effect<ReadonlyArray<MissionEvent>, MissionError>;
  }
>()("t3/ardud/missions/MissionService") {}

const make = Effect.gen(function* () {
  const store = yield* MissionStore.MissionStore;
  return MissionService.of({
    changes: Stream.unwrap(Effect.map(store.subscribe, Stream.fromSubscription)),
    eventsSince: store.eventsSince,
  });
});

export const layer = Layer.effect(MissionService, make);
