import type { KanbanCard, KanbanMessage, KanbanScript } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  cronProblem,
  duplicateOf,
  eventTracker,
  interpreterFor,
  isDue,
  isScriptDiscussion,
  listensTo,
  nextRunAt,
  parseOutput,
  tail,
} from "./scripts.ts";

const script = (patch: Partial<KanbanScript> = {}): KanbanScript =>
  ({
    id: "script-1",
    boardId: "board-1",
    name: "PR watch",
    path: "/tmp/watch.ts",
    trigger: { _tag: "schedule", everyMs: 60_000, cron: null },
    enabled: true,
    createdBy: { _tag: "owner" },
    createdAt: "2026-10-26T00:00:00.000Z",
    lastRun: null,
    ...patch,
  }) as KanbanScript;

const card = (patch: Partial<KanbanCard>) =>
  ({ title: "", links: [], settledAt: null, ...patch }) as unknown as KanbanCard;

const start = Date.parse("2026-10-26T00:00:00.000Z");

describe("board scripts", () => {
  it("picks the interpreter by extension", () => {
    expect(interpreterFor("/a/b.ts")).toBe("bun");
    expect(interpreterFor("/a/b.PY")).toBe("python3");
    expect(interpreterFor("/a/b.zsh")).toBe("zsh");
    expect(interpreterFor("/a/b.sh")).toBe("bash");
    expect(interpreterFor("/a/b.rb")).toBeNull();
    expect(interpreterFor("/a.d/script")).toBeNull();
  });

  it("is due once its interval or cron time has passed", () => {
    const every = script();
    expect(isDue(every, start + 59_000)).toBe(false);
    expect(isDue(every, start + 60_000)).toBe(true);
    expect(isDue({ ...every, enabled: false }, start + 60_000)).toBe(false);

    const cron = script({ trigger: { _tag: "schedule", everyMs: null, cron: "*/15 * * * *" } });
    expect(nextRunAt(cron.trigger, start)).toBe(start + 15 * 60_000);
    expect(nextRunAt({ _tag: "schedule", everyMs: null, cron: "nope" }, start)).toBeNull();
    expect(nextRunAt({ _tag: "schedule", everyMs: null, cron: "0 0 30 2 *" }, start)).toBeNull();
    expect(isDue(script({ trigger: { _tag: "manual" } }), start + 1e9)).toBe(false);
  });

  it("only takes five-field cron lines that come round", () => {
    expect(cronProblem("*/15 * * * *", start)).toBeNull();
    expect(cronProblem("0 9 * * 1-5", start)).toBeNull();
    expect(cronProblem("nope", start)).toContain("five fields");
    expect(cronProblem("0 0 * * * *", start)).toContain("five fields");
    expect(cronProblem("99 * * * *", start)).toContain("not a cron line");
    expect(cronProblem("0 0 30 2 *", start)).toContain("never comes round");
    expect(cronProblem("0 9 31 4 *", start)).toContain("never comes round");
  });

  it("reads commands from the output and keeps the rest as text", () => {
    const parsed = parseOutput(
      [
        "checked 3 repos",
        '{"kanban":"card","prompt":"Review it","title":"External PR: a/b#3","links":[{"url":"https://github.com/a/b/pull/3"}]}',
        '{"kanban":"post","card":12,"text":"Usage reset in 20 min"}',
        '{"kanban":"pool","model":"opus/claude-opus-5-5","slots":0}',
        '{"kanban":"pool","model":"opus/claude-opus-5-5","slots":-1}',
        '{"kanban":"card"}',
        '{"kanban": "post", oops',
        '{"other": 1}',
      ].join("\n"),
    );
    expect(parsed.commands.map((command) => command.kanban)).toEqual(["card", "post", "pool"]);
    expect(parsed.errors).toHaveLength(3);
    expect(parsed.text).toBe('checked 3 repos\n{"other": 1}');
  });

  it("finds a card the script already made", () => {
    const cards = [
      card({
        title: "External PR: a/b#3",
        links: [{ url: "https://github.com/a/b/pull/3" }] as never,
      }),
      card({ title: "Usage", settledAt: "2026-10-25T00:00:00.000Z" }),
    ];
    const byLink = {
      kanban: "card",
      prompt: "x",
      links: [{ url: "https://github.com/a/b/pull/3" }],
    } as const;
    expect(duplicateOf(cards, byLink)).toBe(cards[0]);
    expect(duplicateOf(cards, { kanban: "card", prompt: "x", title: "Usage" })).toBeNull();
    expect(duplicateOf(cards, { kanban: "card", prompt: "x" })).toBeNull();
  });

  it("keeps the end of long output", () => {
    const long = `${"a".repeat(100)}\n${"b".repeat(50)}`;
    expect(tail(long, 60)).toBe("b".repeat(50));
    expect(tail("short", 60)).toBe("short");
  });

  it("turns board changes into script events", () => {
    const eventOf = eventTracker([["card-1", "todo"]]);
    const moved = card({ id: "card-1", number: 1, stage: "working", priority: 3 } as never);
    expect(eventOf({ _tag: "card", card: moved })?.name).toBe("card.moved");
    // Saved again without a stage change: nothing.
    expect(eventOf({ _tag: "card", card: moved })).toBeNull();
    const fresh = card({
      id: "card-2",
      number: 2,
      stage: "todo",
      createdBy: { _tag: "script", scriptId: "script-1" },
    } as never);
    const created = eventOf({ _tag: "card", card: fresh });
    expect(created?.name).toBe("card.created");
    expect(created?.payload).toMatchObject({ cardId: "card-2", number: 2 });

    const message = {
      discussionId: "disc-1",
      seq: 4,
      author: { _tag: "owner" },
      authorName: "You",
      blocks: [{ _tag: "md", text: "ship it" }],
      answers: [],
      createdAt: "2026-10-26T00:00:00.000Z",
    } as unknown as KanbanMessage;
    expect(eventOf({ _tag: "message", message })?.payload).toMatchObject({ text: "ship it" });
    // An answer republishes the message; that is not a new post.
    const answered = { ...message, answers: [{ blockId: "b", by: { _tag: "owner" }, choice: [] }] };
    expect(eventOf({ _tag: "message", message: answered as never })).toBeNull();

    // Nothing a script did wakes a script, its own or another's.
    const listener = script({ trigger: { _tag: "event", event: "card.created" } });
    expect(listensTo(listener, created!)).toBe(false);
    expect(
      listensTo(script({ id: "script-2" as never, trigger: listener.trigger }), created!),
    ).toBe(false);
    const byOwner = { ...created!, by: { _tag: "owner" } as const };
    expect(listensTo(listener, byOwner)).toBe(true);
    expect(listensTo({ ...listener, enabled: false }, byOwner)).toBe(false);
  });

  it("knows the discussions a script opened or posted in", () => {
    const discussion = (patch: object) =>
      ({ createdBy: { _tag: "owner" }, participants: [], ...patch }) as never;
    const scriptActor = { _tag: "script", scriptId: "script-1" };
    expect(isScriptDiscussion(discussion({}))).toBe(false);
    expect(isScriptDiscussion(discussion({ createdBy: scriptActor }))).toBe(true);
    expect(isScriptDiscussion(discussion({ participants: [{ actor: scriptActor }] }))).toBe(true);
  });
});
