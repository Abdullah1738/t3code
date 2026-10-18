import type {
  FeedItem,
  MissionError,
  MissionId,
  MissionRecoveryState,
  Note,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

/**
 * What the editor (scribe track) adds to the overview and inbox. The scribe
 * registers one with `MissionService.registerEditor` when its layer starts;
 * until then core assembles the bottom line, feed and FYI list itself.
 */
export interface MissionEditorView {
  readonly bottomLine: string;
  readonly bottomLineAt: string | null;
  /** The editor's feed; `null` keeps core's feed built from events and notes. */
  readonly feed: ReadonlyArray<FeedItem> | null;
}

export interface MissionEditor {
  readonly view: (missionId: MissionId) => Effect.Effect<MissionEditorView | null, MissionError>;
  /** Ranked FYI notes for the owner inbox, best first. */
  readonly fyi: (
    missionId: MissionId | null,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<Note>, MissionError>;
}

// ardud missions: recovery
/** The recovery track's overview badge; registered with `MissionService.registerRecovery`. */
export interface MissionRecoveryReader {
  readonly state: (missionId: MissionId) => Effect.Effect<MissionRecoveryState | null>;
}
// end ardud missions: recovery
