import type {
  AckNoteInput,
  AnswerAskInput,
  Approver,
  CreateMissionInput,
  CreateRoleInput,
  CriticalityVerdict,
  DecideApprovalInput,
  DecideDraftInput,
  DecideKnockInput,
  DecideSuggestionInput,
  DraftNote,
  DraftNoteScope,
  Lane,
  LaneId,
  MarkMissionSeenInput,
  MarkReadInput,
  MergeLanesInput,
  MissionActor,
  MissionEvent,
  MissionEventId,
  MissionEventKind,
  MissionId,
  MissionInbox,
  MissionInboxHistory,
  MissionLink,
  MissionListSnapshot,
  MissionMessage,
  MissionOverview,
  MissionRecordRef,
  MissionRoutingTable,
  MissionTimelineGroup,
  MissionTier,
  MissionViewsSnapshot,
  PoolId,
  PoolsSnapshot,
  PostMessageInput,
  RecoveryIncident,
  RecoverySettingsInput,
  ReactToCallInput,
  ReorderSubMissionsInput,
  ResolveRuleChangeInput,
  ReviewPolicy,
  ReviewRecord,
  RoleId,
  RolesSnapshot,
  Room,
  RoomId,
  RoomPage,
  // ardud missions: fix-p3
  MissionRoomActivity,
  MissionRoomActivityInput,
  Rule,
  RuleChangeRequest,
  RuleId,
  SetApprovalRoutingInput,
  SetCriticalityGuideInput,
  SetDraftNoteActiveInput,
  SetMissionFocusInput,
  SetMissionStatusInput,
  SetPoolCapacityInput as ContractSetPoolCapacityInput,
  SetRoleModelInput,
  SplitLaneInput,
  SubMissionId,
  Suggestion,
  SuggestionStats,
  TuneRoomInput,
  UpdateMissionInput,
  UpdateRoleInput,
  UpdateRoomInput,
  UpsertLaneInput,
  UpsertRuleInput,
  WorkItem,
  WorkStage,
} from "@t3tools/contracts";

// --- finish-a ---
import type {
  CommentInboxItemInput,
  InboxMark,
  SnoozeInboxItemInput,
  UnsnoozeInboxItemInput,
} from "@t3tools/contracts";
// --- end finish-a ---

import type { ViewSectionRequest } from "./views/layout.ts";
// --- views additions ---
import type {
  RunViewSourceInput,
  SetViewSourceInput,
  ViewHistory,
  ViewHistoryInput,
  ViewLongText,
  ViewLongTextInput,
  ViewSourceRunResult,
} from "@t3tools/contracts";
// --- end views additions ---

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

/**
 * Who last changed one field of one record, read from the event log: the
 * newest event whose subject is the record and whose `payload.changed` names
 * the field (the core track's write convention). Nothing is locked; this is
 * attribution only.
 */
export interface FieldChange {
  readonly ref: MissionRecordRef;
  readonly field: string;
  readonly actor: MissionActor;
  readonly eventId: MissionEventId;
  readonly at: string;
  // --- finish-b ---
  /** The value the change replaced, when the event kept it. */
  readonly previous?: string | number | undefined;
  // --- end finish-b ---
}

/**
 * The overview plus the per-pool usage line and who last changed what. The
 * contract's `recovery` carries the open restart incident, if any.
 */
export interface MissionOverviewSnapshot extends MissionOverview {
  readonly poolUsage: ReadonlyArray<MissionPoolUsage>;
  /** Latest change per field of the mission and its sub-missions. */
  readonly changes: ReadonlyArray<FieldChange>;
}

// --- Approval routing ------------------------------------------------------

/**
 * The contract routing table plus who last changed each row. The first
 * matching row wins and no match goes to the owner; editing the table never
 * moves records that already exist. `changes` uses the mission as the ref and
 * the row id as the field (`rules` is the table as a whole).
 */
