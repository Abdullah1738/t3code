import {
  KANBAN_BACKLOG,
  kanbanStepSubtasks,
  type KanbanBoard,
  type KanbanCard,
  type KanbanGoal,
  type KanbanReviewChain,
  type KanbanStage,
} from "@t3tools/contracts";

import { MAX_BATCH } from "./rules.ts";
import { subtaskIds, subtaskLines } from "./subtasks.ts";

const lines = (...parts: ReadonlyArray<string | null | false | undefined>) =>
  parts.filter((part): part is string => typeof part === "string").join("\n");

const cardFacts = (card: KanbanCard, goal: KanbanGoal | null) =>
  lines(
    `Card #${card.number}: ${card.title || "(untitled)"}`,
    card.priority === KANBAN_BACKLOG ? "Priority: backlog" : `Priority: P${card.priority}`,
    goal ? `Goal: ${goal.name}` : null,
    card.projects.length > 0 ? `Projects: ${card.projects.join(", ")}` : null,
    card.links.length > 0
      ? `Links:\n${card.links.map((link) => `- ${link.label ?? link.kind}: ${link.url}${link.state ? ` (${link.state})` : ""}`).join("\n")}`
      : null,
    subtaskLines(card),
  );

/** First message of a card's work thread. */
const LINKS_LINE =
  "- Links: to point at a card, write [#12 Title](t3-context://v1/kanban-card/<card id>), or kanban-discussion/<discussion id> for a discussion; the owner sees a chip. One may reach you like that, or as [Kanban card: #12 Title; ref=<card id>] (card_get, discussion_read). A thread is a plain [title](t3-thread://v1/<thread id>) link (t3_thread_read).";

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
    "- Your card tools: card_get, card_search, card_update, card_move, card_ask, card_flag, subtask_done, discussion_post, wiki_read.",
    card.subtasks.length > 0
      ? "- Subtasks are the card's plan. Do the worker's subtasks of the step the card is on, and mark each with subtask_done (done with a short note, or skipped with why). The card can't go to needs_review while one is open. Later steps come back to you after the review if they are yours; the evaluator's and the reviewer's aren't yours to do."
      : null,
    "- When the work is done, attach every PR with card_update (links) and call card_move to needs_review with a one-line note. A reviewer picks it up; findings come back to you in this thread.",
    "- Before card_move to needs_review, check what reviewers keep finding: list the sibling paths and call sites of what you changed (other entry points, clients, providers, the way back) and fix or name each; search skills, watchers and the wiki for rules your change contradicts; name any change needed outside the repo (live config, skills, deploys) in card_update.",
    "- If you need a decision from the owner, ask with card_ask. Don't guess on product or risk calls. Ask async and keep working where you can; his answer comes to this thread. Pass blocking only when you can't go on without it: the card then waits in Needs Owner and comes back to you with the answer. Never use the built-in question tool: nobody sees it and the card stalls.",
    board.instructions.escalation.trim()
      ? `- When to ask the owner:\n${board.instructions.escalation.trim()}`
      : null,
    "- Never end a turn while a card of yours is in Working: move it to needs_review, ask with card_ask (blocking when you can't go on), flag it, or keep working. Wait for CI or a deploy inside the turn. Each time you stop with a card in Working you are nudged.",
    "- If you can't continue (missing access, broken env), call card_flag with the reason: the card goes back to To Do and the evaluator is told.",
    "- Messages from the card discussion arrive here. Answer them with discussion_post; plain replies in this thread are not seen there.",
    "- Read the board wiki (wiki_read) for lessons that apply to this work.",
    LINKS_LINE,
    "",
    "Taking more cards (reuse your context instead of handing it back):",
    `- One thread can carry up to ${MAX_BATCH} cards at once. Each card still moves to needs_review on its own and gets its own review.`,
    "- card_next lists related todo cards (same group, blocking or blocked, same PR or Linear issue). card_claim takes one into this thread.",
    "- Found more work while doing this? card_create with assignToSelf true makes a card and gives it to you right away; without it the card waits for an evaluator to write its packet, then goes to another thread.",
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
    `Pass card "#${card.number}" to card_update, card_move, card_flag and subtask_done for this card. Attach its PRs yourself with card_update (links) before moving it to needs_review: with several cards on this thread the board can't tell which PR is whose.`,
  );

