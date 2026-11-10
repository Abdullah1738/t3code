/**
 * Retry once before flagging. A worker's or reviewer's run that fails, or a
 * reviewer that still has no verdict after its nudge, used to flag the card at
 * once, and an evaluator had to restart it by hand. Now the first failure of a
 * kind restarts the same role on the same card once, and only the second flags.
 *
 * Pure decisions; the engine's turn-end code calls them where it used to flag.
 */
import { type KanbanBoard, type KanbanCard, type KanbanCardRetry } from "@t3tools/contracts";

import { isContextFull, isOutage } from "./rules.ts";

export type RetryKind = KanbanCardRetry["kind"];
export type RetryRole = KanbanCardRetry["role"];

/**
 * How long a failed run waits before its restart, so a provider that is down is not
 * hammered. The card keeps its thread and slot meanwhile; the tick (every 30
 * seconds) sees the failed idle thread again and restarts it once this has passed.
 */
export const RETRY_BACKOFF_MS = 60_000;

/**
 * How long after a restart the old failed run may still be the thread's latest
 * (the wake is on its way) before that counts as the retry having failed.
 */
export const RETRY_SETTLE_MS = 2 * 60_000;

/** Card event when a failed run is held for its one retry; a board shows "Retrying". */
export const RETRYING_EVENT = "Run failed, retrying once";
/** Card event when the card goes back to its queue for the retry. */
export const RESTARTED_EVENT = "Retrying after a failed run";
export const NO_VERDICT_RESTARTED_EVENT = "Reviewer stopped without a verdict, retrying once";
export const NO_VERDICT_REASON = "Reviewer stopped without a verdict";

/** The parts of a provider failure the decision reads. */
export interface RetryFailure {
  readonly class: string;
  readonly code: string | null;
  readonly message: string;
  readonly category?: string | undefined;
  readonly retryable?: boolean | null | undefined;
  readonly runId?: string | null | undefined;
}

// A request the provider turned down as it stands: sending it again changes nothing.
const REFUSED_CODE = /invalid-request|no-route|content-filter|not-found|forbidden|permission/i;
// A model or level the provider doesn't offer or doesn't allow this account.
const MODEL_TEXT =
  /variant unavailable|model[^.]{0,40}(not (found|available|offered|supported|allowed|enabled)|unavailable|does not exist|is not allowed)|unknown model|unsupported (model|variant)|no such model|not authorized to use|access to (this )?model/i;
// The folder the thread runs in is gone.
const WORKSPACE_TEXT =
  /no such file or directory|ENOENT|(workspace|worktree|working directory|project folder|cwd)[^.]{0,40}(missing|not found|does not exist|is gone|no longer exists)/i;
// Someone stopped the run.
const STOPPED_TEXT =
  /\b(interrupted|cancell?ed|aborted|stopped) by\b|user (interrupt|abort|cancel)/i;

/**
 * Why a failed run is not worth running again, or null when it is. Retried: failures
 * with no category (or `unknown`) in class provider_error, transport_error or
 * unknown, which is what a dropped stream, a crashed harness or a run that failed
 * without a message look like. Never retried:
 *  - outages (quota, transient, expired auth): the thread is paused and probed instead;
 *  - a thread too long for the model: it is compacted or started fresh instead;
 *  - config, model_invalid and content_filter categories, permission and validation
 *    errors, refused requests, and anything the provider marks not retryable;
 *  - a model or level that isn't offered or allowed, a missing workspace, a run
 *    someone stopped.
 */
export function noRetryReason(failure: RetryFailure): string | null {
  if (isOutage(failure)) return "the provider is out of usage or down";
  switch (failure.category) {
    case "config":
      return "the provider refuses this account or setup";
    case "model_invalid":
      return "the model or level is not offered";
    case "context_exhausted":
      return "the thread is too long for the model";
    case "content_filter":
      return "the provider's content filter stopped it";
    default:
      break;
  }
  if (isContextFull(failure)) return "the thread is too long for the model";
  if (failure.retryable === false) return "the provider says a retry won't help";
  if (failure.class === "permission_error") return "the provider refused permission";
  if (failure.class === "validation_error") return "the request itself is invalid";
  if (failure.code !== null && REFUSED_CODE.test(failure.code)) {
    return "the provider refused the request as it stands";
  }
  if (MODEL_TEXT.test(failure.message)) return "the model or level is not offered or allowed";
  if (WORKSPACE_TEXT.test(failure.message)) return "the thread's workspace is missing";
  if (STOPPED_TEXT.test(failure.message)) return "the run was stopped";
  return null;
}

export type RetryDecision =
  /** Flag the card as before. `why` says why no (further) retry. */
  | { readonly _tag: "flag"; readonly why: string }
  /** First sighting of a failed run: save `retries`, log RETRYING_EVENT, leave the card with its thread. */
  | { readonly _tag: "wait"; readonly retries: ReadonlyArray<KanbanCardRetry> }
  /** Nothing to do now: the backoff is still running, the restart is on its way, or the board is paused. */
  | { readonly _tag: "hold" }
  /** Release the card to its queue unflagged, with `retries`; the dispatcher starts it again. */
  | { readonly _tag: "restart"; readonly retries: ReadonlyArray<KanbanCardRetry> };

