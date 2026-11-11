import {
  ASK_AUTO_RETRY_MAX,
  ASK_UNDO_MS,
  AskApiError,
  askKey,
} from "@t3tools/client-runtime/ardud/kanban";
import type { KanbanAskFeedItem, KanbanAskSecretAnswerInput } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ASK_RECONNECT_GAP_MS, createAskScopes, type AskConnection } from "./askScope";
import { ASK_AUTO_RETRY_GAP_MS, ownerStanding, type SessionRead } from "./logic";

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
function harness(start: { readonly sessionOut?: ReadonlyArray<string> } = {}) {
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
    if (unauthorized.has(server)) {
      const refusal = { error: { code: "unauthorized", message: "Sign in again." } };
      return { ok: false, status: 401, text: async () => JSON.stringify(refusal) };
    }
    const body = path.endsWith("/asks")
      ? { at: "2026-11-11T08:00:00.000Z", open: feeds[server] ?? [], closed: [] }
      : { card: {}, ask: null };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  }) as unknown as typeof fetch;
  const deferred: Array<() => void> = [];
  /** What each server's session says of this phone: the owner's unless a test says otherwise. */
  const owners: Record<string, boolean> = { A: true, B: true };
  /** Servers whose session can't be read right now: no connection, or still on its way. */
  const sessionsOut = new Set<string>(start.sessionOut ?? []);
  /** Servers whose session answers "signed out". */
  const signedOut = new Set<string>();
  /** Servers that no longer take this phone's credential. */
  const unauthorized = new Set<string>();
  const sessionListeners = new Set<() => void>();
  const sessionRereads: Array<string> = [];
  /** How the app's connection to each server stands; live unless a test says otherwise. */
  const connections: Record<string, AskConnection> = {};
  const connectionListeners = new Set<() => void>();
  const reconnects: Array<string> = [];
  const foregroundListeners = new Set<() => void>();
  const session = (environmentId: string): SessionRead =>
    sessionsOut.has(environmentId)
      ? { state: "reading" }
      : signedOut.has(environmentId)
        ? { state: "read", authenticated: false, owner: undefined }
        : { state: "read", authenticated: true, owner: owners[environmentId] === true };
  const connection = (environmentId: string) => connections[environmentId] ?? "live";
  const scopes = createAskScopes({
    paired: () => paired,
    onPairedChange: (run) => {
      pairedListeners.add(run);
      return () => void pairedListeners.delete(run);
    },
    target: (environmentId) => {
      if (connection(environmentId) !== "live") {
        throw new AskApiError(0, "offline", "Not connected to Robob.");
      }
      return {
        base: `https://${environmentId.toLowerCase()}.test`,
        headers: { authorization: `Bearer token-${environmentId}` },
        cookies: false,
      };
    },
    sendSecrets: async (environmentId) => {
      secretSends.push(environmentId);
      return { _tag: "sent" };
    },
    watch: {
      onBoardsChange: () => () => undefined,
      onForeground: (run) => {
        foregroundListeners.add(run);
        return () => void foregroundListeners.delete(run);
      },
      isForeground: () => true,
    },
    session,
    onSessionChange: (_environmentId, run) => {
      sessionListeners.add(run);
      return () => void sessionListeners.delete(run);
    },
    rereadSession: (environmentId) => void sessionRereads.push(environmentId),
    connection,
    onConnectionChange: (_environmentId, run) => {
      connectionListeners.add(run);
      return () => void connectionListeners.delete(run);
    },
    reconnect: (environmentId) => void reconnects.push(environmentId),
    defer: (run) => deferred.push(run),
    now: () => Date.now(),
    fetch: fetchFake,
  });
  return {
    scopes,
    owners,
    /** What the session says of this phone on a server changes (or can no longer be read). */
    setSession: (environmentId: string, owner: boolean | "out" | "signedOut") => {
      sessionsOut.delete(environmentId);
      signedOut.delete(environmentId);
      if (owner === "out") sessionsOut.add(environmentId);
      else if (owner === "signedOut") signedOut.add(environmentId);
      else owners[environmentId] = owner;
      for (const run of Array.from(sessionListeners)) run();
    },
    /** The app's connection to a server changes. */
    setConnection: (environmentId: string, next: AskConnection) => {
      connections[environmentId] = next;
      for (const run of Array.from(connectionListeners)) run();
    },
    /** The standing the answer controls go by, as a screen would compute it. */
    standing: () => {
      const scope = scopes.current();
      const state = scope.cell.getState();
      return ownerStanding(
        session(scope.environmentId ?? ""),
        state.notOwner !== null,
        state.ownerSeen,
      );
    },
    foreground: () => {
      for (const run of Array.from(foregroundListeners)) run();
    },
    sessionRereads,
    reconnects,
    unauthorized,
    feeds,
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

  it("every screen that holds a secret is cleared, the sample page's too", () => {
    const h = harness();
    // An ask with a secret field, and the reference page's sample secret under it.
    const held = { ask: "s3cr3t", sample: "hunter2" };
    h.scopes.holdSecrets(() => {
      held.ask = "";
    });
    h.scopes.holdSecrets(() => {
      held.sample = "";
    });
    h.pair("B");
    expect(held).toEqual({ ask: "", sample: "" });
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

  it("does not go by itself while the phone was never known to be his, and goes once it is", async () => {
    // The session has not been read since the app started: never confirmed.
    const h = harness({ sessionOut: ["A"] });
    const scope = h.scopes.current();
    await scope.asks.refreshAsks();
    expect(h.standing()).toBe("checking");
    const ask = scope.cell.getState().feed!.open[0]!;
    h.writesDown.add("A");
    scope.asks.answerAsk(ask, "primary");
    await vi.advanceTimersByTimeAsync(ASK_UNDO_MS);
    h.writesDown.delete("A");
    expect(h.answers("A")).toHaveLength(1);

    for (let n = 0; n < 3; n += 1) {
      await aWhile();
      await read(h);
    }
    expect(h.answers("A")).toHaveLength(1);
    // The answer is still there, with every try left and Retry by hand for when he is known.
    expect(scope.cell.getState().failed[askKey(ask)]?.unreached).toBe(true);
    expect(scope.cell.getState().failed[askKey(ask)]?.send.autoRetries).toBeUndefined();

    h.setSession("A", true);
    expect(h.standing()).toBe("owner");
    await aWhile();
    await read(h);
    expect(h.answers("A")).toHaveLength(2);
    expect(scope.cell.getState().failed).toEqual({});
  });

  it("does not go by itself once the server has refused this phone as not the owner's", async () => {
    const h = harness();
    const scope = h.scopes.current();
    await scope.asks.refreshAsks();
    const ask = scope.cell.getState().feed!.open[0]!;
    h.writesDown.add("A");
    scope.asks.answerAsk(ask, "primary");
    await vi.advanceTimersByTimeAsync(ASK_UNDO_MS);
    h.writesDown.delete("A");

    // A refusal met since (a reply, a snooze): the session said owner, the server says not.
    scope.asks.noteAskNotOwner("This device is not paired as the owner's.", true);
    for (let n = 0; n < 3; n += 1) {
      await aWhile();
      await read(h);
    }
    expect(h.answers("A")).toHaveLength(1);
    expect(scope.cell.getState().failed[askKey(ask)]?.unreached).toBe(true);
  });

  it("an answer whose ask moved is not sent again by itself: it comes back as updated", async () => {
    const h = harness();
    const scope = h.scopes.current();
    await scope.asks.refreshAsks();
    const ask = scope.cell.getState().feed!.open[0]!;
    h.writesDown.add("A");
    scope.asks.answerAsk(ask, "primary");
    await vi.advanceTimersByTimeAsync(ASK_UNDO_MS);
    h.writesDown.delete("A");
    expect(h.answers("A")).toHaveLength(1);

    // The ask was edited while the answer sat unsent.
    h.feeds.A = [{ ...entry(1), revision: 1 } as KanbanAskFeedItem];
    for (let n = 0; n < 3; n += 1) {
      await aWhile();
      await read(h);
    }
    expect(h.answers("A")).toHaveLength(1);
    expect(scope.cell.getState().failed).toEqual({});
    expect(scope.cell.getState().marks[askKey(ask)]).toBe("updated");
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

describe("a phone the session confirmed as his, when the connection goes", () => {
  /** What the scope decided on the last change of the store. */
  const decide = async (h: ReturnType<typeof harness>) => {
    h.runDeferred();
    await settle();
  };

  it("can still answer: the answer waits as Not sent and goes exactly once when the connection is back", async () => {
    const h = harness();
    const scope = h.scopes.current();
    await scope.asks.refreshAsks();
    const ask = scope.cell.getState().feed!.open[0]!;
    expect(h.standing()).toBe("owner");

    // The server stops: no connection, and the session can't be read any more.
    h.setConnection("A", "down");
    h.setSession("A", "out");
    expect(h.standing()).toBe("owner");
    await scope.asks.refreshAsks();
    expect(scope.cell.getState().error).toBe("Not connected to Robob.");

    // He answers. Nothing can leave the phone: it is kept as "Not sent".
    const before = h.requests.length;
    scope.asks.answerAsk(ask, "primary");
    await vi.advanceTimersByTimeAsync(ASK_UNDO_MS);
    await decide(h);
    expect(h.requests).toHaveLength(before);
    expect(scope.cell.getState().failed[askKey(ask)]?.unreached).toBe(true);
    expect(scope.cell.getState().toast?.text).toContain("Not sent");

    // Reads keep failing while it is down, and nothing goes.
    for (let n = 0; n < 3; n += 1) {
      await aWhile();
      await scope.asks.refreshAsks();
      await decide(h);
    }
    expect(h.answers("A")).toHaveLength(0);

    // The connection is back. The scope reads the feed by itself, and the answer goes
    // on that read: the session is still on its way, and he was confirmed before.
    h.setConnection("A", "live");
    await settle();
    expect(scope.cell.getState().error).toBeNull();
    await decide(h);
    expect(h.answers("A")).toHaveLength(1);
    expect(scope.cell.getState().failed).toEqual({});

    // The session reads again and more reads follow: it was sent once, and only once.
    h.setSession("A", true);
    for (let n = 0; n < 3; n += 1) {
      await aWhile();
      await scope.asks.refreshAsks();
      await decide(h);
    }
    expect(h.answers("A")).toHaveLength(1);
    expect(h.standing()).toBe("owner");
  });

  it("a refusal from the server ends it, and the session coming back unread does not restore it", async () => {
    const h = harness();
    const scope = h.scopes.current();
    await scope.asks.refreshAsks();
    h.setConnection("A", "down");
    h.setSession("A", "out");
    expect(h.standing()).toBe("owner");

    scope.asks.noteAskNotOwner("This device is not paired as the owner's.", true);
    expect(h.standing()).toBe("notOwner");
    expect(scope.cell.getState().ownerSeen).toBe(false);

    // A session that says owner again, read after the refusal, is what brings it back.
    h.setConnection("A", "live");
    expect(h.standing()).toBe("notOwner");
    h.setSession("A", true);
    expect(h.standing()).toBe("owner");
  });

  it("a session that comes back as not his, or signed out, ends it", async () => {
    const h = harness();
    const scope = h.scopes.current();
    await scope.asks.refreshAsks();
    h.setSession("A", "out");
    expect(h.standing()).toBe("owner");
    h.setSession("A", false);
    expect(h.standing()).toBe("notOwner");

    h.setSession("A", true);
    expect(h.standing()).toBe("owner");
    h.setSession("A", "signedOut");
    expect(h.standing()).toBe("unchecked");
    // Signed out and then unreadable: no longer confirmed, so it does not come back as his.
    h.setSession("A", "out");
    expect(h.standing()).toBe("checking");
    expect(scope.cell.getState().ownerSeen).toBe(false);
  });

  it("is confirmed per server: the next server starts unconfirmed", async () => {
    const h = harness({ sessionOut: ["B"] });
    await h.scopes.current().asks.refreshAsks();
    expect(h.standing()).toBe("owner");
    h.pair("B");
    expect(h.standing()).toBe("checking");
  });
});

describe("when the connection comes back", () => {
  it("the feed is read at once, not at the next poll", async () => {
    const h = harness();
    const scope = h.scopes.current();
    await scope.asks.refreshAsks();
    h.setConnection("A", "down");
    await scope.asks.refreshAsks();
    const reads = h.requests.length;
    h.setConnection("A", "live");
    await settle();
    expect(h.requests).toHaveLength(reads + 1);
    expect(scope.cell.getState().error).toBeNull();
    // Signalled again while live: nothing more is read.
    h.setConnection("A", "live");
    await settle();
    expect(h.requests).toHaveLength(reads + 1);
  });

  it("nothing is read for a store no screen has started", async () => {
    const h = harness();
    h.setConnection("A", "down");
    h.setConnection("A", "live");
    await settle();
    expect(h.requests).toHaveLength(0);
  });

  it("the session is read again when the app comes to the front, on the server in use", async () => {
    const h = harness();
    h.foreground();
    expect(h.sessionRereads).toEqual(["A"]);
    h.pair("B");
    h.foreground();
    expect(h.sessionRereads).toEqual(["A", "B"]);
    h.pair(null);
    h.foreground();
    expect(h.sessionRereads).toEqual(["A", "B"]);
  });
});

describe("while the connection layer waits to try again", () => {
  it("the feed is asked for where it was last read, and a good read tells the layer to try now", async () => {
    const h = harness();
    const scope = h.scopes.current();
    await scope.asks.refreshAsks();
    expect(h.reconnects).toEqual([]);

    // The server is down and the app is between two attempts.
    h.setConnection("A", "waiting");
    h.readsDown.add("A");
    const before = h.requests.length;
    await scope.asks.refreshAsks();
    expect(h.requests).toHaveLength(before + 1);
    expect(h.requests.at(-1)?.server).toBe("A");
    expect(scope.cell.getState().error).toBe("Robob did not answer.");
    expect(h.reconnects).toEqual([]);

    // The server is back before the next attempt: the read finds it.
    h.readsDown.delete("A");
    await scope.asks.refreshAsks();
    expect(scope.cell.getState().error).toBeNull();
    expect(h.reconnects).toEqual(["A"]);

    // The attempt has not landed yet: it is not asked for again on every read.
    await scope.asks.refreshAsks();
    expect(h.reconnects).toEqual(["A"]);
    await vi.advanceTimersByTimeAsync(ASK_RECONNECT_GAP_MS);
    await scope.asks.refreshAsks();
    expect(h.reconnects).toEqual(["A", "A"]);

    // Live again: reads tell the layer nothing.
    h.setConnection("A", "live");
    await settle();
    await vi.advanceTimersByTimeAsync(ASK_RECONNECT_GAP_MS);
    await scope.asks.refreshAsks();
    expect(h.reconnects).toEqual(["A", "A"]);
  });

  it("an answer goes to that server too", async () => {
    const h = harness();
    const scope = h.scopes.current();
    await scope.asks.refreshAsks();
    const ask = scope.cell.getState().feed!.open[0]!;
    h.setConnection("A", "waiting");
    scope.asks.answerAsk(ask, "primary");
    await vi.advanceTimersByTimeAsync(ASK_UNDO_MS);
    expect(h.answers("A")).toHaveLength(1);
    expect(h.answers("B")).toHaveLength(0);
    expect(scope.cell.getState().failed).toEqual({});
  });

  it("nothing is asked for when the connection is off, refused or the phone is offline", async () => {
    const h = harness();
    const scope = h.scopes.current();
    await scope.asks.refreshAsks();
    h.setConnection("A", "down");
    const before = h.requests.length;
    await scope.asks.refreshAsks();
    expect(h.requests).toHaveLength(before);
    expect(scope.cell.getState().error).toBe("Not connected to Robob.");
    expect(h.reconnects).toEqual([]);
  });

  it("a server never reached over a live connection is not called", async () => {
    const h = harness();
    h.setConnection("A", "waiting");
    const scope = h.scopes.current();
    await scope.asks.refreshAsks();
    expect(h.requests).toHaveLength(0);
    expect(scope.cell.getState().status).toBe("error");
  });

  it("a credential the server no longer takes is not used again", async () => {
    const h = harness();
    const scope = h.scopes.current();
    await scope.asks.refreshAsks();
    h.setConnection("A", "waiting");
    h.unauthorized.add("A");
    const before = h.requests.length;
    await scope.asks.refreshAsks();
    expect(h.requests).toHaveLength(before + 1);
    await scope.asks.refreshAsks();
    expect(h.requests).toHaveLength(before + 1);
    expect(scope.cell.getState().error).toBe("Not connected to Robob.");
    expect(h.reconnects).toEqual([]);
  });

  it("the address of one server is never used for another", async () => {
    const h = harness();
    await h.scopes.current().asks.refreshAsks();
    h.pair("B");
    h.setConnection("B", "waiting");
    const before = h.requests.length;
    await h.scopes.current().asks.refreshAsks();
    expect(h.requests).toHaveLength(before);
  });
});