/** Sent when a card is taken off a thread that keeps working on other cards. */
export const dropCardText = (card: KanbanCard, what: string, others: ReadonlyArray<KanbanCard>) =>
  `Card #${card.number} ${what}, so it is no longer yours: stop working on it. Carry on with ${others.map((other) => `#${other.number}`).join(", ")}.`;

/** Sent when a card a thread keeps working beside is paused (the backlog, the owner's answer). */
export const pauseCardText = (
  card: KanbanCard,
  what: string,
  until: string,
  others: ReadonlyArray<KanbanCard>,
) =>
  `Card #${card.number} ${what}: pause it and leave it as it is. It comes back to you ${until}. Carry on with ${others.map((other) => `#${other.number}`).join(", ")}.`;

/** Sent to a card's live thread when its plan of subtasks changes. */
export const planChangedText = (card: KanbanCard) =>
  lines(
    `Card #${card.number}'s plan changed.`,
    "",
    subtaskLines(card) ?? "It has no subtasks now.",
  );

/** The same, when another evaluator's change put the card on this step. */
export const evaluatorStepFromOtherText = (card: KanbanCard, by: string) =>
  lines(
    evaluatorStepText(card),
    "",
    `Another evaluator (thread ${by}) moved the card on to this step. Read the card's events first, so nothing outward is done twice.`,
  );

/** Sent to the card discussion's evaluator when the step a card is on becomes its own. */
export const evaluatorStepText = (card: KanbanCard) =>
  lines(
    `Card #${card.number} (${card.title || "untitled"}, now in ${card.stage}) is waiting on your subtasks: ${subtaskIds(kanbanStepSubtasks(card, "evaluator"))}.`,
    "",
    subtaskLines(card),
    "",
    kanbanStepSubtasks(card, "script").length > 0
      ? "Subtasks marked script belong to a board script: leave them to it. It hands one back to you if it fails."
      : null,
    kanbanStepSubtasks(card, "script").length > 0 ? "" : null,
    "Do them, mark each with subtask_done, then move the card on. Anything outward (a message, a ticket update, a merge or deploy) follows the board's approval rules: ask the owner first where they say so.",
  );

