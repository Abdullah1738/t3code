import { describe, expect, it } from "@effect/vitest";

import {
  BoardModel,
  decideAction,
  type BoardAction,
  type LiveStatus,
  type Observation,
  type ThreadObservation,
} from "./BoardModel.ts";

// Behavioural cases ported from OpenChamber's session-board runtime tests,
// expressed against t3 thread observations.

const ACTIVATED = 100;

const fixture = () => {
  let clock = 1_000;
  const model = new BoardModel({ activatedAt: ACTIVATED, now: () => clock });
  const prompts = new Map<string, number>();
  const shells = new Map<string, Omit<ThreadObservation, "promptAt" | "live">>();
  const statuses = new Map<string, LiveStatus>();

  const observe = (observation: Observation) => {
    const patch = model.observe(observation);
    model.commit(patch);
    return patch;
  };
  const read = (threadId: string, extra: Partial<ThreadObservation> = {}): ThreadObservation => {
    const shell = shells.get(threadId) ?? {
      threadId,
      projectId: "project",
      title: threadId,
      parentId: null,
      rootId: threadId,
      relationship: null,
      attention: null,
      model: null,
      branch: null,
      worktreePath: null,
      archived: false,
    };
    return {
      ...shell,
      promptAt: prompts.get(threadId) ?? null,
      live: statuses.get(threadId) ?? "idle",
      ...extra,
    };
  };
  const f: {
    model: BoardModel;
    tick: (ms?: number) => number;
    add: (threadId: string, extra?: Partial<ThreadObservation>) => void;
    child: (threadId: string, parentId: string, relationship?: "subagent" | "fork") => void;
    prompt: (threadId: string, at?: number, extra?: Partial<ThreadObservation>) => unknown;
    status: (threadId: string, live: LiveStatus, extra?: Partial<ThreadObservation>) => unknown;
    attention: (threadId: string, kind: "question" | "approval" | null) => unknown;
    observe: (threadId: string, extra?: Partial<ThreadObservation>) => unknown;
    deleted: (threadId: string) => unknown;
    entries: () => ReturnType<BoardModel["entries"]>;
    lanes: () => Array<[string, string]>;
    token: (threadId: string) => number;
    act: (
      action: BoardAction,
      threadId: string,
      workRevision?: number,
    ) => ReturnType<typeof decideAction>;
  } = {
    model,
    tick: (ms = 10) => (clock += ms),
    add: (threadId: string, extra: Partial<ThreadObservation> = {}) => {
      shells.set(threadId, { ...read(threadId), ...extra });
    },
    child: (threadId: string, parentId: string, relationship: "subagent" | "fork" = "subagent") => {
      f.add(threadId, {
        parentId,
        rootId: shells.get(parentId)?.rootId ?? parentId,
        relationship,
      });
    },
    prompt: (threadId: string, at = 120, extra: Partial<ThreadObservation> = {}) => {
      prompts.set(threadId, at);
      return observe(read(threadId, extra));
    },
    status: (threadId: string, live: LiveStatus, extra: Partial<ThreadObservation> = {}) => {
      statuses.set(threadId, live);
      return observe(read(threadId, extra));
    },
    attention: (threadId: string, kind: "question" | "approval" | null) =>
      observe(read(threadId, { attention: kind === null ? null : { kind, count: 1 } })),
    observe: (threadId: string, extra: Partial<ThreadObservation> = {}) =>
      observe(read(threadId, extra)),
    deleted: (threadId: string) => observe({ threadId, deleted: true }),
    entries: () => model.entries(),
    lanes: () => model.entries().map((entry): [string, string] => [entry.threadId, entry.state]),
    token: (threadId: string) => model.rows.get(threadId)!.workRevision,
    act: (action: BoardAction, threadId: string, workRevision = f.token(threadId)) => {
      const decision = decideAction({
        action,
        row: model.rows.get(threadId),
        workRevision,
        running: model.isRunning(threadId),
        now: clock,
      });
      if (decision._tag === "commit") model.rows.set(threadId, decision.row);
      return decision;
    },
  };
  return f;
};

