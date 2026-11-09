import {
  KANBAN_BACKLOG,
  KanbanBoardId,
  KanbanCardId,
  KanbanDiscussionId,
  ThreadId,
  type KanbanBoard,
  type KanbanCard,
  type KanbanDiscussion,
  type KanbanPool,
  type ModelSelection,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  applyReviewResult,
  checkClaim,
  checkMove,
  confirmDispatch,
  discussionSettleDue,
  isBlocked,
  isContextFull,
  isHandoffBudget,
  isOutage,
  MAX_BATCH,
  maskDownPools,
  modelKey,
  modelLevel,
  modelOnPool,
  nextProbeDelay,
  planDispatch,
  aliasPool,
  poolFor,
  poolKey,
  prsLanded,
  relatedCandidates,
  reviewGate,
  workerQuietDue,
  reviewerQuietDue,
  waitingOnBackground,
  BACKGROUND_GRACE_MS,
} from "./rules.ts";

const model = (name: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make("opencode"),
  model: name,
});
const haiku = model("opus/cc/claude-haiku-5-5");
const opus = model("opus/claude-opus-5-5");
const sol = model("opus/cx/gpt-6.1-sol");
const astra = model("opus/gpt-6-astra");

const board: KanbanBoard = {
  id: KanbanBoardId.make("b1"),
  slug: "robob",
  name: "Robob",
  icon: null,
  iconImage: null,
  defaultProjectId: null,
  managerModel: haiku,
  evaluatorModel: opus,
  defaultCardModel: opus,
  reviewChains: [
    { name: "Critical", steps: [sol, astra] },
    { name: "Default", steps: [opus] },
  ],
  defaultReviewChain: "Default",
  instructions: { modelRouting: "", reviewerRouting: "", escalation: "" },
  setup: null,
  pause: null,
  createdAt: "2026-10-25T00:00:00Z",
  archivedAt: null,
};

let n = 0;
const card = (patch: Partial<KanbanCard> = {}): KanbanCard => {
  n += 1;
  return {
    id: KanbanCardId.make(`c${n}`),
    boardId: board.id,
    number: n,
    title: `card ${n}`,
    description: "",
    prompt: "do it",
    stage: "todo",
    priority: 2,
    goalId: null,
    projects: [],
    model: opus,
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
    createdAt: "2026-10-25T00:00:00Z",
    updatedAt: "2026-10-25T00:00:00Z",
    movedAt: `2026-10-25T00:00:${String(n).padStart(2, "0")}Z`,
    ...patch,
  };
};

const pools = (entries: ReadonlyArray<[ModelSelection, number]>): ReadonlyArray<KanbanPool> =>
  entries.map(([m, slots]) => ({ key: poolKey(m), model: m, slots }));

describe("checkMove", () => {
  it("keeps thread stages for the dispatcher", () => {
    expect(checkMove("owner", card(), "working").ok).toBe(false);
    expect(checkMove("evaluator", card({ stage: "needs_review" }), "in_review").ok).toBe(false);
    expect(checkMove("dispatcher", card(), "working").ok).toBe(true);
    expect(checkMove("dispatcher", card({ stage: "needs_review" }), "in_review").ok).toBe(true);
    expect(checkMove("dispatcher", card({ stage: "completed" }), "working").ok).toBe(false);
  });

  it("lets a card thread hand off only from working", () => {
    expect(checkMove("cardThread", card({ stage: "working" }), "needs_review").ok).toBe(true);
    expect(checkMove("cardThread", card({ stage: "working" }), "needs_owner").ok).toBe(true);
    expect(checkMove("cardThread", card({ stage: "working" }), "completed").ok).toBe(false);
    expect(checkMove("cardThread", card({ stage: "in_review" }), "todo").ok).toBe(false);
  });

  it("lets evaluators and the owner move freely outside thread stages, not settled cards", () => {
    expect(checkMove("evaluator", card({ stage: "completed" }), "deployed").ok).toBe(true);
    expect(checkMove("owner", card({ stage: "working" }), "todo").ok).toBe(true);
    expect(
      checkMove("owner", card({ stage: "verified", settledAt: "2026-10-25T01:00:00Z" }), "todo").ok,
    ).toBe(false);
  });

  it("lets a script move a card only to completed, deployed or verified, off a quiet stage", () => {
    expect(checkMove("script", card({ stage: "todo" }), "deployed").ok).toBe(true);
    expect(checkMove("script", card({ stage: "completed" }), "verified").ok).toBe(true);
    expect(checkMove("script", card({ stage: "todo" }), "todo").ok).toBe(false);
    expect(checkMove("script", card({ stage: "needs_review" }), "needs_review").ok).toBe(false);
    expect(checkMove("script", card({ stage: "completed" }), "needs_review").ok).toBe(false);
    expect(checkMove("script", card({ stage: "completed" }), "needs_owner").ok).toBe(false);
    expect(checkMove("script", card({ stage: "working" }), "completed").ok).toBe(false);
    expect(
      checkMove(
        "script",
        card({ stage: "completed", settledAt: "2026-10-25T01:00:00Z" }),
        "verified",
      ).ok,
    ).toBe(false);
  });
});

describe("reviewGate", () => {
  const reviewSub = {
    id: "s2",
    step: 2,
    text: "r",
    owner: "review",
    state: "open",
    note: null,
    doneBy: null,
    doneAt: null,
  } as unknown as KanbanCard["subtasks"][number];

  it("names an open review subtask", () => {
    const result = reviewGate(card({ subtasks: [reviewSub] }), 1);
    expect(result).not.toBeNull();
    expect(result).toContain("s2");
  });

  it("waits for the whole chain", () => {
    expect(reviewGate(card({ reviewStep: 0 }), 1)).not.toBeNull();
    expect(reviewGate(card({ reviewStep: 1 }), 1)).toBeNull();
    expect(reviewGate(card({ reviewStep: 1 }), 2)).not.toBeNull();
  });
});

describe("applyReviewResult", () => {
  it("findings send the card back and restart the chain", () => {
    const c = card({ stage: "in_review", reviewStep: 1, reviewRound: 2 });
    expect(applyReviewResult(c, 2, "findings")).toEqual({
      stage: "todo",
      reviewStep: 0,
      reviewRound: 3,
      continueReview: false,
    });
  });

  it("clear moves to the next chain step on the same thread", () => {
    const c = card({ stage: "in_review", reviewStep: 0 });
    expect(applyReviewResult(c, 2, "clear")).toMatchObject({
      stage: "in_review",
      reviewStep: 1,
      continueReview: true,
    });
  });

  it("after the last step waits for open PRs, completes when they landed", () => {
    const open = card({
      stage: "in_review",
      reviewStep: 1,
      links: [{ kind: "pr", url: "u", label: null, state: "open", checkedAt: null }],
    });
    expect(applyReviewResult(open, 2, "clear")).toMatchObject({
      stage: "in_review",
      continueReview: false,
    });
    const merged = card({
      stage: "in_review",
      reviewStep: 1,
      links: [{ kind: "pr", url: "u", label: null, state: "merged", checkedAt: null }],
    });
    expect(applyReviewResult(merged, 2, "clear").stage).toBe("completed");
    expect(prsLanded(card())).toBe(true);
  });

  it("a PR link the work thread never linked is context and holds nothing", () => {
    const context = (url: string, state: "open" | "merged" | null) => ({
      kind: "pr" as const,
      url,
      label: null,
      state,
      checkedAt: null,
    });
    expect(prsLanded(card({ links: [context("u", null)] }))).toBe(true);
    expect(prsLanded(card({ links: [context("u", null), context("v", "open")] }))).toBe(false);
    expect(prsLanded(card({ links: [context("u", null), context("v", "merged")] }))).toBe(true);
    const nullStatePr = card({
      stage: "in_review",
      reviewStep: 1,
      links: [context("u", null)],
    });
    expect(applyReviewResult(nullStatePr, 2, "clear").stage).toBe("completed");
  });
});

