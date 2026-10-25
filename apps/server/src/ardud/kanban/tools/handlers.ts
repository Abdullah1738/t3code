import {
  KanbanBoardId,
  KanbanCardId,
  KanbanDiscussionId,
  KanbanGoalId,
  OrchestratorMcpFailure,
  ProjectId,
  type KanbanActor,
  type KanbanBlock,
  type KanbanCard,
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
          "Only evaluators use this tool. Card threads ask through card_move, card_flag or discussion_post.",
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

/** A card id ("card-...") or number ("#12"/"12"); defaults to the caller's own card. */
const cardFor = Effect.fn("KanbanTools.cardFor")(function* (
  service: KanbanService["Service"],
  caller: Caller,
  ref: string | undefined,
) {
  const trimmed = ref?.trim();
  if (!trimmed) {
    if (caller.link?.cardId) return (yield* service.card(caller.link.cardId)).card;
    return yield* invalid("Pass card: this thread has no card of its own.");
  }
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

/** Card threads may only act on their own card. */
const ownCard = (caller: Caller, card: KanbanCard) =>
  isCardThread(caller) && caller.link?.cardId !== card.id
    ? refuse(`This thread works on another card; it can't change card #${card.number}.`)
    : Effect.void;

const modelOf = (input: ModelInput): ModelSelection => modelSelectionOf(input);

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
) {
  if (explicit?.trim()) return yield* service.discussion(KanbanDiscussionId.make(explicit.trim()));
  if (caller.link?.discussionId) return yield* service.discussion(caller.link.discussionId);
  if (caller.link?.cardId) return yield* service.cardDiscussion(caller.link.cardId);
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

const handlers = {
  board_get: McpToolAccess.readsAsCaller((input) =>
    withCaller((service, caller) =>
      Effect.gen(function* () {
        const board = yield* boardFor(service, caller, input.boardId);
        return { board: yield* service.snapshot(board.id) };
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
        return { card: yield* service.reviewResult(caller.threadId, input.verdict, findings) };
      }),
    ),
  ),

  discussion_post: McpToolAccess.actsAsCaller((input) =>
    withCaller((service, caller) =>
      Effect.gen(function* () {
        const blocks = blocksOf(input);
        if (blocks.length === 0) return yield* invalid("Pass text or blocks.");
        const discussion = yield* discussionFor(service, caller, input.discussionId);
        return { message: yield* service.post(discussion.id, caller.actor, blocks) };
      }),
    ),
  ),

  discussion_read: McpToolAccess.readsAsCaller((input) =>
    withCaller((service, caller) =>
      Effect.gen(function* () {
        const discussion = yield* discussionFor(service, caller, input.discussionId);
        const messages = yield* service.messages(
          discussion.id,
          input.afterSeq !== undefined ? { afterSeq: input.afterSeq } : undefined,
        );
        if (discussion.lastSeq > 0)
          yield* service.markRead(discussion.id, caller.actor, discussion.lastSeq);
        return { discussion, messages };
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
    asEvaluator((service, caller) =>
      Effect.gen(function* () {
        const board = yield* boardFor(service, caller);
        const blockedBy = yield* cardIds(service, caller, input.blockedBy);
        const card = yield* service.createCard(
          board.id,
          {
            prompt: input.prompt,
            title: input.title,
            description: input.description,
            priority: input.priority,
            goalId: input.goalId ? KanbanGoalId.make(input.goalId) : null,
            projects: input.projects,
            model: input.model ? modelOf(input.model) : undefined,
            projectId: input.projectId ? ProjectId.make(input.projectId) : null,
            links: input.links,
            blockedBy,
            stage: input.stage,
            question: input.question ?? null,
            reviewChain: input.reviewChain ?? null,
          },
          caller.actor,
        );
        return { card };
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
            ...(input.projectId !== undefined
              ? { projectId: input.projectId === null ? null : ProjectId.make(input.projectId) }
              : {}),
            links: input.links,
            blockedBy,
            ...(input.reviewChain !== undefined ? { reviewChain: input.reviewChain } : {}),
            comment: input.comment,
          },
          caller.actor,
        );
        return { card: edited };
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
        if (input.projectId && board.defaultProjectId === null) {
          return {
            board: yield* service.updateBoard(board.id, {
              defaultProjectId: ProjectId.make(input.projectId),
            }),
          };
        }
        return { board };
      }),
    ),
  ),

  evaluator_start: McpToolAccess.actsAsCaller((input) =>
    asEvaluator((service, caller) =>
      Effect.gen(function* () {
        const board = yield* boardFor(service, caller, input.boardId);
        const text = input.text?.trim() ?? "";
        let purpose: EvaluatorPurpose;
        if (input.kind === "setup" || input.kind === "request") {
          if (!text) return yield* invalid(`A ${input.kind} evaluator needs text.`);
          purpose = { kind: input.kind, text };
        } else {
          purpose = { kind: input.kind };
        }
        return { threadId: yield* service.startEvaluator(KanbanBoardId.make(board.id), purpose) };
      }),
    ),
  ),
} satisfies McpToolAccess.Handlers<typeof KanbanToolkit.tools>;

export const layer = McpToolAccess.toLayer(KanbanToolkit, handlers);
