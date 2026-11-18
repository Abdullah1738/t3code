/**
 * Missions board tools for agent threads. Who may do what comes from the
 * calling thread's board link: a card's work or review thread acts on its own
 * card; an evaluator acts on the whole board. The service enforces the moves.
 */
import {
  CARD_ASK_TOOL_DESCRIPTION,
  IsoDateTime,
  KanbanBlockInput,
  KanbanNightlyReviewTime,
  KanbanNightlyReviewTimeZone,
  KanbanBoardIcon,
  KanbanPriority,
  KanbanStage,
  KanbanMoveOptions,
  KanbanWaitKind,
  NonNegativeInt,
  OrchestratorMcpFailure,
  PositiveInt,
  ProviderOptionSelection,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { ExactEdits } from "../engine/exactEdits.ts";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";

import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import { KanbanService } from "../engine/KanbanService.ts";
import { ASK_LIMITS } from "../engine/asks.ts";
import { MAX_SUBTASKS, MAX_TEXT } from "../engine/subtasks.ts";
import { MAX_BATCH } from "../engine/rules.ts";
import { WAITS_ENGINE_WIRED } from "../engine/waits.ts";

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

const BoardRef = Schema.optional(
  describe(
    TrimmedNonEmptyString,
    "Board id or slug; defaults to this thread's board, its parent's for a delegated child, or an unambiguous card/discussion reference",
  ),
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
      "Provider options. Standard mode only: serviceTier default, fastMode false.",
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
        describe(
          TrimmedNonEmptyString,
          "Existing s<N> id from card_get. Listed alone it keeps that subtask as it is. An s<N> id the card does not have yet creates a new subtask with that id (text and owner required); omit id to let the board number a new subtask.",
        ),
      ),
      step: Schema.optional(
        describe(
          PositiveInt,
          "Subtasks with the same step go in any order. Leave out to keep an existing id's step, or for the step after the previous entry on a new subtask. Done and skipped subtasks keep their step.",
        ),
      ),
      text: Schema.optional(
        describe(
          RawBoardText.check(Schema.isMaxLength(MAX_TEXT)),
          `Subtask text, at most ${MAX_TEXT} characters. Required for a new subtask; for an existing open id, sent text replaces it. Done and skipped subtasks keep their text.`,
        ),
      ),
      owner: Schema.optional(
        describe(
          Schema.Literals(["work", "review", "evaluator", "script"]),
          "Who does it: the worker, the reviewer (ticked when the review passes), an evaluator, or a board script (the script ticks it from its output; the evaluator hears about it only if the script hands it back). Required for a new subtask; omitted on an existing open id, keeps its owner. Done and skipped subtasks keep their owner.",
        ),
      ),
      gate: Schema.optional(Schema.NullOr(Schema.Literals(["deploy", "money", "secret"]))),
      clearGate: Schema.optional(
        describe(
          TrimmedNonEmptyString,
          "Evaluators: remove a gate the board guessed on this existing subtask, with the reason it is wrong. Abdullah gets a notice. A gate set on purpose can't be cleared this way; ask him naming the subtask id.",
        ),
      ),
      interrupting: Schema.optional(
        describe(
          Schema.Boolean,
          "Evaluator only: set on the install or restart subtask that interrupts running work; omit to preserve, false clears.",
        ),
      ),
      service: Schema.optional(
        describe(
          Schema.NullOr(Schema.String),
          "Evaluator only: the service this step restarts, e.g. robob-watch, agent-bridges, telegram-bridge, robob; the 4 h release window is counted per service across all boards. Omit to preserve; null clears. Requires interrupting: true.",
        ),
      ),
      ownerOnly: Schema.optional(
        describe(
          Schema.Boolean,
          "Evaluator only: set on steps the board keeps with the owner (Robob/OpenCode restarts from tool boards, sudo/macOS, rule or prompt changes). Omit to preserve; false clears.",
        ),
      ),
      script: Schema.optional(
        describe(
          TrimmedNonEmptyString,
          "For a script's subtask: the name of the board script that does it. Left out on a new or edited entry, any script on the board can. An id alone keeps its stored binding; done and skipped subtasks keep theirs.",
        ),
      ),
      holdsDependents: Schema.optional(
        describe(
          Schema.Boolean,
          "true on the step that lands the work where dependents need it (merge, land, fast-forward, push): a Completed card's dependents wait until it's done. false: never holds. Left out: guessed from the text (merge/land/fast-forward).",
        ),
      ),
    }),
  ).check(Schema.isMaxLength(MAX_SUBTASKS)),
  `At most ${MAX_SUBTASKS} subtasks, each at most ${MAX_TEXT} characters. The card's plan, in order: the work, its review and everything after (merge, deploy, telling whoever asked, updating tickets, a read-back). Leave out steps that aren't needed. On card_edit it replaces the plan: list existing ids to keep them (an id alone keeps it unchanged; done and skipped ones can't be rewritten), add new entries without an id or with a new s<N> id; open ones left out go, done ones stay.`,
);

const LinkInput = Schema.Struct({
  url: TrimmedNonEmptyString,
  label: Schema.optional(Schema.String),
});

const BLOCKS_DESCRIPTION =
  'Each block is an object whose `_tag` field names its kind (all shown keys are required, even where null is allowed): md {text}, collapse {title, text}, html {html, title: string|null, height: positive integer|null}, image {url, alt: string|null}, attachment {attachment: {type: "image"|"file", id, name, mimeType, sizeBytes}}, card {cardId}; attachment id comes from t3_attachment_prepare_upload. Example: [{"_tag":"md","text":"Line count went from 120 to 4"},{"_tag":"image","url":"https://example.com/proof.png","alt":"Result"}]';

const BlocksInput = {
  text: Schema.optional(describe(Schema.String, "Markdown message (shortcut for one md block).")),
  blocks: Schema.optional(
    describe(
      Schema.Array(KanbanBlockInput),
      `${BLOCKS_DESCRIPTION} Also accepts choice {id, style: "poll"|"pick", question, options: [{id, label}], multi}.`,
    ),
  ),
};

// MCP supplies its own decode options and strips excess keys before handlers run.
// Keep the declared keys at registration so the raw payload can be checked first.
export class KanbanArgumentKeys extends Context.Service<
  KanbanArgumentKeys,
  ReadonlyArray<string>
>()("t3/ardud/kanban/tools/tools/KanbanArgumentKeys") {}

