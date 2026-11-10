import type { KanbanActor, KanbanCard, KanbanWait } from "@t3tools/contracts";
import { KANBAN_WAIT_CHECK_FAILURES, KANBAN_WAIT_LIMIT_MS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { poolThreads } from "./rules.ts";
import type { KanbanThreadPr } from "./threads.ts";
import {
  applyAnswer,
  checkInput,
  checksSummary,
  checkWait,
  decodeAnswer,
  endWait,
  expireWait,
  findPrLink,
  mayClearFlag,
  mergePrReadings,
  newWait,
  nextActor,
  prKey,
  prName,
  readingFromDetail,
  resolveWait,
  sameCommit,
  scriptCheckEveryMs,
  scriptWaiters,
  WAIT_CHECKS,
  WAIT_SCRIPT_EVERY_MAX_MS,
  WAIT_SCRIPT_EVERY_MIN_MS,
  WAIT_SCRIPT_EVERY_MS,
  waitCheckName,
  waitEventKind,
  waitExpired,
  waitHidesIdle,
  waitHoldsDispatch,
  waitPrRequests,
  waitSatisfied,
  waitSetBody,
  waitSkipsNudge,
  waitSlotProblem,
  waitTarget,
  type WaitAnswer,
  type WaitChecker,
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
    script: null,
    args: null,
    status: null,
    lastCheckedAt: null,
    failures: 0,
    problem: null,
    ...patch,
  }) as KanbanWait;

const scriptWait = (patch: Partial<KanbanWait> = {}) =>
  wait({
    on: "script",
    pr: null,
    sinceHead: null,
    script: "linear-state" as never,
    args: { issue: "ENG-123", state: "Done" },
    note: "ENG-123 to reach Done",
    ...patch,
  });

const facts = (patch: Partial<WaitFacts> = {}): WaitFacts => ({
  nowMs: NOW,
  prs: [],
  cards: new Map(),
  ...patch,
});
const ctx = { chainLength: 1 };
const LATER = "2026-11-10T11:30:00.000Z";
const HEAD = "ffee00112233445566778899aabbccddeeff0011";
const hold: WaitAnswer = { result: "hold" };
const answer = (target: KanbanCard, known: WaitFacts = facts()) =>
  waitSatisfied(target, known, ctx);

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

