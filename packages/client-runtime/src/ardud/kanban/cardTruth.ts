import {
  KANBAN_BACKLOG,
  KANBAN_DONE_STAGES,
  KANBAN_WAIT_LIMIT_MS,
  kanbanAwaitsMerge,
  kanbanDeciding,
  kanbanWaitCheckFailing,
  kanbanEvaluatorStep,
  kanbanHeldUpBy,
  kanbanRetryNotBefore,
  kanbanRetrying,
  kanbanScriptStep,
  kanbanStepSubtasks,
  kanbanWaitExpired,
  kanbanWaiting,
  kanbanWaitsOnEvaluator,
  type KanbanCard,
  type KanbanCardEvent,
  type KanbanWait,
  type KanbanWaitKind,
} from "@t3tools/contracts";

import { ageView, clockLabel, formatTimeOfDay } from "../common/time.ts";
import type { KanbanBoardState } from "./boardState.ts";
import { guessWaitFrom, type WaitGuess } from "./waitGuess.ts";

/**
 * What a card is really doing, for display: the stage says where it sits,
 * this says whether anything is moving it.
 */
export type CardTruthState =
  /** To-Do or Needs Review with nothing in the way: the dispatcher takes it when a slot frees. */
  | "ready"
  /** To-Do held by other cards, the backlog or the board's setup. */
  | "blocked"
  /** A work thread is on it. */
  | "running"
  /**
   * Its run failed, or its reviewer gave no verdict, and the board is on the one
   * automatic retry: waiting out the backoff, queued for a slot, or running again.
   */
  | "retrying"
  /** Its run failed, or it was flagged stalled, and nothing is retrying it. */
  | "failed"
  /** A reviewer thread is on it. */
  | "reviewing"
  /** Parked on a wait: see `wait`. */
  | "waiting"
  /** The next step is the evaluator's or a board script's. */
  | "evaluator"
  /** Waiting on the owner. */
  | "owner"
  /** Nothing runs it and nothing says why. */
  | "idle"
  /** Completed, deployed, verified or settled. */
  | "done";

export interface CardTruthWait {
  readonly on: KanbanWaitKind;
  /** The agent's one-line note, or the text a guess was read from. */
  readonly note: string;
  /** How long it has waited: "3d 2h". */
  readonly age: string;
  readonly expired: boolean;
  /** The check's latest progress line ("CI 3 of 5 passed"), or null. */
  readonly status: string | null;
  /** Its check failed several times in a row: nothing can end the wait until it works. */
  readonly checkFailing: boolean;
}

export interface CardTruth {
  readonly state: CardTruthState;
  /** "Waiting on the author", "Blocked by #12, #14", "Idle 3d 2h". */
  readonly label: string;
  readonly wait: CardTruthWait | null;
  /** True when the wait was guessed from free text on a card with no `wait` of its own. */
  readonly derived: boolean;
  /** Why the card belongs in a Stuck view, or null. */
  readonly stuckReason: string | null;
}

export interface CardTruthHints {
  /** The card's history, when the caller has it loaded (the board feed doesn't carry it). */
  readonly events?: ReadonlyArray<KanbanCardEvent> | undefined;
  /** The card's full wake note, when loaded; the feed only says one is pending. */
  readonly wakeNote?: string | null | undefined;
  readonly timeZone?: string | undefined;
}

/** A thread with no turn running for this long is quiet (the server's WORKER_QUIET_MS). */
export const TRUTH_QUIET_MS = 30 * 60 * 1000;
/** A review-stage card nothing runs and nothing explains shows as stuck after this long. */
export const TRUTH_IDLE_STUCK_MS = 24 * 60 * 60 * 1000;

const age = (atIso: string, nowMs: number) => ageView(atIso, nowMs)?.label ?? "";
const elapsed = (atIso: string, nowMs: number) => {
  const ms = nowMs - Date.parse(atIso);
  return Number.isFinite(ms) ? ms : 0;
};
const prNumber = (url: string | null) => {
  const match = url === null ? null : /\/(?:pull|pulls|merge_requests)\/(\d+)/.exec(url);
  return match ? ` (PR #${match[1]})` : "";
};

/** "15:41" for later today, "Sat 14 Nov 09:00" for another day. */
function untilLabel(untilIso: string, nowMs: number, timeZone?: string): string {
  const time = formatTimeOfDay(untilIso, timeZone);
  // clockLabel gives the time for today and the day for any other date.
  const clock = clockLabel(untilIso, nowMs, timeZone);
  return clock === time ? time : `${clock} ${time}`;
}

