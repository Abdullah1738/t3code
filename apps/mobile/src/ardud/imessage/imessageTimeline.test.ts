import {
  MessageId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { buildIMessageChatRows } from "@t3tools/client-runtime/ardud/imessage";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { imessageTimelineEntries } from "./imessageTimeline";

const threadId = ThreadId.make("thread-imessage");
const runId = RunId.make("run-1");

function base(id: string, ordinal: number, startedAt: string, completedAt = startedAt) {
  return {
    id: TurnItemId.make(id),
    threadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: DateTime.makeUnsafe(startedAt),
    completedAt: DateTime.makeUnsafe(completedAt),
    updatedAt: DateTime.makeUnsafe(completedAt),
  };
}

function projected(item: OrchestrationV2TurnItem, position: number) {
  return {
    position,
    visibility: "local",
    sourceThreadId: threadId,
    sourceItemId: item.id,
    item,
  } satisfies OrchestrationV2ProjectedTurnItem;
}

function entriesOf(items: ReadonlyArray<OrchestrationV2TurnItem>) {
  return imessageTimelineEntries(items.map((item, index) => projected(item, index)));
}

function rowsOf(items: ReadonlyArray<OrchestrationV2TurnItem>, activeRunId: string | null = null) {
  return buildIMessageChatRows(entriesOf(items), {
    previousDayKey: null,
    namedSenders: false,
    activeRunId,
  }).rows;
}

const userText = {
  ...base("item-user", 0, "2026-10-20T09:00:00.000Z"),
  type: "user_message",
  messageId: MessageId.make("message-user"),
  createdBy: "user",
  creationSource: "mobile",
  inputIntent: "turn_start",
  text: "Add these to food db",
  attachments: [],
} satisfies OrchestrationV2TurnItem;

const command = {
  ...base("item-command", 1, "2026-10-20T09:00:05.000Z", "2026-10-20T09:00:17.000Z"),
  type: "command_execution",
  input: "food.py add eggs",
  output: "ok",
  exitCode: 0,
} satisfies OrchestrationV2TurnItem;

const plan = {
  ...base("item-plan", 2, "2026-10-20T09:00:18.000Z"),
  type: "proposed_plan",
  planId: "plan-1",
  markdown: "Save three items",
  streaming: false,
} as OrchestrationV2TurnItem;

const interrupted = {
  ...base("item-interrupt", 3, "2026-10-20T09:00:19.000Z"),
  type: "run_interrupt_result",
  message: "Stopped",
} satisfies OrchestrationV2TurnItem;

const reply = {
  ...base("item-reply", 4, "2026-10-20T09:00:20.000Z"),
  type: "assistant_message",
  messageId: MessageId.make("message-reply"),
  text: "Saved all three.",
  streaming: false,
} satisfies OrchestrationV2TurnItem;

const emptyDraft = {
  ...base("item-empty", 5, "2026-10-20T09:00:21.000Z"),
  type: "assistant_message",
  messageId: MessageId.make("message-empty"),
  text: "",
  streaming: false,
} satisfies OrchestrationV2TurnItem;

const interruptRequest = {
  ...base("item-interrupt-request", 3, "2026-10-20T09:00:19.000Z"),
  type: "run_interrupt_request",
  message: "Stop",
} satisfies OrchestrationV2TurnItem;

describe("imessageTimelineEntries", () => {
  it("splits turn items into the entry kinds the rows read", () => {
    const entries = entriesOf([userText, command, plan, interrupted, reply]);

    expect(entries.map((entry) => entry.kind)).toEqual([
      "message",
      "work",
      "proposed-plan",
      "event",
      "message",
    ]);
    expect(entries[1]).toMatchObject({
      kind: "work",
      entry: { runId, tone: "tool", command: "food.py add eggs" },
    });
    expect(entries[2]).toMatchObject({
      kind: "proposed-plan",
      proposedPlan: { runId, planMarkdown: "Save three items" },
    });
  });

  it("builds bubbles and agent steps from mobile turn items", () => {
    const rows = rowsOf([userText, command, plan, interrupted, reply]);

    expect(rows.map((row) => row.kind)).toEqual(["divider", "time", "incoming", "agent", "reply"]);
    expect(rows[2]).toMatchObject({ text: "Add these to food db" });
    expect(rows[4]).toMatchObject({ send: { text: "Saved all three.", via: "final" } });
    const agent = rows[3];
    expect(agent?.kind === "agent" ? agent.turn.steps : []).toMatchObject([
      { label: "Ran", text: "food.py add eggs", code: true, seconds: 12 },
      { label: "Plan", text: "Save three items" },
      { label: "Event", text: "run interrupt result" },
      { label: "Sent", text: "Saved all three." },
    ]);
  });

  it("keeps an empty final draft so an earlier draft never shows as sent", () => {
    const rows = rowsOf([userText, reply, emptyDraft]);

    expect(rows.map((row) => row.kind)).toEqual(["divider", "time", "incoming", "agent"]);
    const agent = rows[3];
    expect(agent).toMatchObject({ kind: "agent", turn: { outcome: "no-reply" } });
    expect(agent?.kind === "agent" ? agent.turn.steps[0] : null).toMatchObject({
      label: "Text not sent",
      text: "Saved all three.",
    });
  });

  it("shows an interrupt request as an event step", () => {
    const rows = rowsOf([userText, interruptRequest, reply]);

    const agent = rows[3];
    expect(agent?.kind === "agent" ? agent.turn.steps : []).toMatchObject([
      { label: "Event", text: "run interrupt request" },
      { label: "Sent", text: "Saved all three." },
    ]);
  });

  it("leaves out step details that only repeat the label or a thread id", () => {
    const notice = {
      ...base("item-notice", 2, "2026-10-20T09:00:18.000Z"),
      type: "system_notice",
      message: "Context compacted",
    } satisfies OrchestrationV2TurnItem;
    const created = {
      ...base("item-created", 3, "2026-10-20T09:00:19.000Z"),
      type: "thread_created",
      targetThreadId: ThreadId.make("thread-child"),
    } as OrchestrationV2TurnItem;

    const work = entriesOf([notice, created]).flatMap((entry) =>
      entry.kind === "work" ? [entry.entry] : [],
    );
    expect(work.map((entry) => entry.detail)).toEqual([undefined, undefined]);
  });

  it("marks the live run as working until its reply lands", () => {
    expect(rowsOf([userText, command], runId).at(-1)).toMatchObject({
      kind: "agent",
      turn: { outcome: "working" },
    });
  });

  it("reads a send tool call as a text and keeps the final message as a note", () => {
    const send = {
      ...base("item-send", 1, "2026-10-20T09:00:05.000Z", "2026-10-20T09:00:06.000Z"),
      type: "dynamic_tool",
      toolName: "mcp__t3-code__imessage_send",
      input: { text: "On it." },
    } satisfies OrchestrationV2TurnItem;
    const rows = rowsOf([userText, send, reply]);

    expect(rows.map((row) => row.kind)).toEqual([
      "divider",
      "time",
      "incoming",
      "agent",
      "reply",
      "note",
    ]);
    expect(rows[4]).toMatchObject({ send: { text: "On it.", via: "tool", state: "sent" } });
    expect(rows[5]).toMatchObject({ text: "Saved all three." });
  });
});
