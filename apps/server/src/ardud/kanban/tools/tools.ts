/**
 * Missions board tools for agent threads. Who may do what comes from the
 * calling thread's board link: a card's work or review thread acts on its own
 * card; an evaluator acts on the whole board. The service enforces the moves.
 */
import {
  KanbanBlock,
  KanbanStage,
  NonNegativeInt,
  OrchestratorMcpFailure,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";

import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { KanbanService } from "../engine/KanbanService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  KanbanService,
];

const Record = Schema.Unknown;
const Records = Schema.Array(Schema.Unknown);

const describe = <S extends Schema.Top>(schema: S, description: string) =>
  schema.annotate({ description });

const CardRef = describe(
  TrimmedNonEmptyString,
  'Card id or number ("#12" or "12"). Defaults to your own card when you are a card thread.',
);

export const ModelInput = Schema.Struct({
  model: describe(
    TrimmedNonEmptyString,
    'Model id exactly as the board pools list it (board_get), e.g. "opus/claude-opus-5-5".',
  ),
  instanceId: Schema.optional(
    describe(TrimmedNonEmptyString, 'Provider instance; leave out to use "opencode".'),
  ),
  variant: Schema.optional(
    describe(TrimmedNonEmptyString, 'Thinking variant, e.g. "high" or "xhigh".'),
  ),
});
export type ModelInput = typeof ModelInput.Type;

const LinkInput = Schema.Struct({
  url: TrimmedNonEmptyString,
  label: Schema.optional(Schema.String),
});

const BlocksInput = {
  text: Schema.optional(describe(Schema.String, "Markdown message (shortcut for one md block).")),
  blocks: Schema.optional(
    describe(
      Schema.Array(KanbanBlock),
      'Rich blocks, each with _tag: md {text}, collapse {title, text}, html {html, title, height}, choice {id, style "poll"|"pick", question, options [{id,label}], multi}, card {cardId}, image {url, alt}.',
    ),
  ),
};

const tool = <
  const Name extends string,
  P extends Schema.Struct.Fields,
  S extends Schema.Struct.Fields,
>(
  name: Name,
  title: string,
  description: string,
  parameters: P,
  success: S,
  flags: { readonly readonly: boolean; readonly destructive?: boolean },
) =>
  Tool.make(name, {
    description,
    parameters: Schema.Struct(parameters),
    success: Schema.Struct(success),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies,
  })
    .annotate(Tool.Title, title)
    .annotate(Tool.Readonly, flags.readonly)
    .annotate(Tool.Destructive, flags.destructive ?? false)
    .annotate(Tool.Idempotent, flags.readonly)
    .annotate(Tool.OpenWorld, false);

const BoardGet = tool(
  "board_get",
  "Read the board",
  "The Missions board you work on: board settings and instructions, every card, goals, pools, groups, live thread states and unread counts. Threads outside a board pass boardId.",
  { boardId: Schema.optional(TrimmedNonEmptyString) },
  { board: Record },
  { readonly: true },
);

const CardGet = tool(
  "card_get",
  "Read a card",
  "One card with its history (moves, edits, comments, review verdicts) and every thread it has had.",
  { card: Schema.optional(CardRef) },
  { card: Record, events: Records, threads: Records },
  { readonly: true },
);

const CardUpdate = tool(
  "card_update",
  "Update your card",
  "For a card's work thread: change the card description, attach links (PRs, Linear, any URL; added by URL, existing links stay) or add a comment. Attach every PR before moving to needs_review: the card completes only when they are merged or closed.",
  {
    card: Schema.optional(CardRef),
    description: Schema.optional(Schema.String),
    links: Schema.optional(Schema.Array(LinkInput)),
    comment: Schema.optional(Schema.String),
  },
  { card: Record },
  { readonly: false },
);

