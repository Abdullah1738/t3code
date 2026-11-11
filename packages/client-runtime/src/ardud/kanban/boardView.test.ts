import type { KanbanBoardSnapshot, KanbanCard, KanbanThreadState } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { applyKanbanChange, boardStateFromSnapshot, type KanbanBoardState } from "./boardState.ts";
import {
  boardSteps,
  createBoardView,
  nextCardThresholdMs,
  type BoardLane,
  type BoardModel,
  type BoardViewParams,
} from "./boardView.ts";
import { TILE_GROUP_ORDER } from "./tilePlace.ts";
import { cardSteps, cardView, groupCards, stageBoard, type BoardFilter } from "./viewModel.ts";

const NOW = Date.parse("2026-10-25T12:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const model = { instanceId: "opencode", model: "opus/claude-opus-5-5" } as never;
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

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
    createdBy: { _tag: "owner" },
    createdAt: "2026-10-25T10:00:00.000Z",
    updatedAt: "2026-10-25T10:00:00.000Z",
    movedAt: "2026-10-25T10:00:00.000Z",
    ...patch,
  } as KanbanCard;
}

const ask = (id: string, patch: Record<string, unknown> = {}) =>
  ({
    id,
    text: `Question ${id}`,
    blocking: false,
    by: { _tag: "owner" },
    at: "2026-10-25T09:00:00.000Z",
    closedAt: null,
    ...patch,
  }) as never;

function stateOf(cards: KanbanCard[], threads: KanbanThreadState[] = []): KanbanBoardState {
  return boardStateFromSnapshot({
    board: { id: "board-toy", name: "Toy", pause: null },
    cards,
    goals: [
      {
        id: "goal-a",
        boardId: "board-toy",
        name: "PBV2",
        status: "active",
        now: null,
        story: [],
        createdAt: "2026-10-20T00:00:00.000Z",
      },
      {
        id: "goal-b",
        boardId: "board-toy",
        name: "Ledger",
        status: "active",
        now: null,
        story: [],
        createdAt: "2026-10-21T00:00:00.000Z",
      },
    ],
    pools: [],
    groups: [
      {
        id: "g1",
        name: "Auth",
        summary: "Login work",
        cardIds: ["card-2", "card-5"],
        updatedAt: "",
      },
    ],
    threads,
    unread: [],
  } as unknown as KanbanBoardSnapshot);
}

const withCard = (state: KanbanBoardState, next: KanbanCard) =>
  applyKanbanChange(state, { _tag: "card", card: next } as never);

/** Every state group shown in full, so a lane's rows hold all of its cards. */
const ALL_OPEN = Object.fromEntries(
  ["todo", "working", "needs_review", "in_review"].flatMap((column) =>
    TILE_GROUP_ORDER.map((group) => [`${column}:${group}`, "all" as const]),
  ),
);
const STAGE: BoardViewParams = { filter: {}, group: "stage", groups: ALL_OPEN };
const idsOf = (lane: BoardLane) =>
  lane.rows.flatMap((row) => (row.kind === "card" ? [row.card.id] : []));

/** A small deterministic generator (mulberry32). */
function random(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (max: number) => Math.floor(next() * max),
    pick: <T>(items: ReadonlyArray<T>) => items[Math.floor(next() * items.length)]!,
    chance: (share: number) => next() < share,
  };
}

const STAGES = [
  "todo",
  "todo",
  "todo",
  "working",
  "needs_review",
  "in_review",
  "completed",
  "deployed",
  "verified",
  "needs_owner",
] as const;

