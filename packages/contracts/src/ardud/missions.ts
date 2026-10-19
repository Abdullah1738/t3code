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
// --- router additions ---
export const OwnerRequestId = missionEntityId("OwnerRequestId");
export type OwnerRequestId = typeof OwnerRequestId.Type;
// --- end router additions ---

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
  // --- router additions ---
  "owner-request",
  // --- end router additions ---
  // --- views additions ---
  "view-template",
  "view-section",
  "view-layout",
  "view-starter-layout",
  // --- end views additions ---
]);
export type MissionRecordKind = typeof MissionRecordKind.Type;

export const MissionRecordRef = Schema.Struct({
  kind: MissionRecordKind,
  id: TrimmedNonEmptyString,
  label: Schema.optional(Schema.String),
});
export type MissionRecordRef = typeof MissionRecordRef.Type;

// --- discuss additions (coordinator) ---
/**
 * A decision a master made on a condition the owner stated in a Discuss
 * conversation (an owner request about the record). `quote` is the owner's
 * exact words; the deciding service checks they are in one of his messages in
 * that request before it records the decision.
 */
export const OwnerCondition = Schema.Struct({
  requestId: OwnerRequestId,
  quote: TrimmedNonEmptyString,
});
export type OwnerCondition = typeof OwnerCondition.Type;
// --- end discuss additions ---

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

// --- asks additions ---
/*
 * The `view` passthrough a record carries for generative views: which card
 * template drew it and the template field values the writer filled in. The
 * schemas live here, not in missionsViews.ts, because the records below carry
 * them and missionsViews.ts imports the records; missionsViews.ts re-exports
 * them.
 */
export const ViewTemplateId = TrimmedNonEmptyString.pipe(Schema.brand("ViewTemplateId"));
export type ViewTemplateId = typeof ViewTemplateId.Type;
export const ViewKey = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,31}$/));
export type ViewKey = typeof ViewKey.Type;
export const ViewKicker = TrimmedNonEmptyString.check(Schema.isMaxLength(24));
export const ViewFieldValue = Schema.Union([
  Schema.TaggedStruct("short", { value: Schema.String.check(Schema.isMaxLength(200)) }),
  Schema.TaggedStruct("text", { value: Schema.String.check(Schema.isMaxLength(4000)) }),
  Schema.TaggedStruct("number", { value: Schema.Finite }),
  Schema.TaggedStruct("choice", { value: ViewKicker }),
  Schema.TaggedStruct("flags", { value: Schema.Array(ViewKicker).check(Schema.isMaxLength(12)) }),
  Schema.TaggedStruct("links", { value: Schema.Array(MissionLink).check(Schema.isMaxLength(12)) }),
  Schema.TaggedStruct("refs", {
    value: Schema.Array(MissionRecordRef).check(Schema.isMaxLength(20)),
  }),
]);
export type ViewFieldValue = typeof ViewFieldValue.Type;
export const ViewFields = Schema.Record(ViewKey, ViewFieldValue);
export type ViewFields = typeof ViewFields.Type;
/** What a backed record carries: the template that draws it and its field values. */
export const RecordView = Schema.Struct({
  templateId: Schema.NullOr(ViewTemplateId),
  fields: ViewFields,
});
export type RecordView = typeof RecordView.Type;
// --- end asks additions ---

export const PullRequestKey = Schema.Struct({
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
});
export type PullRequestKey = typeof PullRequestKey.Type;

/** Field names once locked on a record. Unused since 17 Oct 2026: nothing is locked. */
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
  // --- core additions ---
  /** Who decides which approvals and drafts; first match wins, none means the owner. */
  approvalRouting: Schema.optional(
    Schema.Array(
      Schema.suspend((): Schema.Codec<ApprovalRoute, ApprovalRouteEncoded> => ApprovalRoute),
    ),
  ),
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
  /** Unused since 17 Oct 2026: nothing is locked. */
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
  /** Unused since 17 Oct 2026: nothing is locked. */
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
  // --- router additions ---
  /** One room per owner request: the owner and the master, nobody else. */
  "owner-request",
  // --- end router additions ---
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
  // --- asks additions ---
  /** Generative views: the card template that draws it and its field values. */
  view: Schema.optional(RecordView),
  // --- end asks additions ---
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
  // --- discuss additions (coordinator) ---
  /** Set when the master answered on a condition the owner stated in Discuss. */
  onOwnerCondition: Schema.optional(Schema.NullOr(OwnerCondition)),
  // --- end discuss additions ---
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
  // --- asks additions ---
  /** Answer epoch: advances on every reopen. Missing means 0. */
  revision: Schema.optional(NonNegativeInt),
  /** When the current epoch began; an answer's evidence must not predate it. Missing means createdAt. */
  revisedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  /** iMessages that answered an earlier epoch; they never answer this ask again. */
  spentInboundIds: Schema.optional(Schema.Array(Schema.String)),
  /** Generative views: the card template that draws it and its field values. */
  view: Schema.optional(RecordView),
  // --- end asks additions ---
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
  // --- discuss additions (coordinator) ---
  /** Set when the master revised the call on a condition the owner stated in Discuss. */
  onOwnerCondition: Schema.optional(Schema.NullOr(OwnerCondition)),
  // --- end discuss additions ---
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
  // --- asks additions ---
  /** Generative views: the card template that draws it and its field values. */
  view: Schema.optional(RecordView),
  // --- end asks additions ---
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

/** An owner rule, in the owner's words. The owner or the master writes, edits or retires one. */
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
  // --- asks additions ---
  /** Generative views: the card template that draws it and its field values. */
  view: Schema.optional(RecordView),
  // --- end asks additions ---
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
  // --- asks additions ---
  /** Accepted ones whose change went through. */
  applied: Schema.optional(NonNegativeInt),
  /** Set on a mission's rows; absent on rows across every mission. */
  missionId: Schema.optional(Schema.NullOr(MissionId)),
  // --- end asks additions ---
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
  // --- discuss additions (coordinator) ---
  /** Set when the master decided the draft on a condition the owner stated in Discuss. */
  onOwnerCondition: Schema.optional(Schema.NullOr(OwnerCondition)),
  // --- end discuss additions ---
  createdAt: IsoDateTime,
  // --- asks additions ---
  /** Who decides it; picked by the mission's routing table. Missing means the owner. */
  approver: Schema.optional(Schema.suspend((): Schema.Codec<Approver> => Approver)),
  /** Why it went to that approver: the matched route, or the re-route reason. */
  routeNote: Schema.optional(Schema.NullOr(Schema.String)),
  /** One or two lines for the approver; set by the writer, a system (crw) or the master. */
  summary: Schema.optional(Schema.NullOr(Schema.String)),
  /** Free short labels shown as chips (e.g. "core change"); no fixed list. */
  flags: Schema.optional(Schema.Array(Schema.String)),
  /** The role that wrote it and the model its thread was observed on. */
  writtenBy: Schema.optional(
    Schema.Struct({ roleId: Schema.NullOr(RoleId), model: Schema.NullOr(Schema.String) }),
  ),
  /** System that opened it (e.g. `crw`); missing for drafts from mission threads. */
  requestedBy: Schema.optional(Schema.NullOr(Schema.String)),
  /** Exact code head the text is about (crw drafts); decisions count only for this head. */
  head: Schema.optional(Schema.NullOr(Schema.String)),
  /** Set when the system closed it because its head moved; it is then dropped and never counts. */
  staleReason: Schema.optional(Schema.NullOr(Schema.String)),
  /** Decision epoch: advances on every revision and reopen. Missing means 0. */
  revision: Schema.optional(NonNegativeInt),
  /** When the current epoch began; a decision's evidence must not predate it. Missing means createdAt. */
  revisedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  /** Where the system posted the approved text (e.g. the PR comment), once it reports sent. */
  sentLink: Schema.optional(Schema.NullOr(MissionLink)),
  /** Why the last send failed; cleared when a later send succeeds. */
  sendError: Schema.optional(Schema.NullOr(Schema.String)),
  /** The sub-mission it is about; routing rows can match it. Missing means none. */
  subMissionId: Schema.optional(Schema.NullOr(SubMissionId)),
  /** The work item it is about; routing rows can match it. Missing means none. */
  workItemId: Schema.optional(Schema.NullOr(WorkItemId)),
  /** Generative views: the card template that draws it and its field values. */
  view: Schema.optional(RecordView),
  /** The text this one replaced when it was last revised. */
  previousText: Schema.optional(Schema.NullOr(Schema.String)),
  // --- end asks additions ---
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
  /** Where the note came from. "master" (asks addition) is a direct write by a mission's master. */
  source: Schema.Literals(["owner", "master", "suggestion", "import"]),
  active: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  // --- asks additions ---
  /** Who wrote or last changed it (the owner or a master). Missing on older notes. */
  writtenBy: Schema.optional(MissionActor),
  // --- end asks additions ---
});
export type DraftNote = typeof DraftNote.Type;

