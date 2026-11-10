/**
 * What the Needs-you page knows: the ask feed, what he has typed on each ask,
 * and the answers that are held, on their way, failed or sent. One store for
 * the page and the sidebar count.
 */
import {
  askFormCarried,
  askFormFor,
  buildAskAnswer,
  createAskSendQueue,
  type AskAnswerBody,
  type AskForm,
  type AskIntent,
  type AskProblemKey,
  type HeldSend,
  type NeedsYouMark,
} from "@t3tools/client-runtime/ardud/kanban";
import {
  kanbanAskRevision,
  type KanbanAskFeed,
  type KanbanAskFeedItem,
  type KanbanBlock,
  type KanbanOwnerAsk,
} from "@t3tools/contracts";
import { create } from "zustand";

import { kanban } from "../kanbanStore";
import { askApi, AskApiError } from "./askApi";

export const askKey = (entry: Pick<KanbanAskFeedItem, "cardId" | "ask">): string =>
  `${entry.cardId}:${entry.ask.id}`;

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
}

interface AskState {
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly error: string | null;
  readonly feed: KanbanAskFeed | null;
  /** Asks closed in the History window; null until read. */
  readonly closed: ReadonlyArray<KanbanAskFeedItem> | null;
  readonly closedStatus: "idle" | "loading" | "ready" | "error";
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
  readonly failed: Readonly<Record<string, { readonly send: AskSend; readonly message: string }>>;
  /** Answers given in this session, newest first. */
  readonly sent: ReadonlyArray<AskSend>;
  /** Asks read whole (their big blocks are stubs in the feed), by `key@revision`. */
  readonly details: Readonly<Record<string, KanbanOwnerAsk>>;
  readonly toast: AskToast | null;
}

const INITIAL: AskState = {
  status: "idle",
  error: null,
  feed: null,
  closed: null,
  closedStatus: "idle",
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
  toast: null,
};

export const useAskStore = create<AskState>(() => INITIAL);
const get = useAskStore.getState;
const set = useAskStore.setState;

const without = <T>(record: Readonly<Record<string, T>>, keys: ReadonlyArray<string>) => {
  const next = { ...record };
  for (const key of keys) delete next[key];
  return next;
};

let toastId = 0;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

export function showAskToast(toast: Omit<AskToast, "id">, ms = 4_200) {
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

export const dismissAskToast = () => {
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = null;
  set({ toast: null });
};

let inFlight: Promise<void> | null = null;
let again = false;
/** The ask the page has open: changes on it need no "new" mark. */
let focusedKey: string | null = null;
export const noteAskFocus = (key: string | null) => {
  focusedKey = key;
};

function mergeFeed(feed: KanbanAskFeed) {
  const state = get();
  const before = new Map((state.feed?.open ?? []).map((entry) => [askKey(entry), entry]));
  const marks = { ...state.marks };
  const previous = { ...state.previous };
  const forms = { ...state.forms };
  const openKeys = new Set<string>();
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
      entry.messages.length > old.messages.length && entry.messages.at(-1)?.author._tag !== "owner";
    const cameBack = old.waitsOn !== "owner" && entry.waitsOn === "owner";
    if ((agentSpoke || cameBack) && key !== focusedKey && entry.waitsOn === "owner") {
      marks[key] ??= "reply";
    }
  }
  // An ask that closed (or whose send finished) is no longer hidden, marked or failed.
  const gone = (key: string) => !openKeys.has(key);
  const hidden = { ...state.hidden };
  for (const [key, sendId] of Object.entries(hidden)) {
    const live = state.held?.payload.id === sendId || sending.has(sendId);
    if (!live) delete hidden[key];
  }
  for (const key of Object.keys(marks)) if (gone(key)) delete marks[key];
  set({
    feed,
    status: "ready",
    error: null,
    marks,
    previous,
    forms,
    hidden,
    failed: without(state.failed, Object.keys(state.failed).filter(gone)),
  });
}

/** Reads the feed again. Calls that arrive while one is running fold into one more. */
export function refreshAsks(): Promise<void> {
  if (inFlight !== null) {
    again = true;
    return inFlight;
  }
  if (get().feed === null) set({ status: "loading" });
  inFlight = askApi
    .feed()
    .then(mergeFeed, (error: unknown) => {
      set({
        status: get().feed === null ? "error" : "ready",
        error: error instanceof Error ? error.message : "Couldn't load asks.",
      });
    })
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
export async function loadClosedAsks(): Promise<void> {
  if (get().closedStatus === "loading") return;
  set({ closedStatus: get().closed === null ? "loading" : "ready" });
  try {
    const feed = await askApi.feed({ closed: "7d" });
    mergeFeed(feed);
    set({ closed: feed.closed, closedStatus: "ready" });
  } catch {
    set({ closedStatus: get().closed === null ? "error" : "ready" });
  }
}

let watchers = 0;
let stopWatching: (() => void) | null = null;
let pollMs = 60_000;
let pollTimer: ReturnType<typeof setInterval> | null = null;

const restartPoll = () => {
  if (pollTimer !== null) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (document.visibilityState === "visible") void refreshAsks();
  }, pollMs);
};

