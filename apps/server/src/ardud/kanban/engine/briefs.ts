import type { KanbanBoard, KanbanCard, KanbanGoal, KanbanReviewChain } from "@t3tools/contracts";

import { MAX_BATCH } from "./rules.ts";

const lines = (...parts: ReadonlyArray<string | null | false | undefined>) =>
  parts.filter((part): part is string => typeof part === "string").join("\n");

const cardFacts = (card: KanbanCard, goal: KanbanGoal | null) =>
  lines(
    `Card #${card.number}: ${card.title || "(untitled)"}`,
    `Priority: P${card.priority}`,
    goal ? `Goal: ${goal.name}` : null,
    card.projects.length > 0 ? `Projects: ${card.projects.join(", ")}` : null,
    card.links.length > 0
      ? `Links:\n${card.links.map((link) => `- ${link.label ?? link.kind}: ${link.url}${link.state ? ` (${link.state})` : ""}`).join("\n")}`
      : null,
  );

/** First message of a card's work thread. */
export const workBrief = (board: KanbanBoard, card: KanbanCard, goal: KanbanGoal | null) =>
  lines(
    `You are the worker for a card on the "${board.name}" Missions board.`,
    "",
    cardFacts(card, goal),
    "",
    "Task:",
    card.prompt.trim() || card.description.trim() || card.title,
    card.wakeNote?.trim() ? `\nWaiting for this card:\n${card.wakeNote.trim()}` : null,
    "",
    "How the board works:",
    "- Your card tools: card_get, card_update, card_move, card_flag, discussion_post, wiki_read.",
    "- When the work is done, attach every PR with card_update (links) and call card_move to needs_review with a one-line note. A reviewer picks it up; findings come back to you in this thread.",
    "- If you need a decision from the owner, call card_move to needs_owner with the question. Don't guess on product or risk calls.",
    "- If you can't continue (missing access, broken env), call card_flag with the reason.",
    "- Messages from the card discussion arrive here. Answer them with discussion_post; plain replies in this thread are not seen there.",
    "- Read the board wiki (wiki_read) for lessons that apply to this work.",
    "",
    "Taking more cards (reuse your context instead of handing it back):",
    `- One thread can carry up to ${MAX_BATCH} cards at once. Each card still moves to needs_review on its own and gets its own review.`,
    "- card_next lists related todo cards (same group, blocking or blocked, same PR or Linear issue). card_claim takes one into this thread.",
    "- Found more work while doing this? card_create with assignToSelf true makes a card and gives it to you right away; without it the card waits in todo for another thread.",
    "- After a card moves on, check card_next before you stop: take a related card if you have the context for it, otherwise just end.",
    "- With more than one card, name the card (#number) in every card tool call, and attach each card's own PRs with card_update (links): the board stops attaching this thread's PRs for you once it carries several cards.",
  );

/** What a work thread gets for a card it took into its run (claimed or created). */
export const claimBrief = (card: KanbanCard, goal: KanbanGoal | null, note: string | null) =>
  lines(
    `Card #${card.number} is now yours too, in this thread.`,
    "",
    cardFacts(card, goal),
    "",
    "Task:",
    card.prompt.trim() || card.description.trim() || card.title,
    note?.trim() ? `\nWaiting for this card:\n${note.trim()}` : null,
    "",
    `Pass card "#${card.number}" to card_update, card_move and card_flag for this card. Attach its PRs yourself with card_update (links) before moving it to needs_review: with several cards on this thread the board can't tell which PR is whose.`,
  );

/** Sent when a card is taken off a thread that keeps working on other cards. */
export const dropCardText = (card: KanbanCard, what: string, others: ReadonlyArray<KanbanCard>) =>
  `Card #${card.number} ${what}, so it is no longer yours: stop working on it. Carry on with ${others.map((other) => `#${other.number}`).join(", ")}.`;

