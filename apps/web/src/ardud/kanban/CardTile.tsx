import { memo } from "react";

import type { CardView } from "@t3tools/client-runtime/ardud/kanban";

import { cn } from "../../lib/utils";
import { Chip, flagGlyph, Glyph, ModelMark, Pri, stageGlyph, UnreadDot } from "./parts";

export const CardTile = memo(function CardTile(props: {
  card: CardView;
  selected: boolean;
  raised?: boolean;
  /** Similar and other groupings show the stage instead of the goal. */
  showStage?: boolean;
  onOpen: (cardId: string) => void;
}) {
  const { card } = props;
  const stalled = card.flag?.kind === "stalled";
  return (
    <button
      type="button"
      onClick={() => props.onOpen(card.id)}
      aria-current={props.selected ? "true" : undefined}
      className={cn(
        "flex w-full min-w-0 flex-col gap-1.5 rounded-xl px-2.75 pt-2.25 pb-2.5 text-left text-sm text-(--m-text) outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)",
        props.raised ? "bg-(--m-raised)" : "bg-(--m-surface)",
        props.selected
          ? "ring-2 ring-inset ring-(--m-text)"
          : stalled
            ? "ring-2 ring-inset ring-(--m-negative)"
            : "hover:bg-(--m-active)",
      )}
    >
      <span className="flex items-center gap-1.75 text-xs text-(--m-muted)">
        <Pri priority={card.priority} />
        <span className="tabular-nums">#{card.number}</span>
        {card.unread > 0 ? <UnreadDot label={`${card.unread} unread`} /> : null}
        <span className="ms-auto tabular-nums">{card.age}</span>
      </span>
      <span className="line-clamp-2 leading-snug font-medium">{card.title}</span>
      {card.flag ? (
        <span
          className={cn(
            "flex gap-1.5 text-xs",
            card.flag.kind === "stalled" && "items-center font-medium text-(--m-negative)",
            card.flag.kind === "blocked" && "items-center text-(--m-muted)",
            card.flag.kind === "ask" &&
              cn(
                "items-start leading-snug",
                card.flag.blocking ? "text-(--m-text)" : "text-(--m-muted)",
              ),
          )}
        >
          <Glyph
            kind={flagGlyph(card.flag)}
            className={card.flag.kind === "ask" ? "mt-0.75" : undefined}
          />
          <span className={card.flag.kind === "ask" ? "line-clamp-3" : "truncate"}>
            {card.flag.label}
          </span>
        </span>
      ) : null}
      <span className="flex min-w-0 items-center gap-1.25">
        {props.showStage ? (
          <Chip>
            <Glyph kind={stageGlyph(card.stage)} />
            {card.stageLabel}
          </Chip>
        ) : card.goal ? (
          <Chip className="min-w-0 shrink">
            <span className="truncate">{card.goal.name}</span>
          </Chip>
        ) : null}
        {card.pr ? (
          <span className="inline-flex shrink-0 items-center gap-1 px-1 text-xs font-medium tabular-nums">
            <PrGlyph state={card.pr.state} />
            {card.pr.label}
          </span>
        ) : null}
        <span className="flex-1" />
        {card.subtasks ? (
          <span
            className="shrink-0 px-1 text-xs text-(--m-muted) tabular-nums"
            aria-label={`${card.subtasks.done} of ${card.subtasks.total} subtasks done`}
          >
            {card.subtasks.done}/{card.subtasks.total}
          </span>
        ) : null}
        {card.running ? <Glyph kind="ok" label="Running" /> : null}
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
