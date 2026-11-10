import type { KanbanAskFeedItem, KanbanCard, KanbanOwnerAsk } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import type { KanbanBoardState } from "./boardState.ts";
import { needsYouFromFeed, needsYouItems } from "./needsYou.ts";

const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const hoursAgo = (hours: number) => iso(NOW - hours * 3_600_000);

const ask = (id: string, patch: Partial<KanbanOwnerAsk> = {}): KanbanOwnerAsk =>
  ({
    id,
    text: `Question ${id}`,
    blocking: false,
    by: { _tag: "owner" },
    at: hoursAgo(1),
    seq: null,
    closedAt: null,
    ...patch,
  }) as KanbanOwnerAsk;

const card = (number: number, patch: Partial<KanbanCard> = {}): KanbanCard =>
  ({
    id: `card-${number}`,
    boardId: "board-toy",
    number,
    title: `Card ${number}`,
    stage: "working",
    priority: 3,
    blockedBy: [],
    asks: [],
    settledAt: null,
    ...patch,
  }) as KanbanCard;

const state = (cards: ReadonlyArray<KanbanCard>) =>
  ({ cards: new Map(cards.map((entry) => [entry.id, entry])) }) as unknown as KanbanBoardState;

const keys = (items: ReadonlyArray<{ readonly key: string }>) => items.map((item) => item.key);

describe("needsYouItems", () => {
  it("ranks blocking first, then the card that unblocks the most, then the oldest", () => {
    const list = needsYouItems(
      state([
        card(1, { asks: [ask("q1", { at: hoursAgo(9) })] }),
        card(2, { stage: "needs_owner", asks: [ask("q1", { blocking: true, at: hoursAgo(1) })] }),
        card(3, { stage: "needs_owner", asks: [ask("q1", { blocking: true, at: hoursAgo(2) })] }),
        card(4, { stage: "needs_owner", asks: [ask("q1", { blocking: true, at: hoursAgo(5) })] }),
        // Two unfinished cards wait on #2, one on #3; a done and a settled one don't count.
        card(5, { blockedBy: ["card-2"] as never }),
        card(6, { blockedBy: ["card-2", "card-3"] as never, stage: "todo" }),
        card(7, { blockedBy: ["card-4"] as never, stage: "verified" }),
        card(8, { blockedBy: ["card-4"] as never, settledAt: hoursAgo(1) as never }),
        card(9, { asks: [ask("q1", { at: hoursAgo(3) }), ask("q2", { at: hoursAgo(30) })] }),
      ]),
      NOW,
    );
    expect(keys(list.items)).toEqual([
      "card-2:q1", // blocking, unblocks 2
      "card-3:q1", // blocking, unblocks 1
      "card-4:q1", // blocking, unblocks 0
      "card-9:q2", // async, oldest
      "card-1:q1",
      "card-9:q1",
    ]);
    expect(list.items.map((item) => item.unblocks)).toEqual([2, 1, 0, 0, 0, 0]);
    expect(list.count).toBe(6);
    expect(list.blocking).toBe(3);
    expect(list.entries.every((entry) => entry._tag === "ask")).toBe(true);
    expect(list.items[3]!.ageMs).toBe(30 * 3_600_000);
  });

  it("sets apart asks that are not his turn, and stale ones", () => {
    const list = needsYouItems(
      state([
        card(1, {
          stage: "needs_owner",
          asks: [
            ask("q1", { blocking: true, clarifyAskedAt: hoursAgo(1) as never }),
            ask("q2", { handedAt: hoursAgo(1) as never }),
            ask("q3", { expiresAt: hoursAgo(1) as never }),
            ask("q4", { expiresAt: iso(NOW + 3_600_000) as never }),
            ask("q5", { closedAt: hoursAgo(1) as never }),
          ],
        }),
        // A settled card's open ask is nobody's to answer.
        card(2, { settledAt: hoursAgo(2) as never, asks: [ask("q1")] }),
      ]),
      NOW,
    );
    expect(keys(list.items)).toEqual(["card-1:q4"]);
    expect(keys(list.waitingOnAgent)).toEqual(["card-1:q1"]);
    expect(keys(list.withEvaluator)).toEqual(["card-1:q2"]);
    expect(keys(list.expired)).toEqual(["card-1:q3"]);
    expect(list.count).toBe(1);
    expect(list.blocking).toBe(0);
    // Each group has its own count; the badge number is `owner`.
    expect(list.counts).toEqual({ owner: 1, agent: 1, evaluator: 1, expired: 1, notices: 0 });
  });

  it("gives each item its response parts, and keeps notices apart, uncounted and never blocking", () => {
    const list = needsYouItems(
      state([
        card(1, { asks: [ask("q1")] }),
        card(2, {
          asks: [
            ask("q1", {
              kind: "deploy-go" as never,
              action: { summary: "Deploy" },
              respond: {
                verdict: { approve: "Deploy", reject: "Hold" },
                fields: [{ id: "when", label: "When", type: "date" }],
              } as never,
            }),
          ],
        }),
        card(3, {
          asks: [
            // A notice stored as blocking by mistake still never counts as blocking.
            ask("q1", { kind: "notice", blocking: true, respond: { ack: true } }),
            ask("q2", {
              options: [
                { id: "a", label: "A" },
                { id: "b", label: "B" },
              ] as never,
            }),
          ],
        }),
      ]),
      NOW,
    );
    expect(keys(list.items)).toEqual(["card-1:q1", "card-2:q1", "card-3:q2"]);
    expect(keys(list.notices)).toEqual(["card-3:q1"]);
    expect([list.count, list.blocking]).toEqual([3, 0]);
    expect(list.counts).toEqual({ owner: 3, agent: 0, evaluator: 0, expired: 0, notices: 1 });
    expect(list.notices[0]).toMatchObject({ notice: true, blocking: false });
    expect(list.notices[0]!.response.ack).toBe(true);

    const [plain, custom, pick] = list.items;
    // An ask with no kind and no parts takes a free-text reply.
    expect(plain!.response.fields.map((field) => [field.id, field.type])).toEqual([
      ["answer", "longtext"],
    ]);
    // A kind this client has never heard of renders from its parts.
    expect(custom!.kind).toBe("deploy-go");
    expect(custom!.response.verdict).toEqual({ approve: "Deploy", reject: "Hold" });
    expect(custom!.response.fields.map((field) => field.id)).toEqual(["when"]);
    expect(pick!.response.choose).toMatchObject({ multi: false, min: 1, max: 1 });
  });

  it("folds asks with the same batch key on a board into one entry at its best item's place", () => {
    const deploy = (number: number, patch: Partial<KanbanOwnerAsk> = {}) =>
      card(number, { asks: [ask("q1", { kind: "action", batchKey: "deploy-go", ...patch })] });
    const list = needsYouItems(
      state([
        deploy(1, { at: hoursAgo(2) }),
        card(2, { stage: "needs_owner", asks: [ask("q1", { blocking: true })] }),
        deploy(3, { at: hoursAgo(8) }),
        card(4, { asks: [ask("q1", { at: hoursAgo(5) })] }),
        // A lone key is a plain ask; a clarified one is out of the batch.
        card(5, { asks: [ask("q1", { batchKey: "solo", at: hoursAgo(1) })] }),
        deploy(6, { clarifyAskedAt: hoursAgo(1) as never }),
      ]),
      NOW,
    );
    expect(
      list.entries.map((entry) =>
        entry._tag === "batch" ? [entry.batchKey, keys(entry.items)] : entry.item.key,
      ),
    ).toEqual(["card-2:q1", ["deploy-go", ["card-3:q1", "card-1:q1"]], "card-4:q1", "card-5:q1"]);
    expect(list.items.length).toBe(5);
    expect(keys(list.waitingOnAgent)).toEqual(["card-6:q1"]);
    expect(list.items.find((item) => item.key === "card-3:q1")?.kind).toBe("action");
  });

  it("reads kind, revision and updated with their defaults", () => {
    const list = needsYouItems(
      state([card(1, { asks: [ask("q1"), ask("q2", { kind: "draft", revision: 2 })] })]),
      NOW,
    );
    expect(list.items.map((item) => [item.ask.id, item.kind, item.revision, item.updated])).toEqual(
      [
        ["q1", "question", 0, false],
        ["q2", "draft", 2, true],
      ],
    );
  });
});