/** One random card, with the mix a real board has: blockers, flags, asks, waits, threads. */
function randomCard(rng: ReturnType<typeof random>, number: number, count: number): KanbanCard {
  const stage = rng.pick(STAGES);
  const movedAt = iso(NOW - rng.int(9 * 24) * HOUR - rng.int(60) * MINUTE);
  const running = stage === "working" || (stage === "in_review" && rng.chance(0.4));
  const threadId = running ? (`thread-${number}` as never) : null;
  const blockedBy = rng.chance(0.4)
    ? Array.from({ length: 1 + rng.int(2) }, () => `card-${1 + rng.int(count)}`).filter(
        (id) => id !== `card-${number}`,
      )
    : [];
  return card(number, {
    stage,
    priority: 1 + rng.int(5),
    movedAt,
    updatedAt: movedAt,
    goalId: rng.chance(0.5) ? (rng.pick(["goal-a", "goal-b"]) as never) : null,
    projects: rng.chance(0.3) ? [rng.pick(["api", "web", "infra"])] : [],
    blockedBy: blockedBy as never,
    workThreadId: rng.chance(0.3) ? (`work-${rng.int(6)}` as never) : null,
    activeThreadId: threadId,
    activeRole: running ? (stage === "working" ? "work" : "review") : null,
    stalled:
      !running && rng.chance(0.08)
        ? ({
            reason: "Run failed twice",
            at: movedAt,
            by: { _tag: "system", component: "x" },
          } as never)
        : null,
    asks: rng.chance(0.12)
      ? [
          ask(`ask-${number}`, {
            blocking: stage === "needs_owner",
            at: iso(NOW - rng.int(48) * HOUR),
            ...(rng.chance(0.4) ? { snoozedUntil: iso(NOW + (rng.int(6) - 2) * HOUR) } : {}),
            ...(rng.chance(0.3) ? { expiresAt: iso(NOW + (rng.int(6) - 2) * HOUR) } : {}),
          }),
        ]
      : [],
    settledAt: stage === "verified" && rng.chance(0.6) ? movedAt : null,
    links: rng.chance(0.3)
      ? ([
          {
            kind: "pr",
            url: `https://github.com/example-org/repo/pull/${number}`,
            label: null,
            state: "open",
          },
        ] as never)
      : [],
  });
}

function randomBoard(seed: number, count: number) {
  const rng = random(seed);
  const cards = Array.from({ length: count }, (_, index) => randomCard(rng, index + 1, count));
  // The newest stamp is the old view model's clock; pin it to the test's.
  cards[0] = { ...cards[0]!, updatedAt: iso(NOW) };
  const threads = cards.flatMap((entry) =>
    entry.activeThreadId === null
      ? []
      : [
          {
            threadId: entry.activeThreadId,
            title: `Thread for ${entry.number}`,
            running: rng.chance(0.7),
            needsInput: false,
            lastActivityAt: iso(NOW - rng.int(90) * MINUTE),
          } as KanbanThreadState,
        ],
  );
  return { rng, state: stateOf(cards, threads) };
}

