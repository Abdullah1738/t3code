import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "../baseSchemas.ts";
import { ModelSelection } from "../modelSelection.ts";

/**
 * Fork-only Missions contracts: the records a long-running, multi-lane piece of
 * work is made of (mission, sub-missions, lanes, roles, rooms, asks, rules,
 * suggestions, drafts, pools, review policy) plus the bounded snapshots the
 * clients read. Server owns every record (`apps/server/src/ardud/missions/`,
 * tables `ardud_mission_*`); clients subscribe to one mission at a time.
 *
 * Rules the shapes encode:
 * - Owner asks never carry a default or a deadline. Only what an ask blocks waits.
 * - Suggestions never apply themselves; accept goes through the same service
 *   call a human edit uses.
 * - Owner provenance is either typed in the Robob app or a verified iMessage
 *   inbound id from the owner's or Moni's chat. Everything else is agent text.
 * - Review stages point at roles, never at model ids. "Critical" is per mission,
 *   judged by the master from a written guide.
 */

// ---------------------------------------------------------------------------
// Ids

const missionEntityId = <Brand extends string>(brand: Parameters<typeof Schema.brand<Brand>>[0]) =>
  TrimmedNonEmptyString.pipe(Schema.brand<Brand>(brand));

export const MissionId = missionEntityId("MissionId");
export type MissionId = typeof MissionId.Type;
export const SubMissionId = missionEntityId("SubMissionId");
export type SubMissionId = typeof SubMissionId.Type;
export const MilestoneId = missionEntityId("MilestoneId");
export type MilestoneId = typeof MilestoneId.Type;
export const LaneId = missionEntityId("LaneId");
export type LaneId = typeof LaneId.Type;
export const RoleId = missionEntityId("RoleId");
export type RoleId = typeof RoleId.Type;
export const RoleBindingId = missionEntityId("RoleBindingId");
export type RoleBindingId = typeof RoleBindingId.Type;
export const RoomId = missionEntityId("RoomId");
export type RoomId = typeof RoomId.Type;
export const MissionMessageId = missionEntityId("MissionMessageId");
export type MissionMessageId = typeof MissionMessageId.Type;
export const SubscriptionId = missionEntityId("SubscriptionId");
export type SubscriptionId = typeof SubscriptionId.Type;
export const AskId = missionEntityId("AskId");
export type AskId = typeof AskId.Type;
export const CallId = missionEntityId("CallId");
export type CallId = typeof CallId.Type;
export const NoteId = missionEntityId("NoteId");
export type NoteId = typeof NoteId.Type;
export const RuleId = missionEntityId("RuleId");
export type RuleId = typeof RuleId.Type;
export const RuleChangeRequestId = missionEntityId("RuleChangeRequestId");
export type RuleChangeRequestId = typeof RuleChangeRequestId.Type;
export const SuggestionId = missionEntityId("SuggestionId");
export type SuggestionId = typeof SuggestionId.Type;
export const DraftId = missionEntityId("DraftId");
export type DraftId = typeof DraftId.Type;
export const DraftNoteId = missionEntityId("DraftNoteId");
export type DraftNoteId = typeof DraftNoteId.Type;
export const KnockId = missionEntityId("KnockId");
export type KnockId = typeof KnockId.Type;
export const PoolId = missionEntityId("PoolId");
export type PoolId = typeof PoolId.Type;
export const PoolHoldId = missionEntityId("PoolHoldId");
export type PoolHoldId = typeof PoolHoldId.Type;
export const WorkItemId = missionEntityId("WorkItemId");
export type WorkItemId = typeof WorkItemId.Type;
export const ReviewStageId = missionEntityId("ReviewStageId");
export type ReviewStageId = typeof ReviewStageId.Type;
export const ReviewLadderId = missionEntityId("ReviewLadderId");
export type ReviewLadderId = typeof ReviewLadderId.Type;
export const CriticalityVerdictId = missionEntityId("CriticalityVerdictId");
export type CriticalityVerdictId = typeof CriticalityVerdictId.Type;
export const ReviewRecordId = missionEntityId("ReviewRecordId");
export type ReviewRecordId = typeof ReviewRecordId.Type;
export const ApprovalId = missionEntityId("ApprovalId");
export type ApprovalId = typeof ApprovalId.Type;
export const ForkId = missionEntityId("MissionForkId");
export type ForkId = typeof ForkId.Type;
export const MissionEventId = missionEntityId("MissionEventId");
export type MissionEventId = typeof MissionEventId.Type;

// ---------------------------------------------------------------------------
// Shared pieces

/** Short text shown in lists. Full bodies load on open, never in list payloads. */
export const MissionSummaryText = TrimmedNonEmptyString.check(Schema.isMaxLength(400));
export type MissionSummaryText = typeof MissionSummaryText.Type;

export const MissionHealth = Schema.Literals(["green", "amber", "red", "unknown"]);
export type MissionHealth = typeof MissionHealth.Type;

export const MissionTier = Schema.Literals(["P0", "P1", "P2"]);
export type MissionTier = typeof MissionTier.Type;

export const Confidence = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
export type Confidence = typeof Confidence.Type;

export const Share = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
export type Share = typeof Share.Type;

export const OwnerSurface = Schema.Literals(["web", "desktop", "mobile"]);
export type OwnerSurface = typeof OwnerSurface.Type;

/** The owner's and Moni's chats are both trusted for answers and approvals. */
export const TrustedChat = Schema.Literals(["owner", "moni"]);
export type TrustedChat = typeof TrustedChat.Type;

/**
 * Where a record's authority comes from. Only `owner-app` and `owner-imessage`
 * count as the owner. The server sets this; clients and agents never send it.
 */
export const MissionProvenance = Schema.Union([
  Schema.TaggedStruct("owner-app", {
    surface: OwnerSurface,
    /** Auth session that typed it, when known. */
    sessionId: Schema.NullOr(Schema.String),
  }),
  Schema.TaggedStruct("owner-imessage", {
    chat: TrustedChat,
    /** Spectrum inbound message id the server verified (exists, trusted chat, contains the text). */
    inboundId: TrimmedNonEmptyString,
  }),
  Schema.TaggedStruct("agent", {
    threadId: ThreadId,
    roleId: Schema.NullOr(RoleId),
  }),
  Schema.TaggedStruct("system", {
    /** Server component, e.g. `governor`, `code-check`, `crw`, `coord-shim`. */
    component: TrimmedNonEmptyString,
  }),
  Schema.TaggedStruct("import", {
    /** e.g. `coord.db`, `STANDING-RULES.md`, `LANE-ROSTER.md`. */
    source: TrimmedNonEmptyString,
  }),
]);
export type MissionProvenance = typeof MissionProvenance.Type;

export const isOwnerProvenance = (provenance: MissionProvenance): boolean =>
  provenance._tag === "owner-app" || provenance._tag === "owner-imessage";

/** Who did or is addressed by something inside a mission. */
export const MissionActor = Schema.Union([
  Schema.TaggedStruct("owner", {}),
  Schema.TaggedStruct("role", { roleId: RoleId }),
  Schema.TaggedStruct("lane", { laneId: LaneId }),
  Schema.TaggedStruct("thread", { threadId: ThreadId }),
  Schema.TaggedStruct("system", { component: TrimmedNonEmptyString }),
  /** A person outside the swarm (a dev on Cliq or Linear). */
  Schema.TaggedStruct("person", { name: TrimmedNonEmptyString }),
]);
export type MissionActor = typeof MissionActor.Type;

/** A pointer to any record, used by evidence, blockers, suggestions and the timeline. */
export const MissionRecordKind = Schema.Literals([
  "mission",
  "sub-mission",
  "milestone",
  "lane",
  "role",
  "room",
  "message",
  "ask",
  "call",
  "note",
  "rule",
  "rule-change-request",
  "suggestion",
  "draft",
  "draft-note",
  "knock",
  "pool",
  "pool-hold",
  "review-policy",
  "criticality-verdict",
  "review",
  "work-item",
  "approval",
  "fork",
  "thread",
]);
export type MissionRecordKind = typeof MissionRecordKind.Type;

export const MissionRecordRef = Schema.Struct({
  kind: MissionRecordKind,
  id: TrimmedNonEmptyString,
  label: Schema.optional(Schema.String),
});
export type MissionRecordRef = typeof MissionRecordRef.Type;

/** An outside link: a PR, CI run, Linear ticket, deploy readback, transcript range. */
export const MissionLink = Schema.Struct({
  kind: Schema.Literals([
    "pull-request",
    "commit",
    "ci-run",
    "ticket",
    "deploy",
    "transcript",
    "file",
    "url",
  ]),
  label: Schema.String,
  url: Schema.NullOr(Schema.String),
  /** Repo-relative path, ticket key, run id, `threadId#e10-e14`, as the kind needs. */
  ref: Schema.NullOr(Schema.String),
});
export type MissionLink = typeof MissionLink.Type;

export const PullRequestKey = Schema.Struct({
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
});
export type PullRequestKey = typeof PullRequestKey.Type;

/** Field names the owner locked on a record. Only the owner edits a locked field. */
export const LockedFields = Schema.Array(TrimmedNonEmptyString);
export type LockedFields = typeof LockedFields.Type;

