import { kanbanOpenAsks, type KanbanCard, type KanbanCardEvent } from "@t3tools/contracts";

import { TILE_COLUMN_LABELS, type TileLine, type TilePlace } from "./tilePlace.ts";
import { STAGE_LABELS } from "./viewModel.ts";

/**
 * The card a drawer shows.
 *
 * The board feed's copy of a card is live but trimmed: no description or prompt,
 * the wake note only as "pending", long titles, questions, asks and subtask
 * texts cut short and subtask notes left out. The card read on its own has all
 * of it but can be a moment behind the feed. So: the newer of the two for
 * everything that changes as the board works, and the long texts always from
 * the full read.
 *
 * `loaded` is false until the full card has arrived. A drawer must not show a
 * missing description as "no description" before then.
 */
export function drawerCard(
  feed: KanbanCard,
  full: KanbanCard | undefined,
): { readonly card: KanbanCard; readonly loaded: boolean } {
  if (full === undefined || full.id !== feed.id) return { card: feed, loaded: false };
  if (full.updatedAt >= feed.updatedAt) return { card: full, loaded: true };
  // The feed is ahead: keep its state, put back the texts it trimmed.
  const whole = (short: string, long: string) => (long.startsWith(short) ? long : short);
  const subtasks = new Map(full.subtasks.map((subtask) => [subtask.id, subtask]));
  const asks = new Map(full.asks.map((ask) => [ask.id, ask]));
  return {
    loaded: true,
    card: {
      ...feed,
      title: whole(feed.title, full.title),
      description: full.description,
      prompt: full.prompt,
      wakeNote: feed.wakeNote === "pending" ? (full.wakeNote ?? feed.wakeNote) : feed.wakeNote,
      question:
        feed.question === null || full.question === null
          ? feed.question
          : whole(feed.question, full.question),
      stalled:
        feed.stalled === null || full.stalled === null
          ? feed.stalled
          : { ...feed.stalled, reason: whole(feed.stalled.reason, full.stalled.reason) },
      subtasks: feed.subtasks.map((subtask) => {
        const known = subtasks.get(subtask.id);
        return known === undefined
          ? subtask
          : {
              ...subtask,
              text: whole(subtask.text, known.text),
              note: subtask.note ?? known.note,
            };
      }),
      asks: feed.asks.map((ask) => {
        const known = asks.get(ask.id);
        return known === undefined ? ask : { ...ask, text: whole(ask.text, known.text) };
      }),
    },
  };
}

/** What a drawer's header says about where the card is and what it waits on. */
export interface CardStateView {
  /** The board column the card is in: "Reviewing", "In review, waiting", "Needs you". */
  readonly column: string;
  /** The card waits on the reader: the header marks it. */
  readonly needsYou: boolean;
  /** What it waits on, in the tile's own words; null when `plain` says it. */
  readonly line: TileLine | null;
  /** What it waits on when the tile has no line: "Nothing. A worker is on it." */
  readonly plain: string | null;
  /** How many cards this one holds up. */
  readonly unblocks: number;
}

/**
 * The drawer header's true state. It reads the same placement the board's tile
 * does, so a card never says one thing in its column and another when opened.
 */
export function cardStateView(card: KanbanCard, place: TilePlace, unblocks: number): CardStateView {
  const settled = card.settledAt !== null;
  const column =
    place.column === "shipped" ? STAGE_LABELS[card.stage] : TILE_COLUMN_LABELS[place.column];
  const asks = settled ? 0 : kanbanOpenAsks(card).length;
  let plain: string | null = null;
  if (settled) plain = "Nothing. It is settled.";
  else if (place.column === "needs_owner") {
    plain =
      asks > 1
        ? `Your answer to ${asks} asks`
        : asks === 1
          ? "Your answer to one ask"
          : "Your answer";
  } else if (place.line === null) {
    switch (place.group) {
      case "running":
        plain = "Nothing. A worker is on it.";
        break;
      case "reviewing":
        plain = "Nothing. A reviewer is on it.";
        break;
      case "ready":
      case "through":
        plain = "A free slot. Next up by what it unblocks.";
        break;
      case "next":
        plain = "A free reviewer. Next up for review.";
        break;
      default:
        plain = "Nothing";
    }
  }
  return {
    column,
    needsYou: place.column === "needs_owner" && !settled,
    line: plain === null ? place.line : null,
    plain,
    unblocks: settled ? 0 : unblocks,
  };
}

