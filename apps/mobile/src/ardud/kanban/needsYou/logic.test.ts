import {
  EMPTY_NEEDS_YOU_FILTER,
  needsYouFocusOrder,
  needsYouFromFeed,
  needsYouSections,
  type AskSend,
} from "@t3tools/client-runtime/ardud/kanban";
import type { KanbanAskBlock, KanbanAskFeedItem, KanbanOwnerAsk } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  acceptsInWords,
  acceptsOnlyMedia,
  askFacts,
  askHtmlStaysInFrame,
  askKeyFromParams,
  askNeighbours,
  askParamsFromKey,
  askRowMedia,
  askShown,
  askStatePills,
  askTurn,
  batchAll,
  batchPrimaryLabel,
  boardChips,
  customValueAccepted,
  historyRows,
  isLoadablePicture,
  linkHost,
  moveRank,
  needsYouItemsByKey,
  queueRows,
  rankOrder,
  readAskHtmlMessage,
  unreachedRetryGate,
} from "./logic";

const NOW = Date.parse("2026-11-11T12:00:00.000Z");

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
    kind: ask.kind ?? "approval",
    revision: ask.revision ?? 0,
    waitsOn: "owner",
    expired: false,
    messages: [],
    ...item,
  }) as unknown as KanbanAskFeedItem;

describe("route params", () => {
  it("a link names an ask by its card and ask ids", () => {
    expect(askKeyFromParams({ cardId: " c1 ", askId: "q2" })).toBe("c1:q2");
    expect(askKeyFromParams({ cardId: "c1" })).toBeNull();
    expect(askKeyFromParams(undefined)).toBeNull();
  });

  it("a queue key splits back into the params that open it", () => {
    expect(askParamsFromKey("c1:q2")).toEqual({ cardId: "c1", askId: "q2" });
    expect(askParamsFromKey("card:with:colons:q2")).toEqual({
      cardId: "card:with:colons",
      askId: "q2",
    });
    expect(askParamsFromKey("nothing")).toBeNull();
    expect(askParamsFromKey("c1:")).toBeNull();
  });
});

describe("the queue as rows", () => {
  const open = [
    entry(1),
    entry(2, { batchKey: "deploy", blocking: false }),
    entry(3, { batchKey: "deploy", blocking: false }),
    entry(4, { respond: { ack: true }, blocking: false }),
    entry(5, { clarifyAskedAt: "2026-11-11T09:00:00.000Z" }, { waitsOn: "agent" }),
  ];
  const needsYou = needsYouFromFeed(open, NOW);
  const sections = needsYouSections(needsYou, EMPTY_NEEDS_YOU_FILTER, new Map([["b1", "Robob"]]));

  it("lists each section's heading before its rows, a batch folded as one row", () => {
    const rows = queueRows(sections, new Set());
    expect(rows.map((row) => (row._tag === "section" ? row.label : row._tag))).toEqual([
      "Holds a card",
      "ask",
      "Not blocking",
      "batch",
      "Waiting on agents",
      "ask",
      "Notices, nothing needed",
      "ask",
    ]);
    const batch = rows.find((row) => row._tag === "batch");
    expect(batch?._tag === "batch" && batch.entry.items).toHaveLength(2);
    expect(batch?._tag === "batch" && batch.last).toBe(true);
  });

  it("an open batch lists its asks under it, in the order the web steps through", () => {
    const key = "batch:b1:deploy";
    const rows = queueRows(sections, new Set([key]));
    const keys = rows.flatMap((row) => (row._tag === "section" ? [] : [row.key]));
    expect(keys).toEqual(needsYouFocusOrder(sections, new Set([key])));
    const nested = rows.filter((row) => row._tag === "ask" && row.nested);
    expect(nested).toHaveLength(2);
    expect(nested.at(-1)?._tag === "ask" && nested.at(-1)).toMatchObject({ last: true });
  });

  it("finds any open ask by key and steps between single asks only", () => {
    const byKey = needsYouItemsByKey(needsYou);
    expect([...byKey.keys()].sort()).toEqual(["c1:q1", "c2:q1", "c3:q1", "c4:q1", "c5:q1"]);
    const order = needsYouFocusOrder(sections, new Set());
    expect(askNeighbours(order, "c1:q1")).toEqual({ previous: null, next: "c5:q1" });
    expect(askNeighbours(order, "c5:q1")).toEqual({ previous: "c1:q1", next: "c4:q1" });
    expect(askNeighbours(order, "gone")).toEqual({ previous: null, next: "c1:q1" });
  });

  it("counts the asks to answer on each board for the filter", () => {
    const two = [
      ...open,
      entry(9, {}, {
        boardId: "b2",
        boardName: "Crpko",
        cardId: "x9",
      } as Partial<KanbanAskFeedItem>),
    ];
    const owed = needsYouFromFeed(two, NOW).items;
    expect(boardChips(two, owed)).toEqual([
      { id: "b1", name: "Robob", count: 3 },
      { id: "b2", name: "Crpko", count: 1 },
    ]);
  });
});

