// @effect-diagnostics globalDate:off -- Tests exercise local calendar day boundaries.
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  buildIMessageChatRows,
  formatIMessageDuration,
  imessageAgentSummary,
  imessageRowsAtLevel,
  type IMessageChatRow,
  type IMessageChatRowOptions,
  type IMessageTimelineEntry,
  type IMessageTimelineMessage,
} from "./chatRows.ts";
import { IMESSAGE_TOOL_MODE_MARKER } from "./sends.ts";
import { imessageDayKey } from "./threadWindow.ts";

const morning = new Date(2026, 9, 20, 9, 0).toISOString();
const noon = new Date(2026, 9, 20, 12, 0).toISOString();
const nextDay = new Date(2026, 9, 21, 8, 0).toISOString();

const GUIDANCE =
  "[Channel guidance from the iMessage bridge, not typed by the owner]\nKeep replies short.\n[End of channel guidance. The owner's message follows.]\n\n";
const TOOL_GUIDANCE = `[Channel guidance from the iMessage bridge, not typed by the owner]\n${IMESSAGE_TOOL_MODE_MARKER} Text with imessage_send.\n[End of channel guidance. The owner's message follows.]\n\n`;

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

function sendTool(
  id: string,
  runId: string,
  input: Record<string, unknown>,
  options: { createdAt?: string; status?: string; toolName?: string; output?: unknown } = {},
): IMessageTimelineEntry {
  const createdAt = options.createdAt ?? morning;
  return {
    id,
    kind: "work",
    createdAt,
    entry: {
      id,
      runId,
      label: "Sent an iMessage",
      tone: options.status === "failed" ? "error" : "tool",
      structuredPayload: {
        type: "dynamic_tool",
        toolName: options.toolName ?? "mcp__t3-code__imessage_send",
        status: options.status ?? "completed",
        input,
        ...(options.output === undefined ? {} : { output: options.output }),
        startedAt: null,
        completedAt: null,
      } as never,
    },
  };
}

function cliCommand(id: string, runId: string, command: string): IMessageTimelineEntry {
  return {
    id,
    kind: "work",
    createdAt: morning,
    entry: { id, runId, label: "Ran command", command, tone: "tool" },
  };
}

const build = (entries: ReadonlyArray<IMessageTimelineEntry>, options = ownerChat) =>
  buildIMessageChatRows(entries, options).rows;
const kinds = (rows: ReadonlyArray<IMessageChatRow>) => rows.map((row) => row.kind);
const stepsOf = (row: IMessageChatRow | undefined) => (row?.kind === "agent" ? row.turn.steps : []);
const replyText = (row: IMessageChatRow | undefined) =>
  row?.kind === "reply" ? row.send.text : null;

