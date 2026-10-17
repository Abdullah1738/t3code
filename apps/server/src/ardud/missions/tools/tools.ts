import {
  AskId,
  AskStatus,
  DecideSuggestionInput,
  DraftChannel,
  DraftId,
  DraftStatus,
  ForkId,
  MissionId,
  MissionLink,
  MissionRecordRef,
  NoteId,
  OrchestratorMcpFailure,
  PostMessageInput,
  TrimmedNonEmptyString,
  WithdrawAskInput,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";

import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as AsksService from "../asks/AsksService.ts";
import { MakeCallInput, OpenAskRequest, ProposeSuggestionInput } from "../asks/inputs.ts";
import { WATCH_KINDS } from "../asks/watch.ts";

/**
 * Mission tools for agents in any T3 thread. Who is calling comes from the
 * calling thread (MCP invocation context), never from parameters, and every
 * tool is strict: an unknown key such as `default` or `askedBy` is refused.
 * The only owner-voiced writes are answers and draft decisions that carry the
 * id of the owner's (or Moni's) iMessage, which the server verifies.
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
    "Submit outward text (Linear, GitHub, Cliq, iMessage, WhatsApp, email) as a draft for the owner to approve; nothing is sent. Load mission_drafts guideFor first. To answer a rewrite request pass draftId and the new text.",
  parameters: Schema.Struct({
    draftId: Schema.optional(DraftId),
    missionId: Schema.optional(MissionId),
    audience: Schema.optional(TrimmedNonEmptyString),
    channel: Schema.optional(DraftChannel),
    target: Schema.optional(MissionLink),
    text: TrimmedNonEmptyString,
  }),
  success: Schema.Struct({ draft: Schema.Unknown }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
});

const MissionDraftApproveTool = Tool.make("mission_draft_approve", {
  description:
    "Record the owner's decision on a draft that arrived by iMessage: approve (optionally with his edited text), rewrite with his note, or drop. inboundId must be his (or Moni's) incoming iMessage containing that decision. Approval records the draft as approved; sending is separate.",
  parameters: Schema.Struct({
    draftId: DraftId,
    action: Schema.Literals(["approve", "rewrite", "drop"]),
    editedText: Schema.optional(TrimmedNonEmptyString),
    rewriteNote: Schema.optional(TrimmedNonEmptyString),
    inboundId: TrimmedNonEmptyString,
  }),
  success: Schema.Struct({ draft: Schema.Unknown, suggestions: Records }),
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
    "As the mission's master, accept, accept with edits, or dismiss a suggestion addressed to the master that you did not author. Owner-addressed suggestions are his to decide.",
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
    "End a fork with one line for the master (what was answered or decided). Only the owner can mark a fork as committing the mission.",
  parameters: Schema.Struct({ forkId: ForkId, summaryLine: TrimmedNonEmptyString }),
  success: Schema.Struct({ fork: Schema.Unknown, delivered: Schema.Boolean }),
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
  writeTool(MissionDraftApproveTool, "Record the owner's iMessage draft decision"),
  writeTool(MissionPostTool, "Post to a mission room"),
  writeTool(MissionSuggestTool, "Suggest a change"),
  writeTool(MissionSuggestionDecideTool, "Decide a master suggestion"),
  writeTool(MissionForkTool, "Fork the master for a question"),
  writeTool(MissionForkCloseTool, "Close a fork"),
  writeTool(MissionNoteAckTool, "Acknowledge a note"),
);