export interface RetryInput {
  readonly kind: RetryKind;
  readonly role: RetryRole;
  /** The failed run, for run_failed. */
  readonly failure?: RetryFailure | null | undefined;
  /** The card's `retries`. */
  readonly retries: ReadonlyArray<KanbanCardRetry> | undefined;
  /** The board's pause holds this card: nothing is retried or flagged until it lifts. */
  readonly paused: boolean;
  readonly nowMs: number;
  /** The decision's own stamp, as the card stores it. */
  readonly at: string;
}

/**
 * What to do where the engine used to flag.
 *
 * run_failed: the first failed run of an attempt is recorded and waits
 * RETRY_BACKOFF_MS with its thread (`wait`, then `hold` each time the same run is
 * seen again), then the card is released for one restart (`restart`). A different
 * failed run after that, or the old one still standing RETRY_SETTLE_MS after the
 * restart, flags. A failure that a retry can't help (see noRetryReason) flags at once.
 *
 * no_verdict: asked only once the reviewer's nudge is used. The first time the
 * review is restarted at once (there is no provider to spare); the second flags.
 */
export function decideRetry(input: RetryInput): RetryDecision {
  if (input.paused) return { _tag: "hold" };
  const all = input.retries ?? [];
  const entry = all.find((retry) => retry.kind === input.kind && retry.role === input.role);
  const others = all.filter((retry) => retry !== entry);
  if (input.kind === "no_verdict") {
    if (entry !== undefined) return { _tag: "flag", why: "the review was already restarted once" };
    return {
      _tag: "restart",
      retries: [
        ...others,
        {
          kind: "no_verdict",
          role: input.role,
          runId: null,
          reason: NO_VERDICT_REASON,
          at: input.at,
          state: "restarted",
        },
      ],
    };
  }
  const failure = input.failure;
  if (!failure) return { _tag: "flag", why: "no failure to retry" };
  const runId = failure.runId ?? null;
  if (entry === undefined) {
    const why = noRetryReason(failure);
    if (why !== null) return { _tag: "flag", why };
    return {
      _tag: "wait",
      retries: [
        ...others,
        {
          kind: "run_failed",
          role: input.role,
          runId,
          reason: failure.message,
          at: input.at,
          state: "waiting",
        },
      ],
    };
  }
  const sameRun = entry.runId === runId;
  const since = input.nowMs - Date.parse(entry.at);
  if (entry.state === "waiting") {
    // Another run failed while this one waited: that was the second failure.
    if (!sameRun) return { _tag: "flag", why: "a second run failed" };
    if (since < RETRY_BACKOFF_MS) return { _tag: "hold" };
    return {
      _tag: "restart",
      retries: [...others, { ...entry, at: input.at, state: "restarted" }],
    };
  }
  // Restarted. The old run can still be the latest while the wake is on its way.
  if (sameRun && since < RETRY_SETTLE_MS) return { _tag: "hold" };
  return {
    _tag: "flag",
    why: sameRun ? "the restart did not start a new run" : "the retry failed too",
  };
}

/** The card without its retry record: a real move, a normal turn end, a verdict or a flag starts over. */
export const withoutRetries = <C extends KanbanCard>(card: C): C => {
  if (card.retries === undefined) return card;
  const { retries: _retries, ...rest } = card;
  return rest as C;
};

/** The same, for one role: a worker's good turn says nothing about a reviewer's retry. */
export const withoutRoleRetries = <C extends KanbanCard>(card: C, role: RetryRole): C => {
  if (card.retries === undefined) return card;
  const kept = card.retries.filter((retry) => retry.role !== role);
  return kept.length === 0 ? withoutRetries(card) : { ...card, retries: kept };
};

/** Whether the board's pause holds a card (it runs nothing but the cards it keeps). */
export const heldByPause = (board: Pick<KanbanBoard, "pause">, card: Pick<KanbanCard, "id">) =>
  board.pause !== null && !board.pause.keep.includes(card.id);

/** Told to a worker when its card comes back after a failed run. */
export const workRetryNote = (message: string) =>
  `Your last run on this card failed: "${message}". The board is starting it again once; if it fails again the card is flagged. Check what you already did (git log, the card, your last messages) before redoing anything, then carry on.`;

/** The wake note with the retry note added, keeping what was already waiting for the worker. */
export const withRetryNote = (note: string | null | undefined, message: string) =>
  [note?.trim(), workRetryNote(message)].filter((part): part is string => !!part).join("\n\n");

/** The line a restarted reviewer's brief opens with, or null when the card isn't on a review retry. */
export const reviewRetryNote = (card: Pick<KanbanCard, "retries">): string | null => {
  const retry = card.retries?.findLast(
    (entry) => entry.role === "review" && entry.state === "restarted",
  );
  if (retry === undefined) return null;
  return retry.kind === "no_verdict"
    ? "Your last turn on this review ended without a verdict, also after a reminder. The board is starting the review again once; if it ends without a verdict again the card is flagged. If you already reached a verdict, record it now with card_review_result."
    : `Your last review run on this card failed: "${retry.reason}". The board is starting it again once; if it fails again the card is flagged. Pick up where you stopped.`;
};