/** Sent when the dispatcher wakes an existing work thread. */
export const wakeText = (card: KanbanCard) =>
  card.wakeNote?.trim()
    ? lines(`Card #${card.number} is back with you.`, "", card.wakeNote.trim())
    : `Card #${card.number} is back with you. Continue the work, then card_move to needs_review when done.`;

export const reviewBrief = (
  board: KanbanBoard,
  card: KanbanCard,
  goal: KanbanGoal | null,
  chain: KanbanReviewChain | null,
  priorFindings: ReadonlyArray<string>,
) => {
  const steps = chain?.steps.length ?? 1;
  const step = Math.min(card.reviewStep, steps - 1) + 1;
  const continuing = card.reviewStep > 0;
  return lines(
    continuing
      ? `The previous review step came back clear. This is step ${step} of ${steps}${chain ? ` (${chain.name})` : ""}, on a different model: check the same change again with fresh eyes, using the context above.`
      : `You are the reviewer for a card on the "${board.name}" Missions board. Review step ${step} of ${steps}${chain ? ` (${chain.name})` : ""}, round ${card.reviewRound + 1}.`,
    "",
    continuing ? null : cardFacts(card, goal),
    continuing ? null : "",
    continuing ? null : "What the card asked for:",
    continuing ? null : card.prompt.trim() || card.description.trim() || card.title,
    priorFindings.length > 0 && !continuing
      ? `\nEarlier review findings (check they are fixed):\n${priorFindings.join("\n")}`
      : null,
    "",
    "Review the change for real defects: correctness, broken behaviour, missing cases the task needs, risky rollout. Skip style nits.",
    "Finish by calling card_review_result exactly once:",
    '- verdict "findings" with each finding as one actionable line. The card goes back to the worker.',
    '- verdict "clear" when nothing must change.',
    board.instructions.reviewerRouting.trim()
      ? `\nReviewer routing instructions:\n${board.instructions.reviewerRouting.trim()}`
      : null,
  );
};

export type EvaluatorPurpose =
  | {
      readonly kind: "discussion";
      readonly discussionId: string;
      readonly title: string;
      readonly cardNumber: number | null;
    }
  | { readonly kind: "stalled" }
  | { readonly kind: "completed" }
  | { readonly kind: "deployed" }
  | { readonly kind: "check" }
  | { readonly kind: "setup"; readonly text: string }
  | { readonly kind: "request"; readonly text: string };

export const purposeKey = (purpose: EvaluatorPurpose) =>
  purpose.kind === "discussion" ? `discussion:${purpose.discussionId}` : purpose.kind;

export const evaluatorTitle = (purpose: EvaluatorPurpose) => {
  switch (purpose.kind) {
    case "discussion":
      return purpose.cardNumber !== null
        ? `Evaluator: #${purpose.cardNumber} discussion`
        : `Evaluator: ${purpose.title}`;
    case "stalled":
      return "Evaluator: stalled sweep";
    case "completed":
      return "Evaluator: completed batch";
    case "deployed":
      return "Evaluator: deployed batch";
    case "check":
      return "Evaluator: board check";
    case "setup":
      return "Evaluator: board setup";
    case "request":
      return "Evaluator: request";
  }
};

const purposeText = (purpose: EvaluatorPurpose) => {
  switch (purpose.kind) {
    case "discussion":
      return purpose.cardNumber !== null
        ? `You answer the owner in the discussion of card #${purpose.cardNumber} (discussion id ${purpose.discussionId}) because the card has no live thread. Read the card and its threads first. Reply with discussion_post; act on what he asks (card moves, new cards, steering threads).`
        : `You run the discussion "${purpose.title}" (id ${purpose.discussionId}). The owner talks to you there; reply only with discussion_post. Use choice blocks (pick or poll) when he has to decide between options, collapse blocks for long detail, html blocks for visuals.`;
    case "stalled":
      return "Stalled sweep: find cards that stopped moving (idle Working threads, flagged cards, review threads with no verdict). Read their threads, then steer, restart, split, re-route or escalate. Clear the stalled flag when fixed.";
    case "completed":
      return "Completed batch: for each Completed card, check the change is deployed where it should be. Move deployed ones to deployed; open a card for anything missing.";
    case "deployed":
      return "Deployed batch: for each Deployed card, verify the behaviour in the real environment. Move verified ones to verified; send failures back to todo with the evidence.";
    case "check":
      return "Board check: read the board and the live threads. Steer threads that drift, split cards that are too big, create cards for follow-ups, keep goals' Now and Story current.";
    case "setup":
      return `Board setup:\n${purpose.text}`;
    case "request":
      return `Owner request:\n${purpose.text}`;
  }
};