/** Sent to the card discussion's evaluator once when a board script hands a subtask back. */
export const handBackText = (
  card: KanbanCard,
  subtaskId: string,
  scriptName: string,
  note: string,
) =>
  lines(
    `Script "${scriptName}" handed subtask ${subtaskId} of card #${card.number} (${card.title || "untitled"}, now in ${card.stage}) back to you: ${note}`,
    "",
    subtaskLines(card),
    "",
    "Find out what stopped it. Do the subtask yourself and mark it with subtask_done, or fix the cause and give it back to the script with card_edit (owner script). Anything outward (a message, a ticket update, a merge or deploy) follows the board's approval rules: ask the owner first where they say so.",
  );

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
    card.subtasks.length > 0
      ? "Check the subtasks the worker marked done really are; a clear verdict ticks off the review's own."
      : null,
    "Finish by calling card_review_result exactly once, with head set to the commit you reviewed (the PR's head sha, or `git rev-parse HEAD` on the card's branch):",
    '- verdict "findings" with each finding as one actionable line. The card goes back to the worker.',
    '- verdict "clear" when nothing must change.',
    'After that call, end your final message with one line: "Verdict: clear" or "Verdict: changes needed: <top finding>".',
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
  | { readonly kind: "packets" }
  | { readonly kind: "setup"; readonly text: string; readonly discussionId?: string | null }
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
    case "packets":
      return "Evaluator: packets";
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
      return "Completed batch: for each Completed card, check the change is deployed where it should be. Move deployed ones to deployed; open a card for anything missing. Cards are completed and deployed only once the card's review passed. Leave a card alone while its current step is a board script's.";
    case "deployed":
      return "Deployed batch: for each Deployed card, verify the behaviour in the real environment. Move verified ones to verified; send failures back to todo with the evidence. Cards are completed and deployed only once the card's review passed. Leave a card alone while its current step is a board script's.";
    case "check":
      return "Board check: read the board and the live threads. Steer threads that drift, split cards that are too big, create cards for follow-ups, give a plan of subtasks to cards that have none, do the evaluator subtasks cards are waiting on, keep goals' Now and Story current. Leave a card alone while its current step is a board script's.";
    case "packets":
      return "Packets: threads and scripts made new cards that wait on your packet subtask. Each one is sent to you here, and more may follow while you work. For each: read what it points at, write its packet with card_edit, add the plan, then mark the packet subtask done.";
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
    "- Read everything: board_get, card_search (cards by words or #number, settled ones too), card_get, discussions, the wiki, the cards' threads (t3_thread_read), past sessions (recall), the web, Dia for logged-in pages.",
    "- Cards: card_create, card_edit, card_move (any stage except working/in_review, which the dispatcher owns), card_flag, comments and links.",
    "- Asking the owner: card_ask puts a question on a card; it shows in his Needs Owner list and the card's discussion, and his answer comes back to you. Async by default: the card and its thread go on. Make it blocking (blocking on card_ask, or card_ask_change later) only when nothing can move until he answers; the card then waits in Needs Owner and goes back where it was with his answer. Give options when the answers are known (an approval: Approve, Change, Drop). The owner can make an async ask blocking himself, and drop asks. Drop your own asks with card_ask_change once they no longer matter.",
    "- Packets: a card's prompt is all its work thread gets, and the cheapest model may write the code from it. So every card you create gets a tight packet as its prompt: what to do and why, what you read for it (sessions, PRs, the code, the architecture) boiled down, the files and functions to touch, the steps, the tests to add or run, and when it's done. Detailed enough that the writer never has to guess or go looking. Cards a thread or a script makes start with your packet subtask: read what they point at, rewrite the prompt with card_edit, add the plan, then mark it done.",
    "- Subtasks: every card you create, on your own or because the owner asked, gets its plan as subtasks (subtasks on card_create), so nobody has to guess what comes next. Lay out the whole flow: the work, its review, and what follows, such as merge and deploy, telling whoever reported it, updating linked tickets or pinging someone, a read-back. Leave out what isn't needed. Same step means any order. Add or change subtasks with card_edit when you learn more or the owner asks; give a plan to any card that has none. Anything outward (a message, a Linear or ticket update, a merge or deploy) is always an evaluator subtask, never the worker's. Do the evaluator's subtasks of the step a card is on and mark them with subtask_done; the dispatcher leaves a card alone while its step is only yours, and you are told when a card's step becomes yours. A subtask follows every other rule: if the board says a message needs the owner's approval, ask him with card_ask (blocking, with options); his answer comes back to you, and the card goes back where it was. The subtask stays open until it's sent. A card reaches verified only when every subtask is done or skipped.",
    "- Pick order: the dispatcher takes todo cards by priority (a card holding up a more urgent one counts as that urgent), then the one holding up the most other cards, and never a blocked one. Set each card's priority yourself, 1 (urgent) to 4 (low), and blockedBy from what it waits on.",
    "- Backlog: priority 5 is never picked up, and a card with a thread is paused there until it leaves. Move a card into the backlog, or out of it, only when the owner asks.",
    "- Threads: card_thread steer|stop|wake. Every message to a thread is a steer. Threads only talk to each other through you.",
    "- Capacity: pool_set changes how many threads run per model, and adds a pool for any model in the composer's list (orchestrator_capabilities), at 0 slots unless the owner gives a number; pool_remove drops an unused one. A model that leaves the list drops to 0 by itself. Lowering never kills work by itself; stop threads to fit if needed. A pool the routing below doesn't name runs work only when the owner asks for that model.",
    "- Models: give a card several models with weights (models on card_create or card_edit) when the routing below says so. It starts on the highest-weight model whose pool has room, equal weights at random, and its thread keeps that model. A model or variant the provider doesn't offer is refused when you set it, and the error lists what it does offer; pick the closest one yourself. If a card's run fails, it is flagged stalled and you get a note: fix it, clear the flag, and say what you changed.",
    "- Goals: goal_set keeps a goal's Now (current status) and its numbered Story for a non-technical reader.",
    "- Discussions: discussion_create opens a channel, discussion_post writes to any discussion (markdown, collapse, html, choice, card blocks).",
    LINKS_LINE,
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

