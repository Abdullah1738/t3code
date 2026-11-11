// @effect-diagnostics globalTimers:off - Plain callback store shared by web and mobile.
// @effect-diagnostics globalDate:off - Send times and toasts run on the device clock, outside an Effect runtime.
/**
 * What a Needs-you screen knows: the ask feed, what he has typed on each ask,
 * and the answers that are held, on their way, failed or sent. One store for
 * the screen and the sidebar count, shared by the web page and the phone: each
 * passes in its server calls, its state cell and how it hears that a board
 * changed or the app came to the front.
 */
import {
  kanbanAskRevision,
  type KanbanAskFeed,
  type KanbanAskFeedItem,
  type KanbanBlock,
  type KanbanOwnerAsk,
} from "@t3tools/contracts";

import {
  askFormCarried,
  askFormFor,
  buildAskAnswer,
  type AskAnswerBody,
  type AskForm,
  type AskIntent,
  type AskProblemKey,
} from "./askAnswer.ts";
import {
  AskApiError,
  askFailureText,
  type AskApi,
  type AskBatchResult,
  type AskFeedRead,
  type AskUnreadable,
} from "./askApi.ts";
import type { ChangeView } from "./askKeys.ts";
import { askReplyProblem } from "./askReply.ts";
import { ASK_NOT_OWNER_DEVICE_TEXT } from "./askSecrets.ts";
import { createAskSendQueue, type HeldSend } from "./askSendQueue.ts";
import type { NeedsYouMark } from "./needsYouQueue.ts";

export const askKey = (entry: Pick<KanbanAskFeedItem, "cardId" | "ask">): string =>
  `${entry.cardId}:${entry.ask.id}`;

/** The queue key of an ask that could not be read, when its card and id could be. */
export const askUnreadableKey = (ask: AskUnreadable): string | null =>
  ask.cardId !== null && ask.askId !== null ? `${ask.cardId}:${ask.askId}` : null;

/** What is known of an ask that read before, to hold against one that no longer reads. */
export interface AskKnown {
  readonly cardId: string | null;
  readonly askId: string | null;
  readonly cardRef: string | null;
  readonly boardId: string | null;
  readonly cardNumber: number | null;
}

const NOTHING_KNOWN: AskKnown = {
  cardId: null,
  askId: null,
  cardRef: null,
  boardId: null,
  cardNumber: null,
};

/**
 * Whether an ask that could not be read might be this one. Only a part both
 * sides have, and that differs, rules it out: an unreadable ask with nothing
 * readable in it could be any ask.
 */
export const askCouldBe = (lost: AskUnreadable, known: AskKnown): boolean => {
  const differs = <T>(a: T | null, b: T | null) => a !== null && b !== null && a !== b;
  return !(
    differs(lost.cardId, known.cardId) ||
    differs(lost.askId, known.askId) ||
    differs(lost.cardRef, known.cardRef) ||
    differs(lost.boardId, known.boardId) ||
    differs(lost.cardNumber, known.cardNumber)
  );
};

const knownOf = (entry: KanbanAskFeedItem): AskKnown => ({
  cardId: entry.cardId,
  askId: entry.ask.id,
  cardRef: entry.cardRef,
  boardId: entry.boardId,
  cardNumber: entry.cardNumber,
});

const NO_UNREADABLE: ReadonlyArray<AskUnreadable> = [];
/** The same list object when nothing in it changed, so nothing re-renders for it. */
const keptList = (
  before: ReadonlyArray<AskUnreadable>,
  next: ReadonlyArray<AskUnreadable> | undefined,
): ReadonlyArray<AskUnreadable> => {
  if (next === undefined || next.length === 0) return NO_UNREADABLE;
  return before.length === next.length && before.every((item, index) => item === next[index])
    ? before
    : next;
};

/** Who asked, as a sentence names them: "the #457 work thread", "the Robob evaluator". */
export function askAsker(entry: KanbanAskFeedItem): string {
  switch (entry.ask.by._tag) {
    case "thread":
      return `the #${entry.cardNumber} work thread`;
    case "evaluator":
      return `the ${entry.boardName} evaluator`;
    case "script":
      return "the board script";
    default:
      return `the ${entry.boardName} board`;
  }
}

export interface AskSendRef {
  readonly key: string;
  readonly cardRef: string;
  readonly askId: string;
  readonly revision: number;
  /** The ask was put away when he answered it: its being put away is then nothing new. */
  readonly snoozed?: boolean;
}

/** One answer from the moment he gives it: held for undo, sending, then sent. */
export interface AskSend {
  readonly id: number;
  readonly kind: "answer" | "batch" | "hand";
  /** What was in focus when he answered, so Undo can go back to it. */
  readonly focusKey: string;
  readonly refs: ReadonlyArray<AskSendRef>;
  readonly body: AskAnswerBody;
  /** A hand-over: "…and ones like this from now on", with his words. */
  readonly hand?: { readonly always: boolean; readonly text?: string };
  /** "Approved", "Deploy", "Handed to the evaluator". */
  readonly label: string;
  readonly title: string;
  readonly boardId: string;
  readonly boardName: string;
  readonly cardNumber: number | null;
  /** Who gets it. */
  readonly to: string;
  readonly at: number;
  readonly state: "held" | "sending" | "sent";
  /**
   * How many times this answer has gone again by itself after never reaching
   * the server. It stays with the answer through every failure and retry, so
   * the limit holds however the connection flaps; only a new answer starts at
   * none.
   */
  readonly autoRetries?: number;
  /** With "from now on": the evaluator thread it started, or why it did not. */
  readonly evaluator?: {
    readonly started: boolean;
    readonly threadId: string | null;
    readonly error: string | null;
  };
}

export interface AskToast {
  readonly id: number;
  readonly text: string;
  /** The held answer this toast can undo. */
  readonly undoSendId?: number;
  readonly retryKey?: string;
  readonly viewKey?: string;
  /** The asks a snooze just put away, so Undo can bring them back. */
  readonly undoSnooze?: ReadonlyArray<AskSendRef>;
}

/** An answer the server did not take, kept with what he gave so it can go again. */
export interface AskFailedSend {
  readonly send: AskSend;
  readonly message: string;
  /**
   * The request never got an answer (offline, the server not reached). Such a
   * send can go again by itself once the connection is back; one the server
   * refused never does.
   */
  readonly unreached?: boolean;
}