// ---------------------------------------------------------------------------
// Approvals from outside (crw Awaiting Decision, deploy holds)

export const ApprovalStatus = Schema.Literals(["pending", "approved", "rejected", "stale-closed"]);
export type ApprovalStatus = typeof ApprovalStatus.Type;

// --- core additions ---

/** Who decides an approval or a draft. The owner can always decide either way. */
export const Approver = Schema.Literals(["owner", "master"]);
export type Approver = typeof Approver.Type;
// --- end core additions ---

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
  // --- core additions ---
  /** The note that came with the approve or reject. */
  decisionNote: Schema.optional(Schema.NullOr(Schema.String)),
  /** Set when the master decided the approval on a condition the owner stated in Discuss (discuss additions). */
  onOwnerCondition: Schema.optional(Schema.NullOr(OwnerCondition)),
  /** Who decides it, from the mission's approval routing. Missing means owner. */
  approver: Schema.optional(Approver),
  /** Why the master last re-routed it. */
  routeNote: Schema.optional(Schema.NullOr(Schema.String)),
  // --- asks additions ---
  /** One or two lines for the approver; from the requester (crw) or the master's annotation. */
  summary: Schema.optional(Schema.NullOr(Schema.String)),
  /** Free short labels shown as chips (e.g. "authorization risk"); no fixed list. */
  flags: Schema.optional(Schema.Array(Schema.String)),
  /** Generative views: the card template that draws it and its field values. */
  view: Schema.optional(RecordView),
  // --- end asks additions ---
});
export type Approval = typeof Approval.Type;

// --- core additions ---

/** Records written before routing existed have no approver: they are the owner's. */
export const approverOf = (approval: Pick<Approval, "approver">): Approver =>
  approval.approver ?? "owner";

/**
 * What a routing row matches; a missing field matches anything. `repository`
 * is `owner/repo`, read from the approval's pull-request link. Draft rows are
 * for the asks track, which routes drafts with the same table.
 *
 * `subMissionId` and `workItemId` match the work the approval or draft is
 * about, so the master can take a whole sub-mission's items. An approval's
 * work item is the one whose pull request is the approval's PR link.
 */
export const ApprovalRouteMatch = Schema.Union([
  Schema.TaggedStruct("approval", {
    kind: Schema.optional(Approval.fields.kind),
    repository: Schema.optional(TrimmedNonEmptyString),
    subMissionId: Schema.optional(SubMissionId),
    workItemId: Schema.optional(WorkItemId),
  }),
  Schema.TaggedStruct("draft", {
    channel: Schema.optional(DraftChannel),
    audience: Schema.optional(TrimmedNonEmptyString),
    person: Schema.optional(TrimmedNonEmptyString),
    subMissionId: Schema.optional(SubMissionId),
    workItemId: Schema.optional(WorkItemId),
  }),
]);
export type ApprovalRouteMatch = typeof ApprovalRouteMatch.Type;

/**
 * One row of a mission's approval routing. The owner and the master edit the
 * table; the first matching row wins and no match means the owner.
 */
export const ApprovalRoute = Schema.Struct({
  id: TrimmedNonEmptyString,
  match: ApprovalRouteMatch,
  approver: Approver,
  note: Schema.optional(Schema.NullOr(Schema.String)),
});
export type ApprovalRoute = typeof ApprovalRoute.Type;
export type ApprovalRouteEncoded = typeof ApprovalRoute.Encoded;
// --- end core additions ---

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

// --- policy additions ---

/** What the hard triggers read about a PR. Without facts only stored verdicts count. */
export const PullRequestFacts = Schema.Struct({
  changedLines: Schema.optional(NonNegativeInt),
  paths: Schema.optional(Schema.Array(Schema.String)),
  labels: Schema.optional(Schema.Array(Schema.String)),
});
export type PullRequestFacts = typeof PullRequestFacts.Type;

/** A holder running a different model than its role says, as model keys. */
export const RoleDrift = Schema.Struct({
  roleId: RoleId,
  bindingId: RoleBindingId,
  threadId: ThreadId,
  expected: Schema.String,
  observed: Schema.String,
});
export type RoleDrift = typeof RoleDrift.Type;

export const RolesSnapshot = Schema.Struct({
  missionId: MissionId,
  roles: Schema.Array(Role),
  /** Registry defaults not stored yet. They act like stored roles and are stored on first change. */
  defaults: Schema.Array(RoleId),
  /** Every binding, newest first, so ended ones show the succession history. */
  bindings: Schema.Array(RoleBinding),
  drift: Schema.Array(RoleDrift),
});
export type RolesSnapshot = typeof RolesSnapshot.Type;

export const ReviewPolicySnapshot = Schema.Struct({
  policy: ReviewPolicy,
  /** False until someone edits the policy; the default ladders apply meanwhile. */
  stored: Schema.Boolean,
});
export type ReviewPolicySnapshot = typeof ReviewPolicySnapshot.Type;

export const PoolPressureLevel = Schema.Literals(["ok", "tight", "exhausted"]);
export type PoolPressureLevel = typeof PoolPressureLevel.Type;

export const PoolView = Schema.Struct({
  /** `usage` is live: held amounts for native pools, the latest sample otherwise. */
  pool: Pool,
  /** Open holds: active and reconcile-required, then queued in admission order. */
  holds: Schema.Array(PoolHold),
  inUse: Schema.Number,
  pressure: PoolPressureLevel,
  pressureReason: Schema.String,
  /** Observed pools only sample once a read-only source is configured. */
  sourceConfigured: Schema.Boolean,
});
export type PoolView = typeof PoolView.Type;

