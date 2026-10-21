import { imessageDayKey } from "@t3tools/client-runtime/ardud/imessage";
import { describe, expect, it } from "vite-plus/test";

import type { TimelineEntry, WorkLogEntry } from "../../session-logic";
import type { ChatMessage } from "../../types";
import { buildIMessageChatRows, type IMessageChatRowOptions } from "./imessageChatRows";

const morning = new Date(2026, 9, 20, 9, 0).toISOString();
const noon = new Date(2026, 9, 20, 12, 0).toISOString();
const nextDay = new Date(2026, 9, 21, 8, 0).toISOString();

const GUIDANCE =
  "[Channel guidance from the iMessage bridge, not typed by the owner]\nKeep replies short.\n[End of channel guidance. The owner's message follows.]\n\n";

const ownerChat: IMessageChatRowOptions = {
  previousDayKey: null,
  namedSenders: false,
  activeRunId: null,
};

function message(
  id: string,
  role: "user" | "assistant",
  text: string,
  runId: string,
  createdAt = morning,
  extra: Partial<ChatMessage> = {},
): TimelineEntry {
  const chatMessage = {
    id,
    role,
    text,
    runId,
    streaming: false,
    createdAt,
    updatedAt: createdAt,
    ...extra,
  } as unknown as ChatMessage;
  return { id, kind: "message", createdAt, message: chatMessage };
}

function work(id: string, runId: string, createdAt = morning): TimelineEntry {
  const entry = {
    id,
    createdAt,
    runId,
    label: `ran ${id}`,
    tone: "tool",
  } as unknown as WorkLogEntry;
  return { id, kind: "work", createdAt, entry };
}

const kinds = (rows: ReturnType<typeof buildIMessageChatRows>) => rows.map((row) => row.kind);

