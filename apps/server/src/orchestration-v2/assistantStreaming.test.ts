import { describe, expect, it } from "vite-plus/test";
import {
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { makeAssistantStreamingFilter, splitBufferedAssistantText } from "./assistantStreaming.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const message = (text: string, streaming = true): ProviderAdapter.ProviderAdapterV2Event => ({
  type: "message.updated",
  driver: ProviderDriverKind.make("codex"),
  message: {
    id: MessageId.make("message"),
    threadId: ThreadId.make("thread"),
    runId: null,
    nodeId: null,
    createdBy: "agent",
    creationSource: "provider",
    updatedAt: DateTime.makeUnsafe("2026-09-14T00:00:00Z"),
    role: "assistant",
    text,
    attachments: [],
    createdAt: DateTime.makeUnsafe("2026-09-14T00:00:00Z"),
    streaming,
  },
});

const turnItem = (
  text: string,
  streaming = true,
  type: "assistant_message" | "reasoning" = "assistant_message",
  id = "item",
  driver = "codex",
): ProviderAdapter.ProviderAdapterV2Event => ({
  type: "turn_item.updated",
  driver: ProviderDriverKind.make(driver),
  turnItem: {
    id: TurnItemId.make(id),
    threadId: ThreadId.make("thread"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: streaming ? "running" : "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-09-14T00:00:00Z"),
    ...(type === "assistant_message" ? { type, messageId: MessageId.make("message") } : { type }),
    text,
    streaming,
  },
});