describe("createBoardView", () => {
  it("holds the cards the old view model listed, To-Do's startable ones in the same order", () => {
    const { state } = randomBoard(11, 240);
    const filters: BoardFilter[] = [
      {},
      { settled: "include" },
      { settled: "only" },
      { priorities: [1, 2] },
      { goalIds: ["goal-a", ""] },
      { projects: ["api"] },
      { query: "card 1" },
      { query: "#12" },
    ];
    for (const filter of filters) {
      const built = createBoardView().model(state, NOW, {
        filter,
        group: "stage",
        groups: ALL_OPEN,
      });
      // A search looks through settled cards too; the old view model needs to be told.
      const old = stageBoard(
        state,
        NOW,
        filter.query && filter.settled === undefined ? { ...filter, settled: "include" } : filter,
      );
      expect(built.total).toBe(old.total);
      const oldIds = (stage: string) =>
        old.active.find((column) => column.stage === stage)!.cards.map((view) => view.id);
      const [todo, working, reviewing, waiting] = built.active;
      expect(built.active.map((lane) => lane.label)).toEqual([
        "To-Do",
        "Working",
        "Reviewing",
        "In review, waiting",
      ]);
      expect(idsOf(todo!).toSorted()).toEqual(oldIds("todo").toSorted());
      expect(idsOf(working!).toSorted()).toEqual(oldIds("working").toSorted());
      // The two review stages are split by what the card is doing, not by stage.
      expect([...idsOf(reviewing!), ...idsOf(waiting!)].toSorted()).toEqual(
        [...oldIds("needs_review"), ...oldIds("in_review")].toSorted(),
      );
      expect(todo!.count).toBe(oldIds("todo").length);
      // Ready cards lead To-Do in the dispatcher's pick order, as before.
      const ready = todo!.rows.findIndex((row) => row.kind === "group" && row.id === "todo:ready");
      if (ready >= 0) {
        const group = todo!.rows[ready]!;
        const count = group.kind === "group" ? group.count : 0;
        const ids = todo!.rows
          .slice(ready + 1, ready + 1 + count)
          .map((row) => (row.kind === "card" ? row.card.id : ""));
        expect(ids).toEqual(oldIds("todo").filter((id) => ids.includes(id)));
      }
      expect(built.shipped.map((lane) => [lane.key, idsOf(lane)])).toEqual(
        old.shipped.map((column) => [column.stage, column.cards.map((view) => view.id)]),
      );
      expect(idsOf(built.owner)).toEqual(old.owner.cards.map((view) => view.id));
      expect(built.owner.count).toBe(old.owner.count);
    }
  });

  it("shows on a tile what the old card view showed, with ages left to the tile", () => {
    const { state } = randomBoard(5, 160);
    const built = createBoardView().model(state, NOW, {
      filter: { settled: "include" },
      group: "stage",
      groups: ALL_OPEN,
    });
    const rows = [...built.active, ...built.shipped].flatMap((lane) => lane.rows);
    expect(rows.length).toBeGreaterThan(100);
    for (const row of rows) {
      if (row.kind !== "card") continue;
      const source = state.cards.get(row.card.id)!;
      const old = cardView(source, state, NOW);
      expect({
        number: row.card.number,
        title: row.card.title,
        stage: row.card.stage,
        priority: row.card.priority,
        goal: row.card.goal,
        pr: row.card.pr,
        model: row.card.model,
        running: row.card.running,
        needsInput: row.card.needsInput,
        unread: row.card.unread,
        subtasks: row.card.subtasks,
        settled: row.card.settled,
        flagKind: row.card.flag?.kind ?? null,
      }).toEqual({
        number: old.number,
        title: old.title,
        stage: old.stage,
        priority: old.priority,
        goal: old.goal,
        pr: old.pr,
        model: old.model,
        running: old.running,
        needsInput: old.needsInput,
        unread: old.unread,
        subtasks: old.subtasks,
        settled: source.settledAt !== null,
        flagKind: old.flag?.kind ?? null,
      });
      if (old.flag?.kind === "stalled") {
        expect(row.card.flag?.label).toBe("Stalled");
        expect(row.card.flagSince).toBe(source.stalled?.at);
      } else {
        expect(row.card.flag).toEqual(old.flag);
      }
    }
  });

  it("groups by goal, project, model and similarity like the old view model", () => {
    const { state } = randomBoard(23, 200);
    for (const group of ["goal", "project", "model", "similar"] as const) {
      const built = createBoardView().model(state, NOW, { filter: {}, group });
      const old = groupCards(state, group, NOW, {});
      expect(built.groups.map((lane) => [lane.key, lane.label, lane.summary, idsOf(lane)])).toEqual(
        old.map((entry) => [
          entry.key,
          entry.label,
          entry.summary,
          entry.cards.map((view) => view.id),
        ]),
      );
      expect(built.active).toEqual([]);
    }
  });

  it("counts goals the way activeGoals does", () => {
    const { state } = randomBoard(31, 200);
    const built = createBoardView().model(state, NOW, STAGE);
    expect(built.goals.map((entry) => [entry.goal.id, entry.progress])).toEqual([
      ["goal-a", expect.objectContaining({ total: expect.any(Number) })],
      ["goal-b", expect.objectContaining({ total: expect.any(Number) })],
    ]);
    for (const entry of built.goals) {
      const members = [...state.cards.values()].filter((item) => item.goalId === entry.goal.id);
      expect(entry.progress.total).toBe(members.length);
      expect(entry.progress.todo).toBe(members.filter((item) => item.stage === "todo").length);
    }
  });

  it("returns the same model while nothing changed", () => {
    const { state } = randomBoard(3, 120);
    const engine = createBoardView();
    const first = engine.model(state, NOW, STAGE);
    const built = engine.computed();
    expect(engine.model(state, NOW, STAGE)).toBe(first);
    // A new filter object with the same content, and a clock that crossed nothing.
    expect(
      engine.model(state, NOW + 1000, {
        filter: { settled: "hide" },
        group: "stage",
        groups: { ...ALL_OPEN },
      }),
    ).toBe(first);
    expect(engine.computed()).toBe(built);
  });

  it("rebuilds one view when one card changes, and keeps every other row and lane", () => {
    const cards = Array.from({ length: 60 }, (_, index) =>
      card(index + 1, { stage: index % 3 === 0 ? "working" : "todo" }),
    );
    const state = stateOf(cards);
    const engine = createBoardView();
    const first = engine.model(state, NOW, STAGE);
    const built = engine.computed();
    expect(built).toBe(60);

    const next = withCard(state, { ...cards[1]!, title: "Renamed", updatedAt: iso(NOW) });
    const second = engine.model(next, NOW, STAGE);
    expect(engine.computed()).toBe(built + 1);
    expect(second).not.toBe(first);
    const [todo, working] = second.active;
    expect(working).toBe(first.active[1]);
    expect(todo).not.toBe(first.active[0]);
    const before = new Map(first.active[0]!.rows.map((row) => [row.key, row]));
    const changed = todo!.rows.filter((row) => before.get(row.key) !== row);
    expect(changed.map((row) => row.key)).toEqual(["card-2"]);
    expect(second.owner).toBe(first.owner);
    expect(second.shipped).toBe(first.shipped);
    expect(second.goals).toBe(first.goals);
  });

  it("keeps a tile's view when the server sends the card again unchanged", () => {
    const cards = [card(1), card(2)];
    const state = stateOf(cards);
    const engine = createBoardView();
    const first = engine.model(state, NOW, STAGE);
    // Same content, new object: what a reconnect's snapshot gives.
    const next = withCard(state, { ...cards[0]! });
    expect(engine.model(next, NOW, STAGE)).toBe(first);
    // A field no tile shows.
    const edited = withCard(next, { ...cards[0]!, prompt: "Do it carefully" });
    expect(engine.model(edited, NOW, STAGE)).toBe(first);
  });

  it("rebuilds the cards a changed blocker holds up", () => {
    const cards = [
      card(1),
      card(2, { blockedBy: ["card-1"] as never }),
      card(3, { blockedBy: ["card-2"] as never }),
      card(4),
    ];
    const state = stateOf(cards);
    const engine = createBoardView();
    const first = engine.model(state, NOW, STAGE);
    const flagOf = (built: BoardModel, id: string) =>
      built.active[0]!.rows.flatMap((row) =>
        row.kind === "card" && row.card.id === id ? [row.card.flag?.label ?? null] : [],
      )[0];
    expect(flagOf(first, "card-2")).toBe("After #1");
    expect(idsOf(first.active[0]!)).toEqual(["card-1", "card-4", "card-2", "card-3"]);

    const built = engine.computed();
    const next = withCard(state, { ...cards[0]!, stage: "verified", updatedAt: iso(NOW) });
    const second = engine.model(next, NOW, STAGE);
    // The blocker itself and the card waiting on it; #3 and #4 read neither.
    expect(engine.computed()).toBe(built + 2);
    expect(flagOf(second, "card-2")).toBeNull();
    expect(flagOf(second, "card-3")).toBe("After #2");
    expect(idsOf(second.active[0]!)).toEqual(["card-2", "card-4", "card-3"]);
  });

  it("follows a blocker on the same work thread into its own blockers", () => {
    const thread = "work-1" as never;
    const cards = [
      card(1),
      card(2, { blockedBy: ["card-1"] as never, workThreadId: thread }),
      card(3, { blockedBy: ["card-2"] as never, workThreadId: thread }),
    ];
    const state = stateOf(cards);
    const engine = createBoardView();
    const flagOf = (built: BoardModel, id: string) =>
      built.active[0]!.rows.flatMap((row) =>
        row.kind === "card" && row.card.id === id ? [row.card.flag?.label ?? null] : [],
      )[0];
    // #3's blocker #2 shares its thread and is itself held by #1.
    expect(flagOf(engine.model(state, NOW, STAGE), "card-3")).toBe("After #2");
    const next = withCard(state, { ...cards[0]!, stage: "verified", updatedAt: iso(NOW) });
    expect(flagOf(engine.model(next, NOW, STAGE), "card-3")).toBeNull();
  });

  it("rebuilds a card's view when its thread, goal or unread count changes", () => {
    const threadId = "thread-1" as never;
    const cards = [
      card(1, { stage: "working", activeThreadId: threadId, activeRole: "work" }),
      card(2, { goalId: "goal-a" as never }),
      card(3),
    ];
    const state = stateOf(cards, [
      { threadId, title: "Work", running: true, needsInput: false, lastActivityAt: iso(NOW) },
    ]);
    const engine = createBoardView();
    const first = engine.model(state, NOW, STAGE);
    const built = engine.computed();

    const quiet = applyKanbanChange(state, {
      _tag: "thread",
      thread: {
        threadId,
        title: "Work",
        running: false,
        needsInput: true,
        lastActivityAt: iso(NOW),
      },
    } as never);
    const second = engine.model(quiet, NOW, STAGE);
    expect(engine.computed()).toBe(built + 1);
    const working = second.active[1]!.rows.find((row) => row.kind === "card");
    expect(working?.kind === "card" && working.card.needsInput).toBe(true);
    expect(second.active[0]).toBe(first.active[0]);

    const renamed = applyKanbanChange(quiet, {
      _tag: "goal",
      goal: { ...state.goals.get("goal-a")!, name: "PBV3" },
    } as never);
    const third = engine.model(renamed, NOW, STAGE);
    expect(engine.computed()).toBe(built + 2);
    const todo = third.active[0]!.rows.find((row) => row.key === "card-2");
    expect(todo?.kind === "card" && todo.card.goal?.name).toBe("PBV3");
    expect(third.active[1]).toBe(second.active[1]);
  });

  it("rebuilds when the clock crosses a card's next threshold, not before", () => {
    const wake = NOW + 2 * HOUR;
    const cards = [card(1, { asks: [ask("a1", { snoozedUntil: iso(wake) })] }), card(2)];
    const state = stateOf(cards);
    const engine = createBoardView();
    const first = engine.model(state, NOW, STAGE);
    expect(idsOf(first.owner)).toEqual([]);
    expect(engine.model(state, wake - 1, STAGE)).toBe(first);
    const woken = engine.model(state, wake, STAGE);
    expect(idsOf(woken.owner)).toEqual(["card-1"]);
    expect(woken.owner.count).toBe(1);
    // The other card's row is the object it was.
    expect(woken.active[0]!.rows[1]).toBe(first.active[0]!.rows[1]);
  });

  it("names the next threshold of a card", () => {
    const moved = NOW - 10 * MINUTE;
    const plain = card(1, { movedAt: iso(moved) });
    // 30 minutes after it moved: the first offset still ahead.
    expect(nextCardThresholdMs(plain, undefined, NOW)).toBe(moved + 30 * MINUTE);
    const retried = card(2, {
      movedAt: iso(moved),
      retries: [
        {
          kind: "run_failed",
          role: "work",
          runId: null,
          reason: "x",
          at: iso(NOW - 20_000),
          state: "waiting",
        },
      ] as never,
    });
    expect(nextCardThresholdMs(retried, undefined, NOW)).toBe(NOW - 20_000 + 60_000);
    const old = card(3, { movedAt: iso(NOW - 30 * 24 * HOUR) });
    expect(nextCardThresholdMs(old, undefined, NOW)).toBe(Number.POSITIVE_INFINITY);
  });

  it("gives the same board as a fresh engine after any run of changes and clock steps", () => {
    for (const seed of [1, 2, 3]) {
      const { rng, state: initial } = randomBoard(seed, 120);
      const engine = createBoardView();
      let state = initial;
      let now = NOW;
      const params: BoardViewParams[] = [
        STAGE,
        { filter: { settled: "include" }, group: "stage" },
        { filter: {}, group: "goal" },
        { filter: { query: "card 1" }, group: "stage" },
      ];
      for (let step = 0; step < 60; step += 1) {
        const move = rng.int(5);
        if (move === 0) {
          now += rng.pick([20_000, 5 * MINUTE, 45 * MINUTE, 7 * HOUR, 30 * HOUR]);
        } else if (move === 1) {
          const number = 1 + rng.int(120);
          state = withCard(state, { ...randomCard(rng, number, 120), updatedAt: iso(now) });
        } else if (move === 2) {
          const target = rng.pick([...state.cards.values()]);
          state = withCard(state, {
            ...target,
            stage: rng.pick(STAGES),
            movedAt: iso(now),
            updatedAt: iso(now),
          });
        } else if (move === 3) {
          const threads = [...state.threads.values()];
          if (threads.length > 0) {
            const thread = rng.pick(threads);
            state = applyKanbanChange(state, {
              _tag: "thread",
              thread: { ...thread, running: !thread.running, lastActivityAt: iso(now) },
            } as never);
          }
        } else {
          state = applyKanbanChange(state, {
            _tag: "board",
            board: {
              ...state.board,
              setup: rng.chance(0.5) ? { status: "running", discussionId: "d" } : undefined,
            },
          } as never);
        }
        const picked = rng.pick(params);
        expect(engine.model(state, now, picked)).toEqual(
          createBoardView().model(state, now, picked),
        );
      }
    }
  });

  it("drops the views of removed cards", () => {
    const cards = [card(1), card(2), card(3)];
    const state = stateOf(cards);
    const engine = createBoardView();
    engine.model(state, NOW, STAGE);
    const removed = applyKanbanChange(state, { _tag: "cardRemoved", cardId: "card-2" } as never);
    expect(idsOf(engine.model(removed, NOW, STAGE).active[0]!)).toEqual(["card-1", "card-3"]);
  });

  it("places one card for a drawer the way its tile is placed, with or without a model", () => {
    const cards = [
      card(1),
      card(2, { blockedBy: ["card-1"] as never }),
      card(3, { blockedBy: ["card-1"] as never }),
    ];
    const state = stateOf(cards);
    // No model built yet: a drawer over another view still gets the card's place.
    const cold = createBoardView().place(state, NOW, "card-2");
    expect(cold?.place.column).toBe("todo");
    expect(cold?.place.group).toBe("blocked");
    expect(cold?.place.line?.lead).toBe("Blocked by #1");

    const engine = createBoardView();
    const built = engine.model(state, NOW, STAGE);
    const tile = built.active[0]!.rows.flatMap((row) =>
      row.kind === "card" && row.card.id === "card-1" ? [row.card] : [],
    )[0]!;
    const computed = engine.computed();
    const warm = engine.place(state, NOW, "card-1");
    expect(warm?.unblocks).toBe(tile.unblocks);
    expect(warm?.unblocks).toBe(2);
    expect(warm?.place.line).toBe(tile.line);
    // Read from the board's own cache: nothing was derived again.
    expect(engine.computed()).toBe(computed);
    expect(engine.place(state, NOW, "card-9")).toBeNull();
  });
});

