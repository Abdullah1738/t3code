import type { KanbanCard } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { drawerCard } from "./cardDetail.ts";

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
