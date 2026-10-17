import type {
  AnswerAskInput,
  Approval,
  Ask,
  CallId,
  DecideApprovalInput,
  DecideDraftInput,
  DecideKnockInput,
  DecideSuggestionInput,
  Draft,
  DraftNote,
  DraftNoteId,
  DraftNoteScope,
  ForkId,
  Knock,
  Lane,
  MarkReadInput,
  MissionFork,
  MissionId,
  MissionInbox,
  MissionLink,
  MissionListSnapshot,
  MissionMessage,
  MissionOverview,
  MissionRecordRef,
  NoteId,
  PostMessageInput,
  ReorderSubMissionsInput,
  Room,
  RoomId,
  RoomPage,
  Rule,
  SubMissionId,
  Suggestion,
  SuggestionStats,
  UpsertRuleInput,
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

// ---------------------------------------------------------------------------
// UI-side shapes the contracts do not carry yet. Each is a proposed contract
// addition; the core/asks/router tracks own the real schema.

/**
 * One model or infrastructure pool the mission draws on, as the header shows
 * it. `accounts` counts usable accounts (Claude, Codex review slots), `budget`
 * is money against a cap (offbox), `lock` is a single-holder resource (the dev
 * environment). Values are samples, so each carries when it was read.
 */
export type MissionPoolUsage =
  | {
      readonly _tag: "accounts";
      readonly id: string;
      readonly label: string;
      readonly usable: number;
      readonly total: number;
      readonly sampledAt: string;
    }
  | {
      readonly _tag: "budget";
      readonly id: string;
      readonly label: string;
      readonly spent: number;
      readonly cap: number;
      /** ISO currency code. */
      readonly currency: string;
      readonly sampledAt: string;
    }
  | {
      readonly _tag: "lock";
      readonly id: string;
      readonly label: string;
      /** `null` when free. */
      readonly holder: string | null;
      readonly since: string | null;
      readonly sampledAt: string;
    };

/** The overview plus the per-pool usage line. */
export interface MissionOverviewSnapshot extends MissionOverview {
  readonly poolUsage: ReadonlyArray<MissionPoolUsage>;
}

/**
 * Owner edit of a sub-mission's intended effort share. The edit locks the
 * `intendedEffort` field so the master can no longer overwrite it; `null`
 * clears the owner's value and hands the field back to the master.
 */
export interface SetIntendedEffortInput {
  readonly subMissionId: SubMissionId;
  readonly share: number | null;
}

/**
 * Opens a fork of the master: a Discuss on a call or ask, or an owner
 * side question ("Ask the mission"). `question` is the owner's opening line.
 * Opening a second fork on the same record returns the open one.
 */
export interface OpenForkInput {
  readonly missionId: MissionId;
  readonly kind: MissionFork["kind"];
  readonly origin: MissionRecordRef | MissionLink | null;
  readonly question?: string;
}

/**
 * A fork plus the owner's opening line, which the contract record does not
 * keep. `question` is `null` for a one-tap Discuss with nothing typed yet.
 */
export interface MissionForkEntry {
  readonly fork: MissionFork;
  readonly question: string | null;
}

/** Owner closes a fork without waiting for its answer. */
export interface ArchiveForkInput {
  readonly forkId: ForkId;
}

export interface AddDraftNoteInput {
  /** `null` applies to drafts in every mission. */
  readonly missionId: MissionId | null;
  readonly scope: DraftNoteScope;
  readonly text: string;
}

export interface SetDraftNoteActiveInput {
  readonly draftNoteId: DraftNoteId;
  readonly active: boolean;
}

export interface AckNoteInput {
  readonly noteId: NoteId;
}

/**
 * Owner items decided recently, newest first, so the inbox can show what just
 * happened: the edit diff on an approved draft, approvals that closed as stale.
 */
export interface MissionInboxHistory {
  readonly asks: ReadonlyArray<Ask>;
  readonly drafts: ReadonlyArray<Draft>;
  readonly approvals: ReadonlyArray<Approval>;
  readonly knocks: ReadonlyArray<Knock>;
  readonly suggestions: ReadonlyArray<Suggestion>;
}

export interface LoadRoomPageInput {
  readonly roomId: RoomId;
  /** Messages strictly older than this seq. */
  readonly beforeSeq: number;
  readonly limit: number;
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
  subscribeOverview(
    missionId: MissionId,
    listener: Listener<MissionOverviewSnapshot | null>,
  ): Unsubscribe;
  /** Lanes are only fetched when the owner unfolds them. */
  subscribeLanes(missionId: MissionId, listener: Listener<ReadonlyArray<Lane>>): Unsubscribe;
  /** `null` reads the inbox across every mission. */
  subscribeInbox(missionId: MissionId | null, listener: Listener<MissionInbox>): Unsubscribe;
  subscribeInboxHistory(
    missionId: MissionId | null,
    listener: Listener<MissionInboxHistory>,
  ): Unsubscribe;
  /** Owner notes on how drafts should read, active and turned off. */
  subscribeDraftNotes(
    missionId: MissionId | null,
    listener: Listener<ReadonlyArray<DraftNote>>,
  ): Unsubscribe;
  /** Acceptance record per suggestion author and target kind. */
  subscribeSuggestionStats(listener: Listener<ReadonlyArray<SuggestionStats>>): Unsubscribe;
  /** Forks of the master, newest first. `null` reads every mission. */
  subscribeForks(
    missionId: MissionId | null,
    listener: Listener<ReadonlyArray<MissionForkEntry>>,
  ): Unsubscribe;
  /** Owner rules, active and retired. */
  subscribeRules(missionId: MissionId, listener: Listener<ReadonlyArray<Rule>>): Unsubscribe;
  subscribeRooms(
    missionId: MissionId,
    listener: Listener<ReadonlyArray<MissionRoomEntry>>,
  ): Unsubscribe;
  /**
   * The newest page of a room, kept current as messages arrive. It reaches
   * back to just before the owner's first unread message (within a cap) so the
   * read marker is on screen. Older pages come from `loadRoomPage`. `null`
   * means the room does not exist.
   */
  subscribeRoom(roomId: RoomId, listener: Listener<RoomPage | null>): Unsubscribe;
  loadRoomPage(input: LoadRoomPageInput): Promise<RoomPage>;

  reorderSubMissions(input: ReorderSubMissionsInput): Promise<void>;
  setMissionPaused(input: SetMissionPausedInput): Promise<void>;
  setMissionFocus(input: SetMissionFocusInput): Promise<void>;
  setIntendedEffort(input: SetIntendedEffortInput): Promise<void>;
  /** "discuss" also opens a Discuss fork on the call. */
  reactToCall(input: ReactToCallInput): Promise<void>;
  /** Moves the "since you last looked" mark to now. */
  markMissionSeen(input: MarkMissionSeenInput): Promise<void>;
  openFork(input: OpenForkInput): Promise<MissionForkEntry>;
  archiveFork(input: ArchiveForkInput): Promise<void>;

  answerAsk(input: AnswerAskInput): Promise<void>;
  decideDraft(input: DecideDraftInput): Promise<void>;
  decideSuggestion(input: DecideSuggestionInput): Promise<void>;
  decideKnock(input: DecideKnockInput): Promise<void>;
  decideApproval(input: DecideApprovalInput): Promise<void>;
  addDraftNote(input: AddDraftNoteInput): Promise<DraftNote>;
  setDraftNoteActive(input: SetDraftNoteActiveInput): Promise<void>;
  ackNote(input: AckNoteInput): Promise<void>;

  postRoomMessage(input: PostMessageInput): Promise<MissionMessage>;
  /** Moves the owner's read position; it only ever moves forward. */
  markRoomRead(input: MarkReadInput): Promise<void>;
  /** Writes or edits an owner rule (a correction saved as a rule lands here). */
  upsertRule(input: UpsertRuleInput): Promise<Rule>;
}