export interface ApprovalRoutingTable extends MissionRoutingTable {
  readonly changes: ReadonlyArray<FieldChange>;
}

/**
 * The inbox with every pending draft and approval, whichever inbox it is
 * routed to (`approverOf` on each record). `counts` count only what is routed
 * to the owner (asks, knocks and FYI notes are always the owner's);
 * `masterCounts` count what waits on the master. The owner can decide either.
 */
export interface MissionInboxSnapshot extends MissionInbox {
  readonly masterCounts: { readonly approve: number; readonly suggestions: number };
  // --- finish-a ---
  /**
   * The owner's comments and snoozes on inbox items, keyed by `InboxEntry.key`.
   * A snooze listed here still holds on the server; its `until` is checked
   * against the device clock by `isSnoozed`.
   */
  readonly marks?: ReadonlyArray<InboxMark>;
  // --- end finish-a ---
}

/** Moves one pending draft or approval to the other inbox. Logged with the reason. */
export interface RerouteRecordInput {
  readonly kind: "draft" | "approval";
  readonly id: string;
  readonly approver: Approver;
  readonly reason: string;
}

// --- Timeline --------------------------------------------------------------

/**
 * Event kinds the screens need that the contract does not list yet. Proposed
 * additions for the core track (recovery owns `recovery.*`).
 */
export const PROPOSED_MISSION_EVENT_KINDS = [
  // Already on the core branch's contract; listed until this branch picks it up.
  "lane.updated",
  "routing.updated",
  "record.rerouted",
  "lane.nudged",
  "portfolio.reordered",
  "rule.applied",
  "rule.broken",
  "recovery.detected",
  "recovery.resumed",
] as const;

export type ProposedMissionEventKind = (typeof PROPOSED_MISSION_EVENT_KINDS)[number];

export type MissionTimelineEvent = Omit<MissionEvent, "kind"> & {
  readonly kind: MissionEventKind | ProposedMissionEventKind;
  /** The server's timeline group, for kinds this client does not know yet. */
  readonly group?: MissionTimelineGroup;
};

/** The loaded part of a mission's timeline, newest first. */
export interface MissionTimelineWindow {
  readonly events: ReadonlyArray<MissionTimelineEvent>;
  /** Older events exist on the server; `loadOlderTimeline` fetches the next page. */
  readonly hasOlder: boolean;
}

// --- Lanes and work --------------------------------------------------------

export interface NudgeLaneInput {
  readonly laneId: LaneId;
  /** What the lane should look at; delivered as a room message to the lane lead. */
  readonly note?: string;
}

// --- finish-b ---
/** A new lane: the server's upsert with no lane id. */
export interface NewLaneInput {
  readonly missionId: MissionId;
  readonly name: string;
  readonly subMissionId?: SubMissionId;
}

/**
 * Puts back the value a change replaced, through the same write RPC that
 * made the change. The server records it as a new change.
 */
export type RevertAction =
  | { readonly _tag: "mission"; readonly input: UpdateMissionInput }
  | { readonly _tag: "status"; readonly input: SetMissionStatusInput }
  | { readonly _tag: "focus"; readonly input: SetMissionFocusInput }
  | { readonly _tag: "order"; readonly input: SetPortfolioOrderInput }
  | { readonly _tag: "lane"; readonly input: UpsertLaneInput }
  | { readonly _tag: "role"; readonly input: UpdateRoleInput }
  | { readonly _tag: "role-model"; readonly input: SetRoleModelInput }
  | { readonly _tag: "pool-capacity"; readonly input: ContractSetPoolCapacityInput }
  | { readonly _tag: "recovery"; readonly input: RecoverySettingsInput }
  | { readonly _tag: "room"; readonly input: UpdateRoomInput };
// --- end finish-b ---

/** Ends the lane lead's thread and binds a fresh one with this handoff note. */
export interface HandOffLaneInput {
  readonly laneId: LaneId;
  readonly note: string;
}

