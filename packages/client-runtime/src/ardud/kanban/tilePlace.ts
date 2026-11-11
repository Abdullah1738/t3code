import {
  KANBAN_BACKLOG,
  KANBAN_DONE_STAGES,
  KANBAN_WAIT_LIMIT_MS,
  kanbanDeciding,
  kanbanRetryNotBefore,
  kanbanRetrying,
  kanbanScriptStep,
  kanbanStepSubtasks,
  type KanbanCard,
} from "@t3tools/contracts";

import type { KanbanBoardState } from "./boardState.ts";
import { cardOpenBlockers, cardTruth, type CardTruth } from "./cardTruth.ts";

/** The board's columns when grouped by stage. The keys are the column preference keys. */
export type TileColumn =
  | "todo"
  | "working"
  /** Reviewing: a reviewer is on it, or it is next up for one. */
  | "needs_review"
  /** In review, waiting: nobody is on it and something has to happen first. */
  | "in_review"
  | "shipped"
  | "needs_owner";

export type TileGroup =
  | "through"
  | "ready"
  | "running"
  | "reviewing"
  | "retry"
  | "failed"
  | "quiet"
  | "next"
  | "author"
  | "checks"
  | "held"
  | "evaluator"
  | "blocked"
  | "flagged"
  | "parked"
  | "idle"
  | "paused"
  | "owner"
  | "done";

/** Groups in the order a column lists them. */
export const TILE_GROUP_ORDER: ReadonlyArray<TileGroup> = [
  "through",
  "ready",
  "running",
  "reviewing",
  "retry",
  "failed",
  "quiet",
  "next",
  "author",
  "checks",
  "held",
  "evaluator",
  "blocked",
  "flagged",
  "parked",
  "idle",
  "paused",
];

export const TILE_GROUP_LABELS: Record<TileGroup, string> = {
  through: "Let through by the pause",
  ready: "Ready, by what they unblock",
  running: "Running",
  reviewing: "Reviewing now",
  retry: "Retrying",
  failed: "Failed after a retry",
  quiet: "Not moving",
  next: "Next up for review",
  author: "Waiting on the author",
  checks: "Waiting on merge or CI",
  held: "Held",
  evaluator: "With the evaluator",
  blocked: "Blocked",
  flagged: "Flagged",
  parked: "Flagged or parked",
  idle: "Idle",
  paused: "Held by the pause",
  owner: "Needs you",
  done: "Shipped",
};

export const TILE_COLUMN_LABELS: Record<Exclude<TileColumn, "shipped">, string> = {
  todo: "To-Do",
  working: "Working",
  needs_review: "Reviewing",
  in_review: "In review, waiting",
  needs_owner: "Needs you",
};

/** Why a card is in the Stuck lens, as the lens line counts it. */
export type StuckKind =
  | "failed"
  | "flagged"
  | "idle"
  | "author"
  | "check"
  | "wait"
  | "quiet"
  | "evaluator";

/** "1 failed after a retry, 46 idle in review": the phrase after each count. */
export const STUCK_KIND_PHRASES: Record<StuckKind, string> = {
  failed: "failed after a retry",
  flagged: "flagged",
  idle: "idle in review",
  author: `waiting on an author for over ${(KANBAN_WAIT_LIMIT_MS.push ?? 0) / 86_400_000} days`,
  check: "with a check that keeps failing",
  wait: "past their wait's limit",
  quiet: "not moving",
  evaluator: "waiting on the evaluator for over a day",
};

const STUCK_KIND_ORDER: ReadonlyArray<StuckKind> = [
  "failed",
  "flagged",
  "quiet",
  "idle",
  "author",
  "check",
  "wait",
  "evaluator",
];

/** "54 stuck: 1 failed after a retry, 46 idle in review. Every one says why." */
export function stuckSummary(counts: ReadonlyMap<StuckKind, number>): string {
  let total = 0;
  const parts: string[] = [];
  for (const kind of STUCK_KIND_ORDER) {
    const count = counts.get(kind) ?? 0;
    if (count === 0) continue;
    total += count;
    parts.push(`${count.toLocaleString("en-US")} ${STUCK_KIND_PHRASES[kind]}`);
  }
  return total === 0
    ? "Nothing is stuck."
    : `${total.toLocaleString("en-US")} stuck: ${parts.join(", ")}. Every one says why.`;
}

/**
 * The one line under a tile's title: why the card is where it is, and below it
 * what moves it next. Times are stamps, not text: the tile counts them against
 * the shared clock, so the line stays the same object while nothing changes.
 */
