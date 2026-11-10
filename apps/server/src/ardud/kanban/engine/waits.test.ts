import type { KanbanActor, KanbanCard, KanbanWait } from "@t3tools/contracts";
import { KANBAN_WAIT_LIMIT_MS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { poolThreads } from "./rules.ts";
import type { KanbanThreadPr } from "./threads.ts";
import {
  checkWait,
  endWait,
  expireWait,
  findPrLink,
  mayClearFlag,
  newWait,
  nextActor,
  prName,
  resolveWait,
  sameCommit,
  waitersOn,
  waitExpired,
  waitHidesIdle,
  waitHoldsDispatch,
  waitSatisfied,
  waitSetBody,
  waitSkipsNudge,
  waitSlotProblem,
  waitTarget,
  type WaitFacts,
  type WaitRequest,
} from "./waits.ts";

const SET_AT = "2026-11-10T10:00:00.000Z";
const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const AT = "2026-11-10T12:00:00.000Z";
const PR = "https://github.com/Equicom-Crypto/trading-core/pull/512";
const OTHER_PR = "https://github.com/Equicom-Crypto/trading-core/pull/513";
const owner: KanbanActor = { _tag: "owner" };
const evaluator: KanbanActor = { _tag: "evaluator", threadId: "thread-eval" as never };
const worker: KanbanActor = { _tag: "thread", threadId: "thread-work" as never };

function card(number: number, patch: Partial<KanbanCard> = {}): KanbanCard {
  return {
    id: `card-${number}`,
    boardId: "board-toy",
    number,
    title: `Card ${number}`,
    description: "",
    prompt: "",
    subtasks: [],
    subtaskSeq: 0,
    stage: "in_review",
    priority: 3,
    goalId: null,
    projects: [],
    model: { instanceId: "opencode", model: "opus/claude-opus-5-5" },
    models: [],
    projectId: null,
    links: [{ kind: "pr", url: PR, label: null, state: "open", checkedAt: SET_AT }],
    blockedBy: [],
    stalled: null,
    question: null,
    asks: [],
    reviewChain: null,
    reviewStep: 1,
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
    createdBy: owner,
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: SET_AT,
    movedAt: "2026-11-09T10:00:00.000Z",
    ...patch,
  } as KanbanCard;
}

const wait = (patch: Partial<KanbanWait> = {}): KanbanWait =>
  ({
    on: "push",
    pr: PR,
    card: null,
    ask: null,
    until: null,
    sinceHead: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    note: "Pavan to push the F1-F3 fixes",
    by: evaluator,
    at: SET_AT,
    wakeRole: null,
    expiredAt: null,
    ...patch,
  }) as KanbanWait;

const facts = (patch: Partial<WaitFacts> = {}): WaitFacts => ({
  nowMs: NOW,
  prs: [],
  cards: new Map(),
  ...patch,
});
const ctx = { chainLength: 1 };

const subtask = (owner: "work" | "review" | "evaluator" | "script", text = "do it") =>
  ({
    id: "s1",
    step: 1,
    text,
    owner,
    state: "open",
    note: null,
    doneBy: null,
    doneAt: null,
  }) as KanbanCard["subtasks"][number];

describe("waitSatisfied", () => {
  it("holds a card with no wait", () => {
    expect(waitSatisfied(card(1), facts())).toEqual({ over: false });
  });

  it("push: holds on the reviewed head, ends when the head moves, with the commit count when known", () => {
    const waiting = card(1, { wait: wait() });
    const same = { url: PR, state: "open" as const, head: "a1b2c3d4" };
    expect(waitSatisfied(waiting, facts({ prs: [same] }))).toEqual({ over: false });
    expect(
      waitSatisfied(
        waiting,
        facts({ prs: [{ url: PR, state: "open", head: "ffee0011223344", commitsSince: 3 }] }),
      ),
    ).toEqual({
      over: true,
      outcome: "met",
      reason: "The author pushed 3 commits to trading-core#512 (head ffee001)",
    });
    expect(
      waitSatisfied(waiting, facts({ prs: [{ url: PR, state: "draft", head: "ffee0011223344" }] })),
    ).toEqual({
      over: true,
      outcome: "met",
      reason: "The author pushed to trading-core#512: its head moved from a1b2c3d to ffee001",
    });
  });

  it("push: an unknown head or an unread PR never ends it, and a merged or closed PR does", () => {
    const waiting = card(1, { wait: wait() });
    expect(waitSatisfied(waiting, facts({ prs: [{ url: PR, state: "open" }] })).over).toBe(false);
    expect(
      waitSatisfied(waiting, facts({ prs: [{ url: PR, state: "open", head: null }] })).over,
    ).toBe(false);
    expect(waitSatisfied(waiting, facts({ prs: [{ url: OTHER_PR, state: "merged" }] })).over).toBe(
      false,
    );
    expect(
      waitSatisfied(
        card(1, { wait: wait({ sinceHead: null }) }),
        facts({ prs: [{ url: PR, state: "open", head: "ffee0011" }] }),
      ).over,
    ).toBe(false);
    expect(waitSatisfied(waiting, facts({ prs: [{ url: PR, state: "merged" }] }))).toEqual({
      over: true,
      outcome: "moot",
      reason: "trading-core#512 merged while this waited for a push",
    });
    expect(waitSatisfied(waiting, facts({ prs: [{ url: PR, state: "closed" }] }))).toMatchObject({
      over: true,
      outcome: "moot",
    });
  });

  it("merge: ends when the PR merges, fails when it is closed, holds while open", () => {
    const waiting = card(1, { wait: wait({ on: "merge", sinceHead: null }) });
    expect(waitSatisfied(waiting, facts({ prs: [{ url: PR, state: "open" }] })).over).toBe(false);
    expect(waitSatisfied(waiting, facts({ prs: [{ url: PR, state: "merged" }] }))).toEqual({
      over: true,
      outcome: "met",
      reason: "trading-core#512 merged",
    });
    expect(waitSatisfied(waiting, facts({ prs: [{ url: PR, state: "closed" }] }))).toEqual({
      over: true,
      outcome: "failed",
      reason: "trading-core#512 was closed without merging",
    });
  });

  it("ci: ends on a pass or a failure, holds while pending or unreported", () => {
    const waiting = card(1, { wait: wait({ on: "ci", sinceHead: null }) });
    const pr = (checks: "passing" | "failing" | "pending" | null) => ({
      url: PR,
      state: "open" as const,
      head: "a1b2c3d4e5",
      checks,
    });
    expect(waitSatisfied(waiting, facts({ prs: [pr("pending")] })).over).toBe(false);
    expect(waitSatisfied(waiting, facts({ prs: [pr(null)] })).over).toBe(false);
    expect(waitSatisfied(waiting, facts({ prs: [pr("passing")] }))).toEqual({
      over: true,
      outcome: "met",
      reason: "CI passed on trading-core#512 at a1b2c3d",
    });
    expect(waitSatisfied(waiting, facts({ prs: [pr("failing")] }))).toEqual({
      over: true,
      outcome: "failed",
      reason: "CI failed on trading-core#512 at a1b2c3d",
    });
    expect(
      waitSatisfied(waiting, facts({ prs: [{ url: PR, state: "merged", checks: "pending" }] })),
    ).toMatchObject({ over: true, outcome: "moot" });
  });

  it("card: ends when the other card is done, settled or gone; a completed card with its merge open still holds", () => {
    const waiting = card(1, { wait: wait({ on: "card", pr: null, card: "card-2102" as never }) });
    const other = (patch: Partial<KanbanCard>) =>
      facts({ cards: new Map([["card-2102", card(2102, patch)]]) });
    expect(waitSatisfied(waiting, other({ stage: "working" })).over).toBe(false);
    expect(
      waitSatisfied(
        waiting,
        other({ stage: "completed", subtasks: [subtask("evaluator", "merge into native-v1")] }),
      ).over,
    ).toBe(false);
    expect(waitSatisfied(waiting, other({ stage: "completed" }))).toEqual({
      over: true,
      outcome: "met",
      reason: "Card #2102 is done",
    });
    expect(waitSatisfied(waiting, other({ stage: "todo", settledAt: AT as never }))).toMatchObject({
      over: true,
      reason: "Card #2102 is settled",
    });
    expect(waitSatisfied(waiting, facts())).toEqual({
      over: true,
      outcome: "moot",
      reason: "The card it waited on is gone",
    });
  });

  it("time: ends once the time has passed", () => {
    const at = (until: string) =>
      card(1, { wait: wait({ on: "time", pr: null, until: until as never }) });
    expect(waitSatisfied(at("2026-11-10T12:00:01.000Z"), facts()).over).toBe(false);
    expect(waitSatisfied(at("2026-11-10T12:00:00.000Z"), facts())).toEqual({
      over: true,
      outcome: "met",
      reason: "The time you set has passed",
    });
  });

  it("owner_go: ends when the question is closed, or is no longer on the card", () => {
    const ask = (closedAt: string | null) =>
      ({
        id: "q1",
        text: "Merge?",
        blocking: false,
        by: evaluator,
        at: SET_AT,
        seq: null,
        closedAt,
      }) as never;
    const waiting = (asks: KanbanCard["asks"]) =>
      card(1, { asks, wait: wait({ on: "owner_go", pr: null, ask: "q1" as never }) });
    expect(waitSatisfied(waiting([ask(null)]), facts()).over).toBe(false);
    expect(waitSatisfied(waiting([ask(AT)]), facts())).toEqual({
      over: true,
      outcome: "met",
      reason: "Question q1 was answered or dropped",
    });
    expect(waitSatisfied(waiting([]), facts())).toMatchObject({ over: true, outcome: "moot" });
  });
});

describe("facts", () => {
  it("takes the board's thread PR readings as they are", () => {
    // What threads.view(...).prs returns: the tick passes it straight in.
    const prs: ReadonlyArray<KanbanThreadPr> = [
      { url: PR, title: "Fix", state: "open", head: "ffee00112233", checks: "passing" },
    ];
    expect(waitSatisfied(card(1, { wait: wait() }), facts({ prs })).over).toBe(true);
    expect(waitSatisfied(card(1, { wait: wait({ on: "ci" }) }), facts({ prs })).over).toBe(true);
    const untracked: ReadonlyArray<KanbanThreadPr> = [{ url: PR, title: null, state: "open" }];
    expect(waitSatisfied(card(1, { wait: wait() }), facts({ prs: untracked })).over).toBe(false);
  });
});

describe("expiry", () => {
  it("expires a wait past its kind's limit, once, and keeps it holding", () => {
    const waiting = card(7, { wait: wait() });
    const late = facts({ nowMs: Date.parse(SET_AT) + KANBAN_WAIT_LIMIT_MS.push! });
    expect(waitExpired(waiting, NOW)).toBe(false);
    expect(expireWait(waiting, facts(), AT)).toBeNull();
    expect(waitExpired(waiting, late.nowMs)).toBe(true);
    const expired = expireWait(waiting, late, "2026-11-13T10:00:00.000Z");
    expect(expired?.card.wait?.expiredAt).toBe("2026-11-13T10:00:00.000Z");
    expect(expired?.card.stage).toBe("in_review");
    expect(expired?.event).toEqual({
      kind: "wait_expired",
      body: 'Waited 3d on the author to push to trading-core#512 with no change ("Pavan to push the F1-F3 fixes")',
      fromStage: null,
      toStage: null,
    });
    expect(expired?.wake.to).toBe("evaluator");
    // Marked already: not told twice.
    expect(expireWait(expired!.card, late, AT)).toBeNull();
  });

  it("uses the wait's own deadline, and never expires a time wait", () => {
    const own = card(7, { wait: wait({ until: "2026-11-10T11:00:00.000Z" as never }) });
    expect(waitExpired(own, NOW)).toBe(true);
    const time = card(7, {
      wait: wait({ on: "time", pr: null, until: "2026-12-01T00:00:00.000Z" as never }),
    });
    expect(waitExpired(time, NOW + 15 * 24 * 60 * 60 * 1000)).toBe(false);
  });
});

describe("what a waiting card means for the engine", () => {
  const waiting = card(3, { wait: wait() });

  it("is not dispatched or nudged, and is not idle until it expires", () => {
    expect(waitHoldsDispatch(waiting)).toBe(true);
    expect(waitSkipsNudge(waiting)).toBe(true);
    expect(waitHidesIdle(waiting, NOW)).toBe(true);
    expect(waitHidesIdle(waiting, Date.parse(SET_AT) + KANBAN_WAIT_LIMIT_MS.push!)).toBe(false);
    expect(waitHoldsDispatch(card(3))).toBe(false);
  });

  it("stops applying once a thread has the card or someone moved it", () => {
    const started = { ...waiting, activeThreadId: "thread-1" as never };
    expect(waitHoldsDispatch(started)).toBe(false);
    expect(waitSkipsNudge(started)).toBe(false);
    const moved = { ...waiting, movedAt: "2026-11-10T11:00:00.000Z" as never };
    expect(waitHoldsDispatch(moved)).toBe(false);
  });

  it("holds no pool slot", () => {
    expect(waitSlotProblem(waiting)).toBeNull();
    expect(poolThreads([waiting]).size).toBe(0);
    expect(
      waitSlotProblem({ ...waiting, activeThreadId: "thread-1" as never, activePool: "p" }),
    ).toBe("card #3 has a wait and a running thread");
    expect(waitSlotProblem({ ...waiting, activePool: "opencode/opus" })).toBe(
      "card #3 has a wait and holds a pool slot",
    );
  });
});

describe("nextActor", () => {
  it("names who acts next in each stage", () => {
    expect(nextActor(card(1, { stage: "todo" }), ctx)).toBe("work");
    expect(nextActor(card(1, { stage: "todo", subtasks: [subtask("evaluator")] }), ctx)).toBe(
      "evaluator",
    );
    expect(nextActor(card(1, { stage: "needs_review" }), ctx)).toBe("review");
    expect(nextActor(card(1, { stage: "in_review", reviewStep: 0 }), ctx)).toBe("review");
    expect(nextActor(card(1, { stage: "in_review", reviewStep: 1 }), ctx)).toBe("evaluator");
    expect(nextActor(card(1, { stage: "completed" }), ctx)).toBe("evaluator");
  });
});

describe("endWait", () => {
  const pushed = {
    over: true,
    outcome: "met",
    reason: "The author pushed 2 commits to trading-core#512 (head ffee001)",
  } as const;

  it("clears the wait and tells the evaluator when the review had passed", () => {
    const waiting = card(9, { wait: wait(), wakeNote: null });
    const end = endWait(waiting, pushed, facts(), ctx, AT);
    expect("wait" in end.card).toBe(false);
    expect(end.card.stage).toBe("in_review");
    expect(end.card.updatedAt).toBe(AT);
    expect(end.event).toEqual({
      kind: "wait_cleared",
      body: pushed.reason,
      fromStage: null,
      toStage: null,
    });
    expect(end.wake.to).toBe("evaluator");
    expect(end.wake.to === "evaluator" && end.wake.text).toContain(
      "Card #9 (Card 9, in in_review) is no longer waiting: The author pushed 2 commits",
    );
    expect(end.wake.to === "evaluator" && end.wake.text).toContain(
      'It was waiting on the author to push to trading-core#512 ("Pavan to push the F1-F3 fixes").',
    );
  });

  it("sends an open review back to Needs Review from step 0 after a push", () => {
    const waiting = card(9, { reviewStep: 1, wait: wait(), wakeNote: "Earlier note" });
    const end = endWait(waiting, pushed, facts(), { chainLength: 3 }, AT);
    expect(end.card.stage).toBe("needs_review");
    expect(end.card.reviewStep).toBe(0);
    expect(end.card.movedAt).toBe(AT);
    expect(end.card.wakeNote).toContain("Earlier note\n\nThe author pushed 2 commits");
    expect(end.event).toMatchObject({ fromStage: "in_review", toStage: "needs_review" });
    expect(end.wake.to).toBe("review");
  });

  it("wakes the worker in To-Do with the reason as the wake note when asked to", () => {
    const waiting = card(9, { wait: wait({ wakeRole: "work" }) });
    const end = endWait(waiting, pushed, facts(), ctx, AT);
    expect(end.card.stage).toBe("todo");
    expect(end.wake).toEqual({ to: "work", note: end.card.wakeNote });
    expect(end.card.wakeNote).toContain("Carry on with card #9.");
  });

  it("falls back to the evaluator when the asked role has nothing to go back to", () => {
    const done = card(9, { stage: "completed", wait: wait({ wakeRole: "review" }) });
    expect(endWait(done, pushed, facts(), ctx, AT).wake.to).toBe("evaluator");
    expect(endWait(done, pushed, facts(), ctx, AT).card.stage).toBe("completed");
  });

  it("wakes nobody for an owner's answer, which already went to whoever asked", () => {
    const waiting = card(9, { wait: wait({ on: "owner_go", pr: null, ask: "q1" as never }) });
    const end = endWait(
      waiting,
      { over: true, outcome: "met", reason: "Question q1 was answered or dropped" },
      facts(),
      ctx,
      AT,
    );
    expect(end.wake.to).toBe("none");
    expect("wait" in end.card).toBe(false);
  });

  it("wakes nobody when the last PR of a reviewed card merges: the board completes it", () => {
    const waiting = card(9, { wait: wait({ on: "merge", sinceHead: null }) });
    const merged = { over: true, outcome: "met", reason: "trading-core#512 merged" } as const;
    const landed = facts({ prs: [{ url: PR, state: "merged" }] });
    expect(endWait(waiting, merged, landed, ctx, AT).wake.to).toBe("none");
    // Another tracked PR is still open: the card stays, so the evaluator hears.
    const two = card(9, {
      wait: wait({ on: "merge", sinceHead: null }),
      links: [
        { kind: "pr", url: PR, label: null, state: "open", checkedAt: null },
        { kind: "pr", url: OTHER_PR, label: null, state: "open", checkedAt: null },
      ],
    });
    expect(endWait(two, merged, landed, ctx, AT).wake.to).toBe("evaluator");
  });
});

describe("resolveWait", () => {
  it("does nothing for a card with no wait or with a thread", () => {
    expect(resolveWait(card(1), facts(), ctx, AT)).toEqual({ _tag: "none" });
    expect(
      resolveWait(card(1, { wait: wait(), activeThreadId: "t" as never }), facts(), ctx, AT),
    ).toEqual({ _tag: "none" });
  });

  it("holds, ends or expires", () => {
    const waiting = card(1, { wait: wait() });
    expect(resolveWait(waiting, facts(), ctx, AT)).toEqual({ _tag: "hold" });
    const ended = resolveWait(
      waiting,
      facts({ prs: [{ url: PR, state: "open", head: "ffee00112233" }] }),
      ctx,
      AT,
    );
    expect(ended._tag).toBe("end");
    const late = facts({ nowMs: Date.parse(SET_AT) + KANBAN_WAIT_LIMIT_MS.push! });
    expect(resolveWait(waiting, late, ctx, AT)._tag).toBe("expire");
    // Ending wins over expiring.
    expect(
      resolveWait(
        waiting,
        { ...late, prs: [{ url: PR, state: "open", head: "ffee00112233" }] },
        ctx,
        AT,
      )._tag,
    ).toBe("end");
  });

  it("drops a wait left on a card someone moved, without a wake", () => {
    const moved = card(1, {
      stage: "todo",
      movedAt: "2026-11-10T11:00:00.000Z" as never,
      wait: wait(),
    });
    const step = resolveWait(moved, facts(), ctx, AT);
    expect(step._tag).toBe("end");
    if (step._tag !== "end") return;
    expect("wait" in step.card).toBe(false);
    expect(step.card.stage).toBe("todo");
    expect(step.event.body).toBe(
      "The card was moved to todo while it waited on the author to push to trading-core#512",
    );
    expect(step.wake.to).toBe("none");
  });
});

describe("checkWait", () => {
  const request = (patch: Partial<WaitRequest> = {}): WaitRequest => ({
    on: "merge",
    note: "parent PR has to land first",
    pr: PR,
    ...patch,
  });
  const reason = (
    target: KanbanCard,
    req: WaitRequest,
    actor: KanbanActor = evaluator,
    wired = false,
  ) => {
    const check = checkWait(target, req, actor, NOW, wired);
    return check.ok ? "ok" : `${check.code}: ${check.reason}`;
  };

  it("accepts a wait on a PR the card links", () => {
    expect(reason(card(1), request())).toBe("ok");
    expect(reason(card(1), request({ on: "ci" }))).toBe("ok");
    expect(reason(card(1), request({ on: "push", sinceHead: "a1b2c3d4" }))).toBe("ok");
  });

  it("refuses a PR the card doesn't link, a landed one, and a push with no commit to compare", () => {
    expect(reason(card(1), request({ pr: OTHER_PR }))).toBe(
      "invalid: card #1 has no pull request trading-core#513; it has trading-core#512",
    );
    expect(reason(card(1, { links: [] }), request())).toContain("has no pull request link");
    expect(reason(card(1), request({ pr: null }))).toBe(
      "invalid: say which pull request: trading-core#512",
    );
    const merged = card(1, {
      links: [{ kind: "pr", url: PR, label: null, state: "merged", checkedAt: SET_AT }],
    });
    expect(reason(merged, request())).toBe(
      "invalid: trading-core#512 is already merged: nothing to wait for",
    );
    expect(reason(card(1), request({ on: "push" }))).toContain("a push wait needs head");
  });

  it("refuses a running, settled, verified or foreign-flagged card", () => {
    expect(reason(card(1, { activeThreadId: "t" as never }), request())).toContain(
      "denied: card #1 has a running thread",
    );
    expect(reason(card(1, { settledAt: AT as never }), request())).toBe(
      "denied: card #1 is settled",
    );
    expect(reason(card(1, { stage: "verified" }), request())).toContain("is verified");
    const flagged = card(1, {
      stalled: { reason: "Waiting on Pavan", by: evaluator, at: SET_AT } as never,
    });
    expect(reason(flagged, request(), evaluator)).toBe("ok");
    expect(reason(flagged, request(), worker)).toContain("flagged stalled by someone else");
    expect(mayClearFlag(flagged, owner)).toBe(true);
  });

  it("refuses stages the dispatcher would start anyway, until the engine checks waits", () => {
    expect(reason(card(1, { stage: "todo" }), request())).toContain(
      "denied: card #1 is in todo, where the dispatcher would start it anyway",
    );
    expect(reason(card(1, { stage: "needs_review" }), request())).toContain("denied");
    expect(reason(card(1, { stage: "completed" }), request())).toBe("ok");
    expect(reason(card(1, { stage: "todo" }), request(), evaluator, true)).toBe("ok");
  });

  it("checks the card it waits on", () => {
    const on = (other: KanbanCard | null) => request({ on: "card", pr: null, card: other });
    expect(reason(card(1), on(card(2, { stage: "working" })))).toBe("ok");
    expect(reason(card(1), on(null))).toContain("say which card");
    expect(reason(card(1), on(card(1)))).toBe("invalid: a card can't wait on itself");
    expect(reason(card(1), on(card(2, { stage: "deployed" })))).toBe(
      "invalid: card #2 is already done: nothing to wait for",
    );
  });

  it("needs a real time for a time wait and keeps deadlines within 30 days", () => {
    const at = (until: string | null) => request({ on: "time", pr: null, until });
    expect(reason(card(1), at(null))).toBe("invalid: a time wait needs until");
    expect(reason(card(1), at("tomorrow"))).toBe("invalid: until is not a time: tomorrow");
    expect(reason(card(1), at("2026-11-10T11:00:00.000Z"))).toBe("invalid: until is in the past");
    expect(reason(card(1), at("2027-01-10T11:00:00.000Z"))).toContain("more than 30 days");
    expect(reason(card(1), at("2026-11-11T09:00:00.000Z"))).toBe("ok");
  });

  it("points owner_go at an open question, and at card_ask when there is none", () => {
    const go = (ask: string | null) => request({ on: "owner_go", pr: null, ask });
    expect(reason(card(1), go(null))).toContain("ask it first with card_ask");
    expect(reason(card(1), go("q1"))).toContain("ask the owner with card_ask first");
    const asked = card(1, {
      asks: [
        {
          id: "q1",
          text: "Merge?",
          blocking: false,
          by: evaluator,
          at: SET_AT,
          seq: null,
          closedAt: null,
        },
      ] as never,
    });
    expect(reason(asked, go("q1"))).toBe("ok");
    expect(reason(asked, go(null))).toBe("invalid: say which open question: q1");
  });

  it("needs a note", () => {
    expect(reason(card(1), request({ note: "  " }))).toContain("needs a one-line note");
  });
});

describe("helpers", () => {
  it("builds the stored wait from a checked request", () => {
    expect(
      newWait(
        { on: "push", note: " fix F1 ", pr: PR, sinceHead: " a1b2c3d4 ", card: card(2), ask: "q1" },
        evaluator,
        AT,
      ),
    ).toEqual({
      on: "push",
      pr: PR,
      card: null,
      ask: null,
      until: null,
      sinceHead: "a1b2c3d4",
      note: "fix F1",
      by: evaluator,
      at: AT,
      wakeRole: null,
      expiredAt: null,
    });
    const other = newWait({ on: "card", note: "after it", card: card(2), pr: PR }, owner, AT);
    expect(other).toMatchObject({ on: "card", card: "card-2", pr: null, sinceHead: null });
    // A time written with a zone offset is stored in UTC like every other timestamp.
    expect(
      newWait({ on: "time", note: "recheck", until: "2026-11-14T09:00:00+04:00" }, owner, AT).until,
    ).toBe("2026-11-14T05:00:00.000Z");
  });

  it("names PRs, compares short and full commits, and words the target", () => {
    expect(prName(PR)).toBe("trading-core#512");
    expect(prName("https://example.com/notes")).toBe("https://example.com/notes");
    expect(sameCommit("A1B2C3D4", "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678")).toBe(true);
    expect(sameCommit("a1b2c3d4", "a1b2c3d5")).toBe(false);
    expect(sameCommit("a1b", "a1b2c3d4")).toBe(false);
    expect(waitTarget(wait({ on: "merge" }))).toBe("trading-core#512 to merge");
    expect(waitTarget(wait({ on: "ci" }))).toBe("CI on trading-core#512");
    expect(
      waitTarget(wait({ on: "card", card: "card-5" as never }), new Map([["card-5", card(5)]])),
    ).toBe("card #5");
    expect(waitSetBody(wait({ on: "merge", note: "D4 parent" }))).toBe(
      "Waiting on trading-core#512 to merge: D4 parent",
    );
  });

  it("finds a card's PR link by URL, number or repo#number", () => {
    const two = card(1, {
      links: [
        { kind: "pr", url: PR, label: null, state: "open", checkedAt: null },
        {
          kind: "pr",
          url: "https://github.com/Equicom-Crypto/edge-api/pull/512",
          label: null,
          state: null,
          checkedAt: null,
        },
        { kind: "url", url: "https://example.com/512", label: null, state: null, checkedAt: null },
      ],
    });
    expect(findPrLink(two, PR)).toMatchObject({ url: PR });
    expect(findPrLink(two, "trading-core#512")).toMatchObject({ url: PR });
    expect(findPrLink(two, "#512")).toBe("ambiguous");
    expect(findPrLink(two, "512")).toBe("ambiguous");
    expect(findPrLink(two, "#99")).toBeNull();
    expect(findPrLink(card(1), "512")).toMatchObject({ url: PR });
  });

  it("lists the cards waiting on a card", () => {
    const cards = [
      card(1, { wait: wait({ on: "card", pr: null, card: "card-9" as never }) }),
      card(2, { wait: wait({ on: "card", pr: null, card: "card-8" as never }) }),
      card(3, { wait: wait() }),
      card(4, {
        wait: wait({ on: "card", pr: null, card: "card-9" as never }),
        activeThreadId: "t" as never,
      }),
    ];
    expect(waitersOn(cards, "card-9").map((entry) => entry.number)).toEqual([1]);
  });
});