describe("session board model", () => {
  it("moves a root from running to waiting for review when its run settles", () => {
    const f = fixture();
    f.add("t_a");
    f.prompt("t_a");
    f.status("t_a", "working");
    expect(f.lanes()).toEqual([["t_a", "running"]]);
    f.status("t_a", "idle");
    expect(f.entries()).toMatchObject([{ threadId: "t_a", state: "waiting", status: "idle" }]);
  });

  it("baselines untouched history and never writes it", () => {
    const f = fixture();
    f.add("t_old");
    const patch = f.prompt("t_old", 50) as { rows: unknown[] };
    expect(patch.rows).toEqual([]);
    expect(f.entries()).toEqual([]);
  });

  it("includes an old thread that starts running after activation", () => {
    const f = fixture();
    f.add("t_old");
    f.prompt("t_old", 50);
    f.status("t_old", "working");
    expect(f.lanes()).toEqual([["t_old", "running"]]);
    f.status("t_old", "idle");
    expect(f.lanes()).toEqual([["t_old", "waiting"]]);
  });

  it("keeps a root running while a run waits on background work", () => {
    const f = fixture();
    f.add("t_a");
    f.prompt("t_a");
    f.status("t_a", "background");
    expect(f.entries()).toMatchObject([{ state: "running", status: "background" }]);
    expect(f.act("review", "t_a")).toMatchObject({ _tag: "conflict", reason: "running" });
    f.status("t_a", "idle");
    expect(f.lanes()).toEqual([["t_a", "waiting"]]);
  });

  it("keeps a root running while its subagents still work, and never gives subagents a card", () => {
    const f = fixture();
    f.add("t_root");
    f.child("t_sub", "t_root");
    f.prompt("t_root");
    f.status("t_root", "working");
    f.status("t_sub", "working");
    f.status("t_root", "idle");
    expect(f.entries()).toMatchObject([
      { threadId: "t_root", state: "running", status: "background" },
    ]);
    expect(f.model.rows.has("t_sub")).toBe(false);
    f.status("t_sub", "idle");
    expect(f.lanes()).toEqual([["t_root", "waiting"]]);
  });

  it("gives a fork its own card and does not hold its source", () => {
    const f = fixture();
    f.add("t_src");
    f.prompt("t_src");
    f.status("t_src", "idle");
    f.child("t_fork", "t_src", "fork");
    f.prompt("t_fork", 130);
    f.status("t_fork", "working");
    expect(Object.fromEntries(f.lanes())).toEqual({ t_src: "waiting", t_fork: "running" });
  });

  it("retains waiting work until a manual review; a later prompt brings it back", () => {
    const f = fixture();
    f.add("t_a");
    f.prompt("t_a");
    f.status("t_a", "idle");
    const token = f.token("t_a");
    expect(f.act("review", "t_a")).toMatchObject({ _tag: "commit" });
    expect(f.entries()).toEqual([]);
    f.observe("t_a");
    expect(f.entries()).toEqual([]);
    f.prompt("t_a", 140);
    expect(f.entries()).toMatchObject([{ state: "waiting", workRevision: token + 1 }]);
  });

  it("does not treat old prompts, renames or duplicate idles as new work", () => {
    const f = fixture();
    f.add("t_a");
    f.prompt("t_a");
    f.status("t_a", "idle");
    f.act("review", "t_a");
    f.prompt("t_a", 120);
    f.prompt("t_a", 10);
    f.observe("t_a", { title: "renamed" });
    f.status("t_a", "idle");
    expect(f.entries()).toEqual([]);
  });

  it("shows genuine activity after a review before the user message is seen", () => {
    const f = fixture();
    f.add("t_a");
    f.prompt("t_a");
    f.status("t_a", "idle");
    f.act("review", "t_a");
    f.status("t_a", "working");
    expect(f.lanes()).toEqual([["t_a", "running"]]);
    f.status("t_a", "idle");
    expect(f.lanes()).toEqual([["t_a", "waiting"]]);
  });

  it("persists backlog as an acknowledged lane and returns it to review for new work", () => {
    const f = fixture();
    f.add("t_a");
    f.prompt("t_a");
    f.status("t_a", "idle");
    const token = f.token("t_a");
    f.act("backlog", "t_a");
    expect(f.entries()).toMatchObject([{ state: "backlog", workRevision: token }]);
    expect(f.act("restore", "t_a", token)).toMatchObject({ _tag: "commit" });
    expect(f.entries()).toMatchObject([{ state: "waiting", workRevision: token + 1 }]);
    f.act("backlog", "t_a");
    f.prompt("t_a", 180);
    expect(f.entries()).toMatchObject([{ state: "waiting", workRevision: token + 2 }]);
  });

  it.each(["waiting", "backlog", "scheduled"] as const)(
    "completes a %s card and Undo restores its exact lane",
    (lane: "waiting" | "backlog" | "scheduled") => {
      const f = fixture();
      f.add("t_a");
      if (lane === "scheduled") f.prompt("t_a", 120, { scheduledHint: true });
      else f.prompt("t_a");
      f.status("t_a", "idle");
      if (lane === "backlog") f.act("backlog", "t_a");
      const token = f.token("t_a");
      expect(f.lanes()).toEqual([["t_a", lane]]);
      f.act("review", "t_a", token);
      expect(f.entries()).toEqual([]);
      expect(f.model.rows.get("t_a")?.completedFrom).toBe(lane);
      expect(f.act("restore", "t_a", token)).toMatchObject({ _tag: "commit" });
      expect(f.entries()).toMatchObject([{ state: lane, workRevision: token + 1 }]);
    },
  );

  it("rejects running and stale reviews; undo needs the original token", () => {
    const f = fixture();
    f.add("t_a");
    f.prompt("t_a");
    f.status("t_a", "working");
    expect(f.act("review", "t_a")).toMatchObject({ _tag: "conflict", reason: "running" });
    f.status("t_a", "idle");
    const token = f.token("t_a");
    expect(f.act("review", "t_a", token)._tag).toBe("commit");
    expect(f.act("review", "t_a", token)._tag).toBe("noop");
    expect(f.act("restore", "t_a", token)._tag).toBe("commit");
    expect(f.act("review", "t_a", token)).toMatchObject({ _tag: "conflict", reason: "stale" });
    const newer = f.token("t_a");
    f.act("review", "t_a", newer);
    f.prompt("t_a", 150);
    expect(f.act("restore", "t_a", newer)).toMatchObject({ _tag: "conflict", reason: "stale" });
  });

  it("keeps scheduled provenance while running and after settling, with no review", () => {
    const f = fixture();
    f.add("t_cron");
    f.prompt("t_cron", 120, { scheduledHint: true });
    f.status("t_cron", "working");
    expect(f.lanes()).toEqual([["t_cron", "running"]]);
    f.status("t_cron", "idle");
    expect(f.lanes()).toEqual([["t_cron", "scheduled"]]);
    // The schedule's next run stays a scheduled card.
    f.prompt("t_cron", 200, { scheduledHint: true });
    f.status("t_cron", "idle");
    expect(f.lanes()).toEqual([["t_cron", "scheduled"]]);
  });

  it("returns a once-scheduled thread to review when the user prompts it", () => {
    const f = fixture();
    f.add("t_cell");
    f.prompt("t_cell", 120);
    f.act("review", "t_cell");
    // A watcher schedule wakes the thread once.
    f.prompt("t_cell", 200, { scheduledHint: true });
    f.status("t_cell", "idle");
    expect(f.lanes()).toEqual([["t_cell", "scheduled"]]);
    // The next prompt is the user's, so its result needs review.
    f.prompt("t_cell", 300);
    f.status("t_cell", "working");
    expect(f.lanes()).toEqual([["t_cell", "running"]]);
    f.status("t_cell", "idle");
    expect(f.lanes()).toEqual([["t_cell", "waiting"]]);
  });

  it("corrects a persisted scheduled card whose latest prompt is not a scheduled run", () => {
    const f = fixture();
    f.add("t_cell");
    f.prompt("t_cell", 120, { scheduledHint: true });
    expect(f.lanes()).toEqual([["t_cell", "scheduled"]]);
    f.observe("t_cell", { scheduledHint: false });
    expect(f.lanes()).toEqual([["t_cell", "waiting"]]);
  });

  it("keeps automated origins scheduled through user prompts", () => {
    const f = fixture();
    f.model.origins.set("t_crw", "crw");
    f.add("t_crw");
    f.prompt("t_crw", 120);
    f.prompt("t_crw", 200, { scheduledHint: false });
    expect(f.lanes()).toEqual([["t_crw", "scheduled"]]);
  });

  it("shows a pending scheduled run as running after a restart until it is read", () => {
    const f = fixture();
    f.add("t_cron");
    f.prompt("t_cron", 120, { scheduledHint: true });
    f.status("t_cron", "working");
    const restarted = new BoardModel({ activatedAt: ACTIVATED, now: () => 2_000 });
    for (const row of f.model.rows.values()) restarted.rows.set(row.threadId, row);
    expect(restarted.entries()).toMatchObject([{ state: "running", status: "unknown" }]);
  });

  it("routes automated origins to the scheduled lane", () => {
    const f = fixture();
    f.model.origins.set("t_crw", "crw");
    f.add("t_crw");
    f.prompt("t_crw");
    f.status("t_crw", "idle");
    expect(f.lanes()).toEqual([["t_crw", "scheduled"]]);
  });

  it("dates an automated card whose only prompt predates activation", () => {
    const f = fixture();
    f.model.origins.set("t_crw", "crw");
    f.add("t_crw");
    f.prompt("t_crw", 50);
    expect(f.lanes()).toEqual([["t_crw", "scheduled"]]);
    expect(f.model.rows.get("t_crw")?.updatedAt).toBe(50);
  });

  it("completes a card when the user settles its thread, and keeps a later restore", () => {
    const f = fixture();
    f.prompt("t1");
    expect(f.lanes()).toEqual([["t1", "waiting"]]);
    f.observe("t1", { settled: true, settledByUser: true });
    expect(f.lanes()).toEqual([]);
    expect(f.model.rows.get("t1")?.completedFrom).toBe("waiting");
    // Later reads of the still-settled thread don't undo a restore.
    expect(f.act("restore", "t1")._tag).toBe("commit");
    f.observe("t1", { settled: true });
    expect(f.lanes()).toEqual([["t1", "waiting"]]);
  });

  it("completes a Later card on a user settle", () => {
    const f = fixture();
    f.prompt("t1");
    f.act("backlog", "t1");
    f.observe("t1", { settled: true, settledByUser: true });
    expect(f.lanes()).toEqual([]);
    expect(f.model.rows.get("t1")?.completedFrom).toBe("backlog");
  });

  it("completes on a settle while background work drains, and clears once it ends", () => {
    const f = fixture();
    f.prompt("t1");
    f.status("t1", "background", { settled: true, settledByUser: true });
    expect(f.model.rows.get("t1")?.reviewed).toBe(true);
    f.status("t1", "idle", { settled: true });
    expect(f.lanes()).toEqual([]);
  });

  it("ignores a settled shell without a user settle (startup, auto-settle)", () => {
    const f = fixture();
    f.prompt("t1");
    f.act("backlog", "t1");
    f.observe("t1", { settled: true });
    expect(f.lanes()).toEqual([["t1", "backlog"]]);
  });

  it("does not complete a running card on settle", () => {
    const f = fixture();
    f.prompt("t1");
    f.status("t1", "working", { settled: true, settledByUser: true });
    expect(f.lanes()).toEqual([["t1", "running"]]);
  });

  it("tracks a pending question as needs-input on a running card and rolls subagent requests up", () => {
    const f = fixture();
    f.add("t_root");
    f.child("t_sub", "t_root");
    f.prompt("t_root");
    f.status("t_root", "background");
    f.status("t_sub", "working");
    f.attention("t_sub", "question");
    expect(f.entries()).toMatchObject([
      {
        threadId: "t_root",
        state: "running",
        status: "needs-input",
        attention: { kind: "question", count: 1 },
      },
    ]);
    f.attention("t_sub", null);
    expect(f.entries()[0]?.attention).toBeUndefined();
  });

  it("shows a reviewed root again while one of its requests is open", () => {
    const f = fixture();
    f.add("t_root");
    f.prompt("t_root");
    f.status("t_root", "idle");
    f.act("review", "t_root");
    f.attention("t_root", "approval");
    expect(f.entries()).toMatchObject([{ state: "waiting", attention: { kind: "approval" } }]);
    f.attention("t_root", null);
    expect(f.entries()).toEqual([]);
  });

  it("keeps a reviewed root hidden when its subagent starts running", () => {
    const f = fixture();
    f.add("t_root");
    f.child("t_sub", "t_root");
    f.prompt("t_root");
    f.status("t_root", "idle");
    f.act("review", "t_root");
    f.status("t_sub", "working");
    expect(f.entries()).toEqual([]);
  });

  it("retains a deleted card until it is ticked, then allows Undo", () => {
    const f = fixture();
    f.add("t_a");
    f.prompt("t_a");
    f.status("t_a", "working");
    f.deleted("t_a");
    expect(f.entries()).toMatchObject([{ state: "waiting", status: "deleted" }]);
    const token = f.token("t_a");
    expect(f.act("review", "t_a", token)._tag).toBe("commit");
    expect(f.entries()).toEqual([]);
    expect(f.act("restore", "t_a", token)._tag).toBe("commit");
    expect(f.entries()).toMatchObject([{ status: "deleted" }]);
  });

  describe("scheduled runs", () => {
    const run = (f: ReturnType<typeof fixture>, threadId: string, at: number, task = "task-a") => {
      f.add(threadId);
      f.prompt(threadId, at, { scheduledHint: true });
      f.model.schedules.set(threadId, task);
    };
    const supersede = (f: ReturnType<typeof fixture>) => {
      const rows = f.model.supersededRuns();
      for (const row of rows) f.model.rows.set(row.threadId, row);
      return rows.map((row) => row.threadId);
    };

    it("keeps one card per schedule and completes the older runs like a review", () => {
      const f = fixture();
      run(f, "t_1", 120);
      run(f, "t_2", 140);
      run(f, "t_other", 130, "task-b");
      const token = f.token("t_1");
      expect(supersede(f)).toEqual(["t_1"]);
      expect(Object.fromEntries(f.lanes())).toEqual({ t_2: "scheduled", t_other: "scheduled" });
      expect(f.model.rows.get("t_1")).toMatchObject({
        reviewed: true,
        pending: false,
        completedFrom: "scheduled",
        workRevision: token,
      });
      // Undo still works with the token the card last showed.
      expect(f.act("restore", "t_1", token)._tag).toBe("commit");
      expect(supersede(f)).toEqual([]);
      expect(f.lanes().map(([id]) => id)).toContain("t_1");
      // The schedule's next run replaces the restored card too.
      f.tick(1_000);
      run(f, "t_3", 3_000);
      expect(supersede(f).sort()).toEqual(["t_1", "t_2"]);
      expect(Object.fromEntries(f.lanes())).toEqual({ t_3: "scheduled", t_other: "scheduled" });
    });

    it("leaves an older run that is still running or waiting on a question", () => {
      const f = fixture();
      run(f, "t_busy", 110);
      run(f, "t_asks", 120);
      run(f, "t_new", 140);
      f.status("t_busy", "working");
      f.attention("t_asks", "question");
      expect(supersede(f)).toEqual([]);
      expect(Object.fromEntries(f.lanes())).toEqual({
        t_busy: "running",
        t_asks: "scheduled",
        t_new: "scheduled",
      });
      f.status("t_busy", "idle");
      f.attention("t_asks", null);
      expect(supersede(f).sort()).toEqual(["t_asks", "t_busy"]);
      expect(f.lanes()).toEqual([["t_new", "scheduled"]]);
    });

    it("keeps an older run that shows as running after a restart until it is read", () => {
      const f = fixture();
      run(f, "t_1", 120);
      run(f, "t_2", 140);
      f.model.live.delete("t_1");
      expect(supersede(f)).toEqual([]);
    });

    it("never touches backlog cards, ungrouped cards or the newest run", () => {
      const f = fixture();
      run(f, "t_1", 120);
      f.act("backlog", "t_1");
      f.add("t_plain");
      f.prompt("t_plain", 125);
      f.model.schedules.set("t_plain", null);
      run(f, "t_2", 140);
      expect(supersede(f)).toEqual([]);
      expect(f.model.rows.get("t_1")).toMatchObject({ backlog: true, completedFrom: null });
      expect(f.lanes().map(([id]) => id)).toEqual(expect.arrayContaining(["t_plain", "t_2"]));
    });
  });

  describe("iMessage threads", () => {
    it("never makes an iMessage root or its subagents pending or visible", () => {
      const f = fixture();
      f.model.origins.set("t_chat", "imessage");
      f.add("t_chat");
      f.child("t_sub", "t_chat");
      f.prompt("t_chat");
      f.status("t_chat", "working");
      f.status("t_sub", "working");
      f.attention("t_sub", "question");
      expect(f.entries()).toEqual([]);
      f.status("t_chat", "idle");
      expect(f.entries()).toEqual([]);
      expect(f.model.rows.get("t_chat")?.pending ?? false).toBe(false);
    });

    it("treats a fork of an iMessage thread as quiet through its root", () => {
      const f = fixture();
      f.model.origins.set("t_chat", "imessage");
      f.add("t_chat");
      f.child("t_fork", "t_chat", "fork");
      f.prompt("t_fork");
      f.status("t_fork", "working");
      expect(f.entries()).toEqual([]);
    });

    it("hides an existing card once the origin arrives, and shows it again when removed", () => {
      const f = fixture();
      f.add("t_chat");
      f.prompt("t_chat");
      f.status("t_chat", "idle");
      expect(f.entries()).toHaveLength(1);
      f.model.origins.set("t_chat", "imessage");
      expect(f.entries()).toEqual([]);
      expect(f.model.rows.get("t_chat")?.pending).toBe(true);
      // New work in it raises nothing either.
      f.prompt("t_chat", 140);
      expect(f.model.rows.get("t_chat")?.promptAt).toBe(140);
      expect(f.entries()).toEqual([]);
      f.model.origins.delete("t_chat");
      expect(f.entries()).toHaveLength(1);
    });
  });
});