describe("buildIMessageChatRows", () => {
  it("shows typed text as a bubble and only the turn's final assistant message as the reply", () => {
    const rows = buildIMessageChatRows(
      [
        message("in", "user", `${GUIDANCE}Add these to food db`, "r1"),
        work("w1", "r1"),
        message("draft", "assistant", "Reading the labels first.", "r1"),
        work("w2", "r1", noon),
        message("out", "assistant", "Saved all three.", "r1", noon),
      ],
      ownerChat,
    );

    expect(kinds(rows)).toEqual(["divider", "incoming", "agent", "reply"]);
    expect(rows[1]).toMatchObject({ text: "Add these to food db", sender: null });
    expect(rows[2]).toMatchObject({ outcome: "replied", startedAt: morning, endedAt: noon });
    const agent = rows[2];
    expect(agent?.kind === "agent" ? agent.steps.map((step) => step.label) : []).toEqual([
      "Channel guidance",
      "ran w1",
      "ran w2",
      "Text not sent",
    ]);
    expect(rows[3]).toMatchObject({ kind: "reply", text: "Saved all three." });
  });

  it("never turns NO_REPLY into a bubble", () => {
    const rows = buildIMessageChatRows(
      [
        message("in", "user", "Yeah please", "r1"),
        message("out", "assistant", "NO_REPLY", "r1"),
        message("in2", "user", "Thanks", "r2"),
        message("out2", "assistant", "Noted for later.\n\nNO_REPLY", "r2"),
      ],
      ownerChat,
    );

    expect(kinds(rows)).toEqual(["divider", "incoming", "agent", "incoming", "agent"]);
    expect(rows[2]).toMatchObject({ outcome: "no-reply", steps: [] });
    expect(rows[4]).toMatchObject({ outcome: "no-reply" });
  });

  it("shows a watcher event as an event line and folds its frame into the agent details", () => {
    const watcher =
      "[Watcher event from robob-watch inbox-triage, not typed by the owner. Handle it; reply only if the owner needs to know or act now, otherwise log it to the activity log and end with NO_REPLY.]\nApple charge alert\n\nEvent:\n{}";
    const rows = buildIMessageChatRows(
      [message("in", "user", watcher, "r1", morning, { createdBy: "system" }), work("w", "r1")],
      { ...ownerChat, previousDayKey: imessageDayKey(morning) },
    );

    expect(kinds(rows)).toEqual(["event", "agent"]);
    expect(rows[0]).toMatchObject({ source: "inbox-triage", title: "Apple charge alert" });
    const agent = rows[1];
    expect(agent?.kind === "agent" ? agent.steps[0]?.detail : null).toBe(watcher);
  });

  it("hides bridge requests and agent prompts from the conversation", () => {
    const rows = buildIMessageChatRows(
      [
        message(
          "nudge",
          "user",
          "[Bridge request, not typed by the owner.] Say hi in the new chat. End with NO_REPLY.",
          "r1",
        ),
        message("out", "assistant", "NO_REPLY", "r1"),
        message("ask", "user", "Book Moni's ride", "r2", morning, { createdBy: "agent" }),
        message("out2", "assistant", "Booked.", "r2"),
      ],
      { ...ownerChat, previousDayKey: imessageDayKey(morning) },
    );

    expect(kinds(rows)).toEqual(["agent", "agent", "reply"]);
    const labels = rows.flatMap((row) =>
      row.kind === "agent" ? row.steps.map((step) => step.label) : [],
    );
    expect(labels).toEqual(["Bridge request", "Prompt from an agent"]);
  });

  it("keeps a run that a finished subagent started as its own turn", () => {
    const notification = {
      id: "note",
      kind: "work",
      createdAt: noon,
      entry: {
        id: "note",
        createdAt: noon,
        runId: "r2",
        label: 'Subagent "Reconcile order" finished',
        tone: "info",
      } as unknown as WorkLogEntry,
    } satisfies TimelineEntry;
    const rows = buildIMessageChatRows(
      [
        message("in", "user", "Order the PSL", "r1"),
        message("out", "assistant", "On it.", "r1"),
        notification,
        message("out2", "assistant", "Ordered.", "r2", noon),
      ],
      ownerChat,
    );

    expect(kinds(rows)).toEqual(["divider", "incoming", "reply", "agent", "reply"]);
    expect(rows[4]).toMatchObject({ text: "Ordered." });
  });

  it("holds back the reply while the run is still working", () => {
    const rows = buildIMessageChatRows(
      [message("in", "user", "Hi", "r1"), message("draft", "assistant", "Hello", "r1")],
      { ...ownerChat, activeRunId: "r1" },
    );

    expect(kinds(rows)).toEqual(["divider", "incoming", "agent"]);
    expect(rows[2]).toMatchObject({ outcome: "working" });
  });

  it("adds a divider only when the day changes from the thread above", () => {
    const sameDay = buildIMessageChatRows(
      [message("in", "user", "Hi", "r1"), message("out", "assistant", "Hey", "r1")],
      { ...ownerChat, previousDayKey: imessageDayKey(morning) },
    );
    expect(kinds(sameDay)).toEqual(["incoming", "reply"]);

    const rows = buildIMessageChatRows(
      [
        message("a", "user", "Hi", "r1"),
        message("a-out", "assistant", "Hey", "r1"),
        message("b", "user", "Morning", "r2", nextDay),
        message("b-out", "assistant", "Morning!", "r2", nextDay),
      ],
      { ...ownerChat, previousDayKey: imessageDayKey(morning) },
    );
    expect(kinds(rows)).toEqual(["incoming", "reply", "divider", "incoming", "reply"]);
  });

  it("puts each member's name above their bubble in a group, once per run of lines", () => {
    const rows = buildIMessageChatRows(
      [
        message("in", "user", "Moni: When come pls\nSara: Same here\nSara: Any news?", "r1"),
        message("out", "assistant", "NO_REPLY", "r1"),
      ],
      { ...ownerChat, namedSenders: true },
    );

    const bubbles = rows.filter((row) => row.kind === "incoming");
    expect(bubbles.map((row) => [row.sender, row.text, row.senderChanged] as const)).toEqual([
      ["Moni", "When come pls", true],
      ["Sara", "Same here", true],
      ["Sara", "Any news?", false],
    ]);
  });
});
