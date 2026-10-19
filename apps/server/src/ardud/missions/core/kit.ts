import type {
  Mission,
  MissionError,
  MissionEventKind,
  MissionId,
  MissionMutationResult,
  MissionProvenance,
  MissionRecordRef,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

import type { OwnerConditions } from "../discuss/OwnerConditions.ts";
import type * as MissionStore from "../store/MissionStore.ts";
import type { MissionStoreRecord } from "../store/recordIndex.ts";

/** What writes.ts shares with the write modules split out of it. */
export interface WriteKit {
  readonly store: MissionStore.MissionStore["Service"];
  /** Discuss: verifies the owner's condition before the master acts on it. */
  readonly conditions: OwnerConditions["Service"];
  /** One write at a time across every core write. */
  readonly serial: <A>(effect: Effect.Effect<A, MissionError>) => Effect.Effect<A, MissionError>;
  readonly loadMission: (missionId: MissionId) => Effect.Effect<Mission, MissionError>;
  readonly unchanged: (
    missionId: MissionId,
    ref: MissionRecordRef,
  ) => Effect.Effect<MissionMutationResult, MissionError>;
  readonly commit: (
    provenance: MissionProvenance,
    write: {
      readonly missionId: MissionId;
      readonly kind: MissionEventKind;
      readonly summary: string;
      readonly ref: MissionRecordRef;
      readonly upserts: ReadonlyArray<MissionStoreRecord>;
      readonly payload?: unknown;
    },
  ) => Effect.Effect<MissionMutationResult, MissionError>;
}
