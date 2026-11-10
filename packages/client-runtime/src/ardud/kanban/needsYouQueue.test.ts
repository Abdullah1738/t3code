import type { KanbanAskFeedItem, KanbanOwnerAsk } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { needsYouFromFeed } from "./needsYou.ts";
import {
  askAge,
  askKindLabel,
  EMPTY_NEEDS_YOU_FILTER,
  needsYouFocusOrder,
  needsYouKinds,
  needsYouMarkOf,
  needsYouNextFocus,
  needsYouSections,
  needsYouStep,
} from "./needsYouQueue.ts";

const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const BOARDS = new Map([
  ["b-robob", "Robob"],
  ["b-crpko", "Crpko"],
]);

const entry = (
  number: number,
  patch: Partial<KanbanOwnerAsk> = {},
  board = "b-robob",
): KanbanAskFeedItem =>
  ({
    boardId: board,
    boardSlug: board.slice(2),
    boardName: BOARDS.get(board),
    cardId: `card-${board}-${number}`,
    cardNumber: number,
    cardRef: `${board.slice(2)}:${number}`,
    cardTitle: `Card ${number}`,
    stage: "needs_owner",
    priority: 3,
    discussionId: null,
    blocks: 0,
    ask: {
      id: "q1",
      text: `Question ${number}`,
      blocking: false,
      by: { _tag: "owner" },
      at: "2026-11-10T10:00:00.000Z",
      seq: null,
      closedAt: null,
      ...patch,
    },
    kind: patch.kind ?? "question",
    revision: patch.revision ?? 0,
    waitsOn: "owner",
    expired: false,
    messages: [],
  }) as unknown as KanbanAskFeedItem;

const ACTION = { summary: "Deploy", command: "deploy.zsh spectrum-bridge" };
const feed = [
  entry(1, { blocking: true, kind: "action", action: ACTION, batchKey: "deploy" }),
  entry(2, { blocking: true, kind: "action", action: ACTION, batchKey: "deploy" }),
  entry(3, { kind: "decision", title: "Which port?" }),
  entry(4, { clarifyAskedAt: "2026-11-10T11:00:00.000Z" as never }),
  entry(5, { handedAt: "2026-11-10T11:00:00.000Z" as never }),
  entry(6, { kind: "notice", respond: { ack: true } }),
  entry(7, { expiresAt: "2026-11-10T11:00:00.000Z" as never }),
  entry(8, { title: "Token for Cliq" }, "b-crpko"),
];
const needsYou = needsYouFromFeed(feed, NOW);
const sections = (filter = EMPTY_NEEDS_YOU_FILTER, marks = new Map(), hidden = new Set<string>()) =>
  needsYouSections(needsYou, filter, BOARDS, marks, hidden);
const shape = (list: ReturnType<typeof sections>) =>
  list.map((section) => [section.id, section.count] as const);

