import {
  KanbanBoardId,
  KanbanCardId,
  ProviderInstanceId,
  type KanbanBoard,
  type KanbanCard,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { evaluatorBrief, workBrief, type EvaluatorPurpose } from "./briefs.ts";

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
  instructions: { modelRouting: "", reviewerRouting: "", escalation: "" },
  setup: null,
  pause: null,
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
});