export interface SetLaneParkedInput {
  readonly missionId: MissionId;
  readonly laneId: LaneId;
  readonly parked: boolean;
  readonly reason?: string;
}

export interface MoveLaneInput {
  readonly missionId: MissionId;
  readonly laneId: LaneId;
  readonly subMissionId: SubMissionId;
}

/** Narrows a work feed. Without one the feed reads every item. */
export interface WorkQuery {
  readonly laneId?: LaneId;
  readonly stages?: ReadonlyArray<WorkStage>;
  /** Most recently changed first; at most this many. */
  readonly limit?: number;
}

export interface MissionWorkSnapshot {
  readonly missionId: MissionId;
  /** Most recently changed first. */
  readonly items: ReadonlyArray<WorkItem>;
  /** Items matching the query, loaded or not. */
  readonly total: number;
  readonly hasMore: boolean;
}

// --- Rules -----------------------------------------------------------------

/**
 * Findings over the rule book. Conflict and stale come from a scribe or master
 * audit; broken, reading and acks are read off the live rule records
 * (`ruleAudit` in rulesViewModel).
 */
export interface RuleAuditFinding {
  readonly id: string;
  // --- finish-b --- broken, reading and acks are computed from the rules.
  readonly kind: "conflict" | "stale" | "broken" | "reading" | "acks";
  readonly ruleIds: ReadonlyArray<RuleId>;
  readonly note: string;
  readonly foundBy: MissionActor;
  readonly at: string;
}

export interface MissionRuleBook {
  readonly missionId: MissionId;
  readonly rules: ReadonlyArray<Rule>;
  readonly changeRequests: ReadonlyArray<RuleChangeRequest>;
  readonly audit: ReadonlyArray<RuleAuditFinding>;
  /** Open suggestions that target a rule, whoever accepts them. */
  readonly suggestions: ReadonlyArray<Suggestion>;
  /** Latest change per rule field (`quote`, `scope`, `activation`, `status`). */
  readonly changes: ReadonlyArray<FieldChange>;
}

// --- Roles, review policy, pools, recovery --------------------------------

/** The policy track's `RolesSnapshot`, plus attribution. */
export interface MissionRolesSnapshot extends RolesSnapshot {
  /** Latest change per role field (`modelSelection`, `writesPublicText`). */
  readonly changes: ReadonlyArray<FieldChange>;
}

export interface MissionReviewSnapshot {
  readonly missionId: MissionId;
  readonly policy: ReviewPolicy;
  /** Newest first. */
  readonly verdicts: ReadonlyArray<CriticalityVerdict>;
  /** Newest first. */
  readonly reviews: ReadonlyArray<ReviewRecord>;
  readonly changes: ReadonlyArray<FieldChange>;
}

/** The policy track's `PoolsSnapshot`, plus attribution. */
export interface MissionPoolsSnapshot extends PoolsSnapshot {
  /** Latest change per pool field (`capacity`, `enforcement`, `priority`). */
  readonly changes: ReadonlyArray<FieldChange>;
}

/** The contract input plus the reason the screen asks for; the policy RPC has no reason field yet. */
export interface SetPoolCapacityInput extends ContractSetPoolCapacityInput {
  readonly reason: string;
}

/** Restart recovery reads the server's incident shape as is. */
export type {
  RecoveryAction,
  RecoveryCause,
  RecoveryIncident,
  RecoveryThread,
} from "@t3tools/contracts";

// --- Portfolio -------------------------------------------------------------

export interface PortfolioPoolDraw {
  readonly poolId: PoolId;
  readonly label: string;
  readonly unit: string;
  /** This mission's share of the pool in use now, 0..1. */
  readonly share: number;
  readonly runOutAt: string | null;
}