describe("planDispatch", () => {
  it("skips attempted candidates without losing their blockers or occupied slots", () => {
    const failed = card({ priority: 1 });
    const blocked = card({ blockedBy: [failed.id] });
    const next = card({ priority: 3 });
    const attempted = new Set<string>([failed.id]);
    expect(
      planDispatch(
        board,
        [failed, blocked, next],
        pools([[opus, 1]]),
        new Map(),
        () => 0,
        attempted,
      ),
    ).toMatchObject([{ cardId: next.id }]);
    const running = card({
      stage: "working",
      activeRole: "work",
      activeThreadId: ThreadId.make("busy"),
      activePool: poolKey(opus),
    });
    attempted.add(running.id);
    expect(
      planDispatch(
        board,
        [failed, running, next],
        pools([[opus, 1]]),
        new Map(),
        () => 0,
        attempted,
      ),
    ).toEqual([]);
  });

  it("starts no card work or review while the board's setup runs", () => {
    const setupRunning: KanbanBoard = {
      ...board,
      setup: {
        status: "running",
        discussionId: KanbanDiscussionId.make("disc-setup"),
        threadId: ThreadId.make("t-setup"),
        startedAt: "2026-10-28T00:00:00Z",
        finishedAt: null,
      },
    };
    const review = card({ stage: "needs_review" });
    const todo = card();
    expect(planDispatch(setupRunning, [review, todo], pools([[opus, 2]]))).toEqual([]);
    const setupDone: KanbanBoard = {
      ...setupRunning,
      setup: { ...setupRunning.setup!, status: "done", finishedAt: "2026-10-28T01:00:00Z" },
    };
    expect(planDispatch(setupDone, [review, todo], pools([[opus, 2]])).length).toBe(2);
  });

  it("holds work, reviews and claims except for the kept cards until the pause is lifted", () => {
    const kept = card();
    const held = card();
    const review = card({ stage: "needs_review" });
    const cards = [kept, held, review];
    const paused: KanbanBoard = {
      ...board,
      pause: { reason: "Ship the fix", keep: [kept.id], at: "2026-10-28T00:00:00Z", by: "owner" },
    };
    const available = pools([[opus, 3]]);
    expect(
      planDispatch(paused, cards, available).map((entry) => [entry.cardId, entry.role]),
    ).toEqual([[kept.id, "work"]]);
    const ctx = {
      threadId: "t1",
      pool: poolKey(opus),
      projectId: null,
      byId: new Map(cards.map((entry) => [entry.id as string, entry])),
      carrying: 1,
      slots: 3,
    };
    expect(checkClaim(paused, kept, ctx).ok).toBe(true);
    expect(checkClaim(paused, held, ctx)).toEqual({
      ok: false,
      reason: "the board is paused: Ship the fix",
    });
    const reviewKept = { ...paused, pause: { ...paused.pause!, keep: [review.id] } };
    expect(
      planDispatch(reviewKept, cards, available).map((entry) => [entry.cardId, entry.role]),
    ).toEqual([[review.id, "review"]]);
    const lifted = { ...paused, pause: null };
    expect(planDispatch(lifted, cards, available).map((entry) => entry.cardId)).toEqual([
      review.id,
      kept.id,
      held.id,
    ]);
    expect(checkClaim(lifted, held, ctx).ok).toBe(true);
  });

  it("leaves a todo card alone while its step is a board script's", () => {
    const scriptStep = card({
      subtasks: [
        {
          id: "s1",
          step: 1,
          text: "Merge the PR",
          owner: "script",
          script: "land",
          state: "open",
          note: null,
          doneBy: null,
          doneAt: null,
        },
      ],
    });
    expect(planDispatch(board, [scriptStep], pools([[opus, 2]]))).toEqual([]);
  });

  it("interleaves reviews and todos by priority", () => {
    const low = card({ priority: 3 });
    const high = card({ priority: 1 });
    const review = card({ stage: "needs_review" });
    const plan = planDispatch(board, [low, high, review], pools([[opus, 2]]));
    expect(plan.map((d) => [d.cardId, d.role])).toEqual([
      [high.id, "work"],
      [review.id, "review"],
    ]);
  });

  it.each([
    { todoPriority: 1, reviewPriority: 3, winner: "work" },
    { todoPriority: 2, reviewPriority: 2, winner: "review" },
    { todoPriority: 3, reviewPriority: 1, winner: "review" },
  ])(
    "$winner wins a single slot (todo P$todoPriority, review P$reviewPriority)",
    ({ todoPriority, reviewPriority, winner }) => {
      const todo = card({ priority: todoPriority, movedAt: "2026-10-25T00:00:00Z" });
      const review = card({
        stage: "needs_review",
        priority: reviewPriority,
        movedAt: "2026-10-25T01:00:00Z",
      });
      expect(planDispatch(board, [todo, review], pools([[opus, 1]]))).toMatchObject([
        { cardId: winner === "work" ? todo.id : review.id, role: winner },
      ]);
    },
  );

  it.each([
    {
      reason: "own urgency",
      olderPriority: 3,
      newerPriority: 1,
      olderHolds: 0,
      newerHolds: 0,
      waiterPriority: 1,
      winner: "newer",
    },
    {
      reason: "older review inherits P1 urgency",
      olderPriority: 3,
      newerPriority: 1,
      olderHolds: 1,
      newerHolds: 0,
      waiterPriority: 1,
      winner: "older",
    },
    {
      reason: "newer review inherits P1 urgency",
      olderPriority: 1,
      newerPriority: 3,
      olderHolds: 0,
      newerHolds: 1,
      waiterPriority: 1,
      winner: "newer",
    },
    {
      reason: "holds break equal urgency",
      olderPriority: 2,
      newerPriority: 2,
      olderHolds: 1,
      newerHolds: 2,
      waiterPriority: 4,
      winner: "newer",
    },
    {
      reason: "age breaks equal urgency and holds",
      olderPriority: 2,
      newerPriority: 2,
      olderHolds: 1,
      newerHolds: 1,
      waiterPriority: 4,
      winner: "older",
    },
    {
      reason: "urgency beats holds",
      olderPriority: 3,
      newerPriority: 1,
      olderHolds: 2,
      newerHolds: 0,
      waiterPriority: 4,
      winner: "newer",
    },
  ])(
    "picks the $winner review for one Astra slot: $reason",
    ({ olderPriority, newerPriority, olderHolds, newerHolds, waiterPriority, winner }) => {
      const older = card({
        stage: "needs_review",
        reviewChain: "Critical",
        reviewStep: 1,
        priority: olderPriority,
        movedAt: "2026-11-08T21:40:00Z",
      });
      const newer = card({
        stage: "needs_review",
        reviewChain: "Critical",
        reviewStep: 1,
        priority: newerPriority,
        movedAt: "2026-11-08T22:11:00Z",
      });
      const waiters = [
        ...Array.from({ length: olderHolds }, () =>
          card({ priority: waiterPriority, blockedBy: [older.id] }),
        ),
        ...Array.from({ length: newerHolds }, () =>
          card({ priority: waiterPriority, blockedBy: [newer.id] }),
        ),
      ];
      expect(planDispatch(board, [newer, older, ...waiters], pools([[astra, 1]]))).toMatchObject([
        { cardId: winner === "older" ? older.id : newer.id, role: "review", pool: poolKey(astra) },
      ]);
    },
  );

  it("prefers a review over a todo at equal inherited urgency", () => {
    const review = card({ stage: "needs_review", priority: 3, movedAt: "2026-11-09T02:00:00Z" });
    const reviewWaiter = card({ priority: 1, blockedBy: [review.id] });
    const todo = card({ priority: 1, movedAt: "2026-11-08T21:00:00Z" });
    const todoWaiters = Array.from({ length: 2 }, () =>
      card({ priority: 4, blockedBy: [todo.id] }),
    );
    expect(
      planDispatch(board, [todo, review, reviewWaiter, ...todoWaiters], pools([[opus, 1]])),
    ).toMatchObject([{ cardId: review.id, role: "review" }]);
  });

  it("keeps todo urgency and pick order when competing with reviews", () => {
    const review = card({ stage: "needs_review", priority: 2 });
    const blocker = card({ priority: 4 });
    const urgent = card({ priority: 1, blockedBy: [blocker.id] });
    const routine = card({ priority: 2 });
    expect(
      planDispatch(board, [review, routine, blocker, urgent], pools([[opus, 3]])).map(
        (d) => d.cardId,
      ),
    ).toEqual([blocker.id, review.id, routine.id]);
  });

  it("at the same priority takes the card holding up the most work first", () => {
    const loose = card();
    const holdsOne = card();
    const holdsChain = card();
    const waiter = card({ priority: 3, blockedBy: [holdsOne.id] });
    const middle = card({ priority: 4, blockedBy: [holdsChain.id] });
    const end = card({ priority: 4, blockedBy: [middle.id] });
    const urgent = card({ priority: 1 });
    const plan = planDispatch(
      board,
      [loose, holdsOne, holdsChain, waiter, middle, end, urgent],
      pools([[opus, 4]]),
    );
    expect(plan.map((d) => d.cardId)).toEqual([urgent.id, holdsChain.id, holdsOne.id, loose.id]);
  });

  it("takes a card holding up an urgent one as if it were that urgent", () => {
    const routine = card({ priority: 2 });
    const blocker = card({ priority: 4 });
    const urgent = card({ priority: 1, blockedBy: [blocker.id] });
    const plan = planDispatch(board, [routine, blocker, urgent], pools([[opus, 1]]));
    expect(plan.map((d) => d.cardId)).toEqual([blocker.id]);
  });

  it("doesn't count done or settled cards as held up, and survives a loop of blocks", () => {
    const b = card();
    const a = card();
    const doneWaiter = card({ stage: "completed", blockedBy: [a.id] });
    const settledWaiter = card({ blockedBy: [a.id], settledAt: "2026-10-25T01:00:00Z" });
    const loopX: KanbanCard = card();
    const loopY = card({ blockedBy: [loopX.id] });
    const x = { ...loopX, blockedBy: [loopY.id] };
    const plan = planDispatch(
      board,
      [a, b, doneWaiter, settledWaiter, x, loopY],
      pools([[opus, 2]]),
    );
    expect(plan.map((d) => d.cardId)).toEqual([b.id, a.id]);
  });

  it("holds a waiter until its completed blocker's merge subtask is done", () => {
    const mergeStep = (state: "open" | "done") => [
      {
        id: "m1",
        step: 4,
        text: "Rebase on latest ardud/main, merge into ardud/main, push origin main",
        owner: "evaluator" as const,
        state,
        note: null,
        doneBy: null,
        doneAt: null,
      },
    ];
    const blocker = card({ stage: "completed", subtasks: mergeStep("open") });
    const waiter = card({ blockedBy: [blocker.id] });
    expect(planDispatch(board, [blocker, waiter], pools([[opus, 2]])).map((d) => d.cardId)).toEqual(
      [],
    );
    const merged = card({ stage: "completed", subtasks: mergeStep("done") });
    const waiting = card({ blockedBy: [merged.id] });
    expect(planDispatch(board, [merged, waiting], pools([[opus, 2]])).map((d) => d.cardId)).toEqual(
      [waiting.id],
    );
  });

  it("counts running cards against their pool and never goes negative", () => {
    const running = card({
      stage: "working",
      activeThreadId: ThreadId.make("t1"),
      activePool: poolKey(opus),
    });
    const running2 = card({
      stage: "working",
      activeThreadId: ThreadId.make("t2"),
      activePool: poolKey(opus),
    });
    const waiting = card();
    expect(planDispatch(board, [running, running2, waiting], pools([[opus, 1]]))).toEqual([]);
    expect(planDispatch(board, [running, waiting], pools([[opus, 2]])).length).toBe(1);
  });

  it("skips blocked, stalled and settled cards; a done blocker unblocks", () => {
    const blocker = card({ stage: "working", activeThreadId: ThreadId.make("t"), activePool: "x" });
    const blocked = card({ blockedBy: [blocker.id] });
    const stalled = card({
      stalled: { reason: "waiting", by: { _tag: "owner" }, at: "2026-10-25T00:00:00Z" },
    });
    expect(planDispatch(board, [blocker, blocked, stalled], pools([[opus, 5]]))).toEqual([]);
    const doneBlocker = { ...blocker, stage: "completed" as const, activeThreadId: null };
    expect(planDispatch(board, [doneBlocker, blocked], pools([[opus, 5]])).length).toBe(1);
  });

  it("routes reviews to the chain step's pool", () => {
    const critical = card({ stage: "needs_review", reviewChain: "Critical" });
    const second = card({ stage: "needs_review", reviewChain: "Critical", reviewStep: 1 });
    const plan = planDispatch(
      board,
      [critical, second],
      pools([
        [sol, 1],
        [astra, 1],
      ]),
    );
    expect(plan.map((d) => d.pool)).toEqual([poolKey(sol), poolKey(astra)]);
    expect(planDispatch(board, [critical], pools([[astra, 1]]))).toEqual([]);
  });
});

