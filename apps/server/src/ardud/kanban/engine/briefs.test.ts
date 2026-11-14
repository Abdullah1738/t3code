import {
  KanbanBoardId,
  KanbanCardId,
  ProviderInstanceId,
  type KanbanBoard,
  type KanbanCard,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  evaluatorBrief,
  claimBrief,
  wakeText,
  nudgeWorkText,
  reviewBrief,
  workBrief,
  type EvaluatorPurpose,
} from "./briefs.ts";

const model = { instanceId: ProviderInstanceId.make("opencode"), model: "example" };
const board: KanbanBoard = {
  id: KanbanBoardId.make("board-1"),
  slug: "test",
  name: "Test",
  icon: null,
  iconImage: null,
  defaultProjectId: null,
  managerModel: model,
  evaluatorModel: model,
  defaultCardModel: model,
  reviewChains: [],
  defaultReviewChain: null,
  standingApprovals: [],
  instructions: { modelRouting: "", reviewerRouting: "", escalation: "" },
  setup: null,
  pause: null,
  nightlyReview: null,
  createdAt: "2026-10-25T00:00:00Z",
  archivedAt: null,
};
const card: KanbanCard = {
  id: KanbanCardId.make("card-1"),
  boardId: board.id,
  number: 1,
  title: "Example",
  description: "",
  prompt: "Do the work",
  stage: "todo",
  priority: 2,
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
  createdAt: "2026-10-25T00:00:00Z",
  updatedAt: "2026-10-25T00:00:00Z",
  movedAt: "2026-10-25T00:00:00Z",
};

describe("board briefs", () => {
  it("tells workers to watch PR CI and end the turn, and wait inside it for other work", () => {
    expect(nudgeWorkText([card])).toContain(
      "Waiting on CI for a PR: call watch_pull_request on it and end your turn; the board waits while the watch is on and the watch wakes you. For a deploy or anything else, wait inside your turn.",
    );
  });

  it("lets newly dispatched workers end their turn while watching PR CI", () => {
    const brief = workBrief(board, card, null);
    expect(brief).toContain(
      "Waiting on CI for an open or draft PR: call watch_pull_request on it and end your turn; the watch wakes you on CI and review changes, and the board waits for up to 6 hours since your last run while the watch is on.",
    );
    expect(brief).toContain("For a deploy or anything else, wait inside your turn.");
    expect(brief).not.toContain("Never end a turn while a card of yours is in Working");
    expect(brief).not.toContain("Wait for CI or a deploy inside the turn");
    expect(brief).not.toContain("Each time you stop with a card in Working you are nudged");
  });

  it("includes the file-first instructions with a request", () => {
    const brief = evaluatorBrief(board, { kind: "request", text: "Owner's exact request" });
    expect(brief).toContain(
      `Owner request:\nOwner's exact request\n\nFile first: within your first 15 minutes put each item that needs work on the board as a card (P1s first, or a comment on the card that already covers it). Research goes into the card's packet, not this turn. When an ask names a model or a role (packets, evaluators, workers, reviewers), check what is live, then post one line with card_ask before any packet, dispatch or note to another board: "I read this as X, which changes Y. Is that right?" When a card already has a worker thread, send your findings to that thread; don't write its code yourself.`,
    );
  });

  it.each([
    { kind: "discussion", discussionId: "d1", title: "Discussion", cardNumber: null },
    { kind: "discussion", discussionId: "d2", title: "Card", cardNumber: 1 },
    { kind: "stalled" },
    { kind: "completed" },
    { kind: "deployed" },
    { kind: "check" },
    { kind: "packets" },
    { kind: "setup", text: "Setup" },
  ] satisfies ReadonlyArray<EvaluatorPurpose>)(
    "keeps request instructions out of the $kind evaluator brief",
    (purpose) => {
      expect(evaluatorBrief(board, purpose)).not.toContain("File first:");
    },
  );

  it("includes the review input-class instruction in the worker brief", () => {
    expect(workBrief(board, card, null)).toContain(
      "- Before card_move to needs_review, check what reviewers keep finding: list the sibling paths and call sites of what you changed (other entry points, clients, providers, the way back) and fix or name each; search skills, watchers and the wiki for rules your change contradicts; name any change needed outside the repo (live config, skills, deploys) in card_update. When a review finds one input form your code misses (a label, separator, date or number shape), write a table of that whole class, add a test row for each, and run them all before the next round.",
    );
  });

  it("tells reviewers how to retry a lost verdict", () => {
    expect(reviewBrief(board, card, null, null, [])).toContain(
      "Finish by calling card_review_result once, with head set to the commit you reviewed (the PR's head sha, or `git rev-parse HEAD` on the card's branch). If the call fails with a connection error or timeout, card_get the card: if no review event from you at that head is there, call it again with the same verdict, findings and head (an exact repeat within 10 minutes, if the card has not moved since, is acknowledged with a replay note; later calls are refused unless this thread is assigned to the review step):",
    );
  });

  it("gives the reviewer and evaluator model-aware delegation without named agents", () => {
    for (const brief of [
      reviewBrief(board, card, null, null, []),
      evaluatorBrief(board, { kind: "check" }),
    ]) {
      expect(brief).toContain("use T3 `delegate_task` with role `review`");
      expect(brief).toContain("Preserve the routed model and effort exactly in target.options");
      expect(brief).toContain("Do not pass an `agent` selector");
      expect(brief).toContain("The board review thread alone records card_review_result");
    }
  });
});

