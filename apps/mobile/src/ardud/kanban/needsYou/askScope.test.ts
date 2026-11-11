import { ASK_AUTO_RETRY_MAX, ASK_UNDO_MS, askKey } from "@t3tools/client-runtime/ardud/kanban";
import type { KanbanAskFeedItem, KanbanAskSecretAnswerInput } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createAskScopes } from "./askScope";
import { ASK_AUTO_RETRY_GAP_MS } from "./logic";

const entry = (number: number): KanbanAskFeedItem =>
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
    },
    kind: "approval",
    revision: 0,
    waitsOn: "owner",
    expired: false,
    messages: [],
  }) as unknown as KanbanAskFeedItem;

const SECRET_INPUT = {
  cardId: "c1",
  askId: "q1",
  answer: { verdict: "answered" },
  secrets: { token: "s3cr3t" },
} as unknown as KanbanAskSecretAnswerInput;

/**
 * Two servers, A and B, each with the same card and ask ids (the case that
 * would answer the wrong ask), and a phone that can be moved between them.
 */
function harness() {
  let paired: string | null = "A";
  const pairedListeners = new Set<() => void>();
  const requests: Array<{
    readonly server: string;
    readonly method: string;
    readonly path: string;
  }> = [];
  const secretSends: Array<string> = [];
  /** Servers whose reads fail, and servers that drop writes, as a dead network would. */
  const readsDown = new Set<string>();
  const writesDown = new Set<string>();
  /** Writes that have left the phone and not come back yet: they wait here until let go. */
  let writesHeld = false;
  const heldWrites: Array<() => void> = [];
  const feeds: Record<string, ReadonlyArray<KanbanAskFeedItem>> = {
    A: [entry(1)],
    B: [entry(1)],
  };
  const fetchFake = (async (url: string, init?: { readonly method?: string }) => {
    const match = /^https:\/\/([a-z]+)\.test(\/.*)$/i.exec(String(url));
    const server = (match?.[1] ?? "?").toUpperCase();
    const path = match?.[2] ?? "";
    const method = init?.method ?? "GET";
    requests.push({ server, method, path });
    if (method !== "GET" && writesHeld) await new Promise<void>((go) => heldWrites.push(go));
    if ((method === "GET" ? readsDown : writesDown).has(server)) throw new TypeError("offline");
    const body = path.endsWith("/asks")
      ? { at: "2026-11-11T08:00:00.000Z", open: feeds[server] ?? [], closed: [] }
      : { card: {}, ask: null };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  }) as unknown as typeof fetch;
  const deferred: Array<() => void> = [];
  const scopes = createAskScopes({
    paired: () => paired,
    onPairedChange: (run) => {
      pairedListeners.add(run);
      return () => void pairedListeners.delete(run);
    },
    target: (environmentId) => ({
      base: `https://${environmentId.toLowerCase()}.test`,
      headers: { authorization: `Bearer token-${environmentId}` },
      cookies: false,
    }),
    sendSecrets: async (environmentId) => {
      secretSends.push(environmentId);
      return { _tag: "sent" };
    },
    watch: {
      onBoardsChange: () => () => undefined,
      onForeground: () => () => undefined,
      isForeground: () => true,
    },
    defer: (run) => deferred.push(run),
    now: () => Date.now(),
    fetch: fetchFake,
  });
  return {
    scopes,
    requests,
    secretSends,
    readsDown,
    writesDown,
    /** From now on a write stays on its way until `landWrites`. */
    holdWrites: () => {
      writesHeld = true;
    },
    /** The writes on their way come back now, failed or not as the server is at this moment. */
    landWrites: () => {
      writesHeld = false;
      for (const go of heldWrites.splice(0)) go();
    },
    pair: (next: string | null) => {
      paired = next;
      for (const run of Array.from(pairedListeners)) run();
    },
    /** Runs what the scope put off until the store update settled. */
    runDeferred: () => {
      for (const run of deferred.splice(0)) run();
    },
    answers: (server?: string) =>
      requests.filter(
        (request) =>
          request.method === "POST" && (server === undefined || request.server === server),
      ),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const settle = () => vi.advanceTimersByTimeAsync(0);
/** Long enough after a failure that a good read means the server is back. */
const aWhile = () => vi.advanceTimersByTimeAsync(ASK_AUTO_RETRY_GAP_MS);

describe("a held answer when the server changes", () => {
  it("is dropped: it goes to neither the new server nor the old one", async () => {
    const h = harness();
    const a = h.scopes.current();
    await a.asks.refreshAsks();
    const ask = a.cell.getState().feed!.open[0]!;
    a.asks.answerAsk(ask, "primary");
    expect(a.cell.getState().held).not.toBeNull();

    // The first connection is disabled and another takes its place.
    h.pair("B");
    const b = h.scopes.current();
    expect(b).not.toBe(a);
    expect(b.environmentId).toBe("B");
    expect(b.serial).not.toBe(a.serial);
    expect(a.live()).toBe(false);

    await b.asks.refreshAsks();
    await vi.advanceTimersByTimeAsync(ASK_UNDO_MS * 3);
    a.asks.flushAskSends(true);
    b.asks.flushAskSends(true);
    await settle();
    expect(h.answers()).toEqual([]);
    // The new server's ask with the same card and ask id is untouched.
    expect(b.cell.getState().hidden).toEqual({});
    expect(b.cell.getState().sent).toEqual([]);
    expect(a.cell.getState().held).toBeNull();
    expect(a.cell.getState().feed).toBeNull();
  });
});

describe("an answer made offline when the server changes", () => {
  it("is never retried on the new server, by itself or by hand", async () => {
    const h = harness();
    const a = h.scopes.current();
    await a.asks.refreshAsks();
    const ask = a.cell.getState().feed!.open[0]!;
    h.writesDown.add("A");
    a.asks.answerAsk(ask, "primary");
    await vi.advanceTimersByTimeAsync(ASK_UNDO_MS);
    expect(a.cell.getState().failed[askKey(ask)]?.unreached).toBe(true);
    expect(h.answers("A")).toHaveLength(1);

    h.pair("B");
    const b = h.scopes.current();
    // The new server reads fine a while later, which is the signal that sends it again.
    await aWhile();
    await b.asks.refreshAsks();
    await aWhile();
    await b.asks.refreshAsks();
    h.runDeferred();
    a.asks.retryUnreachedAskSends();
    a.asks.retryAskSend(askKey(ask));
    b.asks.retryUnreachedAskSends();
    b.asks.retryAskSend(askKey(ask));
    await settle();

    expect(h.answers("B")).toEqual([]);
    expect(h.answers("A")).toHaveLength(1);
    expect(b.cell.getState().failed).toEqual({});
  });

  it("is dropped when the server goes away and comes back", async () => {
    const h = harness();
    const a = h.scopes.current();
    await a.asks.refreshAsks();
    const ask = a.cell.getState().feed!.open[0]!;
    h.writesDown.add("A");
    a.asks.answerAsk(ask, "primary");
    await vi.advanceTimersByTimeAsync(ASK_UNDO_MS);

    h.pair(null);
    expect(h.scopes.current().environmentId).toBeNull();
    h.writesDown.delete("A");
    h.pair("A");
    const again = h.scopes.current();
    expect(again).not.toBe(a);
    await aWhile();
    await again.asks.refreshAsks();
    await aWhile();
    await again.asks.refreshAsks();
    h.runDeferred();
    await settle();
    expect(again.cell.getState().failed).toEqual({});
    expect(h.answers("A")).toHaveLength(1);
  });
});

describe("what a screen still holds after the server changed", () => {
  it("sends nothing: the old store and its calls are closed", async () => {
    const h = harness();
    const a = h.scopes.current();
    await a.asks.refreshAsks();
    const ask = a.cell.getState().feed!.open[0]!;
    h.pair("B");
    const before = h.requests.length;

    // A handler that rendered with the old server's store fires late.
    a.asks.patchAskForm(ask, { note: "typed late" });
    a.asks.answerAsk(ask, "primary");
    a.asks.handAsks([ask], askKey(ask));
    await a.asks.snoozeAsks([ask], "2026-11-12T05:00:00.000Z", "tomorrow 09:00");
    await expect(a.asks.replyOnAsk(ask, [{ _tag: "md", text: "hello" }])).rejects.toThrow();
    await expect(a.api.feed()).rejects.toThrow("Not connected to Robob.");
    await expect(a.api.answer(ask.cardRef, ask.ask.id, { verdict: "approved" }, 0)).rejects.toThrow(
      "Not connected to Robob.",
    );
    await vi.advanceTimersByTimeAsync(ASK_UNDO_MS * 3);

    expect(h.requests.length).toBe(before);
    expect(a.cell.getState().forms).toEqual({});
  });

  it("a secret goes to the server it was typed for, or nowhere", async () => {
    const h = harness();
    const a = h.scopes.current();
    expect((await a.api.answerSecrets(SECRET_INPUT, 0))._tag).toBe("sent");
    expect(h.secretSends).toEqual(["A"]);

    h.pair("B");
    const late = await a.api.answerSecrets(SECRET_INPUT, 0);
    expect(late._tag).toBe("refused");
    expect(h.secretSends).toEqual(["A"]);

    // The new server's own scope reaches the new server only.
    expect((await h.scopes.current().api.answerSecrets(SECRET_INPUT, 0))._tag).toBe("sent");
    expect(h.secretSends).toEqual(["A", "B"]);
  });

  it("secrets on screen are cleared first, before the store is emptied", async () => {
    const h = harness();
    const a = h.scopes.current();
    await a.asks.refreshAsks();
    const ask = a.cell.getState().feed!.open[0]!;
    a.asks.patchAskForm(ask, { note: "kept until the secrets are gone" });
    const order: Array<string> = [];
    const release = h.scopes.holdSecrets(() => {
      order.push(`secrets dropped, forms ${Object.keys(a.cell.getState().forms).length}`);
    });
    h.scopes.subscribe(() => {
      order.push(`new scope, old forms ${Object.keys(a.cell.getState().forms).length}`);
    });

    h.pair("B");
    expect(order).toEqual(["secrets dropped, forms 1", "new scope, old forms 0"]);

    // A screen that is gone is no longer asked.
    release();
    h.pair("A");
    expect(order).toHaveLength(3);
  });

  it("the same server signalled again changes nothing", async () => {
    const h = harness();
    const a = h.scopes.current();
    await a.asks.refreshAsks();
    h.pair("A");
    h.scopes.sync();
    expect(h.scopes.current()).toBe(a);
    expect(a.live()).toBe(true);
    expect(a.cell.getState().feed?.open).toHaveLength(1);
  });
});

describe("an answer that never reached the server", () => {
  /** A good read of the feed, and what the scope decided on it. */
  const read = async (h: ReturnType<typeof harness>) => {
    await h.scopes.current().asks.refreshAsks();
    h.runDeferred();
    await settle();
  };

  it("stops going by itself after a few tries, however often the feed comes back", async () => {
    const h = harness();
    const scope = h.scopes.current();
    await scope.asks.refreshAsks();
    const ask = scope.cell.getState().feed!.open[0]!;
    // Reads come and go; writes never get through.
    h.writesDown.add("A");
    scope.asks.answerAsk(ask, "primary");
    await vi.advanceTimersByTimeAsync(ASK_UNDO_MS);
    expect(h.answers("A")).toHaveLength(1);

    const flap = async () => {
      h.readsDown.add("A");
      await scope.asks.refreshAsks();
      await aWhile();
      h.readsDown.delete("A");
      await read(h);
    };
    for (let round = 1; round <= ASK_AUTO_RETRY_MAX + 4; round += 1) {
      await flap();
      expect(h.answers("A")).toHaveLength(1 + Math.min(round, ASK_AUTO_RETRY_MAX));
    }
    const failed = scope.cell.getState().failed[askKey(ask)];
    expect(failed?.unreached).toBe(true);
    expect(failed?.send.autoRetries).toBe(ASK_AUTO_RETRY_MAX);

    // By hand it still goes, and once it gets through nothing is left to retry.
    h.writesDown.delete("A");
    scope.asks.retryAskSend(askKey(ask));
    await settle();
    expect(h.answers("A")).toHaveLength(2 + ASK_AUTO_RETRY_MAX);
    expect(scope.cell.getState().failed).toEqual({});
    await flap();
    expect(h.answers("A")).toHaveLength(2 + ASK_AUTO_RETRY_MAX);
  });

  it("does not go again on the reads that follow the failure at once", async () => {
    const h = harness();
    const scope = h.scopes.current();
    await scope.asks.refreshAsks();
    const ask = scope.cell.getState().feed!.open[0]!;
    h.writesDown.add("A");
    scope.asks.answerAsk(ask, "primary");
    await vi.advanceTimersByTimeAsync(ASK_UNDO_MS);
    // The store reads the feed itself right after a failure, and so may a screen.
    for (let n = 0; n < 6; n += 1) await read(h);
    await vi.advanceTimersByTimeAsync(ASK_AUTO_RETRY_GAP_MS - 1_000);
    await read(h);
    expect(h.answers("A")).toHaveLength(1);
    expect(scope.cell.getState().failed[askKey(ask)]?.send.autoRetries ?? 0).toBe(0);
  });

  it("goes again when the feed had already come back while it was on its way", async () => {
    const h = harness();
    const scope = h.scopes.current();
    await scope.asks.refreshAsks();
    const ask = scope.cell.getState().feed!.open[0]!;

    // The feed fails, the answer leaves, and the feed reads fine before the answer is back.
    h.readsDown.add("A");
    await scope.asks.refreshAsks();
    h.holdWrites();
    h.writesDown.add("A");
    scope.asks.answerAsk(ask, "primary");
    await vi.advanceTimersByTimeAsync(ASK_UNDO_MS);
    expect(h.answers("A")).toHaveLength(1);
    h.readsDown.delete("A");
    await read(h);
    expect(scope.cell.getState().failed).toEqual({});

    // Now the answer fails: the feed's recovery is already behind it.
    h.landWrites();
    await settle();
    await read(h);
    expect(scope.cell.getState().failed[askKey(ask)]?.unreached).toBe(true);
    expect(h.answers("A")).toHaveLength(1);

    // A later good read, with nothing failing in between, sends it once more.
    h.writesDown.delete("A");
    await aWhile();
    await read(h);
    expect(h.answers("A")).toHaveLength(2);
    expect(scope.cell.getState().failed).toEqual({});
    await aWhile();
    await read(h);
    expect(h.answers("A")).toHaveLength(2);
  });

  it("goes again after an outage that hit the answer alone", async () => {
    const h = harness();
    const scope = h.scopes.current();
    await scope.asks.refreshAsks();
    const ask = scope.cell.getState().feed!.open[0]!;

    // The feed never fails; only the answer is lost.
    h.writesDown.add("A");
    scope.asks.answerAsk(ask, "primary");
    await vi.advanceTimersByTimeAsync(ASK_UNDO_MS);
    h.writesDown.delete("A");
    await read(h);
    expect(h.answers("A")).toHaveLength(1);
    expect(scope.cell.getState().failed[askKey(ask)]?.unreached).toBe(true);

    await aWhile();
    await read(h);
    expect(h.answers("A")).toHaveLength(2);
    expect(scope.cell.getState().failed).toEqual({});
  });

  it("waits for a good read: a failed one sends nothing", async () => {
    const h = harness();
    const scope = h.scopes.current();
    await scope.asks.refreshAsks();
    const ask = scope.cell.getState().feed!.open[0]!;
    h.writesDown.add("A");
    scope.asks.answerAsk(ask, "primary");
    await vi.advanceTimersByTimeAsync(ASK_UNDO_MS);
    h.readsDown.add("A");
    for (let n = 0; n < 3; n += 1) {
      await aWhile();
      await read(h);
    }
    expect(h.answers("A")).toHaveLength(1);
  });
});