describe("confirmDispatch", () => {
  const plan = (cards: ReadonlyArray<KanbanCard>, slots = 2) =>
    planDispatch(board, cards, pools([[opus, slots]]));

  it("confirms a start whose card, board and pool are unchanged", () => {
    const waiting = card();
    const [start] = plan([waiting]);
    expect(confirmDispatch(board, waiting, [waiting], pools([[opus, 2]]), new Map(), start!)).toBe(
      true,
    );
  });

  it("refuses when the card's row changed after planning", () => {
    const waiting = card();
    const [start] = plan([waiting]);
    const edited = { ...waiting, description: "edited", updatedAt: "2026-10-25T01:00:00Z" };
    const taken = { ...waiting, activeThreadId: ThreadId.make("t9"), activePool: poolKey(opus) };
    for (const fresh of [edited, taken]) {
      expect(confirmDispatch(board, waiting, [fresh], pools([[opus, 2]]), new Map(), start!)).toBe(
        false,
      );
    }
  });

  it("refuses when the pool filled, the board paused or a blocker reopened meanwhile", () => {
    const blocker = card({ stage: "completed" });
    const waiting = card({ blockedBy: [blocker.id] });
    const [start] = plan([blocker, waiting], 1);
    const running = card({
      stage: "working",
      activeThreadId: ThreadId.make("t1"),
      activePool: poolKey(opus),
    });
    const ok = (b: KanbanBoard, cards: ReadonlyArray<KanbanCard>, slots = 1) =>
      confirmDispatch(b, waiting, cards, pools([[opus, slots]]), new Map(), start!);
    expect(ok(board, [blocker, waiting])).toBe(true);
    expect(ok(board, [blocker, waiting, running])).toBe(false);
    expect(ok(board, [blocker, waiting], 0)).toBe(false);
    const paused: KanbanBoard = {
      ...board,
      pause: { reason: "r", keep: [], at: "2026-10-25T00:00:00Z", by: "owner" },
    };
    expect(ok(paused, [blocker, waiting])).toBe(false);
    expect(ok(board, [{ ...blocker, stage: "working" as const }, waiting])).toBe(false);
  });

  it("refuses a review whose chain or step model changed after planning", () => {
    const review = card({ stage: "needs_review" });
    const all = pools([
      [opus, 2],
      [sol, 2],
    ]);
    const [start] = planDispatch(board, [review], all);
    expect(start?.model).toEqual(opus);
    const ok = (b: KanbanBoard) => confirmDispatch(b, review, [review], all, new Map(), start!);
    expect(ok(board)).toBe(true);
    // Key order alone is not a change.
    expect(
      ok({
        ...board,
        reviewChains: [
          { steps: [sol, astra], name: "Critical" },
          { name: "Default", steps: [{ model: opus.model, instanceId: opus.instanceId }] },
        ],
      }),
    ).toBe(true);
    expect(ok({ ...board, defaultReviewChain: "Critical" })).toBe(false);
    expect(
      ok({
        ...board,
        reviewChains: [
          { name: "Critical", steps: [sol, astra] },
          { name: "Default", steps: [sol] },
        ],
      }),
    ).toBe(false);
  });

  it("refuses when the planned pool is gone", () => {
    const waiting = card();
    const [start] = plan([waiting]);
    expect(confirmDispatch(board, waiting, [waiting], pools([[sol, 2]]), new Map(), start!)).toBe(
      false,
    );
  });
});