describe("V2 assistant streaming", () => {
  it("delivers completed paragraphs, coalesces rapid updates, and flushes final text", () => {
    const filter = makeAssistantStreamingFilter("paragraph");
    expect(filter(message("First"), 0)).toBeNull();
    expect(filter(message("First\n\nSec"), 10)).toMatchObject({ message: { text: "First\n\n" } });
    expect(filter(message("First\n\nSecond\n\nThi"), 100)).toBeNull();
    expect(filter(message("First\n\nSecond\n\nThird"), 410)).toMatchObject({
      message: { text: "First\n\nSecond\n\n" },
    });
    const final = message("First\n\nSecond\n\nThird", false);
    expect(filter(final, 420)).toBe(final);
  });
  it("keeps code fences intact", () => {
    expect(splitBufferedAssistantText("Intro\n\n```ts\nx()\n\n")).toEqual({
      ready: "Intro\n\n",
      rest: "```ts\nx()\n\n",
    });
    expect(splitBufferedAssistantText("```ts\nx()\n```\nrest")).toEqual({
      ready: "```ts\nx()\n```\n",
      rest: "rest",
    });
  });
  it("holds streaming text until the full response completes", () => {
    const running = message("partial");
    const final = message("complete", false);
    const buffered = makeAssistantStreamingFilter("turn");
    expect(buffered(running, 0)).toBeNull();
    expect(buffered(message("First\n\nSecond\n\n"), 500)).toBeNull();
    expect(buffered(final, 501)).toBe(final);
  });

  it("keeps assistant items at the existing 400 ms cadence", () => {
    const type = "assistant_message";
    const item = (text: string, streaming = true) => turnItem(text, streaming, type);
    const filter = makeAssistantStreamingFilter("paragraph");
    expect(filter(item("First"), 0)).toBeNull();
    expect(filter(item("First\n\nSec"), 10)).toMatchObject({
      turnItem: { text: "First\n\n", streaming: true, type },
    });
    expect(filter(item("First\n\nSecond\n\nThi"), 100)).toBeNull();
    expect(filter(item("First\n\nSecond\n\nThi"), 410)).toMatchObject({
      turnItem: { text: "First\n\nSecond\n\n", streaming: true },
    });
    const final = item("First\n\nSecond\n\nThird", false);
    expect(filter(final, 420)).toBe(final);

    const buffered = makeAssistantStreamingFilter("turn");
    expect(buffered(item("First\n\nSecond"), 0)).toBeNull();
    expect(buffered(final, 1)).toBe(final);
  });

  it.each(["opencode", "claude", "codex"])(
    "checkpoints %s reasoning per item every two seconds",
    (driver) => {
      const item = (text: string, streaming = true, id = "item") =>
        turnItem(text, streaming, "reasoning", id, driver);
      const filter = makeAssistantStreamingFilter("paragraph");
      expect(filter(item("partial"), -1)).toBeNull();
      expect(filter(item("First\n\npartial"), 0)).toMatchObject({
        turnItem: { text: "First\n\n", streaming: true },
      });
      expect(filter(item("First\n\nSecond\n\npartial"), 400)).toBeNull();
      expect(filter(item("First\n\nSecond\n\npartial"), 1999)).toBeNull();
      expect(filter(item("First\n\nSecond\n\npartial"), 2000)).toMatchObject({
        turnItem: { text: "First\n\nSecond\n\n", streaming: true },
      });
      expect(filter(item("other\n\ntail", true, "other"), 2001)).toMatchObject({
        turnItem: { id: "other", text: "other\n\n" },
      });
      expect(filter(item("changed\n\nmore\n\n", true, "other"), 2002)).toBeNull();
    },
  );

  it("delivers replacements at the next checkpoint and a terminal snapshot immediately", () => {
    const item = (text: string, streaming = true) => turnItem(text, streaming, "reasoning");
    const filter = makeAssistantStreamingFilter("paragraph");
    expect(filter(item("Original 🐕\n\npartial"), 0)).toMatchObject({
      turnItem: { text: "Original 🐕\n\n" },
    });
    expect(filter(item("Replaced 🐈\n\npartial"), 400)).toBeNull();
    expect(filter(item("Replaced 🐈\n\npartial"), 2000)).toMatchObject({
      turnItem: { text: "Replaced 🐈\n\n" },
    });
    const final = item("最終 🐈‍⬛\npartial", false);
    expect(filter(final, 2500)).toBe(final);
    // A final event discards its checkpoint state, even when its ID is reused.
    expect(filter(item("Fresh\n\npartial"), 2501)).toMatchObject({
      turnItem: { text: "Fresh\n\n" },
    });
  });

  it("flushes an exact terminal snapshot at 500 ms and isolates run filters", () => {
    const item = (text: string, streaming = true) => turnItem(text, streaming, "reasoning");
    const firstRun = makeAssistantStreamingFilter("paragraph");
    const secondRun = makeAssistantStreamingFilter("paragraph");
    expect(firstRun(item("First\n\npartial"), 0)).toMatchObject({
      turnItem: { text: "First\n\n" },
    });
    expect(secondRun(item("Second run\n\npartial"), 1)).toMatchObject({
      turnItem: { text: "Second run\n\n" },
    });
    const final = item("replacement 🦊 with no paragraph boundary", false);
    expect(firstRun(final, 500)).toBe(final);
  });

  it("still holds all streaming reasoning in turn mode", () => {
    const filter = makeAssistantStreamingFilter("turn");
    const item = (text: string, streaming = true) => turnItem(text, streaming, "reasoning");
    expect(filter(item("one\n\npartial"), 0)).toBeNull();
    expect(filter(item("one\n\ntwo\n\npartial"), 2000)).toBeNull();
    const final = item("one\n\ntwo\n\nfinal", false);
    expect(filter(final, 2001)).toBe(final);
  });

  it.each(["turn", "paragraph"] as const)(
    "passes command output, tool snapshots and turn terminals immediately in %s mode",
    (mode) => {
      const filter = makeAssistantStreamingFilter(mode);
      const reasoning = turnItem("Start\n\npartial", true, "reasoning");
      filter(reasoning, 0);
      const output: ProviderAdapter.ProviderAdapterV2Event = {
        type: "command_output.delta",
        driver: ProviderDriverKind.make("opencode"),
        threadId: ThreadId.make("thread"),
        itemId: TurnItemId.make("tool"),
        chunk: "actual output",
      };
      expect(filter(output, 1)).toBe(output);
      if (reasoning.type !== "turn_item.updated" || reasoning.turnItem.type !== "reasoning") {
        throw new Error("unexpected fixture");
      }
      const tool: ProviderAdapter.ProviderAdapterV2Event = {
        ...reasoning,
        turnItem: {
          ...reasoning.turnItem,
          id: TurnItemId.make("tool"),
          type: "command_execution",
          input: "pwd",
          output: "actual output",
        },
      };
      expect(filter(tool, 2)).toBe(tool);
      const terminal: ProviderAdapter.ProviderAdapterV2Event = {
        type: "turn.terminal",
        driver: ProviderDriverKind.make("opencode"),
        providerThreadId: ProviderThreadId.make("provider-thread"),
        providerTurnId: ProviderTurnId.make("provider-turn"),
        runOrdinal: 1,
        status: "completed",
        failure: null,
        threadDisposition: "reusable",
      };
      expect(filter(terminal, 3)).toBe(terminal);
    },
  );

  it.each(["turn", "paragraph"] as const)(
    "suppresses running assistant nodes in %s mode while delivering tool and completed nodes",
    (mode) => {
      const filter = makeAssistantStreamingFilter(mode);
      const running: Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "node.updated" }> = {
        type: "node.updated",
        driver: ProviderDriverKind.make("codex"),
        node: {
          id: NodeId.make("node"),
          threadId: ThreadId.make("thread"),
          runId: null,
          parentNodeId: null,
          rootNodeId: NodeId.make("root"),
          kind: "assistant_message",
          status: "running",
          countsForRun: false,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: null,
          completedAt: null,
        },
      };
      expect(filter(running, 0)).toBeNull();
      const completed = { ...running, node: { ...running.node, status: "completed" as const } };
      expect(filter(completed, 1)).toBe(completed);
      const tool = { ...running, node: { ...running.node, kind: "tool_call" as const } };
      expect(filter(tool, 2)).toBe(tool);
    },
  );
});

it("holds a streamed section heading until its content has a boundary", () => {
  expect(splitBufferedAssistantText("Intro\n\n## Results\n\n")).toEqual({
    ready: "Intro\n\n",
    rest: "## Results\n\n",
  });
  expect(splitBufferedAssistantText("**Results**\n\nBody\n\nNext")).toEqual({
    ready: "**Results**\n\nBody\n\n",
    rest: "Next",
  });
});