// ---------------------------------------------------------------------------
// Mission structure

export const MissionStatus = Schema.Literals(["active", "paused", "draining", "archived"]);
export type MissionStatus = typeof MissionStatus.Type;

export const Mission = Schema.Struct({
  id: MissionId,
  slug: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  goal: Schema.String,
  status: MissionStatus,
  tier: MissionTier,
  /** Relative weight inside a tier for borrowing above the guaranteed share. */
  weight: PositiveInt,
  /** Guaranteed share of the global model pools, 0..1. */
  guaranteedShare: Share,
  /** Ceiling when borrowing idle capacity from other missions, 0..1. */
  borrowCeiling: Share,
  projectId: Schema.NullOr(ProjectId),
  masterRoleId: Schema.NullOr(RoleId),
  /** Focus mode: only this sub-mission admits new work. */
  focusSubMissionId: Schema.NullOr(SubMissionId),
  health: MissionHealth,
  lockedFields: LockedFields,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Mission = typeof Mission.Type;

export const SubMissionStatus = Schema.Literals(["active", "paused", "closed"]);
export type SubMissionStatus = typeof SubMissionStatus.Type;

export const SubMission = Schema.Struct({
  id: SubMissionId,
  missionId: MissionId,
  title: TrimmedNonEmptyString,
  /** What the owner wants from it, in his words or the master's. */
  intent: Schema.String,
  /** Priority order inside the mission, 0 first. The owner sets it after the master's first round. */
  order: NonNegativeInt,
  /** Takes idle capacity when higher sub-missions have no ready work. */
  fillIdleCapacity: Schema.Boolean,
  status: SubMissionStatus,
  /** Optional sub-coordinator that owns this sub-mission's lanes. */
  coordinatorRoleId: Schema.NullOr(RoleId),
  /** Owner's intended share of mission effort and the measured share, 0..1. */
  intendedEffort: Schema.NullOr(Share),
  actualEffort: Schema.NullOr(Share),
  health: MissionHealth,
  lockedFields: LockedFields,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type SubMission = typeof SubMission.Type;

export const MilestoneStatus = Schema.Literals([
  "planned",
  "on-track",
  "at-risk",
  "done",
  "missed",
]);
export type MilestoneStatus = typeof MilestoneStatus.Type;

export const Milestone = Schema.Struct({
  id: MilestoneId,
  missionId: MissionId,
  subMissionId: SubMissionId,
  title: TrimmedNonEmptyString,
  targetAt: Schema.NullOr(IsoDateTime),
  status: MilestoneStatus,
  /** Why it is at risk, or what closed it. */
  statusNote: Schema.NullOr(Schema.String),
  itemIds: Schema.Array(WorkItemId),
  // --- core additions ---
  /** Fields only the owner may change. Missing means none. */
  lockedFields: Schema.optional(LockedFields),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Milestone = typeof Milestone.Type;

export const LaneStatus = Schema.Literals([
  "working",
  "stuck",
  "waiting",
  "idle",
  "parked",
  "retired",
]);
export type LaneStatus = typeof LaneStatus.Type;

export const LaneEvidence = Schema.Struct({
  summary: MissionSummaryText,
  at: IsoDateTime,
  messageId: Schema.NullOr(MissionMessageId),
  links: Schema.Array(MissionLink),
});
export type LaneEvidence = typeof LaneEvidence.Type;

export const ContextGauge = Schema.Struct({
  promptTokens: NonNegativeInt,
  limitTokens: PositiveInt,
  /** Successions this lane's lead has had (Z1..Zn on the role page). */
  successions: NonNegativeInt,
});
export type ContextGauge = typeof ContextGauge.Type;

export const Lane = Schema.Struct({
  id: LaneId,
  missionId: MissionId,
  subMissionId: Schema.NullOr(SubMissionId),
  name: TrimmedNonEmptyString,
  purpose: Schema.String,
  status: LaneStatus,
  /** Why it is stuck, waiting or parked. */
  statusReason: Schema.NullOr(Schema.String),
  // --- core additions ---
  /** Fields only the owner may change. Missing means none. */
  lockedFields: Schema.optional(LockedFields),
  leadRoleId: Schema.NullOr(RoleId),
  /** Thread currently doing the lane's work (the lead's binding). */
  threadId: Schema.NullOr(ThreadId),
  currentItemId: Schema.NullOr(WorkItemId),
  lastEvidence: Schema.NullOr(LaneEvidence),
  context: Schema.NullOr(ContextGauge),
  lastActiveAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Lane = typeof Lane.Type;

// ---------------------------------------------------------------------------
// Roles

export const RoleKind = Schema.Literals([
  "master",
  "sub-coordinator",
  "lane-lead",
  "lane-worker",
  "reviewer",
  "final-reviewer",
  "writer",
  "scribe",
  "editor",
  "verifier",
  "answerer",
  "custom",
]);
export type RoleKind = typeof RoleKind.Type;

export const Role = Schema.Struct({
  id: RoleId,
  missionId: MissionId,
  kind: RoleKind,
  name: TrimmedNonEmptyString,
  description: Schema.String,
  /** Model every holder of this role runs. Applies at the holder's next turn. */
  modelSelection: ModelSelection,
  /** A requested model change not yet applied by every holder. */
  pendingModelSelection: Schema.NullOr(ModelSelection),
  /** Lane this role belongs to, for lane leads and workers. */
  laneId: Schema.NullOr(LaneId),
  /** Never writes outward text (reviewers). Their output is findings for a writer. */
  writesPublicText: Schema.Boolean,
  lockedFields: LockedFields,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Role = typeof Role.Type;

export const RoleBindingReason = Schema.Literals(["initial", "succession", "rebind", "import"]);
export type RoleBindingReason = typeof RoleBindingReason.Type;

/** A thread holding a role. Succession closes one binding and opens the next. */
export const RoleBinding = Schema.Struct({
  id: RoleBindingId,
  roleId: RoleId,
  threadId: ThreadId,
  reason: RoleBindingReason,
  /** The handoff note the new holder started from. */
  handoffNote: Schema.NullOr(Schema.String),
  /** Model the holder actually ran last turn; a mismatch with the role is drift. */
  observedModel: Schema.NullOr(Schema.String),
  boundAt: IsoDateTime,
  endedAt: Schema.NullOr(IsoDateTime),
});
export type RoleBinding = typeof RoleBinding.Type;

// ---------------------------------------------------------------------------
// Rooms, messages, subscriptions

export const RoomKind = Schema.Literals([
  "sub-mission",
  "work-item",
  "control",
  "release",
  "arch",
  "lane",
  "custom",
]);
export type RoomKind = typeof RoomKind.Type;

export const RoomNoise = Schema.Struct({
  messagesPerHour: Schema.Number,
  /** Share of messages that were blockers, requests, decisions or controls. */
  actionableShare: Share,
  /** Wakes whose recipient acked without acting, last 24h. */
  wastedWakes: NonNegativeInt,
});
export type RoomNoise = typeof RoomNoise.Type;

export const Room = Schema.Struct({
  id: RoomId,
  missionId: MissionId,
  subMissionId: Schema.NullOr(SubMissionId),
  kind: RoomKind,
  title: TrimmedNonEmptyString,
  workItemId: Schema.NullOr(WorkItemId),
  archived: Schema.Boolean,
  /** Newest message seq in this room. */
  lastSeq: NonNegativeInt,
  lastMessageAt: Schema.NullOr(IsoDateTime),
  noise: Schema.NullOr(RoomNoise),
  createdAt: IsoDateTime,
});
export type Room = typeof Room.Type;

/** Same kinds as coord events, so the coord forward shim maps 1:1. */
export const MissionMessageKind = Schema.Literals([
  "request",
  "decision",
  "status",
  "evidence",
  "blocker",
  "control",
]);
export type MissionMessageKind = typeof MissionMessageKind.Type;

export const BroadcastReceipt = Schema.Struct({
  reached: NonNegativeInt,
  total: NonNegativeInt,
  /** Recipients not reached yet, by label. */
  pending: Schema.Array(Schema.String),
});
export type BroadcastReceipt = typeof BroadcastReceipt.Type;

// --- coord additions ---
/**
 * The coord event a message mirrors: imported history, or a post that came in
 * through the coord forward shim. Keeps the coord-only fields so the shim can
 * answer `coord inbox` with the same rows coord itself returned.
 */
export const CoordEventRef = Schema.Struct({
  /** coord channel id (control, release, arch, observe, delivery). */
  channel: TrimmedNonEmptyString,
  /** coord actor id that posted it. */
  sender: TrimmedNonEmptyString,
  /** coord's canonical sha256 of the post fields; same key + other hash = conflict. */
  bodyHash: Schema.NullOr(Schema.String),
  workId: Schema.NullOr(Schema.String),
  environment: Schema.NullOr(Schema.String),
  expectedRevision: Schema.NullOr(Schema.String),
  authorityRef: Schema.NullOr(Schema.String),
  /** coord seq this replies to. */
  replyTo: Schema.NullOr(NonNegativeInt),
});
export type CoordEventRef = typeof CoordEventRef.Type;
// --- end coord additions ---

/** List shape of a room message. `body` loads on open via a separate call. */
export const MissionMessage = Schema.Struct({
  id: MissionMessageId,
  missionId: MissionId,
  roomId: RoomId,
  /** Monotonic per mission. Read positions and deltas use it. */
  seq: NonNegativeInt,
  kind: MissionMessageKind,
  author: MissionActor,
  provenance: MissionProvenance,
  /** Explicit addressees. Empty means room subscribers by their wake rules. */
  to: Schema.Array(MissionActor),
  summary: MissionSummaryText,
  hasBody: Schema.Boolean,
  /** Idempotency key; the same key with a different body is a conflict. */
  key: Schema.NullOr(Schema.String),
  workItemId: Schema.NullOr(WorkItemId),
  links: Schema.Array(MissionLink),
  /** For controls: how many named recipients have read it. */
  receipt: Schema.NullOr(BroadcastReceipt),
  /** Owner post marked "correct the master": the scribe offers it as a rule. */
  isCorrection: Schema.Boolean,
  createdAt: IsoDateTime,
  // --- coord additions ---
  /** Set when the message mirrors a coord event (import or forward shim). */
  coord: Schema.optional(CoordEventRef),
  // --- end coord additions ---
});
export type MissionMessage = typeof MissionMessage.Type;

export const MissionMessageBody = Schema.Struct({
  messageId: MissionMessageId,
  body: Schema.String,
});
export type MissionMessageBody = typeof MissionMessageBody.Type;

export const SubscriptionMode = Schema.Literals(["wake", "read", "mute"]);
export type SubscriptionMode = typeof SubscriptionMode.Type;

/**
 * Who hears a room and what wakes them. Defaults: blocker/request to a role
 * wakes that role; evidence of done wakes the item lead and verifier; status
 * wakes nobody; controls wake named roles and return a receipt.
 */
export const Subscription = Schema.Struct({
  id: SubscriptionId,
  roomId: RoomId,
  subscriber: MissionActor,
  mode: SubscriptionMode,
  wakeOn: Schema.Array(MissionMessageKind),
  createdAt: IsoDateTime,
});
export type Subscription = typeof Subscription.Type;

/** Read position doubles as the ack: everything at or below `seq` is handled. */
export const ReadPosition = Schema.Struct({
  roomId: RoomId,
  reader: MissionActor,
  seq: NonNegativeInt,
  updatedAt: IsoDateTime,
});
export type ReadPosition = typeof ReadPosition.Type;

/** At most one outstanding doorbell per thread; later deliveries coalesce into it. */
export const Doorbell = Schema.Struct({
  threadId: ThreadId,
  missionId: MissionId,
  state: Schema.Literals(["outstanding", "clear"]),
  pendingMessages: NonNegativeInt,
  oldestPendingSeq: Schema.NullOr(NonNegativeInt),
  lastRungAt: Schema.NullOr(IsoDateTime),
});
export type Doorbell = typeof Doorbell.Type;

// ---------------------------------------------------------------------------
// Boundary: knocks

export const KnockStatus = Schema.Literals(["pending", "forwarded", "dropped"]);
export type KnockStatus = typeof KnockStatus.Type;

/** A thread outside the mission trying to reach it. The owner forwards, edits or drops. */
export const Knock = Schema.Struct({
  id: KnockId,
  missionId: MissionId,
  fromThreadId: ThreadId,
  fromTitle: Schema.String,
  /** The send path that was stopped: control-api, thread-send, queued-send, coord-shim. */
  path: TrimmedNonEmptyString,
  summary: MissionSummaryText,
  body: Schema.String,
  status: KnockStatus,
  /** Text actually forwarded, if the owner edited it. */
  forwardedText: Schema.NullOr(Schema.String),
  forwardedTo: Schema.NullOr(MissionActor),
  decidedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  // --- router additions ---
  /** The member thread the sender tried to reach. */
  targetThreadId: Schema.optional(ThreadId),
  /**
   * What kind of sender knocked. For anything but a thread, `fromThreadId`
   * is a label such as `control-api:<subject>`, not a real thread.
   */
  senderKind: Schema.optional(Schema.Literals(["thread", "session", "mcp-client", "schedule"])),
});
export type Knock = typeof Knock.Type;

// ---------------------------------------------------------------------------
// Asks and calls

export const AskOption = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  detail: Schema.String,
});
export type AskOption = typeof AskOption.Type;

export const AskStatus = Schema.Literals(["open", "answered", "withdrawn", "superseded"]);
export type AskStatus = typeof AskStatus.Type;

export const AskAnswer = Schema.Struct({
  optionId: Schema.NullOr(TrimmedNonEmptyString),
  text: Schema.String,
  provenance: MissionProvenance,
  answeredAt: IsoDateTime,
});
export type AskAnswer = typeof AskAnswer.Type;

/**
 * A question for the owner. It never has a default, a deadline or "unless you
 * say otherwise": only the records in `blocks` wait; every other lane continues.
 */
export const Ask = Schema.Struct({
  id: AskId,
  missionId: MissionId,
  subMissionId: Schema.NullOr(SubMissionId),
  askedBy: MissionActor,
  question: TrimmedNonEmptyString,
  context: Schema.String,
  options: Schema.Array(AskOption),
  /** The asker's pick and why. Advice only; never applied without an answer. */
  recommendation: Schema.NullOr(
    Schema.Struct({
      optionId: Schema.NullOr(TrimmedNonEmptyString),
      reason: Schema.String,
    }),
  ),
  /** What waits on this answer. */
  blocks: Schema.Array(MissionRecordRef),
  costOfWaiting: Schema.String,
  urgency: Schema.Literals(["normal", "p0"]),
  status: AskStatus,
  answer: Schema.NullOr(AskAnswer),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Ask = typeof Ask.Type;

/** A decision the master made itself. Calls since the owner last looked form the direction check. */
export const Call = Schema.Struct({
  id: CallId,
  missionId: MissionId,
  subMissionId: Schema.NullOr(SubMissionId),
  decidedBy: MissionActor,
  title: TrimmedNonEmptyString,
  decision: Schema.String,
  reason: Schema.String,
  alternatives: Schema.Array(Schema.String),
  reversible: Schema.Boolean,
  /** Structural changes (sub-missions, lanes, roles, pools, guide) are calls too. */
  subject: Schema.NullOr(MissionRecordRef),
  ownerReaction: Schema.NullOr(Schema.Literals(["ok", "discuss", "overruled"])),
  createdAt: IsoDateTime,
});
export type Call = typeof Call.Type;

// ---------------------------------------------------------------------------
// Scribe notes

export const NoteType = Schema.Literals([
  "decision",
  "assumption",
  "deviation",
  "risk",
  "blocker",
  "owner-must-know",
  "rule-break",
  "claim-of-done",
  "open-question",
]);
export type NoteType = typeof NoteType.Type;

export const NoteSeverity = Schema.Literals(["low", "medium", "high", "critical"]);
export type NoteSeverity = typeof NoteSeverity.Type;

export const NoteSource = Schema.Struct({
  threadId: ThreadId,
  /** Exact text quoted from the transcript; code checks it is really there. */
  quote: Schema.String,
  /** Inclusive event range in the thread the quote came from. */
  fromEvent: NonNegativeInt,
  toEvent: NonNegativeInt,
});
export type NoteSource = typeof NoteSource.Type;

export const Note = Schema.Struct({
  id: NoteId,
  missionId: MissionId,
  subMissionId: Schema.NullOr(SubMissionId),
  laneId: Schema.NullOr(LaneId),
  type: NoteType,
  summary: MissionSummaryText,
  sources: Schema.Array(NoteSource),
  /** Seen in code or tools vs only said by an agent. */
  basis: Schema.Literals(["observed", "claimed"]),
  severity: NoteSeverity,
  confidence: Confidence,
  author: Schema.Literals(["scribe", "editor", "master", "code-check"]),
  citation: Schema.Literals(["verified", "failed", "unchecked"]),
  /** For claim-of-done: whether code evidence (git, CI, PR, deploy readback) matches. */
  evidence: Schema.Literals(["matched", "mismatch", "missing", "not-applicable"]),
  evidenceLinks: Schema.Array(MissionLink),
  replacesNoteId: Schema.NullOr(NoteId),
  ackedBy: Schema.Array(MissionActor),
  createdAt: IsoDateTime,
});
export type Note = typeof Note.Type;

// ---------------------------------------------------------------------------
// Rules

export const RuleStatus = Schema.Literals(["active", "retired"]);
export type RuleStatus = typeof RuleStatus.Type;

export const RuleScope = Schema.Struct({
  /** Empty arrays mean the whole mission. */
  subMissionIds: Schema.Array(SubMissionId),
  roleKinds: Schema.Array(RoleKind),
  laneIds: Schema.Array(LaneId),
});
export type RuleScope = typeof RuleScope.Type;

export const RuleAck = Schema.Struct({
  actor: MissionActor,
  version: PositiveInt,
  at: IsoDateTime,
});
export type RuleAck = typeof RuleAck.Type;

/** An owner rule. Only the owner creates, edits or retires one; the master can suggest. */
export const Rule = Schema.Struct({
  id: RuleId,
  missionId: Schema.NullOr(MissionId),
  /** Imported numbering (Crpko rule 103), if any. */
  number: Schema.NullOr(PositiveInt),
  title: TrimmedNonEmptyString,
  /** The owner's words, verbatim. */
  quote: Schema.String,
  quotedAt: IsoDateTime,
  provenance: MissionProvenance,
  /** How the master reads and applies it. */
  masterReading: Schema.String,
  scope: RuleScope,
  /** Empty means always on; otherwise when it applies. */
  activation: Schema.String,
  status: RuleStatus,
  version: PositiveInt,
  acks: Schema.Array(RuleAck),
  appliedCount: NonNegativeInt,
  brokenCount: NonNegativeInt,
  lastReliedAt: Schema.NullOr(IsoDateTime),
  lockedFields: LockedFields,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Rule = typeof Rule.Type;

export const RuleChangeRequestStatus = Schema.Literals([
  "open",
  "applied",
  "declined",
  "withdrawn",
]);
export type RuleChangeRequestStatus = typeof RuleChangeRequestStatus.Type;

/**
 * The owner asks the master to modify a rule ("send a modification request to master").
 * The master answers with a proposed new wording or a reason; only the owner applies it.
 */
export const RuleChangeRequest = Schema.Struct({
  id: RuleChangeRequestId,
  ruleId: RuleId,
  missionId: Schema.NullOr(MissionId),
  /** What the owner wants changed, in their words. */
  request: Schema.String,
  provenance: MissionProvenance,
  status: RuleChangeRequestStatus,
  /** The master's proposed wording or scope, if it has one. */
  proposedQuote: Schema.NullOr(Schema.String),
  proposedScope: Schema.NullOr(RuleScope),
  masterResponse: Schema.NullOr(Schema.String),
  /** Discuss fork opened for this request, if any. */
  forkId: Schema.NullOr(ForkId),
  createdAt: IsoDateTime,
  resolvedAt: Schema.NullOr(IsoDateTime),
});
export type RuleChangeRequest = typeof RuleChangeRequest.Type;

// ---------------------------------------------------------------------------
// Suggestions

export const SuggestionTargetKind = Schema.Literals([
  "role",
  "role-model",
  "rule",
  "review-policy",
  "criticality-guide",
  "pool",
  "sub-mission-order",
  "lane",
  "schedule",
  "draft-note",
]);
export type SuggestionTargetKind = typeof SuggestionTargetKind.Type;

export const SuggestionAuthor = Schema.Literals([
  "scribe",
  "editor",
  "master",
  "governor",
  "owner-corrections",
  "code-check",
]);
export type SuggestionAuthor = typeof SuggestionAuthor.Type;

export const SuggestionStatus = Schema.Literals(["open", "accepted", "edited", "dismissed"]);
export type SuggestionStatus = typeof SuggestionStatus.Type;

export const Suggestion = Schema.Struct({
  id: SuggestionId,
  missionId: Schema.NullOr(MissionId),
  targetKind: SuggestionTargetKind,
  /** The record it targets; null when it proposes a new record (a new draft note). */
  target: Schema.NullOr(MissionRecordRef),
  title: TrimmedNonEmptyString,
  /** The record's fields before and after, as JSON; accept applies `after`. */
  before: Schema.NullOr(Schema.Unknown),
  after: Schema.Unknown,
  /** Human-readable diff for the card. */
  diffText: Schema.String,
  why: Schema.String,
  evidence: Schema.Array(Schema.Union([MissionRecordRef, MissionLink])),
  author: SuggestionAuthor,
  /** Who may accept it, by decision rights. */
  acceptor: Schema.Literals(["owner", "master"]),
  status: SuggestionStatus,
  dismissReason: Schema.NullOr(Schema.String),
  /** What happened after acceptance, filled in later. */
  outcome: Schema.NullOr(Schema.String),
  decidedBy: Schema.NullOr(MissionProvenance),
  decidedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
});
export type Suggestion = typeof Suggestion.Type;

export const SuggestionStats = Schema.Struct({
  author: SuggestionAuthor,
  targetKind: SuggestionTargetKind,
  shown: NonNegativeInt,
  accepted: NonNegativeInt,
  dismissed: NonNegativeInt,
  /** Raised when most are dismissed; fewer get shown. */
  bar: Schema.Literals(["normal", "raised", "high"]),
});
export type SuggestionStats = typeof SuggestionStats.Type;

// ---------------------------------------------------------------------------
// Drafts and draft notes

export const DraftChannel = Schema.Literals([
  "linear",
  "github",
  "cliq",
  "imessage",
  "whatsapp",
  "email",
  "telegram",
  "other",
]);
export type DraftChannel = typeof DraftChannel.Type;

export const DraftStatus = Schema.Literals([
  "pending",
  "approved",
  "rewrite-requested",
  "dropped",
  "sent",
  "send-failed",
]);
export type DraftStatus = typeof DraftStatus.Type;

/** Every outward text is a draft until the owner approves it. */
export const Draft = Schema.Struct({
  id: DraftId,
  missionId: MissionId,
  audience: TrimmedNonEmptyString,
  channel: DraftChannel,
  /** Where it goes: ticket key, PR, Cliq chat, person. */
  target: MissionLink,
  text: Schema.String,
  /** Text the owner approved, when he edited it first. */
  approvedText: Schema.NullOr(Schema.String),
  writerRoleId: Schema.NullOr(RoleId),
  source: Schema.Struct({
    kind: Schema.Literals(["fork", "lane", "master", "editor"]),
    ref: Schema.NullOr(MissionRecordRef),
  }),
  /** Draft notes the writer applied. */
  appliedNoteIds: Schema.Array(DraftNoteId),
  status: DraftStatus,
  rewriteNote: Schema.NullOr(Schema.String),
  decidedBy: Schema.NullOr(MissionProvenance),
  decidedAt: Schema.NullOr(IsoDateTime),
  sentAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
});
export type Draft = typeof Draft.Type;

export const DraftNoteScope = Schema.Union([
  Schema.TaggedStruct("all", {}),
  Schema.TaggedStruct("channel", { channel: DraftChannel }),
  Schema.TaggedStruct("person", { name: TrimmedNonEmptyString }),
]);
export type DraftNoteScope = typeof DraftNoteScope.Type;

/** Style guidance writers load every time for matching drafts. */
export const DraftNote = Schema.Struct({
  id: DraftNoteId,
  missionId: Schema.NullOr(MissionId),
  scope: DraftNoteScope,
  text: TrimmedNonEmptyString,
  source: Schema.Literals(["owner", "suggestion", "import"]),
  active: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type DraftNote = typeof DraftNote.Type;

// ---------------------------------------------------------------------------
// Approvals from outside (crw Awaiting Decision, deploy holds)

export const ApprovalStatus = Schema.Literals(["pending", "approved", "rejected", "stale-closed"]);
export type ApprovalStatus = typeof ApprovalStatus.Type;

export const Approval = Schema.Struct({
  id: ApprovalId,
  missionId: MissionId,
  kind: Schema.Literals(["merge", "deploy", "release", "other"]),
  title: TrimmedNonEmptyString,
  detail: Schema.String,
  /** System that needs it, e.g. `crw`. */
  requestedBy: TrimmedNonEmptyString,
  links: Schema.Array(MissionLink),
  status: ApprovalStatus,
  /** Auto-closes as stale when the head moves or the item is gone. */
  staleReason: Schema.NullOr(Schema.String),
  decidedBy: Schema.NullOr(MissionProvenance),
  decidedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
});
export type Approval = typeof Approval.Type;

// ---------------------------------------------------------------------------
// Pools

export const PoolScope = Schema.Union([
  Schema.TaggedStruct("mission", { missionId: MissionId }),
  Schema.TaggedStruct("shared", { missionIds: Schema.Array(MissionId) }),
  Schema.TaggedStruct("global", {}),
]);
export type PoolScope = typeof PoolScope.Type;

export const PoolKind = Schema.Literals(["lease", "budget", "observed"]);
export type PoolKind = typeof PoolKind.Type;

export const PoolBackend = Schema.Literals([
  "native",
  "coord-claim",
  "crw-config",
  "9router",
  "offbox",
]);
export type PoolBackend = typeof PoolBackend.Type;

export const PoolUsage = Schema.Struct({
  used: Schema.Number,
  /** For budgets: the window the spend is counted over, e.g. `5h`, `7d`, `day`, `month`. */
  window: Schema.NullOr(Schema.String),
  /** When the current window resets, if known. */
  resetsAt: Schema.NullOr(IsoDateTime),
  /** Projected time the pool runs out at the current rate. */
  runOutAt: Schema.NullOr(IsoDateTime),
  sampledAt: IsoDateTime,
});
export type PoolUsage = typeof PoolUsage.Type;

export const Pool = Schema.Struct({
  id: PoolId,
  name: TrimmedNonEmptyString,
  /** e.g. `slot`, `review`, `USD`, `% of 5h window`. */
  unit: TrimmedNonEmptyString,
  capacity: Schema.Number,
  scope: PoolScope,
  kind: PoolKind,
  backend: PoolBackend,
  enforcement: Schema.Literals(["advisory", "enforced"]),
  usage: PoolUsage,
  /** Mission ids in admission priority order when contended. */
  priority: Schema.Array(MissionId),
  lockedFields: LockedFields,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Pool = typeof Pool.Type;

export const PoolHoldStatus = Schema.Literals([
  "queued",
  "active",
  "released",
  "expired",
  "reconcile-required",
]);
export type PoolHoldStatus = typeof PoolHoldStatus.Type;

/**
 * A lease on a pool, same model as coord claims: a monotonic fence per pool.
 * An expired hold blocks others until reconciled; it never means a repeat is safe.
 */
export const PoolHold = Schema.Struct({
  id: PoolHoldId,
  poolId: PoolId,
  missionId: MissionId,
  holder: MissionActor,
  amount: Schema.Number,
  purpose: Schema.String,
  fence: PositiveInt,
  status: PoolHoldStatus,
  leaseExpiresAt: Schema.NullOr(IsoDateTime),
  takenAt: Schema.NullOr(IsoDateTime),
  releasedAt: Schema.NullOr(IsoDateTime),
  releaseNote: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
});
export type PoolHold = typeof PoolHold.Type;

// ---------------------------------------------------------------------------
// Review policy

export const ReviewStage = Schema.Struct({
  id: ReviewStageId,
  label: TrimmedNonEmptyString,
  /** Stages point at roles, never at model ids. */
  roleId: RoleId,
});
export type ReviewStage = typeof ReviewStage.Type;

export const ReviewLadder = Schema.Struct({
  id: ReviewLadderId,
  name: TrimmedNonEmptyString,
  appliesTo: Schema.Literals(["normal", "critical", "custom"]),
  /** For custom ladders: when it applies, in words, judged like the guide. */
  condition: Schema.NullOr(Schema.String),
  stageIds: Schema.Array(ReviewStageId),
});
export type ReviewLadder = typeof ReviewLadder.Type;

export const CriticalityTrigger = Schema.Union([
  Schema.TaggedStruct("changed-lines", { atLeast: PositiveInt }),
  Schema.TaggedStruct("path", { pattern: TrimmedNonEmptyString }),
  Schema.TaggedStruct("label", { label: TrimmedNonEmptyString }),
]);
export type CriticalityTrigger = typeof CriticalityTrigger.Type;

export const CriticalityGuide = Schema.Struct({
  /** Written instruction of what counts as critical in this mission. Empty = every PR is normal. */
  text: Schema.String,
  hardTriggers: Schema.Array(CriticalityTrigger),
  version: NonNegativeInt,
  authoredBy: MissionActor,
  updatedAt: IsoDateTime,
});
export type CriticalityGuide = typeof CriticalityGuide.Type;

export const ReviewPolicy = Schema.Struct({
  missionId: MissionId,
  version: PositiveInt,
  stages: Schema.Array(ReviewStage),
  ladders: Schema.Array(ReviewLadder),
  /** Plain rules every round follows (no round cap, one-sitting fix packets, ...). */
  commonRules: Schema.Array(Schema.String),
  guide: CriticalityGuide,
  /** Who records verdicts: the master, or lane leads when the guide delegates it. */
  judgedBy: Schema.Literals(["master", "lane-leads"]),
  lockedFields: LockedFields,
  updatedAt: IsoDateTime,
});
export type ReviewPolicy = typeof ReviewPolicy.Type;

export const CriticalityVerdict = Schema.Struct({
  id: CriticalityVerdictId,
  missionId: MissionId,
  pullRequest: PullRequestKey,
  critical: Schema.Boolean,
  reason: Schema.String,
  guideVersion: NonNegativeInt,
  source: Schema.Literals(["guide", "hard-trigger", "reclassified", "owner"]),
  decidedBy: MissionActor,
  supersedesId: Schema.NullOr(CriticalityVerdictId),
  createdAt: IsoDateTime,
});
export type CriticalityVerdict = typeof CriticalityVerdict.Type;

/** A review round as an evidence record, bound to the exact head it reviewed. */
export const ReviewRecord = Schema.Struct({
  id: ReviewRecordId,
  missionId: MissionId,
  pullRequest: PullRequestKey,
  stageId: ReviewStageId,
  headSha: TrimmedNonEmptyString,
  roleId: RoleId,
  /** Model that actually ran the round, for the stats. */
  model: Schema.String,
  verdict: Schema.Literals(["clear", "findings", "blocked"]),
  findings: NonNegativeInt,
  severeFindings: NonNegativeInt,
  links: Schema.Array(MissionLink),
  createdAt: IsoDateTime,
});
export type ReviewRecord = typeof ReviewRecord.Type;

/** The one answer to "what does PR X need next?" for crw, lanes and the merge gate. */
export const ReviewPlan = Schema.Struct({
  missionId: MissionId,
  pullRequest: PullRequestKey,
  headSha: TrimmedNonEmptyString,
  verdict: Schema.NullOr(CriticalityVerdict),
  ladderId: Schema.NullOr(ReviewLadderId),
  stages: Schema.Array(
    Schema.Struct({
      stageId: ReviewStageId,
      label: Schema.String,
      state: Schema.Literals(["done-at-head", "done-at-older-head", "pending", "needs-rerun"]),
      lastRecordId: Schema.NullOr(ReviewRecordId),
    }),
  ),
  next: Schema.NullOr(
    Schema.Struct({
      stageId: ReviewStageId,
      roleId: RoleId,
      modelSelection: ModelSelection,
    }),
  ),
  mergeAllowed: Schema.Boolean,
  reason: Schema.String,
});
export type ReviewPlan = typeof ReviewPlan.Type;

// ---------------------------------------------------------------------------
// Work items

export const WorkStage = Schema.Literals([
  "ticket",
  "pr",
  "review",
  "merge",
  "deploy",
  "readback",
  "exercised",
  "done",
]);
export type WorkStage = typeof WorkStage.Type;

// --- coord additions ---
/** A deferred item: parked work that comes back when its trigger fires. */
export const WorkItemDeferral = Schema.Struct({
  /** Id in the deferral register it came from, e.g. `DF-12`. */
  registerId: TrimmedNonEmptyString,
  status: Schema.Literals(["deferred", "fired", "done", "closed"]),
  /** The deferred work in full, as written; `title` is its first line. */
  what: Schema.String,
  /** Who deferred it and when, as written. */
  deferredBy: Schema.String,
  why: Schema.String,
  /** What brings it back. */
  trigger: Schema.String,
  source: Schema.String,
  /** Later updates and outcomes, as written. */
  notes: Schema.Array(Schema.String),
});
export type WorkItemDeferral = typeof WorkItemDeferral.Type;
// --- end coord additions ---

/** Done is three facts: merged at the exact head, deployed and read back, behaviour exercised. */
export const WorkItem = Schema.Struct({
  id: WorkItemId,
  missionId: MissionId,
  subMissionId: Schema.NullOr(SubMissionId),
  laneId: Schema.NullOr(LaneId),
  milestoneId: Schema.NullOr(MilestoneId),
  title: TrimmedNonEmptyString,
  kind: Schema.Literals(["ticket", "pr", "deploy", "investigation", "doc", "other"]),
  stage: WorkStage,
  // --- core additions ---
  /** Fields only the owner may change. Missing means none. */
  lockedFields: Schema.optional(LockedFields),
  /** Who holds the ball right now. */
  heldBy: Schema.NullOr(MissionActor),
  blockedBy: Schema.Array(MissionRecordRef),
  dependsOn: Schema.Array(WorkItemId),
  pullRequest: Schema.NullOr(PullRequestKey),
  links: Schema.Array(MissionLink),
  facts: Schema.Struct({
    mergedAtHead: Schema.NullOr(Schema.String),
    deployedReadback: Schema.NullOr(Schema.String),
    exercised: Schema.NullOr(Schema.String),
  }),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  // --- coord additions ---
  /** Set for deferred items; `stage` stays where the work was parked. */
  deferral: Schema.optional(WorkItemDeferral),
  // --- end coord additions ---
});
export type WorkItem = typeof WorkItem.Type;

// ---------------------------------------------------------------------------
// Forks (Discuss, dev questions, owner side questions)

export const MissionFork = Schema.Struct({
  id: ForkId,
  missionId: MissionId,
  kind: Schema.Literals(["discuss", "dev-question", "owner-question"]),
  masterThreadId: ThreadId,
  forkThreadId: ThreadId,
  /** Card or inbound it started from (a call, rule, lane, a Cliq message). */
  origin: Schema.NullOr(Schema.Union([MissionRecordRef, MissionLink])),
  status: Schema.Literals(["open", "answered", "archived"]),
  /** The line the master receives when it ends. */
  summaryLine: Schema.NullOr(Schema.String),
  /** The answer commits the mission to something; the line becomes a note the master acks. */
  commitsMission: Schema.Boolean,
  createdAt: IsoDateTime,
  closedAt: Schema.NullOr(IsoDateTime),
});
export type MissionFork = typeof MissionFork.Type;

// ---------------------------------------------------------------------------
// Timeline

export const MissionEventKind = Schema.Literals([
  "mission.created",
  "mission.updated",
  "mission.paused",
  "mission.resumed",
  "sub-mission.created",
  "sub-mission.updated",
  "sub-mission.reordered",
  "sub-mission.closed",
  "milestone.updated",
  "lane.created",
  "lane.moved",
  "lane.parked",
  "lane.resumed",
  "lane.split",
  "lane.merged",
  "lane.retired",
  // --- core additions ---
  "milestone.created",
  "lane.updated",
  "work-item.created",
  "work-item.updated",
  "role.created",
  "role.model-changed",
  "role.bound",
  "role.succession",
  "room.created",
  "room.archived",
  "subscription.changed",
  "ask.opened",
  "ask.answered",
  "ask.withdrawn",
  "call.made",
  // --- scribe additions ---
  /** The scribe (or editor/master) recorded a note; subject is the note. */
  "note.recorded",
  /** The editor refreshed the bottom line, FYI ranking and feed. */
  "editor.updated",
  // --- end scribe additions ---
  "rule.created",
  "rule.updated",
  "rule.retired",
  "rule.change-requested",
  "rule.change-resolved",
  "suggestion.opened",
  "suggestion.decided",
  "draft.opened",
  "draft.decided",
  "draft.sent",
  "knock.received",
  "knock.decided",
  // --- router additions ---
  "message.posted",
  "send.guarded",
  "member.changed",
  "pool.created",
  "pool.updated",
  "pool.hold-taken",
  "pool.hold-released",
  "pool.hold-expired",
  "review-policy.updated",
  "criticality.recorded",
  "review.recorded",
  "approval.opened",
  "approval.decided",
  "fork.opened",
  "fork.closed",
  // --- asks additions ---
  "ask.superseded",
  "ask.reopened",
  "call.reacted",
  "draft-note.updated",
  "note.acked",
  // --- end asks additions ---
  "field.locked",
  "field.unlocked",
  "governor.action",
  "import.applied",
]);
export type MissionEventKind = typeof MissionEventKind.Type;

/** Append-only log behind the timeline, direction check and scrubber. */
export const MissionEvent = Schema.Struct({
  id: MissionEventId,
  missionId: MissionId,
  seq: NonNegativeInt,
  kind: MissionEventKind,
  actor: MissionActor,
  provenance: MissionProvenance,
  summary: MissionSummaryText,
  subject: Schema.NullOr(MissionRecordRef),
  /** Previous event this one follows from (a decision's lineage). */
  causedBy: Schema.NullOr(MissionEventId),
  payload: Schema.NullOr(Schema.Unknown),
  at: IsoDateTime,
});
export type MissionEvent = typeof MissionEvent.Type;

// ---------------------------------------------------------------------------
// Client snapshots (bounded; deltas carry records by kind)

export const LaneCounts = Schema.Struct({
  working: NonNegativeInt,
  stuck: NonNegativeInt,
  waiting: NonNegativeInt,
  idle: NonNegativeInt,
  parked: NonNegativeInt,
});
export type LaneCounts = typeof LaneCounts.Type;

/** Sidebar row: one per mission, sub-missions in order, lanes folded into counts. */
export const MissionListItem = Schema.Struct({
  id: MissionId,
  title: TrimmedNonEmptyString,
  status: MissionStatus,
  tier: MissionTier,
  health: MissionHealth,
  /** Open asks + pending approvals/drafts + knocks for the owner. */
  needsYou: NonNegativeInt,
  lanes: LaneCounts,
  subMissions: Schema.Array(
    Schema.Struct({
      id: SubMissionId,
      title: TrimmedNonEmptyString,
      order: NonNegativeInt,
      status: SubMissionStatus,
      health: MissionHealth,
      needsYou: NonNegativeInt,
      lanes: LaneCounts,
    }),
  ),
  updatedAt: IsoDateTime,
});
export type MissionListItem = typeof MissionListItem.Type;

export const MissionListSnapshot = Schema.Struct({
  revision: NonNegativeInt,
  missions: Schema.Array(MissionListItem),
});
export type MissionListSnapshot = typeof MissionListSnapshot.Type;

export const DirectionCheckItem = Schema.Struct({
  /** A call, structural event or guide change since the owner last looked. */
  ref: MissionRecordRef,
  summary: MissionSummaryText,
  reason: Schema.String,
  at: IsoDateTime,
});
export type DirectionCheckItem = typeof DirectionCheckItem.Type;

export const BlockerGroup = Schema.Struct({
  /** Who holds the ball: owner, a role, a person outside, a system. */
  holder: MissionActor,
  holderLabel: Schema.String,
  items: Schema.Array(MissionRecordRef),
});
export type BlockerGroup = typeof BlockerGroup.Type;

export const FeedItem = Schema.Struct({
  kind: Schema.Literals(["shipped", "decided", "blocked", "note", "milestone"]),
  summary: MissionSummaryText,
  ref: Schema.NullOr(MissionRecordRef),
  at: IsoDateTime,
});
export type FeedItem = typeof FeedItem.Type;

/** Mission page header + overview tab. Bounded: lists carry summaries, not bodies. */
export const MissionOverview = Schema.Struct({
  mission: Mission,
  subMissions: Schema.Array(SubMission),
  milestones: Schema.Array(Milestone),
  /** One paragraph the editor keeps current (living brief's top). */
  bottomLine: Schema.String,
  bottomLineAt: Schema.NullOr(IsoDateTime),
  /** Usage against the mission's guaranteed share of the model pools, 0..1+. */
  usageShare: Schema.NullOr(Schema.Number),
  directionCheck: Schema.Array(DirectionCheckItem),
  criticalPath: Schema.Array(MissionRecordRef),
  blockers: Schema.Array(BlockerGroup),
  feed: Schema.Array(FeedItem),
  lanes: LaneCounts,
  /** When the owner last opened this mission; feed and direction check are "since". */
  ownerLastLookedAt: Schema.NullOr(IsoDateTime),
});
export type MissionOverview = typeof MissionOverview.Type;

export const InboxTab = Schema.Literals(["decide", "approve", "knocks", "suggestions", "fyi"]);
export type InboxTab = typeof InboxTab.Type;

/** Owner inbox across missions (or one mission). Each list is bounded and newest first. */
export const MissionInbox = Schema.Struct({
  revision: NonNegativeInt,
  counts: Schema.Struct({
    decide: NonNegativeInt,
    approve: NonNegativeInt,
    knocks: NonNegativeInt,
    suggestions: NonNegativeInt,
    fyi: NonNegativeInt,
  }),
  asks: Schema.Array(Ask),
  drafts: Schema.Array(Draft),
  approvals: Schema.Array(Approval),
  knocks: Schema.Array(Knock),
  suggestions: Schema.Array(Suggestion),
  /** Ranked notes for the owner (owner-must-know first). */
  fyi: Schema.Array(Note),
});
export type MissionInbox = typeof MissionInbox.Type;

/** A room opened in the UI: its newest messages (summaries) and the reader's position. */
export const RoomPage = Schema.Struct({
  room: Room,
  messages: Schema.Array(MissionMessage),
  subscriptions: Schema.Array(Subscription),
  ownerReadSeq: NonNegativeInt,
  /** Older messages exist before the first one returned. */
  hasOlder: Schema.Boolean,
});
export type RoomPage = typeof RoomPage.Type;

/** Changes pushed after a snapshot. Clients apply them in `seq` order. */
export const MissionRecord = Schema.Union([
  Schema.TaggedStruct("mission", { record: Mission }),
  Schema.TaggedStruct("sub-mission", { record: SubMission }),
  Schema.TaggedStruct("milestone", { record: Milestone }),
  Schema.TaggedStruct("lane", { record: Lane }),
  Schema.TaggedStruct("role", { record: Role }),
  Schema.TaggedStruct("role-binding", { record: RoleBinding }),
  Schema.TaggedStruct("room", { record: Room }),
  Schema.TaggedStruct("message", { record: MissionMessage }),
  Schema.TaggedStruct("ask", { record: Ask }),
  Schema.TaggedStruct("call", { record: Call }),
  Schema.TaggedStruct("note", { record: Note }),
  Schema.TaggedStruct("rule", { record: Rule }),
  Schema.TaggedStruct("rule-change-request", { record: RuleChangeRequest }),
  Schema.TaggedStruct("suggestion", { record: Suggestion }),
  Schema.TaggedStruct("draft", { record: Draft }),
  Schema.TaggedStruct("draft-note", { record: DraftNote }),
  Schema.TaggedStruct("knock", { record: Knock }),
  Schema.TaggedStruct("approval", { record: Approval }),
  Schema.TaggedStruct("pool", { record: Pool }),
  Schema.TaggedStruct("pool-hold", { record: PoolHold }),
  Schema.TaggedStruct("review-policy", { record: ReviewPolicy }),
  Schema.TaggedStruct("criticality-verdict", { record: CriticalityVerdict }),
  Schema.TaggedStruct("review", { record: ReviewRecord }),
  Schema.TaggedStruct("work-item", { record: WorkItem }),
  Schema.TaggedStruct("fork", { record: MissionFork }),
  Schema.TaggedStruct("event", { record: MissionEvent }),
]);
export type MissionRecord = typeof MissionRecord.Type;

export const MissionStreamItem = Schema.Union([
  Schema.TaggedStruct("list", { snapshot: MissionListSnapshot }),
  Schema.TaggedStruct("upsert", {
    missionId: Schema.NullOr(MissionId),
    seq: NonNegativeInt,
    record: MissionRecord,
  }),
  Schema.TaggedStruct("remove", {
    missionId: Schema.NullOr(MissionId),
    seq: NonNegativeInt,
    ref: MissionRecordRef,
  }),
]);
export type MissionStreamItem = typeof MissionStreamItem.Type;

// --- core additions ---

/**
 * One mission's stream: an `overview` first, then record upserts/removes in
 * `seq` order, with a fresh `overview` after each batch of changes.
 */
export const MissionSubscribeItem = Schema.Union([
  Schema.TaggedStruct("overview", { seq: NonNegativeInt, overview: MissionOverview }),
  MissionStreamItem,
]);
export type MissionSubscribeItem = typeof MissionSubscribeItem.Type;

// ---------------------------------------------------------------------------
// Inputs (owner and agent commands). Provenance comes from the transport.

export const AnswerAskInput = Schema.Struct({
  askId: AskId,
  optionId: Schema.NullOr(TrimmedNonEmptyString),
  text: Schema.String,
  /** iMessage path only: the spectrum inbound id the server must verify. */
  inboundId: Schema.optional(TrimmedNonEmptyString),
});
export type AnswerAskInput = typeof AnswerAskInput.Type;

export const OpenAskInput = Schema.Struct({
  missionId: MissionId,
  subMissionId: Schema.optional(SubMissionId),
  question: TrimmedNonEmptyString,
  context: Schema.String,
  options: Schema.Array(AskOption),
  recommendation: Schema.optional(
    Schema.Struct({ optionId: Schema.NullOr(TrimmedNonEmptyString), reason: Schema.String }),
  ),
  blocks: Schema.Array(MissionRecordRef),
  costOfWaiting: Schema.String,
  urgency: Schema.optional(Schema.Literals(["normal", "p0"])),
});
export type OpenAskInput = typeof OpenAskInput.Type;

export const DecideDraftInput = Schema.Struct({
  draftId: DraftId,
  action: Schema.Literals(["approve", "rewrite", "drop"]),
  /** Approve with edits: the text to send. */
  editedText: Schema.optional(Schema.String),
  rewriteNote: Schema.optional(Schema.String),
  inboundId: Schema.optional(TrimmedNonEmptyString),
});
export type DecideDraftInput = typeof DecideDraftInput.Type;

export const DecideSuggestionInput = Schema.Struct({
  suggestionId: SuggestionId,
  action: Schema.Literals(["accept", "accept-edited", "dismiss"]),
  editedAfter: Schema.optional(Schema.Unknown),
  dismissReason: Schema.optional(Schema.String),
});
export type DecideSuggestionInput = typeof DecideSuggestionInput.Type;

export const DecideKnockInput = Schema.Struct({
  knockId: KnockId,
  action: Schema.Literals(["forward", "drop"]),
  forwardTo: Schema.optional(MissionActor),
  editedText: Schema.optional(Schema.String),
});
export type DecideKnockInput = typeof DecideKnockInput.Type;

export const DecideApprovalInput = Schema.Struct({
  approvalId: ApprovalId,
  action: Schema.Literals(["approve", "reject"]),
  note: Schema.optional(Schema.String),
  inboundId: Schema.optional(TrimmedNonEmptyString),
});
export type DecideApprovalInput = typeof DecideApprovalInput.Type;

export const PostMessageInput = Schema.Struct({
  missionId: MissionId,
  roomId: RoomId,
  kind: MissionMessageKind,
  summary: MissionSummaryText,
  body: Schema.optional(Schema.String),
  to: Schema.optional(Schema.Array(MissionActor)),
  key: Schema.optional(TrimmedNonEmptyString),
  workItemId: Schema.optional(WorkItemId),
  links: Schema.optional(Schema.Array(MissionLink)),
  /** Owner only: post as a correction to the master. */
  isCorrection: Schema.optional(Schema.Boolean),
});
export type PostMessageInput = typeof PostMessageInput.Type;

export const MarkReadInput = Schema.Struct({
  roomId: RoomId,
  seq: NonNegativeInt,
});
export type MarkReadInput = typeof MarkReadInput.Type;

// --- router additions ---

/** Open a room: the newest page, or the page before `beforeSeq` for older messages. */
export const RoomPageInput = Schema.Struct({
  roomId: RoomId,
  beforeSeq: Schema.optional(PositiveInt),
  /** Defaults to 50, at most 200. */
  limit: Schema.optional(PositiveInt),
});
export type RoomPageInput = typeof RoomPageInput.Type;

/** Load one message body when it is opened. */
export const MessageBodyInput = Schema.Struct({
  messageId: MissionMessageId,
});
export type MessageBodyInput = typeof MessageBodyInput.Type;

/** The rooms of one mission. */
export const MissionRoomsInput = Schema.Struct({
  missionId: MissionId,
});
export type MissionRoomsInput = typeof MissionRoomsInput.Type;

/** Join, retune or mute a room for one subscriber. */
export const SubscribeRoomInput = Schema.Struct({
  roomId: RoomId,
  subscriber: MissionActor,
  mode: SubscriptionMode,
  /** Kinds that wake the subscriber. Defaults to request, blocker and control in wake mode. */
  wakeOn: Schema.optional(Schema.Array(MissionMessageKind)),
});
export type SubscribeRoomInput = typeof SubscribeRoomInput.Type;

/**
 * Who a membership is for: an owner-attached thread, or a control-API
 * session registered as a mission service (crw, the coord shim, watchers).
 */
export const MissionMemberPrincipal = Schema.Union([
  Schema.TaggedStruct("thread", { threadId: ThreadId }),
  Schema.TaggedStruct("session", {
    sessionId: TrimmedNonEmptyString,
    label: TrimmedNonEmptyString,
  }),
]);
export type MissionMemberPrincipal = typeof MissionMemberPrincipal.Type;

/** Owner only: attach or detach a thread, or register or drop a service session. */
export const SetMissionMemberInput = Schema.Struct({
  missionId: MissionId,
  principal: MissionMemberPrincipal,
  /** False detaches. */
  member: Schema.Boolean,
});
export type SetMissionMemberInput = typeof SetMissionMemberInput.Type;

export const ReorderSubMissionsInput = Schema.Struct({
  missionId: MissionId,
  /** Every active sub-mission id, in the new order. */
  order: Schema.Array(SubMissionId),
});
export type ReorderSubMissionsInput = typeof ReorderSubMissionsInput.Type;

// --- core additions ---

export const MissionSubscribeInput = Schema.Struct({ missionId: MissionId });
export type MissionSubscribeInput = typeof MissionSubscribeInput.Type;

/** Omit `missionId` (or pass null) for the inbox across every mission. */
export const MissionInboxInput = Schema.Struct({
  missionId: Schema.optional(Schema.NullOr(MissionId)),
});
export type MissionInboxInput = typeof MissionInboxInput.Type;

/** Owner only: pause, resume (active), drain or archive a mission. */
export const SetMissionStatusInput = Schema.Struct({
  missionId: MissionId,
  status: MissionStatus,
});
export type SetMissionStatusInput = typeof SetMissionStatusInput.Type;

export const SetSubMissionStatusInput = Schema.Struct({
  subMissionId: SubMissionId,
  status: SubMissionStatus,
});
export type SetSubMissionStatusInput = typeof SetSubMissionStatusInput.Type;

/** Owner only: focus mode. Null clears it. */
export const SetMissionFocusInput = Schema.Struct({
  missionId: MissionId,
  subMissionId: Schema.NullOr(SubMissionId),
});
export type SetMissionFocusInput = typeof SetMissionFocusInput.Type;

/** The owner opened the mission; the feed and direction check restart from now. */
export const MarkMissionSeenInput = Schema.Struct({ missionId: MissionId });
export type MarkMissionSeenInput = typeof MarkMissionSeenInput.Type;

/** Owner (or an import) only. */
export const CreateMissionInput = Schema.Struct({
  missionId: Schema.optional(MissionId),
  slug: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  goal: Schema.optional(Schema.String),
  tier: Schema.optional(MissionTier),
  weight: Schema.optional(PositiveInt),
  guaranteedShare: Schema.optional(Share),
  borrowCeiling: Schema.optional(Share),
  projectId: Schema.optional(Schema.NullOr(ProjectId)),
});
export type CreateMissionInput = typeof CreateMissionInput.Type;

/** Tier, weight and shares are owner only. Locked fields are owner only. */
export const UpdateMissionInput = Schema.Struct({
  missionId: MissionId,
  title: Schema.optional(TrimmedNonEmptyString),
  goal: Schema.optional(Schema.String),
  tier: Schema.optional(MissionTier),
  weight: Schema.optional(PositiveInt),
  guaranteedShare: Schema.optional(Share),
  borrowCeiling: Schema.optional(Share),
  projectId: Schema.optional(Schema.NullOr(ProjectId)),
  masterRoleId: Schema.optional(Schema.NullOr(RoleId)),
});
export type UpdateMissionInput = typeof UpdateMissionInput.Type;

/**
 * Creates a sub-mission when `subMissionId` is new (title required; it joins
 * the bottom of the order), otherwise updates the given fields.
 */
export const UpsertSubMissionInput = Schema.Struct({
  missionId: MissionId,
  subMissionId: Schema.optional(SubMissionId),
  title: Schema.optional(TrimmedNonEmptyString),
  intent: Schema.optional(Schema.String),
  fillIdleCapacity: Schema.optional(Schema.Boolean),
  coordinatorRoleId: Schema.optional(Schema.NullOr(RoleId)),
  intendedEffort: Schema.optional(Schema.NullOr(Share)),
  status: Schema.optional(SubMissionStatus),
});
export type UpsertSubMissionInput = typeof UpsertSubMissionInput.Type;

/** Creates when `milestoneId` is new (title and subMissionId required). */
export const UpsertMilestoneInput = Schema.Struct({
  missionId: MissionId,
  milestoneId: Schema.optional(MilestoneId),
  subMissionId: Schema.optional(SubMissionId),
  title: Schema.optional(TrimmedNonEmptyString),
  targetAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  status: Schema.optional(MilestoneStatus),
  statusNote: Schema.optional(Schema.NullOr(Schema.String)),
  itemIds: Schema.optional(Schema.Array(WorkItemId)),
});
export type UpsertMilestoneInput = typeof UpsertMilestoneInput.Type;

/**
 * Creates when `laneId` is new (name required). A new `subMissionId` moves
 * the lane; status `parked`, `retired` or back to work parks, retires or
 * resumes it.
 */
export const UpsertLaneInput = Schema.Struct({
  missionId: MissionId,
  laneId: Schema.optional(LaneId),
  subMissionId: Schema.optional(Schema.NullOr(SubMissionId)),
  name: Schema.optional(TrimmedNonEmptyString),
  purpose: Schema.optional(Schema.String),
  status: Schema.optional(LaneStatus),
  statusReason: Schema.optional(Schema.NullOr(Schema.String)),
  leadRoleId: Schema.optional(Schema.NullOr(RoleId)),
  threadId: Schema.optional(Schema.NullOr(ThreadId)),
  currentItemId: Schema.optional(Schema.NullOr(WorkItemId)),
});
export type UpsertLaneInput = typeof UpsertLaneInput.Type;

/** Creates when `workItemId` is new (title required). */
export const UpsertWorkItemInput = Schema.Struct({
  missionId: MissionId,
  workItemId: Schema.optional(WorkItemId),
  subMissionId: Schema.optional(Schema.NullOr(SubMissionId)),
  laneId: Schema.optional(Schema.NullOr(LaneId)),
  milestoneId: Schema.optional(Schema.NullOr(MilestoneId)),
  title: Schema.optional(TrimmedNonEmptyString),
  kind: Schema.optional(WorkItem.fields.kind),
  stage: Schema.optional(WorkStage),
  heldBy: Schema.optional(Schema.NullOr(MissionActor)),
  blockedBy: Schema.optional(Schema.Array(MissionRecordRef)),
  dependsOn: Schema.optional(Schema.Array(WorkItemId)),
  pullRequest: Schema.optional(Schema.NullOr(PullRequestKey)),
  links: Schema.optional(Schema.Array(MissionLink)),
  facts: Schema.optional(WorkItem.fields.facts),
});
export type UpsertWorkItemInput = typeof UpsertWorkItemInput.Type;

/** What a mutation committed: its timeline seq and the record it wrote. */
export const MissionMutationResult = Schema.Struct({
  seq: NonNegativeInt,
  ref: MissionRecordRef,
});
export type MissionMutationResult = typeof MissionMutationResult.Type;

export const SetRoleModelInput = Schema.Struct({
  roleId: RoleId,
  modelSelection: ModelSelection,
  reason: Schema.String,
});
export type SetRoleModelInput = typeof SetRoleModelInput.Type;

export const SetCriticalityGuideInput = Schema.Struct({
  missionId: MissionId,
  text: Schema.String,
  hardTriggers: Schema.optional(Schema.Array(CriticalityTrigger)),
});
export type SetCriticalityGuideInput = typeof SetCriticalityGuideInput.Type;

export const RecordCriticalityInput = Schema.Struct({
  missionId: MissionId,
  pullRequest: PullRequestKey,
  critical: Schema.Boolean,
  reason: Schema.String,
});
export type RecordCriticalityInput = typeof RecordCriticalityInput.Type;

export const TakeHoldInput = Schema.Struct({
  poolId: PoolId,
  missionId: MissionId,
  amount: Schema.optional(Schema.Number),
  purpose: TrimmedNonEmptyString,
  ttlSeconds: PositiveInt,
  /** Wait in the pool's queue instead of failing when it is full. */
  queue: Schema.optional(Schema.Boolean),
});
export type TakeHoldInput = typeof TakeHoldInput.Type;

export const ReleaseHoldInput = Schema.Struct({
  holdId: PoolHoldId,
  fence: PositiveInt,
  note: Schema.String,
});
export type ReleaseHoldInput = typeof ReleaseHoldInput.Type;

export const LockFieldInput = Schema.Struct({
  ref: MissionRecordRef,
  field: TrimmedNonEmptyString,
  locked: Schema.Boolean,
});
export type LockFieldInput = typeof LockFieldInput.Type;

export const RequestRuleChangeInput = Schema.Struct({
  ruleId: RuleId,
  request: TrimmedNonEmptyString,
  /** Open a Discuss fork of the master on this request. */
  discuss: Schema.optional(Schema.Boolean),
});
export type RequestRuleChangeInput = typeof RequestRuleChangeInput.Type;

/** Owner-only rule edits: write, edit wording/scope, retire. */
export const UpsertRuleInput = Schema.Struct({
  ruleId: Schema.optional(RuleId),
  missionId: Schema.NullOr(MissionId),
  title: TrimmedNonEmptyString,
  quote: TrimmedNonEmptyString,
  scope: Schema.optional(RuleScope),
  activation: Schema.optional(Schema.String),
  status: Schema.optional(RuleStatus),
});
export type UpsertRuleInput = typeof UpsertRuleInput.Type;

// --- asks additions ---

/** The asker or the owner takes an open ask back; what it held is released. */
export const WithdrawAskInput = Schema.Struct({
  askId: AskId,
  reason: Schema.String,
});
export type WithdrawAskInput = typeof WithdrawAskInput.Type;

/** Owner-only: an answered ask goes back to open (the way out of an answer). */
export const ReopenAskInput = Schema.Struct({
  askId: AskId,
  reason: Schema.String,
});
export type ReopenAskInput = typeof ReopenAskInput.Type;

/** Owner-only reaction to a master's call in the direction check; null clears it. */
export const ReactToCallInput = Schema.Struct({
  callId: CallId,
  reaction: Schema.NullOr(Schema.Literals(["ok", "discuss", "overruled"])),
  note: Schema.optional(Schema.String),
});
export type ReactToCallInput = typeof ReactToCallInput.Type;

/** Owner-only: write, edit or retire a draft note. */
export const SaveDraftNoteInput = Schema.Struct({
  noteId: Schema.optional(DraftNoteId),
  missionId: Schema.NullOr(MissionId),
  scope: DraftNoteScope,
  text: TrimmedNonEmptyString,
  active: Schema.optional(Schema.Boolean),
});
export type SaveDraftNoteInput = typeof SaveDraftNoteInput.Type;

/** Owner-only: an approved or dropped draft goes back to pending. */
export const ReopenDraftInput = Schema.Struct({
  draftId: DraftId,
});
export type ReopenDraftInput = typeof ReopenDraftInput.Type;

/** Owner-only: a dismissed suggestion goes back to open. */
export const ReopenSuggestionInput = Schema.Struct({
  suggestionId: SuggestionId,
});
export type ReopenSuggestionInput = typeof ReopenSuggestionInput.Type;

/**
 * Fork the master's thread at its latest stable point: Discuss on a card, or
 * a side question answered from the master's context without disturbing it.
 */
export const StartForkInput = Schema.Struct({
  missionId: MissionId,
  kind: Schema.Literals(["discuss", "dev-question", "owner-question"]),
  origin: Schema.NullOr(Schema.Union([MissionRecordRef, MissionLink])),
  question: Schema.optional(TrimmedNonEmptyString),
});
export type StartForkInput = typeof StartForkInput.Type;

/** A fork ends with one line for the master; only the owner can say it commits the mission. */
export const CloseForkInput = Schema.Struct({
  forkId: ForkId,
  summaryLine: TrimmedNonEmptyString,
  commitsMission: Schema.optional(Schema.Boolean),
});
export type CloseForkInput = typeof CloseForkInput.Type;

/** Owner-only fork follow-ups: mark an answered fork as committing, archive it, or reopen it. */
export const UpdateForkInput = Schema.Struct({
  forkId: ForkId,
  action: Schema.Literals(["commits-mission", "archive", "reopen"]),
});
export type UpdateForkInput = typeof UpdateForkInput.Type;

// --- end asks additions ---

// ---------------------------------------------------------------------------
// Errors

export const MissionErrorCode = Schema.Literals([
  "not-found",
  "conflict",
  "locked",
  "forbidden",
  "provenance-required",
  "provenance-invalid",
  "fence-mismatch",
  "pool-full",
  "invalid",
]);
export type MissionErrorCode = typeof MissionErrorCode.Type;

export class MissionError extends Schema.TaggedError<MissionError>()("MissionError", {
  code: MissionErrorCode,
  detail: Schema.String,
}) {
  override get message(): string {
    return `Mission ${this.code}: ${this.detail}`;
  }
}