function waitLabel(
  on: KanbanWaitKind,
  detail: {
    readonly pr: string | null;
    readonly cardNumber: number | null;
    readonly until: string | null;
    readonly ask: string | null;
    readonly script?: string | null;
  },
  nowMs: number,
  timeZone?: string,
): string {
  switch (on) {
    case "push":
      return `Waiting on the author${prNumber(detail.pr)}`;
    case "merge":
      return `Waiting on merge${prNumber(detail.pr)}`;
    case "ci":
      return `Waiting on CI${prNumber(detail.pr)}`;
    case "owner_go":
      return detail.ask === null
        ? "Held for the owner's go"
        : `Held for the owner's go (${detail.ask})`;
    case "card":
      return detail.cardNumber === null
        ? "Held for another card"
        : `Held for #${detail.cardNumber}`;
    case "time":
      return detail.until === null
        ? "Held for a recheck"
        : `Held until ${untilLabel(detail.until, nowMs, timeZone)}`;
    case "script":
      return detail.script ? `Waiting: ${detail.script}` : "Waiting on a script";
  }
}

const base = (
  state: CardTruthState,
  label: string,
  stuckReason: string | null = null,
): CardTruth => ({
  state,
  label,
  wait: null,
  derived: false,
  stuckReason,
});

function fromWait(
  wait: KanbanWait,
  state: KanbanBoardState,
  nowMs: number,
  timeZone?: string,
): CardTruth {
  const target = wait.card === null ? undefined : state.cards.get(wait.card);
  const label = waitLabel(
    wait.on,
    {
      pr: wait.pr,
      cardNumber: target?.number ?? null,
      until: wait.until,
      ask: wait.ask,
      script: wait.script,
    },
    nowMs,
    timeZone,
  );
  const expired = kanbanWaitExpired(wait, nowMs);
  const checkFailing = kanbanWaitCheckFailing(wait);
  const since = age(wait.at, nowMs);
  return {
    state: "waiting",
    // The label says so itself: a failing check means nothing is watching for the wake.
    label: checkFailing ? `${label} (check failing)` : label,
    wait: { on: wait.on, note: wait.note, age: since, expired, status: wait.status, checkFailing },
    derived: false,
    stuckReason: checkFailing
      ? `${label}: its check failed ${wait.failures} times in a row${wait.problem ? ` (${wait.problem})` : ""}`
      : expired
        ? `${label} for ${since}, past its limit${wait.note.trim() ? `: ${wait.note.trim()}` : ""}`
        : null,
  };
}

function fromGuess(
  guess: WaitGuess,
  sinceIso: string,
  nowMs: number,
  timeZone?: string,
): CardTruth {
  const label = waitLabel(
    guess.on,
    { pr: null, cardNumber: guess.cardNumber, until: null, ask: null },
    nowMs,
    timeZone,
  );
  // A guess has no deadline of its own: it borrows its kind's, counted from the text's date.
  const limit = KANBAN_WAIT_LIMIT_MS[guess.on] ?? TRUTH_IDLE_STUCK_MS;
  const expired = elapsed(sinceIso, nowMs) >= limit;
  const since = age(sinceIso, nowMs);
  return {
    state: "waiting",
    label,
    wait: {
      on: guess.on,
      note: guess.from,
      age: since,
      expired,
      status: null,
      checkFailing: false,
    },
    derived: true,
    stuckReason: expired ? `${label} for ${since} (a guess from "${guess.from}")` : null,
  };
}

/** Every unfinished card in `blockedBy`, lowest number first. */
export function cardOpenBlockers(
  card: KanbanCard,
  state: KanbanBoardState,
): ReadonlyArray<KanbanCard> {
  return card.blockedBy
    .flatMap((id) => {
      const blocker = state.cards.get(id);
      if (blocker === undefined || blocker.settledAt !== null) return [];
      return KANBAN_DONE_STAGES.has(blocker.stage) && !kanbanAwaitsMerge(blocker) ? [] : [blocker];
    })
    .sort((a, b) => a.number - b.number);
}

const reviewPassed = (card: KanbanCard, state: KanbanBoardState): boolean => {
  const chains = state.board.reviewChains ?? [];
  const name = card.reviewChain ?? state.board.defaultReviewChain;
  const chain = chains.find((entry) => entry.name === name) ?? chains[0];
  return card.reviewStep >= Math.max(chain?.steps.length ?? 1, 1);
};

/**
 * The texts a wait can be guessed from, most direct first: the stalled
 * reason, the newest comment, flag or move note (when history is loaded), the
 * wake note, the open subtasks of the step the card is on, then link labels.
 */