describe("thread batching", () => {
  const t1 = ThreadId.make("t1");
  const working = (patch: Partial<KanbanCard> = {}) =>
    card({
      stage: "working",
      activeThreadId: t1,
      activeRole: "work",
      activePool: poolKey(opus),
      workThreadId: t1,
      ...patch,
    });

  it("counts a slot per thread, not per card", () => {
    const a = working();
    const b = working();
    const waiting = card();
    expect(planDispatch(board, [a, b, waiting], pools([[opus, 2]])).length).toBe(1);
    expect(planDispatch(board, [a, b, waiting], pools([[opus, 1]]))).toEqual([]);
  });

  it("sends a todo card back to its thread without a new slot, up to the cap", () => {
    const a = working();
    const back = card({ workThreadId: t1 });
    const plan = planDispatch(board, [a, back], pools([[opus, 1]]));
    expect(plan).toMatchObject([{ cardId: back.id, role: "work", joins: true }]);
    const full = Array.from({ length: MAX_BATCH }, () => working());
    expect(planDispatch(board, [...full, back], pools([[opus, 1]]))).toEqual([]);
  });

  it("does not wake a mixed batch for a kept card", () => {
    const held = working();
    const back = card({ workThreadId: t1 });
    const paused: KanbanBoard = {
      ...board,
      pause: { reason: "Hold", keep: [back.id], at: "2026-10-28T00:00:00Z", by: "owner" },
    };
    expect(planDispatch(paused, [held, back], pools([[opus, 1]]))).toEqual([]);
    expect(
      planDispatch({ ...paused, pause: null }, [held, back], pools([[opus, 1]])),
    ).toMatchObject([{ cardId: back.id, joins: true }]);
  });

  it("keeps a held slot for a thread between cards", () => {
    const waiting = card();
    const holds = new Map([["t1", poolKey(opus)]]);
    expect(planDispatch(board, [waiting], pools([[opus, 1]]), holds)).toEqual([]);
    const mine = card({ workThreadId: t1 });
    expect(planDispatch(board, [mine], pools([[opus, 1]]), holds)).toMatchObject([
      { cardId: mine.id, joins: true },
    ]);
  });

  it("claims only todo cards on the same pool and project, unblocked outside the thread", () => {
    const a = working();
    const blocker = card();
    const byId = new Map([a, blocker].map((c) => [c.id as string, c]));
    const ctx = {
      threadId: "t1",
      pool: poolKey(opus),
      projectId: null,
      byId,
      carrying: 1,
      slots: 1,
    };
    expect(checkClaim(board, card(), ctx).ok).toBe(true);
    expect(checkClaim(board, card({ model: haiku }), ctx).ok).toBe(false);
    expect(checkClaim(board, card({ stage: "needs_review" }), ctx).ok).toBe(false);
    expect(checkClaim(board, card({ blockedBy: [blocker.id] }), ctx).ok).toBe(false);
    expect(checkClaim(board, card({ blockedBy: [a.id] }), ctx).ok).toBe(true);
    expect(checkClaim(board, card(), { ...ctx, carrying: MAX_BATCH }).ok).toBe(false);
    // The setup hold covers claims and creates too, not only planDispatch.
    const setupRunning: KanbanBoard = {
      ...board,
      setup: {
        status: "running",
        discussionId: KanbanDiscussionId.make("disc-setup"),
        threadId: ThreadId.make("t-setup"),
        startedAt: "2026-10-28T00:00:00Z",
        finishedAt: null,
      },
    };
    expect(checkClaim(setupRunning, card(), ctx)).toEqual({
      ok: false,
      reason: "Setup is running",
    });
    expect(
      checkClaim(
        { ...setupRunning, setup: { ...setupRunning.setup!, status: "done" } },
        card(),
        ctx,
      ).ok,
    ).toBe(true);
    expect(checkClaim(board, card({ projectId: "p2" as KanbanCard["projectId"] }), ctx).ok).toBe(
      false,
    );
    // Kept for another work thread, or the pool is paused.
    expect(checkClaim(board, card({ workThreadId: ThreadId.make("t2") }), ctx).ok).toBe(false);
    expect(checkClaim(board, card({ workThreadId: t1 }), ctx).ok).toBe(true);
    expect(checkClaim(board, card(), { ...ctx, slots: 0 }).ok).toBe(false);
    expect(checkClaim(board, card({ priority: KANBAN_BACKLOG }), ctx).ok).toBe(false);
  });

  it("starts a card fresh when its old thread is busy in another pool", () => {
    const elsewhere = working({ model: haiku, activePool: poolKey(haiku) });
    const back = card({ workThreadId: t1 });
    expect(
      planDispatch(
        board,
        [elsewhere, back],
        pools([
          [opus, 1],
          [haiku, 1],
        ]),
      ),
    ).toMatchObject([{ cardId: back.id, joins: false, fresh: true }]);
  });

  it("starts a kept card fresh when its old thread carries a held card on another pool", () => {
    const held = working({ model: haiku, activePool: poolKey(haiku) });
    const back = card({ workThreadId: t1 });
    const paused: KanbanBoard = {
      ...board,
      pause: { reason: "Hold", keep: [back.id], at: "2026-10-28T00:00:00Z", by: "owner" },
    };
    expect(
      planDispatch(
        paused,
        [held, back],
        pools([
          [opus, 1],
          [haiku, 1],
        ]),
      ),
    ).toMatchObject([{ cardId: back.id, joins: false, fresh: true }]);
  });

  it("never picks up a backlog card, not even back to its own thread", () => {
    const parked = card({ priority: KANBAN_BACKLOG });
    const paused = card({ priority: KANBAN_BACKLOG, workThreadId: t1 });
    const review = card({ priority: KANBAN_BACKLOG, stage: "needs_review" });
    const next = card({ priority: 4 });
    expect(planDispatch(board, [parked, paused, review, next], pools([[opus, 3]]))).toMatchObject([
      { cardId: next.id },
    ]);
  });

  it("takes nothing from a pool at 0, not even a rejoin", () => {
    const a = working();
    const back = card({ workThreadId: t1 });
    expect(planDispatch(board, [a, back], pools([[opus, 0]]))).toEqual([]);
  });

  it("sends a card back to its thread when only that thread's own work holds it up", () => {
    const blocker = working();
    const back = card({ workThreadId: t1, blockedBy: [blocker.id] });
    expect(planDispatch(board, [blocker, back], pools([[opus, 1]]))).toMatchObject([
      { cardId: back.id, joins: true },
    ]);
    // Someone else's work still blocks it, and so does its old thread's work
    // when a new thread would have to take it.
    const other = working({
      activeThreadId: ThreadId.make("t2"),
      workThreadId: ThreadId.make("t2"),
    });
    const waits = card({ workThreadId: t1, blockedBy: [other.id] });
    expect(planDispatch(board, [blocker, other, waits], pools([[opus, 2]]))).toEqual([]);
    const elsewhere = working({ model: haiku, activePool: poolKey(haiku) });
    const parked = card({ workThreadId: t1, stage: "todo", blockedBy: [] });
    const held = card({ workThreadId: t1, blockedBy: [parked.id] });
    expect(
      planDispatch(
        board,
        [elsewhere, parked, held],
        pools([
          [opus, 2],
          [haiku, 1],
        ]),
      ).map((entry) => entry.cardId),
    ).toEqual([parked.id]);
  });

  it("counts a same-thread blocker that can't go on itself", () => {
    const by = "2026-10-25T12:00:00.000Z";
    const owner = { _tag: "owner" } as const;
    const paused = card({ workThreadId: t1, priority: KANBAN_BACKLOG });
    const stalled = card({ workThreadId: t1, stalled: { reason: "no access", by: owner, at: by } });
    const other = working({
      activeThreadId: ThreadId.make("t2"),
      workThreadId: ThreadId.make("t2"),
    });
    const heldInTurn = card({ workThreadId: t1, blockedBy: [other.id] });
    const asking = card({ workThreadId: t1, stage: "needs_owner", question: "Which fee?" });
    const fine = card({ workThreadId: t1 });
    const all = [paused, stalled, other, heldInTurn, asking, fine];
    const waiters = all.map((blocker) => card({ workThreadId: t1, blockedBy: [blocker.id] }));
    const byId = new Map([...all, ...waiters].map((c) => [c.id as string, c]));
    expect(waiters.map((waiter) => isBlocked(waiter, byId))).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
    // A loop of blocks on one thread never goes.
    const a = card({ workThreadId: t1 });
    const b = card({ workThreadId: t1, blockedBy: [a.id] });
    const looped = { ...a, blockedBy: [b.id] };
    expect(
      isBlocked(
        looped,
        new Map([
          [a.id as string, looped],
          [b.id as string, b],
        ]),
      ),
    ).toBe(true);
  });

  it("still reviews a card whose next step is the evaluator's, and leaves its todo alone", () => {
    const subtask = (id: string, step: number, owner: "work" | "evaluator") => ({
      id,
      step,
      text: id,
      owner,
      state: "open" as const,
      note: null,
      doneBy: null,
      doneAt: null,
    });
    const evaluatorStep = [
      { ...subtask("s1", 1, "work"), state: "done" as const },
      subtask("s2", 2, "evaluator"),
    ];
    const review = card({ stage: "needs_review", subtasks: evaluatorStep });
    const todo = card({ subtasks: evaluatorStep });
    const findings = card({ subtasks: evaluatorStep, wakeNote: "Review findings: fix it" });
    expect(
      planDispatch(board, [review, todo, findings], pools([[opus, 3]])).map(
        (entry) => entry.cardId,
      ),
    ).toEqual([review.id, findings.id]);
  });

  it("offers related todo cards with a reason, in pick order", () => {
    const pr = { kind: "pr" as const, url: "pr-1", label: null, state: null, checkedAt: null };
    const seed = working({ links: [pr] });
    const samePr = card({ links: [pr], priority: 3 });
    const waitsOnSeed = card({ blockedBy: [seed.id], priority: 1 });
    const grouped = card({ priority: 2 });
    const otherModel = card({ links: [pr], model: haiku });
    const unrelated = card();
    const candidates = relatedCandidates({
      board,
      cards: [seed, samePr, waitsOnSeed, grouped, otherModel, unrelated],
      groups: [
        {
          id: "g",
          name: "Fees",
          summary: "",
          cardIds: [seed.id, grouped.id],
          updatedAt: "2026-10-25T00:00:00Z",
        },
      ],
      seeds: [seed],
      threadId: "t1",
      pool: poolKey(opus),
      projectId: null,
      carrying: 1,
      slots: 1,
    });
    expect(candidates.map((c) => c.card.id)).toEqual([waitsOnSeed.id, grouped.id, samePr.id]);
    expect(candidates[0]?.why).toContain(`#${seed.number}`);
  });
});