export interface TileLine {
  readonly icon: "pause" | "retry" | "stop";
  readonly tone: "muted" | "warn" | "negative";
  /** "Waiting on the author", "Blocked by #12, #40", "Idle". */
  readonly lead: string;
  /** Shown after the lead: as an age ("Idle 1d 9h") or a date ("since 28 Oct"). */
  readonly since: string | null;
  readonly sinceAs: "age" | "date";
  /** After a colon: the agent's note, the failure's reason. */
  readonly rest: string | null;
  /** "Wakes itself on the next push". */
  readonly wake: string | null;
  /** A time the wake line ends with: "Wakes itself at" + this. */
  readonly wakeAt: string | null;
}

export interface TilePlace {
  readonly column: TileColumn;
  readonly group: TileGroup;
  /** The bucket a folded group's breakdown counts this card under. */
  readonly reason: string | null;
  readonly line: TileLine | null;
  /** A failed card gets a red edge, a retrying one an amber edge. */
  readonly edge: "fail" | "retry" | null;
  readonly stuck: StuckKind | null;
}

const line = (
  icon: TileLine["icon"],
  tone: TileLine["tone"],
  lead: string,
  wake: string | null,
  more: {
    readonly since?: string | null | undefined;
    readonly sinceAs?: TileLine["sinceAs"] | undefined;
    readonly rest?: string | null | undefined;
    readonly wakeAt?: string | null | undefined;
  } = {},
): TileLine => ({
  icon,
  tone,
  lead,
  since: more.since ?? null,
  sinceAs: more.sinceAs ?? "age",
  rest: more.rest?.trim() ? more.rest.trim() : null,
  wake,
  wakeAt: more.wakeAt ?? null,
});

const prNumber = (url: string | null | undefined): string => {
  const match = url == null ? null : /\/(?:pull|pulls|merge_requests)\/(\d+)/.exec(url);
  return match ? ` (PR #${match[1]})` : "";
};

/** "#12", "#12, #40", "#12, #40 and #7", "#12, #40 and 5 more". */
function numberList(numbers: ReadonlyArray<number>): string {
  const tags = numbers.map((number) => `#${number}`);
  if (tags.length <= 2) return tags.join(", ");
  if (tags.length === 3) return `${tags[0]}, ${tags[1]} and ${tags[2]}`;
  return `${tags[0]}, ${tags[1]} and ${tags.length - 2} more`;
}

function allDone(numbers: ReadonlyArray<number>): string {
  if (numbers.length === 1) return `#${numbers[0]} is done`;
  if (numbers.length === 2) return "both are done";
  if (numbers.length === 3) return "all three are done";
  return `all ${numbers.length} are done`;
}

/**
 * A handle the note names with an @ ("@sharath-kc to push the fix"). The wait
 * records no author, so this is the only place a name can come from.
 */
function handleIn(note: string): string | null {
  const match = /(?:^|[\s(])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)/.exec(note);
  return match ? match[1]! : null;
}

function waitLine(card: KanbanCard, state: KanbanBoardState, truth: CardTruth): TileLine {
  const wait = card.wait;
  const info = truth.wait!;
  const tone = info.checkFailing ? "negative" : info.expired ? "warn" : "muted";
  const guessed = "A guess from the card's notes: nothing is watching for it";
  const failing = "Its check keeps failing: nothing can wake it";
  const wakes = (text: string) => (truth.derived ? guessed : info.checkFailing ? failing : text);
  const pr = prNumber(wait?.pr ?? card.links.find((link) => link.kind === "pr")?.url);
  const note = truth.derived ? "" : info.note;
  const since = truth.derived ? null : (wait?.at ?? null);
  switch (info.on) {
    case "push": {
      const who = handleIn(note) ?? "the author";
      // With a note the line is what happened; without one, since when.
      return line("pause", tone, `Waiting on ${who}`, wakes("Wakes itself on the next push"), {
        rest: note,
        ...(note.trim() ? {} : { since, sinceAs: "date" as const }),
      });
    }
    case "merge":
      return line(
        "pause",
        tone,
        `Waiting on merge${pr}`,
        wakes(
          wait === undefined
            ? "Completes by itself when the PR lands"
            : "Wakes itself when the PR merges",
        ),
        { rest: wait === undefined ? null : note },
      );
    case "ci":
      return line("pause", tone, `Waiting on CI${pr}`, wakes("Wakes itself when CI finishes"), {
        rest: info.status ?? note,
      });
    case "owner_go":
      return line("pause", tone, "Held for your go", truth.derived ? guessed : "In Needs you", {
        rest: note,
      });
    case "card": {
      const target = wait?.card == null ? undefined : state.cards.get(wait.card);
      return line(
        "pause",
        tone,
        target === undefined ? "Held behind another card" : `Held behind #${target.number}`,
        wakes(
          target === undefined
            ? "Wakes itself when that card is done"
            : `Wakes itself when #${target.number} is done`,
        ),
        { rest: note },
      );
    }
    case "time":
      return line(
        "pause",
        tone,
        "Held for a recheck",
        wakes(wait?.until == null ? "Wakes itself later" : "Wakes itself at"),
        { rest: note, wakeAt: truth.derived ? null : (wait?.until ?? null) },
      );
    case "script": {
      const script = wait?.script ?? "a script";
      return line(
        "pause",
        tone,
        `Waiting on ${script}`,
        wakes(`Wakes itself when ${script} says so`),
        {
          rest: info.status ?? note,
        },
      );
    }
  }
}

