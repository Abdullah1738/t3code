import {
  AnnotateApprovalInput,
  AnnotateDraftInput,
  ApprovalId,
  ApprovalStatus,
  AskId,
  AskStatus,
  CreateMissionInput,
  DecideSuggestionInput,
  DraftChannel,
  DraftId,
  DraftStatus,
  ForkId,
  MergeLanesInput,
  MergeSubMissionsInput,
  MissionId,
  MissionLink,
  MissionRecordRef,
  MissionMutationResult,
  NonNegativeInt,
  NoteId,
  OrchestratorMcpFailure,
  PostMessageInput,
  RecordRuleUseInput,
  ReopenDraftInput,
  ReopenSuggestionInput,
  ReorderSubMissionsInput,
  RequestRuleChangeInput,
  ResolveRuleChangeInput,
  RouteApprovalInput,
  RouteDraftInput,
  SaveDraftNoteInput,
  SetApprovalRoutingInput,
  SetMissionFocusInput,
  SetMissionStatusInput,
  SplitLaneInput,
  SubMissionId,
  TrimmedNonEmptyString,
  UpdateForkInput,
  UpdateMissionInput,
  UpsertLaneInput,
  UpsertMilestoneInput,
  UpsertSubMissionInput,
  UpsertRuleInput,
  UpsertWorkItemInput,
  WithdrawAskInput,
  WorkItemId,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";

import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as AsksService from "../asks/AsksService.ts";
import * as RuleService from "../core/RuleService.ts";
import * as MissionService from "../MissionService.ts";
import { MakeCallInput, OpenAskRequest, ProposeSuggestionInput } from "../asks/inputs.ts";
import { WATCH_KINDS } from "../asks/watch.ts";

/**
 * Mission tools for agents in any T3 thread. Who is calling comes from the
 * calling thread (MCP invocation context), never from parameters, and every
 * tool is strict: an unknown key such as `default` or `askedBy` is refused.
 * The only owner-voiced writes are answers and draft decisions that carry the
 * id of the owner's (or Moni's) iMessage, which the server verifies. The
 * master decides, re-routes and annotates drafts and approvals routed to it
 * and edits draft notes through the same service methods the owner uses.
 */

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  AsksService.AsksService,
];

const Records = Schema.Array(Schema.Unknown);