export const argumentFailure = (name: string, allowed: ReadonlyArray<string>, input: unknown) => {
  if (typeof input !== "object" || input === null) return;
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length === 0) return;
  const hint =
    allowed.includes("card") &&
    unknown.some((key) => ["id", "cardId", "card_id", "number", "cardNumber"].includes(key))
      ? ' Did you mean "card"? Pass card: "<card id>" or "#4421".'
      : "";
  return new OrchestratorMcpFailure({
    code: "invalid_request",
    reason: "invalid_args",
    message: `${name} has no argument${unknown.length === 1 ? "" : "s"} ${unknown.map((key) => JSON.stringify(key)).join(", ")}. Allowed: ${allowed.join(", ") || "(none)"}.${hint}`,
  });
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
    .annotate(KanbanArgumentKeys, Object.keys(parameters))
    .annotate(Tool.Title, title)
    .annotate(Tool.Readonly, flags.readonly)
    .annotate(Tool.Destructive, flags.destructive ?? false)
    .annotate(Tool.Idempotent, flags.readonly)
    .annotate(Tool.OpenWorld, false);

const BoardGet = tool(
  "board_get",
  "Read the board",
  "Compact Missions board: settings/instructions, goals, pools, groups, live thread states, unread counts and a page of card number/title/stage/owner/model/short status. No card descriptions, prompts, event histories, goal stories or wiki bodies; use card_get and wiki_read for detail. Default 200 cards, max 500. Every page stays under 50,000 characters and can hold fewer cards than limit when rows are large; follow board.page.nextAfter with after while hasMore. With since, only cards active since then (an event, or an open or touched ask), one short row each: stage changes, review verdicts, run failures, stall, asks with asked/answered times; no settings, groups or unread. boardId defaults to the board identified by this thread; when ambiguous, pass one of the candidate board ids in the error.",
  {
    boardId: BoardRef,
    after: Schema.optional(
      describe(NonNegativeInt, "Cards numbered after this cursor (default 0)."),
    ),
    limit: Schema.optional(describe(PositiveInt, "Page size, default 200, capped at 500.")),
    since: Schema.optional(
      describe(
        TrimmedNonEmptyString,
        "ISO time or relative (now, now-24h, 24h, 90m, 2d), at most 72 hours ago: only cards active since then, as short rows. Times are UTC; give a Z or offset for ISO times.",
      ),
    ),
  },
  { board: Record, prompts: Schema.String },
  { readonly: true },
);

const BoardActivity = tool(
  "board_activity",
  "Board activity rollup",
  "A board's activity in a window (default the last 24 hours, at most 72; since/until accept ISO timestamps or relative times now-24h, 24h, 3d): asks answered in the window with asked/answered times and minutes to answer (p50/p90/max), open counts asks that need an answer; open notices are counted in openNotices. Answer times are also split by kind (missing kind is question) and blocking, with separate counts for decisions and notices open over 6 hours; review rounds and verdicts per card, hours in each stage with dwell median/p95/max and the longest spans, open cards in one stage over 24 hours, stalls by kind and how long they lasted (byKind counts; idle_evaluator includes currently idle completed/deployed evaluator steps with card, stage, step, openEvaluatorSubtasks, idleHours, lastEventAt and evaluatorThreadAlive, even before a flag), run failures by kind and model plus newest-first failures.rows (at most 50, more gives omitted count) with card number, kind, role, pool, threadId, runId, time, reason, repeat count and structured restart-admission wait/queue/rule when available; restartAdmission points to the server-wide analytics_read rollup by UTC day (read section restartAdmission without board/card/kind filters), with this board's failed card numbers; threads started, restarts and evaluator starts (new threads; evaluatorWakes is a compatibility alias), cards left in working or in_review with no thread, and an estimate of pool slots held per hour per model next to each pool's slots. withoutThread adds reason, hours and byReason counts: wait:<kind>, owner_ask, blocked, backlog, paused, evaluator_step, stalled:<kind>, or none (stuck); expired waits carry expiredWait and none has its own capped list. pool_full is reported only for queued cards. Queued todo/needs_review cards include why they wait (pool full with rank, cards ahead and slot holders, blocked, waiting, and other dispatch gates), plus those queued over 6 hours. The holders section lists current slot holders per pool, with stage, held time and open-step owner (at most 50 per pool). Without digest, card numbers only, no titles or text. Read from the cards' stored history. Lists are shortened to fit 50,000 characters and say how many more; answeredItems stays an array, with answeredItemsMore when some are omitted; an oversized kind breakdown reports omitted groups in answerMinutesByKindMore. digest: 'discussions' or 'threads' pages one short row per discussion or card thread active in the window (owner messages, open asks, last message; thread flags); follow page.nextAfter while hasMore. A discussion with too many owner messages continues at ownerMessagesOffset on the next page; count its discussionId once.",
  {
    boardId: BoardRef,
    since: Schema.optional(
      describe(
        TrimmedNonEmptyString,
        "ISO or relative start (now, now-24h, 24h, 90m, 2d); default 24 hours before until. Times are UTC; give a Z or offset for ISO times.",
      ),
    ),
    digest: Schema.optional(Schema.Literals(["discussions", "threads"])),
    after: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    until: Schema.optional(
      describe(
        TrimmedNonEmptyString,
        "ISO or relative end (now, now-24h, 24h, 90m, 2d); default now. Relative times count back from the server clock. Times are UTC; give a Z or offset for ISO times.",
      ),
    ),
  },
  { activity: Record },
  { readonly: true },
);

