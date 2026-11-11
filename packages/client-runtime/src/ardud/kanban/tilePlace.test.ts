import type { KanbanBoardSnapshot, KanbanCard, KanbanThreadState } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { boardStateFromSnapshot, type KanbanBoardState } from "./boardState.ts";
import { createBoardView, type BoardLane, type BoardViewParams } from "./boardView.ts";
import { stuckSummary, tilePlace, type TilePlace } from "./tilePlace.ts";

const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const ago = (ms: number) => iso(NOW - ms);
const model = { instanceId: "opencode", model: "opus/claude-opus-5-5" } as never;
const SYSTEM = { _tag: "system", component: "dispatcher" } as never;
const OWNER = { _tag: "owner" } as never;

function card(number: number, patch: Partial<KanbanCard> = {}): KanbanCard {
  return {
    id: `card-${number}`,
    boardId: "board-toy",
    number,
    title: `Card ${number}`,
    description: "",
    prompt: "",
    stage: "todo",
    priority: 3,
    goalId: null,
    projects: [],
    model,
    models: [],
    subtasks: [],
    subtaskSeq: 0,
    projectId: null,
    links: [],
    blockedBy: [],
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
    createdBy: OWNER,
    createdAt: ago(10 * DAY),
    updatedAt: ago(2 * HOUR),
    movedAt: ago(2 * HOUR),
    ...patch,
  } as KanbanCard;
}

const wait = (on: string, patch: Record<string, unknown> = {}) =>
  ({
    on,
    script: null,
    args: null,
    pr: null,
    card: null,
    ask: null,
    until: null,
    sinceHead: null,
    note: "",
    by: SYSTEM,
    at: ago(HOUR),
    wakeRole: null,
    expiredAt: null,
    status: null,
    lastCheckedAt: null,
    failures: 0,
    problem: null,
    ...patch,
  }) as never;

const retry = (patch: Record<string, unknown> = {}) =>
  ({
    kind: "run_failed",
    role: "work",
    runId: "run-1",
    reason: "offbox exit 90",
    at: ago(10 * MINUTE),
    state: "waiting",
    ...patch,
  }) as never;

const thread = (id: string, patch: Partial<KanbanThreadState> = {}): KanbanThreadState =>
  ({
    threadId: id,
    title: id,
    running: true,
    needsInput: false,
    lastActivityAt: ago(MINUTE),
    ...patch,
  }) as KanbanThreadState;

function stateOf(
  cards: KanbanCard[],
  options: {
    threads?: KanbanThreadState[];
    board?: Record<string, unknown>;
    pools?: unknown[];
  } = {},
): KanbanBoardState {
  return boardStateFromSnapshot({
    board: {
      id: "board-toy",
      name: "Toy",
      pause: null,
      setup: null,
      reviewChains: [],
      defaultReviewChain: null,
      ...options.board,
    },
    cards,
    goals: [],
    pools: options.pools ?? [],
    groups: [],
    threads: options.threads ?? [],
    unread: [],
  } as unknown as KanbanBoardSnapshot);
}

const placed = (
  target: KanbanCard,
  others: KanbanCard[] = [],
  options: Parameters<typeof stateOf>[1] = {},
): TilePlace => {
  const state = stateOf([target, ...others], options);
  const pause = state.board.pause;
  return tilePlace(target, state, NOW, pause == null ? null : new Set<string>(pause.keep));
};

const where = (place: TilePlace) => `${place.column}:${place.group}`;
const say = (place: TilePlace) =>
  place.line === null
    ? null
    : [place.line.lead, place.line.rest, place.line.wake].filter((part) => part !== null);