export const PoolsSnapshot = Schema.Struct({
  pools: Schema.Array(PoolView),
  at: IsoDateTime,
});
export type PoolsSnapshot = typeof PoolsSnapshot.Type;

export const TakeHoldResult = Schema.Struct({
  hold: PoolHold,
  /** 1-based place in the queue when the hold is queued. */
  queuePosition: Schema.NullOr(PositiveInt),
  /** Advisory pools never refuse; this says the hold went over capacity. */
  overCapacity: Schema.Boolean,
});
export type TakeHoldResult = typeof TakeHoldResult.Type;

/** What a succession carried to the new thread; unsupported moves say so instead of failing. */
export const SuccessionMove = Schema.Struct({
  what: Schema.Literals(["schedules", "subscriptions", "children"]),
  moved: NonNegativeInt,
  failed: NonNegativeInt,
  supported: Schema.Boolean,
});
export type SuccessionMove = typeof SuccessionMove.Type;

export const SucceedRoleResult = Schema.Struct({
  ended: RoleBinding,
  binding: RoleBinding,
  moves: Schema.Array(SuccessionMove),
});
export type SucceedRoleResult = typeof SucceedRoleResult.Type;

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
  /** Unused since 17 Oct 2026: nothing is locked. */
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
  // --- asks additions ---
  /** Generative views: the card template that draws it and its field values. */
  view: Schema.optional(RecordView),
  // --- end asks additions ---
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
  // --- asks additions ---
  /** The question the fork was opened with, when one was given. */
  question: Schema.optional(Schema.NullOr(Schema.String)),
  // --- end asks additions ---
});
export type MissionFork = typeof MissionFork.Type;

// --- router additions ---
// Owner requests: the owner asks the master something (progress, a flow to
// tighten, a suggestion, something to pick up) and the master answers in the
// request's own room. Unlike a fork, a request is meant to change the master.

export const OwnerRequestStatus = Schema.Literals(["waiting-on-master", "answered", "settled"]);
export type OwnerRequestStatus = typeof OwnerRequestStatus.Type;

export const OwnerRequest = Schema.Struct({
  id: OwnerRequestId,
  missionId: MissionId,
  subMissionId: Schema.NullOr(SubMissionId),
  /** First line of the opening message. */
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  status: OwnerRequestStatus,
  /** The request's conversation (room kind `owner-request`). */
  roomId: RoomId,
  /** Who opened it: the owner, or the master quoting the owner. */
  createdBy: MissionProvenance,
  lastOwnerAt: Schema.NullOr(IsoDateTime),
  lastMasterAt: Schema.NullOr(IsoDateTime),
  /** What the master made from it: work items, asks, forks, rules, suggestions. */
  links: Schema.Array(MissionRecordRef),
  /** The master spoke since the owner last opened the request. */
  unreadForOwner: Schema.Boolean,
  settledBy: Schema.NullOr(MissionActor),
  settledAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  // --- discuss additions (coordinator) ---
  /** The record the owner is discussing (Discuss on a card). At most one open request per subject. */
  subject: Schema.optional(Schema.NullOr(MissionRecordRef)),
  // --- end discuss additions ---
});
export type OwnerRequest = typeof OwnerRequest.Type;
// --- end router additions ---

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
  "mission.archived",
  "mission.unarchived",
  /** Payload `{ into }`: its lanes, milestones and work items moved there. */
  "sub-mission.merged",
  "approval.stale-closed",
  /** Payload `{ approver, reason }`: a pending approval moved to the other approver. */
  "approval.routed",
  /** Payload `{ routes, reason }`: the mission's approval routing table changed. */
  "approval-routing.updated",
  "rule.applied",
  "rule.broken",
  "milestone.created",
  "lane.updated",
  "work-item.created",
  "work-item.updated",
  "role.created",
  "role.model-changed",
  "role.bound",
  "role.succession",
  /**
   * Payload `{ threadId, turnItemId, closedAs }`: the master declined or
   * withdrew a member's secret request. Never carries a value.
   */
  "secret-request.closed",
  // --- policy additions ---
  "role.unbound",
  "role.updated",
  "role.retired",
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
  "room.tuned",
  "request.opened",
  "request.replied",
  "request.settled",
  "request.reopened",
  /** The owner opened the master's answer. */
  "request.seen",
  "pool.created",
  "pool.updated",
  "pool.hold-taken",
  "pool.hold-released",
  "pool.hold-expired",
  // --- policy additions ---
  "pool.hold-queued",
  "pool.hold-reconciled",
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
  "draft.routed",
  "suggestion.applied",
  "draft.annotated",
  "draft.stale-closed",
  "approval.annotated",
  "draft.send-failed",
  // --- end asks additions ---
  // --- recovery additions ---
  "recovery.incident-opened",
  "recovery.notice-sent",
  "recovery.thread-decided",
  "recovery.incident-cleared",
  "recovery.settings-changed",
  // --- end recovery additions ---
  // --- views additions ---
  "view.template-defined",
  "view.template-updated",
  "view.template-removed",
  "view.template-restored",
  "view.section-placed",
  "view.section-updated",
  "view.section-moved",
  "view.section-removed",
  "view.section-restored",
  "view.layout-changed",
  "view.layout-restored",
  "view.starter-layout-changed",
  "view.starter-layout-restored",
  // --- end views additions ---
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
  // --- router additions ---
  /** Owner requests the master answered that the owner has not opened yet. */
  requestsAnswered: Schema.optional(NonNegativeInt),
  // --- end router additions ---
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

// --- recovery additions ---

/** What interrupted mission threads: Robob itself, OpenCode, one run, or a role handoff. */
export const RecoveryCause = Schema.Literals([
  "server-restart",
  "opencode-restart",
  "run-interrupted",
  "succession",
]);
export type RecoveryCause = typeof RecoveryCause.Type;

/**
 * What recovery does for one thread. resume: notice plus a resume turn, paced.
 * reconcile-first: same, but the cut run was inside a mutation, so the thread
 * checks exact state before continuing. notice-only: tell it what it lost and
 * leave it as it is (paused mission, parked lane, focus hold, owner ask).
 * skip: nothing to do (stopped by the owner, archived, nothing lost).
 */
export const RecoveryAction = Schema.Literals(["resume", "reconcile-first", "notice-only", "skip"]);
export type RecoveryAction = typeof RecoveryAction.Type;

/** pending: queued in resume order. held: waiting on the installer, the master or the thread going idle. */
export const RecoveryThreadState = Schema.Literals([
  "pending",
  "held",
  "sent",
  "decided",
  "skipped",
  "failed",
]);
export type RecoveryThreadState = typeof RecoveryThreadState.Type;

export const RecoveryLostChild = Schema.Struct({
  title: Schema.String,
  kind: Schema.Literals(["native-subagent", "delegated-task"]),
  /** Native subagent: its OpenCode session id. Delegated task: its task node id. */
  ref: Schema.NullOr(Schema.String),
  childThreadId: Schema.NullOr(ThreadId),
  lastStatus: Schema.String,
  /** One line of what it was doing, from its last progress or message. */
  doing: Schema.NullOr(Schema.String),
});
export type RecoveryLostChild = typeof RecoveryLostChild.Type;