export interface PortfolioMission {
  readonly missionId: MissionId;
  readonly title: string;
  readonly status: "active" | "paused" | "draining" | "archived";
  readonly tier: MissionTier;
  /** Labels this mission's master as "master" in attribution lines. */
  readonly masterRoleId: RoleId | null;
  readonly guaranteedShare: number;
  readonly borrowCeiling: number;
  /** Share of shared capacity the mission used over the last window, or `null` unmeasured. */
  readonly usedShare: number | null;
  readonly pools: ReadonlyArray<PortfolioPoolDraw>;
}

export interface PortfolioSnapshot {
  /** Cross-mission priority, highest first. */
  readonly order: ReadonlyArray<MissionId>;
  readonly missions: ReadonlyArray<PortfolioMission>;
  /** Latest change per mission field (`tier`, `guaranteedShare`, `borrowCeiling`). */
  readonly changes: ReadonlyArray<FieldChange>;
  /** Who set the current order, from the newest `portfolio.reordered` event. */
  readonly orderChange: {
    readonly actor: MissionActor;
    readonly at: string;
    // --- finish-b ---
    readonly previousOrder?: ReadonlyArray<MissionId> | undefined;
    // --- end finish-b ---
  } | null;
}

export interface SetPortfolioOrderInput {
  readonly order: ReadonlyArray<MissionId>;
}

/**
 * Sets a sub-mission's intended effort share. The owner and the master write
 * it the same way and nothing locks it; the event log records who changed it
 * last (see `FieldChange`). `null` clears the share.
 */
export interface SetIntendedEffortInput {
  readonly missionId: MissionId;
  readonly subMissionId: SubMissionId;
  readonly share: number | null;
}

export interface AddDraftNoteInput {
  /** `null` applies to drafts in every mission. */
  readonly missionId: MissionId | null;
  readonly scope: DraftNoteScope;
  readonly text: string;
}

// --- Owner requests ---
// The UI shape of a router `OwnerRequest` and its conversation. The owner asks
// or tells the master something; the master answers in the same thread and
// links what it made from it. Discuss on a record opens one about that record.

export type OwnerRequestStatus = "waiting" | "answered" | "settled";

export interface OwnerRequestMessage {
  readonly id: string;
  readonly author: "owner" | "master";
  readonly text: string;
  readonly at: string;
  /** Links posted with this message (pull requests, runs, files). */
  readonly refs: ReadonlyArray<MissionLink>;
}

export interface OwnerRequest {
  readonly id: string;
  readonly missionId: MissionId;
  readonly title: string;
  readonly status: OwnerRequestStatus;
  /** Oldest first. A list read carries the newest few; `subscribeRequest` has them all. */
  readonly messages: ReadonlyArray<OwnerRequestMessage>;
  /** Older messages exist before `messages`. */
  readonly hasOlder: boolean;
  /** Records the master made or touched for it: work items, asks, rules. */
  readonly links: ReadonlyArray<MissionRecordRef>;
  /** The record a Discuss opened it about. */
  readonly subject: MissionRecordRef | null;
  /** The master spoke since the owner last read it. */
  readonly unread: boolean;
  /** How many messages the owner has not read, when the server counts them. */
  readonly unreadMessages?: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly settledAt: string | null;
}

export interface OpenRequestInput {
  readonly missionId: MissionId;
  readonly text: string;
  /** Discuss: the record it is about. The server keeps one open request per subject. */
  readonly subject?: MissionRecordRef;
}

export interface RequestThreadInput {
  readonly missionId: MissionId;
  readonly requestId: string;
}

export interface ReplyRequestInput {
  readonly requestId: string;
  readonly text: string;
}

export interface RequestIdInput {
  readonly requestId: string;
}

/** Settle or reopen; a note is the owner's closing (or reopening) words to the master. */
export interface RequestNoteInput extends RequestIdInput {
  readonly note?: string | undefined;
}

/** One logged change to a mission's layout or sections, from its `view.*` events. */
export interface MissionViewChange {
  readonly id: string;
  readonly at: string;
  readonly by: "owner" | "master";
  readonly summary: string;
}

