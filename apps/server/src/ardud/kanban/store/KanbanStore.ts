import { reportSqliteError } from "@t3tools/shared/nodeSqliteErrors";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Scope from "effect/Scope";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SavedWrite from "../engine/savedWrite.ts";

import {
  KanbanAutomation,
  KanbanBoard,
  KanbanCard,
  KanbanCardEvent,
  KanbanDiscussion,
  KanbanGoal,
  KanbanGroup,
  KanbanMessage,
  KanbanPool,
  KanbanScript,
  KanbanScriptRun,
  KanbanThreadLink,
  KanbanWikiPage,
  type KanbanActor,
  type KanbanScheduleCard,
  KanbanBoardId,
  ThreadId,
  KanbanCardId,
  type KanbanDiscussionId,
  type KanbanScriptId,
  type KanbanStage,
} from "@t3tools/contracts";

import { makeDecodeCache } from "./decodeCache.ts";
import { SummaryCard } from "./summaryCard.ts";
import * as BoardsDatabase from "../../persistence/BoardsDatabase.ts";
import { initializeKanbanSchema } from "../../persistence/kanbanSchema.ts";
import { ensureKanbanCacheVersions } from "../../persistence/kanbanCacheVersions.ts";

export class KanbanStoreError extends Schema.TaggedError<KanbanStoreError>()("KanbanStoreError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Missions board storage failed during ${this.operation}.`;
  }
}

const codec = <S extends Schema.Top>(schema: S) => {
  const json = Schema.fromJsonString(schema);
  return {
    decode: Schema.decodeUnknownEffect(json),
    encode: Schema.encodeEffect(json),
  };
};

const Board = codec(KanbanBoard);
const Card = codec(KanbanCard);
const Summary = codec(SummaryCard);
const SchedulingCard = codec(
  Schema.Struct({
    id: KanbanCard.fields.id,
    number: KanbanCard.fields.number,
    stage: KanbanCard.fields.stage,
    settledAt: KanbanCard.fields.settledAt,
    priority: KanbanCard.fields.priority,
    blockedBy: KanbanCard.fields.blockedBy,
    updatedAt: KanbanCard.fields.updatedAt,
    movedAt: KanbanCard.fields.movedAt,
    activeThreadId: KanbanCard.fields.activeThreadId,
    subtasks: KanbanCard.fields.subtasks,
    wait: KanbanCard.fields.wait,
    deciding: KanbanCard.fields.deciding,
  }),
);
const CardEvent = codec(
  KanbanCardEvent.mapFields((fields) => ({ ...fields, id: Schema.optionalKey(fields.id) })),
);
const Goal = codec(KanbanGoal);
const Pool = codec(KanbanPool);
const Groups = codec(Schema.Array(KanbanGroup));
const Discussion = codec(KanbanDiscussion);
const Message = codec(KanbanMessage);
const Script = codec(KanbanScript);
const ScriptRun = codec(
  KanbanScriptRun.mapFields((fields) => ({ ...fields, id: Schema.optionalKey(fields.id) })),
);
const Automation = codec(KanbanAutomation);
const Wiki = codec(KanbanWikiPage);
const ThreadLink = codec(KanbanThreadLink);

const decodeTurn = Effect.callback<void>((resume) => {
  const immediate = setImmediate(() => resume(Effect.void));
  return Effect.sync(() => clearImmediate(immediate));
});

interface JsonRow {
  readonly json: string;
}
interface EntityVersionRow {
  readonly id: string;
  readonly cache_version: number;
}
interface EntityJsonRow extends EntityVersionRow, JsonRow {}
interface KeyedVersionRow extends EntityVersionRow {
  readonly board_id: string;
}
interface KeyedJsonRow extends KeyedVersionRow, JsonRow {}
interface IdJsonRow extends JsonRow {
  readonly id: number;
}

const InstructionApplication = Schema.Struct({
  id: Schema.String,
  boardId: KanbanBoardId,
  boardSlug: Schema.String,
  cardId: KanbanCardId,
  field: Schema.Literals(["escalation", "modelRouting", "reviewerRouting", "guessedGates"]),
  askId: Schema.String,
  threadId: ThreadId,
});
export type InstructionApplication = typeof InstructionApplication.Type;
const Application = codec(InstructionApplication);

export type NewCardEvent = Omit<KanbanCardEvent, "id">;
export type NewScriptRun = Omit<KanbanScriptRun, "id">;

// Scoped by the migration lock; the service reconciles only these threads after
// the caller's outer transaction commits or rolls back.
export const cardWrites = Context.Reference<
  ((cards: ReadonlyArray<KanbanCard>) => void) | undefined
>("KanbanCardWrites", { defaultValue: () => undefined });

export type SlotEventWhy =
  | "start"
  | "join"
  | "hold"
  | "hold_end"
  | "card_left"
  | "thread_stopped"
  | "pool_moved"
  | "restart"
  | "restore";

export interface SlotEvent {
  readonly id: number;
  readonly boardId: string;
  readonly poolKey: string;
  readonly threadId: string;
  readonly cardId: string | null;
  readonly kind: "take" | "release";
  readonly at: string;
  readonly why: SlotEventWhy;
}

export interface DecodeCacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
  readonly entries: number;
}

export interface KanbanStoreShape {
  readonly observeCallerWrites: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly registerCallerParent?: (threadId: string, parentThreadId: string) => void;
  readonly callerAnalytics?: (threadId: string) =>
    | {
        boardId?: string;
        cardId?: string;
        cardNumber?: number;
        cardStage?: string;
        callerRole: "work" | "review" | "evaluator" | "discussion" | "none";
        callerKind?: "delegated_child" | "plain_thread" | "unknown";
      }
    | undefined;
  readonly addSlotEvent: (row: Omit<SlotEvent, "id">) => Effect.Effect<void, KanbanStoreError>;
  readonly slotEvents: (filter: {
    readonly boardId: string;
    readonly from: string;
    readonly to: string;
  }) => Effect.Effect<ReadonlyArray<SlotEvent>, KanbanStoreError>;
  readonly slotHistory: (filter: {
    readonly boardId: string;
    readonly from: string;
    readonly to: string;
  }) => Effect.Effect<
    { readonly events: ReadonlyArray<SlotEvent>; readonly recordedSince: string | null },
    KanbanStoreError
  >;
  readonly openSlots: (
    boardId?: string,
  ) => Effect.Effect<ReadonlyArray<SlotEvent>, KanbanStoreError>;
  readonly decodeCacheStats: Effect.Effect<Readonly<Record<string, DecodeCacheStats>>>;
  readonly boards: Effect.Effect<ReadonlyArray<KanbanBoard>, KanbanStoreError>;
  readonly board: (boardId: KanbanBoardId) => Effect.Effect<KanbanBoard | null, KanbanStoreError>;
  readonly putBoard: (board: KanbanBoard) => Effect.Effect<void, KanbanStoreError>;
  /** The board and any new pools in one transaction: all of it commits, or none of it does. */
  readonly putBoardWithPools: (
    board: KanbanBoard,
    pools: ReadonlyArray<KanbanPool>,
    application?: InstructionApplication,
  ) => Effect.Effect<void, KanbanStoreError>;

