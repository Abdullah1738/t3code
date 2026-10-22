// @effect-diagnostics globalDate:off -- Tests exercise local calendar day boundaries.
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  buildIMessageChatRows,
  formatIMessageDuration,
  imessageAgentSummary,
  type IMessageChatRow,
  type IMessageChatRowOptions,
  type IMessageTimelineEntry,
  type IMessageTimelineMessage,
} from "./chatRows.ts";
import { imessageDayKey } from "./threadWindow.ts";

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
  extra: Partial<IMessageTimelineMessage> = {},
): IMessageTimelineEntry {
  const chatMessage: IMessageTimelineMessage = {
    id,
    role,
    text,
    runId,
    streaming: false,
    createdAt,
    updatedAt: createdAt,
    ...extra,
  };
  return { id, kind: "message", createdAt, message: chatMessage };
}

function work(id: string, runId: string, createdAt = morning): IMessageTimelineEntry {
  return { id, kind: "work", createdAt, entry: { id, runId, label: `ran ${id}`, tone: "tool" } };
}

const kinds = (rows: ReadonlyArray<IMessageChatRow>) => rows.map((row) => row.kind);
const stepsOf = (row: IMessageChatRow | undefined) => (row?.kind === "agent" ? row.steps : []);

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

    expect(kinds(rows)).toEqual(["divider", "time", "incoming", "agent", "reply"]);
    expect(rows[1]).toMatchObject({ createdAt: morning });
    expect(rows[2]).toMatchObject({ text: "Add these to food db", sender: null });
    expect(rows[3]).toMatchObject({ outcome: "replied", startedAt: morning, endedAt: noon });
    expect(stepsOf(rows[3]).map((step) => [step.label, step.text])).toEqual([
      ["Channel guidance", "iMessage bridge rules, 19 characters"],
      ["Tool", "ran w1"],
      ["Tool", "ran w2"],
      ["Text not sent", "Reading the labels first."],
    ]);
    expect(stepsOf(rows[3])[0]?.detail).toBe("Keep replies short.");
    expect(rows[4]).toMatchObject({ kind: "reply", text: "Saved all three." });
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

    expect(kinds(rows)).toEqual([
      "divider",
      "time",
      "incoming",
      "agent",
      "time",
      "incoming",
      "agent",
    ]);
    expect(rows[3]).toMatchObject({ outcome: "no-reply", steps: [] });
    expect(rows[6]).toMatchObject({ outcome: "no-reply" });
  });

  it("shows a watcher event as an event line and folds its frame into the agent details", () => {
    const watcher =
      "[Watcher event from robob-watch inbox-triage, not typed by the owner. Handle it; reply only if the owner needs to know or act now, otherwise log it to the activity log and end with NO_REPLY.]\nApple charge alert\n\nEvent:\n{}";
    const rows = buildIMessageChatRows(
      [message("in", "user", watcher, "r1", morning, { createdBy: "system" }), work("w", "r1")],
      { ...ownerChat, previousDayKey: imessageDayKey(morning) },
    );

    expect(kinds(rows)).toEqual(["time", "event", "agent"]);
    expect(rows[1]).toMatchObject({ source: "inbox-triage", title: "Apple charge alert" });
    expect(stepsOf(rows[2])[0]).toMatchObject({
      label: "Watcher event",
      text: "inbox-triage · Apple charge alert",
      detail: watcher,
    });
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

    expect(kinds(rows)).toEqual(["time", "agent", "time", "agent", "reply"]);
    const labels = rows.flatMap((row) => stepsOf(row).map((step) => step.label));
    expect(labels).toEqual(["Bridge request", "Agent prompt"]);
  });

  it("keeps a run that a finished subagent started as its own turn", () => {
    const notification = {
      id: "note",
      kind: "work",
      createdAt: noon,
      entry: {
        id: "note",
        runId: "r2",
        label: 'Subagent "Reconcile order" finished',
        tone: "info",
      },
    } satisfies IMessageTimelineEntry;
    const rows = buildIMessageChatRows(
      [
        message("in", "user", "Order the PSL", "r1"),
        message("out", "assistant", "On it.", "r1"),
        notification,
        message("out2", "assistant", "Ordered.", "r2", noon),
      ],
      ownerChat,
    );

    expect(kinds(rows)).toEqual(["divider", "time", "incoming", "reply", "time", "agent", "reply"]);
    expect(rows[6]).toMatchObject({ text: "Ordered." });
  });

  it("holds back the reply while the run is still working", () => {
    const rows = buildIMessageChatRows(
      [message("in", "user", "Hi", "r1"), message("draft", "assistant", "Hello", "r1")],
      { ...ownerChat, activeRunId: "r1" },
    );

    expect(kinds(rows)).toEqual(["divider", "time", "incoming", "agent"]);
    expect(rows[3]).toMatchObject({ outcome: "working" });
  });

  it("adds a divider only when the day changes from the thread above", () => {
    const sameDay = buildIMessageChatRows(
      [message("in", "user", "Hi", "r1"), message("out", "assistant", "Hey", "r1")],
      { ...ownerChat, previousDayKey: imessageDayKey(morning) },
    );
    expect(kinds(sameDay)).toEqual(["time", "incoming", "reply"]);

    const rows = buildIMessageChatRows(
      [
        message("a", "user", "Hi", "r1"),
        message("a-out", "assistant", "Hey", "r1"),
        message("b", "user", "Morning", "r2", nextDay),
        message("b-out", "assistant", "Morning!", "r2", nextDay),
      ],
      { ...ownerChat, previousDayKey: imessageDayKey(morning) },
    );
    expect(kinds(rows)).toEqual([
      "time",
      "incoming",
      "reply",
      "divider",
      "time",
      "incoming",
      "reply",
    ]);
  });

  it("puts each member's name above their bubble, once per run of lines in a turn", () => {
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

  it("names the sender again at the start of each turn", () => {
    const rows = buildIMessageChatRows(
      [
        message("a", "user", "Moni: Hi", "r1"),
        message("a-out", "assistant", "Hey", "r1"),
        message("b", "user", "Moni: Still there?", "r2"),
        message("b-out", "assistant", "NO_REPLY", "r2"),
      ],
      { ...ownerChat, namedSenders: true },
    );

    const bubbles = rows.filter((row) => row.kind === "incoming");
    expect(bubbles.map((row) => row.senderChanged)).toEqual([true, true]);
  });

  it("shows commands with their run time", () => {
    const started = DateTime.makeUnsafe("2026-10-20T09:00:00Z");
    const completed = DateTime.makeUnsafe("2026-10-20T09:00:02Z");
    const command = {
      id: "cmd",
      kind: "work",
      createdAt: morning,
      entry: {
        id: "cmd",
        runId: "r1",
        label: "Ran command",
        command: "wa read thomas | tail -8",
        tone: "tool",
        structuredPayload: { startedAt: started, completedAt: completed },
      },
    } satisfies IMessageTimelineEntry;
    const rows = buildIMessageChatRows(
      [
        message("in", "user", "Did Thomas reply?", "r1"),
        command,
        message("out", "assistant", "Yes.", "r1"),
      ],
      ownerChat,
    );

    expect(stepsOf(rows[3])).toEqual([
      {
        id: "cmd",
        label: "Ran",
        text: "wa read thomas | tail -8",
        detail: null,
        code: true,
        seconds: 2,
        error: false,
      },
    ]);
  });
});

describe("imessageAgentSummary", () => {
  const step = {
    id: "s",
    label: "Ran",
    text: "ls",
    detail: null,
    code: true,
    seconds: 1,
    error: false,
  };

  it("reads like the chip: outcome, step count, then time taken", () => {
    expect(
      imessageAgentSummary({
        steps: [step, step, step],
        outcome: "replied",
        startedAt: "2026-10-20T09:00:00.000Z",
        endedAt: "2026-10-20T09:01:22.000Z",
      }),
    ).toBe("Agent · 3 steps · 1m 22s");
    expect(
      imessageAgentSummary({
        steps: [],
        outcome: "no-reply",
        startedAt: "2026-10-20T09:00:00.000Z",
        endedAt: "2026-10-20T09:00:00.000Z",
      }),
    ).toBe("No reply");
  });
});

describe("formatIMessageDuration", () => {
  it("keeps seconds under an hour and drops them past it", () => {
    expect([0.2, 9, 60, 82, 3600, 3725].map(formatIMessageDuration)).toEqual([
      "<1s",
      "9s",
      "1m",
      "1m 22s",
      "1h",
      "1h 2m",
    ]);
  });
});
