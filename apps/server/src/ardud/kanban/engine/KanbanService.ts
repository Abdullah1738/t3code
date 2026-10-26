// @effect-diagnostics nodeBuiltinImport:off - record ids only need a random UUID.
import * as NodeCrypto from "node:crypto";

import {
  KANBAN_THREAD_STAGES,
  KanbanBoardId,
  KanbanCardId,
  KanbanDiscussionId,
  KanbanError,
  KanbanGoalId,
  type KanbanActor,
  type KanbanBlock,
  type KanbanBoard,
  type KanbanBoardSnapshot,
  type KanbanCard,
  type KanbanCardEvent,
  type KanbanChange,
  type KanbanDiscussion,
  type KanbanGoal,
  type KanbanGroup,
  type KanbanLink,
  type KanbanMessage,
  type KanbanParticipant,
  type KanbanPool,
  type KanbanStage,
  type KanbanThreadLink,
  type KanbanThreadState,
  type KanbanWikiPage,
  type ModelSelection,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ProjectService from "../../../project/ProjectService.ts";
import * as TextGeneration from "../../../textGeneration/TextGeneration.ts";
import { actorKey, KanbanStore } from "../store/KanbanStore.ts";
import * as Briefs from "./briefs.ts";
import * as Defaults from "./defaults.ts";
import * as Rules from "./rules.ts";
import { KanbanThreads } from "./threads.ts";

/** Typing shows while an agent's turn runs; refreshed by the tick, cleared at turn end. */
const TYPING_MS = 90_000;
const OWNER_NAME = "You";

export interface NewLink {
  readonly url: string;
  readonly label?: string | null | undefined;
  readonly kind?: KanbanLink["kind"] | undefined;
}

export interface NewCard {
  readonly prompt: string;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly priority?: number | undefined;
  readonly goalId?: KanbanGoal["id"] | null | undefined;
  readonly projects?: ReadonlyArray<string> | undefined;
  readonly model?: ModelSelection | undefined;
  readonly projectId?: ProjectId | null | undefined;
  readonly links?: ReadonlyArray<NewLink> | undefined;
  readonly blockedBy?: ReadonlyArray<KanbanCard["id"]> | undefined;
  readonly stage?: "todo" | "needs_owner" | undefined;
  readonly question?: string | null | undefined;
  readonly reviewChain?: string | null | undefined;
}

export interface CardPatch {
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly prompt?: string | undefined;
  readonly priority?: number | undefined;
  readonly goalId?: KanbanGoal["id"] | null | undefined;
  readonly projects?: ReadonlyArray<string> | undefined;
  readonly model?: ModelSelection | undefined;
  readonly projectId?: ProjectId | null | undefined;
  /** Added or relabelled by URL; existing links stay. */
  readonly links?: ReadonlyArray<NewLink> | undefined;
  readonly blockedBy?: ReadonlyArray<KanbanCard["id"]> | undefined;
  readonly reviewChain?: string | null | undefined;
  readonly comment?: string | undefined;
}

export interface GoalInput {
  readonly id?: KanbanGoal["id"] | undefined;
  readonly name?: string | undefined;
  readonly status?: KanbanGoal["status"] | undefined;
  readonly now?: string | undefined;
  /** Appended to the numbered story. */
  readonly story?: string | undefined;
}

export type BoardPatch = Partial<
  Pick<
    KanbanBoard,
    | "name"
    | "defaultProjectId"
    | "managerModel"
    | "evaluatorModel"
    | "defaultCardModel"
    | "reviewChains"
    | "defaultReviewChain"
    | "instructions"
  >
>;

export interface CardDetail {
  readonly card: KanbanCard;
  readonly events: ReadonlyArray<KanbanCardEvent>;
  readonly threads: ReadonlyArray<KanbanThreadLink>;
}

export type KanbanWatchEvent =
  | { readonly _tag: "snapshot"; readonly snapshot: KanbanBoardSnapshot }
  | { readonly _tag: "change"; readonly change: KanbanChange };

export interface KanbanServiceShape {
  readonly boards: Effect.Effect<ReadonlyArray<KanbanBoard>, KanbanError>;
  readonly ensureBoard: (input: {
    readonly slug: string;
    readonly name: string;
    readonly defaultProjectId: ProjectId | null;
  }) => Effect.Effect<KanbanBoard, KanbanError>;
  readonly updateBoard: (
    boardId: KanbanBoard["id"],
    patch: BoardPatch,
  ) => Effect.Effect<KanbanBoard, KanbanError>;
  readonly snapshot: (
    boardId: KanbanBoard["id"],
  ) => Effect.Effect<KanbanBoardSnapshot, KanbanError>;
  readonly watch: (boardId: KanbanBoard["id"]) => Stream.Stream<KanbanWatchEvent, KanbanError>;

  readonly card: (cardId: KanbanCard["id"]) => Effect.Effect<CardDetail, KanbanError>;
  readonly createCard: (
    boardId: KanbanBoard["id"],
    input: NewCard,
    actor: KanbanActor,
  ) => Effect.Effect<KanbanCard, KanbanError>;
  readonly editCard: (
    cardId: KanbanCard["id"],
    patch: CardPatch,
    actor: KanbanActor,
  ) => Effect.Effect<KanbanCard, KanbanError>;
  readonly moveCard: (
    cardId: KanbanCard["id"],
    to: KanbanStage,
    role: Rules.MoveRole,
    actor: KanbanActor,
    options?: {
      readonly note?: string | null | undefined;
      readonly question?: string | null | undefined;
    },
  ) => Effect.Effect<KanbanCard, KanbanError>;
  readonly flagCard: (
    cardId: KanbanCard["id"],
    reason: string | null,
    actor: KanbanActor,
  ) => Effect.Effect<KanbanCard, KanbanError>;
  readonly settleCard: (cardId: KanbanCard["id"]) => Effect.Effect<KanbanCard, KanbanError>;
  readonly reviewResult: (
    threadId: ThreadId,
    verdict: "clear" | "findings",
    findings: ReadonlyArray<string>,
  ) => Effect.Effect<KanbanCard, KanbanError>;
  readonly cardThread: (
    cardId: KanbanCard["id"],
    action: "steer" | "stop" | "wake",
    text: string,
    actor: KanbanActor,
  ) => Effect.Effect<KanbanCard, KanbanError>;

  readonly setPool: (
    boardId: KanbanBoard["id"],
    model: ModelSelection,
    slots: number,
  ) => Effect.Effect<ReadonlyArray<KanbanPool>, KanbanError>;
  readonly setGoal: (
    boardId: KanbanBoard["id"],
    input: GoalInput,
  ) => Effect.Effect<KanbanGoal, KanbanError>;
  readonly setGroups: (
    boardId: KanbanBoard["id"],
    groups: ReadonlyArray<Omit<KanbanGroup, "updatedAt">>,
  ) => Effect.Effect<void, KanbanError>;

  readonly discussions: (
    boardId: KanbanBoard["id"],
  ) => Effect.Effect<ReadonlyArray<KanbanDiscussion>, KanbanError>;
  readonly discussion: (id: KanbanDiscussion["id"]) => Effect.Effect<KanbanDiscussion, KanbanError>;
  readonly createDiscussion: (
    boardId: KanbanBoard["id"],
    title: string,
    actor: KanbanActor,
  ) => Effect.Effect<KanbanDiscussion, KanbanError>;
  readonly cardDiscussion: (
    cardId: KanbanCard["id"],
  ) => Effect.Effect<KanbanDiscussion, KanbanError>;
  readonly messages: (
    id: KanbanDiscussion["id"],
    options?: { readonly afterSeq?: number; readonly limit?: number },
  ) => Effect.Effect<ReadonlyArray<KanbanMessage>, KanbanError>;
  readonly post: (
    discussionId: KanbanDiscussion["id"],
    author: KanbanActor,
    blocks: ReadonlyArray<KanbanBlock>,
  ) => Effect.Effect<KanbanMessage, KanbanError>;
  readonly answer: (
    discussionId: KanbanDiscussion["id"],
    seq: number,
    blockId: string,
    choice: ReadonlyArray<string>,
    by: KanbanActor,
  ) => Effect.Effect<KanbanMessage, KanbanError>;
  readonly markRead: (
    discussionId: KanbanDiscussion["id"],
    actor: KanbanActor,
    seq: number,
  ) => Effect.Effect<void, KanbanError>;

  readonly wiki: (
    boardId: KanbanBoard["id"],
  ) => Effect.Effect<ReadonlyArray<KanbanWikiPage>, KanbanError>;
  readonly writeWiki: (
    boardId: KanbanBoard["id"],
    page: { readonly slug: string; readonly title: string; readonly body: string },
    actor: KanbanActor,
  ) => Effect.Effect<KanbanWikiPage, KanbanError>;

  /** Starts an evaluator thread for a board job (setup, owner request, sweeps). */
  readonly startEvaluator: (
    boardId: KanbanBoard["id"],
    purpose: Briefs.EvaluatorPurpose,
    text?: string,
  ) => Effect.Effect<ThreadId, KanbanError>;
  /** The board link of a calling thread, or null for threads the board did not start. */
  readonly caller: (threadId: string) => Effect.Effect<KanbanThreadLink | null, KanbanError>;

  /** Runs dispatch for every board now. */
  readonly dispatchNow: Effect.Effect<void, KanbanError>;
  /** Handles a finished turn of a board thread now. */
  readonly turnEnded: (threadId: ThreadId) => Effect.Effect<void, KanbanError>;
  /** Periodic upkeep: typing heartbeat, PR states, dispatch. */
  readonly tick: Effect.Effect<void, KanbanError>;
  /** Queues a finished turn for the worker. */
  readonly notifyTurnEnded: (threadId: ThreadId) => Effect.Effect<void>;
  /** Background worker: runs queued dispatch kicks and turn ends; never returns. */
  readonly worker: Effect.Effect<never>;
}

export class KanbanService extends Context.Service<KanbanService, KanbanServiceShape>()(
  "t3/ardud/kanban/engine/KanbanService",
) {}

type Job = { readonly _tag: "kick" } | { readonly _tag: "turnEnd"; readonly threadId: ThreadId };

const WriterOutput = Schema.Struct({ title: Schema.String, description: Schema.String });

const uuid = () => NodeCrypto.randomUUID();

const failWith = (code: KanbanError["code"], detail: string) =>
  Effect.fail(new KanbanError({ code, detail }));

const isKanbanError = Schema.is(KanbanError);

const toKanbanError = (error: unknown): KanbanError => {
  if (isKanbanError(error)) return error;
  const detail =
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
      ? error.message
      : String(error);
  return new KanbanError({ code: "failed", detail });
};

const clampPriority = (value: number | undefined, fallback: number) => {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(4, Math.max(1, Math.round(value)));
};

const linkKind = (url: string): KanbanLink["kind"] => {
  if (/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(url)) return "pr";
  if (/linear\.app\//.test(url)) return "linear";
  return "url";
};

export const mergeLinks = (
  existing: ReadonlyArray<KanbanLink>,
  added: ReadonlyArray<NewLink>,
): ReadonlyArray<KanbanLink> => {
  const next = [...existing];
  for (const input of added) {
    const url = input.url.trim();
    if (url.length === 0) continue;
    const index = next.findIndex((link) => link.url === url);
    if (index >= 0) {
      const current = next[index]!;
      next[index] = { ...current, label: input.label ?? current.label };
      continue;
    }
    next.push({
      kind: input.kind ?? linkKind(url),
      url,
      label: input.label ?? null,
      state: null,
      checkedAt: null,
    });
  }
  return next;
};

const fallbackTitle = (prompt: string) => {
  const first = prompt.trim().split("\n")[0] ?? "";
  return first.length > 60 ? `${first.slice(0, 57).trimEnd()}...` : first || "Untitled";
};

/** Plain text of a message for agents. */
export const blocksText = (blocks: ReadonlyArray<KanbanBlock>) =>
  blocks
    .map((block) => {
      switch (block._tag) {
        case "md":
          return block.text;
        case "collapse":
          return `${block.title}\n${block.text}`;
        case "html":
          return `[visual${block.title ? `: ${block.title}` : ""}]`;
        case "choice":
          return `${block.question} (${block.multi ? "pick any" : "pick one"}: ${block.options.map((option) => `${option.id} = ${option.label}`).join(", ")})`;
        case "card":
          return `[card ${block.cardId}]`;
        case "image":
          return `[image${block.alt ? `: ${block.alt}` : ""}]`;
      }
    })
    .join("\n\n");

const roleName = (role: KanbanThreadLink["role"]) =>
  role === "work" ? "Worker" : role === "review" ? "Reviewer" : "Evaluator";

const make = Effect.gen(function* () {
  const store = yield* KanbanStore;
  const threads = yield* KanbanThreads;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const projects = yield* ProjectService.ProjectService;
  const scope = yield* Effect.scope;

  const lock = yield* Semaphore.make(1);
  const changes = yield* PubSub.unbounded<{
    readonly boardId: string;
    readonly change: KanbanChange;
  }>();
  const jobs = yield* Queue.unbounded<Job>();
  const kickPending = yield* Ref.make(false);

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const nowMillis = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
  const publish = (boardId: string, change: KanbanChange) =>
    PubSub.publish(changes, { boardId, change });

  const kick = Effect.gen(function* () {
    const pending = yield* Ref.getAndSet(kickPending, true);
    if (!pending) yield* Queue.offer(jobs, { _tag: "kick" });
  });

  const boardOf = Effect.fn("KanbanService.boardOf")(function* (boardId: string) {
    const board = (yield* store.boards).find((candidate) => candidate.id === boardId);
    if (!board) return yield* failWith("not-found", `board ${boardId}`);
    return board;
  });

  /**
   * Agents write model ids in many shapes ("opus/x" vs instance "opus" + "x"). Match the
   * request to one of the board's pools so the dispatcher can run it; a model with no pool
   * would sit in To-Do forever.
   */
  const poolModel = Effect.fn("KanbanService.poolModel")(function* (
    boardId: KanbanBoardId,
    model: ModelSelection,
  ) {
    const pools = yield* store.pools(boardId);
    const key = Rules.poolKey(model);
    const joined = `${model.instanceId}/${model.model}`;
    const match =
      pools.find((pool) => pool.key === key) ??
      pools.find((pool) => pool.model.model === joined || pool.model.model === model.model) ??
      (() => {
        const suffix = pools.filter((pool) => pool.model.model.endsWith(`/${model.model}`));
        return suffix.length === 1 ? suffix[0] : undefined;
      })();
    if (!match) {
      return yield* failWith(
        "invalid",
        `no pool runs ${joined}; pools: ${pools.map((pool) => pool.model.model).join(", ") || "none"}`,
      );
    }
    return {
      instanceId: match.model.instanceId,
      model: match.model.model,
      ...(model.options
        ? { options: model.options }
        : match.model.options
          ? { options: match.model.options }
          : {}),
    } satisfies ModelSelection;
  });

  const cardOf = Effect.fn("KanbanService.cardOf")(function* (cardId: KanbanCard["id"]) {
    const card = yield* store.card(cardId);
    if (!card) return yield* failWith("not-found", `card ${cardId}`);
    return card;
  });

  const discussionOf = Effect.fn("KanbanService.discussionOf")(function* (
    id: KanbanDiscussion["id"],
  ) {
    const discussion = yield* store.discussion(id);
    if (!discussion) return yield* failWith("not-found", `discussion ${id}`);
    return discussion;
  });

  const goalOf = Effect.fn("KanbanService.goalOf")(function* (card: KanbanCard) {
    if (card.goalId === null) return null;
    return (yield* store.goals(card.boardId)).find((goal) => goal.id === card.goalId) ?? null;
  });

  const threadState = Effect.fn("KanbanService.threadState")(function* (threadId: ThreadId) {
    const view = yield* threads.view(threadId);
    if (!view) return [];
    const state: KanbanThreadState = {
      threadId,
      title: view.title,
      running: view.state !== "idle",
      lastActivityAt: view.updatedAt,
    };
    return [state];
  });

  const snapshotOf = Effect.fn("KanbanService.snapshotOf")(function* (boardId: KanbanBoard["id"]) {
    const board = yield* boardOf(boardId);
    const cards = yield* store.cards(boardId);
    const live = cards.flatMap((card) => (card.activeThreadId ? [card.activeThreadId] : []));
    const states = yield* Effect.forEach(live, threadState, { concurrency: 8 });
    const discussions = yield* store.discussions(boardId);
    const unread = discussions.flatMap((discussion) => {
      const owner = discussion.participants.find(
        (participant) => participant.actor._tag === "owner",
      );
      const count = discussion.lastSeq - (owner?.lastReadSeq ?? 0);
      return count > 0 ? [{ discussionId: discussion.id, count }] : [];
    });
    return {
      board,
      cards,
      goals: yield* store.goals(boardId),
      pools: yield* store.pools(boardId),
      groups: yield* store.groups(boardId),
      threads: states.flat(),
      unread,
    } satisfies KanbanBoardSnapshot;
  });

  // Callers hold the lock, and log a card's event before saving it: clients
  // re-read the card's history when its change is published.

  const saveCard = Effect.fn("KanbanService.saveCard")(function* (card: KanbanCard) {
    yield* store.putCard(card);
    yield* publish(card.boardId, { _tag: "card", card });
  });

  const logEvent = Effect.fn("KanbanService.logEvent")(function* (
    card: KanbanCard,
    actor: KanbanActor,
    kind: KanbanCardEvent["kind"],
    extra: {
      readonly fromStage?: KanbanStage | null;
      readonly toStage?: KanbanStage | null;
      readonly body?: string | null;
    } = {},
  ) {
    return yield* store.addCardEvent({
      cardId: card.id,
      at: yield* nowIso,
      actor,
      kind,
      fromStage: extra.fromStage ?? null,
      toStage: extra.toStage ?? null,
      body: extra.body ?? null,
    });
  });

  const release = (card: KanbanCard) =>
    ({ ...card, activeThreadId: null, activeRole: null, activePool: null }) satisfies KanbanCard;

  const moveUnlocked = Effect.fn("KanbanService.moveUnlocked")(function* (
    card: KanbanCard,
    to: KanbanStage,
    role: Rules.MoveRole,
    actor: KanbanActor,
    options: {
      readonly note?: string | null | undefined;
      readonly question?: string | null | undefined;
    } = {},
  ) {
    const check = Rules.checkMove(role, card, to);
    if (!check.ok) return yield* failWith("denied", check.reason);
    const at = yield* nowIso;
    const leaving = card.activeThreadId !== null && !KANBAN_THREAD_STAGES.includes(to);
    // A thread moving its own card is mid-turn and finishes on its own.
    if (leaving && role !== "cardThread" && card.activeThreadId) {
      yield* threads.interrupt(card.activeThreadId, `Card #${card.number} moved to ${to}`);
    }
    const base = leaving ? release(card) : card;
    const next: KanbanCard = {
      ...base,
      stage: to,
      movedAt: at,
      updatedAt: at,
      question: to === "needs_owner" ? (options.question ?? card.question) : null,
      reviewStep: card.stage === "working" && to === "needs_review" ? 0 : card.reviewStep,
    };
    yield* logEvent(next, actor, "moved", {
      fromStage: card.stage,
      toStage: to,
      body: options.note ?? null,
    });
    yield* saveCard(next);
    yield* kick;
    return next;
  });

  /** Copies the work thread's tracked PRs (same source as the sidebar) onto the card. */
  const syncPrs = Effect.fn("KanbanService.syncPrs")(function* (card: KanbanCard) {
    if (card.workThreadId === null) return card;
    const view = yield* threads.view(card.workThreadId);
    if (!view || view.prs.length === 0) return card;
    const at = yield* nowIso;
    let changed = false;
    let links = mergeLinks(
      card.links,
      view.prs
        .filter((pr) => !card.links.some((link) => link.url === pr.url))
        .map((pr) => ({ url: pr.url, label: pr.title, kind: "pr" as const })),
    );
    if (links.length !== card.links.length) changed = true;
    links = links.map((link) => {
      const pr = view.prs.find((candidate) => candidate.url === link.url);
      if (!pr || link.state === pr.state) return link;
      changed = true;
      return { ...link, state: pr.state, checkedAt: at };
    });
    if (!changed) return card;
    const next = { ...card, links, updatedAt: at };
    yield* saveCard(next);
    return next;
  });

  const writeTitle = Effect.fn("KanbanService.writeTitle")(function* (
    cardId: KanbanCard["id"],
    fields: { readonly title: boolean; readonly description: boolean },
  ) {
    const generateJson = textGeneration.generateJson;
    if (!generateJson) return;
    const card = yield* cardOf(cardId);
    const board = yield* boardOf(card.boardId);
    const projectId = card.projectId ?? board.defaultProjectId;
    if (projectId === null) return;
    const project = yield* projects.getById(projectId);
    if (Option.isNone(project)) return;
    const written = yield* generateJson({
      cwd: project.value.workspaceRoot,
      prompt: Briefs.writerPrompt(card),
      outputSchema: WriterOutput,
      modelSelection: board.managerModel,
    });
    yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* cardOf(cardId);
        const title = written.title.trim().slice(0, 80);
        const description = written.description.trim();
        yield* saveCard({
          ...current,
          title: fields.title && title ? title : current.title,
          description: fields.description && description ? description : current.description,
          updatedAt: yield* nowIso,
        });
      }),
    );
  });

  const forkWriter = (
    cardId: KanbanCard["id"],
    fields: { readonly title: boolean; readonly description: boolean },
  ) =>
    writeTitle(cardId, fields).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("kanban title writer failed", { cardId, cause }),
      ),
      Effect.forkIn(scope),
      Effect.asVoid,
    );

  // Callers hold the lock.

  const withParticipant = (
    discussion: KanbanDiscussion,
    actor: KanbanActor,
    name: string,
    patch: Partial<Omit<KanbanParticipant, "actor">>,
  ): KanbanDiscussion => {
    const key = actorKey(actor);
    const index = discussion.participants.findIndex(
      (participant) => actorKey(participant.actor) === key,
    );
    const current: KanbanParticipant =
      index >= 0
        ? discussion.participants[index]!
        : { actor, name, lastReadSeq: 0, typingUntil: null, owes: null };
    const updated = { ...current, ...patch };
    const participants = [...discussion.participants];
    if (index >= 0) participants[index] = updated;
    else participants.push(updated);
    return { ...discussion, participants };
  };

  const saveDiscussion = Effect.fn("KanbanService.saveDiscussion")(function* (
    discussion: KanbanDiscussion,
  ) {
    yield* store.putDiscussion(discussion);
    yield* publish(discussion.boardId, { _tag: "discussion", discussion });
  });

  const newDiscussion = Effect.fn("KanbanService.newDiscussion")(function* (
    boardId: KanbanBoard["id"],
    title: string,
    cardId: KanbanCard["id"] | null,
    actor: KanbanActor,
  ) {
    const at = yield* nowIso;
    const discussion: KanbanDiscussion = {
      id: KanbanDiscussionId.make(`disc-${uuid()}`),
      boardId,
      cardId,
      title: title.trim() || "Discussion",
      evaluatorThreadId: null,
      participants: [
        {
          actor: { _tag: "owner" },
          name: OWNER_NAME,
          lastReadSeq: 0,
          typingUntil: null,
          owes: null,
        },
      ],
      lastSeq: 0,
      lastMessageAt: null,
      createdBy: actor,
      createdAt: at,
      archivedAt: null,
    };
    yield* saveDiscussion(discussion);
    return discussion;
  });

  const cardDiscussionUnlocked = Effect.fn("KanbanService.cardDiscussionUnlocked")(function* (
    cardId: KanbanCard["id"],
  ) {
    const card = yield* cardOf(cardId);
    if (card.discussionId !== null) {
      const existing = yield* store.discussion(card.discussionId);
      if (existing) return existing;
    }
    const discussion = yield* newDiscussion(
      card.boardId,
      `#${card.number} ${card.title}`,
      card.id,
      {
        _tag: "system",
        component: "kanban",
      },
    );
    yield* saveCard({ ...card, discussionId: discussion.id });
    return discussion;
  });

  const typingUntil = DateTime.now.pipe(
    Effect.map((now) => DateTime.formatIso(DateTime.add(now, { milliseconds: TYPING_MS }))),
  );

  /** Delivers text to an agent on behalf of a discussion and marks it as owing a reply. */
  const deliver = Effect.fn("KanbanService.deliver")(function* (
    discussion: KanbanDiscussion,
    actor: KanbanActor,
    name: string,
    threadId: ThreadId,
    text: string,
  ) {
    yield* threads.send({ threadId, text });
    const next = withParticipant(discussion, actor, name, {
      lastReadSeq: discussion.lastSeq,
      typingUntil: yield* typingUntil,
      owes: "asked",
    });
    yield* saveDiscussion(next);
    return next;
  });

  const startEvaluatorUnlocked = Effect.fn("KanbanService.startEvaluatorUnlocked")(function* (
    board: KanbanBoard,
    purpose: Briefs.EvaluatorPurpose,
    extra: { readonly text?: string | undefined; readonly cardId?: KanbanCard["id"] | null } = {},
  ) {
    if (board.defaultProjectId === null) {
      return yield* failWith("invalid", `board ${board.slug} has no default project`);
    }
    const at = yield* nowIso;
    const brief = Briefs.evaluatorBrief(board, purpose);
    const threadId = yield* threads.launch({
      key: `${board.id}:eval:${Briefs.purposeKey(purpose)}:${at}`,
      projectId: board.defaultProjectId,
      title: Briefs.evaluatorTitle(purpose),
      model: board.evaluatorModel,
      text: extra.text ? `${brief}\n\n${extra.text}` : brief,
    });
    yield* store.putThreadLink({
      threadId,
      boardId: board.id,
      cardId: extra.cardId ?? null,
      role: "evaluator",
      purpose: Briefs.purposeKey(purpose),
      discussionId:
        purpose.kind === "discussion" ? KanbanDiscussionId.make(purpose.discussionId) : null,
      model: board.evaluatorModel,
      startedAt: at,
      endedAt: null,
    });
    return threadId;
  });

  /** The discussion's evaluator gets the text: an existing one is steered, otherwise one starts. */
  const toEvaluator = Effect.fn("KanbanService.toEvaluator")(function* (
    discussion: KanbanDiscussion,
    text: string,
  ) {
    const actorOf = (threadId: ThreadId): KanbanActor => ({ _tag: "evaluator", threadId });
    if (discussion.evaluatorThreadId !== null) {
      const view = yield* threads.view(discussion.evaluatorThreadId);
      if (view) {
        return yield* deliver(
          discussion,
          actorOf(discussion.evaluatorThreadId),
          "Evaluator",
          discussion.evaluatorThreadId,
          text,
        );
      }
    }
    const board = yield* boardOf(discussion.boardId);
    const card = discussion.cardId ? yield* store.card(discussion.cardId) : null;
    const threadId = yield* startEvaluatorUnlocked(
      board,
      {
        kind: "discussion",
        discussionId: discussion.id,
        title: discussion.title,
        cardNumber: card?.number ?? null,
      },
      { text, cardId: discussion.cardId },
    );
    const next = withParticipant(
      { ...discussion, evaluatorThreadId: threadId },
      actorOf(threadId),
      "Evaluator",
      {
        lastReadSeq: discussion.lastSeq,
        typingUntil: yield* typingUntil,
        owes: "asked",
      },
    );
    yield* saveDiscussion(next);
    return next;
  });

  /**
   * Owner (or script) text in a discussion reaches whoever owns it: the card's
   * live thread, the card's work thread when it waits on the owner, else the
   * discussion's evaluator.
   */
  const routeToOwnerAgent = Effect.fn("KanbanService.routeToOwnerAgent")(function* (
    discussion: KanbanDiscussion,
    text: string,
  ) {
    if (discussion.cardId !== null) {
      const card = yield* cardOf(discussion.cardId);
      if (card.stage === "needs_owner" && card.workThreadId !== null) {
        const at = yield* nowIso;
        const next: KanbanCard = {
          ...card,
          stage: "todo",
          question: null,
          stalled: null,
          wakeNote: text,
          movedAt: at,
          updatedAt: at,
        };
        yield* logEvent(next, { _tag: "owner" }, "moved", {
          fromStage: card.stage,
          toStage: "todo",
          body: "Owner replied",
        });
        yield* saveCard(next);
        yield* saveDiscussion(
          withParticipant(discussion, { _tag: "thread", threadId: card.workThreadId }, "Worker", {
            lastReadSeq: discussion.lastSeq,
            owes: "asked",
          }),
        );
        yield* kick;
        return;
      }
      if (card.activeThreadId !== null && card.activeRole !== null) {
        yield* deliver(
          discussion,
          { _tag: "thread", threadId: card.activeThreadId },
          roleName(card.activeRole),
          card.activeThreadId,
          text,
        );
        return;
      }
    }
    yield* toEvaluator(discussion, text);
  });

  const postUnlocked = Effect.fn("KanbanService.postUnlocked")(function* (
    discussionId: KanbanDiscussion["id"],
    author: KanbanActor,
    blocks: ReadonlyArray<KanbanBlock>,
  ) {
    if (blocks.length === 0)
      return yield* failWith("invalid", "a message needs at least one block");
    const discussion = yield* discussionOf(discussionId);
    const at = yield* nowIso;
    let authorName = OWNER_NAME;
    if (author._tag === "thread" || author._tag === "evaluator") {
      const link = yield* store.threadLink(author.threadId);
      authorName = link ? roleName(link.role) : "Agent";
    } else if (author._tag === "script") {
      authorName = (yield* store.script(author.scriptId))?.name ?? "Script";
    } else if (author._tag === "system") {
      authorName = "Board";
    }
    const message: KanbanMessage = {
      discussionId,
      seq: discussion.lastSeq + 1,
      author,
      authorName,
      blocks,
      answers: [],
      createdAt: at,
    };
    yield* store.putMessage(message);
    const posted = withParticipant(
      { ...discussion, lastSeq: message.seq, lastMessageAt: at },
      author,
      authorName,
      {
        lastReadSeq: message.seq,
        typingUntil: null,
        owes: null,
      },
    );
    yield* saveDiscussion(posted);
    yield* publish(discussion.boardId, { _tag: "message", message });

    const text = blocksText(blocks);
    if (author._tag === "owner") {
      yield* routeToOwnerAgent(posted, Briefs.ownerMessageText(posted.title, posted.id, text));
    } else if (author._tag === "script") {
      yield* routeToOwnerAgent(
        posted,
        `Script "${authorName}" posted in "${posted.title}" (discussion ${posted.id}):\n\n${text}`,
      );
    } else if (author._tag === "evaluator" && posted.cardId !== null) {
      // An evaluator in a card discussion speaks to the card's live thread too.
      const card = yield* cardOf(posted.cardId);
      if (card.activeThreadId !== null && card.activeThreadId !== author.threadId) {
        yield* threads.send({
          threadId: card.activeThreadId,
          text: `Evaluator in the card discussion (${posted.id}):\n\n${text}`,
        });
      }
    }
    return message;
  });

  /** A finished turn settles the agent's typing and, once, nudges an unanswered discussion. */
  const settleParticipant = Effect.fn("KanbanService.settleParticipant")(function* (
    discussion: KanbanDiscussion,
    threadId: ThreadId,
  ) {
    const participant = discussion.participants.find(
      (candidate) =>
        (candidate.actor._tag === "thread" || candidate.actor._tag === "evaluator") &&
        candidate.actor.threadId === threadId,
    );
    if (!participant) return;
    if (participant.owes === "asked") {
      yield* threads
        .send({ threadId, text: Briefs.nudgeDiscussionText(discussion.id) })
        .pipe(Effect.ignore);
      yield* saveDiscussion(
        withParticipant(discussion, participant.actor, participant.name, {
          owes: "nudged",
          typingUntil: yield* typingUntil,
        }),
      );
      return;
    }
    if (participant.typingUntil !== null || participant.owes !== null) {
      yield* saveDiscussion(
        withParticipant(discussion, participant.actor, participant.name, {
          owes: null,
          typingUntil: null,
        }),
      );
    }
  });

  const startCard = Effect.fn("KanbanService.startCard")(function* (
    board: KanbanBoard,
    dispatch: Rules.Dispatch,
  ) {
    const card = yield* cardOf(dispatch.cardId);
    const projectId = card.projectId ?? board.defaultProjectId;
    const at = yield* nowIso;
    const system: KanbanActor = { _tag: "system", component: "dispatcher" };
    if (projectId === null) {
      const next = {
        ...card,
        stalled: { reason: "No project set for this card", by: system, at },
        updatedAt: at,
      };
      yield* logEvent(next, system, "flagged", { body: "No project set for this card" });
      yield* saveCard(next);
      return;
    }
    const goal = yield* goalOf(card);
    const existing = dispatch.role === "work" ? card.workThreadId : card.reviewThreadId;
    let threadId: ThreadId | null = null;
    if (existing !== null) {
      const view = yield* threads.view(existing);
      // A turn still finishing (for example the one that called card_move) gets
      // the next message only after it ends; the next pass retries.
      if (view && view.state !== "idle") return;
      if (view) threadId = existing;
    }
    const synced = dispatch.role === "review" ? yield* syncPrs(card) : card;
    let text: string;
    if (dispatch.role === "work") {
      text = threadId ? Briefs.wakeText(synced) : Briefs.workBrief(board, synced, goal);
    } else {
      const events = yield* store.cardEvents(card.id);
      const findings = events
        .filter((event) => event.kind === "review" && event.toStage === "todo" && event.body)
        .map((event) => event.body ?? "");
      text = Briefs.reviewBrief(board, synced, goal, Rules.chainFor(board, synced), findings);
    }
    if (threadId) {
      yield* threads.send({ threadId, text, model: dispatch.model });
    } else {
      threadId = yield* threads.launch({
        key: `${card.id}:${dispatch.role}:${at}`,
        projectId,
        title:
          dispatch.role === "work"
            ? `#${card.number} ${card.title}`
            : `#${card.number} review: ${card.title}`,
        model: dispatch.model,
        text,
      });
      yield* store.putThreadLink({
        threadId,
        boardId: board.id,
        cardId: card.id,
        role: dispatch.role,
        purpose: null,
        discussionId: null,
        model: dispatch.model,
        startedAt: at,
        endedAt: null,
      });
      yield* logEvent(card, system, "thread", { body: `${dispatch.role} thread ${threadId}` });
    }
    const to: KanbanStage = dispatch.role === "work" ? "working" : "in_review";
    const next: KanbanCard = {
      ...synced,
      stage: to,
      activeThreadId: threadId,
      activeRole: dispatch.role,
      activePool: dispatch.pool,
      workThreadId: dispatch.role === "work" ? threadId : synced.workThreadId,
      reviewThreadId: dispatch.role === "review" ? threadId : synced.reviewThreadId,
      wakeNote: dispatch.role === "work" ? null : synced.wakeNote,
      nudgedAt: null,
      movedAt: at,
      updatedAt: at,
    };
    yield* logEvent(next, system, "moved", { fromStage: card.stage, toStage: to });
    yield* saveCard(next);
  });

  const dispatchUnlocked = Effect.fn("KanbanService.dispatchUnlocked")(function* () {
    yield* Ref.set(kickPending, false);
    for (const board of yield* store.boards) {
      if (board.archivedAt !== null) continue;
      const plan = Rules.planDispatch(
        board,
        yield* store.cards(board.id),
        yield* store.pools(board.id),
      );
      for (const dispatch of plan) {
        yield* startCard(board, dispatch).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("kanban dispatch failed", { cardId: dispatch.cardId, cause }),
          ),
        );
      }
    }
  });

  const turnEndedUnlocked = Effect.fn("KanbanService.turnEndedUnlocked")(function* (
    threadId: ThreadId,
  ) {
    const link = yield* store.threadLink(threadId);
    if (!link) return;
    const at = yield* nowIso;
    const card = link.cardId ? yield* store.card(link.cardId) : null;

    const discussionIds = new Set<string>();
    if (link.discussionId) discussionIds.add(link.discussionId);
    if (card?.discussionId) discussionIds.add(card.discussionId);
    for (const id of discussionIds) {
      const discussion = yield* store.discussion(KanbanDiscussionId.make(id));
      if (discussion) yield* settleParticipant(discussion, threadId);
    }

    if (link.role === "evaluator") {
      if (link.discussionId === null && link.endedAt === null) {
        yield* store.putThreadLink({ ...link, endedAt: at });
      }
      return;
    }
    if (!card) return;
    const synced = link.role === "work" ? yield* syncPrs(card) : card;
    if (synced.activeThreadId !== threadId) {
      yield* kick;
      return;
    }
    const system: KanbanActor = { _tag: "system", component: "dispatcher" };
    if (synced.nudgedAt === null) {
      yield* threads
        .send({
          threadId,
          text:
            link.role === "work" ? Briefs.nudgeWorkText(synced) : Briefs.nudgeReviewText(synced),
        })
        .pipe(Effect.ignore);
      yield* saveCard({ ...synced, nudgedAt: at, updatedAt: at });
      return;
    }
    // A worker may be waiting on CI or a deploy, so it keeps its slot; the
    // stalled sweep looks at idle Working cards. A reviewer that still has no
    // verdict after the nudge frees its slot and is flagged.
    if (link.role === "work") return;
    const reason = "Reviewer stopped without a verdict";
    const next: KanbanCard = {
      ...release(synced),
      stage: "needs_review",
      stalled: { reason, by: system, at },
      nudgedAt: null,
      movedAt: at,
      updatedAt: at,
    };
    yield* logEvent(next, system, "flagged", {
      fromStage: synced.stage,
      toStage: next.stage,
      body: reason,
    });
    yield* saveCard(next);
    yield* kick;
  });

  const tickUnlocked = Effect.fn("KanbanService.tickUnlocked")(function* () {
    const now = yield* nowMillis;
    for (const board of yield* store.boards) {
      if (board.archivedAt !== null) continue;
      // Typing heartbeat.
      for (const discussion of yield* store.discussions(board.id)) {
        let next = discussion;
        for (const participant of discussion.participants) {
          if (participant.typingUntil === null) continue;
          const actor = participant.actor;
          if (actor._tag !== "thread" && actor._tag !== "evaluator") continue;
          const view = yield* threads.view(actor.threadId);
          if (view && view.state !== "idle") {
            next = withParticipant(next, actor, participant.name, {
              typingUntil: yield* typingUntil,
            });
          } else if (Date.parse(participant.typingUntil) < now) {
            next = withParticipant(next, actor, participant.name, { typingUntil: null });
          }
        }
        if (next !== discussion) yield* saveDiscussion(next);
      }
      // Reviewed cards wait in review until their PRs land.
      const chains = board.reviewChains;
      for (const card of yield* store.cards(board.id)) {
        if (card.stage !== "in_review" || card.activeThreadId !== null) continue;
        const chain = Rules.chainFor({ ...board, reviewChains: chains }, card);
        if (!Rules.reviewFinished(card, chain?.steps.length ?? 1)) continue;
        const synced = yield* syncPrs(card);
        if (Rules.prsLanded(synced)) {
          yield* moveUnlocked(
            synced,
            "completed",
            "system",
            { _tag: "system", component: "dispatcher" },
            {
              note: "PRs landed",
            },
          );
        }
      }
    }
    yield* dispatchUnlocked();
  });

  const guard = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    lock.withPermits(1)(effect).pipe(Effect.mapError(toKanbanError));
  const read = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError(toKanbanError));

  const ensureBoard: KanbanServiceShape["ensureBoard"] = (input) =>
    guard(
      Effect.gen(function* () {
        const slug = input.slug.trim().toLowerCase();
        const existing = (yield* store.boards).find((board) => board.slug === slug);
        if (existing) return existing;
        const board: KanbanBoard = {
          id: KanbanBoardId.make(`board-${slug}`),
          slug,
          name: input.name.trim() || slug,
          defaultProjectId: input.defaultProjectId,
          managerModel: Defaults.DEFAULT_MANAGER_MODEL,
          evaluatorModel: Defaults.DEFAULT_EVALUATOR_MODEL,
          defaultCardModel: Defaults.DEFAULT_CARD_MODEL,
          reviewChains: Defaults.DEFAULT_REVIEW_CHAINS,
          defaultReviewChain: Defaults.DEFAULT_REVIEW_CHAIN,
          instructions: Defaults.DEFAULT_INSTRUCTIONS,
          createdAt: yield* nowIso,
          archivedAt: null,
        };
        yield* store.putBoard(board);
        for (const pool of Defaults.DEFAULT_POOLS) {
          yield* store.putPool(board.id, {
            key: Rules.poolKey(pool.model),
            model: pool.model,
            slots: pool.slots,
          });
        }
        yield* publish(board.id, { _tag: "board", board });
        return board;
      }),
    );

  const updateBoard: KanbanServiceShape["updateBoard"] = (boardId, patch) =>
    guard(
      Effect.gen(function* () {
        const board = yield* boardOf(boardId);
        const next: KanbanBoard = { ...board, ...patch };
        yield* store.putBoard(next);
        yield* publish(board.id, { _tag: "board", board: next });
        yield* kick;
        return next;
      }),
    );

  const createCard: KanbanServiceShape["createCard"] = (boardId, input, actor) =>
    guard(
      Effect.gen(function* () {
        const board = yield* boardOf(boardId);
        const prompt = input.prompt.trim();
        if (prompt.length === 0 && !input.title?.trim()) {
          return yield* failWith("invalid", "a card needs a prompt or a title");
        }
        const at = yield* nowIso;
        const stage = input.stage ?? "todo";
        const card: KanbanCard = {
          id: KanbanCardId.make(`card-${uuid()}`),
          boardId,
          number: yield* store.nextCardNumber(boardId),
          title: input.title?.trim() || fallbackTitle(prompt),
          description: input.description?.trim() ?? "",
          prompt,
          stage,
          priority: clampPriority(input.priority, 3),
          goalId: input.goalId ?? null,
          projects: input.projects ?? [],
          model: input.model ? yield* poolModel(boardId, input.model) : board.defaultCardModel,
          projectId: input.projectId ?? null,
          links: mergeLinks([], input.links ?? []),
          blockedBy: input.blockedBy ?? [],
          stalled: null,
          question: stage === "needs_owner" ? (input.question ?? null) : null,
          reviewChain: input.reviewChain ?? null,
          reviewStep: 0,
          reviewRound: 0,
          activeThreadId: null,
          activeRole: null,
          activePool: null,
          workThreadId: null,
          reviewThreadId: null,
          discussionId: null,
          wakeNote: null,
          nudgedAt: null,
          settledAt: null,
          createdBy: actor,
          createdAt: at,
          updatedAt: at,
          movedAt: at,
        };
        yield* logEvent(card, actor, "created", { toStage: stage });
        yield* saveCard(card);
        const needTitle = !input.title?.trim();
        const needDescription = !input.description?.trim();
        if (prompt.length > 0 && (needTitle || needDescription)) {
          yield* forkWriter(card.id, { title: needTitle, description: needDescription });
        }
        yield* kick;
        return card;
      }),
    );

  const editCard: KanbanServiceShape["editCard"] = (cardId, patch, actor) =>
    guard(
      Effect.gen(function* () {
        const card = yield* cardOf(cardId);
        const at = yield* nowIso;
        const next: KanbanCard = {
          ...card,
          title: patch.title?.trim() || card.title,
          description: patch.description?.trim() ?? card.description,
          prompt: patch.prompt?.trim() || card.prompt,
          priority: clampPriority(patch.priority, card.priority),
          goalId: patch.goalId === undefined ? card.goalId : patch.goalId,
          projects: patch.projects ?? card.projects,
          model: patch.model ? yield* poolModel(card.boardId, patch.model) : card.model,
          projectId: patch.projectId === undefined ? card.projectId : patch.projectId,
          links: patch.links ? mergeLinks(card.links, patch.links) : card.links,
          blockedBy: patch.blockedBy ?? card.blockedBy,
          reviewChain: patch.reviewChain === undefined ? card.reviewChain : patch.reviewChain,
          updatedAt: at,
        };
        const changed = Object.entries(patch)
          .filter(([key, value]) => key !== "comment" && value !== undefined)
          .map(([key]) => key);
        if (changed.length > 0)
          yield* logEvent(next, actor, patch.links ? "linked" : "edited", {
            body: changed.join(", "),
          });
        if (patch.comment?.trim())
          yield* logEvent(next, actor, "comment", { body: patch.comment.trim() });
        yield* saveCard(next);
        if (patch.prompt?.trim() && patch.prompt.trim() !== card.prompt && !patch.title) {
          yield* forkWriter(card.id, { title: true, description: !patch.description });
        }
        yield* kick;
        return next;
      }),
    );

  const moveCard: KanbanServiceShape["moveCard"] = (cardId, to, role, actor, options) =>
    guard(
      Effect.gen(function* () {
        const card = yield* cardOf(cardId);
        if (role === "cardThread") {
          if (actor._tag !== "thread" || card.activeThreadId !== actor.threadId) {
            return yield* failWith("denied", `card #${card.number} is not assigned to this thread`);
          }
          if (to === "needs_owner" && !options?.question?.trim()) {
            return yield* failWith("invalid", "needs_owner needs the question for the owner");
          }
        }
        const moved = yield* moveUnlocked(card, to, role, actor, options ?? {});
        if (to === "needs_review") return yield* syncPrs(moved);
        if (to === "needs_owner" && options?.question?.trim()) {
          const discussion = yield* cardDiscussionUnlocked(moved.id);
          yield* postUnlocked(discussion.id, actor, [
            { _tag: "md", text: options.question.trim() },
          ]);
          return yield* cardOf(moved.id);
        }
        return moved;
      }),
    );

  const flagCard: KanbanServiceShape["flagCard"] = (cardId, reason, actor) =>
    guard(
      Effect.gen(function* () {
        const card = yield* cardOf(cardId);
        const at = yield* nowIso;
        const selfFlag =
          reason !== null && actor._tag === "thread" && card.activeThreadId === actor.threadId;
        const flagged: KanbanCard = {
          ...card,
          stalled: reason === null ? null : { reason, by: actor, at },
          updatedAt: at,
        };
        // A thread that can't go on frees its slot; it ends its turn on its own.
        const next: KanbanCard = selfFlag
          ? {
              ...release(flagged),
              stage: card.activeRole === "review" ? "needs_review" : "todo",
              movedAt: at,
            }
          : flagged;
        yield* logEvent(next, actor, "flagged", {
          fromStage: card.stage,
          toStage: next.stage,
          body: reason ?? "Cleared",
        });
        yield* saveCard(next);
        yield* kick;
        return next;
      }),
    );

  const settleCard: KanbanServiceShape["settleCard"] = (cardId) =>
    guard(
      Effect.gen(function* () {
        const card = yield* cardOf(cardId);
        if (card.stage !== "verified")
          return yield* failWith("denied", "only verified cards can be settled");
        const at = yield* nowIso;
        const next = { ...card, settledAt: at, updatedAt: at };
        yield* logEvent(next, { _tag: "owner" }, "edited", { body: "Settled" });
        yield* saveCard(next);
        return next;
      }),
    );

  const reviewResult: KanbanServiceShape["reviewResult"] = (threadId, verdict, findings) =>
    guard(
      Effect.gen(function* () {
        const link = yield* store.threadLink(threadId);
        if (!link || link.role !== "review" || link.cardId === null) {
          return yield* failWith("denied", "only a card's review thread records a review result");
        }
        const card = yield* cardOf(link.cardId);
        if (card.activeThreadId !== threadId || card.stage !== "in_review") {
          return yield* failWith(
            "conflict",
            `card #${card.number} is not in review with this thread`,
          );
        }
        if (verdict === "findings" && findings.length === 0) {
          return yield* failWith("invalid", "findings need at least one line");
        }
        const board = yield* boardOf(card.boardId);
        const chain = Rules.chainFor(board, card);
        const outcome = Rules.applyReviewResult(card, chain?.steps.length ?? 1, verdict);
        const at = yield* nowIso;
        const body =
          verdict === "findings" ? findings.map((line) => `- ${line.trim()}`).join("\n") : "clear";
        const next: KanbanCard = {
          ...release(card),
          stage: outcome.continueReview ? "needs_review" : outcome.stage,
          reviewStep: outcome.reviewStep,
          reviewRound: outcome.reviewRound,
          wakeNote:
            verdict === "findings"
              ? `Review findings (round ${card.reviewRound + 1}):\n${body}\n\nFix them, then card_move to needs_review.`
              : card.wakeNote,
          nudgedAt: null,
          movedAt: at,
          updatedAt: at,
        };
        yield* logEvent(next, { _tag: "thread", threadId }, "review", {
          fromStage: card.stage,
          toStage: next.stage,
          body,
        });
        yield* saveCard(next);
        yield* kick;
        return next;
      }),
    );

  const cardThread: KanbanServiceShape["cardThread"] = (cardId, action, text, actor) =>
    guard(
      Effect.gen(function* () {
        const card = yield* cardOf(cardId);
        const at = yield* nowIso;
        if (action === "steer") {
          const threadId = card.activeThreadId ?? card.workThreadId;
          if (threadId === null)
            return yield* failWith("invalid", `card #${card.number} has no thread`);
          yield* threads.send({ threadId, text });
          yield* logEvent(card, actor, "thread", { body: `Steered: ${text}` });
          return card;
        }
        if (action === "stop") {
          if (card.activeThreadId !== null)
            yield* threads.interrupt(card.activeThreadId, text || "Stopped");
          const next: KanbanCard = {
            ...release(card),
            stage: KANBAN_THREAD_STAGES.includes(card.stage) ? "todo" : card.stage,
            stalled: { reason: text.trim() || "Stopped", by: actor, at },
            movedAt: at,
            updatedAt: at,
          };
          yield* logEvent(next, actor, "flagged", {
            fromStage: card.stage,
            toStage: next.stage,
            body: next.stalled?.reason ?? null,
          });
          yield* saveCard(next);
          return next;
        }
        if (card.activeThreadId !== null) {
          if (text.trim()) yield* threads.send({ threadId: card.activeThreadId, text });
          return card;
        }
        const next: KanbanCard = {
          ...card,
          stage: card.stage === "needs_review" ? "needs_review" : "todo",
          stalled: null,
          question: null,
          settledAt: null,
          wakeNote: text.trim() || card.wakeNote,
          movedAt: at,
          updatedAt: at,
        };
        yield* logEvent(next, actor, "moved", {
          fromStage: card.stage,
          toStage: next.stage,
          body: "Woken",
        });
        yield* saveCard(next);
        yield* kick;
        return next;
      }),
    );

  const setPool: KanbanServiceShape["setPool"] = (boardId, model, slots) =>
    guard(
      Effect.gen(function* () {
        yield* boardOf(boardId);
        const key = Rules.poolKey(model);
        yield* store.putPool(boardId, { key, model, slots: Math.max(0, Math.round(slots)) });
        const pools = yield* store.pools(boardId);
        yield* publish(boardId, { _tag: "pools", pools });
        yield* kick;
        return pools;
      }),
    );

  const setGoal: KanbanServiceShape["setGoal"] = (boardId, input) =>
    guard(
      Effect.gen(function* () {
        const goals = yield* store.goals(boardId);
        const at = yield* nowIso;
        const existing = input.id ? goals.find((goal) => goal.id === input.id) : undefined;
        if (input.id && !existing) return yield* failWith("not-found", `goal ${input.id}`);
        if (!existing && !input.name?.trim())
          return yield* failWith("invalid", "a new goal needs a name");
        const base: KanbanGoal = existing ?? {
          id: KanbanGoalId.make(`goal-${uuid()}`),
          boardId,
          name: input.name!.trim(),
          status: "active",
          now: null,
          story: [],
          createdAt: at,
        };
        const goal: KanbanGoal = {
          ...base,
          name: input.name?.trim() || base.name,
          status: input.status ?? base.status,
          now: input.now?.trim() ? { text: input.now.trim(), at } : base.now,
          story: input.story?.trim()
            ? [...base.story, { at, text: input.story.trim() }]
            : base.story,
        };
        yield* store.putGoal(goal);
        yield* publish(boardId, { _tag: "goal", goal });
        return goal;
      }),
    );

  const setGroups: KanbanServiceShape["setGroups"] = (boardId, groups) =>
    guard(
      Effect.gen(function* () {
        const at = yield* nowIso;
        const next = groups.map((group) => ({ ...group, updatedAt: at }));
        yield* store.putGroups(boardId, next);
        yield* publish(boardId, { _tag: "groups", groups: next });
      }),
    );

  const createDiscussion: KanbanServiceShape["createDiscussion"] = (boardId, title, actor) =>
    guard(
      Effect.gen(function* () {
        yield* boardOf(boardId);
        return yield* newDiscussion(boardId, title, null, actor);
      }),
    );

  const answer: KanbanServiceShape["answer"] = (discussionId, seq, blockId, choice, by) =>
    guard(
      Effect.gen(function* () {
        const discussion = yield* discussionOf(discussionId);
        const message = yield* store.message(discussionId, seq);
        if (!message) return yield* failWith("not-found", `message ${seq}`);
        const block = message.blocks.find(
          (candidate): candidate is Extract<KanbanBlock, { _tag: "choice" }> =>
            candidate._tag === "choice" && candidate.id === blockId,
        );
        if (!block) return yield* failWith("not-found", `choice ${blockId}`);
        const picked = block.options.filter((option) => choice.includes(option.id));
        if (picked.length === 0 || (!block.multi && picked.length > 1)) {
          return yield* failWith("invalid", "pick one of the options");
        }
        const at = yield* nowIso;
        const key = actorKey(by);
        const next: KanbanMessage = {
          ...message,
          answers: [
            ...message.answers.filter(
              (entry) => !(entry.blockId === blockId && actorKey(entry.by) === key),
            ),
            { blockId, by, choice: picked.map((option) => option.id), at },
          ],
        };
        yield* store.putMessage(next);
        yield* publish(discussion.boardId, { _tag: "message", message: next });
        if (by._tag !== "owner") return next;
        const text = `Owner answered "${block.question}" in discussion ${discussion.id} (message ${seq}): ${picked.map((option) => option.label).join(", ")}`;
        const author = message.author;
        if (author._tag === "thread" || author._tag === "evaluator") {
          const view = yield* threads.view(author.threadId);
          if (view) {
            yield* deliver(discussion, author, message.authorName, author.threadId, text);
            return next;
          }
        }
        yield* routeToOwnerAgent(discussion, text);
        return next;
      }),
    );

  const markRead: KanbanServiceShape["markRead"] = (discussionId, actor, seq) =>
    guard(
      Effect.gen(function* () {
        const discussion = yield* discussionOf(discussionId);
        const key = actorKey(actor);
        const current = discussion.participants.find(
          (participant) => actorKey(participant.actor) === key,
        );
        if (current && current.lastReadSeq >= seq) return;
        yield* saveDiscussion(
          withParticipant(discussion, actor, current?.name ?? OWNER_NAME, {
            lastReadSeq: Math.min(seq, discussion.lastSeq),
          }),
        );
      }),
    );

  const writeWiki: KanbanServiceShape["writeWiki"] = (boardId, page, actor) =>
    guard(
      Effect.gen(function* () {
        yield* boardOf(boardId);
        const slug = page.slug
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "");
        if (!slug) return yield* failWith("invalid", "a wiki page needs a slug");
        const next: KanbanWikiPage = {
          boardId,
          slug,
          title: page.title.trim() || slug,
          body: page.body,
          updatedAt: yield* nowIso,
          updatedBy: actor,
        };
        yield* store.putWiki(next);
        return next;
      }),
    );

  const watch: KanbanServiceShape["watch"] = (boardId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        const snapshot = yield* read(snapshotOf(boardId));
        const live = Stream.fromSubscription(subscription).pipe(
          Stream.filter((entry) => entry.boardId === boardId),
          Stream.map((entry): KanbanWatchEvent => ({ _tag: "change", change: entry.change })),
        );
        return Stream.concat(
          Stream.succeed<KanbanWatchEvent>({ _tag: "snapshot", snapshot }),
          live,
        );
      }),
    );

  const runJob = (job: Job) =>
    lock
      .withPermits(1)(job._tag === "kick" ? dispatchUnlocked() : turnEndedUnlocked(job.threadId))
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("kanban job failed", { job: job._tag, cause }),
        ),
      );

  return KanbanService.of({
    boards: read(store.boards),
    ensureBoard,
    updateBoard,
    snapshot: (boardId) => read(snapshotOf(boardId)),
    watch,
    card: (cardId) =>
      read(
        Effect.gen(function* () {
          const card = yield* cardOf(cardId);
          return {
            card,
            events: yield* store.cardEvents(cardId),
            threads: yield* store.threadLinks({ cardId }),
          } satisfies CardDetail;
        }),
      ),
    createCard,
    editCard,
    moveCard,
    flagCard,
    settleCard,
    reviewResult,
    cardThread,
    setPool,
    setGoal,
    setGroups,
    discussions: (boardId) => read(store.discussions(boardId)),
    discussion: (id) => read(discussionOf(id)),
    createDiscussion,
    cardDiscussion: (cardId) => guard(cardDiscussionUnlocked(cardId)),
    messages: (id, options) => read(store.messages(id, options)),
    post: (discussionId, author, blocks) => guard(postUnlocked(discussionId, author, blocks)),
    answer,
    markRead,
    wiki: (boardId) => read(store.wiki(boardId)),
    writeWiki,
    startEvaluator: (boardId, purpose, text) =>
      guard(
        Effect.gen(function* () {
          const board = yield* boardOf(boardId);
          return yield* startEvaluatorUnlocked(board, purpose, { text });
        }),
      ),
    caller: (threadId) => read(store.threadLink(threadId)),
    dispatchNow: guard(dispatchUnlocked()),
    turnEnded: (threadId) => guard(turnEndedUnlocked(threadId)),
    tick: guard(tickUnlocked()),
    notifyTurnEnded: (threadId) =>
      Queue.offer(jobs, { _tag: "turnEnd", threadId }).pipe(Effect.asVoid),
    worker: Queue.take(jobs).pipe(Effect.flatMap(runJob), Effect.forever),
  });
});

export const layer = Layer.effect(KanbanService, make);
