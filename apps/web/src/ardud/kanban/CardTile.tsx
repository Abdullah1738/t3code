import { LockOpenIcon, OctagonXIcon, PauseIcon, RotateCwIcon } from "lucide-react";
import { memo } from "react";

import type { BoardTileView, TileLine } from "@t3tools/client-runtime/ardud/kanban";
import { ageView, clockLabel, formatTimeOfDay } from "@t3tools/client-runtime/ardud/common";

import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { useBoardClock } from "./useBoardClock";
import { Chip, flagGlyph, Glyph, ModelMark, Pri, stageGlyph, UnreadDot } from "./parts";

const DAY_MS = 24 * 60 * 60 * 1000;
const dayMonth = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });

/** How long ago, counted against the board's one shared clock so no tile runs a timer. */
export function CardAge(props: { since: string; prefix?: string }) {
  const label = ageView(props.since, useBoardClock())?.label ?? "";
  if (props.prefix === undefined) return label;
  return label && label !== "now" ? `${props.prefix} ${label}` : props.prefix;
}

/** "Idle 1d 9h", "Waiting on the author since 28 Oct", "... for 8h" within the first day. */
function sinceText(line: TileLine, nowMs: number): string {
  if (line.since === null) return "";
  const age = ageView(line.since, nowMs)?.label ?? "";
  if (age === "" || age === "now") return "";
  if (line.sinceAs === "age") return ` ${age}`;
  const at = Date.parse(line.since);
  return nowMs - at < DAY_MS ? ` for ${age}` : ` since ${dayMonth.format(at)}`;
}

/** "15:41" for today, "Sat 14 Nov 09:00" for another day. */
export function clockTime(atIso: string, nowMs: number): string {
  const time = formatTimeOfDay(atIso);
  const clock = clockLabel(atIso, nowMs);
  return clock === time ? time : `${clock} ${time}`;
}

const LINE_ICONS = { pause: PauseIcon, retry: RotateCwIcon, stop: OctagonXIcon } as const;
const LINE_TONES = {
  muted: "text-(--m-muted)",
  warn: "text-(--m-warning)",
  negative: "text-(--m-negative)",
} as const;

/**
 * The one line that matters: why the card is where it is, then what moves it next.
 * `roomy` is the drawer's size: body text, nothing cut.
 */
export function TileWhy(props: { line: TileLine; clamp?: boolean; roomy?: boolean }) {
  const nowMs = useBoardClock();
  const { line } = props;
  const Icon = LINE_ICONS[line.icon];
  const wake =
    line.wake === null
      ? null
      : line.wakeAt === null
        ? line.wake
        : `${line.wake} ${clockTime(line.wakeAt, nowMs)}`;
  return (
    <span
      className={cn(
        "flex min-w-0 flex-col gap-0.5 leading-snug",
        props.roomy ? "text-sm pointer-coarse:text-base" : "text-xs pointer-coarse:text-sm",
      )}
    >
      <span className={cn("flex min-w-0 items-start gap-1.5", LINE_TONES[line.tone])}>
        <Icon
          aria-hidden
          className={cn(
            "shrink-0",
            props.roomy ? "mt-0.75 size-3.5" : "mt-0.5 size-3 pointer-coarse:size-3.5",
          )}
        />
        <span className={cn("min-w-0 wrap-break-word", props.clamp !== false && "line-clamp-2")}>
          {line.lead}
          {sinceText(line, nowMs)}
          {line.rest === null ? "" : `: ${line.rest}`}
        </span>
      </span>
      {wake === null ? null : (
        <span
          className={cn("text-(--m-muted)", props.roomy ? "ps-5" : "ps-4.5 pointer-coarse:ps-5")}
        >
          {wake}
        </span>
      )}
    </span>
  );
}