/** A worker asked something in its card discussion. */
export const workerQuestionText = (
  cardNumber: number,
  discussionId: string,
  threadId: string,
  text: string,
) =>
  lines(
    `The worker on card #${cardNumber} (thread ${threadId}) asked in the card's discussion (${discussionId}):`,
    "",
    text,
    "",
    `Read the card and the discussion first. If you can answer from the card, its packet, the code or the board, reply with discussion_post (discussionId ${discussionId}); the worker gets your reply. If only the owner can decide, or the worker is answering him, leave it to him: card_ask on the card if it isn't asked yet, and tell the worker to go on with the rest. If it isn't really a question (a status update), don't reply.`,
  );

/** Handed to an evaluator that asked on a card before the card discussion got its own evaluator. */
export const cardHandoffText = (cardNumber: number, discussionId: string, threadId: string) =>
  `The owner followed up in the discussion of card #${cardNumber} (${discussionId}), and it now has its own evaluator (${threadId}), which owns #${cardNumber} from here. Don't change #${cardNumber} on your earlier ask; if you know something it needs, post it in that discussion.`;

/** Start text for a new card evaluator: the evaluators that asked there first may have acted already. */
export const priorAskerText = (threadIds: ReadonlyArray<string>) =>
  threadIds
    .map(
      (threadId) =>
        `Evaluator ${threadId} asked here before you and may already have changed the card on the owner's answer: check the card's events first.`,
    )
    .join("\n");

export const nudgeWorkText = (cards: ReadonlyArray<KanbanCard>) => {
  const names = cards.map((card) => `#${card.number}`).join(", ");
  return `${cards.length === 1 ? `Card ${names} is` : `Cards ${names} are`} still in Working and your turn ended. A card can't stay in Working while you are stopped, so do one of these now for each: if it is done, card_move to needs_review; if you need the owner's answer to go on, card_ask with blocking true (the card waits in Needs Owner); if you can't go on, card_flag with the reason (it goes back to To Do and the evaluator is told); otherwise keep working on it now. Wait for CI or a deploy inside your turn instead of ending it.`;
};

export const runFailedText = (
  card: KanbanCard,
  role: "work" | "review",
  message: string,
  stage: KanbanStage,
) =>
  `Card #${card.number}'s ${role} run failed: "${message}". The card is flagged stalled and back in ${stage}; its thread is released. Fix the cause. If the provider refused the model or variant, card_edit the model to the closest one orchestrator_capabilities offers (for a review step, ask the owner to change the board's review chain). Then clear the flag with card_flag stalled false and say in the card's discussion what you changed.`;

export const providerBackText = (message: string) =>
  lines(
    `Your last run stopped on a provider error: "${message}". The model answers again now.`,
    "Pick up exactly where you stopped. Check what you already did (git log, the card, your last messages) before redoing anything.",
  );

export const modelRefusedText = (card: KanbanCard, problem: string) =>
  `Card #${card.number} was not started: ${problem} It is flagged stalled. card_edit its model to the closest one orchestrator_capabilities offers (for a review step, ask the owner to change the board's review chain), clear the flag with card_flag stalled false, and say in the card's discussion what you changed.`;

export const workerFlaggedText = (card: KanbanCard, reason: string) =>
  `Card #${card.number} (${card.title || "untitled"}): its thread flagged it and let it go: "${reason}". It is in ${card.stage}, flagged, and its slot is free. Read the thread (t3_thread_read), sort out what it needs, then card_thread wake with what to do next (it goes back to the same thread), or re-plan the card.`;

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
