import {
  KANBAN_UNKNOWN_BLOCK_TEXT,
  KanbanMessage,
  type KanbanAskSecretAnswerInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ASK_UNREADABLE_TEXT,
  AskApiError,
  askRouteUrl,
  createAskApi,
  type AskApiHost,
  type AskSecretSendResult,
} from "./askApi.ts";

interface Sent {
  readonly url: string;
  readonly init: RequestInit;
}

function harness(
  respond: (sent: Sent) => Response | Promise<Response>,
  secrets: (input: KanbanAskSecretAnswerInput) => AskSecretSendResult = () => ({ _tag: "sent" }),
  target: AskApiHost["target"] = () => ({
    base: "https://robob.example/",
    headers: { authorization: "Bearer t" },
    cookies: false,
  }),
) {
  const sent: Array<Sent> = [];
  const secretInputs: Array<KanbanAskSecretAnswerInput> = [];
  const api = createAskApi({
    target,
    fetch: (async (url: unknown, init?: RequestInit) => {
      const entry = { url: String(url), init: init ?? {} };
      sent.push(entry);
      return respond(entry);
    }) as typeof fetch,
    answerSecrets: async (input) => {
      secretInputs.push(input);
      return secrets(input);
    },
  });
  return { api, sent, secretInputs };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("askRouteUrl", () => {
  it("puts the route on the server's origin, whatever path the base carries", () => {
    expect(askRouteUrl("https://robob.example/", "/asks")).toBe(
      "https://robob.example/api/ardud/kanban/asks",
    );
    expect(askRouteUrl("http://127.0.0.1:3773", "/asks")).toBe(
      "http://127.0.0.1:3773/api/ardud/kanban/asks",
    );
    expect(askRouteUrl("https://robob.example/some/path/?x=1", "/asks")).toBe(
      "https://robob.example/api/ardud/kanban/asks",
    );
  });
});

describe("createAskApi", () => {
  it("reads the feed with the connection's own proof and no cookies", async () => {
    const { api, sent } = harness(() => json(200, { at: "now", open: [], closed: [] }));
    await api.feed({ closed: "7d" });
    expect(sent[0]!.url).toBe("https://robob.example/api/ardud/kanban/asks?closed=7d");
    expect(sent[0]!.init.method).toBe("GET");
    expect(sent[0]!.init.credentials).toBe("omit");
    expect(sent[0]!.init.headers).toEqual({ authorization: "Bearer t" });
  });

  it("uses cookies when the session rides in one", async () => {
    const { api, sent } = harness(
      () => json(200, { at: "now", open: [], closed: [] }),
      undefined,
      () => ({ base: "https://robob.example/", headers: {}, cookies: true }),
    );
    await api.feed();
    expect(sent[0]!.init.credentials).toBe("include");
  });

  it("sends an answer with the revision he read, and encodes the card ref", async () => {
    const { api, sent } = harness(() => json(200, { card: {}, ask: null }));
    await api.answer("robob:12", "q 1", { verdict: "approved", note: "ok" }, 3);
    expect(sent[0]!.url).toBe(
      "https://robob.example/api/ardud/kanban/cards/robob%3A12/asks/q%201/answer",
    );
    expect(JSON.parse(String(sent[0]!.init.body))).toEqual({
      verdict: "approved",
      note: "ok",
      revision: 3,
    });
  });

  it("a batch hand-over or snooze sends refs only; a batch answer sends revisions", async () => {
    const { api, sent } = harness(() => json(200, { results: [] }));
    const items = [{ card: "robob:1", askId: "q1", revision: 2 }];
    await api.handBatch(items, { always: true, text: "words" });
    await api.snoozeBatch(items, null);
    await api.answerBatch({ verdict: "approved" }, items);
    expect(JSON.parse(String(sent[0]!.init.body))).toEqual({
      always: true,
      text: "words",
      items: [{ card: "robob:1", askId: "q1" }],
    });
    expect(JSON.parse(String(sent[1]!.init.body))).toEqual({
      until: null,
      items: [{ card: "robob:1", askId: "q1" }],
    });
    expect(JSON.parse(String(sent[2]!.init.body))).toEqual({ verdict: "approved", items });
  });

  it("a refusal that carries the ask's revision is stale", async () => {
    const { api } = harness(() =>
      json(409, { error: { code: "conflict", message: "The ask changed.", revision: 4 } }),
    );
    const error = await api.answer("robob:1", "q1", { verdict: "approved" }, 3).catch((e) => e);
    expect(error).toBeInstanceOf(AskApiError);
    expect(error.stale).toBe(true);
    expect(error.revision).toBe(4);
    expect(error.denied).toBe(false);
    expect(error.message).toBe("The ask changed.");
  });

  it("a device that is not paired as the owner's is denied, with the reason", async () => {
    const { api } = harness(() =>
      json(403, {
        error: { code: "denied", message: "This device isn't yours.", reason: "not_owner_device" },
      }),
    );
    const error = await api.snooze("robob:1", "q1", null).catch((e) => e);
    expect(error.denied).toBe(true);
    expect(error.notOwnerDevice).toBe(true);
    expect(error.stale).toBe(false);
    expect(error.unreached).toBe(false);
  });

  it("words alone on an approval come back as the server's own 400", async () => {
    const { api } = harness(() =>
      json(400, { error: { code: "invalid", message: "Words alone do not answer this ask." } }),
    );
    const error = await api.answer("robob:1", "q1", { verdict: "answered" }, 0).catch((e) => e);
    expect(error.status).toBe(400);
    expect(error.code).toBe("invalid");
    expect(error.message).toBe("Words alone do not answer this ask.");
  });

  it("no answer at all is unreached, not a refusal", async () => {
    const { api } = harness(() => {
      throw new TypeError("Network request failed");
    });
    const error = await api.feed().catch((e) => e);
    expect(error).toBeInstanceOf(AskApiError);
    expect(error.unreached).toBe(true);
    expect(error.code).toBe("network");
  });

  it("no connection is unreached too, and nothing is fetched", async () => {
    const { api, sent } = harness(
      () => json(200, {}),
      undefined,
      () => {
        throw new AskApiError(0, "offline", "Not connected to Robob.");
      },
    );
    const error = await api.feed().catch((e) => e);
    expect(error.code).toBe("offline");
    expect(error.unreached).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it("an aborted read is passed through as the abort it was", async () => {
    const abort = Object.assign(new Error("Aborted"), { name: "AbortError" });
    const { api } = harness(() => {
      throw abort;
    });
    await expect(api.feed()).rejects.toBe(abort);
  });

  it("a page where data should be is a failure, even with 200", async () => {
    const { api } = harness(() => new Response("<!doctype html><html></html>", { status: 200 }));
    const error = await api.feed().catch((e) => e);
    expect(error).toBeInstanceOf(AskApiError);
    expect(error.message).toBe("Robob sent something that is not an answer.");
  });

  it("a secret answer goes over the secret call only, with the revision", async () => {
    const { api, sent, secretInputs } = harness(() => json(200, {}));
    const outcome = await api.answerSecrets(
      { cardId: "c1", askId: "q1", answer: { verdict: "answered" }, secrets: { token: "s3cret" } },
      2,
    );
    expect(outcome).toEqual({ _tag: "sent" });
    expect(sent).toHaveLength(0);
    expect(secretInputs[0]).toEqual({
      cardId: "c1",
      askId: "q1",
      answer: { verdict: "answered", revision: 2 },
      secrets: { token: "s3cret" },
    });
  });

  it("a refused secret answer is put in words that never hold the value", async () => {
    const { api } = harness(
      () => json(200, {}),
      () => ({
        _tag: "failed",
        failure: { _tag: "KanbanError", code: "denied", reason: "not_owner_device", detail: "" },
      }),
    );
    const outcome = await api.answerSecrets(
      { cardId: "c1", askId: "q1", answer: { verdict: "answered" }, secrets: { token: "s3cret" } },
      0,
    );
    expect(outcome._tag).toBe("refused");
    if (outcome._tag !== "refused") return;
    expect(outcome.failure.notOwner).toEqual({ device: true });
    expect(JSON.stringify(outcome)).not.toContain("s3cret");
  });

  it("offline, a secret answer is refused in plain words and can be typed again", async () => {
    const { api } = harness(
      () => json(200, {}),
      () => ({ _tag: "offline" }),
    );
    const outcome = await api.answerSecrets(
      { cardId: "c1", askId: "q1", answer: { verdict: "answered" }, secrets: { token: "s3cret" } },
      0,
    );
    expect(outcome).toEqual({
      _tag: "refused",
      failure: { message: "Not connected to Robob.", stale: false, field: null },
    });
  });
});

// What the routes send, as plain JSON: the shapes the server's own values have.
const wireMessage = (blocks: ReadonlyArray<unknown>, seq = 1) => ({
  discussionId: "d1",
  seq,
  author: { _tag: "thread", threadId: "t1" },
  authorName: "Worker",
  blocks,
  answers: [],
  createdAt: "2026-11-11T08:00:00.000Z",
  askId: "q1",
});
const wireAsk = (blocks: ReadonlyArray<unknown>, extra: Record<string, unknown> = {}) => ({
  id: "q1",
  text: "Ship it?",
  blocking: true,
  by: { _tag: "thread", threadId: "t1" },
  at: "2026-11-11T08:00:00.000Z",
  seq: 1,
  closedAt: null,
  kind: "approval",
  respond: { verdict: {} },
  blocks,
  ...extra,
});
const wireItem = (
  number: number,
  blocks: ReadonlyArray<unknown> = [],
  extra: Record<string, unknown> = {},
) => ({
  boardId: "b1",
  boardSlug: "robob",
  boardName: "Robob",
  cardId: `c${number}`,
  cardNumber: number,
  cardRef: `robob:${number}`,
  cardTitle: `Card ${number}`,
  stage: "needs_owner",
  priority: 3,
  discussionId: "d1",
  blocks: 0,
  ask: wireAsk(blocks),
  kind: "approval",
  revision: 0,
  waitsOn: "owner",
  expired: false,
  messages: [wireMessage(blocks)],
  ...extra,
});
const wireFeed = (open: ReadonlyArray<unknown>, at = "2026-11-11T08:00:00.000Z") => ({
  at,
  open,
  closed: [],
});
/** A block of a kind only a newer server knows, with a payload this build must not keep. */
const FROM_LATER = { _tag: "map", zoom: 12, pins: [{ lat: 25.2, lng: 55.3, note: "private" }] };
const STAND_IN = { _tag: "md", text: KANBAN_UNKNOWN_BLOCK_TEXT };

describe("what the server sent is read through the apps' read schemas", () => {
  it("a block of an unknown kind in the feed becomes the one-line stand-in, its payload dropped", async () => {
    const { api } = harness(() =>
      json(200, wireFeed([wireItem(1, [{ _tag: "md", text: "Look" }, FROM_LATER])])),
    );
    const feed = await api.feed();
    const entry = feed.open[0]!;
    expect(entry.ask.blocks).toEqual([{ _tag: "md", text: "Look" }, STAND_IN]);
    expect(entry.messages[0]!.blocks).toEqual([{ _tag: "md", text: "Look" }, STAND_IN]);
    expect(JSON.stringify(feed)).not.toContain("private");
    expect(JSON.stringify(feed)).not.toContain("pins");
  });

  it("the same for the single-ask read and for one message read whole", async () => {
    const { api } = harness(({ url }) =>
      url.includes("/messages/")
        ? json(200, wireMessage([FROM_LATER], 4))
        : json(200, {
            boardId: "b1",
            cardId: "c1",
            cardNumber: 1,
            discussionId: null,
            ask: wireAsk([FROM_LATER]),
          }),
    );
    const detail = await api.detail("robob:1", "q1");
    expect(detail.ask.blocks).toEqual([STAND_IN]);
    const message = await api.message("d1", 4);
    expect(message.blocks).toEqual([STAND_IN]);
    expect(JSON.stringify([detail, message])).not.toContain("private");
  });

  it("does not leave the process reading unknown blocks: a server in it stays strict", async () => {
    const strict = Schema.decodeUnknownSync(KanbanMessage);
    const { api } = harness(() => json(200, wireFeed([wireItem(1, [FROM_LATER])])));
    await api.feed();
    expect(() => strict(wireMessage([FROM_LATER]))).toThrow();
  });

  it("a known kind of block that is malformed is refused, not stood in for", async () => {
    const { api } = harness(() => json(200, wireFeed([wireItem(1, [{ _tag: "html", html: 42 }])])));
    const error = await api.feed().catch((e) => e);
    expect(error).toBeInstanceOf(AskApiError);
    expect(error.code).toBe("unreadable");
  });

  it("a feed that can't be read is an error to show, never an empty queue", async () => {
    for (const body of [
      {},
      { at: "now", open: "none", closed: [] },
      wireFeed([wireItem(1), { ...wireItem(2), ask: undefined }]),
      wireFeed([{ ...wireItem(1), cardNumber: "one" }]),
    ]) {
      const { api } = harness(() => json(200, body));
      const error = await api.feed().catch((e) => e);
      expect(error).toBeInstanceOf(AskApiError);
      expect(error.code).toBe("unreadable");
      expect(error.message).toBe(ASK_UNREADABLE_TEXT);
      // The server did answer: it is not a lost connection, so nothing goes again by itself.
      expect(error.unreached).toBe(false);
      expect(error.stale).toBe(false);
      expect(error.denied).toBe(false);
    }
    const detail = harness(() => json(200, { card: {}, ask: null }));
    expect((await detail.api.detail("robob:1", "q1").catch((e) => e)).code).toBe("unreadable");
    const message = harness(() => json(200, { seq: 1 }));
    expect((await message.api.message("d1", 1).catch((e) => e)).code).toBe("unreadable");
  });

  it("an ask that comes again unchanged is not read again: it is the same object", async () => {
    let at = 0;
    let second: unknown = wireItem(2);
    const { api } = harness(() =>
      json(200, wireFeed([wireItem(1), second], `2026-11-11T08:00:0${(at += 1)}.000Z`)),
    );
    const first = await api.feed();
    second = wireItem(2, [], { revision: 1 });
    const next = await api.feed();
    expect(next.at).not.toBe(first.at);
    expect(next.open[0]).toBe(first.open[0]);
    expect(next.open[1]).not.toBe(first.open[1]);
    expect(next.open[1]!.revision).toBe(1);
  });

  it("a feed that was refused does not forget the asks of the one before", async () => {
    let body: unknown = wireFeed([wireItem(1)]);
    const { api } = harness(() => json(200, body));
    const first = await api.feed();
    body = wireFeed([wireItem(1), { broken: true }]);
    await expect(api.feed()).rejects.toThrow(ASK_UNREADABLE_TEXT);
    body = wireFeed([wireItem(1)]);
    expect((await api.feed()).open[0]).toBe(first.open[0]);
  });

  it("reads a feed of two hundred asks, and the next one without reading them again", async () => {
    const open = Array.from({ length: 200 }, (_, index) =>
      wireItem(index + 1, [{ _tag: "md", text: `Ask ${index + 1}` }]),
    );
    const { api } = harness(() => json(200, wireFeed(open)));
    const first = await api.feed();
    expect(first.open).toHaveLength(200);
    const next = await api.feed();
    expect(next.open.every((entry, index) => entry === first.open[index])).toBe(true);
  });
});