export interface AskState {
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly error: string | null;
  readonly feed: KanbanAskFeed | null;
  /**
   * Open asks the last feed carried that this build could not read. They are
   * not in `feed.open` and not closed: the page says how many there are and
   * points at their cards, and nothing of theirs is dropped as if answered.
   */
  readonly unreadable: ReadonlyArray<AskUnreadable>;
  /** The same for the closed asks of the History window. */
  readonly unreadableClosed: ReadonlyArray<AskUnreadable>;
  /**
   * How many times the feed has been read with success. Each good read is a
   * sign the server is reachable; an answer that never reached it may go
   * again by itself after a later one (see `retryUnreachedAskSends`).
   */
  readonly reads: number;
  /** Asks closed in the History window; null until read. */
  readonly closed: ReadonlyArray<KanbanAskFeedItem> | null;
  readonly closedStatus: "idle" | "loading" | "ready" | "error";
  /** When `closed` was read (the feed's own time); null until read. */
  readonly closedAt: string | null;
  /**
   * Why the last read of History did not come back, until one does. With
   * `closed` held, what History shows is then as of `closedAt`, not current.
   */
  readonly closedError: string | null;
  readonly forms: Readonly<Record<string, AskForm>>;
  /** Asks he tried to send with something missing: every problem shows. */
  readonly tried: Readonly<Record<string, true>>;
  /** Problems the server named after a send, by ask then field. */
  readonly refused: Readonly<Record<string, Partial<Record<AskProblemKey, string>>>>;
  readonly marks: Readonly<Record<string, NeedsYouMark>>;
  /** The ask as he last saw it, kept when its agent edits it, to show what changed. */
  readonly previous: Readonly<Record<string, KanbanOwnerAsk>>;
  /** Asks whose answer is held or on its way, by the send that covers them. */
  readonly hidden: Readonly<Record<string, number>>;
  readonly held: HeldSend<AskSend> | null;
  readonly failed: Readonly<Record<string, AskFailedSend>>;
  /** Answers given in this session, newest first. */
  readonly sent: ReadonlyArray<AskSend>;
  /** Asks read whole (their big blocks are stubs in the feed), by `key@revision`. */
  readonly details: Readonly<Record<string, KanbanOwnerAsk>>;
  /** Why an ask could not be read whole, by `key@revision`: shown on that ask, with Retry. */
  readonly detailErrors: Readonly<Record<string, string>>;
  readonly toast: AskToast | null;
  /**
   * The server said this session is not the owner's own, in its words.
   * `device`: a paired device that has to be paired again. While it stands,
   * nothing is held for Undo or offered for Retry: it could not succeed.
   */
  readonly notOwner: { readonly text: string; readonly device: boolean } | null;
  /** How change asks show their texts; kept as he steps from ask to ask. */
  readonly changeView: ChangeView;
}

export const INITIAL_ASK_STATE: AskState = {
  status: "idle",
  error: null,
  feed: null,
  unreadable: NO_UNREADABLE,
  unreadableClosed: NO_UNREADABLE,
  reads: 0,
  closed: null,
  closedStatus: "idle",
  closedAt: null,
  closedError: null,
  forms: {},
  tried: {},
  refused: {},
  marks: {},
  previous: {},
  hidden: {},
  held: null,
  failed: {},
  sent: [],
  details: {},
  detailErrors: {},
  toast: null,
  notOwner: null,
  changeView: "after",
};