describe("model weights", () => {
  const t1 = ThreadId.make("t1");
  const all = pools([
    [opus, 1],
    [haiku, 1],
    [sol, 1],
  ]);
  const weighted = (weights: ReadonlyArray<[ModelSelection, number]>, patch = {}) =>
    card({ models: weights.map(([m, weight]) => ({ model: m, weight })), ...patch });
  const busy = (m: ModelSelection) =>
    card({
      stage: "working",
      model: m,
      activeThreadId: ThreadId.make(`busy-${m.model}`),
      activeRole: "work",
      activePool: poolKey(m),
    });

  it("starts on the highest weight with room, then the next weight down", () => {
    const c = weighted([
      [opus, 60],
      [haiku, 20],
      [sol, 10],
    ]);
    expect(planDispatch(board, [c], all)).toMatchObject([{ model: opus, pool: poolKey(opus) }]);
    expect(planDispatch(board, [busy(opus), c], all)).toMatchObject([
      { cardId: c.id, model: haiku },
    ]);
    expect(planDispatch(board, [busy(opus), busy(haiku), c], all)).toMatchObject([
      { cardId: c.id, model: sol },
    ]);
    expect(planDispatch(board, [busy(opus), busy(haiku), busy(sol), c], all)).toEqual([]);
  });

  it("treats a paused pool as full, and splits equal weights with pick", () => {
    const c = weighted([
      [opus, 60],
      [haiku, 20],
      [sol, 20],
    ]);
    const paused = pools([
      [opus, 0],
      [haiku, 1],
      [sol, 1],
    ]);
    expect(planDispatch(board, [c], paused, new Map(), () => 0)).toMatchObject([{ model: haiku }]);
    expect(planDispatch(board, [c], paused, new Map(), (count) => count - 1)).toMatchObject([
      { model: sol },
    ]);
  });

  it("gives the room to the next card once one takes it", () => {
    const first = weighted([
      [opus, 2],
      [haiku, 1],
    ]);
    const second = weighted([
      [opus, 2],
      [haiku, 1],
    ]);
    expect(planDispatch(board, [first, second], all)).toMatchObject([
      { cardId: first.id, model: opus },
      { cardId: second.id, model: haiku },
    ]);
  });

  it("keeps a card on its thread's model once it has one", () => {
    const back = weighted(
      [
        [opus, 2],
        [haiku, 1],
      ],
      { model: haiku, workThreadId: t1 },
    );
    expect(planDispatch(board, [back], all)).toMatchObject([{ cardId: back.id, model: haiku }]);
  });

  it("lets a thread claim a weighted card on any of its pools", () => {
    const c = weighted([
      [opus, 2],
      [haiku, 1],
    ]);
    const ctx = {
      threadId: "t1",
      pool: poolKey(haiku),
      projectId: null,
      byId: new Map<string, KanbanCard>(),
      carrying: 1,
      slots: 1,
    };
    expect(checkClaim(board, c, ctx).ok).toBe(true);
    expect(checkClaim(board, c, { ...ctx, pool: poolKey(sol) }).ok).toBe(false);
    expect(modelOnPool(c, poolKey(haiku))).toEqual(haiku);
    expect(modelOnPool(c, poolKey(sol))).toBeNull();
    // Once its thread has it, the card runs only on that thread's model.
    const kept = { ...c, model: opus, workThreadId: t1 };
    expect(checkClaim(board, kept, ctx).ok).toBe(false);
  });
});