/** One line of a card's history. */
export interface CardHistoryLine {
  readonly id: number;
  readonly at: string;
  /**
   * `wait`: a wait was set. `wake`: a wait ended and the card carries on.
   * `expired`: a wait ran past its limit or its check keeps failing. `flag`: flagged.
   * `plain`: everything else, including kinds this build doesn't know.
   */
  readonly kind: "move" | "wait" | "wake" | "expired" | "flag" | "plain";
  /** The line. An ISO instant in it is split out so the reader's clock can show it. */
  readonly parts: ReadonlyArray<string | { readonly at: string }>;
  /** A stage change that came with the event: "In review → To-Do". */
  readonly moved: string | null;
  readonly actor: KanbanCardEvent["actor"]["_tag"];
}

const ISO_INSTANT = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})/g;

function withInstants(text: string): CardHistoryLine["parts"] {
  const parts: Array<string | { readonly at: string }> = [];
  let from = 0;
  for (const match of text.matchAll(ISO_INSTANT)) {
    if (match.index > from) parts.push(text.slice(from, match.index));
    parts.push({ at: match[0] });
    from = match.index + match[0].length;
  }
  if (from < text.length) parts.push(text.slice(from));
  return parts;
}

/**
 * Which wait event a body is. Until every client knows the wait kinds the server
 * stores them as plain edits, so the wording is what tells them apart.
 */
function waitKindOf(body: string): "wait" | "wake" | "expired" | null {
  if (/^Waiting (for|until) /.test(body)) return "wait";
  if (/^(Wait ended: |No longer held for the evaluator)/.test(body)) return "wake";
  if (/^(Wait expired: |Wait check failing: )/.test(body)) return "expired";
  return null;
}

const stagesOf = (event: KanbanCardEvent): string | null =>
  event.toStage === null || event.fromStage === event.toStage
    ? null
    : `${event.fromStage === null ? "New" : STAGE_LABELS[event.fromStage]} → ${STAGE_LABELS[event.toStage]}`;

/**
 * A card's history as the drawer lists it, newest first: moves, waits set, ended
 * and expired, flags, reviews and edits. Comments, threads, links and plan steps
 * have their own places in the drawer. A kind this build doesn't know is a plain
 * line with whatever the event says.
 */
export function cardHistory(events: ReadonlyArray<KanbanCardEvent>): CardHistoryLine[] {
  const lines: CardHistoryLine[] = [];
  for (const event of events) {
    const body = event.body?.trim() ?? "";
    const base = { id: event.id, at: event.at, actor: event.actor._tag };
    const waitKind =
      event.kind === "wait_set"
        ? "wait"
        : event.kind === "wait_cleared"
          ? "wake"
          : event.kind === "wait_expired"
            ? "expired"
            : event.kind === "edited"
              ? waitKindOf(body)
              : null;
    if (waitKind !== null) {
      const fallback =
        waitKind === "wait" ? "Waiting" : waitKind === "wake" ? "Wait ended" : "Wait expired";
      lines.push({
        ...base,
        kind: waitKind,
        parts: withInstants(body || fallback),
        moved: stagesOf(event),
      });
      continue;
    }
    switch (event.kind) {
      case "comment":
      case "thread":
      case "linked":
      case "subtask":
        break;
      case "created":
        lines.push({ ...base, kind: "plain", parts: ["Created"], moved: null });
        break;
      case "moved": {
        const moved = stagesOf(event);
        if (moved !== null) lines.push({ ...base, kind: "move", parts: [moved], moved: null });
        break;
      }
      case "review": {
        // One finding per "- " line; a finding may run over several lines.
        const listed = body.split("\n").filter((entry) => /^\s*[-*]\s+\S/.test(entry)).length;
        const findings = body === "" || body === "clear" ? 0 : Math.max(1, listed);
        lines.push({
          ...base,
          kind: "plain",
          parts: [
            findings === 0
              ? "Review passed"
              : `Review found ${findings} ${findings === 1 ? "thing" : "things"}`,
          ],
          moved: stagesOf(event),
        });
        break;
      }
      case "flagged": {
        const cleared = body === "" || /^clear(ed)?$/i.test(body);
        lines.push({
          ...base,
          kind: cleared ? "plain" : "flag",
          parts: [cleared ? "Flag cleared" : `Flagged: ${body}`],
          moved: stagesOf(event),
        });
        break;
      }
      case "edited":
        lines.push({
          ...base,
          kind: "plain",
          // "Settled", "Scribe put it in goal ..." read by themselves; a bare field list doesn't.
          parts: [body === "" ? "Edited" : /^[A-Z]/.test(body) ? body : `Edited: ${body}`],
          moved: stagesOf(event),
        });
        break;
      default:
        lines.push({
          ...base,
          kind: "plain",
          parts: withInstants(body || "Update"),
          moved: stagesOf(event),
        });
    }
  }
  // Newest first by when it happened; events of one instant keep the order they were written in.
  return lines.sort((a, b) => (a.at === b.at ? b.id - a.id : a.at < b.at ? 1 : -1));
}
