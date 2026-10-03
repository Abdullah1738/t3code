import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import type { OpenCodeMessage, OpenCodeSession } from "./OpenCodeHttp.ts";
import {
  historyEvents,
  importedThreadId,
  projectRootFor,
  sessionModelSelection,
  sessionOrigin,
  subagentCalls,
} from "./transcript.ts";

const instanceId = ProviderInstanceId.make("opencode");
const session = (overrides: Partial<OpenCodeSession> = {}): OpenCodeSession => ({
  id: "ses_1",
  title: "Fix the thing",
  time: { created: 1_000, updated: 2_000 },
  location: { directory: "/repo/app" },
  ...overrides,
});

const context = {
  threadId: importedThreadId("ses_1"),
  instanceId,
  childThreadId: (id: string) => ThreadId.make(`child:${id}`),
};

describe("sessionOrigin", () => {
  it("prefers the OpenChamber origin tag", () => {
    expect(sessionOrigin(session({ metadata: { openchamber: { origin: "telegram" } } }))).toBe(
      "telegram",
    );
  });
  it("marks Robob's iMessage folders as iMessage, not desktop chats", () => {
    expect(
      sessionOrigin(
        session({
          location: { directory: "/Users/ardud/.config/openchamber/imessage/2026-10-01/s" },
        }),
      ),
    ).toBe("imessage");
    expect(
      sessionOrigin(
        session({ location: { directory: "/Users/ardud/.config/openchamber/chats/2026-10-01/s" } }),
      ),
    ).toBeNull();
  });
  it("leaves other sessions without an origin", () => {
    expect(sessionOrigin(session())).toBeNull();
  });
});

describe("projectRootFor", () => {
  it("keeps repo subfolders under the repo", () => {
    expect(projectRootFor(session(), "/repo").path).toBe("/repo");
  });
  it("keeps worktrees elsewhere under their repo", () => {
    expect(projectRootFor(session(), "/other").path).toBe("/other");
  });
  it("uses the session folder when OpenCode has no project root", () => {
    expect(projectRootFor(session(), "/").path).toBe("/repo/app");
    expect(projectRootFor(session(), undefined).path).toBe("/repo/app");
  });
  it("groups OpenChamber scratch folders", () => {
    const root = projectRootFor(
      session({ location: { directory: "/Users/ardud/.config/openchamber/imessage/2026/s-1" } }),
      undefined,
    );
    expect(root).toEqual({ path: "/Users/ardud/.config/openchamber/imessage", title: "iMessage" });
  });
});

describe("sessionModelSelection", () => {
  const fallback = { instanceId, model: "opus/claude-opus-5-5" };
  it("uses the session's last model and variant", () => {
    expect(
      sessionModelSelection(
        session({ model: { providerID: "layso", id: "gpt-6-astra", variant: "xhigh" } }),
        instanceId,
        fallback,
      ),
    ).toEqual({
      instanceId,
      model: "layso/gpt-6-astra",
      options: [{ id: "variant", value: "xhigh" }],
    });
  });
  it("falls back when OpenCode no longer offers the model", () => {
    expect(
      sessionModelSelection(
        session({ model: { providerID: "inferhub", id: "gpt-6-astra" } }),
        instanceId,
        fallback,
        new Set(["opus/claude-opus-5-5"]),
      ),
    ).toEqual(fallback);
  });
  it("falls back when the session has no model", () => {
    expect(sessionModelSelection(session(), instanceId, fallback)).toEqual(fallback);
  });
});

describe("historyEvents", () => {
  const messages: ReadonlyArray<OpenCodeMessage> = [
    { id: "msg_1", type: "user", text: "hello", time: { created: 1_000 } },
    {
      id: "msg_2",
      type: "assistant",
      time: { created: 1_500 },
      content: [
        { type: "reasoning", text: "thinking" },
        {
          type: "tool",
          name: "bash",
          state: {
            status: "completed",
            input: { command: "ls" },
            content: [{ type: "text", text: "a\nb" }],
            metadata: { exit: 0 },
          },
        },
        {
          type: "tool",
          name: "subagent",
          state: {
            status: "completed",
            input: { description: "Look around", prompt: "go" },
            content: [{ type: "text", text: "done" }],
            metadata: { sessionID: "ses_child" },
          },
        },
        { type: "text", text: "hi there" },
      ],
    },
    { id: "msg_3", type: "idle", time: { created: 1_600 } },
  ];

  it("maps messages to runless items with stable ids and increasing ordinals", () => {
    const { events, positions } = historyEvents({ ...context, messages, firstOrdinal: 10 });
    const items = events.flatMap((event) =>
      event.type === "turn-item.updated" ? [event.payload] : [],
    );
    expect(items.map((item) => item.type)).toEqual([
      "user_message",
      "reasoning",
      "command_execution",
      "subagent",
      "assistant_message",
    ]);
    expect(items.every((item) => item.runId === null)).toBe(true);
    expect(positions.map((position) => position.ordinal)).toEqual([10, 11, 12, 13, 14]);
    expect(events.filter((event) => event.type === "message.updated")).toHaveLength(2);
    const again = historyEvents({ ...context, messages, firstOrdinal: 10 });
    expect(again.events.map((event) => event.id)).toEqual(events.map((event) => event.id));
  });

  it("links subagent calls to their child session's thread", () => {
    const { events } = historyEvents({ ...context, messages, firstOrdinal: 10 });
    const subagent = events.find(
      (event) => event.type === "turn-item.updated" && event.payload.type === "subagent",
    );
    expect(subagent?.type === "turn-item.updated" && subagent.payload).toMatchObject({
      childThreadId: "child:ses_child",
      result: "done",
    });
    expect(subagentCalls({ ...context, messages })).toMatchObject([
      { sessionId: "ses_child", childThreadId: "child:ses_child", title: "Look around" },
    ]);
  });
});
