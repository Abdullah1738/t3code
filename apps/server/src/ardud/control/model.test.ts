import type {
  ModelSelection,
  OrchestrationV2ConversationMessage,
  OrchestrationV2Run,
  OrchestrationV2StoredEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { controlEventFromStored } from "./http.ts";
import {
  lastAssistantText,
  modelSelectionFrom,
  parseSince,
  stateFromRunStatus,
  stateFromRuns,
} from "./model.ts";

const at = (ms: number) => DateTime.makeUnsafe(ms);
const selection = (options?: ModelSelection["options"]): ModelSelection =>
  ({
    instanceId: "opencode",
    model: "opus/claude-opus-5-5",
    ...(options === undefined ? {} : { options }),
  }) as ModelSelection;

const run = (ordinal: number, status: OrchestrationV2Run["status"]) =>
  ({ id: `run-${ordinal}`, ordinal, status }) as unknown as OrchestrationV2Run;

const message = (
  id: string,
  role: "user" | "assistant",
  text: string,
  createdAt: number,
  runId: string | null = "run-1",
) =>
  ({
    id,
    role,
    text,
    runId,
    createdAt: at(createdAt),
    updatedAt: at(createdAt),
  }) as unknown as OrchestrationV2ConversationMessage;

describe("state mapping", () => {
  it("maps run statuses onto control states", () => {
    expect(stateFromRunStatus("running", false)).toBe("running");
    expect(stateFromRunStatus("preparing", false)).toBe("running");
    expect(stateFromRunStatus("waiting", false)).toBe("waiting");
    expect(stateFromRunStatus("queued", false)).toBe("queued");
    expect(stateFromRunStatus("completed", false)).toBe("idle");
    expect(stateFromRunStatus("interrupted", false)).toBe("idle");
    expect(stateFromRunStatus(null, false)).toBe("idle");
    expect(stateFromRunStatus("running", true)).toBe("needs-input");
  });

  it("prefers the active run over newer queued or older finished ones", () => {
    const result = stateFromRuns([run(1, "completed"), run(2, "running"), run(3, "queued")], false);
    expect(result.state).toBe("running");
    expect(result.run?.ordinal).toBe(2);
    expect(stateFromRuns([run(1, "completed"), run(2, "failed")], false).run?.ordinal).toBe(2);
    expect(stateFromRuns([], false)).toEqual({ state: "idle", run: null });
  });
});

describe("model selection", () => {
  it("parses provider/model with a variant", () => {
    expect(
      modelSelectionFrom({ model: "opus/gpt-6-astra", variant: "xhigh", base: selection() }),
    ).toEqual({
      instanceId: "opencode",
      model: "opus/gpt-6-astra",
      options: [{ id: "variant", value: "xhigh" }],
    });
  });

  it("keeps other options and the variant when only the variant changes or nothing changes", () => {
    const base = selection([
      { id: "agent", value: "build" },
      { id: "variant", value: "high" },
    ]);
    expect(modelSelectionFrom({ base }).options).toEqual([
      { id: "agent", value: "build" },
      { id: "variant", value: "high" },
    ]);
    expect(modelSelectionFrom({ variant: "low", base }).options).toEqual([
      { id: "agent", value: "build" },
      { id: "variant", value: "low" },
    ]);
    expect(modelSelectionFrom({ variant: null, base }).options).toEqual([
      { id: "agent", value: "build" },
    ]);
  });

  it("drops the old model's options when the model changes", () => {
    const base = selection([{ id: "variant", value: "high" }]);
    expect(modelSelectionFrom({ model: "opus/other", base })).toEqual({
      instanceId: "opencode",
      model: "opus/other",
    });
  });
});

describe("messages", () => {
  it("returns the newest non-empty assistant text, optionally per run", () => {
    const messages = [
      message("u1", "user", "hi", 1),
      message("a1", "assistant", "first", 2),
      message("a2", "assistant", "  ", 3),
      message("u2", "user", "again", 4, "run-2"),
      message("a3", "assistant", "second\n", 5, "run-2"),
    ];
    expect(lastAssistantText(messages)?.text).toBe("second");
    expect(lastAssistantText(messages, "run-1")?.text).toBe("first");
    expect(lastAssistantText(messages, "run-9")).toBeNull();
  });

  it("parses since as ISO or epoch milliseconds", () => {
    expect(parseSince("1700000000000")).toBe(1_700_000_000_000);
    expect(parseSince("2026-10-02T00:00:00.000Z")).toBe(Date.parse("2026-10-02T00:00:00.000Z"));
    expect(parseSince("nope")).toBeUndefined();
    expect(parseSince(null)).toBeUndefined();
  });
});

describe("control events", () => {
  const stored = (event: Record<string, unknown>) =>
    ({ sequence: 7, commandId: null, event }) as unknown as OrchestrationV2StoredEvent;

  it("maps run updates to thread status", () => {
    expect(
      controlEventFromStored(
        stored({ type: "run.updated", threadId: "t1", payload: { id: "r1", status: "waiting" } }),
      ),
    ).toEqual({
      type: "thread.status",
      threadId: "t1",
      runId: "r1",
      status: "waiting",
      state: "waiting",
    });
  });

  it("emits completed messages only", () => {
    const payload = { id: "m1", runId: "r1", role: "assistant", text: "PONG", streaming: false };
    expect(
      controlEventFromStored(stored({ type: "message.updated", threadId: "t1", payload })),
    ).toEqual({
      type: "message.completed",
      threadId: "t1",
      runId: "r1",
      messageId: "m1",
      role: "assistant",
      text: "PONG",
    });
    expect(
      controlEventFromStored(
        stored({
          type: "message.updated",
          threadId: "t1",
          payload: { ...payload, streaming: true },
        }),
      ),
    ).toBeNull();
  });

  it("maps runtime requests to opened and resolved", () => {
    const payload = { id: "q1", kind: "user_input", status: "pending" };
    expect(
      controlEventFromStored(stored({ type: "runtime-request.updated", threadId: "t1", payload })),
    ).toMatchObject({ type: "request.opened", kind: "question", requestId: "q1" });
    expect(
      controlEventFromStored(
        stored({
          type: "runtime-request.updated",
          threadId: "t1",
          payload: { id: "p1", kind: "command", status: "resolved" },
        }),
      ),
    ).toMatchObject({ type: "request.resolved", kind: "approval" });
  });

  it("ignores high-volume item events", () => {
    expect(
      controlEventFromStored(stored({ type: "turn-item.updated", threadId: "t1" })),
    ).toBeNull();
  });
});

describe("effort compatibility", () => {
  const claude = {
    instanceId: "claudeAgent",
    model: "claude-opus-5-5",
    options: [{ id: "effort", value: "max" }],
  } as unknown as ModelSelection;

  it("a variant patch replaces an existing effort with one effort option", () => {
    expect(modelSelectionFrom({ variant: "xhigh", base: claude })).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
      options: [{ id: "effort", value: "xhigh" }],
    });
  });

  it("a null variant clears the effort", () => {
    expect(modelSelectionFrom({ variant: null, base: claude })).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
    });
  });
});
