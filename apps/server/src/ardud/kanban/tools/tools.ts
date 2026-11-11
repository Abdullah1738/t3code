/**
 * Missions board tools for agent threads. Who may do what comes from the
 * calling thread's board link: a card's work or review thread acts on its own
 * card; an evaluator acts on the whole board. The service enforces the moves.
 */
import {
  KanbanBlockInput,
  KanbanBoardIcon,
  KanbanPriority,
  KanbanStage,
  NonNegativeInt,
  OrchestratorMcpFailure,
  PositiveInt,
  ProviderOptionSelection,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";

import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import { KanbanService } from "../engine/KanbanService.ts";
import { MAX_BATCH } from "../engine/rules.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  ServerSettings.ServerSettingsService,
  KanbanService,
];

const Record = Schema.Unknown;
const Records = Schema.Array(Schema.Unknown);
const RawBoardText = Schema.toType(TrimmedNonEmptyString);

const describe = <S extends Schema.Top>(schema: S, description: string) =>
  schema.annotate({ description });

const CardRef = describe(
  TrimmedNonEmptyString,
  'Card id or number ("#12" or "12"). Defaults to your own card when you are a card thread carrying one card.',
);

const ModelInputFields = {
  model: describe(
    TrimmedNonEmptyString,
    'Model id exactly as the board pools list it (board_get), e.g. "opus/claude-opus-5-5".',
  ),
  instanceId: Schema.optional(
    describe(TrimmedNonEmptyString, 'Provider instance; leave out to use "opencode".'),
  ),
  effort: Schema.optional(
    describe(TrimmedNonEmptyString, 'Thinking effort, e.g. "xhigh". Prefer this over variant.'),
  ),
  variant: Schema.optional(
    describe(
      TrimmedNonEmptyString,
      "Legacy name for effort. If both are supplied, they must agree.",
    ),
  ),
  options: Schema.optional(
    describe(
      Schema.Array(ProviderOptionSelection),
      "Full provider options, including fastMode or serviceTier.",
    ),
  ),
};
export const ModelInput = Schema.Struct(ModelInputFields);
export type ModelInput = typeof ModelInput.Type;

const WeightedModels = describe(
  Schema.Array(
    Schema.Struct({
      ...ModelInputFields,
      weight: describe(
        PositiveInt,
        "Higher wins when its pool has room; equal weights split at random.",
      ),
    }),
  ),
  "Several models to start on, by weight: the card starts on the highest-weight model whose pool has room, and its thread keeps that model. Wins over model.",
);

const SubtasksInput = describe(
  Schema.Array(
    Schema.Struct({
      id: Schema.optional(
        describe(TrimmedNonEmptyString, "An existing subtask's id (s1, s2...) to keep it."),
      ),
      step: Schema.optional(
        describe(
          PositiveInt,
          "Subtasks with the same step go in any order. Leave out for the step after the previous entry.",
        ),
      ),
      text: RawBoardText,
      owner: describe(
        Schema.Literals(["work", "review", "evaluator", "script"]),
        "Who does it: the worker, the reviewer (ticked when the review passes), an evaluator, or a board script (the script ticks it from its output; the evaluator hears about it only if the script hands it back).",
      ),
      script: Schema.optional(
        describe(
          TrimmedNonEmptyString,
          "For a script's subtask: the name of the board script that does it. Left out, any script on the board can.",
        ),
      ),
    }),
  ),
  "The card's plan, in order: the work, its review and everything after (merge, deploy, telling whoever asked, updating tickets, a read-back). Leave out steps that aren't needed. On card_edit it replaces the plan: listed ids keep their state, open ones left out go, done ones stay.",
);

const LinkInput = Schema.Struct({
  url: TrimmedNonEmptyString,
  label: Schema.optional(Schema.String),
});

