import type { KanbanCard, KanbanCardEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { cardHistory, cardStateView, drawerCard } from "./cardDetail.ts";
import type { TileLine, TilePlace } from "./tilePlace.ts";

function card(patch: Partial<KanbanCard> = {}): KanbanCard {
  return {
    id: "card-1",
    boardId: "board-toy",
    number: 1,
    title: "Card 1",
    description: "",
    prompt: "",
    stage: "todo",
    priority: 3,
    subtasks: [],
    asks: [],
    links: [],
    stalled: null,
    question: null,
    wakeNote: null,
    settledAt: null,
    updatedAt: "2026-10-25T10:00:00.000Z",
    movedAt: "2026-10-25T10:00:00.000Z",
    ...patch,
  } as KanbanCard;
}

const subtask = (id: string, text: string, note: string | null = null) =>
  ({ id, text, note, step: 1, owner: "work", state: "open" }) as never;

describe("drawerCard", () => {
  it("is not loaded until the full card arrives, so a blank description isn't taken for none", () => {
    const feed = card();
    expect(drawerCard(feed, undefined)).toEqual({ card: feed, loaded: false });
    // A detail for another card (the drawer just switched) is not this card's.
    expect(drawerCard(feed, card({ id: "card-2" as never, description: "Other" })).loaded).toBe(
      false,
    );
  });

  it("shows the full card once it is as new as the feed's copy", () => {
    const feed = card();
    const full = card({ description: "Why this matters", prompt: "Do it" });
    const shown = drawerCard(feed, full);
    expect(shown.loaded).toBe(true);
    expect(shown.card).toBe(full);
  });

  it("keeps the feed's newer state and puts back the texts the feed trims", () => {
    const long = "x".repeat(600);
    const feed = card({
      stage: "working",
      updatedAt: "2026-10-25T11:00:00.000Z",
      title: long.slice(0, 512),
      wakeNote: "pending",
      question: "Which queue",
      subtasks: [subtask("s1", "Write the migra"), subtask("s2", "New in the feed")],
      asks: [{ id: "a1", text: "Short", closedAt: null } as never],
    });
    const full = card({
      title: long,
      description: "Why this matters",
      prompt: "Do it",
      wakeNote: "Resume after the deploy",
      question: "Which queue should it use?",
      subtasks: [subtask("s1", "Write the migration", "ran on staging")],
      asks: [{ id: "a1", text: "Shorter than you think", closedAt: null } as never],
    });
    const shown = drawerCard(feed, full);
    expect(shown.loaded).toBe(true);
    expect(shown.card.stage).toBe("working");
    expect(shown.card.title).toBe(long);
    expect(shown.card.description).toBe("Why this matters");
    expect(shown.card.prompt).toBe("Do it");
    expect(shown.card.wakeNote).toBe("Resume after the deploy");
    expect(shown.card.question).toBe("Which queue should it use?");
    expect(shown.card.subtasks.map((entry) => [entry.text, entry.note])).toEqual([
      ["Write the migration", "ran on staging"],
      ["New in the feed", null],
    ]);
    expect(shown.card.asks[0]?.text).toBe("Shorter than you think");
  });

  it("does not put back a text that was rewritten since the full read", () => {
    const feed = card({ updatedAt: "2026-10-25T11:00:00.000Z", title: "Renamed" });
    const full = card({ title: "Old name", description: "Still the best we have" });
    const shown = drawerCard(feed, full);
    expect(shown.card.title).toBe("Renamed");
    expect(shown.card.description).toBe("Still the best we have");
  });
});

const place = (patch: Partial<TilePlace>): TilePlace => ({
  column: "todo",
  group: "ready",
  reason: null,
  line: null,
  edge: null,
  stuck: null,
  ...patch,
});

const LINE: TileLine = {
  icon: "pause",
  tone: "muted",
  lead: "Waiting on the author",
  since: "2026-10-20T10:00:00.000Z",
  sinceAs: "date",
  rest: "round-2 feedback",
  wake: "Wakes itself on the next push",
  wakeAt: null,
};

describe("cardStateView", () => {
  it("says what the tile says when the tile has a line", () => {
    const view = cardStateView(
      card({ stage: "in_review" }),
      place({ column: "in_review", group: "author", line: LINE }),
      3,
    );
    expect(view).toEqual({
      column: "In review, waiting",
      needsYou: false,
      line: LINE,
      plain: null,
      unblocks: 3,
    });
  });

  it("says in a sentence what a card with no line waits on", () => {
    const plain = (patch: Partial<TilePlace>, cardPatch: Partial<KanbanCard> = {}) =>
      cardStateView(card(cardPatch), place(patch), 0).plain;
    expect(plain({ column: "working", group: "running" })).toBe("Nothing. A worker is on it.");
    expect(plain({ column: "needs_review", group: "reviewing" })).toBe(
      "Nothing. A reviewer is on it.",
    );
    expect(plain({ column: "todo", group: "ready" })).toBe(
      "A free slot. Next up by what it unblocks.",
    );
    expect(plain({ column: "todo", group: "through" })).toBe(
      "A free slot. Next up by what it unblocks.",
    );
    expect(plain({ column: "needs_review", group: "next" })).toBe(
      "A free reviewer. Next up for review.",
    );
    expect(plain({ column: "shipped", group: "done" }, { stage: "deployed" })).toBe("Nothing");
  });

  it("names the column a shipped card is in by its stage", () => {
    expect(
      cardStateView(card({ stage: "verified" }), place({ column: "shipped", group: "done" }), 0)
        .column,
    ).toBe("Verified");
  });

  it("puts the reader's answer first on a card that needs them", () => {
    const ask = (id: string) => ({ id, text: "Which one", closedAt: null }) as never;
    const owner = place({ column: "needs_owner", group: "owner", line: LINE });
    const one = cardStateView(card({ asks: [ask("a1")] }), owner, 2);
    expect(one).toMatchObject({
      column: "Needs you",
      needsYou: true,
      line: null,
      plain: "Your answer to one ask",
      unblocks: 2,
    });
    expect(cardStateView(card({ asks: [ask("a1"), ask("a2")] }), owner, 0).plain).toBe(
      "Your answer to 2 asks",
    );
    expect(cardStateView(card({ stage: "needs_owner", question: "Go?" }), owner, 0).plain).toBe(
      "Your answer",
    );
  });

  it("waits on nothing once settled, whatever the tile would say", () => {
    const view = cardStateView(
      card({ stage: "verified", settledAt: "2026-10-26T10:00:00.000Z" as never }),
      place({ column: "needs_owner", group: "owner", line: LINE }),
      4,
    );
    expect(view).toMatchObject({
      needsYou: false,
      line: null,
      plain: "Nothing. It is settled.",
      unblocks: 0,
    });
  });
});

let nextEventId = 1;
const event = (
  kind: string,
  body: string | null,
  patch: Partial<KanbanCardEvent> = {},
): KanbanCardEvent =>
  ({
    id: nextEventId++,
    cardId: "card-1",
    at: "2026-10-25T10:00:00.000Z",
    actor: { _tag: "system", component: "board" },
    kind,
    fromStage: null,
    toStage: null,
    body,
    head: null,
    ...patch,
  }) as KanbanCardEvent;

const said = (events: ReadonlyArray<KanbanCardEvent>) =>
  cardHistory(events).map((line) => [
    line.kind,
    line.parts.map((part) => (typeof part === "string" ? part : `<${part.at}>`)).join(""),
    line.moved,
  ]);

describe("cardHistory", () => {
  it("lists newest first and leaves out what has its own place in the drawer", () => {
    const lines = said([
      event("created", null, { toStage: "todo" }),
      event("thread", "work thread t1"),
      event("moved", "started", { fromStage: "todo", toStage: "working" }),
      event("comment", "Looks good"),
      event("subtask", "s1 done: write it"),
      event("linked", "https://example.test/pull/4"),
      event("moved", null, { fromStage: "working", toStage: "needs_review" }),
    ]);
    expect(lines).toEqual([
      ["move", "Working → Needs Review", null],
      ["move", "To-Do → Working", null],
      ["plain", "Created", null],
    ]);
  });

  it("reads wait events stored as plain edits by their wording", () => {
    const lines = said([
      event("edited", "Waiting for trading-core#544 to merge: the fix rides on it"),
      event("edited", "Wait ended: trading-core#544 merged", {
        fromStage: "in_review",
        toStage: "todo",
      }),
      event("edited", "Waiting until 2026-11-14T05:00:00.000Z: recheck the soak"),
      event("edited", "Wait expired: 3d on a push that never came"),
      event("edited", "Wait check failing: 3 failures in a row while waiting for ci: 502"),
      event("edited", "No longer held for the evaluator: the card carries on"),
      event("edited", "Wait ended: cleared by hand (was waiting for #12 to be done)"),
    ]);
    expect(lines).toEqual([
      ["wake", "Wait ended: cleared by hand (was waiting for #12 to be done)", null],
      ["wake", "No longer held for the evaluator: the card carries on", null],
      ["expired", "Wait check failing: 3 failures in a row while waiting for ci: 502", null],
      ["expired", "Wait expired: 3d on a push that never came", null],
      ["wait", "Waiting until <2026-11-14T05:00:00.000Z>: recheck the soak", null],
      ["wake", "Wait ended: trading-core#544 merged", "In Review → To-Do"],
      ["wait", "Waiting for trading-core#544 to merge: the fix rides on it", null],
    ]);
  });

  it("reads the same events under their own kinds", () => {
    const lines = said([
      event("wait_set", "Waiting for the author to push"),
      event("wait_cleared", "Wait ended: the author pushed", {
        fromStage: "in_review",
        toStage: "needs_review",
      }),
      event("wait_expired", "Wait expired: 2d on a merge"),
      // A newer server may word them differently: the kind decides, not the text.
      event("wait_set", "Parked behind the release"),
      event("wait_cleared", null),
    ]);
    expect(lines).toEqual([
      ["wake", "Wait ended", null],
      ["wait", "Parked behind the release", null],
      ["expired", "Wait expired: 2d on a merge", null],
      ["wake", "Wait ended: the author pushed", "In Review → Needs Review"],
      ["wait", "Waiting for the author to push", null],
    ]);
  });

  it("orders by when things happened, not by the order they were stored in", () => {
    const lines = said([
      event("edited", "Wait ended: pushed", { at: "2026-10-27T10:00:00.000Z" }),
      event("edited", "Waiting for the author to push", { at: "2026-10-26T10:00:00.000Z" }),
      event("created", null, { at: "2026-10-25T10:00:00.000Z" }),
    ]);
    expect(lines.map((line) => line[1])).toEqual([
      "Wait ended: pushed",
      "Waiting for the author to push",
      "Created",
    ]);
  });

  it("shows a kind it doesn't know as a plain line", () => {
    expect(
      said([event("other", "Rebased onto 2026-11-10T08:00:00Z"), event("other", null)]),
    ).toEqual([
      ["plain", "Update", null],
      ["plain", "Rebased onto <2026-11-10T08:00:00Z>", null],
    ]);
  });

  it("words flags, reviews and edits", () => {
    const lines = said([
      event("flagged", "worker stopped with no result"),
      event("flagged", "Cleared"),
      event("review", "clear", { fromStage: "in_review", toStage: "completed" }),
      // A finding that runs over two lines is still one finding.
      event("review", "- one\n  still the first\n- two", {
        fromStage: "in_review",
        toStage: "todo",
      }),
      event("edited", "Settled"),
      event("edited", "priority, title"),
      event("edited", null),
    ]);
    expect(lines).toEqual([
      ["plain", "Edited", null],
      ["plain", "Edited: priority, title", null],
      ["plain", "Settled", null],
      ["plain", "Review found 2 things", "In Review → To-Do"],
      ["plain", "Review passed", "In Review → Completed"],
      ["plain", "Flag cleared", null],
      ["flag", "Flagged: worker stopped with no result", null],
    ]);
  });
});