  readonly cards: (
    boardId: KanbanBoardId,
  ) => Effect.Effect<ReadonlyArray<KanbanCard>, KanbanStoreError>;
  readonly schedulingCards: (
    boardId: KanbanBoardId,
  ) => Effect.Effect<ReadonlyArray<KanbanScheduleCard>, KanbanStoreError>;
  readonly claimCards: (
    boardId: KanbanBoardId,
    seeds: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<KanbanCard>, KanbanStoreError>;
  readonly watchCardWrites: (
    boardId: KanbanBoardId,
  ) => Effect.Effect<Set<KanbanCardId>, never, Scope.Scope>;
  readonly dispatchCards: (
    boardId: KanbanBoardId,
  ) => Effect.Effect<ReadonlyArray<KanbanCard>, KanbanStoreError>;
  readonly openCards: (
    boardId: KanbanBoardId,
  ) => Effect.Effect<ReadonlyArray<KanbanCard>, KanbanStoreError>;
  readonly feedCards: (
    boardId: KanbanBoardId,
    page?: { readonly after: number; readonly limit: number },
  ) => Effect.Effect<ReadonlyArray<KanbanCard>, KanbanStoreError>;
  readonly cardPage: (
    boardId: KanbanBoardId,
    page: { readonly after: number; readonly limit: number; readonly open: boolean },
  ) => Effect.Effect<ReadonlyArray<KanbanCard>, KanbanStoreError>;
  /** Only the fields the board list's badges read, for every card on the board, in number order. */
  readonly summaryCards: (
    boardId: KanbanBoardId,
  ) => Effect.Effect<ReadonlyArray<SummaryCard>, KanbanStoreError>;
  readonly card: (cardId: KanbanCardId) => Effect.Effect<KanbanCard | null, KanbanStoreError>;
  readonly cardByNumber: (
    boardId: KanbanBoardId,
    number: number,
  ) => Effect.Effect<KanbanCard | null, KanbanStoreError>;
  /** Cards a thread is running now; one work thread may carry several. */
  readonly cardsByThread: (
    threadId: string,
  ) => Effect.Effect<ReadonlyArray<KanbanCard>, KanbanStoreError>;
  readonly poolThreadIds: (
    boardId: KanbanBoardId,
    pool: string,
  ) => Effect.Effect<ReadonlyArray<string>, KanbanStoreError>;
  readonly cardsInStage: (
    stage: KanbanStage,
  ) => Effect.Effect<ReadonlyArray<KanbanCard>, KanbanStoreError>;
  readonly nextCardNumber: (boardId: KanbanBoardId) => Effect.Effect<number, KanbanStoreError>;
  readonly putCard: (card: KanbanCard) => Effect.Effect<void, KanbanStoreError>;
  readonly addCardEvent: (
    event: NewCardEvent,
    applicationId?: string,
  ) => Effect.Effect<KanbanCardEvent, KanbanStoreError>;
  readonly pendingInstructionApplications: (
    cardId: KanbanCardId,
    boardId: KanbanBoardId,
    field: InstructionApplication["field"],
    askId: string,
  ) => Effect.Effect<ReadonlyArray<InstructionApplication>, KanbanStoreError>;
  readonly cardEvents: (
    cardId: KanbanCardId,
  ) => Effect.Effect<ReadonlyArray<KanbanCardEvent>, KanbanStoreError>;
  /** Each card's last stage change with an id below `beforeId` (none for a card without one). */
  readonly lastTransitions: (
    boardId: KanbanBoardId,
    cardIds: ReadonlyArray<KanbanCardId>,
    beforeId: number,
  ) => Effect.Effect<ReadonlyArray<KanbanCardEvent>, KanbanStoreError>;
  readonly activityHistory: (
    boardId: KanbanBoardId,
    window: { readonly since: string; readonly until: string },
  ) => Effect.Effect<ReadonlyArray<KanbanCardEvent>, KanbanStoreError>;
  /** Every event on a board's cards with `since <= at < until`, oldest first. */
  readonly boardEvents: (
    boardId: KanbanBoardId,
    since: string,
    until: string,
  ) => Effect.Effect<ReadonlyArray<KanbanCardEvent>, KanbanStoreError>;

  readonly goals: (
    boardId: KanbanBoardId,
  ) => Effect.Effect<ReadonlyArray<KanbanGoal>, KanbanStoreError>;
  readonly feedGoals: (
    boardId: KanbanBoardId,
  ) => Effect.Effect<ReadonlyArray<KanbanGoal>, KanbanStoreError>;
  readonly putGoal: (goal: KanbanGoal) => Effect.Effect<void, KanbanStoreError>;

  readonly pools: (
    boardId: KanbanBoardId,
  ) => Effect.Effect<ReadonlyArray<KanbanPool>, KanbanStoreError>;
  readonly putPool: (
    boardId: KanbanBoardId,
    pool: KanbanPool,
  ) => Effect.Effect<void, KanbanStoreError>;
  readonly removePool: (
    boardId: KanbanBoardId,
    key: string,
  ) => Effect.Effect<void, KanbanStoreError>;
  /**
   * Gives each pool in `pools` (keyed by its old key) a new key and record in place, and
   * writes the cards, in one transaction: a failure leaves the board as it was.
   */
  readonly rekeyBoard: (
    boardId: KanbanBoardId,
    pools: ReadonlyArray<{ readonly from: string; readonly pool: KanbanPool }>,
    cards: ReadonlyArray<KanbanCard>,
  ) => Effect.Effect<void, KanbanStoreError>;
  /**
   * Writes a board migration: the board record, its pools (old keys removed, new ones put),
   * the cards and the open thread links, in one transaction. A failure leaves the board
   * untouched. Unlike rekeyBoard, it also rewrites models, not only keys.
   */
  readonly migrateBoardSelections: (input: {
    readonly board: KanbanBoard;
    readonly pools: ReadonlyArray<KanbanPool>;
    readonly oldPoolKeys: ReadonlyArray<string>;
    readonly cards: ReadonlyArray<KanbanCard>;
    readonly threadLinks: ReadonlyArray<KanbanThreadLink>;
  }) => Effect.Effect<void, KanbanStoreError>;

  readonly groups: (
    boardId: KanbanBoardId,
  ) => Effect.Effect<ReadonlyArray<KanbanGroup>, KanbanStoreError>;
  readonly putGroups: (
    boardId: KanbanBoardId,
    groups: ReadonlyArray<KanbanGroup>,
  ) => Effect.Effect<void, KanbanStoreError>;

  readonly discussions: (
    boardId: KanbanBoardId,
  ) => Effect.Effect<ReadonlyArray<KanbanDiscussion>, KanbanStoreError>;
  readonly openDiscussions: (
    boardId: KanbanBoardId,
  ) => Effect.Effect<ReadonlyArray<KanbanDiscussion>, KanbanStoreError>;
  readonly discussion: (
    id: KanbanDiscussionId,
  ) => Effect.Effect<KanbanDiscussion | null, KanbanStoreError>;
  readonly latestSystemDiscussion: (
    boardId: KanbanBoardId,
    component: string,
  ) => Effect.Effect<KanbanDiscussion | null, KanbanStoreError>;
  readonly discussionByEvaluator: (
    threadId: string,
  ) => Effect.Effect<KanbanDiscussion | null, KanbanStoreError>;
  readonly discussionBoardIdsByEvaluator: (
    threadId: string,
  ) => Effect.Effect<ReadonlyArray<KanbanBoardId>, KanbanStoreError>;
  readonly putDiscussion: (discussion: KanbanDiscussion) => Effect.Effect<void, KanbanStoreError>;
  /** The newest `limit` (default 200) after `afterSeq` and before `beforeSeq`, oldest first. */
  readonly messages: (
    id: KanbanDiscussionId,
    options?: { readonly afterSeq?: number; readonly beforeSeq?: number; readonly limit?: number },
  ) => Effect.Effect<ReadonlyArray<KanbanMessage>, KanbanStoreError>;
  /**
   * The owner's latest message and whether an evaluator spoke after it, without decoding the
   * history. Null when the owner never wrote.
   */
  readonly ownerWait: (
    id: KanbanDiscussionId,
  ) => Effect.Effect<
    { readonly seq: number; readonly createdAt: string; readonly answered: boolean } | null,
    KanbanStoreError
  >;
  readonly ownerReply: (
    id: KanbanDiscussionId,
    threadId: ThreadId,
    evaluator: boolean,
  ) => Effect.Effect<
    { readonly key: string; readonly createdAt: string; readonly answered: boolean } | null,
    KanbanStoreError
  >;
  /** Every message of a discussion, oldest first. */
  readonly allMessages: (
    id: KanbanDiscussionId,
  ) => Effect.Effect<ReadonlyArray<KanbanMessage>, KanbanStoreError>;
  readonly message: (
    id: KanbanDiscussionId,
    seq: number,
  ) => Effect.Effect<KanbanMessage | null, KanbanStoreError>;
  readonly putMessage: (message: KanbanMessage) => Effect.Effect<void, KanbanStoreError>;

  readonly scripts: (
    boardId: KanbanBoardId,
  ) => Effect.Effect<ReadonlyArray<KanbanScript>, KanbanStoreError>;
  readonly allScripts: Effect.Effect<ReadonlyArray<KanbanScript>, KanbanStoreError>;
  readonly script: (id: KanbanScriptId) => Effect.Effect<KanbanScript | null, KanbanStoreError>;
  readonly putScript: (script: KanbanScript) => Effect.Effect<void, KanbanStoreError>;
  readonly addScriptRun: (run: NewScriptRun) => Effect.Effect<KanbanScriptRun, KanbanStoreError>;
  readonly putScriptRun: (run: KanbanScriptRun) => Effect.Effect<void, KanbanStoreError>;
  readonly scriptRuns: (
    id: KanbanScriptId,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<KanbanScriptRun>, KanbanStoreError>;

  readonly automations: (
    boardId: KanbanBoardId,
  ) => Effect.Effect<ReadonlyArray<KanbanAutomation>, KanbanStoreError>;
  readonly putAutomation: (automation: KanbanAutomation) => Effect.Effect<void, KanbanStoreError>;

  readonly wiki: (
    boardId: KanbanBoardId,
  ) => Effect.Effect<ReadonlyArray<KanbanWikiPage>, KanbanStoreError>;
  readonly putWiki: (page: KanbanWikiPage) => Effect.Effect<void, KanbanStoreError>;

  /** Threads the board started; a thread belongs to at most one board. */
  readonly threadLink: (
    threadId: string,
  ) => Effect.Effect<KanbanThreadLink | null, KanbanStoreError>;
  readonly threadLinksByIds: (
    threadIds: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<KanbanThreadLink>, KanbanStoreError>;
  readonly threadLinks: (
    filter:
      | { readonly cardId: KanbanCardId }
      | { readonly boardId: KanbanBoardId; readonly open: boolean },
  ) => Effect.Effect<ReadonlyArray<KanbanThreadLink>, KanbanStoreError>;
  readonly putThreadLink: (link: KanbanThreadLink) => Effect.Effect<void, KanbanStoreError>;
  readonly openReviewLinks: (
    boardId: KanbanBoardId,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly link: KanbanThreadLink; readonly card: KanbanCard | null }>,
    KanbanStoreError
  >;
  /** Records that a work thread carries a card (idempotent). */
  readonly addThreadCard: (
    threadId: string,
    cardId: KanbanCardId,
    at: string,
  ) => Effect.Effect<void, KanbanStoreError>;
  /** Cards a work thread has carried, in the order it took them. */
  readonly threadCards: (
    threadId: string,
  ) => Effect.Effect<ReadonlyArray<KanbanCardId>, KanbanStoreError>;
}

export class KanbanStore extends Context.Service<KanbanStore, KanbanStoreShape>()(
  "t3/ardud/kanban/store/KanbanStore",
) {}

export const actorKey = (actor: KanbanActor): string => {
  switch (actor._tag) {
    case "owner":
      return "owner";
    case "thread":
    case "evaluator":
      return `${actor._tag}:${actor.threadId}`;
    case "script":
      return `script:${actor.scriptId}`;
    case "system":
      return `system:${actor.component}`;
  }
};

const make = Effect.gen(function* () {
  const sql = yield* BoardsDatabase.client;
  const stateSql = yield* SqlClient.SqlClient;
  const fail = (operation: string) => (cause: unknown) => {
    reportSqliteError(cause, `KanbanStore.${operation}`);
    return new KanbanStoreError({ operation, cause });
  };

  yield* BoardsDatabase.initialize(
    initializeKanbanSchema(sql).pipe(Effect.andThen(ensureKanbanCacheVersions(sql))),
  ).pipe(Effect.mapError(fail("create tables")));

  const callerWrites = Context.Reference<Array<() => void> | undefined>("KanbanCallerWrites", {
    defaultValue: () => undefined,
  });
  // SQL success inside an outer transaction is not a commit. Publish its
  // metadata only after that enclosing operation succeeds, including bulk writes.
  const observeCallerWrites: KanbanStoreShape["observeCallerWrites"] = Effect.fnUntraced(
    function* (effect) {
      if ((yield* callerWrites) !== undefined) return yield* effect;
      const updates: Array<() => void> = [];
      const parent = yield* NodeSqliteClient.TransactionCommitObserver;
      const apply = () => {
        for (const update of updates) update();
        updates.length = 0;
      };
      return yield* effect.pipe(
        Effect.provideService(callerWrites, updates),
        Effect.provideService(NodeSqliteClient.TransactionCommitObserver, () => {
          apply();
          parent?.();
        }),
        Effect.tap(() => Effect.sync(apply)),
      );
    },
  );
  const updateCaller = Effect.fnUntraced(function* (apply: () => void) {
    const updates = yield* callerWrites;
    if (updates !== undefined) updates.push(apply);
    else if ((yield* Effect.serviceOption(sql.transactionService))._tag === "None") apply();
  });
  let callerHydrated = false;
  const callerParents = new Map<string, string>();
  const callerLinks = new Map<
    string,
    {
      boardId: string;
      cardId: string | null;
      role: "work" | "review" | "evaluator";
      discussionId: string | null;
    }
  >();
  const callerCards = new Map<string, { number: number; stage: string }>();
  const hydrateCallerParents = Effect.fn("KanbanStore.hydrateCallerParents")(function* () {
    const tables = yield* stateSql`
      SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'orchestration_v2_projection_threads'
    `;
    if (tables.length === 0) return;
    const parents = yield* stateSql<{ thread_id: string; parent_thread_id: string | null }>`
      SELECT thread_id, CASE
        WHEN json_extract(payload_json, '$.lineage.relationshipToParent') = 'subagent'
          THEN COALESCE(json_extract(payload_json, '$.lineage.parentThreadId'), json_extract(payload_json, '$.lineage.rootThreadId'))
        WHEN json_type(payload_json, '$.lineage') IS NULL
          AND json_extract(payload_json, '$.forkedFrom.type') = 'run'
          THEN json_extract(payload_json, '$.forkedFrom.threadId')
        END AS parent_thread_id
      FROM orchestration_v2_projection_threads
      WHERE deleted_at IS NULL
        AND (json_extract(payload_json, '$.lineage.relationshipToParent') = 'subagent'
          OR (json_type(payload_json, '$.lineage') IS NULL
            AND json_extract(payload_json, '$.forkedFrom.type') = 'run'))
    `;
    for (const row of parents)
      if (row.parent_thread_id !== null && !callerParents.has(row.thread_id))
        callerParents.set(row.thread_id, row.parent_thread_id);
  });
  // Hydrate once after board migration; calls only consult these compact maps.
  // Writes observed during hydration win over its older snapshot.
  yield* BoardsDatabase.onReady(
    hydrateCallerParents().pipe(
      Effect.andThen(
        sql.withTransaction(
          Effect.gen(function* () {
            const links = yield* sql<{
              thread_id: string;
              board_id: string;
              card_id: string | null;
              role: "work" | "review" | "evaluator";
              discussion_id: string | null;
            }>`SELECT thread_id, board_id, card_id, json_extract(json, '$.role') AS role, json_extract(json, '$.discussionId') AS discussion_id FROM ardud_kanban_threads`;
            const cards = yield* sql<{
              id: string;
              number: number;
              stage: string;
            }>`SELECT id, number, stage FROM ardud_kanban_cards`;
            for (const row of links)
              if (!callerLinks.has(row.thread_id))
                callerLinks.set(row.thread_id, {
                  boardId: row.board_id,
                  cardId: row.card_id,
                  role: row.role,
                  discussionId: row.discussion_id,
                });
            for (const row of cards)
              if (!callerCards.has(row.id))
                callerCards.set(row.id, { number: row.number, stage: row.stage });
            callerHydrated = true;
          }),
        ),
      ),
      NodeSqliteClient.readOnly,
      Effect.mapError(fail("hydrate caller analytics")),
    ),
  );
  const callerAnalytics: NonNullable<KanbanStoreShape["callerAnalytics"]> = (threadId) => {
    const seen = new Set<string>();
    let id = threadId;
    let link = callerLinks.get(id);
    while (!link && callerParents.has(id) && !seen.has(id)) {
      seen.add(id);
      id = callerParents.get(id)!;
      link = callerLinks.get(id);
    }
    if (!link)
      return callerParents.has(threadId)
        ? { callerRole: "none", callerKind: "delegated_child" }
        : { callerRole: "none", callerKind: callerHydrated ? "plain_thread" : "unknown" };
    const card = link.cardId === null ? undefined : callerCards.get(link.cardId);
    return {
      boardId: link.boardId,
      callerRole: link.discussionId !== null ? "discussion" : link.role,
      ...(callerParents.has(threadId) ? { callerKind: "delegated_child" as const } : {}),
      ...(link.cardId === null ? {} : { cardId: link.cardId }),
      ...(card === undefined ? {} : { cardNumber: card.number, cardStage: card.stage }),
    };
  };

  const readCounters = Context.Reference<
    Record<string, { hits: number; misses: number; evictions: number }>
  >("KanbanReadCounters", {
    defaultValue: () => ({}),
  });

  const jsonFetchCounters = Context.Reference<{
    jsonRowsFetched: number;
    jsonBytesFetched: number;
  }>("KanbanJsonFetchCounters", {
    defaultValue: () => ({ jsonRowsFetched: 0, jsonBytesFetched: 0 }),
  });

  // Observers exist only while a dispatch pass is alive; no card data or
  // change history is retained between passes. Track raw store writers too.
  const cardWatches = new Map<string, Set<Set<KanbanCardId>>>();
  const watchCardWrites = Effect.fn("KanbanStore.watchCardWrites")((boardId: KanbanBoardId) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const changed = new Set<KanbanCardId>();
        let watches = cardWatches.get(boardId);
        if (!watches) cardWatches.set(boardId, (watches = new Set()));
        watches.add(changed);
        return changed;
      }),
      (changed) =>
        Effect.sync(() => {
          const watches = cardWatches.get(boardId);
          watches?.delete(changed);
          if (watches?.size === 0) cardWatches.delete(boardId);
        }),
    ),
  );
  // Dirty-card watches track attempted writes; attribution publishes only on commit.
  const cardWritten = (card: KanbanCard) => {
    for (const changed of cardWatches.get(card.boardId) ?? []) changed.add(card.id);
  };

  // Revisions come from SQLite triggers, including writes outside this store.
  // Full collection reads reconcile deletions; subset reads never prune siblings.
  const cached = <R extends EntityVersionRow, A, E>(
    name: string,
    decode: (json: string) => Effect.Effect<A, E>,
    key: (row: R) => string,
  ) => makeDecodeCache(name, decode, key, readCounters);
  const rowKey = (row: EntityVersionRow) => row.id;
  const poolKey = (row: KeyedVersionRow) => JSON.stringify([row.board_id, row.id]);
  const decoders = {
    board: cached("board", Board.decode, rowKey),
    card: cached("card", Card.decode, rowKey),
    feed: cached("feed", Card.decode, rowKey),
    scheduling: cached("scheduling", SchedulingCard.decode, rowKey),
    summary: cached("summary", Summary.decode, rowKey),
    goal: cached("goal", Goal.decode, rowKey),
    goalFeed: cached("goalFeed", Goal.decode, rowKey),
    pool: cached("pool", Pool.decode, poolKey),
    discussion: cached("discussion", Discussion.decode, rowKey),
    thread: cached("thread", ThreadLink.decode, rowKey),
  };
  const decodeCacheStats = Effect.sync(() =>
    Object.fromEntries(Object.entries(decoders).map(([name, decoder]) => [name, decoder.stats()])),
  );

  // Per-row spans would dominate this loop. Count locally so concurrent reads
  // cannot attribute each other's hits/misses to the read operation's span.
  const decodeAll = Effect.fnUntraced(function* <R extends JsonRow, A, E>(
    rows: ReadonlyArray<R>,
    decoder:
      | {
          name: string;
          decode: (
            row: R,
            counts: { hits: number; misses: number; evictions: number },
            shared?: boolean,
          ) => Effect.Effect<A, E>;
        }
      | ((json: string) => Effect.Effect<A, E>),
    sharedOverride?: boolean,
  ) {
    // A rolled-back revision can be allocated again; never publish uncommitted decodes.
    const shared =
      sharedOverride ??
      (yield* Effect.map(Effect.serviceOption(sql.transactionService), (tx) => tx._tag === "None"));
    const fetched = yield* jsonFetchCounters;
    fetched.jsonRowsFetched += rows.length;
    for (const row of rows) fetched.jsonBytesFetched += row.json.length;
    const counters = yield* readCounters;
    const counts =
      typeof decoder === "function"
        ? { hits: 0, misses: 0, evictions: 0 }
        : (counters[decoder.name] ??= { hits: 0, misses: 0, evictions: 0 });
    const result = yield* Effect.forEach(rows, (row, index) => {
      const decoded =
        typeof decoder === "function" ? decoder(row.json) : decoder.decode(row, counts, shared);
      return index > 0 && index % 32 === 0 ? decodeTurn.pipe(Effect.andThen(decoded)) : decoded;
    });
    return result;
  });
  // Cache pruning shares the collection read span, including eviction counters.
  const reconcileCards = Effect.fnUntraced(function* (
    boardId: string,
    rows: ReadonlyArray<KeyedVersionRow>,
  ) {
    const ids = new Set(rows.map((row) => row.id));
    for (const decoder of [decoders.card, decoders.feed, decoders.summary])
      yield* decoder.reconcile(boardId, ids);
  });

  // The read span already covers this helper. Pin both phases to one connection
  // and snapshot; capture cache hits before yielding so concurrent eviction is harmless.
  const readCollection = Effect.fnUntraced(function* <A, E, ME>(
    metadata: Effect.Effect<ReadonlyArray<KeyedVersionRow>, ME>,
    table: "ardud_kanban_cards" | "ardud_kanban_discussions",
    decoder: {
      name: string;
      lookup: (
        row: KeyedVersionRow,
        counts: { hits: number; misses: number; evictions: number },
        shared: boolean,
      ) => { value: A } | undefined;
      decode: (
        row: KeyedJsonRow,
        counts: { hits: number; misses: number; evictions: number },
        shared?: boolean,
      ) => Effect.Effect<A, E>;
    },
    reconcile?: (rows: ReadonlyArray<KeyedVersionRow>) => Effect.Effect<void>,
  ) {
    // Check before our read transaction: caller-owned transactions must neither
    // consume nor publish shared revisions, since rollback can reuse a version.
    const shared = (yield* Effect.serviceOption(sql.transactionService))._tag === "None";
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* metadata;
        if (reconcile !== undefined) yield* reconcile(rows);
        const counters = yield* readCounters;
        const counts = (counters[decoder.name] ??= { hits: 0, misses: 0, evictions: 0 });
        const values = new Map<string, A>();
        const missing: string[] = [];
        for (const row of rows) {
          const hit = decoder.lookup(row, counts, shared);
          if (hit === undefined) missing.push(row.id);
          else values.set(row.id, hit.value);
        }
        for (let offset = 0; offset < missing.length; offset += 128) {
          const ids = missing.slice(offset, offset + 128);
          const fetched = yield* sql<KeyedJsonRow>`
          SELECT id, board_id, cache_version, json FROM ${sql(table)} WHERE ${sql.in("id", ids)}
        `;
          const decoded = yield* decodeAll(fetched, decoder, shared);
          for (let i = 0; i < fetched.length; i++) values.set(fetched[i]!.id, decoded[i]!);
        }
        return rows.map((row) => values.get(row.id)!);
      }),
    );
  });

  const first = <A>(items: ReadonlyArray<A>): A | null => items[0] ?? null;

  const run = <A, E>(operation: string, effect: Effect.Effect<A, E>) =>
    effect.pipe(Effect.mapError(fail(operation)));

  // Reads inside a write transaction stay on the writer for read-your-writes.
  const runRead = <A, E>(operation: string, effect: Effect.Effect<A, E>) =>
    run(
      operation,
      Effect.suspend(() => {
        const counters: Record<string, { hits: number; misses: number; evictions: number }> = {};
        const fetched = { jsonRowsFetched: 0, jsonBytesFetched: 0 };
        return SavedWrite.stage(NodeSqliteClient.readOnly(effect), "read").pipe(
          Effect.provideService(readCounters, counters),
          Effect.provideService(jsonFetchCounters, fetched),
          Effect.ensuring(
            Effect.suspend(() =>
              Effect.annotateCurrentSpan({
                ...fetched,
                ...Object.fromEntries(
                  Object.entries(counters).flatMap(([name, counts]) =>
                    Object.entries(counts).map(([kind, count]) => [
                      `kanban.decode.${name}.${kind}`,
                      count,
                    ]),
                  ),
                ),
              }),
            ),
          ),
          Effect.withSpan("KanbanStore.read", { attributes: { "kanban.operation": operation } }),
        );
      }),
    );

  const boards = runRead(
    "read boards",
    Effect.gen(function* () {
      const rows =
        yield* sql<EntityJsonRow>`SELECT id, cache_version, json FROM ardud_kanban_boards ORDER BY rowid`;
      yield* decoders.board.reconcile(undefined, new Set(rows.map(rowKey)));
      return yield* decodeAll(rows, decoders.board);
    }),
  );
  const board = (boardId: KanbanBoardId) =>
    runRead(
      "read board",
      Effect.flatMap(
        sql<EntityJsonRow>`SELECT id, cache_version, json FROM ardud_kanban_boards WHERE id = ${boardId}`,
        (rows) =>
          rows.length === 0
            ? decoders.board.drop(boardId).pipe(Effect.as(null))
            : Effect.map(decodeAll(rows, decoders.board), first),
      ),
    );
  const putBoard = (board: KanbanBoard) =>
    run(
      "write board",
      Effect.gen(function* () {
        const json = yield* Board.encode(board);
        yield* sql`
          INSERT INTO ardud_kanban_boards (id, slug, json) VALUES (${board.id}, ${board.slug}, ${json})
          ON CONFLICT (id) DO UPDATE SET slug = excluded.slug, json = excluded.json
        `;
      }),
    );

  const putBoardWithPools = (
    board: KanbanBoard,
    pools: ReadonlyArray<KanbanPool>,
    application?: InstructionApplication,
  ) =>
    run(
      "write board with pools",
      sql.withTransaction(
        Effect.gen(function* () {
          const json = yield* Board.encode(board);
          yield* sql`
            INSERT INTO ardud_kanban_boards (id, slug, json) VALUES (${board.id}, ${board.slug}, ${json})
            ON CONFLICT (id) DO UPDATE SET slug = excluded.slug, json = excluded.json
          `;
          if (application !== undefined) {
            const receipt = yield* Application.encode(application);
            yield* sql`
              INSERT INTO ardud_kanban_instruction_applications (id, board_id, card_id, field, ask_id, json)
              VALUES (${application.id}, ${board.id}, ${application.cardId}, ${application.field}, ${application.askId}, ${receipt})
            `;
          }
          for (const pool of pools) {
            const poolJson = yield* Pool.encode(pool);
            yield* sql`
              INSERT INTO ardud_kanban_pools (board_id, key, json) VALUES (${board.id}, ${pool.key}, ${poolJson})
              ON CONFLICT (board_id, key) DO UPDATE SET json = excluded.json
            `;
          }
        }),
      ),
    );

  const cards = (boardId: KanbanBoardId) =>
    runRead(
      "read cards",
      readCollection(
        sql<KeyedVersionRow>`SELECT id, board_id, cache_version FROM ardud_kanban_cards WHERE board_id = ${boardId} ORDER BY number`,
        "ardud_kanban_cards",
        decoders.card,
        (rows) => reconcileCards(boardId, rows),
      ),
    );
  const openCards = (boardId: KanbanBoardId) =>
    runRead(
      "read open cards",
      readCollection(
        sql<KeyedVersionRow>`
      SELECT id, board_id, cache_version FROM ardud_kanban_cards
      WHERE board_id = ${boardId} AND json_extract(json, '$.settledAt') IS NULL
      ORDER BY number
    `,
        "ardud_kanban_cards",
        decoders.card,
      ),
    );
  const dispatchCards = (boardId: KanbanBoardId) =>
    runRead(
      "read dispatch cards",
      readCollection(
        sql<KeyedVersionRow>`
          SELECT id, board_id, cache_version, number
          FROM ardud_kanban_cards INDEXED BY ardud_kanban_cards_dispatch
          WHERE board_id = ${boardId}
            AND (stage IN ('todo', 'working', 'needs_review', 'in_review')
              OR active_thread_id IS NOT NULL)
            AND json_extract(json, '$.settledAt') IS NULL
          UNION ALL
          -- Waits/deciding exist only in JSON. Read those exceptions from the existing
          -- open-card index, keeping settled history out of both the read and boot DDL.
          SELECT id, board_id, cache_version, number
          FROM ardud_kanban_cards INDEXED BY ardud_kanban_cards_open
          WHERE board_id = ${boardId} AND json_extract(json, '$.settledAt') IS NULL
            AND NOT (stage IN ('todo', 'working', 'needs_review', 'in_review')
              OR active_thread_id IS NOT NULL)
            AND (json_extract(json, '$.wait') IS NOT NULL
              OR json_extract(json, '$.deciding') IS NOT NULL)
          ORDER BY number
        `,
        "ardud_kanban_cards",
        decoders.card,
      ),
    );
  const feedCards: KanbanStoreShape["feedCards"] = (boardId, page) =>
    runRead(
      "read feed cards",
      Effect.flatMap(
        sql<KeyedJsonRow>`
          SELECT id, board_id, cache_version, json_set(json,
            '$.prompt', '', '$.description', '', '$.wakeNote', CASE WHEN json_extract(json, '$.wakeNote') IS NULL THEN NULL ELSE 'pending' END,
            '$.title', substr(json_extract(json, '$.title'), 1, 512),
            '$.question', substr(json_extract(json, '$.question'), 1, 512),
            '$.stalled.reason', substr(json_extract(json, '$.stalled.reason'), 1, 512),
            '$.asks', json(COALESCE((
              SELECT json_group_array(json_set(ask.value, '$.text', substr(json_extract(ask.value, '$.text'), 1, 512)))
              FROM json_each(ardud_kanban_cards.json, '$.asks') AS ask
              WHERE json_extract(ask.value, '$.closedAt') IS NULL
            ), '[]')),
            '$.subtasks', json(COALESCE((
              SELECT json_group_array(json_set(task.value,
                '$.text', substr(json_extract(task.value, '$.text'), 1, 128), '$.note', NULL))
              FROM json_each(ardud_kanban_cards.json, '$.subtasks') AS task
            ), '[]'))
          ) AS json
          FROM ardud_kanban_cards
          WHERE board_id = ${boardId} AND number > ${page?.after ?? 0}
          ORDER BY number LIMIT ${page?.limit ?? -1}
        `,
        (rows) => decodeAll(rows, decoders.feed),
      ),
    );
  const cardPage: KanbanStoreShape["cardPage"] = (boardId, page) =>
    runRead(
      "read card page",
      readCollection(
        sql<KeyedVersionRow>`
          SELECT id, board_id, cache_version, number FROM ardud_kanban_cards
          WHERE board_id = ${boardId} AND number > ${page.after}
            ${page.open ? sql`AND json_extract(json, '$.settledAt') IS NULL` : sql``}
          ORDER BY number LIMIT ${page.limit}
        `,
        "ardud_kanban_cards",
        decoders.card,
      ),
    );
  const summaryCards = (boardId: KanbanBoardId) =>
    runRead(
      "read summary cards",
      Effect.gen(function* () {
        const cards: Array<SummaryCard> = [];
        let after = 0;
        // Release the reader between batches; a board list must not monopolize
        // the boards lane while SQLite parses every card's asks.
        while (true) {
          const rows = yield* sql<KeyedJsonRow & { number: number }>`
            SELECT id, board_id, cache_version, number, json_object(
              'id', id,
              'stage', stage,
              'settledAt', json_extract(json, '$.settledAt'),
              'activeThreadId', active_thread_id,
              'asks', json(COALESCE((
                SELECT json_group_array(json_patch(
                  json_object('closedAt', json_extract(ask.value, '$.closedAt')),
                  json_object(
                    'clarifyAskedAt', json_extract(ask.value, '$.clarifyAskedAt'),
                    'handedAt', json_extract(ask.value, '$.handedAt'),
                    'expiresAt', json_extract(ask.value, '$.expiresAt'),
                    'snoozedUntil', json_extract(ask.value, '$.snoozedUntil'),
                    'respond', CASE WHEN json_extract(ask.value, '$.respond.ack') = 1
                      THEN json_object('ack', json('true')) END
                  )
                ))
                FROM json_each(ardud_kanban_cards.json, '$.asks') AS ask
              ), '[]'))
            ) AS json
            FROM ardud_kanban_cards
            WHERE board_id = ${boardId} AND number > ${after}
            ORDER BY number LIMIT 64
          `;
          cards.push(...(yield* decodeAll(rows, decoders.summary)));
          if (rows.length < 64) {
            yield* decoders.summary.reconcile(boardId, new Set(cards.map((card) => card.id)));
            return cards;
          }
          after = rows.at(-1)!.number;
        }
      }),
    );
  const card = (cardId: KanbanCardId) =>
    runRead(
      "read card",
      Effect.flatMap(
        sql<KeyedJsonRow>`SELECT id, board_id, cache_version, json FROM ardud_kanban_cards WHERE id = ${cardId}`,
        (rows) =>
          Effect.gen(function* () {
            if (rows.length === 0)
              for (const decoder of [decoders.card, decoders.feed, decoders.summary])
                yield* decoder.drop(cardId);
            return first(yield* decodeAll(rows, decoders.card));
          }),
      ),
    );
  const cardByNumber = (boardId: KanbanBoardId, number: number) =>
    runRead(
      "read card by number",
      Effect.flatMap(
        sql<KeyedJsonRow>`SELECT id, board_id, cache_version, json FROM ardud_kanban_cards WHERE board_id = ${boardId} AND number = ${number}`,
        (rows) => Effect.map(decodeAll(rows, decoders.card), first),
      ),
    );
  const schedulingCards = (boardId: KanbanBoardId) =>
    runRead(
      "read scheduling cards",
      Effect.gen(function* () {
        const rows = yield* sql<KeyedJsonRow>`
        SELECT id, board_id, cache_version, json_patch(json_object(
          'id', id, 'number', number, 'stage', stage,
          'settledAt', json_extract(json, '$.settledAt'),
          'priority', json_extract(json, '$.priority'),
          'blockedBy', json_extract(json, '$.blockedBy'),
          'updatedAt', json_extract(json, '$.updatedAt'),
          'movedAt', json_extract(json, '$.movedAt'),
          'activeThreadId', active_thread_id,
          'subtasks', CASE WHEN json_type(json, '$.subtasks') IS NULL THEN json('[]')
              ELSE json_extract(json, '$.subtasks') END
        ), json_object(
          'wait', json_extract(json, '$.wait'),
          'deciding', json_extract(json, '$.deciding')
        )) AS json
        FROM ardud_kanban_cards WHERE board_id = ${boardId} ORDER BY number
      `;
        yield* decoders.scheduling.reconcile(boardId, new Set(rows.map((row) => row.id)));
        return yield* decodeAll(rows, decoders.scheduling);
      }),
    );
  const claimCards: KanbanStoreShape["claimCards"] = (boardId, seeds) =>
    runRead(
      "read claim cards",
      readCollection(
        sql<KeyedVersionRow>`
        WITH RECURSIVE relevant(id) AS (
          SELECT id FROM ardud_kanban_cards WHERE board_id = ${boardId} AND stage = 'todo'
          UNION
          SELECT id FROM ardud_kanban_cards
          WHERE board_id = ${boardId} AND id IN (SELECT value FROM json_each(${JSON.stringify(seeds)}))
          UNION
          SELECT blocker.value FROM relevant
          JOIN ardud_kanban_cards AS card ON card.id = relevant.id AND card.board_id = ${boardId}
          JOIN json_each(card.json, '$.blockedBy') AS blocker
        )
        SELECT id, board_id, cache_version FROM ardud_kanban_cards
        WHERE board_id = ${boardId} AND id IN (SELECT id FROM relevant)
        ORDER BY number
      `,
        "ardud_kanban_cards",
        decoders.card,
      ),
    );
  const poolThreadIds: KanbanStoreShape["poolThreadIds"] = (boardId, pool) =>
    runRead(
      "read pool thread ids",
      Effect.map(
        sql<{ readonly thread_id: string }>`
        SELECT DISTINCT active_thread_id AS thread_id
        FROM ardud_kanban_cards INDEXED BY ardud_kanban_cards_dispatch
        WHERE board_id = ${boardId} AND active_thread_id IS NOT NULL
          AND json_extract(json, '$.activePool') = ${pool}
      `,
        (rows) => rows.map((row) => row.thread_id),
      ),
    );
  const cardsByThread = (threadId: string) =>
    runRead(
      "read cards by thread",
      readCollection(
        sql<KeyedVersionRow>`SELECT id, board_id, cache_version FROM ardud_kanban_cards WHERE active_thread_id = ${threadId} ORDER BY number`,
        "ardud_kanban_cards",
        decoders.card,
      ),
    );
  const cardsInStage = (stage: KanbanStage) =>
    runRead(
      "read cards in stage",
      readCollection(
        sql<KeyedVersionRow>`SELECT id, board_id, cache_version FROM ardud_kanban_cards WHERE stage = ${stage} ORDER BY board_id, number`,
        "ardud_kanban_cards",
        decoders.card,
      ),
    );
  const nextCardNumber = (boardId: KanbanBoardId) =>
    run(
      "next card number",
      Effect.map(
        sql<{ readonly next: number }>`
          SELECT COALESCE(MAX(number), 0) + 1 AS next FROM ardud_kanban_cards WHERE board_id = ${boardId}
        `,
        (rows) => Number(rows[0]?.next ?? 1),
      ),
    );
  const putCard = (value: KanbanCard) =>
    run(
      "write card",
      Effect.gen(function* () {
        const observe = yield* cardWrites;
        const previous = observe === undefined ? null : yield* card(value.id);
        const json = yield* Card.encode(value);
        yield* sql`
          INSERT INTO ardud_kanban_cards (id, board_id, number, stage, active_thread_id, json)
          VALUES (${value.id}, ${value.boardId}, ${value.number}, ${value.stage}, ${value.activeThreadId}, ${json})
          ON CONFLICT (id) DO UPDATE SET
            stage = excluded.stage,
            active_thread_id = excluded.active_thread_id,
            json = excluded.json
        `;
        observe?.(previous === null ? [value] : [previous, value]);
        cardWritten(value);
        yield* updateCaller(() =>
          callerCards.set(value.id, { number: value.number, stage: value.stage }),
        );
      }),
    );
  const slotColumns = sql.literal(
    'id, board_id AS "boardId", pool_key AS "poolKey", thread_id AS "threadId", card_id AS "cardId", kind, at, why',
  );
  const addSlotEvent = (row: Omit<SlotEvent, "id">) =>
    run(
      "write slot event",
      sql`
      INSERT INTO ardud_kanban_slot_events (board_id, pool_key, thread_id, card_id, kind, at, why)
      VALUES (${row.boardId}, ${row.poolKey}, ${row.threadId}, ${row.cardId}, ${row.kind}, ${row.at}, ${row.why})
    `.pipe(Effect.asVoid),
    );
  const slotEvents: KanbanStoreShape["slotEvents"] = ({ boardId, from, to }) =>
    runRead(
      "read slot events",
      sql<SlotEvent>`
      SELECT ${slotColumns} FROM ardud_kanban_slot_events
      WHERE board_id = ${boardId} AND at >= ${from} AND at < ${to} ORDER BY id
    `,
    );
  const slotHistory: KanbanStoreShape["slotHistory"] = ({ boardId, from, to }) =>
    runRead(
      "read slot history",
      Effect.gen(function* () {
        const rows = yield* sql<SlotEvent & { readonly recordedSince: string }>`
        WITH carry AS (
          SELECT MAX(id) AS id FROM ardud_kanban_slot_events
          WHERE board_id = ${boardId} AND at < ${from}
          GROUP BY pool_key, thread_id
        ), selected AS (
          SELECT * FROM ardud_kanban_slot_events WHERE id IN (SELECT id FROM carry)
          UNION ALL SELECT * FROM ardud_kanban_slot_events
          WHERE board_id = ${boardId} AND at >= ${from} AND at < ${to}
        )
        SELECT ${slotColumns},
          (SELECT MIN(at) FROM ardud_kanban_slot_events WHERE board_id = ${boardId}) AS "recordedSince"
        FROM selected ORDER BY id
      `;
        return { events: rows, recordedSince: rows[0]?.recordedSince ?? null };
      }),
    );
  const openSlots: KanbanStoreShape["openSlots"] = (boardId) =>
    runRead(
      "read open slots",
      sql<SlotEvent>`
      SELECT ${slotColumns} FROM ardud_kanban_slot_events
      WHERE id IN (
        SELECT MAX(id) FROM ardud_kanban_slot_events
        ${boardId === undefined ? sql.literal("") : sql`WHERE board_id = ${boardId}`}
        GROUP BY board_id, pool_key, thread_id
      ) AND kind = 'take' ORDER BY id
    `,
    );

  const pendingInstructionApplications: KanbanStoreShape["pendingInstructionApplications"] = (
    cardId,
    boardId,
    field,
    askId,
  ) =>
    runRead(
      "read pending instruction applications",
      Effect.flatMap(
        sql<JsonRow>`
      SELECT json FROM ardud_kanban_instruction_applications
      WHERE card_id = ${cardId} AND board_id = ${boardId} AND field = ${field}
        AND ask_id = ${askId} AND audit_event_id IS NULL
      ORDER BY rowid
    `,
        (rows) => decodeAll(rows, Application.decode),
      ),
    );

  const addCardEvent = (event: NewCardEvent, applicationId?: string) => {
    const insert = Effect.gen(function* () {
      if (applicationId !== undefined) {
        const existing = yield* sql<IdJsonRow>`
          SELECT e.id, e.json FROM ardud_kanban_instruction_applications a
          JOIN ardud_kanban_card_events e ON e.id = a.audit_event_id
          WHERE a.id = ${applicationId} AND a.card_id = ${event.cardId}
        `;
        if (existing[0]) {
          const saved = yield* CardEvent.decode(existing[0].json);
          return { ...saved, id: Number(existing[0].id) } as KanbanCardEvent;
        }
      }
      const json = yield* CardEvent.encode(event);
      const rows = yield* sql<{ readonly id: number }>`
        INSERT INTO ardud_kanban_card_events (card_id, json) VALUES (${event.cardId}, ${json})
        RETURNING id
      `;
      const id = Number(rows[0]?.id ?? 0);
      if (applicationId !== undefined) {
        yield* sql`
          UPDATE ardud_kanban_instruction_applications SET audit_event_id = ${id}
          WHERE id = ${applicationId} AND card_id = ${event.cardId} AND audit_event_id IS NULL
        `;
      }
      return { ...event, id } as KanbanCardEvent;
    });
    return run(
      "write card event",
      applicationId === undefined ? insert : sql.withTransaction(insert),
    );
  };
  const cardEvents = (cardId: KanbanCardId) =>
    runRead(
      "read card events",
      Effect.flatMap(
        sql<IdJsonRow>`SELECT id, json FROM ardud_kanban_card_events WHERE card_id = ${cardId} ORDER BY id`,
        (rows) =>
          Effect.forEach(rows, (row) =>
            Effect.map(
              CardEvent.decode(row.json),
              (event) => ({ ...event, id: Number(row.id) }) as KanbanCardEvent,
            ),
          ),
      ),
    );

  const boardEvents = (boardId: KanbanBoardId, since: string, until: string) =>
    runRead(
      "read board events",
      Effect.flatMap(
        sql<IdJsonRow>`
          SELECT e.id, e.json FROM ardud_kanban_card_events e INDEXED BY ardud_kanban_card_events_at
          JOIN ardud_kanban_cards c ON c.id = e.card_id
          WHERE json_extract(e.json, '$.at') >= ${since} AND json_extract(e.json, '$.at') < ${until}
            AND c.board_id = ${boardId}
          ORDER BY e.id
        `,
        (rows) =>
          Effect.forEach(rows, (row) =>
            Effect.map(
              CardEvent.decode(row.json),
              (event) => ({ ...event, id: Number(row.id) }) as KanbanCardEvent,
            ),
          ),
      ),
    );

  const activityHistory: KanbanStoreShape["activityHistory"] = (boardId, window) =>
    runRead(
      "read activity boundary history",
      Effect.flatMap(
        sql<IdJsonRow>`
          WITH history AS (
            SELECT e.id, e.card_id, json_extract(e.json, '$.at') AS at,
              json_extract(e.json, '$.kind') AS kind,
              substr(json_extract(e.json, '$.body'), 1, length('Wait expired: ')) AS body,
              json_extract(e.json, '$.toStage') AS to_stage,
              json_extract(e.json, '$.fromStage') AS from_stage
            FROM ardud_kanban_cards c
            JOIN ardud_kanban_card_events e INDEXED BY ardud_kanban_card_events_card ON e.card_id = c.id
            WHERE c.board_id = ${boardId}
              AND (json_extract(e.json, '$.at') < ${window.since} OR json_extract(e.json, '$.at') >= ${window.until})
          ), markers AS (
            SELECT *, (to_stage IS NOT NULL AND to_stage IS NOT from_stage) AS is_stage,
              (kind IN ('wait_set', 'wait_cleared', 'wait_expired') OR
                (kind = 'edited' AND (body GLOB 'Waiting *' OR body GLOB 'Wait ended: *' OR body GLOB 'Wait expired: *'))) AS is_wait,
              (kind IN ('flagged', 'moved', 'review', 'wait_set') OR
                (to_stage IS NOT NULL AND to_stage IS NOT from_stage) OR
                (kind = 'edited' AND body GLOB 'Waiting *')) AS is_stall
            FROM history
          ), picked AS (
            SELECT MAX(id) AS id FROM markers WHERE at < ${window.since} AND is_wait GROUP BY card_id
            UNION SELECT MAX(id) AS id FROM markers WHERE at < ${window.since} AND is_stall GROUP BY card_id
            UNION SELECT MAX(id) AS id FROM markers WHERE at < ${window.since} AND is_stage GROUP BY card_id
            UNION SELECT MIN(id) AS id FROM markers WHERE at >= ${window.until} AND is_stage GROUP BY card_id
          )
          SELECT id, json FROM ardud_kanban_card_events WHERE id IN (SELECT id FROM picked) ORDER BY id
        `,
        (rows) =>
          Effect.forEach(rows, (row) =>
            Effect.map(
              CardEvent.decode(row.json),
              (event) => ({ ...event, id: Number(row.id) }) as KanbanCardEvent,
            ),
          ),
      ),
    );

  const lastTransitions = (
    _boardId: KanbanBoardId,
    cardIds: ReadonlyArray<KanbanCardId>,
    beforeId: number,
  ) =>
    cardIds.length === 0
      ? Effect.succeed([] as ReadonlyArray<KanbanCardEvent>)
      : runRead(
          "read last stage changes",
          Effect.flatMap(
            sql<IdJsonRow>`
              SELECT id, json FROM ardud_kanban_card_events
              WHERE id IN (
                SELECT MAX(id) FROM ardud_kanban_card_events INDEXED BY ardud_kanban_card_events_card
                WHERE card_id IN ${sql.in(cardIds)} AND id < ${beforeId}
                  AND json_extract(json, '$.toStage') IS NOT NULL
                  AND json_extract(json, '$.toStage') IS NOT json_extract(json, '$.fromStage')
                GROUP BY card_id
              )
              ORDER BY id
            `,
            (rows) =>
              Effect.forEach(rows, (row) =>
                Effect.map(
                  CardEvent.decode(row.json),
                  (event) => ({ ...event, id: Number(row.id) }) as KanbanCardEvent,
                ),
              ),
          ),
        );

  const goals = (boardId: KanbanBoardId) =>
    runRead(
      "read goals",
      Effect.gen(function* () {
        const rows =
          yield* sql<KeyedJsonRow>`SELECT id, board_id, cache_version, json FROM ardud_kanban_goals WHERE board_id = ${boardId} ORDER BY rowid`;
        const ids = new Set(rows.map(rowKey));
        yield* decoders.goal.reconcile(boardId, ids);
        yield* decoders.goalFeed.reconcile(boardId, ids);
        return yield* decodeAll(rows, decoders.goal);
      }),
    );
  const putGoal = (goal: KanbanGoal) =>
    run(
      "write goal",
      Effect.gen(function* () {
        const json = yield* Goal.encode(goal);
        yield* sql`
          INSERT INTO ardud_kanban_goals (id, board_id, json) VALUES (${goal.id}, ${goal.boardId}, ${json})
          ON CONFLICT (id) DO UPDATE SET json = excluded.json
        `;
      }),
    );

  const pools = (boardId: KanbanBoardId) =>
    runRead(
      "read pools",
      Effect.gen(function* () {
        const rows =
          yield* sql<KeyedJsonRow>`SELECT key AS id, board_id, cache_version, json FROM ardud_kanban_pools WHERE board_id = ${boardId} ORDER BY rowid`;
        const ids = new Set(rows.map(poolKey));
        yield* decoders.pool.reconcile(boardId, ids);
        return yield* decodeAll(rows, decoders.pool);
      }),
    );
  const putPool = (boardId: KanbanBoardId, pool: KanbanPool) =>
    run(
      "write pool",
      Effect.gen(function* () {
        const json = yield* Pool.encode(pool);
        yield* sql`
          INSERT INTO ardud_kanban_pools (board_id, key, json) VALUES (${boardId}, ${pool.key}, ${json})
          ON CONFLICT (board_id, key) DO UPDATE SET json = excluded.json
        `;
      }),
    );
  const rekeyBoard = (
    boardId: KanbanBoardId,
    pools: ReadonlyArray<{ readonly from: string; readonly pool: KanbanPool }>,
    cards: ReadonlyArray<KanbanCard>,
  ) =>
    run(
      "rekey board",
      sql
        .withTransaction(
          Effect.gen(function* () {
            for (const { from, pool } of pools) {
              const json = yield* Pool.encode(pool);
              yield* sql`
              UPDATE ardud_kanban_pools SET key = ${pool.key}, json = ${json}
              WHERE board_id = ${boardId} AND key = ${from}
            `;
            }
            for (const card of cards) {
              const json = yield* Card.encode(card);
              yield* sql`UPDATE ardud_kanban_cards SET json = ${json} WHERE id = ${card.id}`;
              cardWritten(card);
            }
          }),
        )
        .pipe(
          Effect.tap(() =>
            updateCaller(() => {
              for (const card of cards) {
                callerCards.set(card.id, { number: card.number, stage: card.stage });
              }
            }),
          ),
        ),
    );
  const migrateBoardSelections = (input: {
    readonly board: KanbanBoard;
    readonly pools: ReadonlyArray<KanbanPool>;
    readonly oldPoolKeys: ReadonlyArray<string>;
    readonly cards: ReadonlyArray<KanbanCard>;
    readonly threadLinks: ReadonlyArray<KanbanThreadLink>;
  }) =>
    run(
      "migrate board selections",
      sql
        .withTransaction(
          Effect.gen(function* () {
            const boardJson = yield* Board.encode(input.board);
            yield* sql`
            INSERT INTO ardud_kanban_boards (id, slug, json) VALUES (${input.board.id}, ${input.board.slug}, ${boardJson})
            ON CONFLICT (id) DO UPDATE SET slug = excluded.slug, json = excluded.json
          `;
            // The board reads its pools in insertion order (ORDER BY rowid), so a migrated pool keeps its row
            // and its place: a key change is an in-place UPDATE, never a delete and re-insert. Only a key
            // that leaves the board is deleted. `oldPoolKeys` and `pools` are paired by position.
            // Re-keyed pools move first, so their rows are never deleted in the way; the removal pass that
            // follows only sees keys that genuinely left the board.
            const survivingKeys = new Set(input.pools.map((pool) => pool.key));
            for (const [index, pool] of input.pools.entries()) {
              const poolJson = yield* Pool.encode(pool);
              const oldKey = input.oldPoolKeys[index];
              if (oldKey !== undefined && oldKey !== pool.key) {
                yield* sql`
                UPDATE ardud_kanban_pools SET key = ${pool.key}, json = ${poolJson}
                WHERE board_id = ${input.board.id} AND key = ${oldKey}
              `;
                continue;
              }
              yield* sql`
              INSERT INTO ardud_kanban_pools (board_id, key, json) VALUES (${input.board.id}, ${pool.key}, ${poolJson})
              ON CONFLICT (board_id, key) DO UPDATE SET json = excluded.json
            `;
            }
            for (const key of input.oldPoolKeys) {
              if (survivingKeys.has(key)) continue;
              yield* sql`DELETE FROM ardud_kanban_pools WHERE board_id = ${input.board.id} AND key = ${key}`;
            }
            const observe = yield* cardWrites;
            for (const value of input.cards) {
              const previous = observe === undefined ? null : yield* card(value.id);
              const json = yield* Card.encode(value);
              yield* sql`
              UPDATE ardud_kanban_cards SET json = ${json}, active_thread_id = ${value.activeThreadId}, stage = ${value.stage}
              WHERE id = ${value.id}
            `;
              observe?.(previous === null ? [value] : [previous, value]);
              cardWritten(value);
            }
            for (const link of input.threadLinks) {
              const json = yield* ThreadLink.encode(link);
              yield* sql`UPDATE ardud_kanban_threads SET json = ${json} WHERE thread_id = ${link.threadId}`;
            }
          }),
        )
        .pipe(
          Effect.tap(() =>
            updateCaller(() => {
              for (const card of input.cards) {
                callerCards.set(card.id, { number: card.number, stage: card.stage });
              }
              for (const link of input.threadLinks) callerLinks.set(link.threadId, link);
            }),
          ),
        ),
    );
  const removePool = (boardId: KanbanBoardId, key: string) =>
    run(
      "remove pool",
      Effect.asVoid(
        sql`DELETE FROM ardud_kanban_pools WHERE board_id = ${boardId} AND key = ${key}`,
      ),
    );

  const groups = (boardId: KanbanBoardId) =>
    runRead(
      "read groups",
      Effect.flatMap(
        sql<JsonRow>`SELECT json FROM ardud_kanban_groups WHERE board_id = ${boardId}`,
        (rows) => (rows[0] ? Groups.decode(rows[0].json) : Effect.succeed([])),
      ),
    );
  const putGroups = (boardId: KanbanBoardId, value: ReadonlyArray<KanbanGroup>) =>
    run(
      "write groups",
      Effect.gen(function* () {
        const json = yield* Groups.encode(value);
        yield* sql`
          INSERT INTO ardud_kanban_groups (board_id, json) VALUES (${boardId}, ${json})
          ON CONFLICT (board_id) DO UPDATE SET json = excluded.json
        `;
      }),
    );

  const discussions = (boardId: KanbanBoardId) =>
    runRead(
      "read discussions",
      readCollection(
        sql<KeyedVersionRow>`SELECT id, board_id, cache_version FROM ardud_kanban_discussions WHERE board_id = ${boardId} ORDER BY rowid`,
        "ardud_kanban_discussions",
        decoders.discussion,
        (rows) => decoders.discussion.reconcile(boardId, new Set(rows.map(rowKey))),
      ),
    );
  const openDiscussions = (boardId: KanbanBoardId) =>
    runRead(
      "read open discussions",
      readCollection(
        sql<KeyedVersionRow>`SELECT id, board_id, cache_version FROM ardud_kanban_discussions
          WHERE board_id = ${boardId}
            AND json_extract(json, '$.settledAt') IS NULL
            AND json_extract(json, '$.archivedAt') IS NULL
          ORDER BY rowid`,
        "ardud_kanban_discussions",
        decoders.discussion,
      ),
    );
  const discussion = (id: KanbanDiscussionId) =>
    runRead(
      "read discussion",
      Effect.flatMap(
        sql<KeyedJsonRow>`SELECT id, board_id, cache_version, json FROM ardud_kanban_discussions WHERE id = ${id}`,
        (rows) =>
          rows.length === 0
            ? decoders.discussion.drop(id).pipe(Effect.as(null))
            : Effect.map(decodeAll(rows, decoders.discussion), first),
      ),
    );
  const latestSystemDiscussion = (boardId: KanbanBoardId, component: string) =>
    runRead(
      "read latest system discussion",
      Effect.flatMap(
        sql<KeyedJsonRow>`SELECT id, board_id, cache_version, json FROM ardud_kanban_discussions
          WHERE board_id = ${boardId} AND card_id IS NULL
            AND json_extract(json, '$.archivedAt') IS NULL
            AND json_extract(json, '$.createdBy._tag') = 'system'
            AND json_extract(json, '$.createdBy.component') = ${component}
          ORDER BY rowid DESC LIMIT 1`,
        (rows) => Effect.map(decodeAll(rows, decoders.discussion), first),
      ),
    );
  const discussionByEvaluator = (threadId: string) =>
    runRead(
      "read discussion by evaluator",
      Effect.flatMap(
        sql<KeyedJsonRow>`
          SELECT id, board_id, cache_version, json FROM ardud_kanban_discussions WHERE evaluator_thread_id = ${threadId} LIMIT 1
        `,
        (rows) => Effect.map(decodeAll(rows, decoders.discussion), first),
      ),
    );
  const discussionBoardIdsByEvaluator = (threadId: string) =>
    runRead(
      "read discussion boards by evaluator",
      Effect.map(
        sql<{ readonly board_id: KanbanBoardId }>`
          SELECT DISTINCT board_id FROM ardud_kanban_discussions
          WHERE evaluator_thread_id = ${threadId} ORDER BY board_id
        `,
        (rows) => rows.map((row) => row.board_id),
      ),
    );
  const putDiscussion = (value: KanbanDiscussion) =>
    run(
      "write discussion",
      Effect.gen(function* () {
        const json = yield* Discussion.encode(value);
        yield* sql`
          INSERT INTO ardud_kanban_discussions (id, board_id, card_id, evaluator_thread_id, json)
          VALUES (${value.id}, ${value.boardId}, ${value.cardId}, ${value.evaluatorThreadId}, ${json})
          ON CONFLICT (id) DO UPDATE SET
            card_id = excluded.card_id,
            evaluator_thread_id = excluded.evaluator_thread_id,
            json = excluded.json
        `;
      }),
    );
  const messages = (
    id: KanbanDiscussionId,
    options?: { readonly afterSeq?: number; readonly beforeSeq?: number; readonly limit?: number },
  ) =>
    runRead(
      "read messages",
      Effect.flatMap(
        sql<JsonRow>`
          SELECT json FROM (
            SELECT seq, json FROM ardud_kanban_messages
            WHERE discussion_id = ${id} AND seq > ${options?.afterSeq ?? 0}
              AND seq < ${options?.beforeSeq ?? Number.MAX_SAFE_INTEGER}
            ORDER BY seq DESC LIMIT ${options?.limit ?? 200}
          ) ORDER BY seq
        `,
        (rows) => decodeAll(rows, Message.decode),
      ),
    );
  // Walks the discussion's primary key newest first; json_extract stays in SQLite, so a
  // multi-MB history is never decoded.
  const ownerWait = (id: KanbanDiscussionId) =>
    runRead(
      "read owner wait",
      Effect.map(
        sql<{ readonly seq: number; readonly createdAt: string; readonly answered: number }>`
          SELECT m.seq AS seq,
            json_extract(m.json, '$.createdAt') AS createdAt,
            EXISTS (
              SELECT 1 FROM ardud_kanban_messages e
              WHERE e.discussion_id = m.discussion_id AND e.seq > m.seq
                AND json_extract(e.json, '$.author._tag') = 'evaluator'
            ) AS answered
          FROM ardud_kanban_messages m
          WHERE m.discussion_id = ${id} AND json_extract(m.json, '$.author._tag') = 'owner'
          ORDER BY m.seq DESC LIMIT 1
        `,
        (rows) => {
          const row = rows[0];
          return row
            ? {
                seq: Number(row.seq),
                createdAt: String(row.createdAt),
                answered: Number(row.answered) === 1,
              }
            : null;
        },
      ),
    );
  const ownerReply: KanbanStoreShape["ownerReply"] = Effect.fn("KanbanStore.ownerReply")(
    function* (id, threadId, evaluator) {
      return yield* runRead(
        "read owner reply obligation",
        Effect.map(
          sql<{ readonly key: string; readonly createdAt: string; readonly answered: number }>`
            WITH actions AS (
              SELECT seq, '' AS block, json_extract(json, '$.createdAt') AS at
              FROM ardud_kanban_messages
              WHERE discussion_id = ${id} AND json_extract(json, '$.author._tag') = 'owner'
              UNION ALL
              SELECT m.seq, json_extract(a.value, '$.blockId'), json_extract(a.value, '$.at')
              FROM ardud_kanban_messages m, json_each(m.json, '$.answers') a
              WHERE m.discussion_id = ${id} AND json_extract(a.value, '$.by._tag') = 'owner'
            )
            SELECT seq || ':' || block || ':' || at AS key, at AS createdAt, EXISTS (
              SELECT 1 FROM ardud_kanban_messages reply
              WHERE reply.discussion_id = ${id}
                AND (json_extract(reply.json, '$.createdAt') > actions.at OR
                  (json_extract(reply.json, '$.createdAt') = actions.at AND reply.seq > actions.seq))
                AND ((${evaluator} AND json_extract(reply.json, '$.author._tag') = 'evaluator')
                  OR json_extract(reply.json, '$.author.threadId') = ${threadId})
            ) AS answered
            FROM actions ORDER BY at DESC, seq DESC, block DESC LIMIT 1
          `,
          (rows) =>
            rows[0]
              ? {
                  key: rows[0].key,
                  createdAt: rows[0].createdAt,
                  answered: Number(rows[0].answered) === 1,
                }
              : null,
        ),
      );
    },
  );
  const allMessages = (id: KanbanDiscussionId) =>
    runRead(
      "read all messages",
      Effect.flatMap(
        sql<JsonRow>`SELECT json FROM ardud_kanban_messages WHERE discussion_id = ${id} ORDER BY seq`,
        (rows) => decodeAll(rows, Message.decode),
      ),
    );
  const message = (id: KanbanDiscussionId, seq: number) =>
    runRead(
      "read message",
      Effect.flatMap(
        sql<JsonRow>`SELECT json FROM ardud_kanban_messages WHERE discussion_id = ${id} AND seq = ${seq}`,
        (rows) => Effect.map(decodeAll(rows, Message.decode), first),
      ),
    );
  const putMessage = (value: KanbanMessage) =>
    run(
      "write message",
      Effect.gen(function* () {
        const json = yield* Message.encode(value);
        yield* sql`
          INSERT INTO ardud_kanban_messages (discussion_id, seq, json)
          VALUES (${value.discussionId}, ${value.seq}, ${json})
          ON CONFLICT (discussion_id, seq) DO UPDATE SET json = excluded.json
        `;
      }),
    );

  const scripts = (boardId: KanbanBoardId) =>
    runRead(
      "read scripts",
      Effect.flatMap(
        sql<JsonRow>`SELECT json FROM ardud_kanban_scripts WHERE board_id = ${boardId} ORDER BY rowid`,
        (rows) => decodeAll(rows, Script.decode),
      ),
    );
  const allScripts = runRead(
    "read all scripts",
    Effect.flatMap(sql<JsonRow>`SELECT json FROM ardud_kanban_scripts ORDER BY rowid`, (rows) =>
      decodeAll(rows, Script.decode),
    ),
  );
  const script = (id: KanbanScriptId) =>
    runRead(
      "read script",
      Effect.flatMap(sql<JsonRow>`SELECT json FROM ardud_kanban_scripts WHERE id = ${id}`, (rows) =>
        Effect.map(decodeAll(rows, Script.decode), first),
      ),
    );
  const putScript = (value: KanbanScript) =>
    run(
      "write script",
      Effect.gen(function* () {
        const json = yield* Script.encode(value);
        yield* sql`
          INSERT INTO ardud_kanban_scripts (id, board_id, json) VALUES (${value.id}, ${value.boardId}, ${json})
          ON CONFLICT (id) DO UPDATE SET json = excluded.json
        `;
      }),
    );
  const addScriptRun = (value: NewScriptRun) =>
    run(
      "write script run",
      Effect.gen(function* () {
        const json = yield* ScriptRun.encode(value);
        const rows = yield* sql<{ readonly id: number }>`
          INSERT INTO ardud_kanban_script_runs (script_id, json) VALUES (${value.scriptId}, ${json})
          RETURNING id
        `;
        return { ...value, id: Number(rows[0]?.id ?? 0) } as KanbanScriptRun;
      }),
    );
  const putScriptRun = (value: KanbanScriptRun) =>
    run(
      "update script run",
      Effect.gen(function* () {
        const { id, ...rest } = value;
        const json = yield* ScriptRun.encode(rest);
        yield* sql`UPDATE ardud_kanban_script_runs SET json = ${json} WHERE id = ${id}`;
      }),
    );
  const scriptRuns = (id: KanbanScriptId, limit: number) =>
    runRead(
      "read script runs",
      Effect.flatMap(
        sql<IdJsonRow>`
          SELECT id, json FROM ardud_kanban_script_runs WHERE script_id = ${id} ORDER BY id DESC LIMIT ${limit}
        `,
        (rows) =>
          Effect.forEach(rows, (row) =>
            Effect.map(
              ScriptRun.decode(row.json),
              (value) => ({ ...value, id: Number(row.id) }) as KanbanScriptRun,
            ),
          ),
      ),
    );

  const automations = (boardId: KanbanBoardId) =>
    runRead(
      "read automations",
      Effect.flatMap(
        sql<JsonRow>`SELECT json FROM ardud_kanban_automations WHERE board_id = ${boardId} ORDER BY rowid`,
        (rows) => decodeAll(rows, Automation.decode),
      ),
    );
  const putAutomation = (value: KanbanAutomation) =>
    run(
      "write automation",
      Effect.gen(function* () {
        const json = yield* Automation.encode(value);
        yield* sql`
          INSERT INTO ardud_kanban_automations (id, board_id, json) VALUES (${value.id}, ${value.boardId}, ${json})
          ON CONFLICT (id) DO UPDATE SET json = excluded.json
        `;
      }),
    );

  const wiki = (boardId: KanbanBoardId) =>
    runRead(
      "read wiki",
      Effect.flatMap(
        sql<JsonRow>`SELECT json FROM ardud_kanban_wiki WHERE board_id = ${boardId} ORDER BY slug`,
        (rows) => decodeAll(rows, Wiki.decode),
      ),
    );
  const putWiki = (page: KanbanWikiPage) =>
    run(
      "write wiki",
      Effect.gen(function* () {
        const json = yield* Wiki.encode(page);
        yield* sql`
          INSERT INTO ardud_kanban_wiki (board_id, slug, json) VALUES (${page.boardId}, ${page.slug}, ${json})
          ON CONFLICT (board_id, slug) DO UPDATE SET json = excluded.json
        `;
      }),
    );

  const threadLink = (threadId: string) =>
    runRead(
      "read thread link",
      Effect.flatMap(
        sql<KeyedJsonRow>`SELECT thread_id AS id, board_id, cache_version, json FROM ardud_kanban_threads WHERE thread_id = ${threadId}`,
        (rows) =>
          Effect.gen(function* () {
            if (rows.length === 0) yield* decoders.thread.drop(threadId);
            return first(yield* decodeAll(rows, decoders.thread));
          }),
      ),
    );
  const threadLinksByIds: KanbanStoreShape["threadLinksByIds"] = (threadIds) =>
    threadIds.length === 0
      ? Effect.succeed([])
      : runRead(
          "read thread links by ids",
          Effect.flatMap(
            sql<KeyedJsonRow>`SELECT thread_id AS id, board_id, cache_version, json FROM ardud_kanban_threads WHERE thread_id IN ${sql.in(threadIds)}`,
            (rows) => decodeAll(rows, decoders.thread),
          ),
        );
  const threadLinks: KanbanStoreShape["threadLinks"] = (filter) =>
    runRead(
      "read thread links",
      Effect.flatMap(
        "cardId" in filter
          ? sql<KeyedJsonRow>`
              SELECT thread_id AS id, board_id, cache_version, json FROM ardud_kanban_threads
              WHERE card_id = ${filter.cardId}
                OR thread_id IN (
                  SELECT thread_id FROM ardud_kanban_thread_cards WHERE card_id = ${filter.cardId}
                )
              ORDER BY rowid
            `
          : filter.open
            ? sql<KeyedJsonRow>`SELECT thread_id AS id, board_id, cache_version, json FROM ardud_kanban_threads WHERE board_id = ${filter.boardId} AND ended = 0 ORDER BY rowid`
            : sql<KeyedJsonRow>`SELECT thread_id AS id, board_id, cache_version, json FROM ardud_kanban_threads WHERE board_id = ${filter.boardId} ORDER BY rowid`,
        (rows) =>
          Effect.gen(function* () {
            if ("boardId" in filter && !filter.open)
              yield* decoders.thread.reconcile(filter.boardId, new Set(rows.map((row) => row.id)));
            return yield* decodeAll(rows, decoders.thread);
          }),
      ),
    );
  const openReviewLinks: KanbanStoreShape["openReviewLinks"] = (boardId) =>
    runRead(
      "read open review links with cards",
      Effect.flatMap(
        sql<{ thread_json: string; card_json: string | null }>`
          SELECT t.json AS thread_json, c.json AS card_json
          FROM ardud_kanban_threads t
          LEFT JOIN ardud_kanban_cards c ON c.id = t.card_id AND c.board_id = t.board_id
          WHERE t.board_id = ${boardId} AND t.ended = 0
            AND json_extract(t.json, '$.role') = 'review'
          ORDER BY t.rowid
        `,
        (rows) =>
          Effect.forEach(rows, (row) =>
            Effect.all({
              link: ThreadLink.decode(row.thread_json),
              card: row.card_json === null ? Effect.succeed(null) : Card.decode(row.card_json),
            }),
          ),
      ),
    );
  const putThreadLink = (link: KanbanThreadLink) =>
    run(
      "write thread link",
      Effect.gen(function* () {
        const json = yield* ThreadLink.encode(link);
        const ended = link.endedAt === null ? 0 : 1;
        yield* sql`
          INSERT INTO ardud_kanban_threads (thread_id, board_id, card_id, ended, json)
          VALUES (${link.threadId}, ${link.boardId}, ${link.cardId}, ${ended}, ${json})
          ON CONFLICT (thread_id) DO UPDATE SET
            card_id = excluded.card_id, ended = excluded.ended, json = excluded.json
        `;
        yield* updateCaller(() => callerLinks.set(link.threadId, link));
      }),
    );

  const addThreadCard = (threadId: string, cardId: KanbanCardId, at: string) =>
    run(
      "write thread card",
      sql`
        INSERT INTO ardud_kanban_thread_cards (thread_id, card_id, joined_at)
        VALUES (${threadId}, ${cardId}, ${at})
        ON CONFLICT (thread_id, card_id) DO NOTHING
      `.pipe(Effect.asVoid),
    );
  const threadCards = (threadId: string) =>
    runRead(
      "read thread cards",
      Effect.map(
        sql<{ readonly card_id: string }>`
          SELECT card_id FROM ardud_kanban_thread_cards WHERE thread_id = ${threadId}
          ORDER BY joined_at, rowid
        `,
        (rows) => rows.map((row) => KanbanCardId.make(row.card_id)),
      ),
    );

  return KanbanStore.of({
    callerAnalytics,
    observeCallerWrites,
    registerCallerParent: (threadId, parentThreadId) => {
      callerParents.set(threadId, parentThreadId);
    },
    decodeCacheStats,
    boards,
    board,
    putBoard,
    putBoardWithPools,
    cards,
    openCards,
    dispatchCards,
    watchCardWrites,
    summaryCards,
    feedCards,
    cardPage,
    feedGoals: (boardId) =>
      runRead(
        "read feed goals",
        Effect.flatMap(
          sql<KeyedJsonRow>`SELECT id, board_id, cache_version, json_set(json, '$.story', json(COALESCE((
        SELECT json_group_array(json(entry)) FROM (
          SELECT json_object('at', json_extract(story.value, '$.at'), 'text', substr(json_extract(story.value, '$.text'), 1, 512)) AS entry
          FROM (SELECT value FROM json_each(ardud_kanban_goals.json, '$.story') ORDER BY CAST(key AS INTEGER) DESC LIMIT 20) AS story
          ORDER BY json_extract(story.value, '$.at')
        )
      ), '[]'))) AS json FROM ardud_kanban_goals WHERE board_id = ${boardId} ORDER BY rowid`,
          (rows) => decodeAll(rows, decoders.goalFeed),
        ),
      ),
    card,
    cardByNumber,
    cardsByThread,
    poolThreadIds,
    claimCards,
    schedulingCards,
    cardsInStage,
    nextCardNumber,
    putCard,
    addSlotEvent,
    slotEvents,
    slotHistory,
    openSlots,
    addCardEvent,
    pendingInstructionApplications,
    cardEvents,
    boardEvents,
    activityHistory,
    lastTransitions,
    goals,
    putGoal,
    pools,
    putPool,
    removePool,
    rekeyBoard,
    migrateBoardSelections,
    groups,
    putGroups,
    discussions,
    openDiscussions,
    discussion,
    latestSystemDiscussion,
    discussionByEvaluator,
    discussionBoardIdsByEvaluator,
    putDiscussion,
    messages,
    ownerWait,
    ownerReply,
    allMessages,
    message,
    putMessage,
    scripts,
    allScripts,
    script,
    putScript,
    addScriptRun,
    putScriptRun,
    scriptRuns,
    automations,
    putAutomation,
    wiki,
    putWiki,
    threadLink,
    threadLinksByIds,
    threadLinks,
    openReviewLinks,
    putThreadLink,
    addThreadCard,
    threadCards,
  });
});

export const layer = Layer.effect(KanbanStore, make);