describe("boardSteps", () => {
  it("steps through a lane like cardSteps", () => {
    const { state } = randomBoard(41, 150);
    for (const group of ["goal", "model"] as const) {
      const built = createBoardView().model(state, NOW, { filter: {}, group });
      for (const entry of [...state.cards.values()].slice(0, 60)) {
        expect(boardSteps(built, group, entry.id)).toEqual(
          cardSteps(state, NOW, {}, group, entry.id),
        );
      }
    }
  });
});

describe("stepping on the stage board", () => {
  it("steps through the cards a column shows, across its groups", () => {
    const cards = [
      card(1),
      card(2, { blockedBy: ["card-1"] as never }),
      card(3),
      card(4, { stage: "working" }),
    ];
    const state = stateOf(cards);
    const open = createBoardView().model(state, NOW, STAGE);
    expect(boardSteps(open, "stage", "card-3")).toEqual({
      previous: "card-1",
      next: "card-2",
      afterSettle: null,
    });
    // Blocked is folded by default: its cards are not steps until it is opened.
    const folded = createBoardView().model(state, NOW, { filter: {}, group: "stage" });
    expect(boardSteps(folded, "stage", "card-3")).toEqual({
      previous: "card-1",
      next: null,
      afterSettle: null,
    });
  });
});