/** Where the state lives: a zustand store on the web, the plain cell below elsewhere. */
export interface AskStateCell {
  readonly getState: () => AskState;
  readonly setState: (patch: Partial<AskState>) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

/** A state cell with no framework behind it, for `useSyncExternalStore`. */
export function createAskStateCell(initial: AskState = INITIAL_ASK_STATE): AskStateCell {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    setState: (patch) => {
      state = { ...state, ...patch };
      for (const listener of Array.from(listeners)) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/**
 * Whether an ask is no longer what he answered: it was edited (its revision
 * moved), it expired, it was handed to the evaluator or it was put away. An
 * answer given before that is out of date. It is never sent again as it is,
 * by itself or by Retry: he reads the ask again and answers it again.
 */
export const askMovedSince = (
  entry: Pick<KanbanAskFeedItem, "revision" | "expired" | "waitsOn" | "snoozed">,
  ref: Pick<AskSendRef, "revision" | "snoozed">,
): boolean =>
  entry.revision !== ref.revision ||
  entry.expired ||
  entry.waitsOn === "evaluator" ||
  (entry.snoozed === true && ref.snoozed !== true);

/** How long before an ask that may have closed is read by itself again to find out. */
export const ASK_CLOSED_CHECK_MS = 60_000;

/** At most this many times an answer that never reached the server goes again by itself. */
export const ASK_AUTO_RETRY_MAX = 3;

/** Whether some answer that never reached the server may still go again by itself. */
export const askAutoRetryOwed = (
  state: Pick<AskState, "failed">,
  max: number = ASK_AUTO_RETRY_MAX,
): boolean =>
  Object.values(state.failed).some(
    (failed) => failed.unreached === true && (failed.send.autoRetries ?? 0) < max,
  );

/** How the store hears that the feed may have moved. Each returns its own stop. */
export interface AskWatchHost {
  /** A board's counts changed (the board list feed). */
  readonly onBoardsChange: (run: () => void) => () => void;
  /** The window or app came back to the front. */
  readonly onForeground: (run: () => void) => () => void;
  /** Whether it is in front now: the slow timer reads only then. */
  readonly isForeground: () => boolean;
}

export interface AskStoreHost {
  readonly api: AskApi;
  readonly cell: AskStateCell;
  readonly watch: AskWatchHost;
  /** How long an answer is held for Undo; six seconds when unset. */
  readonly undoMs?: number;
}

export const askFormOf = (state: AskState, entry: KanbanAskFeedItem): AskForm =>
  state.forms[askKey(entry)] ?? askFormFor(entry.ask);

export const askNeedsDetail = (ask: KanbanOwnerAsk): boolean =>
  (ask.blocks ?? []).some(
    (block) =>
      (block._tag === "md" || block._tag === "collapse" || block._tag === "html") &&
      block.truncated === true,
  );

/** The most his words for a standing hand-over may run to (the server's limit). */
export const HAND_WORDS_MAX = 4_000;

const without = <T>(record: Readonly<Record<string, T>>, keys: ReadonlyArray<string>) => {
  const next = { ...record };
  for (const key of keys) delete next[key];
  return next;
};

const refOf = (entry: KanbanAskFeedItem): AskSendRef => ({
  key: askKey(entry),
  cardRef: entry.cardRef,
  askId: entry.ask.id,
  revision: kanbanAskRevision(entry.ask),
  ...(entry.snoozed === true ? { snoozed: true } : {}),
});

const refLabel = (send: AskSend) =>
  send.refs.length > 1
    ? `${send.refs.length} asks`
    : send.cardNumber === null
      ? send.boardName
      : `${send.boardName} #${send.cardNumber}`;

type NotOwner = NonNullable<AskState["notOwner"]>;

const notOwnerOf = (error: unknown): NotOwner | null =>
  error instanceof AskApiError && error.denied
    ? { text: error.message, device: error.notOwnerDevice }
    : null;

export type AskStore = ReturnType<typeof createAskStore>;

export function createAskStore(host: AskStoreHost) {
  const { api: askApi } = host;
  const get = host.cell.getState;
  /** Set by `dispose`: from then on nothing is sent, read or written. */
  let disposed = false;
  const set = (patch: Partial<AskState>) => {
    if (!disposed) host.cell.setState(patch);
  };

  let toastId = 0;
  let toastTimer: ReturnType<typeof setTimeout> | null = null;

  function showAskToast(toast: Omit<AskToast, "id">, ms = 4_200) {
    if (disposed) return;
    if (toastTimer !== null) clearTimeout(toastTimer);
    toastTimer = null;
    const id = ++toastId;
    set({ toast: { ...toast, id } });
    // A toast with Undo lives as long as its answer is held.
    if (toast.undoSendId === undefined) {
      toastTimer = setTimeout(() => {
        if (get().toast?.id === id) set({ toast: null });
      }, ms);
    }
  }

  const dismissAskToast = () => {
    if (toastTimer !== null) clearTimeout(toastTimer);
    toastTimer = null;
    set({ toast: null });
  };

  let inFlight: Promise<void> | null = null;
  let again = false;
  /** History asked for its asks and has none yet: the next good read of the feed asks again. */
  let closedOwed = false;
  /** The ask the page has open: changes on it need no "new" mark. */
  let focusedKey: string | null = null;
  const noteAskFocus = (key: string | null) => {
    focusedKey = key;
  };

  let sendId = 0;
  const sending = new Set<number>();

  /**
   * The answers that did not go whose ask has moved since he gave them
   * (`askMovedSince`), against the open asks as last read. An ask that is not
   * among those is not judged here: it closed, or it could not be read.
   */
  const movedFailed = (
    failed: AskState["failed"],
    open: ReadonlyArray<KanbanAskFeedItem>,
  ): ReadonlyArray<string> => {
    const keys = Object.keys(failed);
    if (keys.length === 0) return [];
    const now = new Map(open.map((entry) => [askKey(entry), entry]));
    return keys.filter((key) => {
      const ref = failed[key]!.send.refs.find((item) => item.key === key);
      const entry = now.get(key);
      return ref !== undefined && entry !== undefined && askMovedSince(entry, ref);
    });
  };

  /**
   * Asks that read before, are absent from the feed now, and may be one of
   * the asks the feed could not even identify: what was known of each. Nothing
   * of his on them is cleared as if they had closed until a feed reads whole or
   * a read of the ask itself says it closed (`confirmClosed`).
   */
  const heldOff = new Map<string, AskKnown>();
  const checking = new Set<string>();
  const checkedAt = new Map<string, number>();

  /** Reads one held-off ask by itself: closed (or no longer on its card) settles it. */
  function confirmClosed(key: string, known: AskKnown) {
    if (known.cardRef === null || known.askId === null || checking.has(key)) return;
    const last = checkedAt.get(key);
    if (last !== undefined && Date.now() - last < ASK_CLOSED_CHECK_MS) return;
    checking.add(key);
    checkedAt.set(key, Date.now());
    const closed = () => {
      // Read again since, or its server gone: there is nothing left to settle.
      if (disposed || !heldOff.has(key)) return;
      heldOff.delete(key);
      checkedAt.delete(key);
      const state = get();
      set({ failed: without(state.failed, [key]), marks: without(state.marks, [key]) });
      if (get().toast?.retryKey === key) dismissAskToast();
    };
    void askApi.detail(known.cardRef, known.askId).then(
      (detail) => {
        checking.delete(key);
        const at = (detail as { ask?: { closedAt?: unknown } } | null | undefined)?.ask?.closedAt;
        if (typeof at === "string") closed();
      },
      (error: unknown) => {
        checking.delete(key);
        // The ask is not on its card any more. Anything else (offline, unreadable) says nothing.
        if (error instanceof AskApiError && error.status === 404) closed();
      },
    );
  }

  type AskNow = "current" | "moved" | "closed" | "unknown";

  /**
   * What the ask of an answer is now, against the feed as last read. `current`:
   * open and as he answered it. `moved`: open, but no longer what he answered
   * (`askMovedSince`). `closed`: not among the open asks, and the feed read
   * whole enough to say so. `unknown`: it can't be compared: no feed read yet,
   * or the ask is (or may be) one of those that could not be read.
   */
  function askNow(ref: AskSendRef): AskNow {
    const { feed, unreadable } = get();
    if (feed === null) return "unknown";
    const entry = feed.open.find((item) => askKey(item) === ref.key);
    if (entry !== undefined) return askMovedSince(entry, ref) ? "moved" : "current";
    const known = heldOff.get(ref.key) ?? {
      ...NOTHING_KNOWN,
      askId: ref.askId,
      cardRef: ref.cardRef,
    };
    const lostHere = unreadable.some((lost) => {
      const key = askUnreadableKey(lost);
      return key === null ? askCouldBe(lost, known) : key === ref.key;
    });
    return lostHere ? "unknown" : "closed";
  }

  function mergeFeed(feed: AskFeedRead) {
    const state = get();
    const before = new Map((state.feed?.open ?? []).map((entry) => [askKey(entry), entry]));
    const marks = { ...state.marks };
    const previous = { ...state.previous };
    const forms = { ...state.forms };
    const openKeys = new Set<string>();
    // An ask that could not be read is still open: nothing of it is cleared as if it had closed.
    const unreadable = keptList(state.unreadable, feed.unreadable?.open);
    // Those with no card or id to go by: any ask missing from this feed may be one of them.
    const unidentified: Array<AskUnreadable> = [];
    for (const lost of unreadable) {
      const key = askUnreadableKey(lost);
      if (key !== null) openKeys.add(key);
      else unidentified.push(lost);
    }
    for (const entry of feed.open) {
      const key = askKey(entry);
      openKeys.add(key);
      const old = before.get(key);
      if (old === undefined) continue;
      if (entry.revision > old.revision) {
        previous[key] ??= old.ask;
        if (forms[key]) forms[key] = askFormCarried(entry.ask, forms[key]!);
        if (entry.waitsOn === "owner") marks[key] = "updated";
        continue;
      }
      const agentSpoke =
        entry.messages.length > old.messages.length &&
        entry.messages.at(-1)?.author._tag !== "owner";
      const cameBack = old.waitsOn !== "owner" && entry.waitsOn === "owner";
      if ((agentSpoke || cameBack) && key !== focusedKey && entry.waitsOn === "owner") {
        marks[key] ??= "reply";
      }
    }
    // An ask that closed (or whose send finished) is no longer hidden, marked or failed.
    // Absent is closed only when every ask in the feed could be told apart: while
    // some can't be identified, an absent ask that could be one of them keeps
    // everything of his (its mark, its unsent answer and its tries).
    const held = new Map<string, AskKnown>();
    const gone = (key: string) => {
      if (openKeys.has(key)) return false;
      if (unidentified.length === 0) return true;
      const old = before.get(key);
      const ref = state.failed[key]?.send.refs.find((item) => item.key === key);
      const known =
        old !== undefined
          ? knownOf(old)
          : (heldOff.get(key) ??
            (ref === undefined
              ? NOTHING_KNOWN
              : { ...NOTHING_KNOWN, askId: ref.askId, cardRef: ref.cardRef }));
      if (!unidentified.some((lost) => askCouldBe(lost, known))) return true;
      held.set(key, known);
      return false;
    };
    const hidden = { ...state.hidden };
    for (const [key, id] of Object.entries(hidden)) {
      const live = state.held?.payload.id === id || sending.has(id);
      if (!live) delete hidden[key];
    }
    for (const key of Object.keys(marks)) if (gone(key)) delete marks[key];
    const failed = without(state.failed, Object.keys(state.failed).filter(gone));
    // An answer that did not go, for an ask that has moved since: it is out of
    // date now, so it is no longer kept to go again, by itself or by Retry.
    // What he filled in stays as the ask's draft, and the ask shows as updated.
    const moved = movedFailed(failed, feed.open);
    for (const key of moved) marks[key] = "updated";
    set({
      feed,
      unreadable,
      reads: state.reads + 1,
      status: "ready",
      error: null,
      marks,
      previous,
      forms,
      hidden,
      failed: without(failed, moved),
      ...(moved.some((key) => state.refused[key] !== undefined)
        ? { refused: without(state.refused, moved) }
        : {}),
    });
    // "Retry" on a toast for one of them would send nothing: the toast goes.
    const retryKey = get().toast?.retryKey;
    if (retryKey !== undefined && moved.includes(retryKey)) dismissAskToast();
    // What is held off now, and nothing that read again or was cleared.
    heldOff.clear();
    for (const [key, known] of held) heldOff.set(key, known);
    for (const key of Array.from(checkedAt.keys())) if (!heldOff.has(key)) checkedAt.delete(key);
    for (const [key, known] of held) confirmClosed(key, known);
  }

  /** Reads the feed again. Calls that arrive while one is running fold into one more. */
  function refreshAsks(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (inFlight !== null) {
      again = true;
      return inFlight;
    }
    if (get().feed === null) set({ status: "loading" });
    inFlight = askApi
      .feed()
      .then(
        (feed) => {
          mergeFeed(feed);
          // History is owed its first read, or holds a read it could not renew: now it can.
          if (closedOwed || get().closedError !== null) void loadClosedAsks();
        },
        (error: unknown) => {
          set({
            status: get().feed === null ? "error" : "ready",
            error: error instanceof Error ? error.message : "Couldn't load asks.",
          });
        },
      )
      .finally(() => {
        inFlight = null;
        if (again) {
          again = false;
          void refreshAsks();
        }
      });
    return inFlight;
  }

  /** Reads the asks closed in the last week, for History. */
  async function loadClosedAsks(): Promise<void> {
    if (disposed || get().closedStatus === "loading") return;
    set({ closedStatus: get().closed === null ? "loading" : "ready" });
    try {
      const feed = await askApi.feed({ closed: "7d" });
      closedOwed = false;
      mergeFeed(feed);
      set({
        closed: feed.closed,
        unreadableClosed: keptList(get().unreadableClosed, feed.unreadable?.closed),
        closedStatus: "ready",
        closedAt: feed.at,
        closedError: null,
      });
    } catch (error) {
      const none = get().closed === null;
      closedOwed = none;
      // Not connected yet (a reload lands on History before the connection is up): the read
      // was not refused, and it goes again by itself on the next good read of the feed. What
      // the screen says meanwhile is `askHistoryFigures`' to decide: never figures.
      const early = error instanceof AskApiError && error.code === "offline";
      set({
        closedStatus: none ? (early ? "idle" : "error") : "ready",
        closedError: error instanceof Error ? error.message : "Couldn't load History.",
      });
    }
  }

  let watchers = 0;
  let stopWatching: (() => void) | null = null;
  let pollMs = 60_000;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const restartPoll = () => {
    if (pollTimer !== null) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (host.watch.isForeground()) void refreshAsks();
    }, pollMs);
  };

  /**
   * Keeps the feed current while anything shows it: it is read again when a
   * board's counts change (the board list feed), when the window comes back,
   * and on a slow timer for edits that change no count. `fast` is the page
   * itself; the sidebar count alone polls slowly.
   */
  function watchAsks(fast: boolean): () => void {
    if (disposed) return () => undefined;
    watchers += 1;
    if (fast) {
      pollMs = 15_000;
      if (stopWatching !== null) restartPoll();
    }
    if (stopWatching === null) {
      let debounce: ReturnType<typeof setTimeout> | null = null;
      const soon = () => {
        if (debounce !== null) clearTimeout(debounce);
        debounce = setTimeout(() => void refreshAsks(), 400);
      };
      const offBoards = host.watch.onBoardsChange(soon);
      const offForeground = host.watch.onForeground(soon);
      restartPoll();
      void refreshAsks();
      stopWatching = () => {
        offBoards();
        offForeground();
        if (debounce !== null) clearTimeout(debounce);
        if (pollTimer !== null) clearInterval(pollTimer);
        pollTimer = null;
      };
    }
    return () => {
      if (disposed) return;
      watchers -= 1;
      if (fast) {
        pollMs = 60_000;
        if (watchers > 0) restartPoll();
      }
      if (watchers === 0) {
        stopWatching?.();
        stopWatching = null;
      }
    };
  }

  function patchAskForm(entry: KanbanAskFeedItem, patch: Partial<AskForm>) {
    const key = askKey(entry);
    const state = get();
    set({
      forms: { ...state.forms, [key]: { ...askFormOf(state, entry), ...patch } },
      ...(state.refused[key] ? { refused: without(state.refused, [key]) } : {}),
    });
  }

  function setAskValue(entry: KanbanAskFeedItem, fieldId: string, value: unknown) {
    const form = askFormOf(get(), entry);
    patchAskForm(entry, { values: { ...form.values, [fieldId]: value } });
  }

  const setAskChangeView = (changeView: ChangeView) => set({ changeView });

  /** He tried to send with something missing: every problem on the ask shows from now on. */
  function markAskTried(entry: KanbanAskFeedItem) {
    set({ tried: { ...get().tried, [askKey(entry)]: true } });
  }

  /** He opened the ask: what was new on it has been seen. */
  function seeAsk(key: string) {
    const state = get();
    if (state.marks[key] === undefined && state.previous[key] === undefined) return;
    set({ marks: without(state.marks, [key]), previous: without(state.previous, [key]) });
  }

  /** Reads an ask whole when the feed sent its big blocks as stubs. */
  async function loadAskDetail(entry: KanbanAskFeedItem): Promise<void> {
    const id = `${askKey(entry)}@${entry.revision}`;
    if (disposed || get().details[id] !== undefined) return;
    if (get().detailErrors[id] !== undefined) {
      set({ detailErrors: without(get().detailErrors, [id]) });
    }
    try {
      const detail = await askApi.detail(entry.cardRef, entry.ask.id);
      set({ details: { ...get().details, [id]: detail.ask } });
    } catch (error) {
      // Said on the ask itself, with Retry: the rest of the ask still shows.
      set({ detailErrors: { ...get().detailErrors, [id]: askFailureText(error) } });
      throw error;
    }
  }

  const patchSend = (id: number, patch: Partial<AskSend>) => {
    const state = get();
    set({ sent: state.sent.map((send) => (send.id === id ? { ...send, ...patch } : send)) });
  };

  /** Remembers a "not the owner's session" refusal, whichever call met it. */
  const noteRefusal = (error: unknown) => {
    const notOwner = notOwnerOf(error);
    if (notOwner !== null) set({ notOwner });
  };

  /**
   * What the session itself says: `false` is a session that is not the owner's,
   * known before anything is sent, so the notice shows up front and no answer is
   * held as if it could go through. `true` clears a notice an earlier session left.
   */
  function noteOwnerStanding(owner: boolean | undefined) {
    if (owner === undefined) return;
    const { notOwner } = get();
    if (owner === false && notOwner === null) {
      set({ notOwner: { text: ASK_NOT_OWNER_DEVICE_TEXT, device: true } });
    } else if (owner === true && notOwner !== null) {
      set({ notOwner: null });
    }
  }

  /** The secret call met the same refusal over its own channel. */
  const noteAskNotOwner = (text: string, device: boolean) => set({ notOwner: { text, device } });

  /** One ask's send was refused: it comes back to the queue with what he typed. */
  function giveBack(send: AskSend, ref: AskSendRef, error: unknown) {
    const state = get();
    const hidden = without(state.hidden, [ref.key]);
    const notOwner = notOwnerOf(error);
    if (notOwner !== null) {
      // Not his own session: the ask is back as he left it, and there is nothing to retry.
      set({ hidden, notOwner });
      return "denied" as const;
    }
    if ((error instanceof AskApiError && error.stale) || askNow(ref) === "moved") {
      // The ask changed or closed since he read it: read it again and keep his form.
      // The same when the send failed for another reason and a feed read while it
      // was on its way already shows the ask moved: no answer is kept to go again.
      set({ hidden, marks: { ...state.marks, [ref.key]: "updated" } });
      return "stale" as const;
    }
    const message = askFailureText(error);
    if (error instanceof AskApiError && error.status === 400) {
      // The server names the field that failed: show it on that field.
      const field = /field "([^"]+)"/.exec(message)?.[1];
      set({
        hidden,
        tried: { ...state.tried, [ref.key]: true },
        refused: {
          ...state.refused,
          [ref.key]: { [field ? `field:${field}` : "why"]: message } as Partial<
            Record<AskProblemKey, string>
          >,
        },
        marks: { ...state.marks, [ref.key]: "failed" },
        failed: { ...state.failed, [ref.key]: { send, message } },
      });
      return "invalid" as const;
    }
    const unreached = error instanceof AskApiError && error.unreached;
    set({
      hidden,
      marks: { ...state.marks, [ref.key]: "failed" },
      failed: {
        ...state.failed,
        [ref.key]: { send, message, ...(unreached ? { unreached: true } : {}) },
      },
    });
    return "failed" as const;
  }

  /** Gives back the asks a batch route refused, each for its own reason. Returns how many. */
  function giveBackRefused(send: AskSend, results: AskBatchResult["results"]): number {
    let refused = 0;
    for (const entry of results) {
      if (entry.ok) continue;
      const ref = send.refs.find(
        (item) => item.cardRef === entry.card && item.askId === entry.askId,
      );
      if (!ref) continue;
      refused += 1;
      const { code, message, reason, revision } = entry.error;
      giveBack(
        send,
        ref,
        new AskApiError(
          code === "conflict" ? 409 : code === "denied" ? 403 : 400,
          code,
          message,
          revision ?? null,
          reason ?? null,
        ),
      );
    }
    return refused;
  }

  async function deliver(send: AskSend, leaving: boolean) {
    if (disposed) return;
    sending.add(send.id);
    patchSend(send.id, { state: "sending" });
    const first = send.refs[0]!;
    let outcome: "sent" | "stale" | "invalid" | "failed" | "denied" = "sent";
    let refusedCount = 0;
    let evaluator: AskSend["evaluator"];
    try {
      if (send.kind === "hand" && send.refs.length === 1) {
        const handed = await askApi.hand(
          first.cardRef,
          first.askId,
          {
            action: "hand",
            ...(send.hand?.always ? { always: true, text: send.hand.text ?? "" } : {}),
          },
          leaving,
        );
        evaluator = handed.evaluator;
      } else if (send.kind === "hand") {
        const result = await askApi.handBatch(
          send.refs.map((ref) => ({
            card: ref.cardRef,
            askId: ref.askId,
            revision: ref.revision,
          })),
          send.hand?.always ? { always: true, text: send.hand.text ?? "" } : {},
          leaving,
        );
        refusedCount = giveBackRefused(send, result.results);
        // One thread per board; a batch is one board's asks, so the first is the one.
        evaluator =
          result.evaluators?.find((entry) => !entry.started) ?? result.evaluators?.[0] ?? undefined;
      } else if (send.kind === "batch") {
        const {
          revision: _revision,
          values: _values,
          finalDraft: _finalDraft,
          ...body
        } = send.body;
        const result = await askApi.answerBatch(
          body,
          send.refs.map((ref) => ({
            card: ref.cardRef,
            askId: ref.askId,
            revision: ref.revision,
          })),
          leaving,
        );
        refusedCount = giveBackRefused(send, result.results);
      } else {
        await askApi.answer(first.cardRef, first.askId, send.body, first.revision, leaving);
      }
    } catch (error) {
      outcome = "failed";
      for (const ref of send.refs) outcome = giveBack(send, ref, error);
      refusedCount = send.refs.length;
    }
    sending.delete(send.id);

    const state = get();
    if (refusedCount === send.refs.length) {
      set({ sent: state.sent.filter((entry) => entry.id !== send.id) });
    } else {
      patchSend(send.id, { state: "sent", ...(evaluator ? { evaluator } : {}) });
      const done = send.refs.map((ref) => ref.key).filter((key) => get().failed[key] === undefined);
      set({ tried: without(get().tried, done), forms: without(get().forms, done) });
    }
    // An answer got through: whatever refused this session before no longer does.
    if (outcome === "sent" && get().notOwner !== null) set({ notOwner: null });
    if (leaving) return;
    void refreshAsks();
    // History, once read, shows the answer as its agent left it.
    if (get().closed !== null) void loadClosedAsks();
    if (outcome === "denied") {
      showAskToast(
        {
          text: `Not sent. ${get().notOwner?.text ?? "Only the owner answers."}`,
          viewKey: first.key,
        },
        9_000,
      );
    } else if (outcome === "stale") {
      showAskToast(
        {
          text: `Not sent: ${refLabel(send)} changed while you were answering. What you typed is kept.`,
          viewKey: first.key,
        },
        9_000,
      );
    } else if (outcome !== "sent") {
      showAskToast(
        {
          text: `Not sent · ${refLabel(send)}. ${get().failed[first.key]?.message ?? "Robob did not confirm it."}`,
          ...(outcome === "failed" ? { retryKey: first.key } : { viewKey: first.key }),
        },
        9_000,
      );
    } else if (refusedCount > 0) {
      showAskToast(
        {
          text: `${send.label} ${send.refs.length - refusedCount} of ${send.refs.length}. ${refusedCount} changed and ${refusedCount === 1 ? "was" : "were"} not ${send.kind === "hand" ? "handed over" : "answered"}.`,
        },
        9_000,
      );
    } else if (evaluator && !evaluator.started) {
      showAskToast(
        {
          text: `Handed over, but the evaluator thread did not start: ${evaluator.error ?? "no reason given"}.`,
        },
        9_000,
      );
    } else if (get().toast?.undoSendId === send.id || get().toast === null) {
      showAskToast({ text: `Sent to ${send.to}.` });
    }
  }

  const queue = createAskSendQueue<AskSend>({
    ...(host.undoMs === undefined ? {} : { delayMs: host.undoMs }),
    now: () => Date.now(),
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    send: (send, leaving) => void deliver(send, leaving),
    onChange: (held) => set({ held }),
  });

  /** Sends a held answer now: he is leaving the page or closing the tab. */
  const flushAskSends = (leaving: boolean) => queue.flush(leaving);

  function hold(send: AskSend, text: string) {
    if (disposed) return;
    const state = get();
    if (state.notOwner !== null) {
      // This session was refused as not the owner's: nothing is held or hidden
      // as if it would go through. It is asked once, in the open, and the ask
      // stays where it is with what he typed.
      set({ sent: [{ ...send, state: "sending" }, ...state.sent] });
      void deliver(send, false);
      return;
    }
    const hidden = { ...state.hidden };
    for (const ref of send.refs) hidden[ref.key] = send.id;
    const keys = send.refs.map((ref) => ref.key);
    set({
      hidden,
      failed: without(state.failed, keys),
      marks: without(state.marks, keys),
      sent: [send, ...state.sent],
    });
    queue.hold(send);
    showAskToast({ text, undoSendId: send.id });
  }

  const baseSend = (
    entry: KanbanAskFeedItem,
    focusKey: string,
  ): Omit<AskSend, "kind" | "refs" | "body" | "label"> => ({
    id: ++sendId,
    focusKey,
    title: entry.ask.title ?? entry.cardTitle,
    boardId: entry.boardId,
    boardName: entry.boardName,
    cardNumber: entry.cardNumber,
    to: askAsker(entry),
    at: Date.now(),
    state: "held",
  });

  /**
   * Answers the ask with what its form holds. Returns the problems when
   * something is missing; otherwise the answer is held for six seconds.
   */
  function answerAsk(
    entry: KanbanAskFeedItem,
    intent: AskIntent,
  ): { readonly ok: true } | { readonly ok: false; readonly first: AskProblemKey } {
    const key = askKey(entry);
    const state = get();
    const form = askFormOf(state, entry);
    const built = buildAskAnswer(entry.ask, form, intent, kanbanAskRevision(entry.ask));
    if (!built.ok) {
      set({ tried: { ...state.tried, [key]: true } });
      return { ok: false, first: built.first };
    }
    const send: AskSend = {
      ...baseSend(entry, key),
      kind: "answer",
      refs: [refOf(entry)],
      body: built.body,
      label: built.label,
    };
    hold(
      send,
      `${built.label} · ${refLabel(send)}.${built.body.note ? ` Your note goes to ${send.to}.` : ""}`,
    );
    return { ok: true };
  }

  /** One answer for several asks of the same shape. */
  function answerAskBatch(
    entries: ReadonlyArray<KanbanAskFeedItem>,
    focusKey: string,
    body: Omit<AskAnswerBody, "revision" | "values" | "finalDraft">,
    label: string,
    title: string,
  ) {
    const first = entries[0];
    if (!first) return;
    const send: AskSend = {
      ...baseSend(first, focusKey),
      kind: "batch",
      refs: entries.map(refOf),
      body,
      label,
      title,
      cardNumber: null,
      to: entries.every((entry) => askAsker(entry) === askAsker(first))
        ? askAsker(first)
        : "their agents",
    };
    hold(
      send,
      `${label} · ${entries.length} asks.${body.note ? " Your note goes with each." : ""}`,
    );
  }

  /**
   * Hands asks to their board's evaluator; with `words`, also asks like them
   * from now on. Several asks are one send: held, undone and reported together.
   */
  function handAsks(
    entries: ReadonlyArray<KanbanAskFeedItem>,
    focusKey: string,
    words?: string,
    title?: string,
  ) {
    const first = entries[0];
    if (!first) return;
    const many = entries.length > 1;
    const send: AskSend = {
      ...baseSend(first, focusKey),
      kind: "hand",
      refs: entries.map(refOf),
      body: { verdict: "handed" },
      label: "Handed to the evaluator",
      to: `the ${first.boardName} evaluator`,
      ...(title === undefined ? {} : { title }),
      ...(many ? { cardNumber: null } : {}),
      ...(words === undefined ? {} : { hand: { always: true, text: words } }),
    };
    hold(
      send,
      `Handed to the evaluator · ${refLabel(send)}.${words === undefined ? "" : " An evaluator thread starts with your words."}`,
    );
  }

  const snoozeRefs = (refs: ReadonlyArray<AskSendRef>, until: string | null) =>
    refs.length === 1
      ? askApi.snooze(refs[0]!.cardRef, refs[0]!.askId, until)
      : askApi.snoozeBatch(
          refs.map((ref) => ({ card: ref.cardRef, askId: ref.askId, revision: ref.revision })),
          until,
        );

  /**
   * Takes back the last thing he did: the held answer, or the snooze the toast
   * still offers to undo. Returns what to focus again, or null when there was nothing.
   *
   * Taking back a held answer is local: it was never sent. Bringing a snoozed
   * ask back is a write to the server. With `only: "held"` nothing is written:
   * a held answer is cancelled, and a snooze stays as it is. A host that is not
   * sure the session is the owner's passes it.
   */
  function undoAskSend(only?: "held"): string | null {
    if (disposed) return null;
    const send = queue.undo();
    if (send === null) {
      if (only === "held") return null;
      const snoozed = get().toast?.undoSnooze;
      if (snoozed === undefined || snoozed.length === 0) return null;
      dismissAskToast();
      void snoozeRefs(snoozed, null).then(
        () => refreshAsks(),
        (error: unknown) => {
          noteRefusal(error);
          showAskToast({ text: `Couldn't bring it back. ${askFailureText(error)}` });
        },
      );
      return snoozed[0]!.key;
    }
    const state = get();
    set({
      hidden: without(
        state.hidden,
        send.refs.map((ref) => ref.key),
      ),
      sent: state.sent.filter((entry) => entry.id !== send.id),
    });
    dismissAskToast();
    return send.focusKey;
  }

  /**
   * Sends a failed answer again, at once. `auto`: it goes by itself, which
   * counts against the answer's limit; a retry by hand never does.
   *
   * Nothing goes without its ask being held against the feed as last read
   * (`askNow`), by hand or by itself:
   * - an ask that has moved since he answered (`askMovedSince`): the answer
   *   leaves the failed list, his draft stays, the ask is marked updated and
   *   he answers again (`moved`);
   * - an ask that closed: the answer is dropped (`closed`);
   * - an ask that can't be compared (it does not read in this build right
   *   now, or no feed has been read): nothing is sent and the answer and his
   *   draft stay as they are, to go once the ask reads again (`waiting`).
   * One such ask holds back its whole batch.
   */
  function retryAskSend(
    key: string,
    auto = false,
  ): "sent" | "moved" | "closed" | "waiting" | "none" {
    if (disposed) return "none";
    const failed = get().failed[key];
    if (!failed) return "none";
    const refs = failed.send.refs.filter((ref) => get().failed[ref.key] !== undefined);
    const now = new Map(refs.map((ref) => [ref.key, askNow(ref)]));
    const keysOf = (what: AskNow) =>
      refs.filter((ref) => now.get(ref.key) === what).map((ref) => ref.key);
    const moved = keysOf("moved");
    const closed = keysOf("closed");
    const label = refLabel({ ...failed.send, refs });
    if (moved.length + closed.length > 0) {
      const state = get();
      const marks = without(state.marks, closed);
      for (const moving of moved) marks[moving] = "updated";
      const out = [...moved, ...closed];
      set({
        failed: without(state.failed, out),
        marks,
        ...(out.some((item) => state.refused[item] !== undefined)
          ? { refused: without(state.refused, out) }
          : {}),
      });
      const retryKey = get().toast?.retryKey;
      if (retryKey !== undefined && out.includes(retryKey)) dismissAskToast();
    }
    const left = refs.filter((ref) => {
      const what = now.get(ref.key);
      return what === "current" || what === "unknown";
    });
    if (left.length === 0) {
      if (!auto) {
        showAskToast(
          moved.length > 0
            ? {
                text: `Not sent: ${label} changed since you answered. What you typed is kept.`,
                viewKey: moved[0]!,
              }
            : { text: `Not sent: ${label} is no longer open.` },
          9_000,
        );
      }
      return moved.length > 0 ? "moved" : "closed";
    }
    if (left.some((ref) => now.get(ref.key) === "unknown")) {
      if (!auto) {
        showAskToast(
          {
            text: `Not sent · ${label}. It can't be sent until the ask can be read in this version of Robob. Your answer is kept.`,
          },
          9_000,
        );
      }
      return "waiting";
    }
    const state = get();
    const keys = left.map((ref) => ref.key);
    const send: AskSend = {
      ...failed.send,
      id: ++sendId,
      refs: left,
      state: "sending",
      at: Date.now(),
      ...(auto ? { autoRetries: (failed.send.autoRetries ?? 0) + 1 } : {}),
    };
    const hidden = { ...state.hidden };
    for (const ref of send.refs) hidden[ref.key] = send.id;
    set({
      hidden,
      failed: without(state.failed, keys),
      marks: without(state.marks, keys),
      sent: [send, ...state.sent],
    });
    dismissAskToast();
    void deliver(send, false);
    return "sent";
  }

  /**
   * The connection is back: every answer that never reached the server goes
   * again, once. An answer the server refused stays where it is. A send leaves
   * the failed list before it goes, so the same answer is never sent twice from
   * here; if the first try did reach the server after all, the second is
   * refused as out of date and the feed shows the ask closed. An answer that
   * has already gone by itself `max` times stays for him to retry by hand: the
   * count rides on the answer, so it holds while the answer is on its way too.
   * With `only`, just the answers it picks go (the host decides which are due).
   *
   * Nothing out of date goes from here: each one goes through `retryAskSend`,
   * which holds its asks against the feed as last read, the same as a retry
   * by hand.
   */
  function retryUnreachedAskSends(
    max: number = ASK_AUTO_RETRY_MAX,
    only?: (send: AskSend) => boolean,
  ): number {
    if (disposed) return 0;
    const seen = new Set<number>();
    let count = 0;
    for (const [key, failed] of Object.entries(get().failed)) {
      if (failed.unreached !== true || seen.has(failed.send.id)) continue;
      if ((failed.send.autoRetries ?? 0) >= max) continue;
      if (only !== undefined && !only(failed.send)) continue;
      // A batch sits under each of its asks: one retry covers them all.
      seen.add(failed.send.id);
      if (get().failed[key] === undefined) continue;
      if (retryAskSend(key, true) === "sent") count += 1;
    }
    return count;
  }

  /** Takes an ask back from the evaluator. */
  async function takeBackAsk(entry: KanbanAskFeedItem) {
    if (disposed) return;
    try {
      await askApi.hand(entry.cardRef, entry.ask.id, { action: "take_back" });
      showAskToast({ text: `${entry.boardName} #${entry.cardNumber} is yours again.` });
    } catch (error) {
      noteRefusal(error);
      showAskToast({ text: `Couldn't take it back. ${askFailureText(error)}` });
    }
    void refreshAsks();
  }

  /**
   * Replies in the ask's discussion. It does not answer the ask: the ask then
   * waits on its agent, who may reply or rewrite it.
   */
  async function replyOnAsk(
    entry: KanbanAskFeedItem,
    blocks: ReadonlyArray<KanbanBlock>,
  ): Promise<void> {
    if (disposed) throw new Error("Not connected to Robob.");
    const problem = askReplyProblem(blocks);
    if (problem !== null) throw new Error(problem);
    try {
      await askApi.reply(entry.cardRef, entry.ask.id, blocks);
    } catch (error) {
      noteRefusal(error);
      throw new Error(askFailureText(error), { cause: error });
    }
    showAskToast({
      text: `Reply sent to ${askAsker(entry)}. ${entry.boardName} #${entry.cardNumber} waits until it answers.`,
    });
    await refreshAsks();
  }

  /**
   * Puts asks away until a time, or brings them back with `null`. They stay open
   * and keep holding their cards; they leave the count and the list until then.
   */
  async function snoozeAsks(
    entries: ReadonlyArray<KanbanAskFeedItem>,
    until: string | null,
    untilLabel: string,
  ): Promise<void> {
    const first = entries[0];
    if (!first || disposed) return;
    const refs = entries.map(refOf);
    const what =
      entries.length > 1 ? `${entries.length} asks` : `${first.boardName} #${first.cardNumber}`;
    try {
      await snoozeRefs(refs, until);
      if (until === null)
        showAskToast({ text: `${what} ${entries.length > 1 ? "are" : "is"} back in the queue.` });
      else
        showAskToast({ text: `Snoozed until ${untilLabel} · ${what}.`, undoSnooze: refs }, 8_000);
    } catch (error) {
      noteRefusal(error);
      showAskToast({
        text: `Couldn't snooze ${what}. ${askFailureText(error)}`,
      });
    }
    await refreshAsks();
  }

  /**
   * An answer that carried a secret went out over the private channel and was
   * taken: it joins this session's answers (without the secret) and the queue
   * moves on.
   */
  function noteAskAnswered(entry: KanbanAskFeedItem, body: AskAnswerBody, label: string) {
    const key = askKey(entry);
    const send: AskSend = {
      ...baseSend(entry, key),
      kind: "answer",
      refs: [refOf(entry)],
      body,
      label,
      state: "sent",
    };
    const state = get();
    set({
      hidden: { ...state.hidden, [key]: send.id },
      sent: [send, ...state.sent],
      forms: without(state.forms, [key]),
      tried: without(state.tried, [key]),
      refused: without(state.refused, [key]),
      failed: without(state.failed, [key]),
      marks: without(state.marks, [key]),
    });
    showAskToast({ text: `${label} · ${refLabel(send)}. Sent to ${send.to}.` });
    void refreshAsks();
  }

  /** The ask changed under an answer that could not be held: read it again and say so. */
  function noteAskStale(entry: KanbanAskFeedItem) {
    set({ marks: { ...get().marks, [askKey(entry)]: "updated" } });
    void refreshAsks();
  }

  /**
   * The server this store talks to is no longer the one in use (the connection
   * was switched, disabled or removed). Everything that was waiting on it is
   * dropped rather than carried to another server: the held answer is never
   * sent, answers that failed are never retried, forms and what was read are
   * cleared, and a read or send still on its way changes nothing when it
   * lands. A disposed store stays empty; the host makes a new one for the
   * next server.
   */
  function dispose() {
    if (disposed) return;
    // Forms first: they hold what he typed for that server.
    host.cell.setState({ forms: {}, tried: {}, refused: {} });
    // The held answer is dropped, not flushed.
    queue.undo();
    if (toastTimer !== null) clearTimeout(toastTimer);
    toastTimer = null;
    stopWatching?.();
    stopWatching = null;
    watchers = 0;
    again = false;
    closedOwed = false;
    focusedKey = null;
    sending.clear();
    host.cell.setState({ ...INITIAL_ASK_STATE });
    disposed = true;
  }

  /** For tests and the stories: back to an empty store. */
  const resetAskStore = () => {
    queue.undo();
    set(INITIAL_ASK_STATE);
  };

  return {
    showAskToast,
    dismissAskToast,
    noteAskFocus,
    refreshAsks,
    loadClosedAsks,
    watchAsks,
    patchAskForm,
    setAskValue,
    setAskChangeView,
    markAskTried,
    seeAsk,
    loadAskDetail,
    noteOwnerStanding,
    noteAskNotOwner,
    flushAskSends,
    answerAsk,
    answerAskBatch,
    handAsks,
    undoAskSend,
    retryAskSend,
    retryUnreachedAskSends,
    dispose,
    takeBackAsk,
    replyOnAsk,
    snoozeAsks,
    noteAskAnswered,
    noteAskStale,
    resetAskStore,
  };
}
