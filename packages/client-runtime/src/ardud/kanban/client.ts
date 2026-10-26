import {
  KANBAN_WS_METHODS as M,
  type KanbanBlock,
  type KanbanBoard,
  type KanbanBoardUpdateInput,
  type KanbanCardDetail,
  type KanbanCardPatchInput,
  type KanbanDiscussion,
  type KanbanMessage,
  type KanbanWatchEvent,
  type KanbanWikiPage,
  type ModelSelection,
} from "@t3tools/contracts";

import type { Listener, Unsubscribe } from "../missions/source.ts";
import {
  createKeyedSnapshotStores,
  createSnapshotStore,
  type SnapshotStore,
  type SnapshotStoreOptions,
} from "../missions/store.ts";
import {
  applyKanbanWatchEvent,
  withDiscussionList,
  withDiscussions,
  ownerReadSeq,
  withOwnerRead,
  type KanbanBoardState,
} from "./boardState.ts";
import { isKanbanServerError, type KanbanTransport } from "./transport.ts";
import { mergeMessages } from "./viewModel.ts";

/**
 * One live feed per board, shared by every store that needs it: the board
 * itself, open discussions and open cards. The feed opens with its first
 * listener and closes with its last.
 */
interface BoardFeed {
  state: KanbanBoardState | undefined;
  readonly events: Set<Listener<KanbanWatchEvent>>;
  readonly failures: Set<Listener<unknown>>;
  close: Unsubscribe | null;
  failed: boolean;
  error: unknown;
}

export interface KanbanClient {
  readonly boards: SnapshotStore<ReadonlyArray<KanbanBoard>>;
  board(boardId: string): SnapshotStore<KanbanBoardState>;
  messages(boardId: string, discussionId: string): SnapshotStore<ReadonlyArray<KanbanMessage>>;
  card(boardId: string, cardId: string): SnapshotStore<KanbanCardDetail>;
  wiki(boardId: string): SnapshotStore<ReadonlyArray<KanbanWikiPage>>;

  patchCard(input: KanbanCardPatchInput): Promise<void>;
  settleCard(cardId: string): Promise<void>;
  stopCard(cardId: string): Promise<void>;
  /** The card's discussion, created on first use. */
  cardDiscussion(boardId: string, cardId: string): Promise<KanbanDiscussion>;
  setPool(boardId: string, model: ModelSelection, slots: number): Promise<void>;
  updateBoard(input: KanbanBoardUpdateInput): Promise<void>;
  createDiscussion(boardId: string, title: string): Promise<KanbanDiscussion>;
  /** Marks read at once; the server catches up in the background. */
  markRead(boardId: string, discussionId: string, seq: number): void;
  post(boardId: string, discussionId: string, blocks: ReadonlyArray<KanbanBlock>): Promise<void>;
  answer(
    boardId: string,
    discussionId: string,
    seq: number,
    blockId: string,
    choice: ReadonlyArray<string>,
  ): Promise<void>;
  /**
   * While watched, the newest message of recent discussions is read whenever
   * a preview falls behind. Screens that list discussions watch; the board
   * feed alone reads no messages.
   */
  watchPreviews(boardId: string): Unsubscribe;
}

const PREVIEW_FETCH_LIMIT = 40;
const MESSAGE_PAGE = 200;
const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 60_000;
const BOARDS_REFRESH_MS = 2 * 60_000;

/**
 * Runs `load` one at a time. A call while it runs asks for one more run after
 * it; a failed run tries again after a growing pause until closed.
 */
