import * as Schema from "effect/Schema";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  KANBAN_UNKNOWN_BLOCK_TEXT,
  KanbanBlockInput,
  KanbanCard,
  KanbanMessage,
  kanbanAskResponse,
  readingUnknownKanbanBlocks,
  tolerateUnknownKanbanBlocks,
} from "./kanban.ts";

// The setting is this process's: whatever a test here turns on is off again
// for the next one, so no test can change another's result.
afterEach(() => tolerateUnknownKanbanBlocks(false));

// What an app older than its server has to survive: a card or a message that
// carries something the app's build has never heard of. The apps turn the
// reading of unknown blocks on (the board client does); the server never does.

const card = (asks: ReadonlyArray<unknown>, extra: Record<string, unknown> = {}) => ({
  id: "card-1",
  boardId: "board-toy",
  number: 1,
  title: "A card",
  description: "",
  prompt: "",
  stage: "needs_owner",
  priority: 3,
  goalId: null,
  projects: [],
  model: { instanceId: "opencode", model: "opus/claude-opus-5-5" },
  models: [],
  subtasks: [],
  subtaskSeq: 0,
  projectId: null,
  links: [],
  blockedBy: [],
  stalled: null,
  question: null,
  asks,
  reviewChain: null,
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
  createdBy: { _tag: "owner" },
  createdAt: "2026-10-25T10:00:00.000Z",
  updatedAt: "2026-10-25T10:00:00.000Z",
  movedAt: "2026-10-25T10:00:00.000Z",
  ...extra,
});

const ask = (patch: Record<string, unknown> = {}) => ({
  id: "q1",
  text: "Ship it?",
  blocking: true,
  by: { _tag: "owner" },
  at: "2026-11-11T08:00:00.000Z",
  seq: null,
  closedAt: null,
  ...patch,
});

const message = (blocks: ReadonlyArray<unknown>, extra: Record<string, unknown> = {}) => ({
  seq: 1,
  discussionId: "d1",
  author: { _tag: "owner" },
  authorName: "You",
  createdAt: "2026-11-11T08:00:00.000Z",
  blocks,
  answers: [],
  ...extra,
});

const decodeCard = Schema.decodeUnknownSync(KanbanCard);
const encodeCard = Schema.encodeSync(KanbanCard);
const decodeMessage = Schema.decodeUnknownSync(KanbanMessage);
const encodeMessage = Schema.encodeSync(KanbanMessage);

const MAP = { _tag: "map", lat: 25.2, lng: 55.3, zoom: 12 };
/** A block of a kind nobody knows yet, far over every inline limit. */
const BIG_MARK = "payload-that-must-not-travel";
const BIG = { _tag: "map", tiles: `${BIG_MARK}:${"x".repeat(400_000)}` };

describe("a card from a newer server, in an app", () => {
  beforeEach(() => tolerateUnknownKanbanBlocks());
  afterEach(() => tolerateUnknownKanbanBlocks(false));

  it("loads with a field on the card or on an ask that this build doesn't know", () => {
    const decoded = decodeCard(card([ask({ fromTheFuture: { nested: true } })], { alsoNew: 1 }));
    expect(decoded.asks).toHaveLength(1);
    expect(decoded.asks[0]?.text).toBe("Ship it?");
  });

  it("loads an ask of a kind, a field type or a response part it has never seen", () => {
    const decoded = decodeCard(
      card([
        ask({
          kind: "from_the_future",
          to: "reviewer",
          respond: {
            verdict: {},
            signature: { required: true },
            fields: [{ id: "tint", label: "Tint", type: "colour", mask: "#rrggbb" }],
          },
        }),
      ]),
    );
    const response = kanbanAskResponse(decoded.asks[0]!);
    // The parts it knows are still there to draw and to answer with.
    expect(response.verdict).toEqual({ approve: "Approve", reject: "Reject" });
    expect(response.fields.map((field) => [field.id, field.type])).toEqual([["tint", "colour"]]);
  });

  it("shows a block of a kind it doesn't know as a line of text, in the same place", () => {
    const decoded = decodeCard(
      card([
        ask({
          blocks: [
            { _tag: "md", text: "Why" },
            MAP,
            { _tag: "image", url: "https://x.test/a.png", alt: null },
          ],
          respond: { fields: [{ id: "pick", label: "Pick", type: "custom", block: 2 }] },
        }),
      ]),
    );
    const blocks = decoded.asks[0]!.blocks!;
    expect(blocks.map((block) => block._tag)).toEqual(["md", "md", "image"]);
    expect(blocks[1]).toMatchObject({ _tag: "md", text: KANBAN_UNKNOWN_BLOCK_TEXT });
    // A field that points at a block by its index still points at the same one.
    expect(blocks[2]?._tag).toBe("image");
  });

  it("the line that stands in holds nothing of the block: a big one never travels on", () => {
    const decoded = decodeCard(card([ask({ blocks: [{ _tag: "md", text: "Why" }, BIG] })]));
    const standIn = decoded.asks[0]!.blocks![1]!;
    expect(standIn).toEqual({ _tag: "md", text: KANBAN_UNKNOWN_BLOCK_TEXT });
    expect(Object.keys(standIn).toSorted()).toEqual(["_tag", "text"]);
    // However the app passes the card on (as it is, or through the schema), the block is not in it.
    for (const wire of [JSON.stringify(decoded), JSON.stringify(encodeCard(decoded))]) {
      expect(wire).not.toContain(BIG_MARK);
      expect(wire.length).toBeLessThan(4_000);
    }
  });

  it("still refuses a pick block in an ask: known to this build, not allowed there", () => {
    const pick = {
      _tag: "choice",
      id: "c1",
      style: "pick",
      question: "Which?",
      options: [],
      multi: false,
    };
    expect(() => decodeCard(card([ask({ blocks: [pick] })]))).toThrow();
  });

  it("still refuses a block of a known kind that is malformed", () => {
    expect(() => decodeCard(card([ask({ blocks: [{ _tag: "image", url: "" }] })]))).toThrow();
    expect(() => decodeCard(card([ask({ blocks: ["not a block"] })]))).toThrow();
  });
});