export const RecoveryHeldHold = Schema.Struct({
  holdId: PoolHoldId,
  poolId: PoolId,
  purpose: Schema.String,
  status: PoolHoldStatus,
  leaseExpiresAt: Schema.NullOr(IsoDateTime),
  /** The lease ran out while things were down: reconcile before trusting it. */
  reconcileRequired: Schema.Boolean,
});
export type RecoveryHeldHold = typeof RecoveryHeldHold.Type;

export const RecoveryThread = Schema.Struct({
  missionId: MissionId,
  threadId: ThreadId,
  title: Schema.String,
  roleId: Schema.NullOr(RoleId),
  roleKind: Schema.NullOr(RoleKind),
  laneId: Schema.NullOr(LaneId),
  laneName: Schema.NullOr(Schema.String),
  subMissionId: Schema.NullOr(SubMissionId),
  /** Resume order inside the mission; the master is 0. */
  position: NonNegativeInt,
  cutRunId: Schema.NullOr(Schema.String),
  lastActivity: Schema.NullOr(Schema.String),
  lastActivityAt: Schema.NullOr(IsoDateTime),
  /** Robob's own restart continuation already started a turn for the cut run. */
  serverContinued: Schema.Boolean,
  /** Why the run stopped when something said so: a stall-watch reason or a provider error. */
  interruptReason: Schema.NullOr(Schema.String),
  /** Succession only: the thread that held the role before. */
  handoffFrom: Schema.NullOr(Schema.Struct({ threadId: ThreadId, title: Schema.String })),
  lostChildren: Schema.Array(RecoveryLostChild),
  holds: Schema.Array(RecoveryHeldHold),
  action: RecoveryAction,
  reason: Schema.String,
  state: RecoveryThreadState,
  stateReason: Schema.NullOr(Schema.String),
  /** Extra instruction the master or owner added for this thread's notice. */
  instruction: Schema.NullOr(Schema.String),
  noticeAt: Schema.NullOr(IsoDateTime),
  decidedBy: Schema.NullOr(MissionActor),
  /** Who gave `instruction` (the owner or the master role); later decisions keep it. */
  instructionBy: Schema.optional(Schema.NullOr(MissionActor)),
  /**
   * Boots in a row that cut this thread's same turn. At the limit a lane is held
   * instead of resumed until the owner or master resumes it; a master still gets
   * its notice and is told not to rerun its own turn.
   */
  bootCuts: Schema.optional(NonNegativeInt),
});
export type RecoveryThread = typeof RecoveryThread.Type;

export const RecoveryIncident = Schema.Struct({
  id: TrimmedNonEmptyString,
  cause: RecoveryCause,
  /** Component that reported it: "missions-recovery" (boot, scans) or "stream-recovery". */
  source: Schema.String,
  detectedAt: IsoDateTime,
  windowStart: IsoDateTime,
  windowEnd: IsoDateTime,
  /** Gap between the last heartbeat and the next start, when Robob itself was down. */
  downSeconds: Schema.NullOr(NonNegativeInt),
  missionIds: Schema.Array(MissionId),
  threads: Schema.Array(RecoveryThread),
  clearedAt: Schema.NullOr(IsoDateTime),
});
export type RecoveryIncident = typeof RecoveryIncident.Type;

/** Overview badge: "Recovered from restart at HH:MM", gone once every thread is resumed or decided. */
export const MissionRecoveryState = Schema.Struct({
  incidentId: TrimmedNonEmptyString,
  cause: RecoveryCause,
  at: IsoDateTime,
  label: Schema.String,
  total: NonNegativeInt,
  pending: NonNegativeInt,
  reconcile: NonNegativeInt,
});
export type MissionRecoveryState = typeof MissionRecoveryState.Type;

export const MissionRecoverySettings = Schema.Struct({
  missionId: MissionId,
  /** Resume turns started per minute after a restart. */
  resumePerMinute: PositiveInt.check(Schema.isLessThanOrEqualTo(60)),
  /** How long lanes wait after the master's notice before resuming, unless the master releases them. */
  masterLeadSeconds: NonNegativeInt.check(Schema.isLessThanOrEqualTo(3600)),
});
export type MissionRecoverySettings = typeof MissionRecoverySettings.Type;

export const MissionRecoveryStatus = Schema.Struct({
  missionId: MissionId,
  settings: MissionRecoverySettings,
  state: Schema.NullOr(MissionRecoveryState),
  /** Latest incident that touched this mission, threads limited to it. */
  incident: Schema.NullOr(RecoveryIncident),
});
export type MissionRecoveryStatus = typeof MissionRecoveryStatus.Type;

/**
 * Master or owner steering one incident's resume. now: send this thread's
 * notice next. hold: keep it unsent. release: let held or waiting threads go.
 * skip: decide it needs no resume. order: resume in this thread order.
 */
export const RecoveryResumeInput = Schema.Struct({
  missionId: MissionId,
  mode: Schema.Literals(["now", "hold", "release", "skip", "order"]),
  threadId: Schema.optional(ThreadId),
  laneId: Schema.optional(LaneId),
  order: Schema.optional(Schema.Array(ThreadId)),
  instruction: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(1000))),
});
export type RecoveryResumeInput = typeof RecoveryResumeInput.Type;

export const RecoverySettingsInput = Schema.Struct({
  missionId: MissionId,
  resumePerMinute: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(60))),
  masterLeadSeconds: Schema.optional(NonNegativeInt.check(Schema.isLessThanOrEqualTo(3600))),
});
export type RecoverySettingsInput = typeof RecoverySettingsInput.Type;

/** A thread another detector (stream-recovery's restart watch) saw interrupted. */
export const RecoveryReportThread = Schema.Struct({
  threadId: ThreadId,
  runIds: Schema.Array(Schema.String),
  /** Subagent rows (native session nodes or delegated task nodes) it saw cancelled. */
  childIds: Schema.Array(Schema.String),
});
export type RecoveryReportThread = typeof RecoveryReportThread.Type;

export const RecoveryReportInput = Schema.Struct({
  /** The reporter's own incident id; reporting it again returns the same incident. */
  reportId: TrimmedNonEmptyString,
  cause: RecoveryCause,
  startAt: IsoDateTime,
  endAt: IsoDateTime,
  threads: Schema.Array(RecoveryReportThread),
  /** Plan only: say which threads are mission members, write and send nothing. */
  dryRun: Schema.optional(Schema.Boolean),
});
export type RecoveryReportInput = typeof RecoveryReportInput.Type;

export const RecoveryMember = Schema.Struct({
  threadId: ThreadId,
  missionIds: Schema.Array(MissionId),
});
export type RecoveryMember = typeof RecoveryMember.Type;

/** One line per mission for the reporter's own summary. */
export const RecoveryReportMission = Schema.Struct({
  missionId: MissionId,
  title: Schema.String,
  threads: NonNegativeInt,
  resume: NonNegativeInt,
  reconcile: NonNegativeInt,
  noticeOnly: NonNegativeInt,
  /**
   * Threads not resumed because boots kept cutting the same turn; not counted in resume or
   * reconcile. Lanes wait for the owner or master; a master (master: true) gets its notice and
   * is told not to rerun its own turn.
   */
  stopped: Schema.optional(
    Schema.Array(
      Schema.Struct({
        threadId: ThreadId,
        title: Schema.String,
        bootCuts: NonNegativeInt,
        master: Schema.optional(Schema.Boolean),
      }),
    ),
  ),
});
export type RecoveryReportMission = typeof RecoveryReportMission.Type;