function serialLoader(load: () => Promise<void>) {
  let running = false;
  let again = false;
  let closed = false;
  let pause = RETRY_MIN_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };
  const run = (): void => {
    if (closed) return;
    if (running) {
      again = true;
      return;
    }
    clear();
    running = true;
    load().then(
      () => {
        running = false;
        pause = RETRY_MIN_MS;
        if (!again) return;
        again = false;
        run();
      },
      () => {
        running = false;
        if (closed) return;
        // A run asked for while this one failed starts now; the pause is for
        // trying the same thing again.
        if (again) {
          again = false;
          run();
          return;
        }
        // @effect-diagnostics-next-line globalTimers:off - Plain callback store shared by web and mobile.
        timer = setTimeout(run, pause);
        pause = Math.min(pause * 2, RETRY_MAX_MS);
      },
    );
  };
  return {
    run,
    /** Skips the pause of a failed run that is waiting to try again. */
    nudge() {
      if (timer !== null) run();
    },
    close() {
      closed = true;
      clear();
    },
  };
}

export function createKanbanClient(
  transport: KanbanTransport,
  options: SnapshotStoreOptions = {},
): KanbanClient {
  const feeds = new Map<string, BoardFeed>();
  // Followers (see `follow`) waiting to join a board's next feed.
  const rejoins = new Map<string, Set<() => void>>();
  // Board state is written by the feed and by optimistic updates; the board
  // store re-emits whenever either changes it.
  const stateListeners = new Map<string, Set<() => void>>();

  // Set while the boards store is open; a board snapshot (first load or a
  // reconnect) is a good moment to read the list again.
  let refreshBoards: (() => void) | null = null;

  const notifyState = (boardId: string) => {
    for (const listener of Array.from(stateListeners.get(boardId) ?? [])) listener();
  };

  // Reads the owner made that the server has not echoed yet. A list read or a
  // snapshot answered before the server applied the read would otherwise put
  // the old unread count back for a moment.
  const pendingReads = new Map<string, Map<string, number>>();
  const withPendingReads = (boardId: string, state: KanbanBoardState) => {
    const pending = pendingReads.get(boardId);
    if (pending === undefined) return state;
    let next = state;
    for (const [discussionId, seq] of pending) {
      const discussion = state.discussions.get(discussionId);
      if (discussion !== undefined && ownerReadSeq(discussion) >= seq) {
        pending.delete(discussionId);
        continue;
      }
      next = withOwnerRead(next, discussionId, seq);
    }
    if (pending.size === 0) pendingReads.delete(boardId);
    return next;
  };
  const sendRead = (discussionId: string, seq: number) => {
    void transport
      .request(M.discussionRead, { discussionId: discussionId as never, seq })
      .catch(() => undefined);
  };
  // A read lost to a dropped connection goes again with the next snapshot;
  // reads the server already applied were cleared from the list above.
  const resendReads = (boardId: string) => {
    for (const [discussionId, seq] of pendingReads.get(boardId) ?? []) sendRead(discussionId, seq);
  };

  const update = (boardId: string, fn: (state: KanbanBoardState) => KanbanBoardState) => {
    const feed = feeds.get(boardId);
    if (feed?.state === undefined) return;
    const next = withPendingReads(boardId, fn(feed.state));
    if (next === feed.state) return;
    feed.state = next;
    notifyState(boardId);
  };

  const listen = (
    boardId: string,
    onEvent: Listener<KanbanWatchEvent>,
    onFailure: Listener<unknown>,
  ): Unsubscribe => {
    let feed = feeds.get(boardId);
    if (feed === undefined) {
      const created: BoardFeed = {
        state: undefined,
        events: new Set(),
        failures: new Set(),
        close: null,
        failed: false,
        error: undefined,
      };
      feed = created;
      feeds.set(boardId, created);
      const closeStream = transport.stream(
        M.subscribe,
        { boardId: boardId as never },
        (event) => {
          const next = applyKanbanWatchEvent(created.state, event);
          created.state = next === undefined ? next : withPendingReads(boardId, next);
          for (const listener of Array.from(created.events)) listener(event);
          if (event._tag === "snapshot") {
            refreshBoards?.();
            resendReads(boardId);
          }
        },
        (error) => {
          // A failed feed is finished: the next listener opens a new one
          // instead of joining this one.
          if (created.failed) return;
          created.failed = true;
          created.error = error;
          if (feeds.get(boardId) === created) feeds.delete(boardId);
          const close = created.close;
          created.close = null;
          close?.();
          for (const listener of Array.from(created.failures)) listener(error);
        },
      );
      // The stream may fail while it opens.
      if (created.failed) closeStream();
      else created.close = closeStream;
      // Followers waiting out a failed feed join this one now.
      const waiting = rejoins.get(boardId);
      if (waiting !== undefined && !created.failed) {
        rejoins.delete(boardId);
        void Promise.resolve().then(() => {
          for (const rejoin of waiting) rejoin();
        });
      }
    }
    const own = feed;
    own.events.add(onEvent);
    own.failures.add(onFailure);
    // Failed while it opened, before anyone listened.
    if (own.failed) void Promise.resolve().then(() => onFailure(own.error));
    return () => {
      own.events.delete(onEvent);
      own.failures.delete(onFailure);
      if (own.events.size > 0) return;
      if (feeds.get(boardId) === own) feeds.delete(boardId);
      const close = own.close;
      own.close = null;
      close?.();
    };
  };

  // For stores that ride on a board's feed without owning its failure (open
  // chats and cards): a failed feed is joined again after a growing pause,
  // and `resync` runs on each rejoin to catch up on what was missed. The
  // board store shows the failure.
  const follow = (
    boardId: string,
    onEvent: Listener<KanbanWatchEvent>,
    resync: () => void,
  ): Unsubscribe => {
    let closed = false;
    let off: Unsubscribe | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pause = RETRY_MIN_MS;
    let joins = 0;
    const stopWaiting = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      rejoins.get(boardId)?.delete(join);
    };
    function join() {
      stopWaiting();
      if (closed || off !== null) return;
      joins += 1;
      off = listen(
        boardId,
        (event) => {
          pause = RETRY_MIN_MS;
          onEvent(event);
        },
        () => {
          // Leave the dead feed so it can be dropped.
          const leave = off;
          off = null;
          leave?.();
          if (closed) return;
          const waiting = rejoins.get(boardId) ?? new Set();
          waiting.add(join);
          rejoins.set(boardId, waiting);
          // @effect-diagnostics-next-line globalTimers:off - Plain callback store shared by web and mobile.
          timer = setTimeout(join, pause);
          pause = Math.min(pause * 2, RETRY_MAX_MS);
        },
      );
      if (joins > 1) resync();
    }
    join();
    return () => {
      closed = true;
      stopWaiting();
      const close = off;
      off = null;
      close?.();
    };
  };

  const board = createKeyedSnapshotStores<string, KanbanBoardState>((boardId, emit, fail) => {
    // Discussions live outside the snapshot, so every snapshot (a reconnect
    // included) reads the list again. Discussions a live change touches while
    // the read is out are newer than the list and keep their entry.
    let fresher: Set<string> | null = null;
    const discussions = serialLoader(async () => {
      const touched = new Set<string>();
      fresher = touched;
      try {
        const list = await transport.request(M.discussions, { boardId: boardId as never });
        update(boardId, (state) => withDiscussionList(state, list, touched));
      } finally {
        if (fresher === touched) fresher = null;
      }
    });
    const emitState = () => {
      const state = feeds.get(boardId)?.state;
      if (state === undefined) return;
      emit(state);
      loadPreviews(boardId);
    };
    const listeners = stateListeners.get(boardId) ?? new Set();
    stateListeners.set(boardId, listeners);
    listeners.add(emitState);
    const off = listen(
      boardId,
      (event) => {
        if (event._tag === "snapshot") discussions.run();
        else if (event.change._tag === "discussion") fresher?.add(event.change.discussion.id);
        emitState();
      },
      fail,
    );
    // Joining a feed another store holds: it may have reconnected since the
    // list was last read.
    if (feeds.get(boardId)?.state !== undefined) discussions.run();
    emitState();
    return () => {
      discussions.close();
      listeners.delete(emitState);
      off();
    };
  }, options);

  const previewWatchers = new Map<string, number>();
  // The discussion seq each preview was last read for, so a read that brings
  // nothing newer is not repeated until the discussion moves on.
  const previewTried = new Map<string, number>();
  const loadPreviews = (boardId: string) => {
    if ((previewWatchers.get(boardId) ?? 0) === 0) return;
    const state = feeds.get(boardId)?.state;
    if (state === undefined) return;
    const behind = [...state.discussions.values()]
      .filter(
        (discussion) =>
          discussion.lastSeq > (state.lastMessages.get(discussion.id)?.seq ?? 0) &&
          (previewTried.get(discussion.id) ?? 0) < discussion.lastSeq,
      )
      .sort((a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""))
      .slice(0, PREVIEW_FETCH_LIMIT);
    for (const discussion of behind) {
      previewTried.set(discussion.id, discussion.lastSeq);
      void transport
        .request(M.messages, {
          discussionId: discussion.id,
          afterSeq: Math.max(0, discussion.lastSeq - 1),
          limit: 1,
        })
        .then(
          (page) => {
            if (page.length > 0) update(boardId, (current) => withDiscussions(current, [], page));
          },
          () => {
            // Try again on the next change.
            previewTried.delete(discussion.id);
          },
        );
    }
  };

  const messages = createKeyedSnapshotStores<string, ReadonlyArray<KanbanMessage>>(
    (key, emit, fail) => {
      const [boardId = "", discussionId = ""] = key.split("\n");
      let list: ReadonlyArray<KanbanMessage> = [];
      let loaded = false;
      // Messages a live change brought while a read was out; they are newer
      // than the read's copies (answers only grow).
      let live: Map<number, KanbanMessage> | null = null;
      // Every read takes the newest page, so answers to recent messages made
      // while away show up too. Only a server answer fails the store; a
      // dropped connection keeps what is shown and tries again.
      const reads = serialLoader(async () => {
        // Taken before the read: live messages landing during it must not
        // count as held, or a gap behind them would go unnoticed.
        const newestHeld = list.at(-1)?.seq ?? 0;
        const during = new Map<number, KanbanMessage>();
        live = during;
        let page: ReadonlyArray<KanbanMessage>;
        try {
          page = await transport.request(M.messages, {
            discussionId: discussionId as never,
            limit: MESSAGE_PAGE,
          });
        } catch (error) {
          if (loaded || !isKanbanServerError(error)) throw error;
          fail(error);
          return;
        } finally {
          if (live === during) live = null;
        }
        // A full page that starts past what is held means more were missed
        // than one page holds: show the newest page alone, never a hole.
        const oldestRead = page[0]?.seq ?? 0;
        const base = page.length >= MESSAGE_PAGE && oldestRead > newestHeld + 1 ? [] : list;
        list = mergeMessages(mergeMessages(base, page), [...during.values()]);
        loaded = true;
        emit(list);
      });
      const off = follow(
        boardId,
        (event) => {
          if (event._tag === "snapshot") {
            if (loaded) reads.run();
            else reads.nudge();
            return;
          }
          const change = event.change;
          if (change._tag !== "message" || change.message.discussionId !== discussionId) return;
          live?.set(change.message.seq, change.message);
          list = mergeMessages(list, [change.message]);
          if (loaded) emit(list);
        },
        reads.run,
      );
      reads.run();
      return () => {
        reads.close();
        off();
      };
    },
    options,
  );

  const card = createKeyedSnapshotStores<string, KanbanCardDetail>((key, emit, fail) => {
    const [boardId = "", cardId = ""] = key.split("\n");
    let lastSeen: string | null = null;
    const reads = serialLoader(async () => {
      let detail: KanbanCardDetail;
      try {
        detail = await transport.request(M.card, { cardId: cardId as never });
      } catch (error) {
        if (lastSeen !== null || !isKanbanServerError(error)) throw error;
        fail(error);
        return;
      }
      lastSeen = detail.card.updatedAt;
      emit(detail);
    });
    const off = follow(
      boardId,
      (event) => {
        if (event._tag === "snapshot") {
          if (lastSeen !== null) reads.run();
          else reads.nudge();
          return;
        }
        const change = event.change;
        if (change._tag !== "card" || change.card.id !== cardId) return;
        if (change.card.updatedAt === lastSeen) return;
        reads.run();
      },
      reads.run,
    );
    reads.run();
    return () => {
      reads.close();
      off();
    };
  }, options);

  // Never fails: a read made before the server connects retries until it
  // lands, and the list is read again on board snapshots and now and then, so
  // new boards appear.
  const boards = createSnapshotStore<ReadonlyArray<KanbanBoard>>((emit) => {
    const reads = serialLoader(async () => {
      emit(await transport.request(M.boards, {}));
    });
    refreshBoards = reads.run;
    // @effect-diagnostics-next-line globalTimers:off - Plain callback store shared by web and mobile.
    const refresh = setInterval(reads.run, BOARDS_REFRESH_MS);
    reads.run();
    return () => {
      clearInterval(refresh);
      reads.close();
      if (refreshBoards === reads.run) refreshBoards = null;
    };
  }, options);

  const wiki = createKeyedSnapshotStores<string, ReadonlyArray<KanbanWikiPage>>(
    (boardId, emit, fail) => {
      let closed = false;
      transport.request(M.wiki, { boardId: boardId as never }).then((pages) => {
        if (!closed) emit(pages);
      }, fail);
      return () => {
        closed = true;
      };
    },
    options,
  );

  const withDiscussion = (boardId: string, discussion: KanbanDiscussion) =>
    update(boardId, (state) => withDiscussions(state, [discussion], []));

  return {
    boards,
    board,
    messages: (boardId, discussionId) => messages(`${boardId}\n${discussionId}`),
    card: (boardId, cardId) => card(`${boardId}\n${cardId}`),
    wiki,

    async patchCard(input) {
      await transport.request(M.cardPatch, input);
    },
    async settleCard(cardId) {
      await transport.request(M.cardSettle, { cardId: cardId as never });
    },
    async stopCard(cardId) {
      await transport.request(M.cardStop, { cardId: cardId as never });
    },
    async cardDiscussion(boardId, cardId) {
      const discussion = await transport.request(M.cardDiscussion, { cardId: cardId as never });
      withDiscussion(boardId, discussion);
      return discussion;
    },
    async setPool(boardId, model, slots) {
      await transport.request(M.poolSet, { boardId: boardId as never, model, slots });
    },
    async updateBoard(input) {
      await transport.request(M.boardUpdate, input);
    },
    async createDiscussion(boardId, title) {
      const discussion = await transport.request(M.discussionCreate, {
        boardId: boardId as never,
        title,
      });
      withDiscussion(boardId, discussion);
      return discussion;
    },
    markRead(boardId, discussionId, seq) {
      const pending = pendingReads.get(boardId) ?? new Map<string, number>();
      pending.set(discussionId, Math.max(seq, pending.get(discussionId) ?? 0));
      pendingReads.set(boardId, pending);
      update(boardId, (state) => withOwnerRead(state, discussionId, seq));
      sendRead(discussionId, seq);
    },
    async post(_boardId, discussionId, blocks) {
      await transport.request(M.messagePost, { discussionId: discussionId as never, blocks });
    },
    async answer(_boardId, discussionId, seq, blockId, choice) {
      await transport.request(M.answer, {
        discussionId: discussionId as never,
        seq,
        blockId,
        choice,
      });
    },
    watchPreviews(boardId) {
      previewWatchers.set(boardId, (previewWatchers.get(boardId) ?? 0) + 1);
      loadPreviews(boardId);
      return () => {
        const left = (previewWatchers.get(boardId) ?? 1) - 1;
        if (left > 0) previewWatchers.set(boardId, left);
        else previewWatchers.delete(boardId);
      };
    },
  };
}
