import type { KanbanAskFeed, KanbanAskFeedItem, KanbanOwnerAsk } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { AskApiError, type AskApi } from "./askApi.ts";
import { ASK_NOT_OWNER_DEVICE_TEXT } from "./askSecrets.ts";
import { ASK_UNDO_MS } from "./askSendQueue.ts";
import {
  ASK_AUTO_RETRY_MAX,
  INITIAL_ASK_STATE,
  askAutoRetryOwed,
  askFormOf,
  askKey,
  createAskStateCell,
  createAskStore,
} from "./askStore.ts";

const entry = (
  number: number,
  ask: Partial<KanbanOwnerAsk> = {},
  item: Partial<KanbanAskFeedItem> = {},
): KanbanAskFeedItem =>
  ({
    boardId: "b1",
    boardSlug: "robob",
    boardName: "Robob",
    cardId: `c${number}`,
    cardNumber: number,
    cardRef: `robob:${number}`,
    cardTitle: `Card ${number}`,
    stage: "needs_owner",
    priority: 3,
    discussionId: null,
    blocks: 0,
    ask: {
      id: "q1",
      text: "Ship it?",
      blocking: true,
      by: { _tag: "thread", threadId: "t1" },
      at: "2026-11-11T08:00:00.000Z",
      seq: null,
      closedAt: null,
      kind: "approval",
      respond: { verdict: {} },
      ...ask,
    },
    kind: "approval",
    revision: ask.revision ?? 0,
    waitsOn: "owner",
    expired: false,
    messages: [],
    ...item,
  }) as unknown as KanbanAskFeedItem;

const feedOf = (open: ReadonlyArray<KanbanAskFeedItem>): KanbanAskFeed =>
  ({ at: "2026-11-11T08:00:00.000Z", open, closed: [] }) as KanbanAskFeed;