describe("tilePlace", () => {
  it("puts a startable To-Do card under Ready, with nothing to say", () => {
    const place = placed(card(1));
    expect(where(place)).toBe("todo:ready");
    expect(place.line).toBeNull();
    expect(place.stuck).toBeNull();
  });

  it("names the cards a blocked one waits for, and when it starts", () => {
    const blockers = [12, 40, 7, 9].map((number) => card(number));
    const by = (...numbers: number[]) =>
      placed(card(1, { blockedBy: numbers.map((number) => `card-${number}`) as never }), blockers);
    expect(where(by(12))).toBe("todo:blocked");
    expect(say(by(12))).toEqual(["Blocked by #12", "Starts by itself when #12 is done"]);
    expect(say(by(12, 40))).toEqual(["Blocked by #12, #40", "Starts by itself when both are done"]);
    expect(say(by(12, 40, 7))).toEqual([
      "Blocked by #7, #12 and #40",
      "Starts by itself when all three are done",
    ]);
    expect(say(by(12, 40, 7, 9))).toEqual([
      "Blocked by #7, #9 and 2 more",
      "Starts by itself when all 4 are done",
    ]);
    expect(by(12).reason).toBe("Waiting on another card");
  });

  it("parks backlog, flagged, waiting and evaluator-step cards in To-Do", () => {
    const backlog = placed(card(1, { priority: 5 }));
    expect(where(backlog)).toBe("todo:parked");
    expect(backlog.reason).toBe("In the backlog");

    const flagged = placed(
      card(2, { stalled: { reason: "Scope is unclear", at: ago(3 * HOUR), by: OWNER } as never }),
    );
    expect(where(flagged)).toBe("todo:parked");
    expect(say(flagged)).toEqual(["Flagged", "Scope is unclear", "Needs a look"]);
    expect(flagged.edge).toBe("fail");
    expect(flagged.stuck).toBe("flagged");

    // A flag whose own words ask for a look is not told to twice.
    const asking = placed(
      card(4, {
        stalled: {
          reason: "Needs a look: the packet names no repo",
          at: ago(HOUR),
          by: OWNER,
        } as never,
      }),
    );
    expect(say(asking)).toEqual(["Flagged", "Needs a look: the packet names no repo"]);

    const step = placed(
      card(3, {
        subtasks: [
          { id: "s1", step: 1, text: "Write the packet", owner: "evaluator", state: "open" },
        ] as never,
      }),
    );
    expect(where(step)).toBe("todo:parked");
    expect(step.reason).toBe("Waiting on the evaluator");
    // The step in its own words, not its id.
    expect(say(step)).toEqual([
      "Evaluator's step",
      "Write the packet",
      "Moves when the evaluator has done it",
    ]);
  });

  it("holds To-Do and review cards while the board's setup runs", () => {
    const board = { setup: { status: "running", discussionId: "d1" } };
    const todo = placed(card(1), [], { board });
    expect(where(todo)).toBe("todo:blocked");
    expect(say(todo)).toEqual(["Setup is running", "Starts by itself when setup is done"]);
    expect(where(placed(card(2, { stage: "needs_review" }), [], { board }))).toBe(
      "needs_review:blocked",
    );
  });

  it("says why a failed run is retrying, and which try it is", () => {
    const soon = placed(card(1, { retries: [retry({ at: ago(20_000) })] as never }));
    expect(where(soon)).toBe("todo:retry");
    expect(say(soon)).toEqual([
      "Run failed once",
      "offbox exit 90",
      "Retrying shortly, try 2 of 2",
    ]);
    expect(soon.edge).toBe("retry");
    expect(soon.stuck).toBeNull();

    const queued = placed(card(2, { retries: [retry()] as never }));
    expect(say(queued)?.at(-1)).toBe("Retry is queued, try 2 of 2");

    const running = placed(
      card(3, {
        stage: "working",
        activeThreadId: "t3" as never,
        activeRole: "work",
        retries: [retry({ state: "restarted" })] as never,
      }),
      [],
      { threads: [thread("t3")] },
    );
    expect(where(running)).toBe("working:retry");
    expect(say(running)).toEqual(["Run failed once", "offbox exit 90", "Retrying now, try 2 of 2"]);

    const noVerdict = placed(
      card(4, {
        stage: "in_review",
        activeThreadId: "t4" as never,
        activeRole: "review",
        retries: [retry({ kind: "no_verdict", role: "review", runId: null })] as never,
      }),
      [],
      { threads: [thread("t4")] },
    );
    expect(where(noVerdict)).toBe("needs_review:retry");
    expect(say(noVerdict)).toEqual(["Reviewer gave no verdict", "Reviewing again now, try 2 of 2"]);
  });

  it("sorts Working into running, failed and not moving", () => {
    const running = placed(
      card(1, { stage: "working", activeThreadId: "t1" as never, activeRole: "work" }),
      [],
      { threads: [thread("t1")] },
    );
    expect(where(running)).toBe("working:running");
    expect(running.line).toBeNull();

    const failed = placed(
      card(2, {
        stage: "working",
        stalled: {
          reason: "worker stopped with no result",
          at: ago(3 * HOUR),
          by: SYSTEM,
        } as never,
      }),
    );
    expect(where(failed)).toBe("working:failed");
    expect(say(failed)).toEqual([
      "Failed",
      "worker stopped with no result",
      "Needs a look: restart it or reroute it",
    ]);
    expect(failed.stuck).toBe("failed");

    // A reason that opens with the word is not prefixed with it again.
    const twice = placed(
      card(4, {
        stage: "working",
        stalled: {
          reason: "failed twice: worker stopped with no result",
          at: ago(3 * HOUR),
          by: SYSTEM,
        } as never,
      }),
    );
    expect(say(twice)).toEqual([
      "Failed twice: worker stopped with no result",
      "Needs a look: restart it or reroute it",
    ]);

    const idle = placed(
      card(3, { stage: "working", activeThreadId: "t3" as never, activeRole: "work" }),
      [],
      { threads: [thread("t3", { running: false, lastActivityAt: ago(50 * MINUTE) })] },
    );
    expect(where(idle)).toBe("working:quiet");
    expect(idle.line?.lead).toBe("Worker idle");
    expect(idle.line?.since).toBe(ago(50 * MINUTE));
    expect(idle.stuck).toBe("quiet");

    const fresh = placed(
      card(4, { stage: "working", activeThreadId: "t4" as never, activeRole: "work" }),
      [],
      { threads: [thread("t4", { running: false, lastActivityAt: ago(5 * MINUTE) })] },
    );
    expect(where(fresh)).toBe("working:quiet");
    expect(fresh.stuck).toBeNull();

    const asking = placed(
      card(5, { stage: "working", activeThreadId: "t5" as never, activeRole: "work" }),
      [],
      { threads: [thread("t5", { running: false, needsInput: true })] },
    );
    expect(where(asking)).toBe("working:quiet");
    expect(say(asking)).toEqual([
      "Worker is waiting on its own question",
      "Needs a look: open its thread",
    ]);
  });

  it("splits review into what a reviewer is on and what waits", () => {
    const next = placed(card(1, { stage: "needs_review" }));
    expect(where(next)).toBe("needs_review:next");

    const reviewing = placed(
      card(2, { stage: "in_review", activeThreadId: "t2" as never, activeRole: "review" }),
      [],
      { threads: [thread("t2")] },
    );
    expect(where(reviewing)).toBe("needs_review:reviewing");

    const idle = placed(card(3, { stage: "in_review", movedAt: ago(33 * HOUR) }));
    expect(where(idle)).toBe("in_review:idle");
    expect(say(idle)).toEqual([
      "Idle",
      "no reviewer, no wait, no next step",
      "Needs a reviewer, or a reason to wait",
    ]);
    expect(idle.line?.since).toBe(ago(33 * HOUR));
    expect(idle.stuck).toBe("idle");
    expect(idle.edge).toBe("fail");
    // Not stuck until it has sat for a day.
    expect(placed(card(4, { stage: "in_review", movedAt: ago(3 * HOUR) })).stuck).toBeNull();
  });

  it("says who or what a parked review card waits on, and what wakes it", () => {
    const parked = (patch: Record<string, unknown>, on = "push", others: KanbanCard[] = []) =>
      placed(
        card(1, { stage: "in_review", movedAt: ago(20 * DAY), wait: wait(on, patch) }),
        others,
      );

    const author = parked({ at: ago(DAY) });
    expect(where(author)).toBe("in_review:author");
    expect(say(author)).toEqual(["Waiting on the author", "Wakes itself on the next push"]);
    expect(author.line?.since).toBe(ago(DAY));
    expect(author.line?.sinceAs).toBe("date");
    expect(author.stuck).toBeNull();

    // The wait records no author: a name only shows when the note gives a handle.
    const named = parked({ note: "@sharath-kc: round-5 feedback posted", at: ago(DAY) });
    expect(say(named)).toEqual([
      "Waiting on sharath-kc",
      "@sharath-kc: round-5 feedback posted",
      "Wakes itself on the next push",
    ]);
    expect(named.line?.since).toBeNull();

    // A wait that ran out says so in words, not only in colour, and keeps its date.
    const late = parked({ at: ago(13 * DAY), note: "Round-4 feedback posted" });
    expect(late.stuck).toBe("author");
    expect(late.line?.tone).toBe("warn");
    expect(say(late)).toEqual([
      "Waiting on the author",
      "Round-4 feedback posted",
      "Past its 3-day limit: needs a look",
    ]);
    expect(late.line?.since).toBe(ago(13 * DAY));
    expect(late.line?.sinceAs).toBe("date");

    const lateCi = parked({ at: ago(DAY) }, "ci");
    expect(lateCi.line?.wake).toBe("Past its 3-hour limit: needs a look");
    const lateOwn = parked({ at: ago(DAY), until: ago(HOUR) }, "merge");
    expect(lateOwn.line?.wake).toBe("Past its limit: needs a look");

    const merge = parked({ pr: "https://github.com/example-org/api/pull/518" }, "merge");
    expect(where(merge)).toBe("in_review:checks");
    expect(say(merge)).toEqual(["Waiting on merge (PR #518)", "Wakes itself when the PR merges"]);

    const ci = parked({ status: "CI 3 of 5 passed" }, "ci");
    expect(say(ci)).toEqual(["Waiting on CI", "CI 3 of 5 passed", "Wakes itself when CI finishes"]);

    const failing = parked({ failures: 4, problem: "403 from the host" }, "ci");
    expect(failing.stuck).toBe("check");
    expect(failing.line?.wake).toBe("Its check keeps failing: nothing can wake it");
    expect(failing.line?.tone).toBe("negative");

    const go = parked({ ask: "q1", note: "Review clear, CI green" }, "owner_go");
    expect(where(go)).toBe("in_review:held");
    expect(say(go)).toEqual(["Held for your go", "Review clear, CI green", "In Needs you"]);

    const behind = parked({ card: "card-73" }, "card", [card(73)]);
    expect(say(behind)).toEqual(["Held behind #73", "Wakes itself when #73 is done"]);

    const until = iso(NOW + 5 * HOUR);
    const timed = parked({ until }, "time");
    expect(say(timed)).toEqual(["Held for a recheck", "Wakes itself"]);
    expect(timed.line?.wakeAt).toBe(until);

    const script = parked({ script: "release-train" }, "script");
    expect(say(script)).toEqual([
      "Waiting on release-train",
      "Wakes itself when release-train says so",
    ]);
  });

  it("marks a wait guessed from the card's notes as a guess", () => {
    const guessed = placed(
      card(1, {
        stage: "in_review",
        links: [
          {
            kind: "note",
            url: "https://example.org/n",
            label: "waiting on author to push",
            state: null,
          },
        ] as never,
      }),
    );
    expect(where(guessed)).toBe("in_review:author");
    expect(say(guessed)).toEqual([
      "Waiting on the author",
      "A guess from the card's notes. Nothing is watching for it",
    ]);
  });

  it("shows the evaluator's turn", () => {
    const deciding = placed(
      card(1, {
        stage: "in_review",
        movedAt: ago(DAY),
        deciding: { since: ago(10 * MINUTE), why: "The author pushed", toldAt: null } as never,
      }),
    );
    expect(where(deciding)).toBe("in_review:evaluator");
    expect(say(deciding)).toEqual([
      "Evaluator deciding",
      "The author pushed",
      "It decides what the card does next",
    ]);
  });

  it("sends needs-owner and done cards to their own columns", () => {
    expect(where(placed(card(1, { stage: "needs_owner" })))).toBe("needs_owner:owner");
    expect(where(placed(card(2, { stage: "deployed" })))).toBe("shipped:done");
    expect(where(placed(card(3, { stage: "verified", settledAt: ago(DAY) })))).toBe("shipped:done");
    // Neither column is in the Stuck lens: a stale wait there is not counted as stuck.
    const lateDone = placed(
      card(4, { stage: "completed", wait: wait("merge", { at: ago(9 * DAY) }) }),
    );
    expect(where(lateDone)).toBe("shipped:done");
    expect(lateDone.stuck).toBeNull();
    const lateOwner = placed(
      card(5, { stage: "needs_owner", wait: wait("owner_go", { at: ago(9 * DAY) }) }),
    );
    expect(lateOwner.stuck).toBeNull();
  });

  it("holds every card off a paused board's keep list, and lets the kept ones through", () => {
    const board = {
      pause: {
        reason: "Only the migration",
        keep: ["card-1", "card-4"],
        at: ago(5 * DAY),
        by: "owner",
      },
    };
    expect(where(placed(card(1), [], { board }))).toBe("todo:through");

    const held = placed(card(2), [], { board });
    expect(where(held)).toBe("todo:paused");
    expect(say(held)).toEqual([
      "Not on the pause's keep list",
      "Starts by itself when the pause lifts",
    ]);

    const parked = placed(card(3, { stage: "in_review", movedAt: ago(9 * DAY) }), [], { board });
    expect(where(parked)).toBe("in_review:paused");
    expect(say(parked)?.at(-1)).toBe("Wakes itself when the pause lifts");
    // Nothing the pause holds needs a look.
    expect(parked.stuck).toBeNull();
    // A failure still says so: lifting the pause would not start it.
    const failedHeld = placed(
      card(6, { stalled: { reason: "worker stopped", at: ago(HOUR), by: SYSTEM } as never }),
      [],
      { board },
    );
    expect(where(failedHeld)).toBe("todo:parked");
    expect(failedHeld.stuck).toBe("failed");
    // Only a card that is ready promises to start when the pause lifts.
    const backlogHeld = placed(card(7, { priority: 5 }), [], { board });
    expect(where(backlogHeld)).toBe("todo:paused");
    expect(say(backlogHeld)).toEqual(["Not on the pause's keep list"]);
    // Queued for review but held: not what a reviewer takes next.
    const queued = placed(card(5, { stage: "needs_review" }), [], { board });
    expect(where(queued)).toBe("in_review:paused");

    // A kept card is placed as on any board; one a thread is already on shows that thread.
    expect(where(placed(card(4, { blockedBy: ["card-9"] as never }), [card(9)], { board }))).toBe(
      "todo:blocked",
    );
    const running = placed(
      card(5, { stage: "working", activeThreadId: "t5" as never, activeRole: "work" }),
      [],
      { board, threads: [thread("t5")] },
    );
    expect(where(running)).toBe("working:running");
  });
});