describe("needsYouFromFeed", () => {
  it("ranks the server feed the same way across boards and keeps batches per board", () => {
    const entry = (
      boardId: string,
      cardNumber: number,
      blocks: number,
      patch: Partial<KanbanOwnerAsk> = {},
    ) =>
      ({
        boardId,
        cardId: `${boardId}-card-${cardNumber}`,
        cardNumber,
        cardTitle: `Card ${cardNumber}`,
        stage: "needs_owner",
        priority: 2,
        blocks,
        ask: ask("q1", { blocking: true, ...patch }),
      }) as unknown as KanbanAskFeedItem;
    const list = needsYouFromFeed(
      [
        entry("board-a", 1, 0, { batchKey: "deploy-go" }),
        entry("board-b", 1, 3, { batchKey: "deploy-go" }),
        entry("board-a", 2, 1, { batchKey: "deploy-go" }),
        entry("board-b", 2, 0, { blocking: false }),
      ],
      NOW,
    );
    expect(keys(list.items)).toEqual([
      "board-b-card-1:q1",
      "board-a-card-2:q1",
      "board-a-card-1:q1",
      "board-b-card-2:q1",
    ]);
    // Board b's lone deploy ask is not folded with board a's two.
    expect(
      list.entries.map((item) => (item._tag === "batch" ? keys(item.items) : item.item.key)),
    ).toEqual([
      "board-b-card-1:q1",
      ["board-a-card-2:q1", "board-a-card-1:q1"],
      "board-b-card-2:q1",
    ]);
    expect(list.items[0]!.unblocks).toBe(3);
  });
});