const CardMove = tool(
  "card_move",
  "Move a card",
  "Work thread: move your card to needs_review when the work is done (a reviewer starts), or to needs_owner with the question when you need the owner. Evaluators: any stage except working and in_review, which the dispatcher owns.",
  {
    card: Schema.optional(CardRef),
    to: KanbanStage,
    note: Schema.optional(describe(Schema.String, "One line for the card history.")),
    question: Schema.optional(
      describe(Schema.String, "Required for needs_owner: what the owner must decide."),
    ),
  },
  { card: Record },
  { readonly: false },
);

const CardFlag = tool(
  "card_flag",
  "Flag a card stalled",
  "Mark a card stalled with the reason (missing access, broken environment, waiting on something outside the board), or clear the flag with stalled false. A card thread flagging its own card gives up its slot.",
  {
    card: Schema.optional(CardRef),
    stalled: Schema.Boolean,
    reason: Schema.optional(Schema.String),
  },
  { card: Record },
  { readonly: false },
);

const CardReviewResult = tool(
  "card_review_result",
  "Record the review verdict",
  "Review threads only, once per review step: clear (no findings) or findings (each a short, actionable line). Findings send the card back to its work thread; clear moves to the next review step or completes the review.",
  {
    verdict: Schema.Literals(["clear", "findings"]),
    findings: Schema.optional(Schema.Array(Schema.String)),
  },
  { card: Record },
  { readonly: false },
);

const DiscussionPost = tool(
  "discussion_post",
  "Post in a discussion",
  "Post a message in a discussion. Defaults to your card's discussion (card threads) or your own discussion (discussion evaluators). This is the only way the owner sees your replies.",
  { discussionId: Schema.optional(TrimmedNonEmptyString), ...BlocksInput },
  { message: Record },
  { readonly: false },
);

const DiscussionRead = tool(
  "discussion_read",
  "Read a discussion",
  "Messages of a discussion (latest 200, or those after afterSeq), with answers to polls and picks. Defaults like discussion_post.",
  {
    discussionId: Schema.optional(TrimmedNonEmptyString),
    afterSeq: Schema.optional(NonNegativeInt),
  },
  { discussion: Record, messages: Records },
  { readonly: true },
);

const WikiRead = tool(
  "wiki_read",
  "Read the board wiki",
  "The board's shared lessons. Without slug: every page.",
  { slug: Schema.optional(TrimmedNonEmptyString) },
  { pages: Records },
  { readonly: true },
);

const CardCreate = tool(
  "card_create",
  "Create a card",
  "Evaluators: create a card in todo (the dispatcher starts it when a slot is free) or needs_owner (with the question). The prompt is what the work thread gets; title and description are written for you when left out.",
  {
    prompt: Schema.String,
    title: Schema.optional(Schema.String),
    description: Schema.optional(Schema.String),
    priority: Schema.optional(describe(Schema.Int, "1 (urgent) to 4; default 3.")),
    goalId: Schema.optional(TrimmedNonEmptyString),
    projects: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
    model: Schema.optional(ModelInput),
    projectId: Schema.optional(
      describe(TrimmedNonEmptyString, "T3 project the card threads run in; default the board's."),
    ),
    links: Schema.optional(Schema.Array(LinkInput)),
    blockedBy: Schema.optional(Schema.Array(CardRef)),
    stage: Schema.optional(Schema.Literals(["todo", "needs_owner"])),
    question: Schema.optional(Schema.String),
    reviewChain: Schema.optional(
      describe(Schema.String, "Review chain name; default the board's."),
    ),
  },
  { card: Record },
  { readonly: false },
);

const CardEdit = tool(
  "card_edit",
  "Edit a card",
  "Evaluators: change any card field. Links are added by URL; blockedBy replaces the list.",
  {
    card: CardRef,
    title: Schema.optional(Schema.String),
    description: Schema.optional(Schema.String),
    prompt: Schema.optional(Schema.String),
    priority: Schema.optional(Schema.Int),
    goalId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
    projects: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
    model: Schema.optional(ModelInput),
    projectId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
    links: Schema.optional(Schema.Array(LinkInput)),
    blockedBy: Schema.optional(Schema.Array(CardRef)),
    reviewChain: Schema.optional(Schema.NullOr(Schema.String)),
    comment: Schema.optional(Schema.String),
  },
  { card: Record },
  { readonly: false },
);