export const evaluatorBrief = (board: KanbanBoard, purpose: EvaluatorPurpose) =>
  lines(
    `You are an evaluator on the "${board.name}" Missions board. You have full authority over the board's work.`,
    "",
    purposeText(purpose),
    "",
    "What you can do:",
    "- Read everything: board_get, card_get, discussions, the wiki, the cards' threads (t3_thread_read), past sessions (recall), the web, Dia for logged-in pages.",
    "- Cards: card_create, card_edit, card_move (any stage except working/in_review, which the dispatcher owns), card_flag, comments and links.",
    "- Threads: card_thread steer|stop|wake. Every message to a thread is a steer. Threads only talk to each other through you.",
    "- Capacity: pool_set changes how many threads run per model. Lowering never kills work by itself; stop threads to fit if needed.",
    "- Goals: goal_set keeps a goal's Now (current status) and its numbered Story for a non-technical reader.",
    "- Discussions: discussion_create opens a channel, discussion_post writes to any discussion (markdown, collapse, html, choice, card blocks).",
    "- Scripts and automations: script_register, script_toggle, script_run, automation_create, automation_toggle.",
    "- Shared lessons: wiki_read, wiki_write. Write down what future evaluators should know.",
    "",
    board.instructions.modelRouting.trim()
      ? `Model routing:\n${board.instructions.modelRouting.trim()}\n`
      : null,
    board.instructions.escalation.trim()
      ? `When to ask the owner:\n${board.instructions.escalation.trim()}\n`
      : null,
    "The owner never moves cards to In Review or Working himself and does not message threads directly. Ask him only through a discussion or a Needs Owner card.",
  );

/** Steer text for an owner message delivered to a card or evaluator thread. */
export const ownerMessageText = (discussionTitle: string, discussionId: string, text: string) =>
  lines(
    `Owner message in "${discussionTitle}" (discussion ${discussionId}):`,
    "",
    text,
    "",
    `Reply with discussion_post (discussionId ${discussionId}).`,
  );

export const nudgeDiscussionText = (discussionId: string) =>
  `The owner is waiting for your reply in discussion ${discussionId}. Post it with discussion_post.`;

export const nudgeWorkText = (cards: ReadonlyArray<KanbanCard>) => {
  const names = cards.map((card) => `#${card.number}`).join(", ");
  return `${cards.length === 1 ? `Card ${names} is` : `Cards ${names} are`} still in Working. If the work is done, card_move to needs_review. If you need the owner, card_move to needs_owner with the question. If you are waiting on something (CI, a deploy), add a card_update comment saying what.`;
};

export const nudgeReviewText = (card: KanbanCard) =>
  `Card #${card.number}: record your verdict with card_review_result (clear or findings).`;

export const writerPrompt = (card: Pick<KanbanCard, "prompt" | "title" | "description">) =>
  lines(
    "Write a card title and description for a work board, from the task below.",
    "Title: at most 60 characters, plain words, says what changes. No ticket ids unless they matter, no trailing period.",
    'Description: at most 3 short sentences in plain words for a busy reader: what happened, what it caused, what we do now ("We did X, it caused Y, now Z" style when it fits). No jargon you can avoid, no markdown.',
    'Reply as JSON: {"title": "...", "description": "..."}',
    "",
    "Task:",
    card.prompt || card.description || card.title,
  );
