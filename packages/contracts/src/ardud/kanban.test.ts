import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  KANBAN_BACKLOG,
  KanbanAnswer,
  KanbanBoard,
  KanbanCardEvent,
  kanbanAwaitsMerge,
  kanbanBlocking,
  kanbanBoardIcon,
  kanbanEvaluatorStep,
  kanbanHeldUpBy,
  kanbanScriptStep,
  kanbanWaitsOnEvaluator,
  KanbanBoardIconImage,
  KanbanCard,
  KANBAN_WAIT_LIMIT_MS,
  KANBAN_CARD_EVENT_KINDS,
  KANBAN_WAIT_CHECK_FAILURES,
  kanbanWait,
  kanbanWaitCheckFailing,
  kanbanWaitDeadlineMs,
  kanbanWaitExpired,
  kanbanWaiting,
  kanbanWaitStale,
  kanbanWithoutWait,
  type KanbanWait,
  KANBAN_BOARD_IMAGE_MAX,
  KanbanSubtask,
  KanbanThreadLink,
} from "./kanban.ts";

type CardPatch = Partial<Omit<KanbanCard, "blockedBy">> & { readonly blockedBy?: string[] };

function card(id: string, patch: CardPatch = {}): KanbanCard {
  const { blockedBy = [], ...rest } = patch;
  return {
    id: id as KanbanCard["id"],
    boardId: "board-toy" as KanbanCard["boardId"],
    number: 1,
    title: id,
    description: "",
    prompt: "",
    stage: "todo",
    priority: 3,
    goalId: null,
    projects: [],
    model: { instanceId: "opencode" as never, model: "opus/claude-opus-5-5" },
    models: [],
    subtasks: [],
    subtaskSeq: 0,
    projectId: null,
    links: [],
    blockedBy: blockedBy as never,
    stalled: null,
    question: null,
    asks: [],
    reviewChain: null,
    reviewStep: 0,
    reviewRound: 0,
    activeThreadId: null,
    activeRole: null,
    activePool: null,
    workThreadId: null,
    reviewThreadId: null,
    discussionId: null,
    wakeNote: null,
    nudgedAt: null,
    settledAt: null,
    createdBy: { _tag: "owner" },
    createdAt: "2026-10-25T10:00:00.000Z",
    updatedAt: "2026-10-25T10:00:00.000Z",
    movedAt: "2026-10-25T10:00:00.000Z",
    ...rest,
  };
}

describe("KanbanCardEvent", () => {
  it("decodes an event stored before head existed as head null", () => {
    const event = Schema.decodeUnknownSync(KanbanCardEvent)({
      id: 1,
      cardId: "card-1",
      at: "2026-10-29T10:00:00.000Z",
      actor: { _tag: "owner" },
      kind: "review",
      fromStage: "in_review",
      toStage: "completed",
      body: "clear",
    });
    expect(event.head).toBeNull();
  });
});

describe("kanbanBlocking", () => {
  it("counts a diamond of waiters once each and takes the most urgent one's priority", () => {
    const blocking = kanbanBlocking([
      card("a"),
      card("b", { blockedBy: ["a"] }),
      card("c", { blockedBy: ["a"], priority: 1 }),
      card("d", { blockedBy: ["b", "c"] }),
      card("e", { blockedBy: ["missing", "e"] }),
      card("f", { blockedBy: ["a"], stage: "completed" }),
    ]);
    expect(blocking.get("a")).toEqual({ holds: 3, urgency: 1 });
    expect(blocking.get("b")).toEqual({ holds: 1, urgency: 3 });
    expect(blocking.get("e")).toEqual({ holds: 0, urgency: 3 });
    expect(blocking.has("f")).toBe(false);
  });

  it("leaves backlog cards out of the waiting, and at the bottom", () => {
    const blocking = kanbanBlocking([
      card("a"),
      card("b", { blockedBy: ["a"], priority: KANBAN_BACKLOG }),
      card("c", { priority: KANBAN_BACKLOG }),
      card("d", { blockedBy: ["c"], priority: 1 }),
    ]);
    expect(blocking.get("a")).toEqual({ holds: 0, urgency: 3 });
    expect(blocking.get("c")).toEqual({ holds: 1, urgency: KANBAN_BACKLOG });
  });
});