const MissionStatusTool = Tool.make("mission_status", {
  description:
    "Mission status. Without missionId: the missions on this server and suggestion acceptance stats. With missionId: that mission's desk (open asks and exactly what each holds, pending drafts, open suggestions, open forks, calls awaiting the owner's direction check, lanes).",
  parameters: Schema.Struct({ missionId: Schema.optional(MissionId) }),
  success: Schema.Struct({
    missions: Records,
    desk: Schema.NullOr(Schema.Unknown),
    suggestionStats: Records,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
});

const MissionDigestTool = Tool.make("mission_digest", {
  description:
    "A mission's event log since an ISO time, oldest first (up to 500 events): asks opened and answered, calls, drafts, suggestions, forks and everything other tracks record.",
  parameters: Schema.Struct({ missionId: MissionId, since: TrimmedNonEmptyString }),
  success: Schema.Struct({ events: Records }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
});

const MissionAsksTool = Tool.make("mission_asks", {
  description:
    'Read owner asks. Pass askId for one ask, or filter by missionId and status (e.g. ["open"]). An ask holds only the records in its `blocks`; everything else keeps going.',
  parameters: Schema.Struct({
    missionId: Schema.optional(MissionId),
    status: Schema.optional(Schema.Array(AskStatus)),
    askId: Schema.optional(AskId),
  }),
  success: Schema.Struct({ asks: Records }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
});

const MissionDraftsTool = Tool.make("mission_drafts", {
  description:
    "Read drafts waiting for the owner. Pass guideFor {channel, audience} with missionId to load the owner's draft notes and approved examples to follow before writing a draft.",
  parameters: Schema.Struct({
    missionId: Schema.optional(MissionId),
    status: Schema.optional(Schema.Array(DraftStatus)),
    guideFor: Schema.optional(
      Schema.Struct({ channel: DraftChannel, audience: TrimmedNonEmptyString }),
    ),
  }),
  success: Schema.Struct({ drafts: Records, guide: Schema.NullOr(Schema.Unknown) }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
});

const MissionNoteTool = Tool.make("mission_note", {
  description:
    "Read a mission's notes (decisions, risks, deviations, claims of done) with their sources. Read only; the scribe writes notes.",
  parameters: Schema.Struct({ missionId: MissionId }),
  success: Schema.Struct({ notes: Records }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
});

const MissionWatchTool = Tool.make("mission_watch", {
  description:
    "Build a robob-watch watcher that wakes you when a mission changes: returns the check command and the full `robob-watch add` line. Run it yourself; nothing is installed here.",
  parameters: Schema.Struct({
    missionId: MissionId,
    on: Schema.Array(Schema.Literals(WATCH_KINDS)).check(Schema.isMinLength(1)),
    intervalSeconds: Schema.optional(
      Schema.Int.check(Schema.isBetween({ minimum: 30, maximum: 3600 })),
    ),
  }),
  success: Schema.Struct({
    check: Schema.String,
    add: Schema.String,
    kinds: Schema.Array(Schema.String),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
});

const MissionAskTool = Tool.make("mission_ask", {
  description:
    "Ask the owner a decision only he can make. Name exactly what it blocks (work items, lanes, drafts...): only those wait, everything else continues. There is no default, deadline or 'unless you say otherwise': the ask waits for his answer. Give options, a recommendation with its reason, and the cost of waiting. Pass supersedes to replace one of your open asks.",
  parameters: OpenAskRequest,
  success: Schema.Struct({ ask: Schema.Unknown }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
});

const MissionAskWithdrawTool = Tool.make("mission_ask_withdraw", {
  description: "Withdraw one of your open asks (no longer needed). Releases what it held.",
  parameters: WithdrawAskInput,
  success: Schema.Struct({ ask: Schema.Unknown, released: Records }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
});

const MissionAskAnswerTool = Tool.make("mission_ask_answer", {
  description:
    "Record the owner's answer that arrived by iMessage. inboundId must be the incoming iMessage id from the owner's or Moni's chat, and that message must contain the answer text (or the chosen option); anything else is refused. Agents can never answer asks themselves.",
  parameters: Schema.Struct({
    askId: AskId,
    optionId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
    text: Schema.String,
    inboundId: TrimmedNonEmptyString,
  }),
  success: Schema.Struct({ ask: Schema.Unknown, released: Records }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
});

const MissionCallTool = Tool.make("mission_call", {
  description:
    "Record a decision you made yourself (a call) so the owner sees it in his direction check and can say ok, discuss or overruled. Use asks only for decisions you cannot make.",
  parameters: MakeCallInput,
  success: Schema.Struct({ call: Schema.Unknown }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
});

const MissionDraftTool = Tool.make("mission_draft", {
  description:
    "Submit outward text (Linear, GitHub, Cliq, iMessage, WhatsApp, email) as a draft for its approver (the routing table picks owner or master); nothing is sent. Load mission_drafts guideFor first. Pass workItemId and/or subMissionId when the text is about one, so routing rows for it apply (the sub-mission defaults to the work item's, then your lane's). Refused when your role does not write public text: hand the text to a writer role. To answer a rewrite request pass draftId and the new text.",
  parameters: Schema.Struct({
    draftId: Schema.optional(DraftId),
    missionId: Schema.optional(MissionId),
    audience: Schema.optional(TrimmedNonEmptyString),
    channel: Schema.optional(DraftChannel),
    target: Schema.optional(MissionLink),
    text: TrimmedNonEmptyString,
    subMissionId: Schema.optional(SubMissionId),
    workItemId: Schema.optional(WorkItemId),
  }),
  success: Schema.Struct({ draft: Schema.Unknown }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
});

const MissionDraftApproveTool = Tool.make("mission_draft_approve", {
  description:
    "Decide a draft: approve (optionally with edited text), rewrite with a note, or drop. For the owner's decision that arrived by iMessage pass inboundId (his or Moni's incoming iMessage containing it). Without inboundId you decide as the mission's master, which works only for drafts routed to the master. Approval records the draft as approved; sending is separate.",
  parameters: Schema.Struct({
    draftId: DraftId,
    action: Schema.Literals(["approve", "rewrite", "drop"]),
    editedText: Schema.optional(TrimmedNonEmptyString),
    rewriteNote: Schema.optional(TrimmedNonEmptyString),
    inboundId: Schema.optional(TrimmedNonEmptyString),
    revision: Schema.optional(NonNegativeInt).annotate({
      description:
        "The draft revision you read (its `revision` field, 0 when missing). Required to approve without an inboundId; a draft revised or reopened since then is refused, so you decide the text it says now.",
    }),
  }),
  success: Schema.Struct({ draft: Schema.Unknown, suggestions: Records }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
});

const MissionDraftRouteTool = Tool.make("mission_draft_route", {
  description:
    "As the mission's master, send one waiting draft to the owner or to the master, with the reason. The reason is logged and shown with the draft.",
  parameters: RouteDraftInput,
  success: Schema.Struct({ draft: Schema.Unknown }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
});

const MissionDraftAnnotateTool = Tool.make("mission_draft_annotate", {
  description:
    "As the mission's master, set a waiting draft's short summary (one or two lines) and flags (short free labels shown as chips). Omit a field to keep it; flags replace the list.",
  parameters: AnnotateDraftInput,
  success: Schema.Struct({ draft: Schema.Unknown }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
});

const MissionDraftNoteTool = Tool.make("mission_draft_note", {
  description:
    "As a mission's master, save a draft note (how outward text should read), edit one (pass noteId) or turn it off or on (active). Scope: all, a channel, or a person. missionId null means every mission. Writers load matching notes with mission_drafts guideFor.",
  parameters: SaveDraftNoteInput,
  success: Schema.Struct({ note: Schema.Unknown }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
});

const MissionPostTool = Tool.make("mission_post", {
  description: "Post a message into a mission room you belong to.",
  parameters: PostMessageInput,
  success: Schema.Struct({ message: Schema.Unknown }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
});

const MissionSuggestTool = Tool.make("mission_suggest", {
  description:
    "Propose a change (role, rule, review policy, pool, lane, schedule, draft note...) for the owner or master to accept. Nothing applies until accepted. Authors whose suggestions are mostly dismissed face a higher bar (more evidence, fewer open at once).",
  parameters: ProposeSuggestionInput,
  success: Schema.Struct({ suggestion: Schema.Unknown }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
});

const MissionSuggestionDecideTool = Tool.make("mission_suggestion_decide", {
  description:
    "As the mission's master, accept, accept with edits, or dismiss any suggestion in the mission, including ones addressed to the owner. The timeline records that the master decided it.",
  parameters: DecideSuggestionInput,
  success: Schema.Struct({ suggestion: Schema.Unknown }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
});

const MissionForkTool = Tool.make("mission_fork", {
  description:
    "Answer a dev's question from the master's context without disturbing the master: forks the master thread at its latest stable point and hands it the question. The fork drafts the reply with mission_draft and ends with mission_fork_close.",
  parameters: Schema.Struct({
    missionId: MissionId,
    question: TrimmedNonEmptyString,
    origin: Schema.optional(Schema.NullOr(Schema.Union([MissionRecordRef, MissionLink]))),
  }),
  success: Schema.Struct({
    fork: Schema.Unknown,
    delivered: Schema.Boolean,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
});

const MissionForkCloseTool = Tool.make("mission_fork_close", {
  description:
    "End a fork with one line for the master (what was answered or decided). The mission's master (or the owner) can also mark it as committing the mission; the timeline names who did.",
  parameters: Schema.Struct({
    forkId: ForkId,
    summaryLine: TrimmedNonEmptyString,
    commitsMission: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Struct({ fork: Schema.Unknown, delivered: Schema.Boolean }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
});

const MissionForkUpdateTool = Tool.make("mission_fork_update", {
  description:
    "As the mission's master, follow up on a fork: reopen it to keep talking, mark an answered fork as committing the mission, or archive it. Recorded as the master, never as the owner.",
  parameters: UpdateForkInput,
  success: Schema.Struct({ fork: Schema.Unknown, delivered: Schema.Boolean }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
});

const MissionDraftReopenTool = Tool.make("mission_draft_reopen", {
  description:
    "As the mission's master, put an approved or dropped draft back to pending, including one the owner decided. It goes back to its approver: a draft routed to the owner still waits for him. Reopening starts a new revision, so earlier approvals no longer count.",
  parameters: ReopenDraftInput,
  success: Schema.Struct({ draft: Schema.Unknown }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
});

const MissionSuggestionReopenTool = Tool.make("mission_suggestion_reopen", {
  description:
    "As the mission's master, put a dismissed suggestion back to open. The timeline records that the master reopened it.",
  parameters: ReopenSuggestionInput,
  success: Schema.Struct({ suggestion: Schema.Unknown }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
});

const MissionNoteAckTool = Tool.make("mission_note_ack", {
  description:
    "As the mission's master, acknowledge a note (for example a fork that commits the mission).",
  parameters: Schema.Struct({ noteId: NoteId }),
  success: Schema.Struct({ note: Schema.Unknown }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
});

// Master plan tools: core's writes with the master's agent provenance.
const planDependencies = [...dependencies, MissionService.MissionService];

const MissionSubMissionTool = Tool.make("mission_sub_mission", {
  description:
    "As the mission's master, create a sub-mission (new subMissionId or none, title required) or update any of its fields, including closing it (status closed).",
  parameters: UpsertSubMissionInput,
  success: MissionMutationResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: planDependencies,
});

const MissionMilestoneTool = Tool.make("mission_milestone", {
  description:
    "As the mission's master, create a milestone (title and subMissionId required) or update its target, status, note or items.",
  parameters: UpsertMilestoneInput,
  success: MissionMutationResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: planDependencies,
});

const MissionLaneTool = Tool.make("mission_lane", {
  description:
    "As the mission's master, create a lane (name required) or update it: move it to another sub-mission, park, retire or resume it, set its lead, thread or current item. A lane an open ask holds keeps waiting until the owner answers (parking or retiring it is still allowed).",
  parameters: UpsertLaneInput,
  success: MissionMutationResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: planDependencies,
});

const MissionWorkItemTool = Tool.make("mission_work_item", {
  description:
    "As the mission's master, create a work item (title required) or update its stage, lane, milestone, holder, dependencies, PR, links or facts. Ask holds in blockedBy come only from open asks and are kept as they are.",
  parameters: UpsertWorkItemInput,
  success: MissionMutationResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: planDependencies,
});

// Master controls (owner rule, 17 Oct 2026: everything the owner can do, the
// master can do). Same service methods as the owner's Robob UI; each change is
// a timeline event recorded as the master.
const missionWriteTool = <Name extends string, P extends Schema.Constraint>(
  name: Name,
  description: string,
  parameters: P,
) =>
  Tool.make(name, {
    description,
    parameters,
    success: MissionMutationResult,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: planDependencies,
  });

const MissionCreateTool = missionWriteTool(
  "mission_create",
  "As a mission master, create a new mission (slug and title required; tier, weight and shares optional). It starts active with no master.",
  CreateMissionInput,
);

const MissionUpdateTool = missionWriteTool(
  "mission_update",
  "As the mission's master, change any mission field: title, goal, tier, weight, guaranteed share, borrow ceiling, project or master role.",
  UpdateMissionInput,
);

const MissionSetStatusTool = missionWriteTool(
  "mission_set_status",
  "As the mission's master, pause (paused), resume (active), drain (draining), archive (archived) or unarchive (active) the mission.",
  SetMissionStatusInput,
);

const MissionFocusTool = missionWriteTool(
  "mission_focus",
  "As the mission's master, turn focus mode on for one open sub-mission, or off with subMissionId null. Focus has no end time; it stays until someone turns it off.",
  SetMissionFocusInput,
);

const MissionSubMissionReorderTool = missionWriteTool(
  "mission_sub_mission_reorder",
  "As the mission's master, reorder the open sub-missions. `order` must list every open sub-mission exactly once.",
  ReorderSubMissionsInput,
);

const MissionSubMissionMergeTool = missionWriteTool(
  "mission_sub_mission_merge",
  "As the mission's master, merge one sub-mission into another: its lanes, milestones and work items move to intoSubMissionId, it closes, and focus follows if it had it.",
  MergeSubMissionsInput,
);

const MissionLaneSplitTool = missionWriteTool(
  "mission_lane_split",
  "As the mission's master, split a lane: a new lane (name required) takes the listed work items from it, in the same sub-mission unless subMissionId says otherwise.",
  SplitLaneInput,
);

const MissionLaneMergeTool = missionWriteTool(
  "mission_lane_merge",
  "As the mission's master, merge a lane into another: its work items move to intoLaneId and it retires. A lane an open ask holds cannot be merged away until the ask is answered or withdrawn.",
  MergeLanesInput,
);

const MissionApprovalsTool = Tool.make("mission_approvals", {
  description:
    "A mission's approvals, newest first: crw merge approvals and others, each with its approver (owner or master), status, decision and any re-route reason.",
  parameters: Schema.Struct({
    missionId: MissionId,
    status: Schema.optional(Schema.Array(ApprovalStatus)),
  }),
  success: Schema.Struct({ approvals: Records }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: planDependencies,
});

const MissionApprovalDecideTool = missionWriteTool(
  "mission_approval_decide",
  "As the mission's master, approve or reject a pending approval routed to the master (with an optional note). Approvals routed to the owner are his; re-route one first with mission_approval_route if he agreed. Stale-closed approvals never count, and an approval only covers the head it names.",
  Schema.Struct({
    missionId: MissionId,
    approvalId: ApprovalId,
    action: Schema.Literals(["approve", "reject"]),
    note: Schema.optional(Schema.String),
  }),
);

const MissionApprovalRouteTool = missionWriteTool(
  "mission_approval_route",
  "As the mission's master, send one pending approval to the owner or to the master, with the reason. The reason is logged and shown with the approval.",
  Schema.Struct({ missionId: MissionId, ...RouteApprovalInput.fields }),
);

const MissionApprovalAnnotateTool = missionWriteTool(
  "mission_approval_annotate",
  "As the mission's master, set a pending approval's short summary (one or two lines) and flags (short free labels shown as chips), e.g. when it arrived without them. Omit a field to keep it; flags replace the list.",
  Schema.Struct({ missionId: MissionId, ...AnnotateApprovalInput.fields }),
);

const MissionApprovalRoutingTool = missionWriteTool(
  "mission_approval_routing",
  "As the mission's master, replace the mission's approval routing table: rows matched in order, first match wins. An approval row matches by kind, repository (owner/repo), sub-mission or work item (the item whose pull request the approval is for); a draft row by channel, audience or person. Anything no row matches goes to the owner. Applies to approvals opened from now on.",
  SetApprovalRoutingInput,
);

const ruleDependencies = [...planDependencies, RuleService.RuleService];

const MissionRuleTool = Tool.make("mission_rule", {
  description:
    "As the mission's master, write a rule (no ruleId), or edit any rule's wording, scope, activation or your reading, or retire it (status retired). missionId null means a rule for every mission. Changing the quote bumps the rule's version.",
  parameters: UpsertRuleInput,
  success: Schema.Struct({ rule: Schema.Unknown }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: ruleDependencies,
});

const MissionRuleUseTool = Tool.make("mission_rule_use", {
  description:
    "As the mission's master, record that a rule was applied or broken, with a short note. It counts on the rule and goes on the timeline.",
  parameters: RecordRuleUseInput,
  success: Schema.Struct({ rule: Schema.Unknown }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: ruleDependencies,
});

const MissionRuleChangeTool = Tool.make("mission_rule_change", {
  description:
    "Ask for a change to a rule, in words. Anyone in the mission may ask; the owner or the master resolves it with mission_rule_change_resolve.",
  parameters: Schema.Struct({
    ruleId: RequestRuleChangeInput.fields.ruleId,
    request: RequestRuleChangeInput.fields.request,
  }),
  success: Schema.Struct({ request: Schema.Unknown }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: ruleDependencies,
});

const MissionRuleChangeResolveTool = Tool.make("mission_rule_change_resolve", {
  description:
    "As the mission's master, resolve an open rule change request: applied (edit the rule with mission_rule too), declined, or withdrawn, with your response.",
  parameters: ResolveRuleChangeInput,
  success: Schema.Struct({ request: Schema.Unknown }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: ruleDependencies,
});

interface ToolConfig {
  readonly parameters: Schema.Constraint;
  readonly success: Schema.Constraint;
  readonly failure: Schema.Constraint;
  readonly failureMode: Tool.FailureMode;
}

// Reads: no side effects. Strict everywhere so unknown keys are refused.
const readTool = <Name extends string, Config extends ToolConfig, R>(
  tool: Tool.Tool<Name, Config, R>,
  title: string,
) =>
  tool
    .annotate(Tool.Title, title)
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false)
    .annotate(Tool.Strict, true);

const writeTool = <Name extends string, Config extends ToolConfig, R>(
  tool: Tool.Tool<Name, Config, R>,
  title: string,
) =>
  tool
    .annotate(Tool.Title, title)
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, false)
    .annotate(Tool.OpenWorld, false)
    .annotate(Tool.Strict, true);

export const MissionsToolkit = Toolkit.make(
  readTool(MissionStatusTool, "Mission status"),
  readTool(MissionDigestTool, "Mission digest"),
  readTool(MissionAsksTool, "Mission asks"),
  readTool(MissionDraftsTool, "Mission drafts"),
  readTool(MissionNoteTool, "Mission notes"),
  readTool(MissionWatchTool, "Watch a mission"),
  writeTool(MissionAskTool, "Ask the owner"),
  writeTool(MissionAskWithdrawTool, "Withdraw an ask"),
  writeTool(MissionAskAnswerTool, "Record the owner's iMessage answer"),
  writeTool(MissionCallTool, "Record a call"),
  writeTool(MissionDraftTool, "Submit a draft"),
  writeTool(MissionDraftApproveTool, "Decide a draft"),
  writeTool(MissionDraftReopenTool, "Reopen a draft"),
  writeTool(MissionDraftRouteTool, "Route one draft"),
  writeTool(MissionDraftAnnotateTool, "Annotate a draft"),
  writeTool(MissionDraftNoteTool, "Save, edit or turn off a draft note"),
  writeTool(MissionPostTool, "Post to a mission room"),
  writeTool(MissionSuggestTool, "Suggest a change"),
  writeTool(MissionSuggestionDecideTool, "Decide a master suggestion"),
  writeTool(MissionSuggestionReopenTool, "Reopen a dismissed suggestion"),
  writeTool(MissionForkTool, "Fork the master for a question"),
  writeTool(MissionForkCloseTool, "Close a fork"),
  writeTool(MissionForkUpdateTool, "Reopen, commit or archive a fork"),
  writeTool(MissionNoteAckTool, "Acknowledge a note"),
  writeTool(MissionSubMissionTool, "Create or update a sub-mission"),
  writeTool(MissionMilestoneTool, "Create or update a milestone"),
  writeTool(MissionLaneTool, "Create or update a lane"),
  writeTool(MissionWorkItemTool, "Create or update a work item"),
  writeTool(MissionCreateTool, "Create a mission"),
  writeTool(MissionUpdateTool, "Update a mission"),
  writeTool(MissionSetStatusTool, "Pause, resume, drain or archive a mission"),
  writeTool(MissionFocusTool, "Set or clear focus mode"),
  writeTool(MissionSubMissionReorderTool, "Reorder sub-missions"),
  writeTool(MissionSubMissionMergeTool, "Merge sub-missions"),
  writeTool(MissionLaneSplitTool, "Split a lane"),
  writeTool(MissionLaneMergeTool, "Merge lanes"),
  readTool(MissionApprovalsTool, "Mission approvals"),
  writeTool(MissionApprovalDecideTool, "Decide an approval routed to the master"),
  writeTool(MissionApprovalRouteTool, "Route one approval"),
  writeTool(MissionApprovalAnnotateTool, "Annotate an approval"),
  writeTool(MissionApprovalRoutingTool, "Set approval routing"),
  writeTool(MissionRuleTool, "Write, edit or retire a rule"),
  writeTool(MissionRuleUseTool, "Record a rule applied or broken"),
  writeTool(MissionRuleChangeTool, "Ask for a rule change"),
  writeTool(MissionRuleChangeResolveTool, "Resolve a rule change request"),
);