describe("board search", () => {
  const threadId = "thread-9" as never;
  const cards = [
    card(1, { title: "Rotate the signing key" }),
    card(2, {
      title: "Ledger drift",
      links: [
        {
          kind: "pr",
          url: "https://github.com/example-org/ledger/pull/512",
          label: "ledger#512",
          state: "open",
        },
      ] as never,
    }),
    card(3, {
      title: "Working card",
      stage: "working",
      activeThreadId: threadId,
      workThreadId: threadId,
      activeRole: "work",
    }),
    card(4, { title: "Has a goal", goalId: "goal-b" as never }),
    card(5, { title: "Asks", asks: [ask("a5", { text: "Which tamarind queue?" })] }),
    card(6, {
      title: "Planned",
      subtasks: [
        { id: "s1", text: "Backfill the zeppelin table", step: 1, state: "open" },
      ] as never,
    }),
    card(7, { title: "Parked", projects: ["wallet"] }),
    card(8, {
      title: "Shipped long ago",
      stage: "verified",
      settledAt: "2026-10-20T00:00:00.000Z",
    }),
    card(120, { title: "Another" }),
  ];
  const state = stateOf(cards, [
    {
      threadId,
      title: "Marzipan migration worker",
      running: true,
      needsInput: false,
      lastActivityAt: null,
    },
  ]);
  const found = (query: string, engine = createBoardView()) => {
    const built = engine.model(state, NOW, { filter: { query }, group: "stage", groups: ALL_OPEN });
    return [...built.active, ...built.shipped].flatMap(idsOf).sort();
  };

  it("finds a card by its number, with or without the hash", () => {
    expect(found("#2")).toEqual(["card-2"]);
    expect(found("#12")).toEqual(["card-120"]);
    // A bare number is also a word: it finds the pull request numbered 512.
    expect(found("12")).toEqual(["card-120", "card-2"]);
    expect(found("#1")).toEqual(["card-1", "card-120"]);
  });

  it("finds a card by its title, every word in any order", () => {
    expect(found("key rotate")).toEqual(["card-1"]);
    expect(found("key ledger")).toEqual([]);
  });

  it("finds a card by its pull request, label or URL", () => {
    expect(found("ledger#512")).toEqual(["card-2"]);
    expect(found("pull/512")).toEqual(["card-2"]);
    expect(found("example-org")).toEqual(["card-2"]);
  });

  it("finds a card by the title of a thread on it", () => {
    expect(found("marzipan")).toEqual(["card-3"]);
    expect(found("working marzipan")).toEqual(["card-3"]);
  });

  it("finds a card by its goal, project, open ask and plan", () => {
    expect(found("ledger")).toEqual(["card-2", "card-4"]);
    expect(found("wallet")).toEqual(["card-7"]);
    expect(found("tamarind")).toEqual(["card-5"]);
    expect(found("zeppelin")).toEqual(["card-6"]);
  });

  it("looks through settled cards while searching, and hides them again after", () => {
    const engine = createBoardView();
    expect(found("shipped long", engine)).toEqual(["card-8"]);
    expect(found("#8", engine)).toEqual(["card-8"]);
    const cleared = engine.model(state, NOW, STAGE);
    expect(cleared.shipped.flatMap(idsOf)).toEqual([]);
    // Only settled cards when that is what the filter asks for.
    const only = engine.model(state, NOW, {
      filter: { query: "card", settled: "only" },
      group: "stage",
    });
    expect(only.total).toBe(0);
  });

  it("reads a description only for cards the client has loaded in full", () => {
    const engine = createBoardView();
    // The feed sends descriptions empty: nothing to find yet.
    expect(found("obsidian", engine)).toEqual([]);
    engine.learn({ ...cards[0]!, description: "Replace the obsidian HSM key", prompt: "Halcyon" });
    expect(found("obsidian", engine)).toEqual(["card-1"]);
    expect(found("rotate halcyon", engine)).toEqual(["card-1"]);
    // Learning the same text again changes nothing.
    const before = engine.model(state, NOW, { filter: { query: "obsidian" }, group: "stage" });
    engine.learn({ ...cards[0]!, description: "Replace the obsidian HSM key", prompt: "Halcyon" });
    expect(engine.model(state, NOW, { filter: { query: "obsidian" }, group: "stage" })).toBe(
      before,
    );
    // Learning a card's text keeps every lane that did not change: opening a drawer
    // must not re-render the board.
    const lanes = engine.model(state, NOW, STAGE);
    engine.learn({ ...cards[1]!, description: "Text seen for the first time", prompt: "" });
    const after = engine.model(state, NOW, STAGE);
    expect(after.active).toBe(lanes.active);
    expect(after.owner).toBe(lanes.owner);
    expect(after.shippedRows).toBe(lanes.shippedRows);
  });
});