describe("kanbanHeldUpBy", () => {
  const evaluatorSubtask = (text: string, state: "open" | "done" = "open") => ({
    id: "s1",
    step: 4,
    text,
    owner: "evaluator" as const,
    state,
    note: null,
    doneBy: null,
    doneAt: null,
  });
  const mergeText =
    "Rebase on latest ardud/main, rerun the box checks if it moved, merge into ardud/main, push origin main";
  const waiter = card("w", { blockedBy: ["b"], workThreadId: "thread-w" as never });
  const byId = (blocker: KanbanCard) => new Map([[blocker.id, blocker]]);

  it("holds a waiter on a completed blocker whose merge subtask is open", () => {
    const blocker = card("b", {
      stage: "completed",
      workThreadId: "thread-b" as never,
      subtasks: [evaluatorSubtask(mergeText)],
    });
    expect(kanbanHeldUpBy(waiter, byId(blocker))).toBe(blocker);
  });

  it("releases the waiter once the blocker's merge subtask is done", () => {
    const blocker = card("b", {
      stage: "completed",
      workThreadId: "thread-b" as never,
      subtasks: [evaluatorSubtask(mergeText, "done")],
    });
    expect(kanbanHeldUpBy(waiter, byId(blocker))).toBeUndefined();
  });

  it("releases a waiter once the merge is done, even with a post-install check still open", () => {
    const blocker = card("b", {
      stage: "completed",
      workThreadId: "thread-b" as never,
      subtasks: [
        evaluatorSubtask(mergeText, "done"),
        evaluatorSubtask(
          "After the next Robob install: check a dependent waits until its blocker's merge subtask is done.",
        ),
      ],
    });
    expect(kanbanHeldUpBy(waiter, byId(blocker))).toBeUndefined();
  });

  it("holds a waiter on the other merge action forms on the board", () => {
    for (const text of [
      "Bring any prefs.md rule text to Abdullah first; merge; deploy robob-watch",
      "merge router.ts into ardud/main",
    ]) {
      const blocker = card("b", {
        stage: "completed",
        workThreadId: "thread-b" as never,
        subtasks: [evaluatorSubtask(text)],
      });
      expect(kanbanHeldUpBy(waiter, byId(blocker))).toBe(blocker);
    }
  });

  it("doesn't hold a waiter on a completed blocker with only a deploy step open", () => {
    const blocker = card("b", {
      stage: "completed",
      workThreadId: "thread-b" as never,
      subtasks: [evaluatorSubtask("Ask Abdullah to deploy spectrum-bridge")],
    });
    expect(kanbanHeldUpBy(waiter, byId(blocker))).toBeUndefined();
  });

  it("doesn't hold a waiter on a verified blocker", () => {
    const blocker = card("b", {
      stage: "verified",
      workThreadId: "thread-b" as never,
      subtasks: [evaluatorSubtask(mergeText)],
    });
    expect(kanbanHeldUpBy(waiter, byId(blocker))).toBeUndefined();
  });

  it("doesn't hold a waiter on the same thread as a completed blocker awaiting merge", () => {
    const blocker = card("b", {
      stage: "completed",
      workThreadId: "thread-w" as never,
      subtasks: [evaluatorSubtask(mergeText)],
    });
    expect(kanbanHeldUpBy(waiter, byId(blocker))).toBeUndefined();
  });
});

const decodeBoard = Schema.decodeUnknownSync(KanbanBoard);