describe("a message from a newer server, in an app", () => {
  beforeEach(() => tolerateUnknownKanbanBlocks());
  afterEach(() => tolerateUnknownKanbanBlocks(false));

  it("loads with a block of a kind it doesn't know, and with a field it doesn't know", () => {
    const decoded = decodeMessage(message([{ _tag: "md", text: "Look" }, BIG], { mood: "calm" }));
    expect(decoded.blocks.map((block) => block._tag)).toEqual(["md", "md"]);
    expect(decoded.blocks[1]).toEqual({ _tag: "md", text: KANBAN_UNKNOWN_BLOCK_TEXT });
    expect(JSON.stringify(decoded)).not.toContain(BIG_MARK);
    expect(JSON.stringify(encodeMessage(decoded))).not.toContain(BIG_MARK);
  });

  it("reads and writes a message of known blocks unchanged", () => {
    const stored = message([
      { _tag: "md", text: "Look" },
      { _tag: "collapse", title: "More", text: "Detail" },
      { _tag: "card", cardId: "card-2" },
    ]);
    expect(encodeMessage(decodeMessage(stored))).toEqual(stored);
  });
});

describe("the server's reader, which stores what it reads", () => {
  // Nothing turns the apps' reading on here: this is how the server runs.

  it("refuses a stored card or message with a block of a kind it doesn't know, as it always has", () => {
    expect(() => decodeCard(card([ask({ blocks: [{ _tag: "md", text: "Why" }, MAP] })]))).toThrow();
    expect(() => decodeCard(card([ask({ blocks: [BIG] })]))).toThrow();
    expect(() => decodeMessage(message([{ _tag: "md", text: "Look" }, MAP]))).toThrow();
  });

  it("so nothing can stand in for a stored block: what it reads is what it writes", () => {
    const storedBlocks = [
      { _tag: "md", text: "Why" },
      { _tag: "html", html: "<p>x</p>", title: "Chart", height: 240 },
    ];
    const storedCard = card([ask({ blocks: storedBlocks })]);
    const cardBack = encodeCard(decodeCard(storedCard));
    expect(cardBack.asks?.[0]?.blocks).toEqual(storedBlocks);
    expect(JSON.stringify(cardBack)).not.toContain(KANBAN_UNKNOWN_BLOCK_TEXT);
    const storedMessage = message([
      { _tag: "md", text: "Look" },
      { _tag: "collapse", title: "More", text: "Detail" },
    ]);
    expect(encodeMessage(decodeMessage(storedMessage))).toEqual(storedMessage);
  });

  it("turning the apps' reading off again restores it", () => {
    tolerateUnknownKanbanBlocks();
    expect(decodeMessage(message([MAP])).blocks).toHaveLength(1);
    tolerateUnknownKanbanBlocks(false);
    expect(() => decodeMessage(message([MAP]))).toThrow();
  });
});

describe("blocks coming in", () => {
  it("are still a closed list: a kind the server doesn't know is refused", () => {
    const decodeInput = Schema.decodeUnknownSync(KanbanBlockInput);
    expect(decodeInput({ _tag: "md", text: "x" })).toEqual({ _tag: "md", text: "x" });
    expect(() => decodeInput(MAP)).toThrow();
    // A key the block doesn't have is dropped, in an app and on the server alike.
    expect(decodeInput({ _tag: "md", text: "x", original: MAP })).toEqual({
      _tag: "md",
      text: "x",
    });
    tolerateUnknownKanbanBlocks();
    expect(() => decodeInput(MAP)).toThrow();
    tolerateUnknownKanbanBlocks(false);
  });
});

describe("one read with unknown blocks stood in for", () => {
  const decode = Schema.decodeUnknownSync(KanbanMessage);
  const fromLater = {
    seq: 1,
    discussionId: "d1",
    author: { _tag: "owner" },
    authorName: "You",
    createdAt: "2026-11-11T08:00:00.000Z",
    blocks: [{ _tag: "map", zoom: 12, secretish: "payload" }],
    answers: [],
  };

  it("stands in for the block during the read and is strict again after it", () => {
    expect(() => decode(fromLater)).toThrow();
    const read = readingUnknownKanbanBlocks(() => decode(fromLater));
    expect(read.blocks).toEqual([{ _tag: "md", text: KANBAN_UNKNOWN_BLOCK_TEXT }]);
    // The same process reads strictly again, as a server must.
    expect(() => decode(fromLater)).toThrow();
  });

  it("is strict again after a read that failed", () => {
    expect(() =>
      readingUnknownKanbanBlocks(() => decode({ ...fromLater, seq: "not a number" })),
    ).toThrow();
    expect(() => decode(fromLater)).toThrow();
  });

  it("leaves an app that reads this way all the time as it was", () => {
    tolerateUnknownKanbanBlocks();
    readingUnknownKanbanBlocks(() => decode(fromLater));
    expect(decode(fromLater).blocks).toHaveLength(1);
  });
});