function harness() {
  let feed = feedOf([]);
  const boards = new Set<() => void>();
  const foreground = new Set<() => void>();
  const calls: Array<{ readonly name: string; readonly args: ReadonlyArray<unknown> }> = [];
  const fail: Partial<Record<keyof AskApi, unknown>> = {};
  const results: Partial<Record<keyof AskApi, unknown>> = {};
  const call =
    (name: keyof AskApi, fallback: unknown) =>
    async (...args: ReadonlyArray<unknown>) => {
      calls.push({ name, args });
      if (fail[name] !== undefined) throw fail[name];
      return results[name] ?? fallback;
    };
  const api = {
    feed: async (...args: ReadonlyArray<unknown>) => {
      calls.push({ name: "feed", args });
      if (fail.feed !== undefined) throw fail.feed;
      return feed;
    },
    detail: call("detail", {}),
    answer: call("answer", { card: {}, ask: null }),
    answerSecrets: call("answerSecrets", { _tag: "sent" }),
    answerBatch: call("answerBatch", { answered: 0, results: [] }),
    reply: call("reply", {}),
    hand: call("hand", { card: {}, ask: null }),
    handBatch: call("handBatch", { handed: 0, results: [] }),
    snooze: call("snooze", { card: {}, ask: null }),
    snoozeBatch: call("snoozeBatch", { snoozed: 0, results: [] }),
    message: call("message", {}),
  } as unknown as AskApi;
  const cell = createAskStateCell();
  const store = createAskStore({
    api,
    cell,
    watch: {
      onBoardsChange: (run) => {
        boards.add(run);
        return () => void boards.delete(run);
      },
      onForeground: (run) => {
        foreground.add(run);
        return () => void foreground.delete(run);
      },
      isForeground: () => true,
    },
  });
  return {
    store,
    cell,
    calls,
    fail,
    results,
    boards,
    foreground,
    named: (name: string) => calls.filter((entry) => entry.name === name),
    setFeed: (open: ReadonlyArray<KanbanAskFeedItem>) => {
      feed = feedOf(open);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const settle = () => vi.advanceTimersByTimeAsync(0);

describe("answering", () => {
  it("holds an answer for undo, then sends it once with the revision he read", async () => {
    const h = harness();
    const ask = entry(1, { revision: 2 });
    h.setFeed([ask]);
    await h.store.refreshAsks();

    expect(h.store.answerAsk(ask, "primary")).toEqual({ ok: true });
    expect(h.cell.getState().hidden[askKey(ask)]).toBeDefined();
    expect(h.cell.getState().toast?.undoSendId).toBeDefined();
    expect(h.named("answer")).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(ASK_UNDO_MS);
    expect(h.named("answer")).toHaveLength(1);
    expect(h.named("answer")[0]!.args).toEqual([
      "robob:1",
      "q1",
      { verdict: "approved", revision: 2 },
      2,
      false,
    ]);
    expect(h.cell.getState().sent[0]?.state).toBe("sent");
    expect(h.cell.getState().toast?.text).toBe("Sent to the #1 work thread.");

    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.named("answer")).toHaveLength(1);
  });

  it("undo takes the held answer back and nothing is sent", async () => {
    const h = harness();
    const ask = entry(1);
    h.setFeed([ask]);
    await h.store.refreshAsks();
    h.store.answerAsk(ask, "primary");

    expect(h.store.undoAskSend()).toBe(askKey(ask));
    await vi.advanceTimersByTimeAsync(ASK_UNDO_MS * 2);
    expect(h.named("answer")).toHaveLength(0);
    expect(h.cell.getState().hidden).toEqual({});
    expect(h.cell.getState().sent).toEqual([]);
  });

  it("leaving sends the held answer at once", async () => {
    const h = harness();
    const ask = entry(1);
    h.setFeed([ask]);
    await h.store.refreshAsks();
    h.store.answerAsk(ask, "primary");
    h.store.flushAskSends(true);
    await settle();
    expect(h.named("answer")[0]!.args[4]).toBe(true);
  });

  it("words alone never go out as the answer to a required pick", async () => {
    const h = harness();
    const ask = entry(1, {
      kind: "decision",
      respond: undefined,
      options: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
    });
    h.setFeed([ask]);
    await h.store.refreshAsks();
    h.store.patchAskForm(ask, { ownWords: "neither, do it differently" });

    expect(h.store.answerAsk(ask, "primary")).toEqual({ ok: false, first: "choose" });
    await vi.advanceTimersByTimeAsync(ASK_UNDO_MS);
    expect(h.named("answer")).toHaveLength(0);
    expect(h.cell.getState().tried[askKey(ask)]).toBe(true);
  });

  it("a stale revision is never resent: the ask is marked updated and his form is kept", async () => {
    const h = harness();
    const ask = entry(1, { revision: 1 });
    h.setFeed([ask]);
    await h.store.refreshAsks();
    h.store.patchAskForm(ask, { note: "ship after lunch" });
    h.fail.answer = new AskApiError(409, "conflict", "The ask changed.", 2);

    h.store.answerAsk(ask, "primary");
    await vi.advanceTimersByTimeAsync(ASK_UNDO_MS);
    const state = h.cell.getState();
    expect(state.marks[askKey(ask)]).toBe("updated");
    expect(state.failed).toEqual({});
    expect(state.hidden).toEqual({});
    expect(askFormOf(state, ask).note).toBe("ship after lunch");
    expect(state.toast?.text).toContain("changed while you were answering");
    expect(state.toast?.retryKey).toBeUndefined();

    h.store.retryAskSend(askKey(ask));
    expect(h.store.retryUnreachedAskSends()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.named("answer")).toHaveLength(1);
  });

  it("a refused value shows on its field, with what he typed kept", async () => {
    const h = harness();
    const ask = entry(1, {
      kind: "input",
      respond: { fields: [{ id: "cap", label: "Cap", type: "number", required: true }] },
    } as Partial<KanbanOwnerAsk>);
    h.setFeed([ask]);
    await h.store.refreshAsks();
    h.store.setAskValue(ask, "cap", "12");
    h.fail.answer = new AskApiError(400, "invalid", 'field "cap" must be at most 10');

    h.store.answerAsk(ask, "primary");
    await vi.advanceTimersByTimeAsync(ASK_UNDO_MS);
    const state = h.cell.getState();
    expect(state.refused[askKey(ask)]).toEqual({ "field:cap": 'field "cap" must be at most 10' });
    expect(state.failed[askKey(ask)]?.unreached).toBeUndefined();
    expect(askFormOf(state, ask).values.cap).toBe("12");
    // The server refused it: it does not go again by itself.
    expect(h.store.retryUnreachedAskSends()).toBe(0);
  });
});

describe("offline", () => {
  it("an answer that never reached the server is kept and goes once when the connection is back", async () => {
    const h = harness();
    const ask = entry(1);
    h.setFeed([ask]);
    await h.store.refreshAsks();
    h.fail.answer = new AskApiError(0, "network", "Robob did not answer.");

    h.store.answerAsk(ask, "primary");
    await vi.advanceTimersByTimeAsync(ASK_UNDO_MS);
    let state = h.cell.getState();
    expect(state.failed[askKey(ask)]?.unreached).toBe(true);
    expect(state.marks[askKey(ask)]).toBe("failed");
    expect(state.toast?.retryKey).toBe(askKey(ask));
    expect(h.named("answer")).toHaveLength(1);

    delete h.fail.answer;
    expect(h.store.retryUnreachedAskSends()).toBe(1);
    // Asked twice in a row (two reconnect signals): still one send.
    expect(h.store.retryUnreachedAskSends()).toBe(0);
    await settle();
    state = h.cell.getState();
    expect(h.named("answer")).toHaveLength(2);
    expect(state.failed).toEqual({});
    expect(state.sent[0]?.state).toBe("sent");
  });

  it("a batch that never reached the server is retried as one send", async () => {
    const h = harness();
    const asks = [entry(1), entry(2), entry(3)];
    h.setFeed(asks);
    await h.store.refreshAsks();
    h.fail.answerBatch = new AskApiError(0, "network", "Robob did not answer.");
    h.store.answerAskBatch(asks, "batch:b1:k", { verdict: "approved" }, "Approved", "3 alike");
    await vi.advanceTimersByTimeAsync(ASK_UNDO_MS);
    expect(Object.keys(h.cell.getState().failed)).toHaveLength(3);

    delete h.fail.answerBatch;
    h.results.answerBatch = {
      answered: 3,
      results: asks.map((ask) => ({ card: ask.cardRef, askId: "q1", ok: true, stage: "ready" })),
    };
    expect(h.store.retryUnreachedAskSends()).toBe(1);
    await settle();
    expect(h.named("answerBatch")).toHaveLength(2);
    expect((h.named("answerBatch")[1]!.args[1] as ReadonlyArray<unknown>).length).toBe(3);
  });
});

describe("automatic retries", () => {
  it("an answer goes by itself a few times at most, counted through every failure and send", async () => {
    const h = harness();
    const ask = entry(1);
    h.setFeed([ask]);
    await h.store.refreshAsks();
    h.fail.answer = new AskApiError(0, "network", "Robob did not answer.");
    h.store.answerAsk(ask, "primary");
    await vi.advanceTimersByTimeAsync(ASK_UNDO_MS);
    expect(askAutoRetryOwed(h.cell.getState())).toBe(true);

    for (let round = 1; round <= ASK_AUTO_RETRY_MAX; round += 1) {
      expect(h.store.retryUnreachedAskSends()).toBe(1);
      // On its way it has left the failed list; the count is on the answer itself.
      expect(h.cell.getState().failed).toEqual({});
      expect(h.cell.getState().sent[0]?.autoRetries).toBe(round);
      await settle();
      expect(h.cell.getState().failed[askKey(ask)]?.send.autoRetries).toBe(round);
    }
    expect(h.named("answer")).toHaveLength(1 + ASK_AUTO_RETRY_MAX);

    // The limit is reached: nothing more goes by itself, however often it is asked.
    expect(askAutoRetryOwed(h.cell.getState())).toBe(false);
    expect(h.store.retryUnreachedAskSends()).toBe(0);
    await settle();
    expect(h.named("answer")).toHaveLength(1 + ASK_AUTO_RETRY_MAX);

    // By hand it always goes, and that does not buy more automatic tries.
    h.store.retryAskSend(askKey(ask));
    await settle();
    expect(h.named("answer")).toHaveLength(2 + ASK_AUTO_RETRY_MAX);
    expect(h.store.retryUnreachedAskSends()).toBe(0);
  });

  it("a new answer to the same ask starts its own count", async () => {
    const h = harness();
    const ask = entry(1);
    h.setFeed([ask]);
    await h.store.refreshAsks();
    h.fail.answer = new AskApiError(0, "network", "Robob did not answer.");
    h.store.answerAsk(ask, "primary");
    await vi.advanceTimersByTimeAsync(ASK_UNDO_MS);
    for (let round = 0; round < ASK_AUTO_RETRY_MAX; round += 1) {
      h.store.retryUnreachedAskSends();
      await settle();
    }
    expect(askAutoRetryOwed(h.cell.getState())).toBe(false);

    h.store.answerAsk(ask, "primary");
    await vi.advanceTimersByTimeAsync(ASK_UNDO_MS);
    expect(h.cell.getState().failed[askKey(ask)]?.send.autoRetries).toBeUndefined();
    expect(askAutoRetryOwed(h.cell.getState())).toBe(true);
  });
});

describe("a store whose server is gone", () => {
  it("drops the held answer: it is never sent", async () => {
    const h = harness();
    const ask = entry(1);
    h.setFeed([ask]);
    await h.store.refreshAsks();
    h.store.patchAskForm(ask, { note: "for the old server" });
    h.store.answerAsk(ask, "primary");
    expect(h.cell.getState().held).not.toBeNull();

    h.store.dispose();
    expect(h.cell.getState()).toEqual(INITIAL_ASK_STATE);
    await vi.advanceTimersByTimeAsync(ASK_UNDO_MS * 3);
    h.store.flushAskSends(true);
    await settle();
    expect(h.named("answer")).toHaveLength(0);
  });

  it("never retries an answer that failed, by itself or by hand", async () => {
    const h = harness();
    const ask = entry(1);
    h.setFeed([ask]);
    await h.store.refreshAsks();
    h.fail.answer = new AskApiError(0, "network", "Robob did not answer.");
    h.store.answerAsk(ask, "primary");
    await vi.advanceTimersByTimeAsync(ASK_UNDO_MS);
    expect(h.cell.getState().failed[askKey(ask)]?.unreached).toBe(true);

    delete h.fail.answer;
    h.store.dispose();
    expect(h.store.retryUnreachedAskSends()).toBe(0);
    h.store.retryAskSend(askKey(ask));
    await settle();
    expect(h.named("answer")).toHaveLength(1);
  });

  it("sends, reads and writes nothing afterwards, and a read on its way changes nothing", async () => {
    const h = harness();
    const ask = entry(1);
    h.setFeed([ask]);
    const reading = h.store.refreshAsks();
    h.store.dispose();
    await reading;
    expect(h.cell.getState()).toEqual(INITIAL_ASK_STATE);

    const before = h.calls.length;
    h.store.answerAsk(ask, "primary");
    h.store.handAsks([ask], askKey(ask));
    h.store.patchAskForm(ask, { note: "typed late" });
    await h.store.snoozeAsks([ask], "2026-11-12T05:00:00.000Z", "tomorrow 09:00");
    await h.store.takeBackAsk(ask);
    await h.store.refreshAsks();
    await h.store.loadClosedAsks();
    await expect(h.store.replyOnAsk(ask, [{ _tag: "md", text: "hello" }])).rejects.toThrow();
    const stop = h.store.watchAsks(true);
    await vi.advanceTimersByTimeAsync(120_000);
    stop();
    expect(h.calls.length).toBe(before);
    expect(h.cell.getState()).toEqual(INITIAL_ASK_STATE);
    expect(h.boards.size + h.foreground.size).toBe(0);
  });
});

describe("owner standing", () => {
  it("a session that is not the owner's says so up front and holds nothing", async () => {
    const h = harness();
    const ask = entry(1);
    h.setFeed([ask]);
    await h.store.refreshAsks();
    h.store.noteOwnerStanding(false);
    expect(h.cell.getState().notOwner).toEqual({ text: ASK_NOT_OWNER_DEVICE_TEXT, device: true });

    h.fail.answer = new AskApiError(403, "denied", "Not yours.", null, "not_owner_device");
    h.store.answerAsk(ask, "primary");
    await settle();
    const state = h.cell.getState();
    expect(state.held).toBeNull();
    expect(state.hidden).toEqual({});
    expect(state.failed).toEqual({});
    expect(state.notOwner).toEqual({ text: "Not yours.", device: true });
    expect(state.toast?.retryKey).toBeUndefined();
    expect(state.toast?.text).toBe("Not sent. Not yours.");

    h.store.noteOwnerStanding(true);
    expect(h.cell.getState().notOwner).toBeNull();
  });

  it("a snooze or reply refused as not the owner's is remembered", async () => {
    const h = harness();
    const ask = entry(1);
    h.setFeed([ask]);
    await h.store.refreshAsks();
    h.fail.snooze = new AskApiError(403, "denied", "Not yours.", null, "not_owner_device");
    await h.store.snoozeAsks([ask], "2026-11-12T05:00:00.000Z", "tomorrow 09:00");
    expect(h.cell.getState().notOwner?.device).toBe(true);
    expect(h.cell.getState().toast?.text).toBe("Couldn't snooze Robob #1. Not yours.");
  });
});

describe("what a host retries on", () => {
  it("counts the reads that came back good, not the ones that failed", async () => {
    const h = harness();
    h.setFeed([entry(1)]);
    expect(h.cell.getState().reads).toBe(0);
    await h.store.refreshAsks();
    expect(h.cell.getState().reads).toBe(1);
    h.fail.feed = new AskApiError(0, "network", "Robob did not answer.");
    await h.store.refreshAsks();
    expect(h.cell.getState().reads).toBe(1);
    expect(h.cell.getState().error).not.toBeNull();
    delete h.fail.feed;
    await h.store.refreshAsks();
    expect(h.cell.getState().reads).toBe(2);
    expect(h.cell.getState().error).toBeNull();
  });

  it("sends only the answers the host says are due", async () => {
    const h = harness();
    const one = entry(1);
    const two = entry(2);
    h.setFeed([one, two]);
    await h.store.refreshAsks();
    h.fail.answer = new AskApiError(0, "network", "Robob did not answer.");
    h.store.answerAsk(one, "primary");
    await vi.advanceTimersByTimeAsync(ASK_UNDO_MS);
    h.store.answerAsk(two, "primary");
    await vi.advanceTimersByTimeAsync(ASK_UNDO_MS);
    const due = h.cell.getState().failed[askKey(two)]!.send.id;

    expect(h.store.retryUnreachedAskSends(undefined, (send) => send.id === due)).toBe(1);
    expect(Object.keys(h.cell.getState().failed)).toEqual([askKey(one)]);
    await settle();
    expect(h.named("answer")).toHaveLength(3);
    expect(h.cell.getState().failed[askKey(one)]?.send.autoRetries).toBeUndefined();
    expect(h.cell.getState().failed[askKey(two)]?.send.autoRetries).toBe(1);
  });
});

describe("the feed", () => {
  it("an edited ask is marked updated, keeps the version he saw and carries his form", async () => {
    const h = harness();
    const first = entry(1, { text: "Ship it?" });
    h.setFeed([first]);
    await h.store.refreshAsks();
    h.store.patchAskForm(first, { note: "after lunch" });

    const edited = entry(1, { text: "Ship it today?", revision: 1 });
    h.setFeed([edited]);
    await h.store.refreshAsks();
    const state = h.cell.getState();
    expect(state.marks[askKey(first)]).toBe("updated");
    expect(state.previous[askKey(first)]?.text).toBe("Ship it?");
    expect(askFormOf(state, edited).note).toBe("after lunch");

    h.store.seeAsk(askKey(first));
    expect(h.cell.getState().marks).toEqual({});
    expect(h.cell.getState().previous).toEqual({});
  });

  it("an agent's reply marks the ask, unless it is the one open", async () => {
    const h = harness();
    const a = entry(1);
    const b = entry(2);
    h.setFeed([a, b]);
    await h.store.refreshAsks();
    h.store.noteAskFocus(askKey(b));
    const message = { author: { _tag: "thread", threadId: "t1" } };
    h.setFeed([
      entry(1, {}, { messages: [message] as never }),
      entry(2, {}, { messages: [message] as never }),
    ]);
    await h.store.refreshAsks();
    expect(h.cell.getState().marks).toEqual({ [askKey(a)]: "reply" });
  });

  it("a failed first read is an error; a failed later read keeps what it has", async () => {
    const h = harness();
    h.fail.feed = new AskApiError(0, "network", "Robob did not answer.");
    await h.store.refreshAsks();
    expect(h.cell.getState().status).toBe("error");
    delete h.fail.feed;
    h.setFeed([entry(1)]);
    await h.store.refreshAsks();
    expect(h.cell.getState().status).toBe("ready");
    h.fail.feed = new AskApiError(0, "network", "Robob did not answer.");
    await h.store.refreshAsks();
    expect(h.cell.getState().status).toBe("ready");
    expect(h.cell.getState().feed?.open).toHaveLength(1);
    expect(h.cell.getState().error).toBe("Robob did not answer.");
  });

  it("is read again when a board changes or the app comes back, until nothing watches", async () => {
    const h = harness();
    const stop = h.store.watchAsks(true);
    await settle();
    expect(h.named("feed")).toHaveLength(1);
    for (const run of h.boards) run();
    for (const run of h.foreground) run();
    await vi.advanceTimersByTimeAsync(400);
    expect(h.named("feed")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.named("feed")).toHaveLength(3);
    stop();
    expect(h.boards.size).toBe(0);
    expect(h.foreground.size).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.named("feed")).toHaveLength(3);
  });
});

describe("batches, hand-over and snooze", () => {
  it("a batch gives back the asks the server refused, each for its own reason", async () => {
    const h = harness();
    const asks = [entry(1), entry(2), entry(3)];
    h.setFeed(asks);
    await h.store.refreshAsks();
    h.results.answerBatch = {
      answered: 2,
      results: [
        { card: "robob:1", askId: "q1", ok: true, stage: "ready" },
        {
          card: "robob:2",
          askId: "q1",
          ok: false,
          error: { code: "conflict", message: "It changed.", revision: 1 },
        },
        { card: "robob:3", askId: "q1", ok: true, stage: "ready" },
      ],
    };
    h.store.answerAskBatch(asks, "batch:b1:k", { verdict: "approved" }, "Approved", "3 alike");
    await vi.advanceTimersByTimeAsync(ASK_UNDO_MS);
    const state = h.cell.getState();
    expect(state.marks[askKey(asks[1]!)]).toBe("updated");
    expect(state.hidden[askKey(asks[1]!)]).toBeUndefined();
    expect(state.sent[0]?.state).toBe("sent");
    expect(state.toast?.text).toBe("Approved 2 of 3. 1 changed and was not answered.");
  });

  it("handing over every time sends his words and reports an evaluator that did not start", async () => {
    const h = harness();
    const ask = entry(1);
    h.setFeed([ask]);
    await h.store.refreshAsks();
    h.results.hand = {
      card: {},
      ask: null,
      evaluator: { started: false, threadId: null, error: "board is paused" },
    };
    h.store.handAsks([ask], askKey(ask), "Approve copy fixes yourself.");
    await vi.advanceTimersByTimeAsync(ASK_UNDO_MS);
    expect(h.named("hand")[0]!.args[2]).toEqual({
      action: "hand",
      always: true,
      text: "Approve copy fixes yourself.",
    });
    expect(h.cell.getState().toast?.text).toBe(
      "Handed over, but the evaluator thread did not start: board is paused.",
    );
  });

  it("a snooze can be undone from its toast", async () => {
    const h = harness();
    const ask = entry(1);
    h.setFeed([ask]);
    await h.store.refreshAsks();
    await h.store.snoozeAsks([ask], "2026-11-12T05:00:00.000Z", "tomorrow 09:00");
    expect(h.cell.getState().toast?.text).toBe("Snoozed until tomorrow 09:00 · Robob #1.");
    expect(h.store.undoAskSend()).toBe(askKey(ask));
    await settle();
    expect(h.named("snooze").map((call) => call.args[2])).toEqual([
      "2026-11-12T05:00:00.000Z",
      null,
    ]);
  });

  it("a reply that breaks a limit is refused before it is sent", async () => {
    const h = harness();
    const ask = entry(1);
    await expect(h.store.replyOnAsk(ask, [])).rejects.toThrow("Write something first.");
    expect(h.named("reply")).toHaveLength(0);
  });

  it("an answer that went over the secret channel joins the sent list without the secret", async () => {
    const h = harness();
    const ask = entry(1);
    h.setFeed([ask]);
    await h.store.refreshAsks();
    h.store.noteAskAnswered(ask, { verdict: "answered" }, "Answer sent");
    const state = h.cell.getState();
    expect(state.hidden[askKey(ask)]).toBeDefined();
    expect(state.sent[0]).toMatchObject({ state: "sent", body: { verdict: "answered" } });
    expect(h.named("answer")).toHaveLength(0);
  });
});
