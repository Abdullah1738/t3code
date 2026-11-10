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
  checkRunProblem,
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

  it("reads wait answers, pushed wakes and parks, and keeps the older commands as they were", () => {
    const parsed = parseOutput(
      [
        '{"kanban":{"wait":{"card":"#12","result":"wake","to":"review","note":"ENG-123 is Done"}}}',
        '{"kanban":{"wait":{"card":13,"result":"hold","status":"CI 3 of 5 passed"}}}',
        '{"kanban":{"wait":{"card":"#14","result":"fail","reason":"Linear said 401"}}}',
        '{"kanban":{"wake":{"card":"#15","to":"work","note":"v2.4.1 is live"}}}',
        '{"kanban":{"wake":{"card":16,"note":"deployed","wait":"2026-11-10T11:00:00.000Z"}}}',
        '{"kanban":{"wait":{"card":"#17","on":"merge","pr":"#544","note":"release PR","wakeRole":"evaluator"}}}',
        '{"kanban":{"wait":{"card":"#18","on":"card","waitsOn":"#12","note":"after the parent"}}}',
        '{"kanban":{"wait":{"card":"#19","on":"script","script":"deploy-landed","args":{"env":"prod"},"note":"prod deploy"}}}',
        '{"kanban":"post","card":12,"text":"still here"}',
        "checked 8 cards",
      ].join("\n"),
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.commands.map((command) => command.kanban)).toEqual(["post"]);
    expect(parsed.text).toBe("checked 8 cards");
    expect(parsed.waits).toEqual([
      {
        _tag: "answer",
        card: 12,
        answer: { result: "wake", to: "review", note: "ENG-123 is Done" },
      },
      { _tag: "answer", card: 13, answer: { result: "hold", status: "CI 3 of 5 passed" } },
      { _tag: "answer", card: 14, answer: { result: "fail", reason: "Linear said 401" } },
      {
        _tag: "wake",
        card: 15,
        // Names no wait: it ends whatever wait the card has.
        wait: null,
        answer: { result: "wake", to: "work", note: "v2.4.1 is live" },
      },
      {
        _tag: "wake",
        card: 16,
        wait: "2026-11-10T11:00:00.000Z",
        answer: { result: "wake", note: "deployed" },
      },
      {
        _tag: "park",
        card: 17,
        waitsOn: null,
        request: { on: "merge", pr: "#544", note: "release PR", wakeRole: "evaluator" },
      },
      { _tag: "park", card: 18, waitsOn: 12, request: { on: "card", note: "after the parent" } },
      {
        _tag: "park",
        card: 19,
        waitsOn: null,
        request: {
          on: "script",
          script: "deploy-landed",
          args: { env: "prod" },
          note: "prod deploy",
        },
      },
    ]);
  });

  it("turns an answer it can't read into a failed check, and reports lines that name no card", () => {
    const parsed = parseOutput(
      [
        // Readable enough to know the card: it holds, with the problem on it.
        '{"kanban":{"wait":{"card":"#12","result":"maybe"}}}',
        '{"kanban":{"wait":{"card":"#13","result":"wake"}}}',
        // No card, no known key, bad values: reported, nothing applied.
        '{"kanban":{"wait":{"result":"wake","note":"x"}}}',
        '{"kanban":{"wake":{"card":"twelve","note":"x"}}}',
        '{"kanban":{"wake":{"card":"#12"}}}',
        '{"kanban":{"wait":{"card":"#12","on":"deploy","note":"x"}}}',
        '{"kanban":{"wait":{"card":"#12","on":"card","waitsOn":"soon","note":"x"}}}',
        '{"kanban":{"nudge":{"card":"#12"}}}',
        '{"kanban":{"wait":{"card":"#12","result":',
      ].join("\n"),
    );
    const unreadable = { result: "fail", reason: "The check's answer could not be read" };
    expect(parsed.waits).toEqual([
      { _tag: "answer", card: 12, answer: unreadable },
      { _tag: "answer", card: 13, answer: unreadable },
    ]);
    expect(parsed.errors.map((error) => error.slice(0, 7))).toEqual([
      "Line 3:",
      "Line 4:",
      "Line 5:",
      "Line 6:",
      "Line 7:",
      "Line 8:",
      "Line 9 ",
    ]);
    expect(parsed.errors[0]).toContain("names its card");
    expect(parsed.errors[1]).toContain('"twelve" is not a card number');
  });

  it("says why a run can't count as a wait check", () => {
    const ran = { exitCode: 0, timedOut: false, overflow: false, spawnError: null };
    expect(checkRunProblem("linear-state", ran, 600_000)).toBeNull();
    expect(checkRunProblem("linear-state", { ...ran, exitCode: 2 }, 600_000)).toBe(
      "The linear-state script exited with code 2",
    );
    expect(
      checkRunProblem("linear-state", { ...ran, exitCode: null, timedOut: true }, 600_000),
    ).toBe("The linear-state script timed out after 10 minutes");
    expect(
      checkRunProblem("linear-state", { ...ran, exitCode: null, overflow: true }, 600_000),
    ).toBe("The linear-state script printed too much and was stopped");
    expect(
      checkRunProblem("linear-state", { ...ran, exitCode: null, spawnError: "ENOENT" }, 600_000),
    ).toBe("The linear-state script didn't start: ENOENT");
  });

  it("takes a pool command of any size", () => {
    const parsed = parseOutput(
      [
        '{"kanban":"pool","model":"opus/claude-opus-5-5","slots":120}',
        '{"kanban":"pool","model":"opus/claude-opus-5-5","slots":-1}',
      ].join("\n"),
    );
    expect(parsed.commands).toEqual([
      { kanban: "pool", model: "opus/claude-opus-5-5", slots: 120 },
    ]);
    expect(parsed.errors).toHaveLength(1);
  });

  it("decodes the subtask, handback and move commands", () => {
    const parsed = parseOutput(
      [
        '{"kanban":"subtask","card":1,"subtask":"s1","state":"done","note":"merged abc1234"}',
        '{"kanban":"handback","card":1,"subtask":"s2","note":"deploy failed: exit 1"}',
        '{"kanban":"move","card":1,"to":"deployed","note":"landed"}',
        '{"kanban":"move","card":1,"to":"working"}',
      ].join("\n"),
    );
    expect(parsed.commands.map((command) => command.kanban)).toEqual([
      "subtask",
      "handback",
      "move",
    ]);
    expect(parsed.errors).toHaveLength(1);
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

  it("a card a script moved on stdout fires no card.moved script, its own or another's", () => {
    const eventOf = eventTracker([["card-1", "todo"]]);
    const moved = card({ id: "card-1", number: 1, stage: "deployed", priority: 3 } as never);
    const byScript = { _tag: "script", scriptId: "script-1" as never } as const;
    const event = eventOf({ _tag: "card", card: moved, by: byScript });
    expect(event?.name).toBe("card.moved");
    expect(event?.by).toEqual(byScript);
    const mover = script({
      id: "script-1" as never,
      trigger: { _tag: "event", event: "card.moved" },
    });
    const other = script({
      id: "script-2" as never,
      trigger: { _tag: "event", event: "card.moved" },
    });
    expect(listensTo(mover, event!)).toBe(false);
    expect(listensTo(other, event!)).toBe(false);
    // A move by the owner still reaches the listener.
    const byOwnerEvent = eventTracker([["card-1", "todo"]])({
      _tag: "card",
      card: moved,
      by: { _tag: "owner" },
    });
    expect(listensTo(mover, byOwnerEvent!)).toBe(true);
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
