import type {
  KanbanBoardSnapshot,
  KanbanCard,
  KanbanCardEvent,
  KanbanThreadState,
  KanbanWait,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { boardStateFromSnapshot } from "./boardState.ts";
import { cardTruth, stuckCards } from "./cardTruth.ts";
import { guessWait } from "./waitGuess.ts";

const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const PR = "https://github.com/Equicom-Crypto/trading-core/pull/512";
const model = { instanceId: "opencode", model: "opus/claude-opus-5-5" } as never;
const evaluator = { _tag: "evaluator", threadId: "thread-eval" } as never;

function card(number: number, patch: Partial<KanbanCard> = {}): KanbanCard {
  return {
    id: `card-${number}`,
    boardId: "board-toy",
    number,
    title: `Card ${number}`,
    description: "",
    prompt: "",
    stage: "in_review",
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
    createdBy: { _tag: "owner" },
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-10T10:00:00.000Z",
    movedAt: "2026-11-10T09:00:00.000Z",
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
    sinceHead: "a1b2c3d4",
    note: "Pavan to push F1-F3",
    by: evaluator,
    at: "2026-11-10T10:00:00.000Z",
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

const state = (cards: KanbanCard[], threads: KanbanThreadState[] = [], board: object = {}) =>
  boardStateFromSnapshot({
    board: {
      id: "board-toy",
      name: "Toy",
      pause: null,
      setup: null,
      reviewChains: [],
      defaultReviewChain: null,
      ...board,
    },
    cards,
    goals: [],
    pools: [],
    groups: [],
    threads,
    unread: [],
  } as unknown as KanbanBoardSnapshot);

const thread = (patch: Partial<KanbanThreadState> = {}): KanbanThreadState =>
  ({
    threadId: "thread-1",
    title: "t",
    running: true,
    needsInput: false,
    lastActivityAt: "2026-11-10T11:55:00.000Z",
    ...patch,
  }) as KanbanThreadState;

const truth = (
  target: KanbanCard,
  others: KanbanCard[] = [],
  threads: KanbanThreadState[] = [],
  hints = {},
) => cardTruth(target, state([target, ...others], threads), NOW, { timeZone: "UTC", ...hints });

const subtask = (owner: "work" | "evaluator" | "script", text: string) =>
  ({
    id: "s3",
    step: 1,
    text,
    owner,
    state: "open",
    note: null,
    doneBy: null,
    doneAt: null,
  }) as never;

describe("cardTruth: To-Do", () => {
  it("is ready with nothing in the way", () => {
    expect(truth(card(1, { stage: "todo" }))).toEqual({
      state: "ready",
      label: "Ready",
      wait: null,
      derived: false,
      stuckReason: null,
    });
  });

  it("names every unfinished blocker, lowest first, and skips finished ones", () => {
    const blocked = card(1, {
      stage: "todo",
      blockedBy: ["card-14", "card-12", "card-9"] as never,
    });
    const result = truth(blocked, [
      card(14, { stage: "working" }),
      card(12, { stage: "todo" }),
      card(9, { stage: "deployed" }),
    ]);
    expect(result).toMatchObject({
      state: "blocked",
      label: "Blocked by #12, #14",
      stuckReason: null,
    });
  });

  it("shows the backlog, the setup hold and the evaluator's step", () => {
    expect(truth(card(1, { stage: "todo", priority: 5 })).label).toBe("In the backlog");
    expect(
      cardTruth(card(1, { stage: "todo" }), state([], [], { setup: { status: "running" } }), NOW)
        .label,
    ).toBe("Setup is running");
    expect(
      truth(card(1, { stage: "todo", subtasks: [subtask("evaluator", "write the packet")] })),
    ).toMatchObject({ state: "evaluator", label: "Waits on the evaluator" });
  });
});

describe("cardTruth: working", () => {
  const working = (patch: Partial<KanbanCard> = {}) =>
    card(1, {
      stage: "working",
      activeThreadId: "thread-1" as never,
      activeRole: "work",
      ...patch,
    });

  it("is running while its thread runs, or before its state has arrived", () => {
    expect(truth(working(), [], [thread()])).toMatchObject({ state: "running", label: "Running" });
    expect(truth(working(), [], [])).toMatchObject({ state: "running", stuckReason: null });
  });

  it("is retrying when the board says so, and ignores a missing counter", () => {
    expect(truth(working(), [], [thread()], { retries: 2 })).toMatchObject({
      state: "retrying",
      label: "Retrying (attempt 3)",
    });
    expect(truth({ ...working(), retries: 1 } as never, [], [thread()]).state).toBe("retrying");
    expect(truth(working(), [], [thread()], { retries: null }).state).toBe("running");
    expect(truth(working(), [], [thread()], { retries: 0 }).state).toBe("running");
  });

  it("is failed when its run failed and the card is flagged", () => {
    const failed = card(1, {
      stage: "todo",
      stalled: {
        reason: "Run failed: Provider turn failed.",
        by: { _tag: "system", component: "dispatcher" },
        at: "2026-11-10T11:00:00.000Z",
      } as never,
    });
    expect(truth(failed)).toMatchObject({
      state: "failed",
      label: "Failed",
      stuckReason: "Failed 1h: Run failed: Provider turn failed.",
    });
    expect(truth(failed, [], [], { retries: 1 })).toMatchObject({
      state: "retrying",
      stuckReason: null,
    });
  });

  it("is stuck when its thread went quiet or waits on its own question", () => {
    const quiet = truth(
      working(),
      [],
      [thread({ running: false, lastActivityAt: "2026-11-10T11:00:00.000Z" as never })],
    );
    expect(quiet).toMatchObject({ state: "idle", label: "Worker idle 1h" });
    expect(quiet.stuckReason).toBe(
      "Worker thread has been idle for 1h with the card still in Working",
    );
    const fresh = truth(working(), [], [thread({ running: false })]);
    expect(fresh).toMatchObject({ state: "idle", stuckReason: null });
    expect(truth(working(), [], [thread({ running: false, needsInput: true })]).stuckReason).toBe(
      "Worker is waiting on its own question",
    );
  });
});

describe("cardTruth: review", () => {
  it("is ready for review while it waits for a reviewer", () => {
    expect(truth(card(1, { stage: "needs_review" }))).toMatchObject({
      state: "ready",
      label: "Ready for review",
    });
  });

  it("is reviewing while a reviewer thread runs", () => {
    const reviewing = card(1, { activeThreadId: "thread-1" as never, activeRole: "review" });
    expect(truth(reviewing, [], [thread()])).toMatchObject({
      state: "reviewing",
      label: "Reviewing",
    });
    expect(
      truth(
        reviewing,
        [],
        [thread({ running: false, lastActivityAt: "2026-11-10T10:00:00.000Z" as never })],
      ),
    ).toMatchObject({ state: "idle", label: "Reviewer idle 2h" });
    // A wait left on a card a thread now runs is ignored: the thread is the truth.
    expect(truth({ ...reviewing, wait: wait() }, [], [thread()]).state).toBe("reviewing");
  });

  it("shows each wait kind from the card's wait", () => {
    const label = (patch: Partial<KanbanWait>, others: KanbanCard[] = []) =>
      truth(card(1, { wait: wait(patch) }), others);
    expect(label({})).toEqual({
      state: "waiting",
      label: "Waiting on the author (PR #512)",
      wait: {
        on: "push",
        note: "Pavan to push F1-F3",
        age: "2h",
        expired: false,
        status: null,
        checkFailing: false,
      },
      derived: false,
      stuckReason: null,
    });
    expect(label({ on: "merge" }).label).toBe("Waiting on merge (PR #512)");
    expect(label({ on: "ci" }).label).toBe("Waiting on CI (PR #512)");
    expect(label({ on: "card", pr: null, card: "card-2102" as never }, [card(2102)]).label).toBe(
      "Held for #2102",
    );
    expect(label({ on: "owner_go", pr: null, ask: "q2" as never }).label).toBe(
      "Held for the owner's go (q2)",
    );
    expect(label({ on: "time", pr: null, until: "2026-11-10T15:30:00.000Z" as never }).label).toBe(
      "Held until 15:30",
    );
    expect(label({ on: "time", pr: null, until: "2026-11-14T09:00:00.000Z" as never }).label).toBe(
      "Held until Sat 14 Nov 09:00",
    );
  });

  it("shows a script wait by its script's name, with the check's latest status", () => {
    const script = (patch: Partial<KanbanWait> = {}) =>
      truth(
        card(1, {
          wait: wait({
            on: "script",
            pr: null,
            sinceHead: null,
            script: "linear-state" as never,
            args: { issue: "ENG-123" },
            note: "ENG-123 to reach Done",
            ...patch,
          }),
        }),
      );
    expect(script({ status: "In Review" })).toEqual({
      state: "waiting",
      label: "Waiting: linear-state",
      wait: {
        on: "script",
        note: "ENG-123 to reach Done",
        age: "2h",
        expired: false,
        status: "In Review",
        checkFailing: false,
      },
      derived: false,
      stuckReason: null,
    });
    // Two failures are a blip; the third says nothing is watching for the wake.
    expect(script({ failures: 2, problem: "Linear said 401" }).stuckReason).toBeNull();
    const failing = script({ failures: 3, problem: "Linear said 401" });
    expect(failing.label).toBe("Waiting: linear-state (check failing)");
    expect(failing.wait).toMatchObject({ checkFailing: true });
    expect(failing.stuckReason).toBe(
      "Waiting: linear-state: its check failed 3 times in a row (Linear said 401)",
    );
  });

  it("surfaces an expired wait as stuck, with its reason", () => {
    const old = truth(
      card(1, {
        movedAt: "2026-11-05T09:00:00.000Z" as never,
        wait: wait({ at: "2026-11-06T10:00:00.000Z" as never }),
      }),
    );
    expect(old.wait).toMatchObject({ expired: true, age: "4d 2h" });
    expect(old.stuckReason).toBe(
      "Waiting on the author (PR #512) for 4d 2h, past its limit: Pavan to push F1-F3",
    );
    const marked = truth(
      card(1, { wait: wait({ expiredAt: "2026-11-10T11:00:00.000Z" as never }) }),
    );
    expect(marked.stuckReason).not.toBeNull();
  });

  it("ignores a wait once someone moved the card", () => {
    const moved = card(1, {
      stage: "todo",
      movedAt: "2026-11-10T11:00:00.000Z" as never,
      wait: wait(),
    });
    expect(truth(moved).state).toBe("ready");
  });

  it("says the evaluator's step is owed after a passed review", () => {
    const owed = card(1, {
      movedAt: "2026-11-08T09:00:00.000Z" as never,
      subtasks: [subtask("evaluator", "merge and deploy")],
    });
    expect(truth(owed)).toMatchObject({
      state: "evaluator",
      label: "Evaluator's step: s3",
      stuckReason: "Review passed 2d 3h ago and s3 is still open",
    });
  });

  it("knows a reviewed card with an open tracked PR waits on its merge, without guessing", () => {
    const reviewed = card(1, {
      links: [
        { kind: "pr", url: PR, label: null, state: "open", checkedAt: "2026-11-10T09:00:00.000Z" },
      ] as never,
    });
    expect(truth(reviewed)).toMatchObject({
      state: "waiting",
      label: "Waiting on merge (PR #512)",
      derived: false,
      stuckReason: null,
    });
    // A context PR (no tracked state) holds nothing.
    const context = card(1, {
      links: [{ kind: "pr", url: PR, label: null, state: null, checkedAt: null }] as never,
    });
    expect(truth(context).state).toBe("idle");
  });

  it("is idle with how long, and stuck after a day", () => {
    expect(truth(card(1))).toEqual({
      state: "idle",
      label: "Idle 3h",
      wait: null,
      derived: false,
      stuckReason: null,
    });
    expect(truth(card(1, { movedAt: "2026-11-07T09:00:00.000Z" as never }))).toMatchObject({
      label: "Idle 3d 3h",
      stuckReason: "Idle 3d 3h in In Review: no reviewer, no wait and no next step recorded",
    });
  });
});

describe("cardTruth: the guess for cards with no wait", () => {
  const stalled = (reason: string, at = "2026-11-10T09:00:00.000Z") =>
    card(1, { stalled: { reason, by: evaluator, at } as never });

  it("reads a stalled flag that is really a wait, and marks it as a guess", () => {
    const result = truth(
      stalled("Waiting on jashwanth9845 for a new head on backoffice-frontend#248."),
    );
    expect(result).toEqual({
      state: "waiting",
      label: "Waiting on the author",
      wait: {
        on: "push",
        note: "Waiting on jashwanth9845 for a new head on backoffice-frontend#248.",
        age: "3h",
        expired: false,
        status: null,
        checkFailing: false,
      },
      derived: true,
      stuckReason: null,
    });
  });

  it("turns an old guess into a stuck card", () => {
    const result = truth(stalled("waiting on jashwanth9845", "2026-11-01T09:00:00.000Z"));
    expect(result.derived).toBe(true);
    expect(result.stuckReason).toBe(
      'Waiting on the author for 9d 3h (a guess from "waiting on jashwanth9845")',
    );
  });

  it("keeps a stalled flag that says nothing about a wait as stalled", () => {
    expect(truth(stalled("Missing AWS access for the staging account"))).toMatchObject({
      state: "failed",
      label: "Stalled",
      derived: false,
      stuckReason: "Stalled 3h: Missing AWS access for the staging account",
    });
  });

  it("reads the open subtask, a link label, the loaded history or the wake note", () => {
    const bySubtask = card(1, {
      subtasks: [
        subtask(
          "evaluator",
          "Wait for Jashwanth's fix: when the PR head moves past 5ee4f57a (check-back schedule), confirm the new head",
        ),
      ],
    });
    expect(truth(bySubtask)).toMatchObject({ label: "Waiting on the author", derived: true });

    const byLabel = card(1, {
      links: [
        {
          kind: "pr",
          url: PR,
          label: "D4 parent PR #1100 (merge gate)",
          state: null,
          checkedAt: null,
        },
      ] as never,
    });
    expect(truth(byLabel)).toMatchObject({ label: "Waiting on merge", derived: true });

    const events = [
      {
        id: 1,
        cardId: "card-1",
        at: "2026-11-09T10:00:00.000Z",
        actor: evaluator,
        kind: "comment",
        fromStage: null,
        toStage: null,
        body: "Review posted to the author.",
        head: null,
      },
      {
        id: 2,
        cardId: "card-1",
        at: "2026-11-10T10:00:00.000Z",
        actor: evaluator,
        kind: "comment",
        fromStage: null,
        toStage: null,
        body: "Merge waits on #3178, #3167 and #45.",
        head: null,
      },
    ] as unknown as KanbanCardEvent[];
    expect(truth(card(1), [], [], { events })).toMatchObject({
      label: "Held for #3178",
      derived: true,
    });

    expect(
      truth(card(1, { wakeNote: "pending" }), [], [], {
        wakeNote: "Verdict remains Waiting on CI.",
      }),
    ).toMatchObject({
      label: "Waiting on CI",
      derived: true,
    });
    // The feed's "pending" placeholder is not a note.
    expect(truth(card(1, { wakeNote: "pending" })).state).toBe("idle");
  });

  it("never guesses over a real wait", () => {
    const both = card(1, {
      wait: wait({ on: "merge" }),
      subtasks: [subtask("evaluator", "Wait for Jashwanth's fix: new head")],
    });
    expect(truth(both)).toMatchObject({ label: "Waiting on merge (PR #512)", derived: false });
  });
});

describe("guessWait", () => {
  it("reads the phrasings found on real cards", () => {
    const kind = (text: string) => guessWait(text)?.on ?? null;
    expect(kind("Waiting on jashwanth9845 for a new head on backoffice-frontend#248.")).toBe(
      "push",
    );
    expect(kind("New head -> reopen s2-s5, fresh Sol review, then Astra card.")).toBe("push");
    expect(kind("waiting on jashwanth9845")).toBe("push");
    expect(
      kind(
        "waiting on Pavan: round-2 asks F1-F3 posted 30 Oct (issuecomment-6521229343); resume at a new head or his reply",
      ),
    ).toBe("push");
    expect(kind("When Jashwanth pushes a fix, a round-3 card takes the merge path.")).toBe("push");
    expect(kind("q4 was dropped, so the default applies: wait for js to mark it ready.")).toBe(
      "push",
    );
    expect(kind("Verdict remains Waiting on CI.")).toBe("ci");
    expect(
      kind(
        "Evaluator CI hold: waiting on hosted run 42844979311 at 705c2b2cc153fed63d5aaadb5dbdf49d8676ee22; …",
      ),
    ).toBe("ci");
    expect(
      kind(
        "Dependency hold, not a CI wait: s5 stays unfinished until PR451 merges into native-v1; …",
      ),
    ).toBe("merge");
    expect(kind("Hold merge for D4, then rebase and validate native-v1 head.")).toBe("merge");
    expect(kind("D4 parent PR #1100 (merge gate)")).toBe("merge");
    expect(
      guessWait(
        "Waiting on #2694 (card-010b55d3-5176-4748-98fb-8bea07b63169): owner q2 chose to ride its full-root dev apply, …",
      ),
    ).toMatchObject({ on: "card", cardNumber: 2694 });
    expect(guessWait("Merge waits on #3178, #3167 and #45.")).toMatchObject({
      on: "card",
      cardNumber: 3178,
    });
    expect(kind("Hourly 10:59Z recheck (8 Nov 11:15Z): STILL HELD.")).toBe("time");
    expect(kind("Held for the owner's go on the merge")).toBe("owner_go");
  });

  it("says nothing for text that is not a wait", () => {
    expect(guessWait("backoffice-core #527 — c010acde, CI green")).toBeNull();
    expect(
      guessWait("crypko-frontend#1551 reviewed f8eac05b: Findings (P3 shared-reader migration)"),
    ).toBeNull();
    expect(guessWait("Missing AWS access for the staging account")).toBeNull();
    expect(guessWait("Run failed: Provider turn failed.")).toBeNull();
    expect(guessWait("Woken")).toBeNull();
    expect(guessWait(null)).toBeNull();
    expect(guessWait("  ")).toBeNull();
  });

  it("cuts a long source text short", () => {
    expect(guessWait(`waiting on the author ${"x".repeat(300)}`)?.from.length).toBe(140);
  });
});

describe("stuckCards", () => {
  it("lists stuck cards oldest first with why, and leaves healthy ones out", () => {
    const board = state([
      card(1),
      card(2, { movedAt: "2026-11-07T09:00:00.000Z" as never }),
      card(3, {
        movedAt: "2026-11-05T09:00:00.000Z" as never,
        wait: wait({ at: "2026-11-06T10:00:00.000Z" as never }),
      }),
      card(4, { wait: wait() }),
      card(5, { stage: "todo" }),
    ]);
    expect(stuckCards(board, NOW).map((entry) => [entry.card.number, entry.truth.state])).toEqual([
      [3, "waiting"],
      [2, "idle"],
    ]);
  });
});