describe("discussionSettleDue", () => {
  const START = Date.parse("2026-10-25T00:00:00Z");
  const H = 60 * 60 * 1000;
  const discussion = (patch: Partial<KanbanDiscussion> = {}): KanbanDiscussion => ({
    id: KanbanDiscussionId.make("d1"),
    boardId: board.id,
    cardId: null,
    title: "Talk",
    evaluatorThreadId: null,
    participants: [],
    lastSeq: 0,
    lastMessageAt: null,
    createdBy: { _tag: "owner" },
    createdAt: "2026-10-25T00:00:00.000Z",
    archivedAt: null,
    titleEditedAt: null,
    settledAt: null,
    snoozedUntil: null,
    pinnedAt: null,
    reopenedAt: null,
    ...patch,
  });
  const typing = [
    {
      actor: { _tag: "owner" as const },
      name: "Abdullah",
      lastReadSeq: 0,
      typingUntil: "2026-10-26T00:00:00.000Z",
      owes: null,
    },
  ] as KanbanDiscussion["participants"];

  it("settles a board channel and a verified card's discussion once a day has passed", () => {
    expect(discussionSettleDue(discussion(), null, START + 25 * H)).toBe(true);
    const verified = card({ stage: "verified" });
    expect(discussionSettleDue(discussion({ cardId: verified.id }), verified, START + 25 * H)).toBe(
      true,
    );
  });

  it("waits for the full idle day before settling", () => {
    expect(discussionSettleDue(discussion(), null, START + 23 * H)).toBe(false);
    expect(discussionSettleDue(discussion(), null, START + 24 * H)).toBe(true);
  });

  it("keeps a discussion whose card is still open", () => {
    for (const stage of ["todo", "working", "needs_review", "in_review", "completed"] as const) {
      const open = card({ stage });
      expect(discussionSettleDue(discussion({ cardId: open.id }), open, START + 25 * H)).toBe(
        false,
      );
    }
  });

  it("never settles a pinned, settled or archived discussion", () => {
    expect(
      discussionSettleDue(
        discussion({ pinnedAt: "2026-10-25T01:00:00.000Z" }),
        null,
        START + 49 * H,
      ),
    ).toBe(false);
    expect(
      discussionSettleDue(
        discussion({ settledAt: "2026-10-25T01:00:00.000Z" }),
        null,
        START + 49 * H,
      ),
    ).toBe(false);
    expect(
      discussionSettleDue(
        discussion({ archivedAt: "2026-10-25T01:00:00.000Z" }),
        null,
        START + 49 * H,
      ),
    ).toBe(false);
  });

  it("keeps a discussion snoozed into the future", () => {
    const snoozed = discussion({ snoozedUntil: "2026-10-27T00:00:00.000Z" });
    expect(discussionSettleDue(snoozed, null, START + 25 * H)).toBe(false);
  });

  it("keeps a discussion while someone is typing in it", () => {
    expect(discussionSettleDue(discussion({ participants: typing }), null, START + 49 * H)).toBe(
      false,
    );
  });

  it("restarts the idle day when a lapsed snooze ends: 23h false, 25h true", () => {
    const wake = "2026-10-25T10:00:00.000Z";
    const wakeMs = Date.parse(wake);
    const lapsed = discussion({ snoozedUntil: wake });
    expect(discussionSettleDue(lapsed, null, wakeMs + 23 * H)).toBe(false);
    expect(discussionSettleDue(lapsed, null, wakeMs + 25 * H)).toBe(true);
  });

  it("restarts the idle day from reopenedAt: 23h false, 25h true", () => {
    const reopened = "2026-10-25T10:00:00.000Z";
    const reopenedMs = Date.parse(reopened);
    const d = discussion({ reopenedAt: reopened });
    expect(discussionSettleDue(d, null, reopenedMs + 23 * H)).toBe(false);
    expect(discussionSettleDue(d, null, reopenedMs + 25 * H)).toBe(true);
  });

  it("counts the idle day from the last message, not from creation", () => {
    const d = discussion({ lastMessageAt: "2026-10-25T12:00:00.000Z" });
    expect(discussionSettleDue(d, null, START + 25 * H)).toBe(false);
    expect(discussionSettleDue(d, null, START + 37 * H)).toBe(true);
  });
});

describe("workerQuietDue", () => {
  const START = Date.parse("2026-10-25T00:00:00Z");
  const START_ISO = "2026-10-25T00:00:00.000Z";
  const working = card({
    stage: "working",
    activeRole: "work",
    activeThreadId: ThreadId.make("t1"),
    movedAt: START_ISO,
  });
  const at = (minutes: number) => START + minutes * 60 * 1000;
  const view = (state: string) => ({ state, quietSince: START_ISO });

  it("is due for an idle or stuck worker after 30 minutes", () => {
    expect(workerQuietDue(working, view("idle"), at(31))).toBe(true);
    expect(workerQuietDue(working, view("idle"), at(29))).toBe(false);
    expect(workerQuietDue(working, view("needs-input"), at(31))).toBe(true);
    expect(workerQuietDue(working, view("running"), at(31))).toBe(false);
  });

  it("counts from quietSince", () => {
    const quiet = { state: "idle", quietSince: "2026-10-25T00:20:00.000Z" };
    expect(workerQuietDue(working, quiet, at(31))).toBe(false);
    expect(workerQuietDue(working, quiet, at(51))).toBe(true);
  });

  it("counts from the last nudge and skips stalled or review cards", () => {
    const nudged = { ...working, nudgedAt: "2026-10-25T00:21:00.000Z" };
    expect(workerQuietDue(nudged, view("idle"), at(31))).toBe(false);
    expect(
      workerQuietDue(
        { ...working, stalled: { reason: "x", by: { _tag: "owner" }, at: START_ISO } },
        view("idle"),
        at(31),
      ),
    ).toBe(false);
    expect(workerQuietDue({ ...working, activeRole: "review" }, view("idle"), at(31))).toBe(false);
  });
});