describe("current-step plan rendering", () => {
  it.each(["\n", "\r\n", "\r", "\u2028", "\u2029"])(
    "replaces legacy frozen plans with separator %j in every worker brief",
    (separator) => {
      const oldPlan =
        "Next on the plan:\nSubtasks (same step means any order; a step opens when the ones before are done or skipped):\n- s2 step 2, worker (now): Removed work\n\nDo this step's work subtasks, mark each with subtask_done, then card_move to needs_review.";
      const current = {
        ...card,
        wakeNote: `Owner says keep the rate.\n\n${oldPlan}\n\nLater owner words.`.replaceAll(
          "\n",
          separator,
        ),
        subtasks: [
          {
            id: "s7",
            step: 3,
            text: "Wait for QA",
            owner: "evaluator" as const,
            state: "open" as const,
            note: null,
            doneBy: null,
            doneAt: null,
          },
          {
            id: "s4",
            step: 4,
            text: "Current work",
            owner: "work" as const,
            state: "open" as const,
            note: null,
            doneBy: null,
            doneAt: null,
          },
        ],
      };
      for (const brief of [
        workBrief(board, current, null),
        wakeText(current),
        claimBrief(current, null, current.wakeNote),
        nudgeWorkText([current]),
      ]) {
        expect(brief).not.toContain("Removed work");
        expect(brief).toContain("evaluator (now): Wait for QA");
        expect(brief).toContain("worker (later): Current work");
        expect(brief).toContain("Owner says keep the rate.");
        expect(brief).toContain("Later owner words.");
      }
    },
  );
});

it.each(["fresh", "reused", "claimed", "nudge"] as const)("worker brief cleanup: %s", (path) => {
  const current = {
    ...card,
    wakeNote: "Do s1 again. For s3, use 2%.",
    subtasks: [
      {
        id: "s1",
        step: 1,
        text: "Old work",
        owner: "work" as const,
        state: "done" as const,
        note: null,
        doneBy: null,
        doneAt: null,
      },
      {
        id: "s3",
        step: 3,
        text: "Current work",
        owner: "work" as const,
        state: "open" as const,
        note: null,
        doneBy: null,
        doneAt: null,
      },
    ],
  };
  const brief =
    path === "fresh"
      ? workBrief(board, current, null)
      : path === "reused"
        ? wakeText(current)
        : path === "claimed"
          ? claimBrief(current, null, current.wakeNote)
          : nudgeWorkText([current]);
  expect(brief).not.toContain("Do s1 again");
  expect(brief).toContain("For s3, use 2%.");
  expect(brief).toContain("worker (now): Current work");
});

it("nightly review puts information gaps before improvements and limits proposals", () => {
  const brief = evaluatorBrief(board, {
    kind: "nightly",
    day: "2026-11-13",
    discussionId: "disc-nightly",
  });
  expect(brief.indexOf("1. Information gaps first")).toBeLessThan(brief.indexOf("2. Improvements"));
  expect(brief.indexOf("2. Improvements")).toBeLessThan(brief.indexOf("3. Cross-board routing"));
  expect(brief.indexOf("3. Cross-board routing")).toBeLessThan(brief.indexOf("4. Proposals"));
  expect(brief.indexOf("4. Proposals")).toBeLessThan(brief.indexOf("5. Post"));
  for (const text of [
    "last 24 hours",
    "analytics_read",
    "board_activity first",
    "board_get with since",
    "olderEvents",
    "limit: 40",
    "todo at P3",
    "settled cards",
    "at most 5",
    "Approve / Change / Drop",
    "disc-nightly",
    "Do not merge, deploy",
    "board's instructions",
    "evaluator_start (kind request, your evidence), not as a card here",
    "Robob scheduling, pools, ticks and the board tools themselves are the robob board",
    "Apply this to information gaps as well as improvements",
    "cross-board handoffs",
  ]) {
    expect(brief).toContain(text);
  }
  expect(brief).not.toContain("full authority");
});

it("nightly review requires complete reads, a fresh cursor and recovery from failed reads", () => {
  const brief = evaluatorBrief(board, { kind: "nightly" });
  for (const text of [
    "Complete the read pass before filing findings",
    "Start board_get without after (or after: 0)",
    "Keep since unchanged while paging",
    "continue until hasMore is false",
    "Do not choose a starting card number or skip early cards",
    "Read every supplied active discussion through the window",
    "skim each active card thread",
    "read the pages relevant to this review by slug or slugs",
    "retry the same read once",
    "continue the other reads either way",
    "fall back to board_get without since, starting at after: 0",
    "A failed wiki read must not end the board, discussion or thread reads",
    "State coverage",
    "name the exact call and the unread portion",
  ]) {
    expect(brief).toContain(text);
  }
  expect(brief.indexOf("Complete the read pass")).toBeLessThan(brief.indexOf("1. Information gaps"));
});
