import { useState } from "react";

import {
  activeGoals,
  groupCards,
  stageBoard,
  type BoardFilter,
  type CardView,
  type GroupBy,
  type KanbanBoardState,
  type StageColumn,
} from "@t3tools/client-runtime/ardud/kanban";
import type { KanbanStage } from "@t3tools/contracts";

import { useMediaQuery } from "../../hooks/useMediaQuery";
import { observeResize } from "../../lib/observeResize";
import { cn } from "../../lib/utils";
import { CardTile } from "./CardTile";
import { GoalBar, Glyph, stageGlyph } from "./parts";

export function BoardColumns(props: {
  state: KanbanBoardState;
  nowMs: number;
  group: GroupBy;
  filter: BoardFilter;
  selectedCardId: string | undefined;
  onOpenCard: (cardId: string) => void;
  onOpenGoal: (goalId: string) => void;
}) {
  // The board's own width decides, not the screen's: an iPad with the sidebar open
  // is a wide screen with a narrow board.
  const [width, setWidth] = useState<number | null>(null);
  const narrowScreen = useMediaQuery("max-md");
  const narrow = width === null ? narrowScreen : width < STAGE_GRID_MIN_WIDTH;
  const measure = (element: HTMLDivElement) =>
    observeResize(element, ([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
  const { state, filter } = props;
  const goals = activeGoals(state);
  const shownGoals = filter.goalId
    ? goals.filter((entry) => entry.goal.id === filter.goalId)
    : goals;

  return (
    <div ref={measure} className="flex min-h-0 flex-1 flex-col gap-3.5">
      {shownGoals.length > 0 ? (
        <div className="flex shrink-0 gap-2.5 overflow-x-auto pe-5 [scrollbar-width:none]">
          {shownGoals.map((entry) => (
            <button
              key={entry.goal.id}
              type="button"
              onClick={() => props.onOpenGoal(entry.goal.id)}
              className="grid min-w-56 flex-1 grid-cols-[auto_1fr_auto] items-center gap-3 rounded-xl bg-(--m-surface) px-3.5 py-2.5 text-left text-sm outline-none hover:bg-(--m-active) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)"
            >
              <span className="truncate font-medium">{entry.goal.name}</span>
              <GoalBar progress={entry.progress} />
              <span className="text-xs text-(--m-muted) tabular-nums">
                {entry.progress.verified}/{entry.progress.total}
              </span>
            </button>
          ))}
        </div>
      ) : null}
      {props.group === "stage" ? (
        narrow ? (
          <StageList {...props} />
        ) : (
          <StageGrid {...props} />
        )
      ) : (
        <GroupGrid {...props} group={props.group} />
      )}
    </div>
  );
}

type ColumnsProps = Parameters<typeof BoardColumns>[0];

// Four stage columns at their narrowest, the shipped column, Needs Owner with its
// right margin, and the gaps.
const STAGE_GRID_MIN_WIDTH = 4 * 128 + 160 + 224 + 20 + 5 * 10;

function StageGrid(props: ColumnsProps) {
  const board = stageBoard(props.state, props.nowMs, props.filter);
  return (
    <div className="flex min-h-0 flex-1 gap-2.5">
      {/* Needs Owner stays outside the scroller so it never slides off a narrow screen. */}
      <div className="flex min-h-0 min-w-0 flex-[3.6] gap-2.5 overflow-x-auto">
        {board.active.map((column) => (
          <Column key={column.stage} column={column} className="min-w-32 flex-1">
            {column.cards.map((card) => (
              <CardTile
                key={card.id}
                card={card}
                selected={card.id === props.selectedCardId}
                onOpen={props.onOpenCard}
              />
            ))}
          </Column>
        ))}
        <ShippedColumn
          board={board.shipped}
          selectedCardId={props.selectedCardId}
          onOpenCard={props.onOpenCard}
        />
      </div>
      {/* A column like the others: header on the same line, its cards in a tinted well
          that grows with them, so an empty Needs Owner isn't a full-height band. */}
      <section
        aria-label={board.owner.label}
        className="me-5 mb-4 flex min-h-0 w-56 shrink-0 flex-col gap-2 xl:w-64"
      >
        <ColumnHeader label={board.owner.label} count={board.owner.cards.length} tone="warn" />
        <div className="flex min-h-0 flex-col gap-2 overflow-y-auto rounded-xl bg-(--m-warnband) p-2">
          {board.owner.cards.length === 0 ? (
            <p className="px-1.5 py-1 text-xs text-(--m-muted)">Nothing waiting on you</p>
          ) : (
            board.owner.cards.map((card) => (
              <CardTile
                key={card.id}
                card={card}
                raised
                selected={card.id === props.selectedCardId}
                onOpen={props.onOpenCard}
              />
            ))
          )}
        </div>
      </section>
    </div>
  );
}

function ColumnHeader(props: { label: string; count: number; tone?: "warn" }) {
  return (
    <div
      className={cn(
        "flex h-6 shrink-0 items-center justify-between px-1 text-xs",
        props.tone === "warn" ? "text-(--m-warning)" : "text-(--m-muted)",
      )}
    >
      <span className="font-medium">{props.label}</span>
      <span className="tabular-nums">{props.count}</span>
    </div>
  );
}

function Column(props: {
  column: { label: string; cards: ReadonlyArray<unknown> };
  className?: string;
  summary?: string | null;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label={props.column.label}
      className={cn("flex min-h-0 flex-col gap-2", props.className)}
    >
      <ColumnHeader label={props.column.label} count={props.column.cards.length} />
      {props.summary ? (
        <p className="px-1 pb-1 text-xs leading-snug text-(--m-muted)">{props.summary}</p>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pb-3">
        {props.children}
      </div>
    </section>
  );
}

function ShippedColumn(props: {
  board: ReadonlyArray<StageColumn>;
  selectedCardId: string | undefined;
  onOpenCard: (cardId: string) => void;
}) {
  return (
    <section aria-label="Shipped" className="flex min-h-0 w-40 shrink-0 flex-col xl:w-44">
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pb-3">
        {props.board.map((column) => (
          <div key={column.stage} className="flex flex-col gap-1 pb-2">
            <ColumnHeader label={column.label} count={column.cards.length} />
            {column.cards.map((card) => (
              <ShippedRow
                key={card.id}
                card={card}
                selected={card.id === props.selectedCardId}
                onOpen={props.onOpenCard}
              />
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

function ShippedRow(props: {
  card: CardView;
  selected: boolean;
  onOpen: (cardId: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => props.onOpen(props.card.id)}
      aria-current={props.selected ? "true" : undefined}
      className={cn(
        "grid grid-cols-[12px_1fr] items-center gap-1.75 rounded-lg bg-(--m-surface) px-1.5 py-1.25 text-left text-xs text-(--m-muted) outline-none hover:bg-(--m-active) hover:text-(--m-text) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)",
        props.selected && "text-(--m-text) ring-2 ring-inset ring-(--m-text)",
      )}
    >
      <Glyph kind={stageGlyph(props.card.stage)} />
      <span className="truncate">{props.card.title}</span>
    </button>
  );
}

function GroupGrid(props: ColumnsProps & { group: Exclude<GroupBy, "stage"> }) {
  const groups = groupCards(props.state, props.group, props.nowMs, props.filter);
  if (groups.length === 0) return <p className="text-(--m-muted)">No cards.</p>;
  return (
    <div className="flex min-h-0 flex-1 gap-2.5 overflow-x-auto">
      {groups.map((group) => (
        <Column key={group.key} column={group} summary={group.summary} className="w-64 shrink-0">
          {group.cards.map((card) => (
            <CardTile
              key={card.id}
              card={card}
              showStage
              selected={card.id === props.selectedCardId}
              onOpen={props.onOpenCard}
            />
          ))}
        </Column>
      ))}
    </div>
  );
}

/** Phone layout: Needs Owner pinned on top, then one stage at a time. */
function StageList(props: ColumnsProps) {
  const board = stageBoard(props.state, props.nowMs, props.filter);
  const columns = [...board.active, ...board.shipped];
  const firstFull = columns.find((column) => column.cards.length > 0)?.stage ?? "todo";
  const [picked, setPicked] = useState<KanbanStage | null>(null);
  const stage = picked ?? firstFull;
  const current = columns.find((column) => column.stage === stage) ?? columns[0];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pe-4 pb-4">
      {board.owner.cards.length > 0 ? (
        <div className="flex flex-col gap-2 rounded-2xl bg-(--m-warnband) p-2.5">
          <ColumnHeader label={board.owner.label} count={board.owner.cards.length} tone="warn" />
          {board.owner.cards.map((card) => (
            <CardTile key={card.id} card={card} raised selected={false} onOpen={props.onOpenCard} />
          ))}
        </div>
      ) : null}
      <div
        role="tablist"
        aria-label="Stage"
        className="flex shrink-0 gap-1 overflow-x-auto [scrollbar-width:none]"
      >
        {columns.map((column) => {
          const selected = column.stage === stage;
          return (
            <button
              key={column.stage}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => setPicked(column.stage)}
              className={cn(
                "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-sm font-medium whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)",
                selected ? "bg-(--m-text) text-(--m-ground)" : "bg-(--m-chip) text-(--m-muted)",
              )}
            >
              {column.label}
              <span className="tabular-nums opacity-70">{column.cards.length}</span>
            </button>
          );
        })}
      </div>
      {current
        ? current.cards.map((card) => (
            <CardTile key={card.id} card={card} selected={false} onOpen={props.onOpenCard} />
          ))
        : null}
    </div>
  );
}