describe("waitingOnBackground and reviewerQuietDue", () => {
  const START = Date.parse("2026-10-25T00:00:00Z");
  const START_ISO = "2026-10-25T00:00:00.000Z";
  const at = (minutes: number) => START + minutes * 60 * 1000;
  const bg = (state: string, background: number) => ({
    state,
    quietSince: START_ISO,
    backgroundWork: background,
  });

  it("holds an idle thread with background work for the grace only", () => {
    expect(BACKGROUND_GRACE_MS).toBe(60 * 60 * 1000);
    expect(waitingOnBackground(bg("idle", 1), at(59))).toBe(true);
    expect(waitingOnBackground(bg("idle", 1), at(61))).toBe(false);
    expect(waitingOnBackground(bg("idle", 0), at(59))).toBe(false);
    expect(waitingOnBackground(bg("running", 1), at(59))).toBe(false);
  });

  const reviewing = card({
    stage: "in_review",
    activeRole: "review",
    activeThreadId: ThreadId.make("t1"),
    movedAt: START_ISO,
  });
  const idle = { state: "idle", quietSince: START_ISO };

  it("is due for an idle reviewer with no verdict after 30 minutes", () => {
    expect(reviewerQuietDue(reviewing, idle, at(31))).toBe(true);
    expect(reviewerQuietDue(reviewing, idle, at(29))).toBe(false);
  });

  it("counts from the last nudge", () => {
    const nudged = { ...reviewing, nudgedAt: "2026-10-25T00:20:00.000Z" };
    expect(reviewerQuietDue(nudged, idle, at(31))).toBe(false);
    expect(reviewerQuietDue(nudged, idle, at(51))).toBe(true);
  });

  it("skips stalled, worker and running reviewers", () => {
    expect(
      reviewerQuietDue(
        { ...reviewing, stalled: { reason: "x", by: { _tag: "owner" }, at: START_ISO } },
        idle,
        at(31),
      ),
    ).toBe(false);
    expect(reviewerQuietDue({ ...reviewing, activeRole: "work" }, idle, at(31))).toBe(false);
    expect(reviewerQuietDue(reviewing, { ...idle, state: "running" }, at(31))).toBe(false);
  });
});

describe("isContextFull", () => {
  it("treats a thread too long for the model as context-full", () => {
    expect(
      isContextFull({
        message:
          '[400]: {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 1000528 tokens > 1000000 maximum"}}',
      }),
    ).toBe(true);
    expect(isContextFull({ message: "context_length_exceeded" })).toBe(true);
    expect(isContextFull({ message: "This model's maximum context length is 200000 tokens" })).toBe(
      true,
    );
    expect(
      isContextFull({
        message:
          "Insufficient context allowance for the provider handoff. Compact the target conversation or use a larger-context model; the current request has not been truncated.",
      }),
    ).toBe(true);
    expect(
      isContextFull({
        message:
          "The request leaves too little context for a provider handoff. Shorten the request or use a larger-context model; the current request has not been truncated.",
      }),
    ).toBe(true);
  });

  it("leaves model, variant and empty failures alone", () => {
    expect(isContextFull({ message: "Variant unavailable for opus/gpt-6-astra: high" })).toBe(
      false,
    );
    expect(isContextFull({ message: "The run failed without an error message." })).toBe(false);
  });
});

describe("isHandoffBudget", () => {
  it("distinguishes handoff budget errors from provider overflows", () => {
    expect(
      isHandoffBudget({ message: "Insufficient context allowance for the provider handoff." }),
    ).toBe(true);
    expect(
      isHandoffBudget({ message: "The request leaves too little context for a provider handoff." }),
    ).toBe(true);
    expect(isHandoffBudget({ message: "prompt is too long" })).toBe(false);
  });
});

describe("isOutage category", () => {
  it("treats quota, transient and expired-auth categories as outages", () => {
    for (const category of ["quota", "transient", "auth_expired"]) {
      expect(isOutage({ class: "provider_error", code: null, message: "anything", category })).toBe(
        true,
      );
    }
  });

  it("never treats config, model, context or content categories as outages, even with outage text", () => {
    const outageLookingText =
      "Third-party apps now draw from your extra usage, not your plan limits. Rate limit exceeded.";
    for (const category of ["config", "model_invalid", "context_exhausted", "content_filter"]) {
      expect(
        isOutage({
          class: "usage_limit",
          code: "provider.quota",
          message: outageLookingText,
          category,
        }),
      ).toBe(false);
    }
  });

  it("falls back to the text and code checks when the category is unknown or missing", () => {
    expect(
      isOutage({
        class: "provider_error",
        code: "provider.internal",
        message: "Timed out waiting for response headers",
        category: "unknown",
      }),
    ).toBe(true);
    expect(
      isOutage({ class: "provider_error", code: "provider.internal", message: "slow down" }),
    ).toBe(false);
  });

  it("keeps a provider.content-filter failure on the flag path without a category", () => {
    expect(
      isOutage({
        class: "provider_error",
        code: "provider.content-filter",
        message: "Provider blocked the response",
      }),
    ).toBe(false);
  });
});

describe("isOutage", () => {
  it("treats out-of-usage, rate-limit and expired-token failures as outages", () => {
    expect(
      isOutage({
        class: "provider_error",
        code: "provider.invalid-request",
        message:
          'Provider error [400]: {"type":"error","error":{"type":"invalid_request_error","message":"Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going."}}',
      }),
    ).toBe(true);
    expect(
      isOutage({
        class: "provider_error",
        code: "provider.invalid-request",
        message:
          "Third-party apps now draw from extra usage, not plan limits. Ask your workspace admin to add more and keep going.",
      }),
    ).toBe(true);
    expect(
      isOutage({ class: "usage_limit", code: "provider.rate-limit", message: "slow down" }),
    ).toBe(true);
    expect(
      isOutage({
        class: "provider_error",
        code: "provider.internal",
        message: "OAuth access token has expired",
      }),
    ).toBe(true);
    expect(
      isOutage({
        class: "provider_error",
        code: "provider.internal",
        message: "Timed out waiting for response headers",
      }),
    ).toBe(true);
  });

  it("keeps request, model and content failures on the flag path", () => {
    expect(
      isOutage({
        class: "provider_error",
        code: "provider.invalid-request",
        message: "prompt is too long: 1200000 tokens > 1000000 maximum",
      }),
    ).toBe(false);
    expect(
      isOutage({
        class: "provider_error",
        code: "provider.internal",
        message: "Request timed out while reading tool output",
      }),
    ).toBe(false);
    expect(
      isOutage({
        class: "provider_error",
        code: "provider.no-route",
        message: "Variant unavailable for opus/gpt-6-astra: high",
      }),
    ).toBe(false);
    expect(
      isOutage({
        class: "provider_error",
        code: "provider.content-filter",
        message: "Provider blocked the response",
      }),
    ).toBe(false);
  });
});