describe("one ask", () => {
  it("says whose turn it is", () => {
    const mine = entry(1);
    const item = (e: KanbanAskFeedItem) => needsYouItemsByKey(needsYouFromFeed([e], NOW));
    expect(askTurn(mine, item(mine).get("c1:q1")!)).toBe("owner");
    const stale = entry(1, { expiresAt: "2026-11-11T09:00:00.000Z" });
    expect(askTurn(stale, item(stale).get("c1:q1")!)).toBe("expired");
    const handed = entry(1, { handedAt: "2026-11-11T09:00:00.000Z" }, { waitsOn: "evaluator" });
    expect(askTurn(handed, item(handed).get("c1:q1")!)).toBe("evaluator");
  });

  it("puts its state in words, the failure first", () => {
    const e = entry(7, {}, { blocks: 2 });
    const item = needsYouItemsByKey(needsYouFromFeed([e], NOW)).get("c7:q1")!;
    expect(
      askStatePills({ entry: e, item, turn: "owner", mark: "failed", nowMs: NOW }).map(
        (pill) => [pill.label, pill.tone] as const,
      ),
    ).toEqual([
      ["Not sent", "negative"],
      ["Holds #7", "warn"],
      ["2 cards wait behind it", "plain"],
    ]);
    const notice = entry(8, { respond: { ack: true }, blocking: true });
    const noticeItem = needsYouItemsByKey(needsYouFromFeed([notice], NOW)).get("c8:q1")!;
    expect(
      askStatePills({
        entry: notice,
        item: noticeItem,
        turn: "owner",
        mark: undefined,
        nowMs: NOW,
      }).map((pill) => pill.label),
    ).toEqual(["Nothing needed"]);
  });

  it("lists why it is in the queue", () => {
    const e = entry(
      7,
      { basis: "head 4c1d9e2", revision: 2, expiresAt: "2026-11-11T14:00:00.000Z" },
      { blocks: 1 },
    );
    const item = needsYouItemsByKey(needsYouFromFeed([e], NOW)).get("c7:q1")!;
    expect(askFacts(e, item)).toEqual([
      ["Waiting", "4h"],
      ["Holds a card", "Yes"],
      ["Cards behind it", "1"],
      ["Rests on", "head 4c1d9e2"],
      ["Good for", "2h"],
      ["Edited", "2 times"],
    ]);
  });

  it("names a link's site and what a file field takes", () => {
    expect(linkHost("https://www.appstoreconnect.apple.com/agreements")).toBe(
      "appstoreconnect.apple.com",
    );
    expect(linkHost("not a link")).toBe("the link");
    expect(acceptsInWords(["application/pdf", "image/*"])).toBe("PDF or images");
    expect(acceptsInWords([".csv"])).toBe("CSV");
    expect(acceptsOnlyMedia(["image/*", "video/mp4"])).toBe(true);
    expect(acceptsOnlyMedia(["image/*", ".csv"])).toBe(false);
    expect(acceptsOnlyMedia(undefined)).toBe(false);
  });

  it("orders a rank field and moves one item", () => {
    const field = {
      options: [
        { id: "speed", label: "Speed" },
        { id: "cost", label: "Cost" },
        { id: "polish", label: "Polish" },
      ],
    } as never;
    expect(rankOrder(field, undefined)).toEqual(["speed", "cost", "polish"]);
    expect(rankOrder(field, ["polish", "gone", "polish"])).toEqual(["polish", "speed", "cost"]);
    expect(moveRank(["speed", "cost", "polish"], "polish", 0)).toEqual(["polish", "speed", "cost"]);
    expect(moveRank(["speed", "cost", "polish"], "speed", 9)).toEqual(["cost", "polish", "speed"]);
    expect(moveRank(["speed", "cost"], "gone", 0)).toEqual(["speed", "cost"]);
  });

  it("takes a value from a page only inside the field's limits", () => {
    expect(customValueAccepted({ min: 5, max: 50 }, 25)).toBe(true);
    expect(customValueAccepted({ min: 5, max: 50 }, 55)).toBe(false);
    expect(customValueAccepted({ min: 5, max: 50 }, Number.NaN)).toBe(false);
    expect(customValueAccepted({}, { region: "eu" })).toBe(true);
    expect(customValueAccepted({}, undefined)).toBe(false);
  });
});