/**
 * Keeps the feed current while anything shows it: it is read again when a
 * board's counts change (the board list feed), when the window comes back,
 * and on a slow timer for edits that change no count. `fast` is the page
 * itself; the sidebar count alone polls slowly.
 */
export function watchAsks(fast: boolean): () => void {
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
    const offBoards = kanban.boards.subscribe(soon);
    const onVisible = () => {
      if (document.visibilityState === "visible") soon();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", soon);
    restartPoll();
    void refreshAsks();
    stopWatching = () => {
      offBoards();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", soon);
      if (debounce !== null) clearTimeout(debounce);
      if (pollTimer !== null) clearInterval(pollTimer);
      pollTimer = null;
    };
  }
  return () => {
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

export const formOf = (state: AskState, entry: KanbanAskFeedItem): AskForm =>
  state.forms[askKey(entry)] ?? askFormFor(entry.ask);

export function patchAskForm(entry: KanbanAskFeedItem, patch: Partial<AskForm>) {
  const key = askKey(entry);
  const state = get();
  set({
    forms: { ...state.forms, [key]: { ...formOf(state, entry), ...patch } },
    ...(state.refused[key] ? { refused: without(state.refused, [key]) } : {}),
  });
}

export function setAskValue(entry: KanbanAskFeedItem, fieldId: string, value: unknown) {
  const form = formOf(get(), entry);
  patchAskForm(entry, { values: { ...form.values, [fieldId]: value } });
}

/** He opened the ask: what was new on it has been seen. */
export function seeAsk(key: string) {
  const state = get();
  if (state.marks[key] === undefined && state.previous[key] === undefined) return;
  set({ marks: without(state.marks, [key]), previous: without(state.previous, [key]) });
}

/** Reads an ask whole when the feed sent its big blocks as stubs. */
export async function loadAskDetail(entry: KanbanAskFeedItem): Promise<void> {
  const id = `${askKey(entry)}@${entry.revision}`;
  if (get().details[id] !== undefined) return;
  const detail = await askApi.detail(entry.cardRef, entry.ask.id);
  set({ details: { ...get().details, [id]: detail.ask } });
}

export const askNeedsDetail = (ask: KanbanOwnerAsk): boolean =>
  (ask.blocks ?? []).some(
    (block) =>
      (block._tag === "md" || block._tag === "collapse" || block._tag === "html") &&
      block.truncated === true,
  );

let sendId = 0;
const sending = new Set<number>();

const patchSend = (id: number, patch: Partial<AskSend>) => {
  const state = get();
  set({ sent: state.sent.map((send) => (send.id === id ? { ...send, ...patch } : send)) });
};

const refLabel = (send: AskSend) =>
  send.refs.length > 1
    ? `${send.refs.length} asks`
    : send.cardNumber === null
      ? send.boardName
      : `${send.boardName} #${send.cardNumber}`;

/** One ask's send was refused: it comes back to the queue with what he typed. */
function giveBack(send: AskSend, ref: AskSendRef, error: unknown) {
  const state = get();
  const hidden = without(state.hidden, [ref.key]);
  if (error instanceof AskApiError && error.stale) {
    // The ask changed or closed since he read it: read it again and keep his form.
    set({ hidden, marks: { ...state.marks, [ref.key]: "updated" } });
    return "stale" as const;
  }
  const message = error instanceof Error ? error.message : "Robob did not confirm it.";
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
  set({
    hidden,
    marks: { ...state.marks, [ref.key]: "failed" },
    failed: { ...state.failed, [ref.key]: { send, message } },
  });
  return "failed" as const;
}

async function deliver(send: AskSend, leaving: boolean) {
  sending.add(send.id);
  patchSend(send.id, { state: "sending" });
  const first = send.refs[0]!;
  let outcome: "sent" | "stale" | "invalid" | "failed" = "sent";
  let refusedCount = 0;
  let evaluator: AskSend["evaluator"];
  try {
    if (send.kind === "hand") {
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
    } else if (send.kind === "batch") {
      const { revision: _revision, values: _values, finalDraft: _finalDraft, ...body } = send.body;
      const result = await askApi.answerBatch(
        body,
        send.refs.map((ref) => ({ card: ref.cardRef, askId: ref.askId, revision: ref.revision })),
        leaving,
      );
      for (const entry of result.results) {
        if (entry.ok) continue;
        const ref = send.refs.find(
          (item) => item.cardRef === entry.card && item.askId === entry.askId,
        );
        if (!ref) continue;
        refusedCount += 1;
        giveBack(
          send,
          ref,
          new AskApiError(
            entry.error.code === "conflict" ? 409 : 400,
            entry.error.code,
            entry.error.message,
          ),
        );
      }
    } else {
      await askApi.answer(first.cardRef, first.askId, send.body, leaving);
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
  if (leaving) return;
  void refreshAsks();
  if (outcome === "stale") {
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
        text: `Not sent: ${send.label.toLowerCase()} on ${refLabel(send)}. ${get().failed[first.key]?.message ?? "Robob did not confirm it."}`,
        ...(outcome === "failed" ? { retryKey: first.key } : { viewKey: first.key }),
      },
      9_000,
    );
  } else if (refusedCount > 0) {
    showAskToast(
      {
        text: `${send.label} ${send.refs.length - refusedCount} of ${send.refs.length}. ${refusedCount} changed and ${refusedCount === 1 ? "was" : "were"} not answered.`,
      },
      9_000,
    );
  } else if (evaluator && !evaluator.started) {
    showAskToast(
      {
        text: `Handed over, but the evaluator did not start: ${evaluator.error ?? "no reason given"}.`,
      },
      9_000,
    );
  } else if (get().toast?.undoSendId === send.id || get().toast === null) {
    showAskToast({ text: `Sent to ${send.to}.` });
  }
}

const queue = createAskSendQueue<AskSend>({
  now: () => Date.now(),
  setTimer: (run, ms) => setTimeout(run, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  send: (send, leaving) => void deliver(send, leaving),
  onChange: (held) => set({ held }),
});

/** Sends a held answer now: he is leaving the page or closing the tab. */
export const flushAskSends = (leaving: boolean) => queue.flush(leaving);

function hold(send: AskSend, text: string) {
  const state = get();
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
  title: entry.ask.title ?? entry.ask.text,
  boardId: entry.boardId,
  boardName: entry.boardName,
  cardNumber: entry.cardNumber,
  to: askAsker(entry),
  at: Date.now(),
  state: "held",
});

const refOf = (entry: KanbanAskFeedItem): AskSendRef => ({
  key: askKey(entry),
  cardRef: entry.cardRef,
  askId: entry.ask.id,
  revision: kanbanAskRevision(entry.ask),
});

/**
 * Answers the ask with what its form holds. Returns the problems when
 * something is missing; otherwise the answer is held for six seconds.
 */
export function answerAsk(
  entry: KanbanAskFeedItem,
  intent: AskIntent,
): { readonly ok: true } | { readonly ok: false; readonly first: AskProblemKey } {
  const key = askKey(entry);
  const state = get();
  const form = formOf(state, entry);
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
export function answerAskBatch(
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
  hold(send, `${label} · ${entries.length} asks.${body.note ? " Your note goes with each." : ""}`);
}

/** Hands the ask to the board's evaluator; with `words`, also asks like it from now on. */
export function handAsk(entry: KanbanAskFeedItem, words?: string) {
  const send: AskSend = {
    ...baseSend(entry, askKey(entry)),
    kind: "hand",
    refs: [refOf(entry)],
    body: { verdict: "handed" },
    label: "Handed to the evaluator",
    to: `the ${entry.boardName} evaluator`,
    ...(words === undefined ? {} : { hand: { always: true, text: words } }),
  };
  hold(
    send,
    `Handed to the evaluator · ${refLabel(send)}.${words === undefined ? "" : " An evaluator thread starts with your words."}`,
  );
}

/** Takes back the held answer. Returns what to focus again, or null when nothing was held. */
export function undoAskSend(): string | null {
  const send = queue.undo();
  if (send === null) return null;
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

/** Sends a failed answer again, at once. */
export function retryAskSend(key: string) {
  const state = get();
  const failed = state.failed[key];
  if (!failed) return;
  const keys = failed.send.refs.map((ref) => ref.key).filter((ref) => state.failed[ref]);
  const send: AskSend = {
    ...failed.send,
    id: ++sendId,
    refs: failed.send.refs.filter((ref) => keys.includes(ref.key)),
    state: "sending",
    at: Date.now(),
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
}

/** Takes an ask back from the evaluator. */
export async function takeBackAsk(entry: KanbanAskFeedItem) {
  try {
    await askApi.hand(entry.cardRef, entry.ask.id, { action: "take_back" });
    showAskToast({ text: `${entry.boardName} #${entry.cardNumber} is yours again.` });
  } catch (error) {
    showAskToast({ text: `Couldn't take it back. ${error instanceof Error ? error.message : ""}` });
  }
  void refreshAsks();
}

/**
 * Replies in the ask's discussion. It does not answer the ask: the ask then
 * waits on its agent, who may reply or rewrite it.
 */
export async function replyOnAsk(
  entry: KanbanAskFeedItem,
  blocks: ReadonlyArray<KanbanBlock>,
): Promise<void> {
  await askApi.reply(entry.cardRef, entry.ask.id, blocks);
  showAskToast({
    text: `Reply sent to ${askAsker(entry)}. ${entry.boardName} #${entry.cardNumber} waits until it answers.`,
  });
  await refreshAsks();
}

/** For tests and the stories: back to an empty store. */
export const resetAskStore = () => {
  queue.undo();
  set(INITIAL);
};
