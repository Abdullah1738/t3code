import {
  KanbanError,
  type KanbanBoard,
  type KanbanCard,
  type KanbanCardId,
  type KanbanPool,
  type KanbanThreadLink,
  type ThreadId,
} from "@t3tools/contracts";

import { sameValue } from "../../harness-migrate/selectionPlan.ts";
import * as Defaults from "./defaults.ts";
import * as Rules from "./rules.ts";

export interface RestoreCutoverCardInput {
  readonly cardId: KanbanCardId;
  readonly threadId: ThreadId;
  readonly stage: "working" | "in_review";
}

type RestorePlan =
  | { readonly ok: false; readonly error: KanbanError }
  | {
      readonly ok: true;
      readonly card: KanbanCard;
      readonly link: KanbanThreadLink;
      readonly changed: boolean;
    };

/** Reattaches only a recorded thread; launching and messaging belong to the cutover job. */
export const planCutoverCardRestore = (input: {
  readonly restore: RestoreCutoverCardInput;
  readonly board: KanbanBoard;
  readonly card: KanbanCard;
  readonly link: KanbanThreadLink | null;
  readonly threadCards: ReadonlyArray<KanbanCardId>;
  readonly cards: ReadonlyArray<KanbanCard>;
  readonly pools: ReadonlyArray<KanbanPool>;
  readonly holds: ReadonlyMap<string, string>;
  readonly at: string;
}): RestorePlan => {
  const { restore, board, card, link } = input;
  const denied = (detail: string): RestorePlan => ({
    ok: false,
    error: new KanbanError({ code: "denied", detail }),
  });
  if (board.pause === null) return denied("cutover card restore requires a paused board");
  if (board.pause.keep.includes(card.id))
    return denied("cutover card must remain held by the board pause");
  if (board.id !== card.boardId || card.id !== restore.cardId) {
    return denied("cutover card does not belong to this board");
  }
  if (card.settledAt !== null) return denied(`card #${card.number} is settled`);

  const role = restore.stage === "working" ? "work" : "review";
  const same =
    card.stage === restore.stage &&
    card.activeThreadId === restore.threadId &&
    card.activeRole === role;
  const stopped =
    card.stage === "todo" &&
    card.stalled !== null &&
    card.activeThreadId === null &&
    card.activeRole === null &&
    card.activePool === null;
  if (!stopped && !same) return denied(`card #${card.number} is not stopped or already restored`);
  if (
    link === null ||
    link.threadId !== restore.threadId ||
    link.boardId !== board.id ||
    link.role !== role
  ) {
    return denied(`thread ${restore.threadId} has no matching ${role} link on this board`);
  }
  const recorded = role === "work" ? card.workThreadId : card.reviewThreadId;
  // A shared worker can have dropped its pointer on stop; its history is still authoritative.
  const historical = role === "work" && input.threadCards.includes(card.id);
  if (recorded !== restore.threadId && !(recorded === null && historical)) {
    return denied(
      `thread ${restore.threadId} is not the recorded ${role} thread for card #${card.number}`,
    );
  }

  const selection = Defaults.modelSelectionResult(
    Rules.nextModel(board, { ...card, stage: restore.stage }),
    true,
  );
  if (selection.kind === "conflict") {
    return { ok: false, error: new KanbanError({ code: "invalid", detail: selection.reason }) };
  }
  const model = selection.selection;
  const key = Rules.poolKey(model);
  const pool = input.pools.find(
    (candidate) => candidate.key === key && Rules.poolKey(candidate.model) === key,
  );
  if (pool === undefined) return denied(`no migrated ${role} pool runs ${key}`);

  const others = input.cards.filter((other) => other.id !== card.id);
  if (
    others.some(
      (other) =>
        other.activeThreadId === restore.threadId &&
        (other.activePool !== key || other.activeRole !== role),
    )
  ) {
    return denied(`thread ${restore.threadId} already occupies another pool or role`);
  }
  const heldPool = input.holds.get(restore.threadId);
  if (heldPool !== undefined && heldPool !== key) {
    return denied(`thread ${restore.threadId} already holds another pool`);
  }
  const occupied = Rules.poolThreads(others, input.holds).get(key) ?? new Set<string>();
  occupied.add(restore.threadId);
  if (occupied.size > pool.slots) return denied(`the ${key} pool has no free slot`);

  const restored: KanbanCard = {
    ...card,
    stage: restore.stage,
    activeThreadId: restore.threadId,
    activeRole: role,
    activePool: key,
    ...(role === "work"
      ? { workThreadId: restore.threadId }
      : { reviewThreadId: restore.threadId }),
    stalled: null,
    nudgedAt: null,
  };
  const nextCard = sameValue(restored, card)
    ? card
    : { ...restored, movedAt: input.at, updatedAt: input.at };
  const restoredLink: KanbanThreadLink = { ...link, model, endedAt: null, paused: null };
  const nextLink = sameValue(restoredLink, link) ? link : restoredLink;
  return {
    ok: true,
    card: nextCard,
    link: nextLink,
    changed: nextCard !== card || nextLink !== link,
  };
};