describe("the board's own checks, through the check contract", () => {
  it("has no answer for a card with no wait", () => {
    expect(answer(card(1))).toBeNull();
  });

  it("push: holds on the reviewed head, ends when the head moves, with the commit count when known", () => {
    const waiting = card(1, { wait: wait() });
    expect(answer(waiting, facts({ prs: [{ url: PR, state: "open", head: "a1b2c3d4" }] }))).toEqual(
      hold,
    );
    expect(
      answer(
        waiting,
        facts({ prs: [{ url: PR, state: "open", head: "ffee0011223344", commitsSince: 3 }] }),
      ),
    ).toEqual({
      result: "wake",
      note: "The author pushed 3 commits to trading-core#512 (head ffee001)",
      to: "review",
      restart: true,
    });
    expect(
      answer(waiting, facts({ prs: [{ url: PR, state: "draft", head: "ffee0011223344" }] })),
    ).toMatchObject({
      result: "wake",
      note: "The author pushed to trading-core#512: its head moved from a1b2c3d to ffee001",
    });
  });

  it("push: an unknown head or an unread PR never ends it, and a merged or closed PR goes to the evaluator", () => {
    const waiting = card(1, { wait: wait() });
    expect(answer(waiting, facts({ prs: [{ url: PR, state: "open" }] }))).toEqual(hold);
    expect(answer(waiting, facts({ prs: [{ url: PR, state: "open", head: null }] }))).toEqual(hold);
    expect(answer(waiting, facts({ prs: [{ url: OTHER_PR, state: "merged" }] }))).toEqual(hold);
    expect(
      answer(
        card(1, { wait: wait({ sinceHead: null }) }),
        facts({ prs: [{ url: PR, state: "open", head: "ffee0011" }] }),
      ),
    ).toEqual(hold);
    expect(answer(waiting, facts({ prs: [{ url: PR, state: "merged" }] }))).toEqual({
      result: "wake",
      note: "trading-core#512 merged while this waited for a push",
      to: "evaluator",
    });
    expect(answer(waiting, facts({ prs: [{ url: PR, state: "closed" }] }))).toMatchObject({
      result: "wake",
      to: "evaluator",
    });
  });

  it("merge: ends when the PR merges, goes to the evaluator when it is closed, holds while open", () => {
    const waiting = card(1, { stage: "todo", wait: wait({ on: "merge", sinceHead: null }) });
    expect(answer(waiting, facts({ prs: [{ url: PR, state: "open" }] }))).toEqual(hold);
    expect(answer(waiting, facts({ prs: [{ url: PR, state: "merged" }] }))).toEqual({
      result: "wake",
      note: "trading-core#512 merged",
    });
    expect(answer(waiting, facts({ prs: [{ url: PR, state: "closed" }] }))).toEqual({
      result: "wake",
      note: "trading-core#512 was closed without merging",
      to: "evaluator",
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
    expect(answer(waiting, facts({ prs: [pr("pending")] }))).toEqual(hold);
    expect(answer(waiting, facts({ prs: [pr(null)] }))).toEqual(hold);
    expect(answer(waiting, facts({ prs: [pr("passing")] }))).toEqual({
      result: "wake",
      note: "CI passed on trading-core#512 at a1b2c3d",
    });
    // Failed CI goes to whoever acts next, like a pass: no `to`.
    expect(answer(waiting, facts({ prs: [pr("failing")] }))).toEqual({
      result: "wake",
      note: "CI failed on trading-core#512 at a1b2c3d",
    });
    expect(
      answer(waiting, facts({ prs: [{ url: PR, state: "merged", checks: "pending" }] })),
    ).toMatchObject({ result: "wake", to: "evaluator" });
  });

  it("card: read from the board's cards on every pass, so no completion hook is needed", () => {
    const waiting = card(1, { wait: wait({ on: "card", pr: null, card: "card-2102" as never }) });
    const other = (patch: Partial<KanbanCard>) =>
      facts({ cards: new Map([["card-2102", card(2102, patch)]]) });
    expect(answer(waiting, other({ stage: "working" }))).toEqual(hold);
    // Completed with its merge still open is not done, as for blockedBy.
    expect(
      answer(
        waiting,
        other({ stage: "completed", subtasks: [subtask("evaluator", "merge into native-v1")] }),
      ),
    ).toEqual(hold);
    expect(answer(waiting, other({ stage: "completed" }))).toEqual({
      result: "wake",
      note: "Card #2102 is done",
    });
    expect(answer(waiting, other({ stage: "deployed" }))).toMatchObject({ result: "wake" });
    expect(answer(waiting, other({ stage: "todo", settledAt: AT as never }))).toMatchObject({
      result: "wake",
      note: "Card #2102 is done",
    });
    // Deleted: nothing will ever finish it, so the evaluator decides.
    expect(answer(waiting, facts())).toEqual({
      result: "wake",
      note: "The card it waited on is gone",
      to: "evaluator",
    });
  });

  it("card: the pass that sees the other card finish ends the wait and wakes the next actor", () => {
    const waiting = card(1, {
      stage: "todo",
      wait: wait({ on: "card", pr: null, card: "card-2" as never, note: "needs #2's schema" }),
    });
    const before = facts({ cards: new Map([["card-2", card(2, { stage: "in_review" })]]) });
    expect(resolveWait(waiting, before, ctx, AT)).toEqual({ _tag: "hold", save: null });
    const after = facts({ cards: new Map([["card-2", card(2, { stage: "completed" })]]) });
    const step = resolveWait(waiting, after, ctx, AT);
    expect(step).toMatchObject({ _tag: "end", wake: { to: "work" } });
    expect(step._tag === "end" && step.card.wakeNote).toContain(
      'Card #2 is done. It was waiting on card #2 ("needs #2\'s schema").',
    );
  });

  it("time: ends once the time has passed", () => {
    const at = (until: string) =>
      card(1, { wait: wait({ on: "time", pr: null, until: until as never }) });
    expect(answer(at("2026-11-10T12:00:01.000Z"))).toEqual(hold);
    expect(answer(at("2026-11-10T12:00:00.000Z"))).toEqual({
      result: "wake",
      note: "The time you set has passed",
    });
  });

  it("owner_go: ends when the question is closed or gone, and wakes nobody unless asked to", () => {
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
    const waiting = (asks: KanbanCard["asks"], wakeRole: KanbanWait["wakeRole"] = null) =>
      card(1, { asks, wait: wait({ on: "owner_go", pr: null, ask: "q1" as never, wakeRole }) });
    expect(answer(waiting([ask(null)]))).toEqual(hold);
    expect(answer(waiting([ask(AT)]))).toEqual({
      result: "wake",
      note: "Question q1 was answered or dropped",
      to: "none",
    });
    expect(answer(waiting([ask(AT)], "evaluator"))).toMatchObject({ to: "evaluator" });
    expect(answer(waiting([]))).toMatchObject({ result: "wake", to: "none" });
  });

  it("registers each built-in under its name and nothing else", () => {
    expect([...WAIT_CHECKS.keys()].toSorted()).toEqual(
      ["card", "ci", "merge", "owner_go", "push", "time"].toSorted(),
    );
  });
});

describe("PR readings from the reader and the work thread", () => {
  it("takes the board's thread PR readings as they are", () => {
    // What threads.view(...).prs returns: the tick passes it straight in.
    const prs: ReadonlyArray<KanbanThreadPr> = [
      { url: PR, title: "Fix", state: "open", head: "ffee00112233", checks: "passing", at: LATER },
    ];
    expect(answer(card(1, { wait: wait() }), facts({ prs }))).toMatchObject({ result: "wake" });
    expect(answer(card(1, { wait: wait({ on: "ci" }) }), facts({ prs }))).toMatchObject({
      result: "wake",
    });
    const untracked: ReadonlyArray<KanbanThreadPr> = [{ url: PR, title: null, state: "open" }];
    expect(answer(card(1, { wait: wait() }), facts({ prs: untracked }))).toEqual(hold);
  });

  it("an outside author's push wakes the reviewer, from the first review step", () => {
    // No work thread watches this PR: the only reading is the reader's.
    const waiting = card(1, { reviewStep: 2, wait: wait() });
    const step = resolveWait(
      waiting,
      facts({ prs: [{ url: PR, state: "open", head: HEAD, at: LATER }] }),
      { chainLength: 2 },
      AT,
    );
    expect(step).toMatchObject({
      _tag: "end",
      card: { stage: "needs_review", reviewStep: 0, reviewRound: 0 },
      event: { fromStage: "in_review", toStage: "needs_review" },
      wake: { to: "review" },
    });
    expect(step._tag === "end" && step.card.wakeNote).toContain(
      "The author pushed to trading-core#512: its head moved from a1b2c3d to ffee001",
    );
  });

  it("a parent PR merging ends a merge wait and wakes the worker", () => {
    const waiting = card(1, {
      stage: "todo",
      links: [{ kind: "pr", url: OTHER_PR, label: "parent", state: null, checkedAt: null }],
      wait: wait({ on: "merge", pr: OTHER_PR as never, sinceHead: null, note: "D4 parent" }),
    });
    const step = resolveWait(
      waiting,
      facts({ prs: [{ url: OTHER_PR, state: "merged", at: LATER }] }),
      ctx,
      AT,
    );
    expect(step).toMatchObject({ _tag: "end", card: { stage: "todo" }, wake: { to: "work" } });
    expect(step._tag === "end" && step.event.body).toBe("trading-core#513 merged");
  });

  it("a PR closed without merging ends the wait and tells the evaluator why", () => {
    const waiting = card(1, { wait: wait({ on: "merge", sinceHead: null, note: "D4 parent" }) });
    const step = resolveWait(
      waiting,
      facts({ prs: [{ url: PR, state: "closed", at: LATER }] }),
      ctx,
      AT,
    );
    expect(step._tag).toBe("end");
    if (step._tag !== "end") return;
    expect("wait" in step.card).toBe(false);
    expect(step.card.stage).toBe("in_review");
    expect(step.wake.to).toBe("evaluator");
    expect(step.wake.to === "evaluator" && step.wake.text).toContain(
      'is no longer waiting: trading-core#512 was closed without merging. It was waiting on trading-core#512 to merge ("D4 parent").',
    );
    // The same for a push wait, even one that asked to wake the worker.
    const push = resolveWait(
      card(1, { wait: wait({ wakeRole: "work" }) }),
      facts({ prs: [{ url: PR, state: "closed", at: LATER }] }),
      ctx,
      AT,
    );
    expect(push).toMatchObject({ _tag: "end", wake: { to: "evaluator" } });
  });

  it("a closed PR under a To-Do card's wait tells the evaluator and leaves the worker a note", () => {
    const waiting = card(1, {
      stage: "todo",
      wait: wait({ on: "merge", sinceHead: null, note: "D4 parent" }),
    });
    const step = resolveWait(waiting, facts({ prs: [{ url: PR, state: "closed" }] }), ctx, AT);
    expect(step).toMatchObject({ _tag: "end", card: { stage: "todo" }, wake: { to: "evaluator" } });
    expect(step._tag === "end" && step.card.wakeNote).toContain(
      "trading-core#512 was closed without merging",
    );
    expect(step._tag === "end" && step.wake.to === "evaluator" && step.wake.text).toContain(
      "The dispatcher will start its worker again",
    );
  });

  it("an unknown reading holds: a PR nobody could read is not done", () => {
    const merge = card(1, {
      links: [{ kind: "pr", url: PR, label: null, state: null, checkedAt: null }],
      wait: wait({ on: "merge", sinceHead: null }),
    });
    expect(resolveWait(merge, facts(), ctx, AT)).toEqual({ _tag: "hold", save: null });
    expect(resolveWait(card(1, { wait: wait() }), facts(), ctx, AT)).toEqual({
      _tag: "hold",
      save: null,
    });
  });

  it("ignores a reading older than the wait, except that merged stays merged", () => {
    const before = "2026-11-10T09:00:00.000Z";
    const waiting = card(1, { wait: wait() });
    // A cached head from before the review would look like a push.
    expect(
      answer(waiting, facts({ prs: [{ url: PR, state: "open", head: HEAD, at: before }] })),
    ).toEqual(hold);
    expect(answer(waiting, facts({ prs: [{ url: PR, state: "closed", at: before }] }))).toEqual(
      hold,
    );
    expect(
      answer(waiting, facts({ prs: [{ url: PR, state: "open", head: HEAD, at: LATER }] })),
    ).toMatchObject({ result: "wake" });
    // A fresh state with a head carried over from an old reading: the head is not evidence.
    expect(
      answer(
        waiting,
        facts({ prs: [{ url: PR, state: "open", head: HEAD, at: LATER, headAt: before }] }),
      ),
    ).toEqual(hold);
    expect(
      answer(
        card(1, { wait: wait({ on: "merge", sinceHead: null }) }),
        facts({ prs: [{ url: PR, state: "merged", at: before }] }),
      ),
    ).toMatchObject({ result: "wake", note: "trading-core#512 merged" });
  });

  it("merges readings by pull request, however the URL was written", () => {
    expect(prKey(`${PR}/files`)).toBe(prKey(PR));
    expect(prKey(`${PR}/`)).toBe("github.com/equicom-crypto/trading-core#512");
    expect(prKey("https://example.com/notes")).toBe("https://example.com/notes");
    // The thread has the fresher state but no head; the reader's head comes along with its own time.
    const thread = { url: `${PR}/files`, state: "open" as const, at: LATER };
    const reader = {
      url: PR,
      state: "draft" as const,
      head: HEAD,
      checks: "passing" as const,
      at: "2026-11-10T11:00:00.000Z",
    };
    expect(mergePrReadings([thread], [reader])).toEqual([
      { ...thread, head: HEAD, headAt: "2026-11-10T11:00:00.000Z" },
    ]);
    // The fresher reading wins whole when it has a head of its own.
    const live = { url: PR, state: "open" as const, head: "0000aaaa", at: LATER };
    expect(mergePrReadings([reader], [live])).toEqual([live]);
    // An undated reading is older than any dated one.
    expect(mergePrReadings([{ url: PR, state: "merged" }], [live])).toEqual([live]);
    expect(mergePrReadings([live], [{ url: OTHER_PR, state: "open" }])).toHaveLength(2);
    // A wait whose URL is written differently from the reading still matches.
    expect(
      answer(
        card(1, { wait: wait({ pr: `${PR}/files` as never }) }),
        facts({ prs: [{ url: PR, state: "open", head: HEAD, at: LATER }] }),
      ),
    ).toMatchObject({ result: "wake" });
  });

  it("falls back to the state on the card's own link when nothing else was read", () => {
    const landed = card(1, {
      stage: "todo",
      links: [{ kind: "pr", url: PR, label: null, state: "merged", checkedAt: LATER as never }],
      wait: wait({ on: "merge", sinceHead: null }),
    });
    expect(answer(landed)).toMatchObject({ result: "wake", note: "trading-core#512 merged" });
    // A reading from the pass wins over the link, even an undated one.
    expect(answer(landed, facts({ prs: [{ url: PR, state: "open" }] }))).toEqual(hold);
  });

  it("sums up a PR's checks the way the PR watch does", () => {
    const check = (status: string, required?: boolean) => ({ status, required }) as never;
    expect(checksSummary([])).toBeNull();
    expect(checksSummary([check("success"), check("skipped"), check("neutral")])).toBe("passing");
    expect(checksSummary([check("success"), check("pending")])).toBe("pending");
    expect(checksSummary([check("success"), check("failure")])).toBe("failing");
    expect(checksSummary([check("cancelled"), check("pending")])).toBe("failing");
    expect(checksSummary([check("action-required")])).toBe("failing");
    // Required checks decide when any are marked; an optional one still running doesn't hold it.
    expect(checksSummary([check("success", true), check("pending", false)])).toBe("passing");
    expect(checksSummary([check("pending", true), check("success", false)])).toBe("pending");
  });

  it("turns a host's answer into a dated reading", () => {
    const detail = {
      state: "open",
      isDraft: true,
      headSha: HEAD,
      checks: [{ status: "success" }],
      observedAt: Date.parse(LATER),
    } as never;
    expect(readingFromDetail(PR, detail, NOW)).toEqual({
      url: PR,
      state: "draft",
      at: LATER,
      head: HEAD,
      checks: "passing",
    });
    expect(
      readingFromDetail(PR, { state: "merged", isDraft: false, checks: [] } as never, NOW),
    ).toEqual({ url: PR, state: "merged", at: AT, head: null, checks: null });
  });

  it("asks for each pull request once, however many cards wait on it", () => {
    const board = { defaultProjectId: "project-default" as never };
    const live = [{ url: PR, state: "open" as const, at: LATER }];
    const requests = waitPrRequests(
      [
        card(1, { wait: wait({ on: "merge", sinceHead: null }) }),
        card(2, { projectId: "project-two" as never, wait: wait({ pr: `${PR}/files` as never }) }),
        card(3, { wait: wait({ on: "ci", pr: OTHER_PR as never, sinceHead: null }) }),
        card(4, { wait: wait({ on: "time", pr: null }) }),
        card(5, { wait: wait(), activeThreadId: "t" as never }),
        card(6),
      ],
      board,
      live,
    );
    expect(requests).toEqual([
      { url: PR, projectId: "project-default", needsHead: true, live: live[0] },
      { url: OTHER_PR, projectId: "project-default", needsHead: false, live: null },
    ]);
    // A script's check is given every PR its card links, so those are read too, in full.
    const linked = card(7, {
      links: [
        { kind: "pr", url: OTHER_PR, label: null, state: null, checkedAt: null },
        { kind: "url", url: "https://example.com/spec", label: null, state: null, checkedAt: null },
      ],
      wait: scriptWait(),
    });
    expect(waitPrRequests([linked], board)).toEqual([
      { url: OTHER_PR, projectId: "project-default", needsHead: true, live: null },
    ]);
  });
});

describe("the check contract", () => {
  it("gives a check the wait, the card and the facts as plain JSON", () => {
    const waiting = card(12, {
      title: "Ship the exporter",
      blockedBy: ["card-3" as never],
      asks: [
        {
          id: "q1",
          text: "Go?",
          blocking: false,
          by: evaluator,
          at: SET_AT,
          seq: null,
          closedAt: AT,
        },
      ] as never,
      wait: scriptWait(),
    });
    const input = checkInput(
      waiting,
      facts({
        prs: [
          { url: PR, state: "open", head: HEAD, checks: "pending", at: LATER },
          { url: OTHER_PR, state: "merged" },
        ],
        cards: new Map([
          ["card-3", card(3, { stage: "completed" })],
          ["card-4", card(4)],
        ]),
      }),
      ctx,
    );
    expect(input).toEqual({
      wait: waiting.wait,
      card: {
        id: "card-12",
        number: 12,
        title: "Ship the exporter",
        stage: "in_review",
        links: [{ kind: "pr", url: PR, label: null, state: "open" }],
        blockedBy: ["card-3"],
        next: "evaluator",
      },
      facts: {
        now: AT,
        // Only the PRs the wait or the card points at.
        prs: [{ url: PR, state: "open", head: HEAD, checks: "pending", at: LATER }],
        cards: [{ id: "card-3", number: 3, stage: "completed", done: true }],
        asks: [{ id: "q1", open: false }],
      },
      args: { issue: "ENG-123", state: "Done" },
    });
    // It is JSON all the way down: a script reads exactly this.
    expect(JSON.parse(JSON.stringify(input))).toEqual(input);
    expect(checkInput(card(1), facts(), ctx)).toBeNull();
  });

  it("reads an answer from outside, and treats anything unreadable as a failed check", () => {
    expect(decodeAnswer({ result: "hold", status: "CI 3 of 5 passed" })).toEqual({
      result: "hold",
      status: "CI 3 of 5 passed",
    });
    expect(decodeAnswer({ result: "wake", to: "review", note: "Ready" })).toEqual({
      result: "wake",
      to: "review",
      note: "Ready",
    });
    expect(decodeAnswer({ result: "fail", reason: "Linear said 401" })).toEqual({
      result: "fail",
      reason: "Linear said 401",
    });
    const unreadable = { result: "fail", reason: "The check's answer could not be read" };
    expect(decodeAnswer({ result: "wake" })).toEqual(unreadable);
    expect(decodeAnswer({ result: "wake", to: "owner", note: "x" })).toEqual(unreadable);
    expect(decodeAnswer({ result: "done" })).toEqual(unreadable);
    expect(decodeAnswer("wake")).toEqual(unreadable);
    expect(decodeAnswer(null)).toEqual(unreadable);
  });

  it("resolves every wait the same way: look the check up by name, give it the input, apply the answer", () => {
    const waiting = card(5, { wait: scriptWait() });
    const seen: Array<unknown> = [];
    const checks = (check: WaitChecker) =>
      new Map<string, WaitChecker>([
        [
          "script:linear-state",
          (input) => {
            seen.push(input.args);
            return check(input);
          },
        ],
      ]);
    expect(
      resolveWait(
        waiting,
        facts(),
        ctx,
        AT,
        checks(() => hold),
      ),
    ).toEqual({
      _tag: "hold",
      save: null,
    });
    expect(seen).toEqual([{ issue: "ENG-123", state: "Done" }]);
    expect(
      resolveWait(
        waiting,
        facts(),
        ctx,
        AT,
        checks(() => ({ result: "wake", to: "work", note: "ENG-123 is Done" })),
      ),
    ).toMatchObject({ _tag: "end", card: { stage: "todo" }, wake: { to: "work" } });
    // Malformed, or a check that throws: the card holds and the problem is recorded.
    const garbled = resolveWait(
      waiting,
      facts(),
      ctx,
      AT,
      checks(() => ({ ok: true }) as never),
    );
    expect(garbled).toMatchObject({
      _tag: "hold",
      save: { wait: { failures: 1, problem: "The check's answer could not be read" } },
    });
    const thrown = resolveWait(
      waiting,
      facts(),
      ctx,
      AT,
      checks(() => {
        throw new Error("boom");
      }),
    );
    expect(thrown).toMatchObject({
      _tag: "hold",
      save: { wait: { failures: 1, problem: "The check threw: Error: boom" } },
    });
  });

  it("keeps the built-in names reserved: a board script can't stand in for one", () => {
    expect(waitCheckName(wait({ on: "merge" }))).toBe("merge");
    // A board script that happens to be called "merge" is only ever reached as a script wait.
    expect(waitCheckName(scriptWait({ script: "merge" as never }))).toBe("script:merge");
    expect(WAIT_CHECKS.has("script:merge")).toBe(false);
    const builtIn = card(1, { stage: "todo", wait: wait({ on: "merge", sinceHead: null }) });
    const decoy = new Map<string, WaitChecker>([
      ...WAIT_CHECKS,
      ["script:merge", () => ({ result: "wake", note: "the script says so" })],
    ]);
    // The merge wait still asks the board's own check, which holds on an open PR.
    expect(resolveWait(builtIn, facts(), ctx, AT, decoy)).toEqual({ _tag: "hold", save: null });
    // A script wait is not answered in-process at all: the script pass does that.
    expect(resolveWait(card(2, { wait: scriptWait() }), facts(), ctx, AT)).toEqual({
      _tag: "hold",
      save: null,
    });
  });
});

describe("applyAnswer", () => {
  const waiting = card(5, { wait: scriptWait() });
  const known = facts();

  it("does nothing for a card that isn't waiting", () => {
    expect(applyAnswer(card(1), hold, known, ctx, AT)).toEqual({ _tag: "none" });
    expect(
      applyAnswer(
        { ...waiting, activeThreadId: "t" as never },
        { result: "wake", note: "x" },
        known,
        ctx,
        AT,
      ),
    ).toEqual({ _tag: "none" });
  });

  it("hold: saves a new status line, and nothing when nothing changed", () => {
    expect(applyAnswer(waiting, hold, known, ctx, AT)).toEqual({ _tag: "hold", save: null });
    const step = applyAnswer(
      waiting,
      { result: "hold", status: "  In Review\n(2 of 3 approvals) " },
      known,
      ctx,
      AT,
    );
    expect(step).toMatchObject({
      _tag: "hold",
      save: { wait: { status: "In Review (2 of 3 approvals)", lastCheckedAt: AT, failures: 0 } },
    });
    const again = step._tag === "hold" ? step.save! : waiting;
    expect(
      applyAnswer(
        again,
        { result: "hold", status: "In Review (2 of 3 approvals)" },
        known,
        ctx,
        AT,
      ),
    ).toEqual({ _tag: "hold", save: null });
    // A caller that checks rarely stamps the time even when nothing changed.
    expect(applyAnswer(waiting, hold, known, ctx, AT, { stamp: true })).toMatchObject({
      _tag: "hold",
      save: { wait: { lastCheckedAt: AT, status: null } },
    });
  });

  it("wake: ends the wait and wakes who the answer names, else the wait's role, else the next actor", () => {
    const to = (target: KanbanCard, wake: Partial<Extract<WaitAnswer, { result: "wake" }>>) => {
      const step = applyAnswer(
        target,
        { result: "wake", note: "ENG-123 is Done.", ...wake },
        known,
        ctx,
        AT,
      );
      return step._tag === "end" ? step.wake.to : step._tag;
    };
    expect(to(waiting, { to: "work" })).toBe("work");
    expect(to(waiting, { to: "review" })).toBe("review");
    expect(to(waiting, { to: "none" })).toBe("none");
    expect(to(waiting, {})).toBe("evaluator");
    expect(to(card(5, { stage: "todo", wait: scriptWait() }), {})).toBe("work");
    expect(to(card(5, { wait: scriptWait({ wakeRole: "work" }) }), {})).toBe("work");
    expect(to(card(5, { wait: scriptWait({ wakeRole: "work" }) }), { to: "review" })).toBe(
      "review",
    );
    // A role with nothing to go back to falls to the evaluator.
    expect(to(card(5, { stage: "completed", wait: scriptWait() }), { to: "review" })).toBe(
      "evaluator",
    );
    const step = applyAnswer(
      waiting,
      { result: "wake", to: "work", note: "ENG-123 is Done." },
      known,
      ctx,
      AT,
    );
    expect(step._tag === "end" && step.card.wakeNote).toBe(
      'ENG-123 is Done. It was waiting on the linear-state script\'s check ("ENG-123 to reach Done"). Carry on with card #5.',
    );
    expect(step._tag === "end" && "wait" in step.card).toBe(false);
  });

  it("wake: a reviewer resumes its step unless the answer restarts the review", () => {
    const mid = card(5, { stage: "in_review", reviewStep: 1, wait: scriptWait() });
    const resumed = applyAnswer(
      mid,
      { result: "wake", to: "review", note: "Ready" },
      known,
      { chainLength: 3 },
      AT,
    );
    expect(resumed).toMatchObject({ _tag: "end", card: { stage: "needs_review", reviewStep: 1 } });
    const restarted = applyAnswer(
      mid,
      { result: "wake", to: "review", note: "Ready", restart: true },
      known,
      { chainLength: 3 },
      AT,
    );
    expect(restarted).toMatchObject({ _tag: "end", card: { reviewStep: 0 } });
  });

  it("fail: never wakes and never drops the wait; the third in a row tells the evaluator", () => {
    const failed = (target: KanbanCard) =>
      applyAnswer(target, { result: "fail", reason: "Linear said 401" }, known, ctx, AT);
    const first = failed(waiting);
    expect(first).toMatchObject({
      _tag: "hold",
      save: {
        stage: "in_review",
        wait: { failures: 1, problem: "Linear said 401", lastCheckedAt: AT },
      },
    });
    const second = failed(first._tag === "hold" ? first.save! : waiting);
    expect(second).toMatchObject({ _tag: "hold", save: { wait: { failures: 2 } } });
    const third = failed(second._tag === "hold" ? second.save! : waiting);
    expect(third._tag).toBe("failing");
    if (third._tag !== "failing") return;
    expect(third.card.wait).toMatchObject({ failures: KANBAN_WAIT_CHECK_FAILURES, on: "script" });
    expect(third.event.body).toBe(
      "The check for the linear-state script's check failed 3 times in a row: Linear said 401",
    );
    expect(third.wake.to).toBe("evaluator");
    expect(waitHidesIdle(third.card, NOW)).toBe(false);
    // Told once: the fourth failure only counts.
    expect(failed(third.card)).toMatchObject({ _tag: "hold", save: { wait: { failures: 4 } } });
    // One good answer clears the count and the problem.
    expect(applyAnswer(third.card, hold, known, ctx, AT)).toMatchObject({
      _tag: "hold",
      save: { wait: { failures: 0, problem: null } },
    });
  });

  it("still expires a wait whose check holds or fails", () => {
    const late = facts({ nowMs: Date.parse(SET_AT) + KANBAN_WAIT_LIMIT_MS.script! });
    expect(applyAnswer(waiting, hold, late, ctx, AT)._tag).toBe("expire");
    expect(applyAnswer(waiting, { result: "fail", reason: "x" }, late, ctx, AT)).toMatchObject({
      _tag: "expire",
      card: { wait: { failures: 1 } },
    });
    // Ending wins over expiring.
    expect(applyAnswer(waiting, { result: "wake", note: "done" }, late, ctx, AT)._tag).toBe("end");
  });
});

describe("wait events", () => {
  it("are written as plain edits until the engine is live, and under their own kinds after", () => {
    // An installed client that doesn't know the wait kinds can't load a card whose history has one.
    expect(waitEventKind("wait_set", false)).toBe("edited");
    expect(waitEventKind("wait_cleared", false)).toBe("edited");
    expect(waitEventKind("wait_expired", false)).toBe("edited");
    expect(waitEventKind("wait_set", true)).toBe("wait_set");
    expect(waitEventKind("wait_cleared", true)).toBe("wait_cleared");
    expect(waitEventKind("wait_expired", true)).toBe("wait_expired");
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
      kind: waitEventKind("wait_expired"),
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
    result: "wake",
    note: "The author pushed 2 commits to trading-core#512 (head ffee001)",
  } as const;
  const restart = { ...pushed, to: "review", restart: true } as const;

  it("clears the wait and tells the evaluator when the review had passed", () => {
    const waiting = card(9, { wait: wait(), wakeNote: null });
    const end = endWait(waiting, pushed, facts(), ctx, AT);
    expect("wait" in end.card).toBe(false);
    expect(end.card.stage).toBe("in_review");
    expect(end.card.updatedAt).toBe(AT);
    expect(end.event).toEqual({
      kind: waitEventKind("wait_cleared"),
      body: pushed.note,
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
    const end = endWait(waiting, restart, facts(), { chainLength: 3 }, AT);
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

  it("wakes nobody when the answer says so, and still clears the wait", () => {
    const waiting = card(9, { wait: wait({ on: "owner_go", pr: null, ask: "q1" as never }) });
    const end = endWait(
      waiting,
      { result: "wake", to: "none", note: "Question q1 was answered or dropped" },
      facts(),
      ctx,
      AT,
    );
    expect(end.wake).toEqual({ to: "none", why: "Question q1 was answered or dropped" });
    expect("wait" in end.card).toBe(false);
  });

  it("wakes nobody when the last PR of a reviewed card merges: the board completes it", () => {
    const waiting = card(9, { wait: wait({ on: "merge", sinceHead: null }) });
    const landed = facts({ prs: [{ url: PR, state: "merged" }] });
    expect(resolveWait(waiting, landed, ctx, AT)).toMatchObject({
      _tag: "end",
      wake: { to: "none" },
    });
    // Another tracked PR is still open: the card stays, so the evaluator hears.
    const two = card(9, {
      wait: wait({ on: "merge", sinceHead: null }),
      links: [
        { kind: "pr", url: PR, label: null, state: "open", checkedAt: null },
        { kind: "pr", url: OTHER_PR, label: null, state: "open", checkedAt: null },
      ],
    });
    expect(resolveWait(two, landed, ctx, AT)).toMatchObject({
      _tag: "end",
      wake: { to: "evaluator" },
    });
    // A review still open: the reviewer carries on.
    const open = card(9, { reviewStep: 0, wait: wait({ on: "merge", sinceHead: null }) });
    expect(resolveWait(open, landed, ctx, AT)).toMatchObject({
      _tag: "end",
      wake: { to: "review" },
    });
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
    expect(resolveWait(waiting, facts(), ctx, AT)).toEqual({ _tag: "hold", save: null });
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

  it("points a script wait at one enabled script on the board, with small args", () => {
    const on = (
      found: ReadonlyArray<{ name: string; enabled: boolean }>,
      args?: Record<string, unknown>,
    ) => request({ on: "script", pr: null, script: { name: "linear-state", found }, args });
    const enabled = [{ name: "linear-state", enabled: true }];
    expect(reason(card(1), on(enabled, { issue: "ENG-1", everyMs: 120_000 }))).toBe("ok");
    expect(reason(card(1), on([]))).toBe("invalid: this board has no script named linear-state");
    expect(reason(card(1), on([{ name: "linear-state", enabled: false }]))).toBe(
      "invalid: the linear-state script is turned off",
    );
    expect(reason(card(1), on([...enabled, ...enabled]))).toContain("2 scripts named linear-state");
    expect(reason(card(1), request({ on: "script", pr: null }))).toContain(
      "a script wait names the board script that checks it",
    );
    expect(reason(card(1), on(enabled, { blob: "x".repeat(2100) }))).toContain("args is too big");
    expect(reason(card(1), on(enabled, { everyMs: "often" }))).toContain("args.everyMs");
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
      script: null,
      args: null,
      status: null,
      lastCheckedAt: null,
      failures: 0,
      problem: null,
    });
    expect(
      newWait(
        {
          on: "script",
          note: "ENG-1 to reach Done",
          pr: PR,
          script: { name: "linear-state", found: [{ name: "linear-state", enabled: true }] },
          args: { issue: "ENG-1" },
        },
        evaluator,
        AT,
      ),
    ).toMatchObject({ on: "script", script: "linear-state", args: { issue: "ENG-1" }, pr: null });
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

  it("lists the cards a script checks, and how often it checks them", () => {
    const cards = [
      card(1, { wait: scriptWait() }),
      card(2, { wait: scriptWait({ script: "deploy-landed" as never }) }),
      card(3, { wait: wait() }),
      card(4, { wait: scriptWait(), activeThreadId: "t" as never }),
      card(5, { wait: scriptWait({ args: { everyMs: 15 * 60_000 } }) }),
    ];
    expect(scriptWaiters(cards, { name: "linear-state" }).map((entry) => entry.number)).toEqual([
      1, 5,
    ]);
    expect(scriptCheckEveryMs([cards[0]!])).toBe(WAIT_SCRIPT_EVERY_MS);
    // The shortest any of its waits asks for, within the bounds.
    expect(scriptCheckEveryMs([cards[0]!, cards[4]!])).toBe(15 * 60_000);
    expect(scriptCheckEveryMs([card(6, { wait: scriptWait({ args: { everyMs: 5 } }) })])).toBe(
      WAIT_SCRIPT_EVERY_MIN_MS,
    );
    expect(scriptCheckEveryMs([card(6, { wait: scriptWait({ args: { everyMs: 9e12 } }) })])).toBe(
      WAIT_SCRIPT_EVERY_MAX_MS,
    );
    expect(waitTarget(scriptWait())).toBe("the linear-state script's check");
  });
});
