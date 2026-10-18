import type {
  AckNoteInput,
  AnswerAskInput,
  Approver,
  CriticalityVerdict,
  DecideApprovalInput,
  DecideDraftInput,
  DecideKnockInput,
  DecideSuggestionInput,
  DraftNote,
  DraftNoteScope,
  ForkId,
  Lane,
  LaneId,
  MarkMissionSeenInput,
  MarkReadInput,
  MergeLanesInput,
  MissionActor,
  MissionEvent,
  MissionEventId,
  MissionEventKind,
  MissionFork,
  MissionId,
  MissionInbox,
  MissionInboxHistory,
  MissionLink,
  MissionListSnapshot,
  MissionMessage,
  MissionOverview,
  MissionRecordRef,
  MissionRoutingTable,
  MissionTier,
  PoolHoldId,
  PoolId,
  PoolsSnapshot,
  PostMessageInput,
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
  Rule,
  RuleChangeRequest,
  RuleId,
  SetApprovalRoutingInput,
  SetCriticalityGuideInput,
  SetDraftNoteActiveInput,
  SetMissionFocusInput,
  SetPoolCapacityInput as ContractSetPoolCapacityInput,
  SetRoleModelInput,
  SplitLaneInput,
  SubMissionId,
  Suggestion,
  SuggestionStats,
  UpsertRuleInput,
  WorkItem,
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
};

// --- Lanes and work --------------------------------------------------------

export interface NudgeLaneInput {
  readonly laneId: LaneId;
  /** What the lane should look at; delivered as a room message to the lane lead. */
  readonly note: string;
}

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

export interface MissionWorkSnapshot {
  readonly missionId: MissionId;
  readonly items: ReadonlyArray<WorkItem>;
}

// --- Rules -----------------------------------------------------------------

/** Conflict and staleness findings over the rule book (scribe or master audit). */
export interface RuleAuditFinding {
  readonly id: string;
  readonly kind: "conflict" | "stale";
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

export type RecoveryCause =
  | "server-restart"
  | "opencode-restart"
  | "run-interrupted"
  | "succession";
export type RecoveryAction = "resume" | "notice-only" | "reconcile-first" | "skip";

export interface RecoveryLostChild {
  readonly title: string;
  readonly sessionId: string | null;
  readonly kind: "native-subagent" | "delegated-task";
  readonly lastStatus: string;
  readonly doing: string;
}

export interface RecoveryMember {
  readonly roleId: RoleId | null;
  readonly laneId: LaneId | null;
  readonly threadId: string;
  readonly cutRunId: string | null;
  readonly lastActivityAt: string | null;
  readonly lostChildren: ReadonlyArray<RecoveryLostChild>;
  readonly holds: ReadonlyArray<PoolHoldId>;
  readonly action: RecoveryAction;
  readonly why: string;
  readonly state: "pending" | "resumed" | "decided";
  readonly settledAt: string | null;
}

/** One restart, as the recovery track records it. Proposed shape. */
export interface RecoveryIncident {
  readonly id: string;
  readonly cause: RecoveryCause;
  readonly detectedAt: string;
  readonly window: { readonly from: string; readonly to: string };
  readonly missionIds: ReadonlyArray<MissionId>;
  readonly members: ReadonlyArray<RecoveryMember>;
  readonly resumesPerMinute: number;
  readonly status: "open" | "cleared";
}

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
  readonly orderChange: { readonly actor: MissionActor; readonly at: string } | null;
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
  subscribeInbox(
    missionId: MissionId | null,
    listener: Listener<MissionInboxSnapshot>,
  ): Unsubscribe;
  /** `null` means the mission has no routing table yet (everything goes to the owner). */
  subscribeRouting(
    missionId: MissionId,
    listener: Listener<ApprovalRoutingTable | null>,
  ): Unsubscribe;
  subscribeWork(missionId: MissionId, listener: Listener<MissionWorkSnapshot>): Unsubscribe;
  subscribeRuleBook(missionId: MissionId, listener: Listener<MissionRuleBook>): Unsubscribe;
  subscribeRoles(missionId: MissionId, listener: Listener<MissionRolesSnapshot>): Unsubscribe;
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
  /** The mission's event log, newest first. */
  subscribeTimeline(
    missionId: MissionId,
    listener: Listener<ReadonlyArray<MissionTimelineEvent>>,
  ): Unsubscribe;
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
  /** Forks of the master, newest first. `null` reads every mission. */
  subscribeForks(
    missionId: MissionId | null,
    listener: Listener<ReadonlyArray<MissionForkEntry>>,
  ): Unsubscribe;
  /** Mission rules, active and retired (global rules included). */
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
}