describe("what an ask shows", () => {
  const blocks = [
    { _tag: "md", text: "Why this is asked." },
    { _tag: "image", url: "https://example.test/a.png", alt: "Before" },
    { _tag: "md", text: "The old screen" },
    {
      _tag: "attachment",
      attachment: {
        type: "image",
        id: "a1",
        name: "after.png",
        mimeType: "image/png",
        sizeBytes: 9,
      },
    },
    {
      _tag: "attachment",
      attachment: { type: "file", id: "a2", name: "clip.mp4", mimeType: "video/mp4", sizeBytes: 9 },
    },
    { _tag: "md", text: "The walkthrough" },
    { _tag: "image", url: "data:image/svg+xml;utf8,<svg/>", alt: "Chart" },
    { _tag: "future-part", anything: 1 },
  ] as unknown as ReadonlyArray<KanbanAskBlock>;

  it("gathers the pictures into one gallery and takes the short text after as a caption", () => {
    const shown = askShown(blocks);
    expect(shown.pictures.map((picture) => [picture.block, picture.name, picture.caption])).toEqual(
      [
        [1, "Before", "The old screen"],
        [3, "after.png", null],
      ],
    );
    expect([...shown.captions]).toEqual([2, 5]);
    expect(shown.pictureOf.get(3)).toBe(1);
  });

  it("only loads pictures over https or as inline raster data", () => {
    expect(isLoadablePicture("https://example.test/a.png")).toBe(true);
    expect(isLoadablePicture("http://example.test/a.png")).toBe(false);
    expect(isLoadablePicture("data:image/png;base64,AAAA")).toBe(true);
    expect(isLoadablePicture("data:image/svg+xml;utf8,<svg/>")).toBe(false);
    expect(isLoadablePicture("file:///etc/passwd")).toBe(false);
  });

  it("hints at pictures and video on a row, and survives a part it does not know", () => {
    expect(askRowMedia(blocks)).toEqual({ pictures: 3, video: true });
    expect(askRowMedia(undefined)).toEqual({ pictures: 0, video: false });
  });
});