export interface MissionViewsState {
  readonly snapshot: MissionViewsSnapshot;
  /** Newest first. */
  readonly changes: ReadonlyArray<MissionViewChange>;
}

/**
 * Feeds a source may serve from sample data. Each names the screen section it
 * fills, so the section can say so once. The RPC source serves all of them
 * live; only the fixture source is sample data.
 */
export const SAMPLED_FEEDS = [
  "work",
  "timeline",
  "portfolio",
  "suggestion-stats",
  "recovery",
] as const;
export type SampledFeed = (typeof SAMPLED_FEEDS)[number];

export interface LoadRoomPageInput {
  readonly roomId: RoomId;
  /** Messages strictly older than this seq. */
  readonly beforeSeq: number;
  readonly limit: number;
}

/**
 * Everything the web and mobile clients read about missions and every action
 * the owner can take. The master reaches the same service methods through its
 * tools; nothing here is owner-only. Subscriptions call the listener with the
 * current value as soon as one is known, then again on every change. Mutations
 * reject with a contract `MissionError`.
 *
 * Two implementations: the WS RPC source (`createRpcMissionsSource`) reads
 * the server, and the fixture source serves sample data for design work
 * (`?missionsFixture=1` on web).
 */
export interface MissionsSource {
  /** Feeds served from sample data. Empty on the RPC source. */
  readonly sampled: ReadonlySet<SampledFeed>;
  subscribeList(listener: Listener<MissionListSnapshot>): Unsubscribe;
  /** `null` means the mission does not exist (or was archived). */
  subscribeOverview(
    missionId: MissionId,
    listener: Listener<MissionOverviewSnapshot | null>,
  ): Unsubscribe;
  /** Lanes are only fetched when the owner unfolds them. */
  subscribeLanes(missionId: MissionId, listener: Listener<ReadonlyArray<Lane>>): Unsubscribe;
  /** `null` reads the inbox across every mission. */
  subscribeInbox(
    missionId: MissionId | null,
    listener: Listener<MissionInboxSnapshot>,
    // --- finish-a ---
    /** A read failed; the feed stays closed until it is subscribed again. */
    onError?: Listener<unknown>,
    // --- end finish-a ---
  ): Unsubscribe;
  /** `null` means the mission has no routing table yet (everything goes to the owner). */
  subscribeRouting(
    missionId: MissionId,
    listener: Listener<ApprovalRoutingTable | null>,
  ): Unsubscribe;
  subscribeWork(
    missionId: MissionId,
    listener: Listener<MissionWorkSnapshot>,
    query?: WorkQuery,
    // --- finish-b ---
    /** A read failed; the feed stays closed until it is subscribed again. */
    onError?: Listener<unknown>,
    // --- end finish-b ---
  ): Unsubscribe;
  subscribeRuleBook(
    missionId: MissionId,
    listener: Listener<MissionRuleBook>,
    // --- finish-b ---
    /** A read failed; the feed stays closed until it is subscribed again. */
    onError?: Listener<unknown>,
    // --- end finish-b ---
  ): Unsubscribe;
  subscribeRoles(
    missionId: MissionId,
    listener: Listener<MissionRolesSnapshot>,
    // --- finish-b ---
    /** A read failed; the feed stays closed until it is subscribed again. */
    onError?: Listener<unknown>,
    // --- end finish-b ---
  ): Unsubscribe;
  /** `null` when the mission has no review policy. */
  subscribeReviewPolicy(
    missionId: MissionId,
    listener: Listener<MissionReviewSnapshot | null>,
  ): Unsubscribe;
  /** Pools the mission draws on (its own, shared, global). */
  subscribePools(missionId: MissionId, listener: Listener<MissionPoolsSnapshot>): Unsubscribe;
  /** Restart incidents touching the mission, newest first. */
  subscribeRecovery(
    missionId: MissionId,
    listener: Listener<ReadonlyArray<RecoveryIncident>>,
  ): Unsubscribe;
  /** The loaded part of the mission's event log, newest first. */
  subscribeTimeline(
    missionId: MissionId,
    listener: Listener<ReadonlyArray<MissionTimelineEvent>>,
    // --- finish-a ---
    /** The first page failed; the feed stays closed until it is subscribed again. */
    onError?: Listener<unknown>,
    // --- end finish-a ---
  ): Unsubscribe;
  /** Same log with whether older pages exist. */
  subscribeTimelineWindow(
    missionId: MissionId,
    listener: Listener<MissionTimelineWindow>,
    // --- finish-a ---
    onError?: Listener<unknown>,
    // --- end finish-a ---
  ): Unsubscribe;
  /** Loads the next older page into the timeline feeds. Resolves once it is in. */
  loadOlderTimeline(missionId: MissionId): Promise<void>;
  subscribePortfolio(listener: Listener<PortfolioSnapshot>): Unsubscribe;
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
  /** Mission rules, active and retired (global rules included). */
  subscribeRules(missionId: MissionId, listener: Listener<ReadonlyArray<Rule>>): Unsubscribe;
  subscribeRooms(
    missionId: MissionId,
    listener: Listener<ReadonlyArray<MissionRoomEntry>>,
    // --- finish-b ---
    /** A read failed; the feed stays closed until it is subscribed again. */
    onError?: Listener<unknown>,
    // --- end finish-b ---
  ): Unsubscribe;
  // --- fix-p3 ---
  /** Today's room messages in bins and a tally since a time, kept current. */
  subscribeRoomActivity(
    input: MissionRoomActivityInput,
    listener: Listener<MissionRoomActivity>,
    onError?: Listener<unknown>,
  ): Unsubscribe;
  // --- end fix-p3 ---
  /**
   * The newest page of a room, kept current as messages arrive. It reaches
   * back to just before the owner's first unread message (within a cap) so the
   * read marker is on screen. Older pages come from `loadRoomPage`. `null`
   * means the room does not exist.
   */
  subscribeRoom(
    roomId: RoomId,
    listener: Listener<RoomPage | null>,
    // --- finish-b ---
    /** A read failed; the feed stays closed until it is subscribed again. */
    onError?: Listener<unknown>,
    // --- end finish-b ---
  ): Unsubscribe;
  loadRoomPage(input: LoadRoomPageInput): Promise<RoomPage>;