function guessTexts(card: KanbanCard, hints: CardTruthHints): ReadonlyArray<string | null> {
  const bodies = (hints.events ?? [])
    .filter(
      (event) =>
        (event.kind === "comment" || event.kind === "flagged" || event.kind === "moved") &&
        event.body !== null &&
        event.actor._tag !== "owner",
    )
    .map((event) => event.body);
  // The newest five, newest first.
  const recent: Array<string | null> = [];
  for (let index = bodies.length - 1; index >= Math.max(0, bodies.length - 5); index -= 1) {
    recent.push(bodies[index] ?? null);
  }
  const wakeNote = hints.wakeNote ?? (card.wakeNote === "pending" ? null : card.wakeNote);
  return [
    card.stalled?.reason ?? null,
    ...recent,
    wakeNote,
    ...kanbanStepSubtasks(card).map((subtask) => subtask.text),
    ...card.links.map((link) => link.label),
  ];
}

function threadTruth(
  card: KanbanCard,
  state: KanbanBoardState,
  nowMs: number,
  hints: CardTruthHints,
): CardTruth {
  const reviewing = card.activeRole === "review";
  const thread = card.activeThreadId === null ? undefined : state.threads.get(card.activeThreadId);
  // Its state hasn't arrived yet (or couldn't be read): it has a thread, so it counts as moving.
  if (thread === undefined || thread.running) {
    // The card's own record says so (kanbanRetrying): the retried turn is the one running.
    const retry = kanbanRetrying(card);
    if (retry !== undefined && retry.role === (reviewing ? "review" : "work")) {
      return base(
        "retrying",
        retry.kind === "no_verdict"
          ? "Reviewing again after no verdict"
          : reviewing
            ? "Reviewing again after a failed run"
            : "Retrying after a failed run",
      );
    }
    return reviewing ? base("reviewing", "Reviewing") : base("running", "Running");
  }
  const who = reviewing ? "Reviewer" : "Worker";
  if (thread.needsInput) {
    const label = `${who} is waiting on its own question`;
    return base(reviewing ? "reviewing" : "running", label, label);
  }
  const since = thread.lastActivityAt ?? card.movedAt;
  const quiet = elapsed(since, nowMs);
  const label = `${who} idle ${age(since, nowMs)}`;
  return base(
    "idle",
    label,
    quiet >= TRUTH_QUIET_MS
      ? `${who} thread has been idle for ${age(since, nowMs)} with the card still in ${reviewing ? "In Review" : "Working"}`
      : null,
  );
}

/**
 * A card's true state. `wait` on the card is the truth when it is there; a
 * card without one gets a best-effort guess from its free text, marked
 * `derived`. Pure: the same card, board and clock give the same answer.
 */