describe("kanbanBoardIcon", () => {
  const opus = { instanceId: "opencode", model: "opus/claude-opus-5-5" };
  const stored = {
    id: "board-toy",
    slug: "toy",
    name: "Toy",
    defaultProjectId: null,
    managerModel: opus,
    evaluatorModel: opus,
    defaultCardModel: opus,
    reviewChains: [],
    defaultReviewChain: null,
    instructions: { modelRouting: "", reviewerRouting: "", escalation: "" },
    createdAt: "2026-10-27T00:00:00.000Z",
    archivedAt: null,
  };

  it("reads a board saved before icons as having none, and drops names it doesn't know", () => {
    expect(kanbanBoardIcon(decodeBoard(stored))).toBeNull();
    expect(kanbanBoardIcon(decodeBoard({ ...stored, icon: "rocket" }))).toBe("rocket");
    expect(kanbanBoardIcon(decodeBoard({ ...stored, icon: "retired" }))).toBeNull();
    expect(decodeBoard(stored).iconImage).toBeNull();
  });

  it("takes only small inline pictures as a board image", () => {
    const valid = Schema.is(KanbanBoardIconImage);
    expect(valid("data:image/webp;base64,UklGRg==")).toBe(true);
    expect(valid("data:image/svg+xml;base64,PHN2Zz4=")).toBe(false);
    expect(valid("https://example.com/icon.png")).toBe(false);
    expect(valid(`data:image/png;base64,${"A".repeat(KANBAN_BOARD_IMAGE_MAX)}`)).toBe(false);
  });

  describe("own answers", () => {
    it("decodes an answer saved before own words existed with text null", () => {
      const decoded = Schema.decodeUnknownSync(KanbanAnswer)({
        blockId: "q1",
        by: { _tag: "owner" },
        choice: ["o1"],
        at: "2026-10-27T10:00:00.000Z",
      });
      expect(decoded.text).toBeNull();
      expect(decoded.choice).toEqual(["o1"]);
    });
  });
});

const decodeThreadLink = Schema.decodeUnknownSync(KanbanThreadLink);

describe("KanbanThreadLink", () => {
  it("decodes a link written before pauses existed as not paused", () => {
    const decoded = decodeThreadLink({
      threadId: "thread-1",
      boardId: "board-1",
      cardId: null,
      role: "work",
      purpose: null,
      discussionId: null,
      model: null,
      startedAt: "2026-10-28T00:00:00.000Z",
      endedAt: null,
    });
    expect(decoded.paused).toBeNull();
  });

  it("decodes a pause written before run ids existed", () => {
    const decoded = decodeThreadLink({
      threadId: "thread-1",
      boardId: "board-1",
      cardId: null,
      role: "work",
      purpose: null,
      discussionId: null,
      model: null,
      startedAt: "2026-10-28T00:00:00.000Z",
      endedAt: null,
      paused: { at: "2026-10-28T01:00:00.000Z", message: "provider down" },
    });
    expect(decoded.paused).toEqual({
      at: "2026-10-28T01:00:00.000Z",
      message: "provider down",
      runId: null,
    });
  });
});

const scriptSubtask = (
  id: string,
  step: number,
  text: string,
  owner: "script" | "evaluator" | "work",
  state: "open" | "done" = "open",
) => ({
  id,
  step,
  text,
  owner,
  ...(owner === "script" ? { script: "land" } : {}),
  state,
  note: null,
  doneBy: null,
  doneAt: null,
});

describe("board script steps", () => {
  it("a script-only step is the script's, and a mixed one still wakes the evaluator", () => {
    const scriptOnly = { subtasks: [scriptSubtask("s1", 1, "Merge the PR", "script")] };
    expect(kanbanScriptStep(scriptOnly)).toBe(true);
    expect(kanbanEvaluatorStep(scriptOnly)).toBe(false);

    const mixed = {
      subtasks: [
        scriptSubtask("s1", 1, "Merge the PR", "script"),
        scriptSubtask("s2", 1, "Tell the reporter", "evaluator"),
      ],
    };
    expect(kanbanScriptStep(mixed)).toBe(false);
    expect(kanbanEvaluatorStep(mixed)).toBe(true);
  });

  it("an evaluator-only step, or evaluator plus script, wakes the evaluator", () => {
    expect(kanbanEvaluatorStep({ subtasks: [scriptSubtask("s1", 1, "Tell", "evaluator")] })).toBe(
      true,
    );
    expect(
      kanbanEvaluatorStep({
        subtasks: [
          scriptSubtask("s1", 1, "Merge", "evaluator"),
          scriptSubtask("s2", 1, "Deploy", "script"),
        ],
      }),
    ).toBe(true);
  });

  it("a todo card on a script-only step is left to its script", () => {
    expect(
      kanbanWaitsOnEvaluator({
        stage: "todo",
        wakeNote: null,
        subtasks: [scriptSubtask("s1", 1, "Merge the PR", "script")],
      }),
    ).toBe(true);
  });

  it("a completed card with an open script merge subtask awaits its merge", () => {
    expect(
      kanbanAwaitsMerge({
        stage: "completed",
        subtasks: [scriptSubtask("s3", 3, "Merge the PR", "script")],
      }),
    ).toBe(true);
  });

  it("a subtask saved without a script name still decodes", () => {
    const decoded = Schema.decodeUnknownSync(KanbanSubtask)({
      id: "s1",
      step: 1,
      text: "Write the PR",
      owner: "work",
      state: "open",
      note: null,
      doneBy: null,
      doneAt: null,
    });
    expect(decoded.script).toBeUndefined();
  });
});