const CardThread = tool(
  "card_thread",
  "Steer, stop or wake a card thread",
  "Evaluators: steer the card's live thread with text, stop it (the card keeps its place; move it if needed), or wake its last work thread with text.",
  {
    card: CardRef,
    action: Schema.Literals(["steer", "stop", "wake"]),
    text: Schema.optional(Schema.String),
  },
  { card: Record },
  { readonly: false, destructive: true },
);

const PoolSet = tool(
  "pool_set",
  "Set a model pool",
  "Evaluators: how many threads may run at once on a model. Lowering never stops running threads by itself.",
  { model: ModelInput, slots: NonNegativeInt },
  { pools: Records },
  { readonly: false },
);

const GoalSet = tool(
  "goal_set",
  "Create or update a goal",
  "Evaluators: create a goal (name) or update one (id): status, Now (current status, plain words) and a new Story entry (appended to the numbered story for a non-technical reader).",
  {
    id: Schema.optional(TrimmedNonEmptyString),
    name: Schema.optional(Schema.String),
    status: Schema.optional(Schema.Literals(["active", "done"])),
    now: Schema.optional(Schema.String),
    story: Schema.optional(Schema.String),
  },
  { goal: Record },
  { readonly: false },
);

const GroupSet = tool(
  "group_set",
  "Set the similar-card groups",
  "Evaluators and the scribe: replace the board's view-only groups of similar cards, each with a plain summary a busy reader understands.",
  {
    groups: Schema.Array(
      Schema.Struct({
        id: TrimmedNonEmptyString,
        name: TrimmedNonEmptyString,
        summary: Schema.String,
        cards: Schema.Array(CardRef),
      }),
    ),
  },
  { groups: Records },
  { readonly: false },
);

const DiscussionCreate = tool(
  "discussion_create",
  "Open a discussion",
  "Evaluators: open a new discussion channel with the owner, then post into it with discussion_post.",
  { title: TrimmedNonEmptyString, ...BlocksInput },
  { discussion: Record },
  { readonly: false },
);

const WikiWrite = tool(
  "wiki_write",
  "Write a wiki page",
  "Evaluators: create or replace a wiki page of lessons future threads should know.",
  { slug: TrimmedNonEmptyString, title: TrimmedNonEmptyString, body: Schema.String },
  { page: Record },
  { readonly: false },
);

const BoardOpen = tool(
  "board_open",
  "Open a Missions board",
  "Create a board (or return the existing one with this slug). projectId is the T3 project its threads run in.",
  {
    slug: TrimmedNonEmptyString,
    name: TrimmedNonEmptyString,
    projectId: Schema.optional(TrimmedNonEmptyString),
  },
  { board: Record },
  { readonly: false },
);

const EvaluatorStart = tool(
  "evaluator_start",
  "Start an evaluator",
  "Start an evaluator thread on a board for a job: setup or request (with text), or a sweep (stalled, completed, deployed, check).",
  {
    boardId: TrimmedNonEmptyString,
    kind: Schema.Literals(["setup", "request", "stalled", "completed", "deployed", "check"]),
    text: Schema.optional(Schema.String),
  },
  { threadId: TrimmedNonEmptyString },
  { readonly: false },
);

export const KanbanToolkit = Toolkit.make(
  BoardGet,
  CardGet,
  CardUpdate,
  CardMove,
  CardFlag,
  CardReviewResult,
  DiscussionPost,
  DiscussionRead,
  WikiRead,
  CardCreate,
  CardEdit,
  CardThread,
  PoolSet,
  GoalSet,
  GroupSet,
  DiscussionCreate,
  WikiWrite,
  BoardOpen,
  EvaluatorStart,
);