describe("stuckSummary", () => {
  it("counts stuck cards by why", () => {
    expect(
      stuckSummary(
        new Map([
          ["idle", 46],
          ["failed", 1],
          ["author", 7],
        ]),
      ),
    ).toBe(
      "54 stuck: 1 failed after a retry, 46 idle in review, 7 waiting on an author for over 3 days. Every one says why.",
    );
    expect(stuckSummary(new Map([["wait", 1]]))).toBe(
      "1 stuck: 1 past its wait's limit. Every one says why.",
    );
    expect(stuckSummary(new Map([["wait", 2]]))).toBe(
      "2 stuck: 2 past their wait's limit. Every one says why.",
    );
    expect(stuckSummary(new Map())).toBe("Nothing is stuck.");
  });
});

describe("the stage board's groups", () => {
  const rowsOf = (lane: BoardLane) =>
    lane.rows.map((row) =>
      row.kind === "card"
        ? `#${row.card.number}`
        : row.kind === "group"
          ? `${row.label} ${row.count}${row.open ? "" : " (folded)"}`
          : row.kind === "more"
            ? `${row.count} more`
            : row.kind === "reasons"
              ? row.items.map((item) => `${item.label} ${item.count}`).join("; ")
              : row.kind === "note"
                ? row.text
                : row.label,
    );
  const STAGE: BoardViewParams = { filter: {}, group: "stage" };

  const board = () => {
    const ready = Array.from({ length: 8 }, (_, index) => card(index + 1));
    const blocked = Array.from({ length: 7 }, (_, index) =>
      card(20 + index, { blockedBy: ["card-1"] as never }),
    );
    const cards = [
      ...ready,
      ...blocked,
      card(30, { priority: 5 }),
      card(40, {
        stage: "working",
        activeThreadId: "t40" as never,
        activeRole: "work",
        activePool: "p1",
      }),
      card(41, {
        stage: "working",
        stalled: { reason: "no result", at: ago(3 * HOUR), by: SYSTEM } as never,
      }),
      card(50, {
        stage: "in_review",
        activeThreadId: "t50" as never,
        activeRole: "review",
        activePool: "p1",
      }),
      card(60, {
        stage: "in_review",
        movedAt: ago(9 * DAY),
        wait: wait("push", { at: ago(9 * DAY) }),
      }),
      card(61, { stage: "in_review", movedAt: ago(2 * DAY), wait: wait("push", { at: ago(DAY) }) }),
      card(62, { stage: "in_review", movedAt: ago(2 * DAY) }),
      card(70, { stage: "needs_owner", question: "Ship it?" }),
    ];
    return stateOf(cards, {
      threads: [thread("t40"), thread("t50")],
      pools: [{ key: "p1", slots: 4, model }],
    });
  };

  it("folds what is not going anywhere and previews the rest", () => {
    const built = createBoardView().model(board(), NOW, STAGE);
    const [todo, working, reviewing, waiting] = built.active;
    expect(rowsOf(todo!)).toEqual([
      "Ready, by what they unblock 8",
      // #1 leads: it unblocks seven cards.
      "#1",
      "#2",
      "#3",
      "#4",
      "#5",
      "3 more",
      "Blocked 7 (folded)",
      "Flagged or parked 1 (folded)",
    ]);
    expect(todo!.count).toBe(16);
    expect(rowsOf(working!)).toEqual(["Running 1", "#40", "Failed after a retry 1", "#41"]);
    expect(rowsOf(reviewing!)).toEqual(["Reviewing now 1", "#50"]);
    expect(rowsOf(waiting!)).toEqual(["Waiting on the author 2", "#60", "#61", "Idle 1", "#62"]);
    const first = todo!.rows[1];
    expect(first?.kind === "card" && first.card.unblocks).toBe(7);
  });

  it("opens a folded group with its reasons, and shows a whole group on request", () => {
    const state = board();
    const engine = createBoardView();
    const opened = engine.model(state, NOW, { ...STAGE, groups: { "todo:blocked": "open" } });
    expect(rowsOf(opened.active[0]!).slice(7)).toEqual([
      "Blocked 7",
      "#20",
      "#21",
      "#22",
      "#23",
      "#24",
      "2 more",
      "Flagged or parked 1 (folded)",
    ]);
    const all = engine.model(state, NOW, {
      ...STAGE,
      groups: { "todo:ready": "all", "todo:parked": "open" },
    });
    expect(rowsOf(all.active[0]!)).toEqual([
      "Ready, by what they unblock 8",
      "#1",
      "#2",
      "#3",
      "#4",
      "#5",
      "#6",
      "#7",
      "#8",
      "Blocked 7 (folded)",
      "Flagged or parked 1",
      "#30",
    ]);
    const closed = engine.model(state, NOW, { ...STAGE, groups: { "todo:ready": "closed" } });
    expect(rowsOf(closed.active[0]!)[0]).toBe("Ready, by what they unblock 8 (folded)");
    // Untouched columns are the objects they were.
    expect(closed.active[1]).toBe(opened.active[1]);
  });

  it("keeps only what needs a look in the Stuck lens, every group open", () => {
    const built = createBoardView().model(board(), NOW, { ...STAGE, lens: "stuck" });
    const [todo, working, reviewing, waiting] = built.active;
    expect(rowsOf(todo!)).toEqual(["Nothing stuck here"]);
    expect(todo!.count).toBe(0);
    expect(rowsOf(working!)).toEqual(["Failed after a retry 1", "#41"]);
    expect(rowsOf(reviewing!)).toEqual(["Nothing stuck here"]);
    expect(rowsOf(waiting!)).toEqual(["Waiting on the author 1", "#60", "Idle 1", "#62"]);
    expect(built.stuck).toEqual({
      count: 3,
      line: "3 stuck: 1 failed after a retry, 1 idle in review, 1 waiting on an author for over 3 days. Every one says why.",
    });
    const group = working!.rows[0];
    expect(group?.kind === "group" && group.foldable).toBe(false);
  });

  it("counts the stuck cards the filter lets through", () => {
    const built = createBoardView().model(board(), NOW, {
      filter: { query: "card 6" },
      group: "stage",
    });
    expect(built.stuck.count).toBe(2);
  });

  it("sums the board up, whatever the filter", () => {
    const expected = {
      running: 2,
      slots: 4,
      ready: 8,
      blocked: 7,
      paused: false,
      authors: 2,
      needsYou: 1,
      open: 23,
      through: 23,
    };
    const engine = createBoardView();
    expect(engine.model(board(), NOW, STAGE).summary).toEqual(expected);
    expect(
      engine.model(board(), NOW, { filter: { query: "card 6" }, group: "stage" }).summary,
    ).toEqual(expected);
  });

  it("groups a paused board by what the pause lets through", () => {
    const state = board();
    const paused: KanbanBoardState = {
      ...state,
      board: {
        ...state.board,
        pause: {
          reason: "Only the migration",
          keep: ["card-1", "card-2"],
          at: ago(DAY),
          by: "owner",
        },
      } as never,
    };
    const built = createBoardView().model(paused, NOW, STAGE);
    expect(rowsOf(built.active[0]!)).toEqual([
      "Let through by the pause 2",
      "#1",
      "#2",
      "Held by the pause 14 (folded)",
    ]);
    expect(rowsOf(built.active[3]!)).toEqual(["Held by the pause 3", "#60", "#61", "#62"]);
    expect(built.summary).toMatchObject({
      ready: 2,
      // The failed card is not the pause's to hold: it shows as failed.
      blocked: 17,
      paused: true,
      open: 23,
      through: 2,
    });
    // Nothing the pause holds is stuck; the failure still is.
    expect(built.stuck.count).toBe(1);
    expect(built.stuck.line).toBe("1 stuck: 1 failed after a retry. Every one says why.");
  });
});

describe("a folded group's reasons", () => {
  it("lists them, most cards first, only when there is more than one", () => {
    const cards = [
      card(1, { priority: 5 }),
      card(2, { priority: 5 }),
      card(3, { stalled: { reason: "Scope is unclear", at: ago(HOUR), by: OWNER } as never }),
      card(4),
    ];
    const built = createBoardView().model(stateOf(cards), NOW, {
      filter: {},
      group: "stage",
      groups: { "todo:parked": "open" },
    });
    const reasons = built.active[0]!.rows.find((row) => row.kind === "reasons");
    expect(reasons?.kind === "reasons" && reasons.items).toEqual([
      { label: "In the backlog", count: 2 },
      { label: "Flagged, needs a look", count: 1 },
    ]);
  });
});