const BlocksInput = {
  text: Schema.optional(describe(Schema.String, "Markdown message (shortcut for one md block).")),
  blocks: Schema.optional(
    describe(
      Schema.Array(KanbanBlockInput),
      'Rich blocks, each with _tag: md {text}, collapse {title, text}, html {html, title, height}, choice {id, style "poll"|"pick", question, options [{id,label}], multi}, card {cardId}, image {url, alt}, attachment {attachment: {type image|file, id, name, mimeType, sizeBytes}} (the id comes from t3_attachment_prepare_upload).',
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
    // An empty Schema.Struct has no `type: object` root, so McpServer refuses
    // to register it and the whole MCP layer fails.
    parameters: Object.keys(parameters).length === 0 ? Tool.EmptyParams : Schema.Struct(parameters),
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
  "Compact Missions board: settings/instructions, goals, pools, groups, live thread states, unread counts and a page of card number/title/stage/owner/model/short status. No card descriptions, prompts, event histories, goal stories or wiki bodies; use card_get and wiki_read for detail. Default 200 cards, max 500; follow board.page.nextAfter with after while hasMore. Threads outside a board pass boardId.",
  {
    boardId: Schema.optional(TrimmedNonEmptyString),
    after: Schema.optional(
      describe(NonNegativeInt, "Cards numbered after this cursor (default 0)."),
    ),
    limit: Schema.optional(describe(PositiveInt, "Page size, default 200, capped at 500.")),
  },
  { board: Record, prompts: Schema.String },
  { readonly: true },
);

const CardSearch = tool(
  "card_search",
  "Search cards",
  "Find cards on a board by words in their title, description, prompt or links, or by #number. Settled cards are left out unless includeSettled. Returns short rows, newest first; read one in full with card_get.",
  {
    boardId: Schema.optional(TrimmedNonEmptyString),
    query: describe(Schema.String, "Words to match (all of them), or #12. Empty lists every card."),
    stage: Schema.optional(KanbanStage),
    includeSettled: Schema.optional(Schema.Boolean),
    limit: Schema.optional(describe(PositiveInt, "At most this many rows (default 20).")),
  },
  { cards: Records, total: NonNegativeInt },
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
  "For a card's work thread: change the card description, attach links (PRs, Linear, any URL; added by URL, existing links stay) or add a comment. Attach every PR before moving to needs_review and link it to your thread (link_pull_request): the card completes only when your thread's PRs are merged or closed. A PR link your thread didn't link is context and doesn't hold the card. If it fails with 'Board busy', nothing was saved and the same call can be repeated; an identical repeat within 10 minutes is not saved twice.",
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
  "Work thread: move your card to needs_review when the work is done (a reviewer starts), or to needs_owner with the question when you need the owner. Evaluators: any stage except working and in_review, which the dispatcher owns; completed and deployed only once the card's review passed.",
  {
    card: Schema.optional(CardRef),
    to: KanbanStage,
    note: Schema.optional(describe(Schema.String, "One line for the card history.")),
    question: Schema.optional(
      describe(Schema.String, "Required for needs_owner: what the owner must decide."),
    ),
  },
  { card: Record, message: Schema.optional(Schema.String) },
  { readonly: false },
);

const CardAsk = tool(
  "card_ask",
  "Ask the owner",
  "Ask the owner a question on a card; it shows in Needs Owner and in the card's discussion, and his answer comes back to you. Async by default: the card and its work go on, and the owner can make it blocking later. Pass blocking only when the work can't go on without the answer: the card then waits in Needs Owner (a work thread's own card must be in Working, and gives up its slot). Options make it a pick; multi lets him tick several.",
  {
    card: Schema.optional(CardRef),
    question: Schema.String,
    blocking: Schema.optional(Schema.Boolean),
    options: Schema.optional(
      describe(Schema.Array(Schema.String), "Answers to pick from, when they are known."),
    ),
    multi: Schema.optional(
      describe(
        Schema.Boolean,
        "With options: let the owner tick several (a checklist). Default: one pick.",
      ),
    ),
  },
  { card: Record },
  { readonly: false },
);

const CardAskChange = tool(
  "card_ask_change",
  "Change an open ask",
  "Make an open async ask (q1, q2... on the card) blocking, or drop one that is no longer needed. A work thread changes only its own card's asks.",
  {
    card: Schema.optional(CardRef),
    ask: Schema.String,
    action: Schema.Literals(["block", "drop"]),
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
  "Review threads only, once per review step: clear (no findings) or findings (each a short, actionable line). Findings send the card back to its work thread; clear moves to the next review step or completes the review. After a connection error, repeating the exact same call (same verdict, findings and head) is safe: an exact repeat of your latest verdict is ignored.",
  {
    verdict: Schema.Literals(["clear", "findings"]),
    findings: Schema.optional(Schema.Array(Schema.String)),
    head: Schema.optional(
      Schema.String.annotate({
        description:
          "The commit you reviewed: the PR's head sha, or `git rev-parse HEAD` on the card's branch. Stored on the review event so scripts land only what was reviewed.",
      }),
    ),
  },
  { card: Record },
  { readonly: false },
);

const DiscussionPost = tool(
  "discussion_post",
  "Post in a discussion",
  "Post a message in a discussion. Pass discussionId, or card for that card's discussion. Defaults to your card's discussion (card threads) or your own discussion (discussion evaluators). This is the only way the owner sees your replies. If it fails with 'Board busy', nothing was saved and the same call can be repeated; an identical repeat within 10 minutes is not saved twice.",
  {
    discussionId: Schema.optional(TrimmedNonEmptyString),
    card: Schema.optional(CardRef),
    ...BlocksInput,
  },
  { message: Record },
  { readonly: false },
);

const DiscussionRead = tool(
  "discussion_read",
  "Read a discussion",
  "Messages of a discussion, newest last, with answers to polls and picks: the latest ones (after afterSeq / before beforeSeq when given), up to 200 and about 1 MB. When older ones were left out, earlierBefore is set: read again with beforeSeq. seq reads one message in full. Defaults like discussion_post.",
  {
    discussionId: Schema.optional(TrimmedNonEmptyString),
    card: Schema.optional(CardRef),
    afterSeq: Schema.optional(NonNegativeInt),
    beforeSeq: Schema.optional(NonNegativeInt),
    seq: Schema.optional(describe(PositiveInt, "Read only this message, in full.")),
  },
  {
    discussion: Record,
    messages: Records,
    earlierBefore: Schema.optional(
      describe(
        NonNegativeInt,
        "Older messages were left out; pass this as beforeSeq to read them.",
      ),
    ),
    note: Schema.optional(Schema.String),
  },
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
  "Create a card in todo (the dispatcher starts it when a slot is free) or, for evaluators, needs_owner (with the question). A card's work thread can pass assignToSelf to take the new card into its own run at once (same model pool; it shares the thread's slot; you get its task back as brief). A work thread's new cards keep the review chain of its card. The prompt is what the work thread gets; from an evaluator it is the packet (scope, files, steps, tests, when it's done). A card a thread makes without assignToSelf waits for an evaluator to write its packet. Title and description are written for you when left out. Refused when an open card on the board has the same title or the same source link (not card, PR or Linear links).",
  {
    prompt: Schema.String,
    assignToSelf: Schema.optional(
      describe(
        Schema.Boolean,
        "Work threads: take the card yourself now. It runs on your model and project.",
      ),
    ),
    title: Schema.optional(Schema.String),
    description: Schema.optional(Schema.String),
    priority: Schema.optional(
      describe(KanbanPriority, "1 (urgent) to 4 (low); default 3. 5 is the backlog."),
    ),
    goalId: Schema.optional(TrimmedNonEmptyString),
    projects: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
    model: Schema.optional(ModelInput),
    models: Schema.optional(WeightedModels),
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
    subtasks: Schema.optional(SubtasksInput),
  },
  { card: Record, brief: Schema.optional(Schema.String) },
  { readonly: false },
);

const CardClaim = tool(
  "card_claim",
  "Take a todo card",
  `Work threads: take a todo card into this thread to reuse your context. It must run on your model and project, not be blocked by work outside this thread or kept for another work thread, and you can carry at most ${MAX_BATCH} cards. The card moves to working on this thread; you get its task back.`,
  { card: CardRef },
  { card: Record, brief: Schema.String },
  { readonly: false },
);

const CardNext = tool(
  "card_next",
  "Related cards to take next",
  "Work threads: the cards you carry, and related todo cards you could take (same group, blocking or blocked, same PR or Linear issue), each with why, the one to take first on top. Use after a card moves on, before you stop; take one with card_claim or just end.",
  {},
  { carrying: Records, candidates: Records, holdsSlot: Schema.Boolean },
  { readonly: true },
);

const CardEdit = tool(
  "card_edit",
  "Edit a card",
  "Evaluators: change any card field. Links are added by URL and removeLinks takes them off by URL (both in one call replace a link); blockedBy replaces the list.",
  {
    card: CardRef,
    title: Schema.optional(Schema.String),
    description: Schema.optional(Schema.String),
    prompt: Schema.optional(Schema.String),
    priority: Schema.optional(
      describe(
        KanbanPriority,
        "1 (urgent) to 4 (low). 5 is the backlog: never picked up, and a card with a thread is paused. Only when the owner asks.",
      ),
    ),
    goalId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
    projects: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
    model: Schema.optional(ModelInput),
    models: Schema.optional(WeightedModels),
    projectId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
    links: Schema.optional(Schema.Array(LinkInput)),
    removeLinks: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
    blockedBy: Schema.optional(Schema.Array(CardRef)),
    reviewChain: Schema.optional(Schema.NullOr(Schema.String)),
    subtasks: Schema.optional(SubtasksInput),
    comment: Schema.optional(Schema.String),
  },
  { card: Record },
  { readonly: false },
);

const SubtaskDone = tool(
  "subtask_done",
  "Mark a subtask",
  "Mark a card subtask done (with a short note on what was done) or skipped (with why). Workers mark the worker's subtasks of their own card, in the step the card is on; the review's are ticked when it passes. Evaluators mark any, and can set one open again. Doing a subtask follows the board's other rules: a message that needs the owner's approval still goes to him first, and the subtask stays open until it's sent.",
  {
    card: Schema.optional(CardRef),
    subtask: describe(TrimmedNonEmptyString, "Subtask id, e.g. s2."),
    state: Schema.Literals(["done", "skipped", "open"]),
    note: Schema.optional(Schema.String),
  },
  { card: Record },
  { readonly: false },
);

const CardThread = tool(
  "card_thread",
  "Steer, stop, wake or reset a card thread",
  "Evaluators: steer the card's live thread with text, stop it (the card keeps its place; move it if needed), wake its last work thread with text, or reset it: the card drops its threads and its next run starts on a fresh one, with text as a note for it.",
  {
    card: CardRef,
    action: Schema.Literals(["steer", "stop", "wake", "reset"]),
    text: Schema.optional(Schema.String),
  },
  { card: Record },
  { readonly: false, destructive: true },
);

const PoolSet = tool(
  "pool_set",
  "Set a model pool",
  "Evaluators: how many threads may run at once on a model at one level; a model or level with no pool yet gets one. Only models in the composer's list (orchestrator_capabilities). Name the variant when the model has pools at several levels. To change a pool's level, pass its key as replaces. Lowering never stops running threads by itself.",
  {
    model: ModelInput,
    slots: Schema.optional(NonNegativeInt),
    replaces: Schema.optional(
      describe(
        TrimmedNonEmptyString,
        "Key of the pool to move to this model's level (board_get pools); its open cards follow. Leave out slots to keep its count.",
      ),
    ),
  },
  { pools: Records },
  { readonly: false },
);

const PoolRemove = tool(
  "pool_remove",
  "Remove a model pool",
  "Evaluators: drop a pool at 0 slots that nothing on the board uses. Name the variant when the model has pools at several levels.",
  { model: ModelInput },
  { pools: Records },
  { readonly: false, destructive: true },
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
        name: RawBoardText,
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
  { title: RawBoardText, ...BlocksInput },
  { discussion: Record },
  { readonly: false },
);

const WikiWrite = tool(
  "wiki_write",
  "Write a wiki page",
  "Evaluators: create or replace a wiki page of lessons future threads should know.",
  { slug: TrimmedNonEmptyString, title: RawBoardText, body: Schema.String },
  { page: Record },
  { readonly: false },
);

const BoardOpen = tool(
  "board_open",
  "Open a Missions board",
  "Create a board (or return the existing one with this slug). projectId is the T3 project its threads run in. icon is shown beside its name; it is set only while the board has none, so the owner's pick stays.",
  {
    slug: TrimmedNonEmptyString,
    name: RawBoardText,
    projectId: Schema.optional(TrimmedNonEmptyString),
    icon: Schema.optional(KanbanBoardIcon),
  },
  { board: Record },
  { readonly: false },
);

const EvaluatorStart = tool(
  "evaluator_start",
  "Start an evaluator",
  "Start an evaluator thread on a board for a job: setup or request (text required), or a sweep: stalled, completed, deployed, check (optional text is added to its brief). A board runs one sweep of each kind at a time; starting another while one runs fails and names it. To give one card or job to a new evaluator, use kind request with text. Card threads may start only kind request (for example to hand a broken tool to the Robob board); their text is stamped with their board, card and thread.",
  {
    boardId: TrimmedNonEmptyString,
    kind: Schema.Literals(["setup", "request", "stalled", "completed", "deployed", "check"]),
    text: Schema.optional(Schema.String),
    /** For setup: an existing discussion on this board to use as the Setup discussion. */
    discussionId: Schema.optional(TrimmedNonEmptyString),
  },
  { threadId: TrimmedNonEmptyString },
  { readonly: false },
);

const SetupDone = tool(
  "setup_done",
  "End board setup",
  "Only the board's setup evaluator calls this, once the board's wiki and setup are complete. It lifts the setup hold: card work and review resume, and one line is posted in the Setup discussion.",
  {},
  { board: Record },
  { readonly: false },
);

const BoardPause = tool(
  "board_pause",
  "Pause or resume a board",
  "Evaluators: pause the whole board or lift it. While paused, the dispatcher starts no card work or review except the kept cards (keep: #numbers). Threads already running keep running; stop them with card_thread stop if they must stop now. clear:true lifts it. Use this instead of per-card stalled flags.",
  {
    boardId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
    keep: Schema.optional(Schema.NullOr(Schema.Array(TrimmedNonEmptyString))),
    reason: Schema.optional(Schema.NullOr(Schema.String)),
    clear: Schema.optional(Schema.NullOr(Schema.Boolean)),
  },
  { board: Record },
  { readonly: false },
);

export const KanbanToolkit = Toolkit.make(
  SetupDone,
  BoardPause,
  BoardGet,
  CardSearch,
  CardGet,
  CardUpdate,
  CardMove,
  CardAsk,
  CardAskChange,
  CardFlag,
  CardReviewResult,
  DiscussionPost,
  DiscussionRead,
  WikiRead,
  CardCreate,
  CardClaim,
  CardNext,
  CardEdit,
  SubtaskDone,
  CardThread,
  PoolSet,
  PoolRemove,
  GoalSet,
  GroupSet,
  DiscussionCreate,
  WikiWrite,
  BoardOpen,
  EvaluatorStart,
);