describe("probe backoff and pool masking", () => {
  it("doubles the probe delay from 5 minutes up to 30", () => {
    const minutes = 60 * 1000;
    expect(nextProbeDelay(5 * minutes)).toBe(10 * minutes);
    expect(nextProbeDelay(10 * minutes)).toBe(20 * minutes);
    expect(nextProbeDelay(20 * minutes)).toBe(30 * minutes);
    expect(nextProbeDelay(30 * minutes)).toBe(30 * minutes);
  });

  it("zeroes only the down pool's slots", () => {
    const down = {
      instanceId: ProviderInstanceId.make("opencode"),
      model: "opus/claude-opus-5-5",
    } as ModelSelection;
    const up = { ...down, model: "opus/cx/gpt-6.1-sol" } as ModelSelection;
    const pools = [
      { key: poolKey(down), model: down, slots: 3 },
      { key: poolKey(up), model: up, slots: 1 },
    ] as unknown as ReadonlyArray<KanbanPool>;
    const masked = maskDownPools(pools, new Set(["opencode/opus/claude-opus-5-5"]));
    expect(masked.map((pool) => pool.slots)).toEqual([0, 1]);
  });

  it("zeroes every level of a down model", () => {
    const high = { ...opus, options: [{ id: "variant", value: "high" }] } as ModelSelection;
    const max = { ...opus, options: [{ id: "variant", value: "max" }] } as ModelSelection;
    const masked = maskDownPools(
      pools([
        [high, 2],
        [max, 3],
        [sol, 1],
      ]),
      new Set([modelKey(opus)]),
    );
    expect(masked.map((pool) => pool.slots)).toEqual([0, 0, 1]);
  });
});

describe("pool levels", () => {
  const at = (m: ModelSelection, level: string): ModelSelection => ({
    ...m,
    options: [{ id: "variant", value: level }],
  });

  it("keys a pool by model and level, and leaves a model with no level as it was", () => {
    expect(poolKey(haiku)).toBe("opencode/opus/cc/claude-haiku-5-5");
    expect(poolKey(at(haiku, "max"))).toBe("opencode/opus/cc/claude-haiku-5-5#max");
    expect(modelKey(at(haiku, "max"))).toBe("opencode/opus/cc/claude-haiku-5-5");
    expect(modelLevel(at(haiku, "max"))).toBe("max");
    expect(modelLevel(haiku)).toBeNull();
  });

  it("finds the exact level's pool, else the model's first pool", () => {
    const all = pools([
      [at(haiku, "max"), 3],
      [at(haiku, "xhigh"), 1],
      [opus, 1],
    ]);
    expect(poolFor(all, at(haiku, "xhigh"))?.key).toBe(poolKey(at(haiku, "xhigh")));
    // A named level is exact: a low card has no low pool here, so it gets none.
    expect(poolFor(all, at(haiku, "low"))).toBeUndefined();
    expect(poolFor(all, haiku)?.key).toBe(poolKey(at(haiku, "max")));
    // A named level on a model whose only pool has no level gets no pool: levels never mix.
    expect(poolFor(all, at(opus, "high"))).toBeUndefined();
    expect(poolFor(all, opus)?.key).toBe(poolKey(opus));
    expect(poolFor(all, sol)).toBeUndefined();
  });

  it("runs each level's cards on its own pool, and a card at an unpooled level on the model's first", () => {
    const max = at(haiku, "max");
    const xhigh = at(haiku, "xhigh");
    const all = pools([
      [max, 1],
      [xhigh, 1],
    ]);
    const plan = planDispatch(
      board,
      [card({ model: xhigh }), card({ model: max }), card({ model: at(haiku, "low") })],
      all,
    );
    // The low card has no pool of its own here, so it waits instead of taking max's slot.
    expect(plan.map((d) => d.pool)).toEqual([poolKey(xhigh), poolKey(max)]);
    const alone = planDispatch(board, [card({ model: at(haiku, "low") })], all);
    expect(alone).toEqual([]);
  });

  it("lets a thread claim a card whose level runs on the thread's pool", () => {
    const max = at(haiku, "max");
    const c = card({ model: at(haiku, "low") });
    const ctx = {
      threadId: "t1",
      pool: poolKey(max),
      projectId: null,
      byId: new Map([[c.id as string, c]]),
      carrying: 0,
      slots: 1,
    };
    // A low card can't be claimed on the thread's max pool: its level has no pool here.
    expect(checkClaim(board, c, { ...ctx, pools: pools([[max, 1]]) }).ok).toBe(false);
    const own = card({ model: max });
    expect(
      checkClaim(board, own, {
        ...ctx,
        byId: new Map([[own.id as string, own]]),
        pools: pools([[max, 1]]),
      }).ok,
    ).toBe(true);
    expect(modelOnPool(own, poolKey(max), pools([[max, 1]]))).toEqual(own.model);
  });
});

describe("claude effort pools", () => {
  const claude = (level: string | null): ModelSelection => ({
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-haiku-5-5",
    ...(level === null ? {} : { options: [{ id: "effort", value: level }] }),
  });
  const maxPool = claude("max");
  const xhighPool = claude("xhigh");

  it("keeps max and xhigh on their own pools, and a named level without a pool gets none", () => {
    const all = pools([
      [maxPool, 1],
      [xhighPool, 1],
    ]);
    expect(poolFor(all, claude("max"))?.key).toBe(poolKey(maxPool));
    expect(poolFor(all, claude("xhigh"))?.key).toBe(poolKey(xhighPool));
    expect(poolFor(all, claude("low"))).toBeUndefined();
  });

  it("a card with no level falls back to the model's first pool", () => {
    const all = pools([
      [maxPool, 1],
      [xhighPool, 1],
    ]);
    expect(poolFor(all, claude(null))?.key).toBe(poolKey(maxPool));
  });

  it("an alias keeps the same level rule: its own level's pool, or none", () => {
    const all = pools([
      [maxPool, 1],
      [xhighPool, 1],
    ]);
    expect(aliasPool(all, claude("xhigh"))?.key).toBe(poolKey(xhighPool));
    expect(aliasPool(all, claude("low"))).toBeUndefined();
    expect(aliasPool(all, claude(null))?.key).toBe(poolKey(maxPool));
  });

  it("a named level is exact on OpenCode too: an xhigh-only pool never runs a max card", () => {
    const opencode = (level: string): ModelSelection => ({
      instanceId: ProviderInstanceId.make("opencode"),
      model: "opus/gpt-6-astra",
      options: [{ id: "variant", value: level }],
    });
    const xhighOnly = pools([[opencode("xhigh"), 1]]);
    expect(poolFor(xhighOnly, opencode("xhigh"))?.key).toBe(poolKey(opencode("xhigh")));
    expect(poolFor(xhighOnly, opencode("max"))).toBeUndefined();
    const maxAlias: ModelSelection = {
      instanceId: ProviderInstanceId.make("opus"),
      model: "gpt-6-astra",
      options: [{ id: "variant", value: "max" }],
    };
    expect(aliasPool(xhighOnly, maxAlias)).toBeUndefined();
  });

  it("OpenCode levels with no pool are refused, and a card with no level still takes the model's pool", () => {
    const opencodeHigh: ModelSelection = {
      instanceId: ProviderInstanceId.make("opencode"),
      model: "opus/cc/claude-haiku-5-5",
      options: [{ id: "variant", value: "high" }],
    };
    const all = pools([[opencodeHigh, 1]]);
    const max: ModelSelection = { ...opencodeHigh, options: [{ id: "variant", value: "max" }] };
    expect(poolFor(all, max)).toBeUndefined();
    const bare: ModelSelection = {
      instanceId: ProviderInstanceId.make("opencode"),
      model: "opus/cc/claude-haiku-5-5",
    };
    expect(poolFor(all, bare)?.key).toBe(poolKey(opencodeHigh));
  });
});