const CardSearch = tool(
  "card_search",
  "Search cards",
  "Find cards on a board by words in their title, description, prompt or links, or by #number. Settled cards are left out unless includeSettled. Returns short rows, newest first; read one in full with card_get.",
  {
    boardId: BoardRef,
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
  'One card with its latest 20 events (moves, edits, comments, review verdicts), eventsTotal, a cursor for older ones (olderEvents) and every thread it has had. Pass events {before: olderEvents, limit} to page back, or "all" for every event (it can be more than your client accepts). With before, the reply carries only the card\'s id, number, title, stage and boardId, without the full card or threads. Pages leave out oldest events to fit 60,000 characters; a full card and threads can exceed this on the first read. A single oversized event is skipped with a note; "all" returns it. Follow olderEvents until null, even after an empty page. card accepts an id or #number; omit it for your own card.',
  {
    card: Schema.optional(CardRef),
    boardId: BoardRef,
    events: Schema.optional(
      Schema.Union([
        Schema.Literal("all"),
        Schema.Struct({
          before: Schema.optional(
            describe(PositiveInt, "Only events older than this (olderEvents from the last read)."),
          ),
          limit: Schema.optional(describe(PositiveInt, "Events per page, default 20, max 200.")),
        }),
      ]),
    ),
  },
  {
    card: describe(
      Record,
      "Full card on the first read; only id, number, title, stage and boardId with events.before.",
    ),
    events: Records,
    threads: Schema.optional(Records),
    eventsTotal: NonNegativeInt,
    olderEvents: Schema.NullOr(NonNegativeInt),
    note: Schema.optional(Schema.String),
  },
  { readonly: true },
);

const CardUpdate = tool(
  "card_update",
  "Update your card",
  "Work threads may update only their assigned cards; evaluators use card_edit. Change the card description, attach links (PRs, Linear, any URL; added by URL, existing links stay) or add a comment. Attach every PR before moving to needs_review and link it to your thread (link_pull_request): the card completes only when your thread's PRs are merged or closed. A PR link your thread didn't link is context and doesn't hold the card. If it fails with 'Board busy' or 'Not saved', nothing was saved and the same call can be repeated; an identical repeat within 10 minutes is not saved twice. card accepts an id or #number; omit it for your own card.",
  {
    boardId: BoardRef,
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
  "Work threads may move only their assigned cards; review threads use card_review_result. Evaluators change card fields with card_edit. Work thread: move your card to needs_review when the work is done (a reviewer starts), including from todo when you are its own work thread and no thread is attached, or to needs_owner with the question when you need the owner. Evaluators: any stage except working and in_review, which the dispatcher owns; completed and deployed only once the card's review passed. A move clears its wait unless keepWait is true or it moves to completed/deployed with open evaluator/script subtasks; the result reports keep/clear. card accepts an id or #number; omit it for your own card.",
  {
    boardId: BoardRef,
    card: Schema.optional(CardRef),
    to: KanbanStage,
    keepWait: KanbanMoveOptions.fields.keepWait,
    note: Schema.optional(describe(Schema.String, "One line for the card history.")),
    question: Schema.optional(
      describe(Schema.String, "Required for needs_owner: what the owner must decide."),
    ),
  },
  { card: Record, message: Schema.optional(Schema.String) },
  { readonly: false },
);

const AskFormat = Schema.Literals(["markdown", "text"]);

const AskChangeInput = Schema.Struct({
  label: Schema.String,
  before: Schema.String,
  after: Schema.String,
  format: Schema.optional(AskFormat),
});

const AskFieldInput = Schema.Struct({
  id: Schema.optional(Schema.String),
  label: Schema.String,
  type: Schema.optional(Schema.String),
  required: Schema.optional(Schema.Boolean),
  hint: Schema.optional(Schema.String),
  default: Schema.optional(Schema.Json),
  unit: Schema.optional(Schema.String),
  min: Schema.optional(Schema.Finite),
  max: Schema.optional(Schema.Finite),
  options: Schema.optional(
    Schema.Array(
      Schema.Union([
        Schema.String,
        Schema.Struct({ id: Schema.optional(Schema.String), label: Schema.String }),
      ]),
    ),
  ),
  multi: Schema.optional(Schema.Boolean),
  accepts: Schema.optional(Schema.Array(Schema.String)),
  maxFiles: Schema.optional(Schema.Finite),
  block: Schema.optional(Schema.Finite),
});

export const AskRespondInput = Schema.Struct({
  verdict: Schema.optional(
    describe(
      Schema.Union([
        Schema.Boolean,
        Schema.Struct({
          approve: Schema.optional(Schema.String),
          reject: Schema.optional(Schema.String),
        }),
      ]),
      'true or an object with optional approve/reject (string button labels); false removes verdict buttons. Example: {"approve":"Deploy","reject":"Don\'t deploy"}.',
    ),
  ),
  choose: Schema.optional(
    describe(
      Schema.Union([
        Schema.Boolean,
        Schema.Struct({
          multi: Schema.optional(Schema.Boolean),
          min: Schema.optional(Schema.Finite),
          max: Schema.optional(Schema.Finite),
        }),
      ]),
      'true or an object with optional multi (boolean), min/max (numbers) for picks from options; false removes picks. Example: {"multi":true,"min":1,"max":2}.',
    ),
  ),
  fields: Schema.optional(
    describe(
      Schema.Array(AskFieldInput),
      `A list of at most ${ASK_LIMITS.fields} objects with label (string), optional id/hint/unit (strings), type (text, longtext, number, date, datetime, toggle, select, rank, file, custom or secret), required/multi (booleans), default (JSON), min/max/maxFiles/block (numbers), accepts (list of strings) and options (list of strings or {id?: string, label: string}); custom uses block as the html block index, secret returns a one-use secretRef (24h, this thread only), and file returns a path. Example: [{"id":"reason","label":"Reason","type":"text","required":true},{"id":"scope","label":"Scope","type":"select","options":["Dev",{"id":"prod","label":"Production"}]}].`,
    ),
  ),
  edit: Schema.optional(
    describe(
      Schema.Union([Schema.Boolean, Schema.String]),
      'true or "draft" to edit the draft; requires draft, and false removes editing. Example: "draft".',
    ),
  ),
  task: Schema.optional(
    describe(
      Schema.Struct({
        steps: Schema.optional(
          Schema.Array(
            Schema.Union([
              Schema.String,
              Schema.Struct({ text: Schema.String, link: Schema.optional(Schema.String) }),
            ]),
          ),
        ),
        proof: Schema.optional(Schema.String),
      }),
      `An object with optional steps (at most ${ASK_LIMITS.taskSteps} strings or {text: string, link?: string}) and proof (id of a required response field); he answers done or couldn't. Example: {"steps":["Check CI",{"text":"Review","link":"https://example.com/pr"}],"proof":"reason"}.`,
    ),
  ),
  ack: Schema.optional(
    describe(
      Schema.Boolean,
      "true makes a notice with no other response parts; it cannot block. Example: true.",
    ),
  ),
});

const ASK_ACTION_DESCRIPTION = `An object with summary (string), optional command/target/undo/then (strings), and evidence (a list of strings, at most ${ASK_LIMITS.evidence}, each at most ${ASK_LIMITS.evidenceLine} characters); then says what you do once it is done. Example: {"summary":"Merge PR #512","evidence":["CI green on abc123","review passed"]}.`;

/** What an asker writes on an ask beyond the question; card_ask_change edits the same fields. */
const AskFieldsInput = {
  kind: Schema.optional(
    describe(
      Schema.String,
      "A label for the layout: question, decision, draft, action, change, input, file, task, signoff, notice, rank, or your own short word. Left out: taken from what you pass. signoff, notice, task, file and rank also set what he gives back (see respond).",
    ),
  ),
  title: Schema.optional(describe(Schema.String, "One short line saying what you ask.")),
  context: Schema.optional(
    describe(
      Schema.String,
      "Markdown: why you ask and what he must know to answer without opening the card.",
    ),
  ),
  options: Schema.optional(
    describe(
      Schema.Array(
        Schema.Union([
          Schema.String,
          Schema.Struct({
            id: Schema.optional(Schema.String),
            label: Schema.String,
            detail: Schema.optional(Schema.String),
            recommended: Schema.optional(Schema.Boolean),
            approves: Schema.optional(Schema.Array(Schema.String)),
            consequence: Schema.optional(Schema.String),
            block: Schema.optional(Schema.Finite),
          }),
        ]),
      ),
      `A list of at most ${ASK_LIMITS.options} strings or objects with label (string), optional id/detail/consequence (strings), recommended (boolean), approves (list of existing subtask ids), and block (index of an existing block); with kind rank these are the items to order. Example: [{"id":"merge","label":"Merge","detail":"CI passed","recommended":true,"consequence":"Ships next release"}].`,
    ),
  ),
  multi: Schema.optional(
    describe(Schema.Boolean, "With options: he may tick several. Default: one pick."),
  ),
  draft: Schema.optional(
    describe(
      Schema.Struct({
        text: Schema.String,
        format: Schema.optional(AskFormat),
        target: Schema.optional(Schema.String),
      }),
      'An object with text (string), optional format ("markdown" or "text") and target (string) for the exact text to post or send. Example: {"text":"Ready to merge.","format":"markdown","target":"comment on PR #512"}.',
    ),
  ),
  action: Schema.optional(
    describe(
      Schema.Struct({
        summary: Schema.String,
        command: Schema.optional(Schema.String),
        target: Schema.optional(Schema.String),
        evidence: Schema.optional(Schema.Array(Schema.String)),
        undo: Schema.optional(Schema.String),
        then: Schema.optional(Schema.String),
      }),
      ASK_ACTION_DESCRIPTION,
    ),
  ),
  change: Schema.optional(
    describe(
      AskChangeInput,
      'An object with label, before and after (strings) for a text being replaced, plus optional format ("markdown" or "text"). Example: {"label":"Tool description","before":"Old text","after":"New text","format":"text"}.',
    ),
  ),
  changes: Schema.optional(
    describe(
      Schema.Array(AskChangeInput),
      `A list of at most ${ASK_LIMITS.changes} change objects, each with label/before/after (strings) and optional format ("markdown" or "text"). Example: [{"label":"Tool description","before":"Old text","after":"New text"}].`,
    ),
  ),
  respond: Schema.optional(
    describe(
      AskRespondInput,
      `An object adding response parts to those implied by the ask (draft: edit + verdict, action/change: verdict, options: choose, bare question: free text); verdict, choose and edit accept false to remove that part, choose needs options, and edit needs a draft. Shapes (combine only the parts you need): {"verdict":{"approve":"Deploy","reject":"Don't deploy"},"choose":{"multi":false,"min":1,"max":1},"fields":[{"id":"reason","label":"Reason","type":"text"}],"edit":true,"task":{"steps":["Check CI",{"text":"Review","link":"https://example.com/pr"}],"proof":"reason"},"ack":false}; verdict also accepts true; Example: {"verdict":true}.`,
    ),
  ),
  to: Schema.optional(
    describe(
      Schema.Literals(["owner", "evaluator"]),
      "Who answers: the owner (default), or the board evaluator for something it can decide for him (work threads only).",
    ),
  ),
  basis: Schema.optional(
    describe(Schema.String, "The facts the ask rests on, e.g. a head commit or a version."),
  ),
  expiresAt: Schema.optional(
    describe(Schema.String, "ISO time after which the ask is stale and can't be answered."),
  ),
  batchKey: Schema.optional(
    describe(
      Schema.String,
      'Same key = same shape of ask on this board; he can answer them together (e.g. "deploy-go").',
    ),
  ),
  blocks: Schema.optional(
    describe(
      Schema.Array(KanbanBlockInput),
      `Evidence shown inside the ask, in order (at most ${ASK_LIMITS.blocks}, ${ASK_LIMITS.attachments} of them images or files); each image needs non-empty alt text, and answers go in options rather than choice blocks. ${BLOCKS_DESCRIPTION}`,
    ),
  ),
};

const AskActionInput = AskFieldsInput.action;

const CardAsk = tool(
  "card_ask",
  "Ask the owner",
  CARD_ASK_TOOL_DESCRIPTION,
  {
    boardId: BoardRef,
    card: Schema.optional(CardRef),
    question: describe(Schema.String, "The question itself, one or two sentences."),
    blocking: Schema.optional(Schema.Boolean),
    ...AskFieldsInput,
  },
  { card: Record, warning: Schema.optional(Schema.String), note: Schema.optional(Schema.String) },
  { readonly: false },
);

const CardAskChange = tool(
  "card_ask_change",
  "Change an open ask",
  'Change an open ask (q1, q2... on the card). Pass the fields to replace (question, title, context, options, draft, action, changes, respond...) with revisionNote saying what changed: he sees it as updated and it is his turn again. blocks replaces the evidence shown with it ([] removes it). Do this when he replied that the ask was unclear. Or pass action: "block" makes an async ask blocking, "drop" removes one no longer needed, "return" (evaluators) gives an ask that is with you back to him. A work thread changes only its own card\'s asks; while no thread is attached, its own work thread may block or drop asks in todo (blocking moves the card to Needs Owner) and needs_owner. card accepts an id or #number; omit it for your own card.',
  {
    boardId: BoardRef,
    card: Schema.optional(CardRef),
    ask: Schema.String,
    question: Schema.optional(Schema.String),
    blocking: Schema.optional(
      describe(
        Schema.Boolean,
        "true makes an async ask blocking. false is accepted only on an ask that is already async (no change); a blocking ask can't be made async.",
      ),
    ),
    revisionNote: Schema.optional(describe(Schema.String, "One line: what you changed and why.")),
    ...AskFieldsInput,
    action: Schema.optional(
      describe(
        Schema.Union([
          Schema.Literals(["block", "drop", "return"]),
          ...AskActionInput.schema.members,
        ]),
        `An operation ("block", "drop" or "return"), or a new action body. ${ASK_ACTION_DESCRIPTION}`,
      ),
    ),
  },
  { card: Record, warning: Schema.optional(Schema.String), note: Schema.optional(Schema.String) },
  { readonly: false },
);

const CardAskAnswer = tool(
  "card_ask_answer",
  "Decide a handed ask",
  'Evaluators only: decide an ask that is with you (the owner handed it over, or it was asked to you; you are told either way). Whoever asked hears it as the answer, marked as decided by you for him. If only he can decide, give it to him with card_ask_change action "return" instead. card accepts an id or #number; omit it for your own card.',
  {
    card: Schema.optional(CardRef),
    ask: Schema.String,
    verdict: describe(
      Schema.String,
      "What the ask takes (you are told which): approved / rejected; picked with optionIds; answered with text or values; done / cant for a task; acknowledged for a notice.",
    ),
    optionIds: Schema.optional(Schema.Array(Schema.String)),
    text: Schema.optional(describe(Schema.String, "The answer in your own words.")),
    values: Schema.optional(
      describe(
        Schema.Record(Schema.String, Schema.Json),
        "For an ask with fields: field id to value (a number, true/false, an option id, a list of ids in order).",
      ),
    ),
    note: Schema.optional(describe(Schema.String, "What whoever acts on it must know first.")),
    finalDraft: Schema.optional(
      describe(Schema.String, "A draft ask: the text to post, when you changed the draft."),
    ),
    revision: Schema.optional(
      describe(
        Schema.Int,
        "The ask's revision as you read it (you are told it; card_get shows it). Needed for every ask but a plain question; an ask edited since is refused.",
      ),
    ),
  },
  { card: Record },
  { readonly: false },
);

const CardFlag = tool(
  "card_flag",
  "Flag a card stalled",
  "Mark a card stalled with the reason (missing access, broken environment, waiting on something outside the board), or clear the flag with stalled false. A stalled card gives up its slot and returns from work or review to its queue. card accepts an id or #number; omit it for your own card.",
  {
    boardId: BoardRef,
    card: Schema.optional(CardRef),
    stalled: Schema.Boolean,
    reason: Schema.optional(Schema.String),
  },
  { card: Record },
  { readonly: false },
);

const BoardStandingApproval = tool(
  "board_standing_approval",
  "Standing deploy approval",
  "Evaluators only: grant a board standing deploy approval from a closed owner-approved ask naming every requested board slug. The ask may be on any board (use its card id). Quote the owner's words and source thread/time. Replaces active records, retaining history. Any evaluator can revoke with a reason. Returns open release asks to drop with card_ask_change; never answers them. Money, secret and ownerOnly steps still need on-card approval. card accepts an id or #number; omit it for your own card.",
  {
    boardId: BoardRef,
    action: Schema.Literals(["grant", "revoke"]),
    boards: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
    quote: Schema.optional(TrimmedNonEmptyString),
    sourceThreadId: Schema.optional(TrimmedNonEmptyString),
    saidAt: Schema.optional(IsoDateTime),
    card: Schema.optional(CardRef),
    ask: Schema.optional(TrimmedNonEmptyString),
    id: Schema.optional(TrimmedNonEmptyString),
    reason: Schema.optional(TrimmedNonEmptyString),
  },
  { boards: Records, openReleaseAsks: Records },
  { readonly: false },
);

const CardWait = tool(
  "card_wait",
  "Say what a card waits on",
  "Set the one thing a card waits for, as data the board shows and checks, instead of writing \"waiting for the dev to push\" in a comment, a subtask or a stalled flag. on: push (new commits on pr; the reviewed commit is taken from the card's last review unless you pass head), merge (pr merged), ci (checks on pr finish), card (waitsOn is done), time (until passes), owner_go (the owner answers open question ask; ask it first with card_ask, and use a blocking card_ask instead when nothing can go on without him). When none of those fit (a Linear issue reaching a state, a deploy landing, a reply from a person), a board script can be the check: on script with script, the name of an enabled script on this board, and args for what it should look at. pr must be a PR link on the card: attach a parent or base PR with links first. One wait per card: a new one replaces the old, and takes over a stalled flag you could clear. When it ends the board clears it, logs why and wakes whoever acts next in the card's stage (wakeRole to choose; new commits on a card in review wake its reviewer for a fresh review); a wait that outlasts its limit (push 3d, merge 2d, ci 3h, card 7d, script 7d, owner_go 2d, or your until) shows the card as stuck. Several things to wait for: set the first, set the next when woken. clear:true removes it. Card threads use it on their own cards only. A worker in Working can park its own card while running with on: time (until required, at most 24 hours ahead), script, or card. Set it as your last act and end the turn; it survives turn end. Clear it if a durable watcher, offbox result or another wake reaches you first. Workers cannot use push, merge, ci or owner_go while Working: use watch_pull_request for PR waits, or card_ask for the owner's answer." +
    (WAITS_ENGINE_WIRED
      ? ""
      : " Not live yet: the wait is saved and shown, but the board does not end it or wake anyone until its tick checks waits, so keep your own check; it is accepted on cards in in_review, completed, deployed and needs_owner.") +
    " card accepts an id or #number; omit it for your own card.",
  {
    card: Schema.optional(CardRef),
    on: Schema.optional(describe(KanbanWaitKind, "What it waits on. Required unless clear.")),
    note: Schema.optional(
      describe(
        Schema.String,
        "One line: what exactly is awaited and from whom. Required unless clear.",
      ),
    ),
    pr: Schema.optional(
      describe(
        TrimmedNonEmptyString,
        'push, merge, ci: the pull request, by URL, "#544" or "trading-core#544". Left out when the card has one PR.',
      ),
    ),
    waitsOn: Schema.optional(describe(CardRef, "card: the card that has to be done first.")),
    ask: Schema.optional(
      describe(TrimmedNonEmptyString, "owner_go: the open question's id, e.g. q2."),
    ),
    until: Schema.optional(
      describe(
        TrimmedNonEmptyString,
        "time: when it ends (ISO 8601, at most 24 hours ahead for a Working worker parking itself, otherwise 30 days). Other kinds: your own deadline, after which the card shows as stuck.",
      ),
    ),
    head: Schema.optional(
      describe(
        TrimmedNonEmptyString,
        "push: the commit you reviewed, when the card's last review didn't record it.",
      ),
    ),
    wakeRole: Schema.optional(
      describe(
        Schema.Literals(["work", "review", "evaluator"]),
        "Who is woken when it ends. Default: whoever acts next in the card's stage (the reviewer while its review is open, else the evaluator; the worker in To-Do).",
      ),
    ),
    script: Schema.optional(
      describe(
        TrimmedNonEmptyString,
        "script: the board script that checks the wait, by its exact name. It must be on this board and turned on.",
      ),
    ),
    args: Schema.optional(
      describe(
        Schema.Record(Schema.String, Schema.Unknown),
        'script: a small JSON object the check is given, e.g. {"issue":"ENG-123","state":"Done"}. everyMs sets how often it is checked (1 minute to 6 hours; 5 minutes when left out).',
      ),
    ),
    clear: Schema.optional(describe(Schema.Boolean, "Remove the card's wait. Nobody is woken.")),
  },
  { card: Record, note: Schema.optional(Schema.String) },
  { readonly: false },
);

const CardReviewResult = tool(
  "card_review_result",
  "Record the review verdict",
  "Review threads only, once per review step: clear (no findings) or findings (each a short, actionable line). Findings send the card back to its work thread; clear moves to the next review step or completes the review. After a connection error, an exact repeat of your latest verdict (same verdict, findings and head) within 10 minutes, if the card has not moved since, is acknowledged with a note naming the original review event; it is not saved again. Later calls from a thread not assigned to the current review step are refused with the stage and step; the verdict is not recorded.",
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
  { card: Record, recorded: Schema.Boolean, note: Schema.optional(Schema.String) },
  { readonly: false },
);

const DiscussionPost = tool(
  "discussion_post",
  "Post in a discussion",
  "Post a message in a discussion. Pass discussionId, or card for that card's discussion. Defaults to your card's discussion (card threads) or your own discussion (discussion evaluators). This is the only way the owner sees your replies. With ask (q1...), the message is a reply on that open ask of the card: the ask stays open and it is the owner's turn again. If it fails with 'Board busy' or 'Not saved', nothing was saved and the same call can be repeated; an identical repeat within 10 minutes is not saved twice. card accepts an id or #number; omit it for your own card.",
  {
    discussionId: Schema.optional(TrimmedNonEmptyString),
    boardId: BoardRef,
    card: Schema.optional(CardRef),
    ask: Schema.optional(
      describe(
        Schema.String,
        "An open ask on the card (q1, q2...) to reply on, without closing it.",
      ),
    ),
    ...BlocksInput,
  },
  { message: Record },
  { readonly: false },
);

const DiscussionRead = tool(
  "discussion_read",
  "Read a discussion",
  "Messages of a discussion, newest last, with answers to polls and picks: the latest ones (after afterSeq / before beforeSeq when given), up to 200 and about 1 MB, or with limit up to that many and about 50,000 characters. When older ones were left out, earlierBefore is set: read again with beforeSeq. seq reads one message in full. Defaults like discussion_post. card accepts an id or #number; omit it for your own card.",
  {
    discussionId: Schema.optional(TrimmedNonEmptyString),
    boardId: BoardRef,
    card: Schema.optional(CardRef),
    afterSeq: Schema.optional(NonNegativeInt),
    beforeSeq: Schema.optional(NonNegativeInt),
    limit: Schema.optional(
      describe(
        PositiveInt,
        "At most this many messages (max 200), within about 50,000 characters.",
      ),
    ),
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
  "The board's shared lessons. Without slug: a list of pages (slug, title, size); pass slug or slugs to read them. With slug, section reads the first matching ATX heading (case-insensitive) and its content through the next same-or-higher heading. outline: true returns heading lines with character offsets. Headings in code fences are ignored. section and outline require slug and cannot be combined.",
  {
    slug: Schema.optional(TrimmedNonEmptyString),
    slugs: Schema.optional(
      Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
    ),
    section: Schema.optional(TrimmedNonEmptyString),
    outline: Schema.optional(Schema.Boolean),
    boardId: BoardRef,
  },
  {
    pages: Records,
    index: Schema.optional(Records),
    missing: Schema.optional(Schema.Array(Schema.String)),
    hint: Schema.optional(Schema.String),
  },
  { readonly: true },
);

const GatedResult = {
  gated: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      gate: Schema.Literals(["deploy", "money", "secret"]),
      source: Schema.Literals(["guessed"]),
    }),
  ),
  message: Schema.optional(Schema.String),
};

