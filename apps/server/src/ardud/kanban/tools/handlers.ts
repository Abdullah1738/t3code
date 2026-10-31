import {
  KANBAN_BACKLOG,
  KanbanBoardId,
  KanbanCardId,
  KanbanDiscussionId,
  KanbanGoalId,
  OrchestratorMcpFailure,
  ProjectId,
  type KanbanActor,
  type KanbanBlock,
  type KanbanCard,
  type KanbanCardModel,
  type KanbanError,
  type KanbanThreadLink,
  type ModelSelection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import type { EvaluatorPurpose } from "../engine/briefs.ts";
import { modelSelectionOf } from "../engine/defaults.ts";
import { KanbanService } from "../engine/KanbanService.ts";
import { KanbanToolkit, type ModelInput } from "./tools.ts";

const toolFailure = (error: KanbanError) =>
  new OrchestratorMcpFailure({
    code: error.code === "denied" ? "capability_denied" : "invalid_request",
    message: error.message,
  });

const refuse = (message: string) =>
  Effect.fail(new OrchestratorMcpFailure({ code: "capability_denied", message }));
const invalid = (message: string) =>
  Effect.fail(new OrchestratorMcpFailure({ code: "invalid_request", message }));

/** The calling thread and its board link (null for threads the board did not start). */
interface Caller {
  readonly threadId: KanbanThreadLink["threadId"];
  readonly link: KanbanThreadLink | null;
  readonly actor: KanbanActor;
}

const isCardThread = (caller: Caller) =>
  caller.link !== null && (caller.link.role === "work" || caller.link.role === "review");

const withCaller = Effect.fn("KanbanTools.withCaller")(
  function* <A, R>(
    run: (
      service: KanbanService["Service"],
      caller: Caller,
    ) => Effect.Effect<A, KanbanError | OrchestratorMcpFailure, R>,
  ) {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const thread = yield* McpInvocationContext.requireThreadScope(scope, "Missions board tools");
    const service = yield* KanbanService;
    const threadId = thread.thread.threadId;
    const link = yield* service.caller(threadId);
    const actor: KanbanActor =
      link !== null && link.role !== "evaluator"
        ? { _tag: "thread", threadId }
        : { _tag: "evaluator", threadId };
    return yield* run(service, { threadId, link, actor });
  },
  Effect.catchTags({ KanbanError: (error) => Effect.fail(toolFailure(error)) }),
);

/** Evaluator tools: board evaluators, or orchestrating threads outside any board. */
const asEvaluator = <A, R>(
  run: (
    service: KanbanService["Service"],
    caller: Caller,
  ) => Effect.Effect<A, KanbanError | OrchestratorMcpFailure, R>,
) =>
  withCaller((service, caller) =>
    isCardThread(caller)
      ? refuse(
          "Only evaluators use this tool. Card threads ask through card_ask, card_flag or discussion_post.",
        )
      : run(service, caller),
  );

const boardFor = Effect.fn("KanbanTools.boardFor")(function* (
  service: KanbanService["Service"],
  caller: Caller,
  explicit?: string,
) {
  const boards = yield* service.boards;
  const wanted = explicit?.trim() || caller.link?.boardId;
  if (wanted) {
    const board = boards.find((candidate) => candidate.id === wanted || candidate.slug === wanted);
    if (board) return board;
    return yield* invalid(`No Missions board "${wanted}".`);
  }
  const open = boards.filter((board) => board.archivedAt === null);
  if (open.length === 1 && open[0]) return open[0];
  return yield* invalid("Pass boardId: this thread is not on a board.");
});

/**
 * A work thread's cards when it names none: what it works on now, else the
 * cards it took that are still its own. One moved to another thread is not.
 */
const workCards = Effect.fn("KanbanTools.workCards")(function* (
  service: KanbanService["Service"],
  caller: Caller,
) {
  const carried = yield* service.carried(caller.threadId);
  return carried.length > 0 ? carried : yield* service.ownCards(caller.threadId);
});

const numbers = (cards: ReadonlyArray<KanbanCard>) =>
  cards.map((card) => `#${card.number}`).join(", ");

/**
 * The caller's own card when it names none: a review thread's card, or the
 * one card a work thread has. A work thread with several must say.
 */
const defaultCard = Effect.fn("KanbanTools.defaultCard")(function* (
  service: KanbanService["Service"],
  caller: Caller,
) {
  if (caller.link?.role === "work") {
    const cards = yield* workCards(service, caller);
    if (cards.length === 1 && cards[0]) return cards[0];
    if (cards.length > 1) return yield* invalid(`Pass card: this thread has ${numbers(cards)}.`);
    return yield* invalid("Pass card: this thread has no card of its own.");
  }
  if (caller.link?.cardId) return (yield* service.card(caller.link.cardId)).card;
  return yield* invalid("Pass card: this thread has no card of its own.");
});

/** A card id ("card-...") or number ("#12"/"12"); defaults to the caller's own card. */
const cardFor = Effect.fn("KanbanTools.cardFor")(function* (
  service: KanbanService["Service"],
  caller: Caller,
  ref: string | undefined,
) {
  const trimmed = ref?.trim();
  if (!trimmed) return yield* defaultCard(service, caller);
  const number = Number.parseInt(trimmed.replace(/^#/, ""), 10);
  if (!Number.isNaN(number) && /^#?\d+$/.test(trimmed)) {
    const board = yield* boardFor(service, caller);
    const snapshot = yield* service.snapshot(board.id);
    const card = snapshot.cards.find((candidate) => candidate.number === number);
    if (!card) return yield* invalid(`No card #${number} on ${board.name}.`);
    return card;
  }
  return (yield* service.card(KanbanCardId.make(trimmed))).card;
});

/**
 * Card threads act only on their own cards: a review thread on its card, a
 * work thread on the cards it still works on (one moved to another thread is
 * no longer its own, even the one it started with).
 */
const ownCard = (caller: Caller, card: KanbanCard) =>
  !isCardThread(caller) ||
  (caller.link?.role === "work"
    ? card.workThreadId === caller.threadId
    : caller.link?.cardId === card.id)
    ? Effect.void
    : refuse(`This thread works on other cards; it can't change card #${card.number}.`);

/** The card a work thread's new cards follow on from: one it carries, else the one it started with. */
const workOrigin = Effect.fn("KanbanTools.workOrigin")(function* (
  service: KanbanService["Service"],
  caller: Caller,
) {
  const [carried] = yield* service.carried(caller.threadId);
  if (carried) return carried;
  return caller.link?.cardId ? (yield* service.card(caller.link.cardId)).card : null;
});

/** Names the board, card and thread a card thread's request came from, so the new evaluator knows. */
const stampHandOn = Effect.fn("KanbanTools.stampHandOn")(function* (
  service: KanbanService["Service"],
  caller: Caller,
  text: string,
) {
  const link = caller.link;
  if (!link) return text;
  const boards = yield* service.boards;
  const sourceBoard = boards.find((board) => board.id === link.boardId);
  const card = yield* workOrigin(service, caller);
  const boardName = sourceBoard ? `"${sourceBoard.name}" board` : `board ${link.boardId}`;
  const cardPart = card
    ? `, card [#${card.number} ${card.title}](t3-context://v1/kanban-card/${card.id})`
    : "";
  return `Handed on by a ${link.role} thread on the ${boardName}${cardPart}, thread [${caller.threadId}](t3-thread://v1/${caller.threadId}).\n\n${text}`;
});

const modelOf = (input: ModelInput): ModelSelection => modelSelectionOf(input);

const modelsOf = (
  input: ReadonlyArray<ModelInput & { readonly weight: number }> | undefined,
): ReadonlyArray<KanbanCardModel> | undefined =>
  input?.map((entry) => ({ model: modelOf(entry), weight: entry.weight }));

const blocksOf = (input: {
  readonly text?: string | undefined;
  readonly blocks?: ReadonlyArray<KanbanBlock> | undefined;
}): ReadonlyArray<KanbanBlock> => [
  ...(input.text?.trim() ? [{ _tag: "md" as const, text: input.text }] : []),
  ...(input.blocks ?? []),
];

const discussionFor = Effect.fn("KanbanTools.discussionFor")(function* (
  service: KanbanService["Service"],
  caller: Caller,
  explicit: string | undefined,
  cardRef?: string | undefined,
) {
  if (explicit?.trim()) return yield* service.discussion(KanbanDiscussionId.make(explicit.trim()));
  if (cardRef?.trim()) {
    const card = yield* cardFor(service, caller, cardRef);
    yield* ownCard(caller, card);
    return yield* service.cardDiscussion(card.id);
  }
  if (caller.link?.discussionId) return yield* service.discussion(caller.link.discussionId);
  if (caller.link?.role === "work") {
    const cards = yield* workCards(service, caller);
    const [only] = cards;
    if (cards.length === 1 && only) return yield* service.cardDiscussion(only.id);
    return yield* invalid(
      cards.length > 1
        ? `Pass card or discussionId: this thread has ${numbers(cards)}; each has its own discussion.`
        : "Pass discussionId: this thread has no card of its own.",
    );
  }
  if (isCardThread(caller)) {
    const card = yield* defaultCard(service, caller);
    return yield* service.cardDiscussion(card.id);
  }
  return yield* invalid("Pass discussionId: this thread has no discussion of its own.");
});

const cardIds = (
  service: KanbanService["Service"],
  caller: Caller,
  refs: ReadonlyArray<string> | undefined,
): Effect.Effect<
  ReadonlyArray<KanbanCard["id"]> | undefined,
  KanbanError | OrchestratorMcpFailure
> =>
  refs === undefined
    ? Effect.void.pipe(Effect.as(undefined))
    : Effect.forEach(refs, (ref) =>
        cardFor(service, caller, ref).pipe(Effect.map((card) => card.id)),
      );

const SEARCH_LIMIT = 20;

const isCardNumber = (card: KanbanCard, query: string) => {
  const trimmed = query.trim();
  return /^#?\d+$/.test(trimmed) && card.number === Number(trimmed.replace("#", ""));
};

/**
 * Every word must appear in the card's text; a lone "#12" (or "12") also finds
 * card 12, which sorts first so the limit never cuts it for #120 and friends.
 */
const cardMatches = (card: KanbanCard, query: string) => {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return true;
  if (isCardNumber(card, trimmed)) return true;
  const text = [
    `#${card.number}`,
    card.title,
    card.description,
    card.prompt,
    ...card.links.flatMap((link) => [link.url, link.label ?? ""]),
  ]
    .join("\n")
    .toLowerCase();
  return trimmed.split(/\s+/).every((word) => text.includes(word));
};

const handlers = {
  board_get: McpToolAccess.readsAsCaller((input) =>
    withCaller((service, caller) =>
      Effect.gen(function* () {
        const board = yield* boardFor(service, caller, input.boardId);
        return { board: yield* service.snapshot(board.id) };
      }),
    ),
  ),

  card_search: McpToolAccess.readsAsCaller((input) =>
    withCaller((service, caller) =>
      Effect.gen(function* () {
        const board = yield* boardFor(service, caller, input.boardId);
        const snapshot = yield* service.snapshot(board.id);
        const found = snapshot.cards
          .filter(
            (card) =>
              (input.includeSettled === true || card.settledAt === null) &&
              (input.stage === undefined || card.stage === input.stage) &&
              cardMatches(card, input.query),
          )
          .toSorted(
            (left, right) =>
              Number(isCardNumber(right, input.query)) - Number(isCardNumber(left, input.query)) ||
              right.number - left.number,
          );
        return {
          total: found.length,
          cards: found.slice(0, input.limit ?? SEARCH_LIMIT).map((card) => ({
            id: card.id,
            number: card.number,
            title: card.title,
            stage: card.stage,
            priority: card.priority,
            settledAt: card.settledAt,
            goalId: card.goalId,
            links: card.links.map((link) => ({ url: link.url, label: link.label })),
          })),
        };
      }),
    ),
  ),

  card_get: McpToolAccess.readsAsCaller((input) =>
    withCaller((service, caller) =>
      Effect.gen(function* () {
        const card = yield* cardFor(service, caller, input.card);
        const detail = yield* service.card(card.id);
        return { card: detail.card, events: detail.events, threads: detail.threads };
      }),
    ),
  ),

  card_update: McpToolAccess.actsAsCaller((input) =>
    withCaller((service, caller) =>
      Effect.gen(function* () {
        const card = yield* cardFor(service, caller, input.card);
        yield* ownCard(caller, card);
        const updated = yield* service.editCard(
          card.id,
          {
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.links !== undefined ? { links: input.links } : {}),
            ...(input.comment !== undefined ? { comment: input.comment } : {}),
          },
          caller.actor,
        );
        return { card: updated };
      }),
    ),
  ),

  card_move: McpToolAccess.actsAsCaller((input) =>
    withCaller((service, caller) =>
      Effect.gen(function* () {
        const card = yield* cardFor(service, caller, input.card);
        yield* ownCard(caller, card);
        if (caller.link?.role === "review") {
          return yield* refuse("Review threads record their verdict with card_review_result.");
        }
        const moved = yield* service.moveCard(
          card.id,
          input.to,
          isCardThread(caller) ? "cardThread" : "evaluator",
          caller.actor,
          { note: input.note ?? null, question: input.question ?? null },
        );
        return { card: moved };
      }),
    ),
  ),

  card_ask: McpToolAccess.actsAsCaller((input) =>
    withCaller((service, caller) =>
      Effect.gen(function* () {
        const card = yield* cardFor(service, caller, input.card);
        yield* ownCard(caller, card);
        if (caller.link?.role === "review") {
          return yield* refuse("Review threads put questions in their findings.");
        }
        const asked = yield* service.askOwner(
          card.id,
          {
            question: input.question,
            blocking: input.blocking ?? false,
            options: input.options,
            multi: input.multi,
          },
          caller.actor,
          isCardThread(caller) ? "cardThread" : "evaluator",
        );
        return { card: asked };
      }),
    ),
  ),

  card_ask_change: McpToolAccess.actsAsCaller((input) =>
    withCaller((service, caller) =>
      Effect.gen(function* () {
        const card = yield* cardFor(service, caller, input.card);
        yield* ownCard(caller, card);
        if (caller.link?.role === "review") {
          return yield* refuse("Review threads put questions in their findings.");
        }
        const changed = yield* service.changeAsk(
          card.id,
          input.ask.trim(),
          input.action,
          caller.actor,
          isCardThread(caller) ? "cardThread" : "evaluator",
        );
        return { card: changed };
      }),
    ),
  ),

  card_flag: McpToolAccess.actsAsCaller((input) =>
    withCaller((service, caller) =>
      Effect.gen(function* () {
        const card = yield* cardFor(service, caller, input.card);
        yield* ownCard(caller, card);
        const reason = input.stalled ? input.reason?.trim() || "Stalled" : null;
        return { card: yield* service.flagCard(card.id, reason, caller.actor) };
      }),
    ),
  ),

  card_review_result: McpToolAccess.actsAsCaller((input) =>
    withCaller((service, caller) =>
      Effect.gen(function* () {
        if (caller.link?.role !== "review") {
          return yield* refuse("Only a card's review thread records a review verdict.");
        }
        const findings = (input.findings ?? []).map((line) => line.trim()).filter(Boolean);
        if (input.verdict === "findings" && findings.length === 0) {
          return yield* invalid("A findings verdict needs at least one finding.");
        }
        return {
          card: yield* service.reviewResult(
            caller.threadId,
            input.verdict,
            findings,
            input.head ?? null,
          ),
        };
      }),
    ),
  ),

  discussion_post: McpToolAccess.actsAsCaller((input) =>
    withCaller((service, caller) =>
      Effect.gen(function* () {
        const blocks = blocksOf(input);
        if (blocks.length === 0) return yield* invalid("Pass text or blocks.");
        const discussion = yield* discussionFor(service, caller, input.discussionId, input.card);
        return { message: yield* service.post(discussion.id, caller.actor, blocks) };
      }),
    ),
  ),

  discussion_read: McpToolAccess.readsAsCaller((input) =>
    withCaller((service, caller) =>
      Effect.gen(function* () {
        const discussion = yield* discussionFor(service, caller, input.discussionId, input.card);
        const messages = yield* service.messages(
          discussion.id,
          input.afterSeq !== undefined ? { afterSeq: input.afterSeq } : undefined,
        );
        if (discussion.lastSeq > 0)
          yield* service.markRead(discussion.id, caller.actor, discussion.lastSeq);
        // Agents open attachments by path; the id alone is not enough to read the file.
        const withPaths = messages.map((message) => ({
          ...message,
          blocks: message.blocks.map((block) =>
            block._tag === "attachment"
              ? { ...block, path: service.attachmentPath(block.attachment) }
              : block,
          ),
        }));
        return { discussion, messages: withPaths };
      }),
    ),
  ),

  wiki_read: McpToolAccess.readsAsCaller((input) =>
    withCaller((service, caller) =>
      Effect.gen(function* () {
        const board = yield* boardFor(service, caller);
        const pages = yield* service.wiki(board.id);
        return { pages: input.slug ? pages.filter((page) => page.slug === input.slug) : pages };
      }),
    ),
  ),

  card_create: McpToolAccess.actsAsCaller((input) =>
    withCaller((service, caller) =>
      Effect.gen(function* () {
        if (caller.link?.role === "review") {
          return yield* refuse("Review threads report findings; they don't create cards.");
        }
        const isWorker = caller.link?.role === "work";
        if (input.assignToSelf && !isWorker) {
          return yield* refuse("Only a card's work thread can take a card with assignToSelf.");
        }
        if (input.assignToSelf && input.priority === KANBAN_BACKLOG) {
          return yield* refuse("A backlog card isn't picked up; leave out assignToSelf.");
        }
        const board = yield* boardFor(service, caller);
        const blockedBy = yield* cardIds(service, caller, input.blockedBy);
        // Follow-up work keeps the review chain and goal of the card it came from.
        const origin = isWorker ? yield* workOrigin(service, caller) : null;
        const fields = {
          prompt: input.prompt,
          title: input.title,
          description: input.description,
          priority: input.priority,
          goalId: input.goalId ? KanbanGoalId.make(input.goalId) : (origin?.goalId ?? null),
          projects: input.projects,
          model: input.model ? modelOf(input.model) : undefined,
          models: modelsOf(input.models),
          projectId: input.projectId ? ProjectId.make(input.projectId) : null,
          links: input.links,
          blockedBy,
          reviewChain: origin ? origin.reviewChain : (input.reviewChain ?? null),
          subtasks: input.subtasks,
        };
        if (input.assignToSelf) {
          return yield* service.createForThread(caller.threadId, fields);
        }
        if (isWorker && input.stage === "needs_owner") {
          return yield* refuse("Work threads ask the owner with card_ask on their own card.");
        }
        const card = yield* service.createCard(
          board.id,
          { ...fields, stage: input.stage, question: input.question ?? null },
          caller.actor,
        );
        return { card };
      }),
    ),
  ),

  card_claim: McpToolAccess.actsAsCaller((input) =>
    withCaller((service, caller) =>
      Effect.gen(function* () {
        if (caller.link?.role !== "work") {
          return yield* refuse("Only a card's work thread takes cards into its run.");
        }
        const card = yield* cardFor(service, caller, input.card);
        return yield* service.claimCard(caller.threadId, card.id);
      }),
    ),
  ),

  card_next: McpToolAccess.readsAsCaller(() =>
    withCaller((service, caller) =>
      Effect.gen(function* () {
        if (caller.link?.role !== "work") {
          return yield* refuse("Only a card's work thread asks for its next card.");
        }
        const next = yield* service.nextCards(caller.threadId);
        return {
          carrying: next.carrying.map((card) => ({
            card: `#${card.number}`,
            title: card.title,
            stage: card.stage,
          })),
          candidates: next.candidates.map(({ card, why }) => ({
            card: `#${card.number}`,
            title: card.title,
            priority: card.priority,
            why,
          })),
          holdsSlot: next.holdsSlot,
        };
      }),
    ),
  ),

  card_edit: McpToolAccess.actsAsCaller((input) =>
    asEvaluator((service, caller) =>
      Effect.gen(function* () {
        const card = yield* cardFor(service, caller, input.card);
        const blockedBy = yield* cardIds(service, caller, input.blockedBy);
        const edited = yield* service.editCard(
          card.id,
          {
            title: input.title,
            description: input.description,
            prompt: input.prompt,
            priority: input.priority,
            ...(input.goalId !== undefined
              ? { goalId: input.goalId === null ? null : KanbanGoalId.make(input.goalId) }
              : {}),
            projects: input.projects,
            model: input.model ? modelOf(input.model) : undefined,
            models: modelsOf(input.models),
            ...(input.projectId !== undefined
              ? { projectId: input.projectId === null ? null : ProjectId.make(input.projectId) }
              : {}),
            links: input.links,
            removeLinks: input.removeLinks,
            blockedBy,
            ...(input.reviewChain !== undefined ? { reviewChain: input.reviewChain } : {}),
            subtasks: input.subtasks,
            comment: input.comment,
          },
          caller.actor,
        );
        return { card: edited };
      }),
    ),
  ),

  subtask_done: McpToolAccess.actsAsCaller((input) =>
    withCaller((service, caller) =>
      Effect.gen(function* () {
        const card = yield* cardFor(service, caller, input.card);
        yield* ownCard(caller, card);
        const role =
          caller.link?.role === "work" || caller.link?.role === "review"
            ? caller.link.role
            : "evaluator";
        return {
          card: yield* service.markSubtask(
            card.id,
            input.subtask,
            input.state,
            input.note ?? null,
            caller.actor,
            role,
          ),
        };
      }),
    ),
  ),

  card_thread: McpToolAccess.actsAsCaller((input) =>
    asEvaluator((service, caller) =>
      Effect.gen(function* () {
        const card = yield* cardFor(service, caller, input.card);
        return {
          card: yield* service.cardThread(card.id, input.action, input.text ?? "", caller.actor),
        };
      }),
    ),
  ),

  pool_set: McpToolAccess.actsAsCaller((input) =>
    asEvaluator((service, caller) =>
      Effect.gen(function* () {
        const board = yield* boardFor(service, caller);
        return { pools: yield* service.setPool(board.id, modelOf(input.model), input.slots) };
      }),
    ),
  ),

  pool_remove: McpToolAccess.actsAsCaller((input) =>
    asEvaluator((service, caller) =>
      Effect.gen(function* () {
        const board = yield* boardFor(service, caller);
        return { pools: yield* service.removePool(board.id, modelOf(input.model)) };
      }),
    ),
  ),

  goal_set: McpToolAccess.actsAsCaller((input) =>
    asEvaluator((service, caller) =>
      Effect.gen(function* () {
        const board = yield* boardFor(service, caller);
        const goal = yield* service.setGoal(board.id, {
          id: input.id ? KanbanGoalId.make(input.id) : undefined,
          name: input.name,
          status: input.status,
          now: input.now,
          story: input.story,
        });
        return { goal };
      }),
    ),
  ),

  group_set: McpToolAccess.actsAsCaller((input) =>
    asEvaluator((service, caller) =>
      Effect.gen(function* () {
        const board = yield* boardFor(service, caller);
        const groups = yield* Effect.forEach(input.groups, (group) =>
          cardIds(service, caller, group.cards).pipe(
            Effect.map((ids) => ({
              id: group.id,
              name: group.name,
              summary: group.summary,
              cardIds: ids ?? [],
            })),
          ),
        );
        yield* service.setGroups(board.id, groups);
        return { groups };
      }),
    ),
  ),

  discussion_create: McpToolAccess.actsAsCaller((input) =>
    asEvaluator((service, caller) =>
      Effect.gen(function* () {
        const board = yield* boardFor(service, caller);
        const discussion = yield* service.createDiscussion(board.id, input.title, caller.actor);
        const blocks = blocksOf(input);
        if (blocks.length > 0) yield* service.post(discussion.id, caller.actor, blocks);
        return { discussion: yield* service.discussion(discussion.id) };
      }),
    ),
  ),

  wiki_write: McpToolAccess.actsAsCaller((input) =>
    asEvaluator((service, caller) =>
      Effect.gen(function* () {
        const board = yield* boardFor(service, caller);
        const page = yield* service.writeWiki(
          board.id,
          { slug: input.slug, title: input.title, body: input.body },
          caller.actor,
        );
        return { page };
      }),
    ),
  ),

  board_open: McpToolAccess.actsAsCaller((input) =>
    asEvaluator((service) =>
      Effect.gen(function* () {
        const board = yield* service.ensureBoard({
          slug: input.slug,
          name: input.name,
          defaultProjectId: input.projectId ? ProjectId.make(input.projectId) : null,
        });
        const patch = {
          ...(input.projectId && board.defaultProjectId === null
            ? { defaultProjectId: ProjectId.make(input.projectId) }
            : {}),
          ...(input.icon && board.icon === null ? { icon: input.icon } : {}),
        };
        if (Object.keys(patch).length === 0) return { board };
        return { board: yield* service.updateBoard(board.id, patch) };
      }),
    ),
  ),

  setup_done: McpToolAccess.actsAsCaller(() =>
    asEvaluator((service, caller) =>
      Effect.gen(function* () {
        const board = yield* boardFor(service, caller);
        return { board: yield* service.endSetup(board.id, caller.actor) };
      }),
    ),
  ),

  evaluator_start: McpToolAccess.actsAsCaller((input) =>
    withCaller((service, caller) =>
      Effect.gen(function* () {
        const cardThread = isCardThread(caller);
        if (cardThread && input.kind !== "request") {
          return yield* refuse(
            'Card threads can start only a request evaluator (kind "request"), for example to hand a broken tool to the Robob board.',
          );
        }
        const board = yield* boardFor(service, caller, input.boardId);
        const text = input.text?.trim() ?? "";
        let purpose: EvaluatorPurpose;
        if (input.kind === "setup" || input.kind === "request") {
          if (!text) return yield* invalid(`A ${input.kind} evaluator needs text.`);
          purpose = {
            kind: input.kind,
            text: cardThread && caller.link ? yield* stampHandOn(service, caller, text) : text,
            ...(input.kind === "setup" ? { discussionId: input.discussionId ?? null } : {}),
          };
        } else {
          purpose = { kind: input.kind };
        }
        // A sweep's text is added to its brief; setup/request already carry it in purpose.
        const sweepText = purpose.kind === "setup" || purpose.kind === "request" ? undefined : text;
        return {
          threadId: yield* service.startEvaluator(
            KanbanBoardId.make(board.id),
            purpose,
            sweepText || undefined,
          ),
        };
      }),
    ),
  ),
} satisfies McpToolAccess.Handlers<typeof KanbanToolkit.tools>;

export const layer = McpToolAccess.toLayer(KanbanToolkit, handlers);