export const CardTile = memo(function CardTile(props: {
  card: BoardTileView;
  selected: boolean;
  /** In the Needs you column: on its tinted well, and showing the ask rather than the state. */
  raised?: boolean;
  /** Similar and other groupings show the stage instead of the goal. */
  showStage?: boolean;
  onOpen: (cardId: string) => void;
}) {
  const { card } = props;
  // Needs you is about the question; every other column is about what the card is doing.
  const ask = props.raised && card.flag?.kind === "ask" ? card.flag : null;
  const line = ask === null ? card.line : null;
  const flag = ask ?? (line === null ? card.flag : null);
  const failed = card.edge === "fail" || (line === null && card.flag?.kind === "stalled");
  return (
    <button
      type="button"
      onClick={() => props.onOpen(card.id)}
      aria-current={props.selected ? "true" : undefined}
      className={cn(
        "flex w-full min-w-0 flex-col gap-1.5 rounded-xl px-2.75 pt-2.25 pb-2.5 text-left text-sm text-(--m-text) outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent) pointer-coarse:gap-2 pointer-coarse:px-3.5 pointer-coarse:pt-3 pointer-coarse:pb-3 pointer-coarse:text-base",
        props.raised ? "bg-(--m-raised)" : "bg-(--m-surface)",
        props.selected
          ? "ring-2 ring-inset ring-(--m-text)"
          : failed
            ? "ring-1 ring-inset ring-(--m-negative) hover:bg-(--m-active)"
            : card.edge === "retry"
              ? "ring-1 ring-inset ring-(--m-warning) hover:bg-(--m-active)"
              : "hover:bg-(--m-active)",
      )}
    >
      <span className="flex items-center gap-1.75 text-xs text-(--m-muted) pointer-coarse:text-sm">
        <Pri priority={card.priority} />
        <span className="tabular-nums">#{card.number}</span>
        {card.unread > 0 ? <UnreadDot label={`${card.unread} unread`} /> : null}
        {card.settled ? <span>Settled</span> : null}
        <span className="ms-auto tabular-nums">
          <CardAge since={card.movedAt} />
        </span>
      </span>
      <span className="line-clamp-2 leading-snug font-medium wrap-break-word">{card.title}</span>
      {line ? <TileWhy line={line} /> : null}
      {flag ? (
        <span
          className={cn(
            "flex gap-1.5 text-xs pointer-coarse:text-sm",
            flag.kind === "stalled" && "items-center font-medium text-(--m-negative)",
            flag.kind === "blocked" && "items-center text-(--m-muted)",
            flag.kind === "ask" &&
              cn(
                "items-start leading-snug",
                flag.blocking ? "text-(--m-text)" : "text-(--m-muted)",
              ),
          )}
        >
          <Glyph kind={flagGlyph(flag)} className={flag.kind === "ask" ? "mt-0.75" : undefined} />
          <span className={flag.kind === "ask" ? "line-clamp-3 wrap-break-word" : "truncate"}>
            {card.flagSince !== null && flag.kind === "stalled" ? (
              <CardAge since={card.flagSince} prefix={flag.label} />
            ) : (
              flag.label
            )}
          </span>
        </span>
      ) : null}
      {card.unblocks > 0 ? (
        <span className="flex items-center gap-1 text-xs font-medium text-(--m-accent-text) tabular-nums pointer-coarse:text-sm">
          <LockOpenIcon aria-hidden className="size-3 shrink-0" />
          Unblocks {card.unblocks.toLocaleString("en-US")}
        </span>
      ) : null}
      <span className="flex min-w-0 items-center gap-1.25">
        {props.showStage ? (
          <Chip>
            <Glyph kind={stageGlyph(card.stage)} />
            {card.stageLabel}
          </Chip>
        ) : card.goal ? (
          // Flex shrink weighs a long PR label by its full text and squeezes the goal
          // to one letter, so beside a PR the goal holds up to half the row.
          <Chip className={cn("min-w-0", card.pr ? "max-w-1/2 shrink-0" : "shrink")}>
            <span className="truncate">{card.goal.name}</span>
          </Chip>
        ) : null}
        {card.pr ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="inline-flex min-w-0 shrink items-center gap-1 px-1 text-xs font-medium tabular-nums pointer-coarse:text-sm" />
              }
            >
              <PrGlyph state={card.pr.state} />
              <span className="truncate">{card.pr.label}</span>
            </TooltipTrigger>
            <TooltipPopup>{card.pr.label}</TooltipPopup>
          </Tooltip>
        ) : null}
        <span className="flex-1" />
        {card.subtasks ? (
          <span
            className="shrink-0 px-1 text-xs text-(--m-muted) tabular-nums pointer-coarse:text-sm"
            aria-label={`${card.subtasks.done} of ${card.subtasks.total} subtasks done`}
          >
            {card.subtasks.done}/{card.subtasks.total}
          </span>
        ) : null}
        {card.needsInput ? (
          <Glyph kind="ask" label="Stuck on its own question" />
        ) : card.running ? (
          <Glyph kind="ok" label="Running" />
        ) : null}
        <ModelMark name={card.model.name} letter={card.model.letter} />
      </span>
    </button>
  );
});

/** Pull request mark: a branch for open, a filled dot once merged. */
export function PrGlyph(props: { state: string | null }) {
  const merged = props.state === "merged";
  const closed = props.state === "closed";
  return (
    <svg viewBox="0 0 12 12" className="size-3 shrink-0" aria-hidden>
      <circle cx="3" cy="2.5" r="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <circle
        cx="3"
        cy="9.5"
        r="1.5"
        fill={merged ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <circle
        cx="9"
        cy="9.5"
        r="1.5"
        fill={closed ? "none" : "currentColor"}
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path
        d="M3 4v4M9 8V5.5A2 2 0 0 0 7 3.5H5.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  );
}