  reorderSubMissions(input: ReorderSubMissionsInput): Promise<void>;
  setMissionPaused(input: SetMissionPausedInput): Promise<void>;
  setMissionFocus(input: SetMissionFocusInput): Promise<void>;
  setIntendedEffort(input: SetIntendedEffortInput): Promise<void>;
  /** Records the owner's reaction only; Discuss opens an owner request about the call instead. */
  reactToCall(input: ReactToCallInput): Promise<void>;
  /** Moves the "since you last looked" mark to now. */
  markMissionSeen(input: MarkMissionSeenInput): Promise<void>;

  answerAsk(input: AnswerAskInput): Promise<void>;
  decideDraft(input: DecideDraftInput): Promise<void>;
  decideSuggestion(input: DecideSuggestionInput): Promise<void>;
  decideKnock(input: DecideKnockInput): Promise<void>;
  decideApproval(input: DecideApprovalInput): Promise<void>;
  addDraftNote(input: AddDraftNoteInput): Promise<DraftNote>;
  setDraftNoteActive(input: SetDraftNoteActiveInput): Promise<void>;
  ackNote(input: AckNoteInput): Promise<void>;
  // --- finish-a ---
  /** A note on an inbox item that decides nothing. */
  commentInboxItem(input: CommentInboxItemInput): Promise<void>;
  /** Hides the item from the owner until `until` or until the item changes. */
  snoozeInboxItem(input: SnoozeInboxItemInput): Promise<void>;
  unsnoozeInboxItem(input: UnsnoozeInboxItemInput): Promise<void>;
  // --- end finish-a ---

