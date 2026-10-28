import {
  KANBAN_BACKLOG,
  KanbanBoardId,
  KanbanCardId,
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
  discussionSettleDue,
  isBlocked,
  MAX_BATCH,
  modelOnPool,
  planDispatch,
  poolKey,
  prsLanded,
  relatedCandidates,
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
});

describe("planDispatch", () => {
  it("takes reviews before work and todo by priority", () => {
    const low = card({ priority: 3 });
    const high = card({ priority: 1 });
    const review = card({ stage: "needs_review" });
    const plan = planDispatch(board, [low, high, review], pools([[opus, 2]]));
    expect(plan.map((d) => [d.cardId, d.role])).toEqual([
      [review.id, "review"],
      [high.id, "work"],
    ]);
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