export function cardTruth(
  card: KanbanCard,
  state: KanbanBoardState,
  nowMs: number,
  hints: CardTruthHints = {},
): CardTruth {
  if (card.settledAt !== null) return base("done", "Settled");
  if (card.activeThreadId !== null) return threadTruth(card, state, nowMs, hints);
  if (card.wait !== undefined && kanbanWaiting(card)) {
    return fromWait(card.wait, state, nowMs, hints.timeZone);
  }
  // Its wait ended in a way only the evaluator can take on: held until that turn is over.
  if (kanbanDeciding(card, nowMs)) return base("evaluator", "Evaluator deciding");
  if (card.stage === "needs_owner") return base("owner", "Waiting on the owner");
  if (KANBAN_DONE_STAGES.has(card.stage)) {
    if (card.stage !== "verified" && (kanbanEvaluatorStep(card) || kanbanScriptStep(card))) {
      const ids = kanbanStepSubtasks(card)
        .map((subtask) => subtask.id)
        .join(", ");
      return base(
        "evaluator",
        kanbanScriptStep(card) ? `Script's step: ${ids}` : `Evaluator's step: ${ids}`,
      );
    }
    return base("done", "Done");
  }

  if (card.stalled !== null) {
    // Agents parked cards with a stalled flag before waits existed: read it as one when it says so.
    const guess = guessWaitFrom([card.stalled.reason]);
    if (guess !== null) return fromGuess(guess, card.stalled.at, nowMs, hints.timeZone);
    // A flagged card is past its retry: the board keeps no retry record on it.
    const failed = card.stalled.by._tag === "system";
    const label = failed ? "Failed" : "Stalled";
    return base("failed", label, `${label} ${age(card.stalled.at, nowMs)}: ${card.stalled.reason}`);
  }

  // Back in its queue for the one automatic retry. Not "ready": the dispatcher holds
  // it until the backoff is over, and after that it waits for a slot like any card.
  const retry = kanbanRetrying(card);
  if (retry !== undefined && (card.stage === "todo" || card.stage === "needs_review")) {
    const notBefore = kanbanRetryNotBefore(card);
    return base(
      "retrying",
      retry.kind === "no_verdict"
        ? "No verdict, review is queued again"
        : notBefore !== null && nowMs < notBefore
          ? "Run failed, retrying shortly"
          : "Run failed, retry is queued",
    );
  }

  if (card.stage === "working") {
    // Working always has a thread; one without is between a failed start and the board's repair.
    const since = age(card.movedAt, nowMs);
    return base(
      "idle",
      "No thread",
      elapsed(card.movedAt, nowMs) >= TRUTH_QUIET_MS
        ? `In Working for ${since} with no thread`
        : null,
    );
  }
  if (card.stage === "todo") {
    if (card.priority === KANBAN_BACKLOG) return base("blocked", "In the backlog");
    if (state.board.setup?.status === "running") return base("blocked", "Setup is running");
    if (kanbanWaitsOnEvaluator(card)) {
      return base(
        "evaluator",
        kanbanScriptStep(card) ? "Waits on a script" : "Waits on the evaluator",
      );
    }
    if (kanbanHeldUpBy(card, state.cards) !== undefined) {
      const blockers = cardOpenBlockers(card, state);
      return base(
        "blocked",
        blockers.length === 0
          ? "Blocked"
          : `Blocked by ${blockers.map((blocker) => `#${blocker.number}`).join(", ")}`,
      );
    }
    return base("ready", "Ready");
  }

  if (card.stage === "needs_review") {
    return state.board.setup?.status === "running"
      ? base("blocked", "Setup is running")
      : base("ready", "Ready for review");
  }

  // In Review with no thread: its review is over, or it was parked.
  const guess = guessWaitFrom(guessTexts(card, hints));
  if (guess !== null) return fromGuess(guess, card.movedAt, nowMs, hints.timeZone);
  if (kanbanEvaluatorStep(card) || kanbanScriptStep(card)) {
    const ids = kanbanStepSubtasks(card)
      .map((subtask) => subtask.id)
      .join(", ");
    const label = kanbanScriptStep(card) ? `Script's step: ${ids}` : `Evaluator's step: ${ids}`;
    const waited = elapsed(card.movedAt, nowMs);
    return base(
      "evaluator",
      label,
      waited >= TRUTH_IDLE_STUCK_MS
        ? `Review passed ${age(card.movedAt, nowMs)} ago and ${ids} is still open`
        : null,
    );
  }
  const open = card.links.find(
    (link) => link.kind === "pr" && (link.state === "open" || link.state === "draft"),
  );
  if (open !== undefined && reviewPassed(card, state)) {
    // Not a guess: a reviewed card stays in review until its tracked PRs land.
    const label = `Waiting on merge${prNumber(open.url)}`;
    const since = age(card.movedAt, nowMs);
    return {
      state: "waiting",
      label,
      wait: {
        on: "merge",
        note: "Review passed; the card completes when its PRs land",
        age: since,
        expired: false,
        status: null,
        checkFailing: false,
      },
      derived: false,
      stuckReason:
        elapsed(card.movedAt, nowMs) >= (KANBAN_WAIT_LIMIT_MS.merge ?? TRUTH_IDLE_STUCK_MS)
          ? `Review passed ${since} ago and the PR is still open`
          : null,
    };
  }
  const since = age(card.movedAt, nowMs);
  return base(
    "idle",
    `Idle ${since}`,
    elapsed(card.movedAt, nowMs) >= TRUTH_IDLE_STUCK_MS
      ? `Idle ${since} in In Review: no reviewer, no wait and no next step recorded`
      : null,
  );
}

/** Cards that belong in a Stuck view, longest in their stage first, each with why. */
export function stuckCards(
  state: KanbanBoardState,
  nowMs: number,
): ReadonlyArray<{
  readonly card: KanbanCard;
  readonly truth: CardTruth;
  readonly reason: string;
}> {
  const stuck: Array<{ card: KanbanCard; truth: CardTruth; reason: string }> = [];
  for (const card of state.cards.values()) {
    const truth = cardTruth(card, state, nowMs);
    if (truth.stuckReason !== null) stuck.push({ card, truth, reason: truth.stuckReason });
  }
  return stuck.sort(
    (a, b) => a.card.movedAt.localeCompare(b.card.movedAt) || a.card.number - b.card.number,
  );
}