const CardCreate = tool(
  "card_create",
  "Create a card",
  "Create a card in todo (the dispatcher starts it when a slot is free) or, for evaluators, needs_owner (with the question). Work threads create cards only on their own board. A card's work thread can pass assignToSelf to take the new card into its own run at once (same model pool; it shares the thread's slot; you get its task back as brief). A work thread's new cards keep the review chain of its card. The prompt is what the work thread gets; from an evaluator it is the packet (scope, files, steps, tests, when it's done). A card a thread makes without assignToSelf waits for an evaluator to write its packet. It isn't yours to change afterwards (card_update refuses it), so put every detail, evidence path and link in prompt, description and links when you create it. Title and description are written for you when left out. Refused when an open card on the board has the same title or the same source link (not card, PR or Linear links).",
  {
    boardId: BoardRef,
    prompt: Schema.String,
    assignToSelf: Schema.optional(
      describe(
        Schema.Boolean,
        "Work threads: take the card yourself now. It runs on your model and project.",
      ),
    ),
    forThread: Schema.optional(
      describe(
        TrimmedNonEmptyString,
        "Evaluators: give the new card to this existing work thread on the board (it keeps its context); no other thread can take it.",
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
  { card: Record, brief: Schema.optional(Schema.String), ...GatedResult },
  { readonly: false },
);

const CardClaim = tool(
  "card_claim",
  "Take a todo card",
  `Work threads: take a todo card into this thread to reuse your context. It must run on your model and project, not be blocked by work outside this thread or kept for another work thread, and you can carry at most ${MAX_BATCH} cards. The card moves to working on this thread; you get its task back.`,
  { boardId: BoardRef, card: CardRef },
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
  "Evaluators: change any card field. Links are added by URL and removeLinks takes them off by URL (both in one call replace a link); blockedBy replaces the list. Replacing prompt or subtasks requires basedOn from the updatedAt you read; on conflict, card_get again, merge, and retry. promptEdits / subtaskEdits: exact find-and-replace on the prompt / open subtask texts; each oldString must appear exactly count times (default 1) in the text as left by the edits before it; all apply or none do. Not with prompt / subtasks in the same call.",
  {
    boardId: BoardRef,
    card: CardRef,
    title: Schema.optional(Schema.String),
    description: Schema.optional(Schema.String),
    prompt: Schema.optional(Schema.String),
    promptEdits: Schema.optional(ExactEdits),
    subtaskEdits: Schema.optional(ExactEdits),
    basedOn: Schema.optional(
      describe(
        Schema.String,
        "updatedAt from your last card_get/card_create/card_edit result; required when replacing prompt or subtasks.",
      ),
    ),
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
  { card: Record, ...GatedResult },
  { readonly: false },
);

const SubtaskDone = tool(
  "subtask_done",
  "Mark a subtask",
  "Mark a card subtask done (with a short note on what was done) or skipped (with why). Workers mark the worker's subtasks of their own card, in the step the card is on; the review's are ticked when it passes. Evaluators mark any, and can set one open again. Doing a subtask follows the board's other rules: a message that needs the owner's approval still goes to him first, and the subtask stays open until it's sent. Unless standing deploy approval covers it, a gated subtask needs the owner's answer on an ask naming its id; a refusal says which ask is missing. With a standing approval live, keep deploy steps worded honestly; don't reword them to dodge the gate. Evaluators may skip a deploy-, money- or secret-gated evaluator or script step without the owner's answer when the note gives the reason (10–300 characters); Abdullah gets a notice, and marking it done still needs his OK. card accepts an id or #number; omit it for your own card.",
  {
    boardId: BoardRef,
    card: Schema.optional(CardRef),
    subtask: describe(
      TrimmedNonEmptyString,
      "Existing s<N> id from card_get, e.g. s2; do not invent ids.",
    ),
    state: Schema.Literals(["done", "skipped", "open"]),
    note: Schema.optional(Schema.String),
    releasedAt: Schema.optional(
      describe(
        IsoDateTime,
        "When the restart actually happened, for ticking a release after the fact; it records that time and does not start a new window; use it for any step that records a release that already happened, including a second card's step for the same release.",
      ),
    ),
  },
  { card: Record },
  { readonly: false },
);

const CardThread = tool(
  "card_thread",
  "Steer, stop, wake or reset a card thread",
  "Evaluators: steer the card's live thread with text, stop it (the card keeps its place; move it if needed), wake its last work thread with text, or reset it: the card drops its threads and its next run starts on a fresh one, with text as a note for it. Steer and wake require non-blank text and an open worker step or pending review findings, unless a reviewer is attached. message is an alias for text; if both are supplied, they must match.",
  {
    boardId: BoardRef,
    card: CardRef,
    action: Schema.Literals(["steer", "stop", "wake", "reset"]),
    text: Schema.optional(Schema.String),
    message: Schema.optional(
      describe(Schema.String, "Alias for text; if both are supplied, they must match."),
    ),
  },
  { card: Record },
  { readonly: false, destructive: true },
);

const PoolSet = tool(
  "pool_set",
  "Set a model pool",
  "Evaluators: how many threads may run at once on a model at one level; a model or level with no pool yet gets one. Pass boardId to target another board; without it, use the caller's board. Only models in the composer's list (orchestrator_capabilities). Name the variant when the model has pools at several levels. To change a pool's level, pass its key as replaces. Lowering never stops running threads by itself.",
  {
    boardId: Schema.optional(TrimmedNonEmptyString),
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

const BoardInstructionsSet = tool(
  "board_instructions_set",
  "Apply approved board instructions",
  "Evaluators: set one of a board's instructions (escalation, modelRouting, reviewerRouting) to text Abdullah approved. The ask must be closed with his approval, and one of its change/changes entries must have a label naming the board (slug or name) and the field, before equal to the board's current text and after equal to text. Text he didn't approve is refused.",
  {
    boardId: Schema.optional(TrimmedNonEmptyString),
    field: Schema.Literals(["escalation", "modelRouting", "reviewerRouting"]),
    text: Schema.String,
    card: CardRef,
    ask: TrimmedNonEmptyString,
  },
  { board: Record, applied: Schema.Boolean, reason: Schema.optional(Schema.String) },
  { readonly: false, destructive: true },
);

const BoardSettingsSet = tool(
  "board_settings_set",
  "Apply approved board settings",
  'Evaluators: set guessedGates to the value Abdullah approved in a closed change ask with an approved verdict. Its change/changes entry must label "<Board> guessed gates" (board slug or name; guessedGates also accepted), with before equal to the current setting and after equal to value: sort gates and join with ", " ("deploy, money, secret", "money, secret", "" for none; "(unset)" for an absent current setting).',
  {
    boardId: Schema.optional(TrimmedNonEmptyString),
    card: CardRef,
    ask: TrimmedNonEmptyString,
    setting: Schema.Literals(["guessedGates"]),
    value: Schema.Array(Schema.Literals(["deploy", "money", "secret"])),
  },
  { board: Record, applied: Schema.Boolean, reason: Schema.optional(Schema.String) },
  { readonly: false, destructive: true },
);

const PoolRemove = tool(
  "pool_remove",
  "Remove a model pool",
  "Evaluators: drop a pool at 0 slots that nothing on the board uses. Pass boardId to target another board; without it, use the caller's board. Name the variant when the model has pools at several levels.",
  { boardId: Schema.optional(TrimmedNonEmptyString), model: ModelInput },
  { pools: Records },
  { readonly: false, destructive: true },
);

const GoalSet = tool(
  "goal_set",
  "Create or update a goal",
  "Evaluators: create a goal (name) or update one (id): status, Now (current status, plain words) and a new Story entry (appended to the numbered story for a non-technical reader).",
  {
    boardId: BoardRef,
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
    boardId: BoardRef,
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
  { boardId: BoardRef, title: RawBoardText, ...BlocksInput },
  { discussion: Record },
  { readonly: false },
);

const WikiWrite = tool(
  "wiki_write",
  "Write a wiki page",
  "Evaluators: create or replace a page with body, or change an existing page with edits (1–50). Pass exactly one of body or edits. Each oldString must appear exactly count times (default 1) in the page as left by the edits before it; all edits apply or none do. title is kept when left out (new pages default to slug). Edits return page metadata, bodyLength and edits count without the body; body writes return the full page.",
  {
    boardId: BoardRef,
    slug: TrimmedNonEmptyString,
    title: Schema.optional(RawBoardText),
    body: Schema.optional(Schema.String),
    edits: Schema.optional(ExactEdits),
  },
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

const ReportBug = tool(
  "report_bug",
  "Report a bug",
  "Report a tooling bug from any thread. Pass cardHint (e.g. #722, a card on boardId's board) when you already know its card there (any stage until it is settled). A hint or strong title match appends a sighting without starting an evaluator; weak matches start a request evaluator, or queue it when the board's spawn limit is full. Identical evidence from this thread on the same card is deduped for 30 minutes. Search matches return up to three candidates, best first.",
  {
    boardId: describe(TrimmedNonEmptyString, "Destination board id or slug."),
    title: describe(TrimmedNonEmptyString, "Short bug title to search for."),
    evidence: describe(TrimmedNonEmptyString, "What broke, with errors, run ids or log paths."),
    cardHint: Schema.optional(
      describe(
        TrimmedNonEmptyString,
        "A card on the destination board: its number (#722), boardslug#722, or its card id. Never your own card's number from another board.",
      ),
    ),
  },
  {
    appendedTo: Schema.optional(TrimmedNonEmptyString),
    callerVerified: Schema.optional(Schema.Boolean),
    callerUnverifiedReason: Schema.optional(
      Schema.Literals(["caller_unresolved", "parent_not_active"]),
    ),
    message: Schema.optional(Schema.String),
    deduped: Schema.optional(Schema.Boolean),
    candidates: Schema.optional(Records),
    threadId: Schema.optional(TrimmedNonEmptyString),
    queued: Schema.optional(Schema.Boolean),
    queueId: Schema.optional(Schema.Number),
  },
  { readonly: false },
);

const EvaluatorStart = tool(
  "evaluator_start",
  "Start an evaluator",
  "Start an evaluator thread on a board for a job: setup or request (text required), or a sweep: stalled, completed, deployed, check, nightly (optional text is added to its brief). A board runs one sweep of each kind at a time; starting another while one runs fails and names it. For requests, one matching open card with a live or recently ended evaluator receives a sighting instead of a new thread. Pass forceNew:true to skip matching; spawn caps still apply. Excess launches queue durably in board order. Card threads may start only kind request (for example to hand a broken tool to the Robob board); their text is stamped with their board, card and thread.",
  {
    boardId: BoardRef,
    kind: Schema.Literals([
      "setup",
      "request",
      "stalled",
      "completed",
      "deployed",
      "check",
      "nightly",
    ]),
    text: Schema.optional(Schema.String),
    forceNew: Schema.optional(Schema.Boolean),
    /** For setup: an existing discussion on this board to use as the Setup discussion. */
    discussionId: Schema.optional(TrimmedNonEmptyString),
  },
  {
    threadId: Schema.optional(TrimmedNonEmptyString),
    matched: Schema.optional(Schema.Boolean),
    card: Schema.optional(Record),
    sightingAppended: Schema.optional(Schema.Boolean),
    queued: Schema.optional(Schema.Boolean),
    queueId: Schema.optional(Schema.Number),
  },
  { readonly: false },
);

const EvaluatorStatus = tool(
  "evaluator_status",
  "Look up an evaluator request",
  "Read back an evaluator_start or report_bug using exactly one returned queueId or threadId. Returns its queue state, evaluator thread and cards it filed or updated, including retitled or settled cards and duplicates recorded on existing cards.",
  {
    boardId: BoardRef,
    queueId: Schema.optional(PositiveInt),
    threadId: Schema.optional(TrimmedNonEmptyString),
  },
  {
    saved: Schema.Boolean,
    queued: Schema.Boolean,
    queueId: Schema.optional(Schema.Number),
    threadId: Schema.optional(TrimmedNonEmptyString),
    cards: Records,
  },
  { readonly: true },
);

const SetupDone = tool(
  "setup_done",
  "End board setup",
  "Only the board's setup evaluator calls this, once the board's wiki and setup are complete. It lifts the setup hold: card work and review resume, and one line is posted in the Setup discussion.",
  { boardId: BoardRef },
  { board: Record },
  { readonly: false },
);

const BoardPause = tool(
  "board_pause",
  "Pause or resume a board",
  "Evaluators: pause the whole board or lift it. While paused, the dispatcher starts no card work or review except the kept cards (keep: #numbers). Threads already running keep running; stop them with card_thread stop if they must stop now. clear:true lifts it. Use this instead of per-card stalled flags.",
  {
    boardId: Schema.optional(Schema.NullOr(BoardRef)),
    keep: Schema.optional(Schema.NullOr(Schema.Array(TrimmedNonEmptyString))),
    reason: Schema.optional(Schema.NullOr(Schema.String)),
    clear: Schema.optional(Schema.NullOr(Schema.Boolean)),
  },
  { board: Record },
  { readonly: false },
);

const BoardNightlyReview = tool(
  "board_nightly_review",
  "Set nightly review",
  "Evaluators: enable or disable this board's daily review. Defaults to midnight Asia/Dubai with Sonnet 5.5 medium. Omitted time and zone keep the saved values.",
  {
    boardId: BoardRef,
    enabled: Schema.Boolean,
    timeOfDay: Schema.optional(KanbanNightlyReviewTime),
    timeZone: Schema.optional(KanbanNightlyReviewTimeZone),
  },
  { board: Record },
  { readonly: false },
);

export const KanbanToolkit = Toolkit.make(
  BoardNightlyReview,
  SetupDone,
  BoardPause,
  BoardGet,
  BoardActivity,
  CardSearch,
  CardGet,
  CardUpdate,
  CardMove,
  CardAsk,
  CardAskChange,
  CardAskAnswer,
  CardFlag,
  CardWait,
  BoardStandingApproval,
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
  BoardInstructionsSet,
  BoardSettingsSet,
  PoolRemove,
  GoalSet,
  GroupSet,
  DiscussionCreate,
  WikiWrite,
  BoardOpen,
  EvaluatorStart,
  EvaluatorStatus,
  ReportBug,
);