describe("a page inside an ask", () => {
  it("reads a value the page hands back, in either form", () => {
    expect(readAskHtmlMessage(JSON.stringify({ type: "robob.ask.value", value: 25 }))).toEqual({
      _tag: "value",
      value: 25,
    });
    expect(readAskHtmlMessage(JSON.stringify({ robobPick: 3 }))).toEqual({
      _tag: "value",
      value: 3,
    });
  });

  it("reads the page's height and ignores everything else", () => {
    expect(
      readAskHtmlMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "ui/notifications/size-changed",
          params: { height: 212 },
        }),
      ),
    ).toEqual({ _tag: "height", height: 212 });
    expect(readAskHtmlMessage("not json")).toBeNull();
    expect(readAskHtmlMessage(JSON.stringify({ type: "something.else" }))).toBeNull();
    expect(readAskHtmlMessage(JSON.stringify("text"))).toBeNull();
  });

  it("keeps the page where it is and sends every other address outside", () => {
    expect(askHtmlStaysInFrame("about:blank")).toBe(true);
    expect(askHtmlStaysInFrame("data:text/html,<p>x</p>")).toBe(true);
    expect(askHtmlStaysInFrame("https://example.test/")).toBe(false);
    expect(askHtmlStaysInFrame("robob://needs-you")).toBe(false);
  });
});

describe("batches", () => {
  it("names the asks one answer goes to", () => {
    expect(batchAll(1, 4)).toBe("this one");
    expect(batchAll(2, 2)).toBe("both");
    expect(batchAll(4, 4)).toBe("all 4");
    expect(batchAll(3, 4)).toBe("these 3");
    expect(batchPrimaryLabel("verdict", "Deploy", "all 4")).toBe("Deploy all 4");
    expect(batchPrimaryLabel("ack", "Approve", "both")).toBe("Seen, both");
    expect(batchPrimaryLabel("choose", "Approve", "these 3")).toBe("Send to these 3");
  });
});

describe("history", () => {
  it("splits what he answered into this session, today and earlier", () => {
    const answered = (number: number, at: string) =>
      entry(number, {
        closedAt: at,
        answer: { verdict: "approved", by: { _tag: "owner" }, at },
      } as Partial<KanbanOwnerAsk>);
    // Local midday on both days, so the split does not depend on the zone the test runs in.
    const today = new Date(NOW);
    today.setHours(12, 0, 0, 0);
    const yesterday = new Date(today.getTime() - 86_400_000);
    const sent = [
      { id: 1, kind: "answer", state: "sent" },
      { id: 2, kind: "hand", state: "sent" },
      { id: 3, kind: "answer", state: "held" },
    ] as unknown as ReadonlyArray<AskSend>;
    const rows = historyRows(
      [answered(1, today.toISOString()), answered(2, yesterday.toISOString()), entry(3)],
      sent,
      today.getTime(),
    );
    expect(rows.session.map((send) => send.id)).toEqual([2, 3]);
    expect(rows.today.map((row) => row.entry.cardNumber)).toEqual([1]);
    expect(rows.earlier.map((row) => row.entry.cardNumber)).toEqual([2]);
    expect(rows.today[0]?.outcome.label).toBe("Approved");
    expect(historyRows(null, [], NOW)).toEqual({ session: [], today: [], earlier: [] });
  });
});

describe("answers made offline", () => {
  it("go again once each time the feed comes back, and not while it reads fine", () => {
    const gate = unreachedRetryGate();
    // The send failed but the feed still reads: he retries by hand.
    expect(gate.next({ reading: true, owed: true })).toBe(false);
    // Offline: the feed fails too.
    expect(gate.next({ reading: false, owed: true })).toBe(false);
    // Back: one automatic try.
    expect(gate.next({ reading: true, owed: true })).toBe(true);
    expect(gate.next({ reading: true, owed: true })).toBe(false);
  });

  it("does nothing when no answer has automatic tries left", () => {
    const gate = unreachedRetryGate();
    expect(gate.next({ reading: false, owed: false })).toBe(false);
    expect(gate.next({ reading: true, owed: false })).toBe(false);
    // The answer is on its way, so nothing is owed for a moment: that resets nothing.
    expect(gate.next({ reading: false, owed: true })).toBe(false);
    expect(gate.next({ reading: true, owed: true })).toBe(true);
  });
});