describe("buildIMessageChatRows before tool mode", () => {
  it("shows typed text as a bubble and only the turn's final assistant message as the reply", () => {
    const rows = build([
      message("in", "user", `${GUIDANCE}Add these to food db`, "r1"),
      work("w1", "r1"),
      message("draft", "assistant", "Reading the labels first.", "r1"),
      work("w2", "r1", noon),
      message("out", "assistant", "Saved all three.", "r1", noon),
    ]);

    expect(kinds(rows)).toEqual(["divider", "time", "incoming", "agent", "reply"]);
    expect(rows[2]).toMatchObject({ text: "Add these to food db", sender: null });
    const chip = rows[3];
    expect(chip?.kind === "agent" && chip.turn).toMatchObject({
      outcome: "replied",
      startedAt: morning,
      endedAt: noon,
      toolMode: false,
      sentCount: 1,
    });
    expect(stepsOf(chip).map((step) => [step.group, step.label, step.text])).toEqual([
      ["in", "Channel guidance", "iMessage bridge rules, 19 characters"],
      ["work", "Tool", "ran w1"],
      ["work", "Tool", "ran w2"],
      ["work", "Text not sent", "Reading the labels first."],
      ["work", "Sent", "Saved all three."],
    ]);
    expect(stepsOf(chip)[0]?.detail).toBe("Keep replies short.");
    expect(rows[4]).toMatchObject({
      kind: "reply",
      send: { text: "Saved all three.", via: "final" },
    });
  });

  it("never turns NO_REPLY into a bubble", () => {
    const rows = build([
      message("in", "user", "Yeah please", "r1"),
      message("out", "assistant", "NO_REPLY", "r1"),
      message("in2", "user", "Thanks", "r2"),
      message("out2", "assistant", "Noted for later.\n\nNO_REPLY", "r2"),
    ]);

    expect(kinds(rows)).toEqual([
      "divider",
      "time",
      "incoming",
      "agent",
      "time",
      "incoming",
      "agent",
    ]);
    expect(rows[3]?.kind === "agent" && rows[3].turn).toMatchObject({
      outcome: "no-reply",
      steps: [],
    });
    expect(rows[6]?.kind === "agent" && rows[6].turn.outcome).toBe("no-reply");
  });

  it("shows a watcher event as a system line and keeps its frame in the turn", () => {
    const watcher =
      "[Watcher event from robob-watch inbox-triage, not typed by the owner. Handle it; reply only if the owner needs to know or act now, otherwise log it to the activity log and end with NO_REPLY.]\nApple charge alert\n\nEvent:\n{}";
    const rows = build(
      [message("in", "user", watcher, "r1", morning, { createdBy: "system" }), work("w", "r1")],
      { ...ownerChat, previousDayKey: imessageDayKey(morning) },
    );

    expect(kinds(rows)).toEqual(["time", "event", "agent"]);
    expect(rows[1]).toMatchObject({
      level: "system",
      source: "inbox-triage",
      title: "Apple charge alert",
    });
    expect(stepsOf(rows[2])[0]).toMatchObject({
      group: "in",
      label: "Watcher event",
      text: "inbox-triage · Apple charge alert",
      detail: watcher,
    });
  });

  it("puts bridge requests and other agents' prompts on the system level", () => {
    const rows = build(
      [
        message(
          "nudge",
          "user",
          "[Bridge request, not typed by the owner.] Say hi in the new chat. End with NO_REPLY.",
          "r1",
        ),
        message("out", "assistant", "NO_REPLY", "r1"),
        message("ask", "user", "Book Moni's ride\nShe is at home.", "r2", morning, {
          createdBy: "agent",
        }),
        message("out2", "assistant", "Booked.", "r2"),
      ],
      { ...ownerChat, previousDayKey: imessageDayKey(morning) },
    );

    expect(kinds(rows)).toEqual(["time", "event", "agent", "time", "injected", "agent", "reply"]);
    expect(rows[1]).toMatchObject({
      source: "Bridge",
      title: "Say hi in the new chat. End with NO_REPLY.",
    });
    expect(rows[4]).toMatchObject({
      title: "Book Moni's ride",
      text: "Book Moni's ride\nShe is at home.",
    });
    expect(kinds(imessageRowsAtLevel(rows, "conversation"))).toEqual([
      "time",
      "agent",
      "time",
      "agent",
      "reply",
    ]);
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
    const rows = build([
      message("in", "user", "Order the PSL", "r1"),
      message("out", "assistant", "On it.", "r1"),
      notification,
      message("out2", "assistant", "Ordered.", "r2", noon),
    ]);

    expect(kinds(rows)).toEqual(["divider", "time", "incoming", "reply", "time", "agent", "reply"]);
    expect(replyText(rows[6])).toBe("Ordered.");
  });

  it("holds back the reply while the run is still working", () => {
    const rows = build(
      [message("in", "user", "Hi", "r1"), message("draft", "assistant", "Hello", "r1")],
      { ...ownerChat, activeRunId: "r1" },
    );

    expect(kinds(rows)).toEqual(["divider", "time", "incoming", "agent"]);
    expect(rows[3]?.kind === "agent" && rows[3].turn.outcome).toBe("working");
  });

  it("shows a file the agent sent through the bridge CLI", () => {
    const rows = build([
      message("in", "user", "Send me the card", "r1"),
      cliCommand(
        "cli",
        "r1",
        `bun ~/.local/share/spectrum-bridge/src/cli.ts send-file --file /tmp/x/card.png --text "Here's today's card." --key k --session s@3`,
      ),
      message("out", "assistant", "Sent.", "r1"),
    ]);

    expect(kinds(rows)).toEqual(["divider", "time", "incoming", "agent", "reply", "reply"]);
    expect(rows[4]).toMatchObject({
      send: { text: "Here's today's card.", file: "card.png", via: "cli", state: "sent" },
    });
  });

  it("adds a divider only when the day changes from the thread above", () => {
    const sameDay = build(
      [message("in", "user", "Hi", "r1"), message("out", "assistant", "Hey", "r1")],
      { ...ownerChat, previousDayKey: imessageDayKey(morning) },
    );
    expect(kinds(sameDay)).toEqual(["time", "incoming", "reply"]);

    const rows = build(
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
    const rows = build(
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
    const rows = build([
      message("in", "user", "Did Thomas reply?", "r1"),
      command,
      message("out", "assistant", "Yes.", "r1"),
    ]);

    expect(stepsOf(rows[3])[0]).toEqual({
      id: "cmd",
      group: "work",
      label: "Ran",
      text: "wa read thomas | tail -8",
      detail: null,
      code: true,
      seconds: 2,
      error: false,
      at: morning,
    });
  });
});

describe("buildIMessageChatRows in tool mode", () => {
  it("shows the tool's texts in order and keeps the final message as a note", () => {
    const result = buildIMessageChatRows(
      [
        message("in", "user", `${TOOL_GUIDANCE}Table at Zuma tomorrow at 8?`, "r1"),
        sendTool("s1", "r1", { text: "On it, checking Zuma now." }),
        work("w1", "r1"),
        sendTool("s2", "r1", { text: "20:00 or 20:30. Book 20:00?" }, { createdAt: noon }),
        message("out", "assistant", "Waiting on his pick.", "r1", noon),
      ],
      ownerChat,
    );
    const { rows } = result;

    expect(result.toolMode).toBe(true);
    expect(kinds(rows)).toEqual(["divider", "time", "incoming", "agent", "reply", "reply", "note"]);
    expect(rows.slice(4, 6).map(replyText)).toEqual([
      "On it, checking Zuma now.",
      "20:00 or 20:30. Book 20:00?",
    ]);
    expect(rows[6]).toMatchObject({ level: "everything", text: "Waiting on his pick." });
    const chip = rows[3];
    expect(chip?.kind === "agent" && chip.turn).toMatchObject({
      outcome: "replied",
      sentCount: 2,
      toolMode: true,
    });
    expect(stepsOf(chip).map((step) => [step.group, step.label])).toEqual([
      ["in", "Channel guidance"],
      ["work", "Sent"],
      ["work", "Tool"],
      ["work", "Sent"],
      ["note", "Agent note"],
    ]);
    expect(kinds(imessageRowsAtLevel(rows, "conversation"))).not.toContain("note");
  });

  it("stays in tool mode for later turns that carry no guidance", () => {
    const rows = build([
      message("in", "user", `${TOOL_GUIDANCE}Hi`, "r1"),
      sendTool("s1", "r1", { text: "Hey" }),
      message("out", "assistant", "Done.", "r1"),
      work("sub", "r2", noon),
      message("out2", "assistant", "The order went through.", "r2", noon),
    ]);

    expect(kinds(rows)).toEqual([
      "divider",
      "time",
      "incoming",
      "agent",
      "reply",
      "note",
      "time",
      "agent",
      "note",
    ]);
    const chip = rows[7];
    expect(chip?.kind === "agent" && chip.turn.outcome).toBe("no-reply");
  });

  it("marks a failed send and does not count it", () => {
    const rows = build([
      message("in", "user", `${TOOL_GUIDANCE}Hi`, "r1"),
      sendTool("s1", "r1", { text: "Hey" }, { status: "failed" }),
      message("out", "assistant", "Could not send.", "r1"),
    ]);

    expect(rows[4]).toMatchObject({ kind: "reply", send: { state: "failed" } });
    const chip = rows[3];
    expect(chip?.kind === "agent" && chip.turn).toMatchObject({
      outcome: "no-reply",
      errorCount: 1,
    });
  });

  it("reads OpenCode's per-thread tool names, files and other chats", () => {
    const rows = build([
      message("in", "user", `${TOOL_GUIDANCE}Tell Moni`, "r1"),
      sendTool(
        "s1",
        "r1",
        { text: "Abdullah says hi", to: "moni" },
        { toolName: "t3-code-thread_abc_imessage_send" },
      ),
      sendTool("s2", "r1", { file: "/Users/x/card.png" }),
      message("out", "assistant", "NO_REPLY", "r1"),
    ]);

    expect(
      rows.filter((row) => row.kind === "reply").map((row) => row.kind === "reply" && row.send),
    ).toMatchObject([
      { text: "Abdullah says hi", to: "moni", via: "tool" },
      { text: "", file: "card.png" },
    ]);
    expect(kinds(rows)).not.toContain("note");
  });

  it("keeps everything the agent wrote while the turn runs out of the chat", () => {
    const rows = build(
      [
        message("in", "user", `${TOOL_GUIDANCE}Hi`, "r1"),
        sendTool("s1", "r1", { text: "On it" }),
        message("draft", "assistant", "Checking now", "r1"),
      ],
      { ...ownerChat, activeRunId: "r1" },
    );

    expect(kinds(rows)).toEqual(["divider", "time", "incoming", "agent", "reply"]);
    expect(stepsOf(rows[3]).at(-1)).toMatchObject({ label: "Agent text", text: "Checking now" });
  });

  it("shows retries the bridge deduplicated as one sent message", () => {
    const outbox = `send:${"a".repeat(64)}`;
    const ack = (created: boolean) => ({
      content: [{ type: "text", text: JSON.stringify({ id: outbox, created, chat: "owner" }) }],
    });
    const result = buildIMessageChatRows(
      [
        message("in", "user", `${TOOL_GUIDANCE}Hi`, "r1"),
        sendTool("s1", "r1", { text: "On it" }, { output: ack(true) }),
        sendTool(
          "s2",
          "r1",
          { text: "On it" },
          { output: { structuredContent: { id: outbox, created: false, chat: "owner" } } },
        ),
        message("out", "assistant", "NO_REPLY", "r1"),
        message("in2", "user", `${TOOL_GUIDANCE}Again?`, "r2", noon),
        sendTool("s3", "r2", { text: "On it" }, { createdAt: noon, output: ack(false) }),
        message("out2", "assistant", "NO_REPLY", "r2", noon),
      ],
      ownerChat,
    );
    const replies = result.rows.filter((row) => row.kind === "reply");
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ send: { outboxId: outbox, state: "sent" } });
    const [first, second] = [...result.turns.values()];
    expect(first?.sentCount).toBe(1);
    // Both attempts stay in the inspector.
    expect(first?.steps.filter((step) => step.send !== undefined)).toHaveLength(2);
    expect(second?.sentCount).toBe(0);
  });

  it("drops a timed-out attempt that a later deduplicated retry sent", () => {
    const outbox = `send:${"b".repeat(64)}`;
    const result = buildIMessageChatRows(
      [
        message("in", "user", `${TOOL_GUIDANCE}Hi`, "r1"),
        sendTool("s1", "r1", { text: "On it" }, { status: "failed" }),
        sendTool(
          "s2",
          "r1",
          { text: "On it" },
          { output: { id: outbox, created: false, chat: "owner" } },
        ),
        message("out", "assistant", "NO_REPLY", "r1"),
      ],
      ownerChat,
    );
    const replies = result.rows.filter((row) => row.kind === "reply");
    expect(replies.map((row) => row.kind === "reply" && row.send.state)).toEqual(["sent"]);
    expect([...result.turns.values()][0]?.sentCount).toBe(1);
  });
});

describe("imessageAgentSummary", () => {
  const step = {
    id: "s",
    group: "work" as const,
    label: "Ran",
    text: "ls",
    detail: null,
    code: true,
    seconds: 1,
    error: false,
    at: null,
  };

  it("reads like the chip: outcome, step count, time taken, then texts sent", () => {
    expect(
      imessageAgentSummary({
        steps: [step, step, step],
        outcome: "replied",
        startedAt: "2026-10-20T09:00:00.000Z",
        endedAt: "2026-10-20T09:01:22.000Z",
        sentCount: 2,
      }),
    ).toBe("Agent · 3 steps · 1m 22s · 2 sent");
    expect(
      imessageAgentSummary({
        steps: [],
        outcome: "no-reply",
        startedAt: "2026-10-20T09:00:00.000Z",
        endedAt: "2026-10-20T09:00:00.000Z",
        sentCount: 0,
      }),
    ).toBe("No text sent");
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
