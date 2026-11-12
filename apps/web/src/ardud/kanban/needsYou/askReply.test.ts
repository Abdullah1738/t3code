/**
 * What leaves the web page when he replies under an ask whose thread holds
 * stand-ins. The page's composer hands `onSend` the blocks `composerBlocks`
 * builds from its text and uploads, and the ask's discussion passes them to
 * the store's `replyOnAsk`. This runs that path from the builder on, over a
 * server that sends blocks only a newer build knows, and reads what was
 * posted. (The composer itself is a browser component: it is not rendered
 * here. It is given no message of the thread, only its own text and files.)
 */
import {
  createAskApi,
  createAskStateCell,
  createAskStore,
} from "@t3tools/client-runtime/ardud/kanban";
import { KANBAN_UNKNOWN_BLOCK_TEXT } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { composerBlocks } from "../composerAttachments";

/** A block of a kind only a newer server knows, with a payload this build must not keep or send. */
const FROM_LATER = { _tag: "map", zoom: 12, pins: [{ lat: 25.2, lng: 55.3, note: "PRIVATE-PIN" }] };

const wireMessage = (seq: number, text: string) => ({
  discussionId: "d1",
  seq,
  author: { _tag: "thread", threadId: "t1" },
  authorName: "Worker",
  blocks: [{ _tag: "md", text }, FROM_LATER],
  answers: [],
  createdAt: "2026-11-11T08:00:00.000Z",
  askId: "q1",
});

const wireFeed = () => ({
  at: "2026-11-11T08:00:00.000Z",
  open: [
    {
      boardId: "b1",
      boardSlug: "robob",
      boardName: "Robob",
      cardId: "c1",
      cardNumber: 1,
      cardRef: "robob:1",
      cardTitle: "Card 1",
      stage: "needs_owner",
      priority: 3,
      discussionId: "d1",
      blocks: 0,
      ask: {
        id: "q1",
        text: "Ship it?",
        blocking: true,
        by: { _tag: "thread", threadId: "t1" },
        at: "2026-11-11T08:00:00.000Z",
        seq: 1,
        closedAt: null,
        kind: "approval",
        respond: { verdict: {} },
        blocks: [{ _tag: "md", text: "READ-ASK-BLOCK" }, FROM_LATER],
      },
      kind: "approval",
      revision: 0,
      waitsOn: "owner",
      expired: false,
      messages: [wireMessage(1, "READ-ASK-MESSAGE"), wireMessage(2, "READ-AGENT-MESSAGE")],
    },
  ],
  closed: [],
});

function page() {
  const writes: Array<{ readonly path: string; readonly body: string }> = [];
  const api = createAskApi({
    target: () => ({ base: "https://robob.test", headers: {}, cookies: true }),
    answerSecrets: async () => ({ _tag: "sent" }),
    fetch: (async (url: string, init?: { method?: string; body?: unknown }) => {
      const method = init?.method ?? "GET";
      if (method !== "GET") {
        writes.push({
          path: String(url).replace("https://robob.test", ""),
          body: String(init?.body ?? ""),
        });
      }
      const body = method === "GET" ? wireFeed() : { seq: 3 };
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    }) as unknown as typeof fetch,
  });
  const cell = createAskStateCell();
  const store = createAskStore({
    api,
    cell,
    watch: {
      onBoardsChange: () => () => undefined,
      onForeground: () => () => undefined,
      isForeground: () => true,
    },
  });
  return { store, cell, writes };
}

const image = {
  type: "image" as const,
  id: "att-1",
  name: "a.png",
  mimeType: "image/png",
  sizeBytes: 10,
};

describe("a reply under an ask whose thread holds stand-ins", () => {
  it("posts the composer's own blocks and nothing that was read", async () => {
    const { store, cell, writes } = page();
    await store.refreshAsks();
    const entry = cell.getState().feed!.open[0]!;
    // Read through the schema: the unknown block is its stand-in, in the ask and in the thread.
    const standIn = { _tag: "md", text: KANBAN_UNKNOWN_BLOCK_TEXT };
    expect(entry.ask.blocks).toEqual([{ _tag: "md", text: "READ-ASK-BLOCK" }, standIn]);
    expect(entry.messages[1]!.blocks).toEqual([
      { _tag: "md", text: "READ-AGENT-MESSAGE" },
      standIn,
    ]);

    // What the composer hands over for a typed reply, then for one with a file.
    await store.replyOnAsk(entry, composerBlocks("his reply", []));
    await store.replyOnAsk(entry, composerBlocks("with a picture", [image]));

    expect(writes.map((write) => write.path)).toEqual([
      "/api/ardud/kanban/cards/robob%3A1/asks/q1/reply",
      "/api/ardud/kanban/cards/robob%3A1/asks/q1/reply",
    ]);
    expect(writes.map((write) => JSON.parse(write.body))).toEqual([
      { blocks: [{ _tag: "md", text: "his reply" }] },
      {
        blocks: [
          { _tag: "md", text: "with a picture" },
          { _tag: "attachment", attachment: image },
        ],
      },
    ]);
    for (const write of writes) {
      expect(write.body).not.toContain(KANBAN_UNKNOWN_BLOCK_TEXT);
      expect(write.body).not.toContain("READ-");
      expect(write.body).not.toContain("PRIVATE-PIN");
    }
  });
});