/** Members are handled by mission recovery; the reporter leaves them alone. */
export const RecoveryReportResult = Schema.Struct({
  incidentId: Schema.NullOr(Schema.String),
  members: Schema.Array(RecoveryMember),
  missions: Schema.Array(RecoveryReportMission),
});
export type RecoveryReportResult = typeof RecoveryReportResult.Type;

// --- end recovery additions ---

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
  // --- recovery additions ---
  /** Set while threads are still being resumed after a restart or interruption. */
  recovery: Schema.optional(Schema.NullOr(MissionRecoveryState)),
  // --- end recovery additions ---
  // --- router additions ---
  /** Owner requests the master answered that the owner has not opened yet. */
  requestsAnswered: Schema.optional(NonNegativeInt),
  // --- end router additions ---
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
  // --- router additions ---
  Schema.TaggedStruct("owner-request", { record: OwnerRequest }),
  // --- end router additions ---
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
  // --- asks additions ---
  /** The master answers for the owner: the owner request whose stated condition this meets. */
  onOwnerCondition: Schema.optional(OwnerCondition),
  // --- end asks additions ---
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
  // --- asks additions ---
  view: Schema.optional(RecordView),
  // --- end asks additions ---
});
export type OpenAskInput = typeof OpenAskInput.Type;

