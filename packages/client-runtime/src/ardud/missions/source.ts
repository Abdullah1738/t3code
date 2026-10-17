import type {
  AnswerAskInput,
  CallId,
  DecideApprovalInput,
  DecideDraftInput,
  DecideKnockInput,
  DecideSuggestionInput,
  Lane,
  MissionId,
  MissionInbox,
  MissionListSnapshot,
  MissionOverview,
  ReorderSubMissionsInput,
  Room,
  SubMissionId,
} from "@t3tools/contracts";

export type Unsubscribe = () => void;
export type Listener<T> = (value: T) => void;

/**
 * Owner pause/resume of a whole mission. Lanes stop at their next safe point.
 * Local input shape until the core track publishes the RPC schema.
 */
export interface SetMissionPausedInput {
  readonly missionId: MissionId;
  readonly paused: boolean;
}

/**
 * Focus mode: only `subMissionId` admits new work; everything below it parks at
 * safe points. `null` clears focus.
 */
export interface SetMissionFocusInput {
  readonly missionId: MissionId;
  readonly subMissionId: SubMissionId | null;
}

/** Owner reaction to a direction-check call: "ok" accepts, "discuss" forks the master. */
export interface ReactToCallInput {
  readonly missionId: MissionId;
  readonly callId: CallId;
  readonly reaction: "ok" | "discuss";
}

export interface MarkMissionSeenInput {
  readonly missionId: MissionId;
}

export interface MissionRoomEntry {
  readonly room: Room;
  readonly unread: number;
}

/**
 * Everything the web and mobile clients read about missions and every owner
 * action they can take. Subscriptions call the listener with the current value
 * as soon as one is known, then again on every change. Mutations reject with a
 * contract `MissionError`.
 *
 * The fixture source implements this today; the WS RPC source from the core
 * track replaces it without touching the screens.
 */
export interface MissionsSource {
  subscribeList(listener: Listener<MissionListSnapshot>): Unsubscribe;
  /** `null` means the mission does not exist (or was archived). */
  subscribeOverview(missionId: MissionId, listener: Listener<MissionOverview | null>): Unsubscribe;
  /** Lanes are only fetched when the owner unfolds them. */
  subscribeLanes(missionId: MissionId, listener: Listener<ReadonlyArray<Lane>>): Unsubscribe;
  /** `null` reads the inbox across every mission. */
  subscribeInbox(missionId: MissionId | null, listener: Listener<MissionInbox>): Unsubscribe;
  subscribeRooms(
    missionId: MissionId,
    listener: Listener<ReadonlyArray<MissionRoomEntry>>,
  ): Unsubscribe;

  reorderSubMissions(input: ReorderSubMissionsInput): Promise<void>;
  setMissionPaused(input: SetMissionPausedInput): Promise<void>;
  setMissionFocus(input: SetMissionFocusInput): Promise<void>;
  reactToCall(input: ReactToCallInput): Promise<void>;
  /** Moves the "since you last looked" mark to now. */
  markMissionSeen(input: MarkMissionSeenInput): Promise<void>;

  answerAsk(input: AnswerAskInput): Promise<void>;
  decideDraft(input: DecideDraftInput): Promise<void>;
  decideSuggestion(input: DecideSuggestionInput): Promise<void>;
  decideKnock(input: DecideKnockInput): Promise<void>;
  decideApproval(input: DecideApprovalInput): Promise<void>;
}