describe("KanbanCard wait", () => {
  const stored = (extra: Record<string, unknown> = {}) => ({
    ...Schema.encodeSync(KanbanCard)(card("stored")),
    ...extra,
  });
  const wait = (patch: Partial<KanbanWait> = {}): KanbanWait => ({
    on: "push",
    pr: "https://github.com/acme/app/pull/12" as never,
    card: null,
    ask: null,
    until: null,
    sinceHead: "a1b2c3d4",
    note: "author to push the fix",
    by: { _tag: "owner" },
    at: "2026-10-25T10:00:00.000Z" as never,
    wakeRole: null,
    expiredAt: null,
    script: null,
    args: null,
    status: null,
    lastCheckedAt: null,
    failures: 0,
    problem: null,
    ...patch,
  });

  it("decodes a card stored before waits existed, and encodes it back without a wait key", () => {
    const encoded = stored();
    expect("wait" in encoded).toBe(false);
    const decoded = Schema.decodeUnknownSync(KanbanCard)(encoded);
    expect(decoded.wait).toBeUndefined();
    expect(kanbanWait(decoded)).toBeNull();
    expect(kanbanWaiting(decoded)).toBe(false);
    expect(JSON.parse(JSON.stringify(Schema.encodeSync(KanbanCard)(decoded)))).toEqual(encoded);
  });

  it("fills the optional parts of a stored wait", () => {
    const decoded = Schema.decodeUnknownSync(KanbanCard)(
      stored({
        wait: {
          on: "merge",
          pr: "https://github.com/acme/app/pull/12",
          note: "parent PR",
          by: { _tag: "owner" },
          at: "2026-10-25T10:00:00.000Z",
        },
      }),
    );
    expect(decoded.wait).toEqual({
      on: "merge",
      pr: "https://github.com/acme/app/pull/12",
      card: null,
      ask: null,
      until: null,
      sinceHead: null,
      note: "parent PR",
      by: { _tag: "owner" },
      at: "2026-10-25T10:00:00.000Z",
      wakeRole: null,
      expiredAt: null,
      script: null,
      args: null,
      status: null,
      lastCheckedAt: null,
      failures: 0,
      problem: null,
    });
  });

  it("decodes a script wait with its args and check state", () => {
    const decoded = Schema.decodeUnknownSync(KanbanCard)(
      stored({
        wait: {
          on: "script",
          script: "linear-state",
          args: { issue: "ENG-123", state: "Done", everyMs: 600000 },
          note: "ENG-123 to reach Done",
          by: { _tag: "owner" },
          at: "2026-10-25T10:00:00.000Z",
          status: "In Review",
          lastCheckedAt: "2026-10-25T10:05:00.000Z",
          failures: 3,
          problem: "Linear said 401",
        },
      }),
    );
    expect(decoded.wait).toMatchObject({
      on: "script",
      script: "linear-state",
      args: { issue: "ENG-123", state: "Done", everyMs: 600000 },
      status: "In Review",
      failures: 3,
    });
    expect(kanbanWaitCheckFailing(decoded.wait!)).toBe(true);
    expect(kanbanWaitCheckFailing({ failures: KANBAN_WAIT_CHECK_FAILURES - 1 })).toBe(false);
  });

  it("drops a wait of a kind this build doesn't know instead of failing the card", () => {
    // A newer server may add kinds; an older client must still load the board.
    const decoded = Schema.decodeUnknownSync(KanbanCard)(
      stored({
        wait: {
          on: "deploy",
          note: "prod deploy",
          by: { _tag: "owner" },
          at: "2026-10-25T10:00:00.000Z",
        },
      }),
    );
    expect(decoded.wait).toBeUndefined();
    expect(decoded.id).toBe("stored");
    // So does a field it never heard of on a wait it does know.
    const extra = Schema.decodeUnknownSync(KanbanCard)(
      stored({
        wait: {
          on: "time",
          until: "2026-10-26T10:00:00.000Z",
          note: "recheck",
          by: { _tag: "owner" },
          at: "2026-10-25T10:00:00.000Z",
          somethingNew: { nested: true },
        },
      }),
    );
    expect(extra.wait?.on).toBe("time");
  });

  it("decodes an event kind this build doesn't know as a generic event", () => {
    const event = (kind: string) =>
      Schema.decodeUnknownSync(KanbanCardEvent)({
        id: 1,
        cardId: "card-1",
        at: "2026-10-29T10:00:00.000Z",
        actor: { _tag: "owner" },
        kind,
        fromStage: null,
        toStage: null,
        body: "Something a newer server logged",
      });
    expect(event("wait_failing").kind).toBe("other");
    expect(event("").kind).toBe("other");
    expect(event("moved").kind).toBe("moved");
    expect(event("wait_failing").body).toBe("Something a newer server logged");
    // A whole card history with one unknown kind in it still loads.
    const detail = Schema.decodeUnknownSync(Schema.Array(KanbanCardEvent))(
      ["created", "from_the_future", "comment"].map((kind, index) => ({
        id: index + 1,
        cardId: "card-1",
        at: "2026-10-29T10:00:00.000Z",
        actor: { _tag: "owner" },
        kind,
        fromStage: null,
        toStage: null,
        body: null,
      })),
    );
    expect(detail.map((entry) => entry.kind)).toEqual(["created", "other", "comment"]);
    expect(KANBAN_CARD_EVENT_KINDS).toContain("other");
  });

  it("decodes the wait event kinds", () => {
    for (const kind of ["wait_set", "wait_cleared", "wait_expired"]) {
      const event = Schema.decodeUnknownSync(KanbanCardEvent)({
        id: 1,
        cardId: "card-1",
        at: "2026-10-29T10:00:00.000Z",
        actor: { _tag: "owner" },
        kind,
        fromStage: null,
        toStage: null,
        body: "PR merged",
      });
      expect(event.kind).toBe(kind);
    }
  });

  it("counts a card as waiting only with no thread, unsettled and unmoved since", () => {
    const waiting = card("w", { stage: "in_review", wait: wait() });
    expect(kanbanWaiting(waiting)).toBe(true);
    expect(kanbanWaiting({ ...waiting, activeThreadId: "thread-1" as never })).toBe(false);
    expect(kanbanWaiting({ ...waiting, settledAt: "2026-10-26T10:00:00.000Z" as never })).toBe(
      false,
    );
    const moved = { ...waiting, movedAt: "2026-10-25T11:00:00.000Z" as never };
    expect(kanbanWaitStale(moved)).toBe(true);
    expect(kanbanWaiting(moved)).toBe(false);
  });

  it("drops the wait key, not sets it to undefined", () => {
    const cleared = kanbanWithoutWait(card("w", { wait: wait() }));
    expect("wait" in cleared).toBe(false);
    const plain = card("p");
    expect(kanbanWithoutWait(plain)).toBe(plain);
  });

  it("expires by the kind's limit, the wait's own until, or never for a time wait", () => {
    const at = Date.parse("2026-10-25T10:00:00.000Z");
    expect(kanbanWaitDeadlineMs(wait())).toBe(at + KANBAN_WAIT_LIMIT_MS.push!);
    expect(kanbanWaitExpired(wait(), at + KANBAN_WAIT_LIMIT_MS.push! - 1)).toBe(false);
    expect(kanbanWaitExpired(wait(), at + KANBAN_WAIT_LIMIT_MS.push!)).toBe(true);
    const own = wait({ until: "2026-10-25T12:00:00.000Z" as never });
    expect(kanbanWaitDeadlineMs(own)).toBe(Date.parse("2026-10-25T12:00:00.000Z"));
    const time = wait({ on: "time", pr: null, until: "2026-10-25T12:00:00.000Z" as never });
    expect(kanbanWaitDeadlineMs(time)).toBeNull();
    expect(kanbanWaitExpired(time, at + 365 * 24 * 60 * 60 * 1000)).toBe(false);
    expect(kanbanWaitExpired(wait({ expiredAt: "2026-10-25T10:05:00.000Z" as never }), at)).toBe(
      true,
    );
  });
});
