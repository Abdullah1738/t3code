/**
 * Whether the figures a Needs-you screen shows are known. A count is a claim:
 * "0 to answer" says nothing waits on him, and that is only true once a read
 * said so. Every screen that shows a count asks here first, so no screen
 * shows a number, or "nothing", for a read that has not come back or failed.
 *
 * - `unknown`: nothing has been read. No figures at all: a loading state
 *   while the first read is out (`failed: false`), or "couldn't load" with
 *   Retry once it failed or there is no connection (`failed: true`).
 * - `known`: read, and the server is reachable as far as anyone knows.
 * - `stale`: an earlier read is held and the server can't be reached now. The
 *   held figures show, marked with the time they were read: not as current.
 */
import type { AskState } from "./askStore.ts";
import { shortWhen } from "./snoozeTimes.ts";

export type AskFigures =
  | { readonly state: "unknown"; readonly failed: false; readonly error: null }
  | { readonly state: "unknown"; readonly failed: true; readonly error: string }
  | { readonly state: "known" }
  | { readonly state: "stale"; readonly readAt: string; readonly error: string };

const LOADING: AskFigures = { state: "unknown", failed: false, error: null };
const KNOWN: AskFigures = { state: "known" };

type QueueRead = Pick<AskState, "feed" | "status" | "error">;

/** The open asks' figures: how many are his to answer, wait on agents, are put away. */
export function askQueueFigures(read: QueueRead): AskFigures {
  if (read.feed === null) {
    return read.status === "error"
      ? { state: "unknown", failed: true, error: read.error ?? "Couldn't load asks." }
      : LOADING;
  }
  return read.error === null ? KNOWN : { state: "stale", readAt: read.feed.at, error: read.error };
}

type HistoryRead = QueueRead &
  Pick<AskState, "closed" | "closedStatus" | "closedAt" | "closedError">;

/**
 * History's figures: what he answered today, counted from the closed asks,
 * beside two figures of the open queue. They are known only when both reads
 * are: History with no closed asks read has no figures, whatever the queue
 * holds, and a queue that can't be reached makes held History stale too.
 */
export function askHistoryFigures(read: HistoryRead): AskFigures {
  const queue = askQueueFigures(read);
  // The server can't be reached now, in the queue's own words.
  const unreachable = queue.state === "known" || queue.error === null ? null : queue.error;
  if (read.closed === null) {
    return read.closedStatus === "error" || unreachable !== null
      ? {
          state: "unknown",
          failed: true,
          error: read.closedError ?? unreachable ?? "Couldn't load History.",
        }
      : LOADING;
  }
  // Closed asks are held without the queue: not a state the store makes, and not known.
  if (queue.state === "unknown") return queue;
  const error = read.closedError ?? unreachable;
  return error === null
    ? KNOWN
    : { state: "stale", readAt: read.closedAt ?? read.feed?.at ?? "", error };
}

/** "as of 17:42" for held figures that may be out of date; null when they are current or unknown. */
export function askFiguresAsOf(figures: AskFigures, nowMs: number): string | null {
  if (figures.state !== "stale") return null;
  const when = shortWhen(figures.readAt, nowMs);
  return when === "" ? "as of the last read" : `as of ${when}`;
}

/** What a "Needs you" row shows beside its name: the sidebar's row on the web. */
export interface AskRowFigure {
  /** The number in the badge; null when no badge is shown. */
  readonly count: number | null;
  /** Quiet words beside it: "…" while the first read is out, "Not loaded", "as of 17:42". */
  readonly note: string | null;
  /** All of it, for a screen reader. */
  readonly label: string;
}

/**
 * The count on a "Needs you" row. No badge means "nothing to answer", and it
 * means that only for a read that said so: while the first read is out the
 * row says "…", after it failed "Not loaded", and a count held from an
 * earlier read carries the time it was read, a held zero too.
 */
export function askRowFigure(figures: AskFigures, count: number, nowMs: number): AskRowFigure {
  if (figures.state === "unknown") {
    return figures.failed
      ? { count: null, note: "Not loaded", label: "Asks not loaded" }
      : { count: null, note: "…", label: "Loading asks" };
  }
  const said = `${count} ${count === 1 ? "ask" : "asks"} to answer`;
  const badge = count > 0 ? count : null;
  const asOf = askFiguresAsOf(figures, nowMs);
  return asOf === null
    ? { count: badge, note: null, label: said }
    : { count: badge, note: asOf, label: `${said}, ${asOf}, may be out of date` };
}

/**
 * What a list of the open asks says when it has no rows, filters aside. "No
 * asks" is a claim like a count: it is said only for a read that came back.
 * Null while the first read is out (the list shows its loading state).
 */
export function askListEmptyLine(figures: AskFigures, nowMs: number): string | null {
  if (figures.state === "unknown") return figures.failed ? "Couldn't load asks" : null;
  const asOf = askFiguresAsOf(figures, nowMs);
  return asOf === null ? "No asks" : `No asks, ${asOf}`;
}
