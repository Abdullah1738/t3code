import { describe, expect, it } from "vite-plus/test";

import type { TimelineEntry, WorkLogEntry } from "../../session-logic";
import type { ChatMessage } from "../../types";
import { buildIMessageChatRows, imessageDayKey } from "./imessageChatRows";

const morning = new Date(2026, 9, 20, 9, 0).toISOString();
const noon = new Date(2026, 9, 20, 12, 0).toISOString();
const nextDay = new Date(2026, 9, 21, 8, 0).toISOString();

function message(id: string, role: "user" | "assistant", createdAt: string): TimelineEntry {
  const chatMessage = {
    id,
    role,
    text: id,
    runId: null,
    streaming: false,
    createdAt,
    updatedAt: createdAt,
  } as unknown as ChatMessage;
  return { id, kind: "message", createdAt, message: chatMessage };
}

function work(id: string, createdAt: string): TimelineEntry {
  const entry = { id, createdAt, label: id, tone: "tool" } as unknown as WorkLogEntry;
  return { id, kind: "work", createdAt, entry };
}

describe("buildIMessageChatRows", () => {
  it("collapses agent work between an incoming message and its reply into one agent row", () => {
    const rows = buildIMessageChatRows(
      [
        message("in", "user", morning),
        work("w1", morning),
        work("w2", noon),
        message("out", "assistant", noon),
      ],
      null,
    );

    expect(rows.map((row) => row.kind)).toEqual(["divider", "incoming", "agent", "reply"]);
    const agent = rows[2];
    expect(agent).toMatchObject({ kind: "agent", startedAt: morning, endedAt: noon });
    expect(agent?.kind === "agent" ? agent.work.map((entry) => entry.id) : []).toEqual([
      "w1",
      "w2",
    ]);
  });

  it("adds a divider when the day changes, and none when the previous thread is the same day", () => {
    const sameDay = buildIMessageChatRows(
      [message("in", "user", morning)],
      imessageDayKey(morning),
    );
    expect(sameDay.map((row) => row.kind)).toEqual(["incoming"]);

    const nextDayRows = buildIMessageChatRows(
      [message("in", "user", nextDay)],
      imessageDayKey(morning),
    );
    expect(nextDayRows.map((row) => row.kind)).toEqual(["divider", "incoming"]);
  });

  it("drops system messages and leaves no empty agent row", () => {
    const system = message("sys", "user", morning);
    if (system.kind !== "message") throw new Error("expected a message entry");
    const rows = buildIMessageChatRows(
      [{ ...system, message: { ...system.message, role: "system" } as ChatMessage }],
      imessageDayKey(morning),
    );
    expect(rows).toEqual([]);
  });
});