  postRoomMessage(input: PostMessageInput): Promise<MissionMessage>;
  /** Moves the owner's read position; it only ever moves forward. */
  markRoomRead(input: MarkReadInput): Promise<void>;
  /** Writes or edits a rule (a correction saved as a rule lands here). */
  upsertRule(input: UpsertRuleInput): Promise<Rule>;
  resolveRuleChange(input: ResolveRuleChangeInput): Promise<void>;

  setApprovalRouting(input: SetApprovalRoutingInput): Promise<ApprovalRoutingTable>;
  rerouteRecord(input: RerouteRecordInput): Promise<void>;

  nudgeLane(input: NudgeLaneInput): Promise<void>;
  handOffLane(input: HandOffLaneInput): Promise<void>;
  setLaneParked(input: SetLaneParkedInput): Promise<void>;
  moveLane(input: MoveLaneInput): Promise<void>;
  splitLane(input: SplitLaneInput): Promise<void>;
  mergeLanes(input: MergeLanesInput): Promise<void>;

  /** Applies on the role's next turn (`pendingModelSelection` until then). */
  setRoleModel(input: SetRoleModelInput): Promise<void>;
  setCriticalityGuide(input: SetCriticalityGuideInput): Promise<void>;
  setPoolCapacity(input: SetPoolCapacityInput): Promise<void>;
  setPortfolioOrder(input: SetPortfolioOrderInput): Promise<void>;

  // --- finish-b ---
  /** Creates a mission and resolves with its id. */
  createMission(input: CreateMissionInput): Promise<MissionId>;
  createLane(input: NewLaneInput): Promise<void>;
  createRole(input: CreateRoleInput): Promise<void>;
  /** Who each message kind wakes in a room (owner or master). */
  tuneRoom(input: TuneRoomInput): Promise<void>;
  /** Rename, move to another sub-mission, remove (archive) or restore a room. */
  updateRoom(input: UpdateRoomInput): Promise<void>;
  /** Puts a change's previous value back through the write that made it. */
  revertChange(action: RevertAction): Promise<void>;
  // --- end finish-b ---

  /** The mission's views record (layout, sections, pins) and its change log; null when gone. */
  subscribeViews(missionId: MissionId, listener: Listener<MissionViewsState | null>): Unsubscribe;
  /** Runs one layout change built by `viewSectionRequest`. */
  changeView(request: ViewSectionRequest): Promise<void>;
  // --- views additions ---
  /** A row value too long for the views snapshot (a report's text), fetched when it opens. */
  loadLongText(input: ViewLongTextInput): Promise<ViewLongText>;
  /** Patch a script source; the owner's Disable/Enable sends `enabled`. */
  setViewSource(input: SetViewSourceInput): Promise<void>;
  /** Run a script source now. */
  runViewSource(input: RunViewSourceInput): Promise<ViewSourceRunResult>;
  /** Past versions of a view object; a source's entries carry its code. */
  loadViewHistory(input: ViewHistoryInput): Promise<ViewHistory>;
  // --- end views additions ---

  /** The owner's requests to the master, newest activity first. */
  subscribeRequests(
    missionId: MissionId,
    listener: Listener<ReadonlyArray<OwnerRequest>>,
    // --- finish-a ---
    onError?: Listener<unknown>,
    // --- end finish-a ---
  ): Unsubscribe;
  /** One request with its whole conversation and full message bodies; null when unknown. */
  subscribeRequest(input: RequestThreadInput, listener: Listener<OwnerRequest | null>): Unsubscribe;
  /** Starts a request from the composer, or from Discuss with a subject. */
  openRequest(input: OpenRequestInput): Promise<OwnerRequest>;
  replyRequest(input: ReplyRequestInput): Promise<void>;
  settleRequest(input: RequestNoteInput): Promise<void>;
  reopenRequest(input: RequestNoteInput): Promise<void>;
  /** The owner opened the request; clears its unread dot. */
  markRequestRead(input: RequestIdInput): Promise<void>;
}