export const DecideDraftInput = Schema.Struct({
  draftId: DraftId,
  action: Schema.Literals(["approve", "rewrite", "drop"]),
  /** Approve with edits: the text to send. */
  editedText: Schema.optional(Schema.String),
  rewriteNote: Schema.optional(Schema.String),
  inboundId: Schema.optional(TrimmedNonEmptyString),
  // --- asks additions ---
  /** The draft revision the decider saw; a decision for an older revision is refused. */
  revision: Schema.optional(NonNegativeInt),
  /** The master decides an owner-routed draft: the owner request whose stated condition this meets. */
  onOwnerCondition: Schema.optional(OwnerCondition),
  // --- end asks additions ---
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
 * Who a membership is for: an owner-attached thread, a control-API session
 * registered as a mission service (crw, watchers), or a coord actor name
 * (`master`, a lane, a system subscriber such as `crw`) the `coord` component
 * credential may speak and read as through the coord shim.
 */
export const MissionMemberPrincipal = Schema.Union([
  Schema.TaggedStruct("thread", { threadId: ThreadId }),
  Schema.TaggedStruct("session", {
    sessionId: TrimmedNonEmptyString,
    label: TrimmedNonEmptyString,
  }),
  Schema.TaggedStruct("coord", { actor: TrimmedNonEmptyString }),
]);
export type MissionMemberPrincipal = typeof MissionMemberPrincipal.Type;

/**
 * Owner or the mission's master: attach or detach a thread, register or drop
 * a service session, or enrol or drop a coord actor for the coord component.
 * Only the owner attaches a thread that belongs to another mission.
 */
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

/** One subscriber's rule in a room: how it hears the room and which kinds wake it. */
export const RoomWakeRule = Schema.Struct({
  subscriber: MissionActor,
  mode: SubscriptionMode,
  /** Kinds that wake the subscriber. Defaults to request, blocker and control in wake mode. */
  wakeOn: Schema.optional(Schema.Array(MissionMessageKind)),
});
export type RoomWakeRule = typeof RoomWakeRule.Type;

/** Read one room's wake rules. */
export const RoomTuningInput = Schema.Struct({
  roomId: RoomId,
});
export type RoomTuningInput = typeof RoomTuningInput.Type;

/**
 * Owner or the mission's master: mute or unmute a room and set wake rules for
 * any of its subscribers, as one logged change. A muted room wakes only the
 * actors a message names.
 */
export const TuneRoomInput = Schema.Struct({
  roomId: RoomId,
  muted: Schema.optional(Schema.Boolean),
  rules: Schema.optional(Schema.Array(RoomWakeRule)),
});
export type TuneRoomInput = typeof TuneRoomInput.Type;

/** A room's wake rules: whether it is muted, and every subscription in it. */
export const RoomTuning = Schema.Struct({
  roomId: RoomId,
  missionId: MissionId,
  muted: Schema.Boolean,
  subscriptions: Schema.Array(Subscription),
  /** Last tuning change, null when the room was never tuned. */
  updatedAt: Schema.NullOr(IsoDateTime),
});
export type RoomTuning = typeof RoomTuning.Type;

/** The deliveries of one mission that were reminded once and are still unread. */
export const MissionAttentionInput = Schema.Struct({
  missionId: MissionId,
});
export type MissionAttentionInput = typeof MissionAttentionInput.Type;

export const AttentionEntry = Schema.Struct({
  threadId: ThreadId,
  message: MissionMessage,
  remindedAt: IsoDateTime,
});
export type AttentionEntry = typeof AttentionEntry.Type;

/**
 * The master's attention view: messages a thread left unread after its one
 * reminder. The router never rings for them again.
 */
export const MissionAttention = Schema.Struct({
  missionId: MissionId,
  entries: Schema.Array(AttentionEntry),
});
export type MissionAttention = typeof MissionAttention.Type;

/** What the owner or master writes into a request. */
export const OwnerRequestText = TrimmedNonEmptyString.check(Schema.isMaxLength(20_000));
export type OwnerRequestText = typeof OwnerRequestText.Type;

export const OpenOwnerRequestInput = Schema.Struct({
  missionId: MissionId,
  /** The first line becomes the title. */
  text: OwnerRequestText,
  subMissionId: Schema.optional(SubMissionId),
  /** Master only: where the owner asked it (his own thread, iMessage). */
  quotedFrom: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
  /** Idempotency key: the same key opens the same request once. */
  key: Schema.optional(TrimmedNonEmptyString),
});
export type OpenOwnerRequestInput = typeof OpenOwnerRequestInput.Type;

export const ReplyOwnerRequestInput = Schema.Struct({
  requestId: OwnerRequestId,
  text: OwnerRequestText,
  /** Master only: what it made from the request. */
  links: Schema.optional(Schema.Array(MissionRecordRef)),
  /** Master only: `waiting-on-master` while it is still working. Defaults to `answered`. */
  status: Schema.optional(Schema.Literals(["answered", "waiting-on-master"])),
  key: Schema.optional(TrimmedNonEmptyString),
});
export type ReplyOwnerRequestInput = typeof ReplyOwnerRequestInput.Type;

export const SettleOwnerRequestInput = Schema.Struct({
  requestId: OwnerRequestId,
  note: Schema.optional(OwnerRequestText),
});
export type SettleOwnerRequestInput = typeof SettleOwnerRequestInput.Type;

export const ReopenOwnerRequestInput = Schema.Struct({
  requestId: OwnerRequestId,
  note: Schema.optional(OwnerRequestText),
});
export type ReopenOwnerRequestInput = typeof ReopenOwnerRequestInput.Type;

export const OwnerRequestsInput = Schema.Struct({
  missionId: MissionId,
  status: Schema.optional(OwnerRequestStatus),
  /** One request with a longer stretch of its conversation, bodies included. */
  requestId: Schema.optional(OwnerRequestId),
});
export type OwnerRequestsInput = typeof OwnerRequestsInput.Type;

export const OwnerRequestMessage = Schema.Struct({
  message: MissionMessage,
  /** Null in a list (read the summary); filled when one request is asked for by id. */
  body: Schema.NullOr(Schema.String),
});
export type OwnerRequestMessage = typeof OwnerRequestMessage.Type;

export const OwnerRequestView = Schema.Struct({
  request: OwnerRequest,
  /** The newest messages, oldest first. */
  messages: Schema.Array(OwnerRequestMessage),
  hasOlder: Schema.Boolean,
  unreadForOwner: Schema.Boolean,
});
export type OwnerRequestView = typeof OwnerRequestView.Type;

export const OwnerRequests = Schema.Struct({
  missionId: MissionId,
  /** Newest activity first. */
  requests: Schema.Array(OwnerRequestView),
});
export type OwnerRequests = typeof OwnerRequests.Type;

// --- core additions ---

export const MissionSubscribeInput = Schema.Struct({ missionId: MissionId });
export type MissionSubscribeInput = typeof MissionSubscribeInput.Type;

/** Omit `missionId` (or pass null) for the inbox across every mission. */
export const MissionInboxInput = Schema.Struct({
  missionId: Schema.optional(Schema.NullOr(MissionId)),
});
export type MissionInboxInput = typeof MissionInboxInput.Type;

/** Pause, resume (active), drain, archive or unarchive a mission. Owner or master. */
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

/** Focus mode. Null clears it. Owner or master. */
export const SetMissionFocusInput = Schema.Struct({
  missionId: MissionId,
  subMissionId: Schema.NullOr(SubMissionId),
});
export type SetMissionFocusInput = typeof SetMissionFocusInput.Type;

/** The owner opened the mission; the feed and direction check restart from now. */
export const MarkMissionSeenInput = Schema.Struct({ missionId: MissionId });
export type MarkMissionSeenInput = typeof MarkMissionSeenInput.Type;

/** Owner, a master or an import. */
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

/** Any field, by the owner or the mission's master. */
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
  // --- asks additions ---
  view: Schema.optional(RecordView),
  // --- end asks additions ---
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

/** Unused since 17 Oct 2026: nothing is locked. Kept so old clients decode. */
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

/** Write, edit wording/scope, or retire a rule. Owner or the mission's master. */
export const UpsertRuleInput = Schema.Struct({
  ruleId: Schema.optional(RuleId),
  missionId: Schema.NullOr(MissionId),
  title: TrimmedNonEmptyString,
  quote: TrimmedNonEmptyString,
  scope: Schema.optional(RuleScope),
  activation: Schema.optional(Schema.String),
  status: Schema.optional(RuleStatus),
  /** The master's reading of the rule. */
  masterReading: Schema.optional(Schema.String),
});
export type UpsertRuleInput = typeof UpsertRuleInput.Type;

// --- policy additions ---

export const CreateRoleInput = Schema.Struct({
  missionId: MissionId,
  kind: RoleKind,
  laneId: Schema.optional(LaneId),
  name: Schema.optional(TrimmedNonEmptyString),
  description: Schema.optional(Schema.String),
  /** Defaults to the registry model for the kind; required for `custom`. */
  modelSelection: Schema.optional(ModelSelection),
});
export type CreateRoleInput = typeof CreateRoleInput.Type;

export const BindRoleInput = Schema.Struct({
  roleId: RoleId,
  threadId: ThreadId,
  reason: Schema.optional(RoleBindingReason),
  handoffNote: Schema.optional(Schema.String),
  /** Keep the role's other holders bound (lane workers). By default they end. */
  shared: Schema.optional(Schema.Boolean),
});
export type BindRoleInput = typeof BindRoleInput.Type;

export const UnbindRoleInput = Schema.Struct({
  roleId: RoleId,
  threadId: ThreadId,
  note: Schema.optional(Schema.String),
});
export type UnbindRoleInput = typeof UnbindRoleInput.Type;

/** The new thread already exists (launched or reset by the caller). */
export const SucceedRoleInput = Schema.Struct({
  roleId: RoleId,
  threadId: ThreadId,
  handoffNote: TrimmedNonEmptyString,
  /** The holder being replaced; needed only when the role has several holders. */
  fromThreadId: Schema.optional(ThreadId),
});
export type SucceedRoleInput = typeof SucceedRoleInput.Type;

export const EditReviewPolicyInput = Schema.Struct({
  missionId: MissionId,
  stages: Schema.optional(Schema.Array(ReviewStage)),
  ladders: Schema.optional(Schema.Array(ReviewLadder)),
  commonRules: Schema.optional(Schema.Array(Schema.String)),
  judgedBy: Schema.optional(ReviewPolicy.fields.judgedBy),
});
export type EditReviewPolicyInput = typeof EditReviewPolicyInput.Type;

/** The role and model default from the stage's role when not given. */
export const RecordReviewInput = Schema.Struct({
  missionId: MissionId,
  pullRequest: PullRequestKey,
  stageId: ReviewStageId,
  headSha: TrimmedNonEmptyString,
  verdict: ReviewRecord.fields.verdict,
  findings: Schema.optional(NonNegativeInt),
  severeFindings: Schema.optional(NonNegativeInt),
  links: Schema.optional(Schema.Array(MissionLink)),
  model: Schema.optional(TrimmedNonEmptyString),
});
export type RecordReviewInput = typeof RecordReviewInput.Type;

export const ReviewPlanRequest = Schema.Struct({
  missionId: MissionId,
  pullRequest: PullRequestKey,
  headSha: TrimmedNonEmptyString,
  /**
   * When given, a fired hard trigger counts in this plan only. Reading a plan
   * never records anything; RecordTriggerFactsInput does that.
   */
  facts: Schema.optional(PullRequestFacts),
  /** Extra ladders whose condition the caller says applies (e.g. a mobile gate). */
  customLadderIds: Schema.optional(Schema.Array(ReviewLadderId)),
});
export type ReviewPlanRequest = typeof ReviewPlanRequest.Type;

export const CreatePoolInput = Schema.Struct({
  poolId: Schema.optional(PoolId),
  name: TrimmedNonEmptyString,
  unit: TrimmedNonEmptyString,
  capacity: Schema.Number,
  scope: PoolScope,
  kind: PoolKind,
  backend: PoolBackend,
  enforcement: Schema.optional(Pool.fields.enforcement),
  priority: Schema.optional(Schema.Array(MissionId)),
});
export type CreatePoolInput = typeof CreatePoolInput.Type;

export const SetPoolCapacityInput = Schema.Struct({
  poolId: PoolId,
  capacity: Schema.Number,
});
export type SetPoolCapacityInput = typeof SetPoolCapacityInput.Type;

export const RenewHoldInput = Schema.Struct({
  holdId: PoolHoldId,
  fence: PositiveInt,
  ttlSeconds: PositiveInt,
});
export type RenewHoldInput = typeof RenewHoldInput.Type;

/** Closes an expired hold. Evidence says what really happened to the work. */
export const ReconcileHoldInput = Schema.Struct({
  holdId: PoolHoldId,
  fence: PositiveInt,
  outcome: Schema.Literals(["done", "not-started", "rolled-back"]),
  evidence: TrimmedNonEmptyString,
});
export type ReconcileHoldInput = typeof ReconcileHoldInput.Type;

/** Edits a role's descriptive fields. Model changes go through `SetRoleModelInput`. */
export const UpdateRoleInput = Schema.Struct({
  roleId: RoleId,
  name: Schema.optional(TrimmedNonEmptyString),
  description: Schema.optional(Schema.String),
  writesPublicText: Schema.optional(Schema.Boolean),
});
export type UpdateRoleInput = typeof UpdateRoleInput.Type;

/** Retires a custom role: its holders are unbound and the role is removed. */
export const RetireRoleInput = Schema.Struct({
  roleId: RoleId,
  note: Schema.optional(Schema.String),
});
export type RetireRoleInput = typeof RetireRoleInput.Type;

/** Edits a pool's name, unit or cross-mission priority order. Capacity has its own input. */
export const UpdatePoolInput = Schema.Struct({
  poolId: PoolId,
  name: Schema.optional(TrimmedNonEmptyString),
  unit: Schema.optional(TrimmedNonEmptyString),
  priority: Schema.optional(Schema.Array(MissionId)),
});
export type UpdatePoolInput = typeof UpdatePoolInput.Type;

/** What the governor sees and would do on its next tick. */
export const GovernorView = Schema.Struct({
  pressure: Schema.Array(
    Schema.Struct({ poolId: PoolId, level: PoolPressureLevel, reason: Schema.String }),
  ),
  shares: Schema.Array(
    Schema.Struct({
      missionId: MissionId,
      dominant: Schema.Number,
      weighted: Schema.Number,
      aboveGuarantee: Schema.Boolean,
    }),
  ),
  actions: Schema.Array(
    Schema.Struct({
      action: Schema.Literals(["park", "park-at-safe-point", "resume"]),
      laneId: LaneId,
      missionId: MissionId,
      reason: Schema.String,
    }),
  ),
  admissions: Schema.Array(
    Schema.Struct({ missionId: MissionId, canAdmit: Schema.Boolean, reason: Schema.String }),
  ),
  at: IsoDateTime,
});
export type GovernorView = typeof GovernorView.Type;
// --- end policy additions ---

// --- core additions ---
/**
 * Verified PR facts from the owner, the master or the component that read
 * them (crw). A fired hard trigger becomes the PR's verdict, in the caller's
 * name.
 */
export const RecordTriggerFactsInput = Schema.Struct({
  missionId: MissionId,
  pullRequest: PullRequestKey,
  facts: PullRequestFacts,
});
export type RecordTriggerFactsInput = typeof RecordTriggerFactsInput.Type;

export const RecordTriggerFactsResult = Schema.Struct({
  /** False when no trigger fired or one is already on record. */
  recorded: Schema.Boolean,
  verdict: Schema.NullOr(CriticalityVerdict),
});
export type RecordTriggerFactsResult = typeof RecordTriggerFactsResult.Type;
// --- end core additions ---

/** The master records that it relied on a rule, or that work broke it. */
export const RecordRuleUseInput = Schema.Struct({
  ruleId: RuleId,
  outcome: Schema.Literals(["applied", "broken"]),
  note: Schema.optional(Schema.String),
});
export type RecordRuleUseInput = typeof RecordRuleUseInput.Type;

/** Close a rule-change request: applied, declined, or withdrawn by its asker. */
export const ResolveRuleChangeInput = Schema.Struct({
  requestId: RuleChangeRequestId,
  status: Schema.Literals(["applied", "declined", "withdrawn"]),
  response: Schema.String,
});
export type ResolveRuleChangeInput = typeof ResolveRuleChangeInput.Type;

/** A system (crw) asks for a decision. Same id and still pending is a no-op. */
export const OpenApprovalInput = Schema.Struct({
  missionId: MissionId,
  approvalId: ApprovalId,
  kind: Approval.fields.kind,
  title: TrimmedNonEmptyString,
  detail: Schema.String,
  requestedBy: TrimmedNonEmptyString,
  links: Schema.Array(MissionLink),
  // --- asks additions ---
  summary: Schema.optional(Schema.NullOr(Schema.String)),
  flags: Schema.optional(Schema.Array(Schema.String)),
  view: Schema.optional(RecordView),
  // --- end asks additions ---
});
export type OpenApprovalInput = typeof OpenApprovalInput.Type;

/** A system closes its pending approval as stale. Never counts as a decision. */
export const CloseStaleApprovalInput = Schema.Struct({
  missionId: MissionId,
  approvalId: ApprovalId,
  reason: TrimmedNonEmptyString,
});
export type CloseStaleApprovalInput = typeof CloseStaleApprovalInput.Type;

/** Replace a mission's approval routing table. Owner or the mission's master. */
export const SetApprovalRoutingInput = Schema.Struct({
  missionId: MissionId,
  routes: Schema.Array(ApprovalRoute),
  reason: Schema.optional(Schema.String),
});
export type SetApprovalRoutingInput = typeof SetApprovalRoutingInput.Type;

/** Move one pending approval to the other approver, with a reason. */
export const RouteApprovalInput = Schema.Struct({
  approvalId: ApprovalId,
  approver: Approver,
  reason: TrimmedNonEmptyString,
});
export type RouteApprovalInput = typeof RouteApprovalInput.Type;

export const AckNoteInput = Schema.Struct({
  noteId: NoteId,
});
export type AckNoteInput = typeof AckNoteInput.Type;

/** Split work off a lane into a new lane; listed work items move with it. */
export const SplitLaneInput = Schema.Struct({
  missionId: MissionId,
  laneId: LaneId,
  newLaneId: Schema.optional(LaneId),
  name: TrimmedNonEmptyString,
  purpose: Schema.optional(Schema.String),
  /** Defaults to the source lane's sub-mission. */
  subMissionId: Schema.optional(Schema.NullOr(SubMissionId)),
  workItemIds: Schema.optional(Schema.Array(WorkItemId)),
});
export type SplitLaneInput = typeof SplitLaneInput.Type;

/** Fold a lane into another: its work items move, the lane retires. */
export const MergeLanesInput = Schema.Struct({
  missionId: MissionId,
  laneId: LaneId,
  intoLaneId: LaneId,
});
export type MergeLanesInput = typeof MergeLanesInput.Type;

/** Fold a sub-mission into another: lanes, milestones and work items move, it closes. */
export const MergeSubMissionsInput = Schema.Struct({
  missionId: MissionId,
  subMissionId: SubMissionId,
  intoSubMissionId: SubMissionId,
});
export type MergeSubMissionsInput = typeof MergeSubMissionsInput.Type;

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

/** The owner or a master: write, edit or retire a draft note. */
export const SaveDraftNoteInput = Schema.Struct({
  noteId: Schema.optional(DraftNoteId),
  missionId: Schema.NullOr(MissionId),
  scope: DraftNoteScope,
  text: TrimmedNonEmptyString,
  active: Schema.optional(Schema.Boolean),
});
export type SaveDraftNoteInput = typeof SaveDraftNoteInput.Type;

/** The draft's approver (the owner always): an approved or dropped draft goes back to pending. */
export const ReopenDraftInput = Schema.Struct({
  draftId: DraftId,
});
export type ReopenDraftInput = typeof ReopenDraftInput.Type;

/** The owner or the mission's master: a dismissed suggestion goes back to open. */
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

/** Fork follow-ups for the owner or the master: mark an answered fork as committing, archive it, or reopen it. */
export const UpdateForkInput = Schema.Struct({
  forkId: ForkId,
  action: Schema.Literals(["commits-mission", "archive", "reopen"]),
});
export type UpdateForkInput = typeof UpdateForkInput.Type;

/** Owner or master: send one pending draft to the other approver; the reason is logged. */
export const RouteDraftInput = Schema.Struct({
  draftId: DraftId,
  approver: Approver,
  reason: TrimmedNonEmptyString,
});
export type RouteDraftInput = typeof RouteDraftInput.Type;

/** Turn a draft note off or back on without rewriting it. */
export const SetDraftNoteActiveInput = Schema.Struct({
  draftNoteId: DraftNoteId,
  active: Schema.Boolean,
});
export type SetDraftNoteActiveInput = typeof SetDraftNoteActiveInput.Type;

/**
 * Feed scope: a mission's records plus the global ones, or only the global
 * ones when `missionId` is null.
 */
export const MissionFeedInput = Schema.Struct({
  missionId: Schema.NullOr(MissionId),
});
export type MissionFeedInput = typeof MissionFeedInput.Type;

/**
 * A record feed: one `snapshot` of the current records, then `upsert` and
 * `remove` deltas as they commit. Deltas can repeat what the snapshot already
 * holds; applying them by record id converges.
 */
export const MissionFeedItem = Schema.Union([
  Schema.TaggedStruct("snapshot", {
    revision: NonNegativeInt,
    records: Schema.Array(MissionRecord),
  }),
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
export type MissionFeedItem = typeof MissionFeedItem.Type;

/** A mission's approval routing table as it stands; resent whenever it changes. */
export const MissionRoutingTable = Schema.Struct({
  missionId: MissionId,
  routes: Schema.Array(ApprovalRoute),
  updatedAt: IsoDateTime,
});
export type MissionRoutingTable = typeof MissionRoutingTable.Type;

/** Decided inbox items for one mission (or every mission when null) over the last N days. */
export const MissionInboxHistoryInput = Schema.Struct({
  missionId: Schema.NullOr(MissionId),
  /** Default 7, at most 90. */
  days: Schema.optional(PositiveInt),
  /** Per kind. Default 50, at most 200. */
  limit: Schema.optional(PositiveInt),
});
export type MissionInboxHistoryInput = typeof MissionInboxHistoryInput.Type;

/** Each list is newest decision first and capped at the requested limit. */
export const MissionInboxHistory = Schema.Struct({
  since: IsoDateTime,
  asks: Schema.Array(Ask),
  drafts: Schema.Array(Draft),
  approvals: Schema.Array(Approval),
  knocks: Schema.Array(Knock),
  suggestions: Schema.Array(Suggestion),
});
export type MissionInboxHistory = typeof MissionInboxHistory.Type;

/**
 * Owner or master: set the short summary and flag chips on a pending draft or approval. A field
 * left out stays as it is; `null` summary or `[]` flags clears it.
 */
export const AnnotateDraftInput = Schema.Struct({
  draftId: DraftId,
  summary: Schema.optional(Schema.NullOr(Schema.String)),
  flags: Schema.optional(Schema.Array(Schema.String)),
});
export type AnnotateDraftInput = typeof AnnotateDraftInput.Type;

export const AnnotateApprovalInput = Schema.Struct({
  approvalId: ApprovalId,
  summary: Schema.optional(Schema.NullOr(Schema.String)),
  flags: Schema.optional(Schema.Array(Schema.String)),
});
export type AnnotateApprovalInput = typeof AnnotateApprovalInput.Type;

/**
 * A system (crw) opens a draft for one exact code head. Reopening the same id with the same head
 * is a no-op; a new head on the same target stale-closes the older pending drafts.
 */
export const OpenSystemDraftInput = Schema.Struct({
  missionId: MissionId,
  draftId: DraftId,
  requestedBy: TrimmedNonEmptyString,
  audience: TrimmedNonEmptyString,
  channel: DraftChannel,
  target: MissionLink,
  head: TrimmedNonEmptyString,
  text: TrimmedNonEmptyString,
  summary: Schema.optional(Schema.NullOr(Schema.String)),
  flags: Schema.optional(Schema.Array(Schema.String)),
  view: Schema.optional(RecordView),
});
export type OpenSystemDraftInput = typeof OpenSystemDraftInput.Type;

/** A system closes its own pending draft because the head moved. Never counts as a decision. */
export const CloseStaleDraftInput = Schema.Struct({
  draftId: DraftId,
  requestedBy: TrimmedNonEmptyString,
  reason: TrimmedNonEmptyString,
});
export type CloseStaleDraftInput = typeof CloseStaleDraftInput.Type;

/**
 * What a system may act on for one draft and head. `state` is `pending` until a decision exists
 * for exactly that head; a stale draft, another head or a reopened draft never reads as decided.
 */
export const SystemDraftDecision = Schema.Struct({
  draftId: DraftId,
  head: Schema.String,
  state: Schema.Literals(["pending", "approved", "rewrite-requested", "dropped", "stale"]),
  /** The text to post: the owner's edit when he edited it, else the draft text. Approved only. */
  text: Schema.NullOr(Schema.String),
  edited: Schema.Boolean,
  rewriteNote: Schema.NullOr(Schema.String),
  decidedAt: Schema.NullOr(IsoDateTime),
  /** The draft revision this decision is for; a send report must name it. */
  revision: NonNegativeInt,
  /** Whether the system already reported posting the approved text. */
  delivery: Schema.Literals(["unsent", "sent", "send-failed"]),
});
export type SystemDraftDecision = typeof SystemDraftDecision.Type;

/** How a system's attempt to post an approved draft went. */
export const DraftSendOutcome = Schema.Union([
  Schema.TaggedStruct("sent", { link: MissionLink }),
  Schema.TaggedStruct("send-failed", { reason: TrimmedNonEmptyString }),
]);
export type DraftSendOutcome = typeof DraftSendOutcome.Type;

/**
 * A system (crw) reports that it posted, or failed to post, the approved text of its own draft.
 * Only an approved draft at exactly `revision` takes it; repeating the same report is a no-op.
 */
export const ReportDraftSentInput = Schema.Struct({
  draftId: DraftId,
  requestedBy: TrimmedNonEmptyString,
  revision: NonNegativeInt,
  outcome: DraftSendOutcome,
});
export type ReportDraftSentInput = typeof ReportDraftSentInput.Type;

/** One mission, or every mission when null. */
export const MissionScopeInput = Schema.Struct({
  missionId: Schema.NullOr(MissionId),
});
export type MissionScopeInput = typeof MissionScopeInput.Type;

/**
 * What waits on the master rather than the owner: pending drafts and
 * approvals routed to the master and open suggestions the master accepts.
 * Counts are complete; lists are newest first and capped.
 */
export const MissionMasterInbox = Schema.Struct({
  revision: NonNegativeInt,
  counts: Schema.Struct({
    approve: NonNegativeInt,
    suggestions: NonNegativeInt,
  }),
  drafts: Schema.Array(Draft),
  approvals: Schema.Array(Approval),
  suggestions: Schema.Array(Suggestion),
});
export type MissionMasterInbox = typeof MissionMasterInbox.Type;

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
