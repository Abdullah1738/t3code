import {
  KanbanBoardId,
  KanbanCardId,
  ThreadId,
  type KanbanBoard,
  type KanbanCard,
  type KanbanPool,
  type ModelSelection,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { applyReviewResult, checkMove, planDispatch, poolKey, prsLanded } from "./rules.ts";

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
    projectId: null,
    links: [],
    blockedBy: [],
    stalled: null,
    question: null,
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