const stepIds = (card: KanbanCard) =>
  kanbanStepSubtasks(card)
    .map((subtask) => subtask.id)
    .join(", ");

/**
 * Where a card sits on the board and the line its tile shows. `kept` is the
 * pause's keep list, or null on a board that is not paused. `truth` is
 * cardTruth of the same card, board and clock.
 */
export function tilePlace(
  card: KanbanCard,
  state: KanbanBoardState,
  nowMs: number,
  kept: ReadonlySet<string> | null,
  truth: CardTruth = cardTruth(card, state, nowMs),
): TilePlace {
  const place = (
    column: TileColumn,
    group: TileGroup,
    shown: TileLine | null = null,
    more: Partial<Pick<TilePlace, "reason" | "edge" | "stuck">> = {},
  ): TilePlace => ({
    column,
    group,
    reason: more.reason ?? null,
    line: shown,
    edge: more.edge ?? null,
    // Whatever the group, a card is only in the Stuck lens when its truth says why.
    stuck: truth.stuckReason === null ? null : (more.stuck ?? "quiet"),
  });

  const stage = card.stage;
  if (card.settledAt !== null || KANBAN_DONE_STAGES.has(stage)) return place("shipped", "done");
  if (stage === "needs_owner") return place("needs_owner", "owner");

  const reviewStage = stage === "needs_review" || stage === "in_review";
  // The Reviewing column holds what a reviewer is on or takes next; the rest of review waits.
  const reviewing: TileColumn = "needs_review";
  const waiting: TileColumn = "in_review";
  const column: TileColumn = stage === "todo" ? "todo" : stage === "working" ? "working" : waiting;

  // A paused board starts and wakes only the cards on its keep list. One with a
  // thread already on it shows what that thread is doing.
  if (kept !== null && !kept.has(card.id) && card.activeThreadId === null) {
    return {
      column: stage === "needs_review" ? reviewing : column,
      group: "paused",
      reason: "Not on the keep list",
      line: line(
        "pause",
        "muted",
        "Not on the pause's keep list",
        stage === "todo"
          ? "Starts by itself when the pause lifts"
          : "Wakes itself when the pause lifts",
      ),
      edge: null,
      stuck: null,
    };
  }

  const retry = kanbanRetrying(card);
  const who = card.activeRole === "review" ? "Reviewer" : "Worker";

  switch (truth.state) {
    case "ready":
      if (stage === "needs_review") return place(reviewing, "next");
      return place(column, kept === null ? "ready" : "through");

    case "running":
    case "reviewing": {
      const home = reviewStage ? reviewing : column;
      if (truth.stuckReason !== null) {
        return place(
          home,
          "quiet",
          line(
            "stop",
            "negative",
            `${who} is waiting on its own question`,
            "Needs a look: open its thread",
          ),
          { edge: "fail", stuck: "quiet" },
        );
      }
      return place(home, truth.state === "reviewing" ? "reviewing" : "running");
    }

    case "retrying": {
      const home = reviewStage ? reviewing : column;
      const queued = card.activeThreadId === null;
      const notBefore = kanbanRetryNotBefore(card);
      const noVerdict = retry?.kind === "no_verdict";
      const lead = noVerdict
        ? "Reviewer gave no verdict"
        : retry?.role === "review"
          ? "Review run failed once"
          : "Run failed once";
      const wake = queued
        ? noVerdict
          ? "Review is queued again, try 2 of 2"
          : notBefore !== null && nowMs < notBefore
            ? "Retrying shortly, try 2 of 2"
            : "Retry is queued, try 2 of 2"
        : noVerdict || retry?.role === "review"
          ? "Reviewing again now, try 2 of 2"
          : "Retrying now, try 2 of 2";
      return place(
        home,
        "retry",
        line("retry", "warn", lead, wake, { rest: noVerdict ? null : retry?.reason }),
        {
          edge: "retry",
        },
      );
    }

    case "failed": {
      const stalled = card.stalled!;
      const failed = stalled.by._tag === "system";
      const shown = line(
        "stop",
        "negative",
        failed ? "Failed" : "Flagged",
        failed ? "Needs a look: restart it or reroute it" : "Needs a look",
        { rest: stalled.reason },
      );
      if (stage === "working") {
        return place(column, "failed", shown, {
          edge: "fail",
          stuck: failed ? "failed" : "flagged",
        });
      }
      return place(column, stage === "todo" ? "parked" : "flagged", shown, {
        edge: "fail",
        reason: "Flagged, needs a look",
        stuck: failed ? "failed" : "flagged",
      });
    }

    case "waiting": {
      const on = truth.wait!.on;
      const group: TileGroup =
        stage === "todo"
          ? "parked"
          : on === "push"
            ? "author"
            : on === "merge" || on === "ci"
              ? "checks"
              : "held";
      return place(column, group, waitLine(card, state, truth), {
        reason: "Parked on a wait",
        stuck: truth.wait!.checkFailing ? "check" : on === "push" ? "author" : "wait",
      });
    }

    case "evaluator": {
      const deciding = kanbanDeciding(card, nowMs);
      const script = kanbanScriptStep(card);
      const ids = stepIds(card);
      const shown = deciding
        ? line("pause", "muted", "Evaluator deciding", "It decides what the card does next", {
            since: card.deciding?.since ?? null,
            rest: card.deciding?.why,
          })
        : line(
            "pause",
            truth.stuckReason === null ? "muted" : "warn",
            script
              ? `Script's step${ids ? `: ${ids}` : ""}`
              : `Evaluator's step${ids ? `: ${ids}` : ""}`,
            script ? "Moves when the script has run" : "Moves when the evaluator has done it",
          );
      return place(column, stage === "todo" ? "parked" : "evaluator", shown, {
        reason: script ? "Waiting on a script" : "Waiting on the evaluator",
        stuck: "evaluator",
      });
    }

    case "blocked": {
      if (card.priority === KANBAN_BACKLOG) {
        return place(
          column,
          "parked",
          line("pause", "muted", "In the backlog", "Starts when you take it out of the backlog"),
          { reason: "In the backlog" },
        );
      }
      if (state.board.setup?.status === "running") {
        return place(
          stage === "needs_review" ? reviewing : column,
          "blocked",
          line("pause", "muted", "Setup is running", "Starts by itself when setup is done"),
          { reason: "Waiting on setup" },
        );
      }
      const numbers = cardOpenBlockers(card, state).map((blocker) => blocker.number);
      return place(
        column,
        "blocked",
        numbers.length === 0
          ? line("pause", "muted", "Blocked", null)
          : line(
              "pause",
              "muted",
              `Blocked by ${numberList(numbers)}`,
              `Starts by itself when ${allDone(numbers)}`,
            ),
        { reason: "Waiting on another card" },
      );
    }

    case "idle": {
      if (card.activeThreadId !== null) {
        // A thread is on the card but no turn runs.
        const thread = state.threads.get(card.activeThreadId);
        const stuck = truth.stuckReason !== null;
        return place(
          reviewStage ? reviewing : column,
          "quiet",
          line(
            stuck ? "stop" : "pause",
            stuck ? "negative" : "muted",
            `${who} idle`,
            stuck ? "Needs a look: its thread stopped without moving the card" : null,
            { since: thread?.lastActivityAt ?? card.movedAt },
          ),
          { edge: stuck ? "fail" : null, stuck: "quiet" },
        );
      }
      if (stage === "working") {
        const stuck = truth.stuckReason !== null;
        return place(
          column,
          "quiet",
          line(
            stuck ? "stop" : "pause",
            stuck ? "negative" : "muted",
            "No thread",
            stuck ? "Needs a look: nothing is running it" : "The board restarts it by itself",
            { since: card.movedAt },
          ),
          { edge: stuck ? "fail" : null, stuck: "quiet" },
        );
      }
      const stuck = truth.stuckReason !== null;
      return place(
        column,
        "idle",
        line(
          stuck ? "stop" : "pause",
          stuck ? "negative" : "muted",
          "Idle",
          "Needs a reviewer, or a reason to wait",
          { since: card.movedAt, rest: "no reviewer, no wait, no next step" },
        ),
        { edge: stuck ? "fail" : null, stuck: "idle" },
      );
    }

    case "owner":
    case "done":
      // Both are placed by stage above; a card can't get here.
      return place(column, "idle");
  }
}