describe("needsYouSections", () => {
  it("cuts the queue into the page's sections, a batch counted by its asks", () => {
    expect(shape(sections())).toEqual([
      ["holds", 2],
      ["open", 2],
      ["expired", 1],
      ["agent", 1],
      ["evaluator", 1],
      ["notices", 1],
    ]);
    expect(sections()[0]!.entries[0]!._tag).toBe("batch");
  });

  it("filters by board, kind, holding and search words", () => {
    expect(shape(sections({ ...EMPTY_NEEDS_YOU_FILTER, boardId: "b-crpko" }))).toEqual([
      ["open", 1],
    ]);
    expect(shape(sections({ ...EMPTY_NEEDS_YOU_FILTER, kind: "decision" }))).toEqual([["open", 1]]);
    expect(shape(sections({ ...EMPTY_NEEDS_YOU_FILTER, holds: true }))).toEqual([["holds", 2]]);
    expect(shape(sections({ ...EMPTY_NEEDS_YOU_FILTER, query: "crpko token" }))).toEqual([
      ["open", 1],
    ]);
    expect(shape(sections({ ...EMPTY_NEEDS_YOU_FILTER, query: "spectrum-bridge" }))).toEqual([
      ["holds", 2],
    ]);
    expect(sections({ ...EMPTY_NEEDS_YOU_FILTER, query: "nothing like it" })).toEqual([]);
  });

  it("unfolds a batch that a filter or a pending answer leaves with one ask", () => {
    const one = sections(EMPTY_NEEDS_YOU_FILTER, new Map(), new Set(["card-b-robob-1:q1"]));
    expect(one[0]!.entries.map((item) => item._tag)).toEqual(["ask"]);
    expect(one[0]!.count).toBe(1);
  });

  it("sets a snoozed ask apart and brings it back as new when its time passes", () => {
    const snoozed = needsYouFromFeed(
      [
        entry(1, { snoozedUntil: "2026-11-11T05:00:00.000Z" as never }),
        entry(2, { snoozedUntil: "2026-11-10T11:30:00.000Z" as never }),
        entry(3, {
          snoozedUntil: "2026-11-12T05:00:00.000Z" as never,
          backFromSnoozeAt: "2026-11-10T11:45:00.000Z" as never,
        }),
        entry(4),
      ],
      NOW,
    );
    const list = needsYouSections(snoozed, EMPTY_NEEDS_YOU_FILTER, BOARDS);
    expect(shape(list)).toEqual([
      ["fresh", 1],
      ["open", 1],
      ["snoozed", 2],
    ]);
    expect(snoozed.count).toBe(2);
    const back = snoozed.items.find((item) => item.cardNumber === 2)!;
    expect(needsYouMarkOf(back, {})).toBe("back");
    expect(needsYouMarkOf(back, { [back.key]: "failed" })).toBe("failed");
  });

  it("moves a marked ask to New for you", () => {
    const marked = sections(EMPTY_NEEDS_YOU_FILTER, new Map([["card-b-robob-3:q1", "reply"]]));
    expect(shape(marked).slice(0, 3)).toEqual([
      ["fresh", 1],
      ["holds", 2],
      ["open", 1],
    ]);
  });
});

describe("focus order", () => {
  const all = sections();
  const batch = "batch:b-robob:deploy";

  it("steps through a batch's asks only while it is unfolded", () => {
    expect(needsYouFocusOrder(all, new Set()).slice(0, 3)).toEqual([
      batch,
      "card-b-crpko-8:q1",
      "card-b-robob-3:q1",
    ]);
    expect(needsYouFocusOrder(all, new Set([batch])).slice(0, 3)).toEqual([
      batch,
      "card-b-robob-1:q1",
      "card-b-robob-2:q1",
    ]);
  });

  it("stays at the ends and starts at the top", () => {
    const order = needsYouFocusOrder(all, new Set());
    expect(needsYouStep(order, null, 1)).toBe(batch);
    expect(needsYouStep(order, batch, -1)).toBe(batch);
    expect(needsYouStep(order, order.at(-1)!, 1)).toBe(order.at(-1));
    expect(needsYouStep([], null, 1)).toBeNull();
  });

  it("after an answer, goes to the first ask that still needs him", () => {
    expect(needsYouNextFocus(all, new Set())).toBe(batch);
    const onlyOthers = sections({ ...EMPTY_NEEDS_YOU_FILTER, kind: "notice" });
    expect(needsYouNextFocus(onlyOthers, new Set())).toBe("card-b-robob-6:q1");
    expect(needsYouNextFocus([], new Set())).toBeNull();
  });
});

describe("labels", () => {
  it("lists the kinds present, most common first", () => {
    expect(needsYouKinds(needsYou).slice(0, 2)).toEqual([
      { kind: "question", count: 4 },
      { kind: "action", count: 2 },
    ]);
  });

  it("reads any kind as a label and any wait as an age", () => {
    expect(askKindLabel("flake-triage")).toBe("Flake triage");
    expect(askKindLabel("signoff")).toBe("Signoff");
    expect(askAge(5 * 86_400_000 + 9 * 3_600_000)).toBe("5d 9h");
    expect(askAge(3 * 3_600_000 + 10)).toBe("3h");
    expect(askAge(12 * 60_000)).toBe("12m");
    expect(askAge(20_000)).toBe("now");
  });
});
