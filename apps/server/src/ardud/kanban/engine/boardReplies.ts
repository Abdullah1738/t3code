import {
  kanbanWaiting,
  type KanbanBoardSnapshot,
  type KanbanCard,
  type KanbanGoal,
} from "@t3tools/contracts";

import { waitSetBody } from "./waits.ts";

export const BOARD_PAGE_LIMIT = 200;
export const BOARD_PAGE_MAX = 500;

const short = (text: string, limit = 512) =>
  text.length > limit ? `${text.slice(0, limit)}…` : text;

export const feedGoal = (goal: KanbanGoal): KanbanGoal => ({
  ...goal,
  now: goal.now === null ? null : { ...goal.now, text: short(goal.now.text) },
  story: goal.story.slice(-20).map((entry) => ({ ...entry, text: short(entry.text) })),
});

/** Keep the existing feed schema; drawers fetch the full card separately. */
export const feedCard = (card: KanbanCard): KanbanCard => ({
  ...card,
  title: short(card.title),
  prompt: "",
  description: "",
  wakeNote: card.wakeNote === null ? null : "pending",
  question: card.question === null ? null : short(card.question),
  stalled: card.stalled === null ? null : { ...card.stalled, reason: short(card.stalled.reason) },
  asks: card.asks
    .filter((ask) => ask.closedAt === null)
    .map((ask) => ({ ...ask, text: short(ask.text) })),
  subtasks: card.subtasks.map((task) => ({ ...task, text: short(task.text, 128), note: null })),
  links: card.links.map((link) => ({
    ...link,
    label: link.label === null ? null : short(link.label),
  })),
});

/**
 * A parked card's wait for the compact board: its line ("Waiting for app#12 to
 * merge: note") and its fields. A wait not in force (a thread has the card, or
 * it was moved since) is left out.
 */
const compactWait = (card: KanbanCard, byId: ReadonlyMap<string, KanbanCard>) => {
  const wait = kanbanWaiting(card) ? (card.wait ?? null) : null;
  if (wait === null) return { line: null, wait: null };
  return {
    line: waitSetBody(wait, byId),
    wait: {
      on: wait.on,
      pr: wait.pr,
      card: wait.card,
      script: wait.script,
      note: short(wait.note),
      status: wait.status,
      failures: wait.failures,
      at: wait.at,
    },
  };
};

export const compactBoard = (
  snapshot: KanbanBoardSnapshot,
  byId = new Map(snapshot.cards.map((card) => [card.id as string, card])),
) => ({
  ...snapshot,
  cards: snapshot.cards.map((card) => ({
    id: card.id,
    number: card.number,
    title: short(card.title),
    stage: card.stage,
    priority: card.priority,
    owner: card.activeThreadId ?? card.workThreadId,
    model: card.model,
    activePool: card.activePool,
    activeThreadId: card.activeThreadId,
    workThreadId: card.workThreadId,
    reviewThreadId: card.reviewThreadId,
    discussionId: card.discussionId,
    goalId: card.goalId,
    blockedBy: card.blockedBy,
    settledAt: card.settledAt,
    updatedAt: card.updatedAt,
    // A parked card says what it waits for, ahead of an open question and the bare stage.
    status: short(
      card.stalled?.reason ?? compactWait(card, byId).line ?? card.question ?? card.stage,
    ),
    wait: compactWait(card, byId).wait,
    stalled: card.stalled,
    question: card.question,
    asks: card.asks,
    activeRole: card.activeRole,
    models: card.models,
    reviewChain: card.reviewChain,
    reviewStep: card.reviewStep,
    reviewRound: card.reviewRound,
    prompt: "",
  })),
  goals: snapshot.goals.map((goal) => ({
    ...goal,
    story: [],
    now: goal.now === null ? null : { ...goal.now, text: short(goal.now.text) },
  })),
  groups: snapshot.groups.map((group) => ({ ...group, summary: short(group.summary) })),
});
