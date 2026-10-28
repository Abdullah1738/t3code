import { useState } from "react";
import * as Schema from "effect/Schema";

import {
  DEFAULT_GROUP_COLUMN_WIDTH,
  activeGoals,
  groupCards,
  stageBoard,
  toggleColumn,
  type BoardColumnKey,
  type BoardFilter,
  type CardView,
  type GroupBy,
  type KanbanBoardState,
  type StageColumn,
} from "@t3tools/client-runtime/ardud/kanban";
import type { KanbanStage } from "@t3tools/contracts";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { observeResize } from "../../lib/observeResize";
import { cn } from "../../lib/utils";
import { CardTile } from "./CardTile";
import { ColumnResizeHandle, COLUMN_WIDTH_PROPERTY } from "./ColumnResizeHandle";
import { GoalBar, Glyph, stageGlyph } from "./parts";
import { useBoardColumnPrefs } from "./useBoardColumnPrefs";

const HIDE_SCROLLBAR = "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

export function BoardColumns(props: {
  boardId: string;
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
  const coarse = useMediaQuery({ pointer: "coarse" });
  const gridMinWidth = coarse ? STAGE_GRID_MIN_WIDTH_COARSE : STAGE_GRID_MIN_WIDTH_FINE;
  const narrow = width === null ? narrowScreen : width < gridMinWidth;
  // Shipped opens by default only on a wide board; a saved choice always wins.
  const wide = width !== null && width >= SHIPPED_OPEN_MIN_WIDTH;
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
        <div className={cn("flex shrink-0 gap-2.5 overflow-x-auto pe-5", HIDE_SCROLLBAR)}>
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
          <StageGrid {...props} wide={wide} />
        )
      ) : (
        <GroupGrid {...props} group={props.group} />
      )}
    </div>
  );
}

type ColumnsProps = Parameters<typeof BoardColumns>[0];

// The stage grid's narrowest widths: two work columns, the review stack, the folded
// shipped strip, Needs Owner with its right margin, and the gaps. Touch sizes are wider.
const STAGE_GRID_MIN_WIDTH_FINE = 2 * 208 + 176 + 56 + 256 + 20 + 4 * 10; // 964
const STAGE_GRID_MIN_WIDTH_COARSE = 2 * 224 + 208 + 56 + 272 + 20 + 4 * 10; // 1044
const SHIPPED_OPEN_MIN_WIDTH = 1400;
const SHIPPED_KEY = "t3code:kanban:board:shipped";
const SHIPPED_SCHEMA = Schema.NullOr(Schema.Literals(["open", "folded"]));

function StageGrid(props: ColumnsProps & { wide: boolean }) {
  const board = stageBoard(props.state, props.nowMs, props.filter);
  const [prefs, updatePrefs] = useBoardColumnPrefs(props.boardId);
  // Stage keys come from stageBoard; the columns here are always BoardColumnKeys.
  const widthOf = (key: string) => prefs.widths[key as BoardColumnKey] ?? null;
  const setWidth = (key: string, width: number) =>
    updatePrefs((current) => ({
      ...current,
      widths: { ...current.widths, [key as BoardColumnKey]: width },
    }));
  const resetWidth = (key: string) =>
    updatePrefs((current) => {
      const widths = { ...current.widths };
      delete widths[key as BoardColumnKey];
      return { ...current, widths };
    });
  const toggle = (key: string) =>
    updatePrefs((current) => toggleColumn(current, key as BoardColumnKey));
  const hidden = (key: string) => prefs.hidden.includes(key as BoardColumnKey);

  const shippedHidden = hidden("shipped");
  const ownerHidden = hidden("needs_owner");

  return (
    <div className="flex min-h-0 flex-1 gap-2.5">
      {/* Needs Owner stays outside the scroller so it never slides off a narrow screen. */}
      <div
        className={cn("flex min-h-0 min-w-0 flex-[3.6] gap-2.5 overflow-x-auto", HIDE_SCROLLBAR)}
      >
        {board.active.map((column) =>
          hidden(column.stage) ? (
            <HiddenColumnRail
              key={column.stage}
              label={column.label}
              count={column.cards.length}
              onShow={() => toggle(column.stage)}
            />
          ) : (
            <Column
              key={column.stage}
              column={column}
              className={cn("min-w-32", widthOf(column.stage) === null ? "flex-1" : "shrink-0")}
              style={columnStyle(widthOf(column.stage))}
              handle={
                <ColumnResizeHandle
                  columnKey={column.stage}
                  label={column.label}
                  edge="right"
                  width={widthOf(column.stage)}
                  onCommit={(width) => setWidth(column.stage, width)}
                  onReset={() => resetWidth(column.stage)}
                />
              }
            >
              {column.cards.map((card) => (
                <CardTile
                  key={card.id}
                  card={card}
                  selected={card.id === props.selectedCardId}
                  onOpen={props.onOpenCard}
                />
              ))}
            </Column>
          ),
        )}
        {shippedHidden ? (
          <HiddenColumnRail
            label="Shipped"
            count={board.shipped.reduce((sum, column) => sum + column.cards.length, 0)}
            onShow={() => toggle("shipped")}
          />
        ) : (
          <ShippedColumn
            board={board.shipped}
            selectedCardId={props.selectedCardId}
            onOpenCard={props.onOpenCard}
            width={widthOf("shipped")}
            handle={
              <ColumnResizeHandle
                columnKey="shipped"
                label="Shipped"
                edge="right"
                width={widthOf("shipped")}
                onCommit={(width) => setWidth("shipped", width)}
                onReset={() => resetWidth("shipped")}
              />
            }
          />
        )}
      </div>
      {/* A column like the others: header on the same line, its cards in a tinted well
          that grows with them, so an empty Needs Owner isn't a full-height band. */}
      {ownerHidden ? (
        <HiddenColumnRail
          label={board.owner.label}
          count={board.owner.cards.length}
          onShow={() => toggle("needs_owner")}
          className="me-5 mb-4"
        />
      ) : (
        <section
          aria-label={board.owner.label}
          data-column="needs_owner"
          className={cn(
            "relative me-5 mb-4 flex min-h-0 shrink-0 flex-col gap-2",
            widthOf("needs_owner") === null ? "w-56 xl:w-64" : "",
          )}
          style={columnStyle(widthOf("needs_owner"))}
        >
          <ColumnResizeHandle
            columnKey="needs_owner"
            label={board.owner.label}
            edge="left"
            width={widthOf("needs_owner")}
            onCommit={(width) => setWidth("needs_owner", width)}
            onReset={() => resetWidth("needs_owner")}
          />
          <ColumnHeader label={board.owner.label} count={board.owner.cards.length} tone="warn" />
          <div
            className={cn(
              "flex min-h-0 flex-col gap-2 overflow-y-auto overflow-x-hidden rounded-xl bg-(--m-warnband) p-2",
              HIDE_SCROLLBAR,
            )}
          >
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
      )}
    </div>
  );
}

/** Slim rail that stands in for a hidden column; clicking it shows the column again. */
function HiddenColumnRail(props: {
  label: string;
  count: number;
  onShow: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={props.onShow}
      aria-label={`Show ${props.label} (${props.count})`}
      className={cn(
        "flex h-full min-h-24 w-8 shrink-0 flex-col items-center gap-2 rounded-xl bg-(--m-surface) py-3 text-xs text-(--m-muted) outline-none hover:bg-(--m-active) hover:text-(--m-text) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)",
        props.className,
      )}
    >
      <span className="tabular-nums">{props.count}</span>
      <span className="font-medium [writing-mode:vertical-rl]">{props.label}</span>
    </button>
  );
}

function columnStyle(width: number | null): React.CSSProperties | undefined {
  return width === null ? undefined : { width: `var(${COLUMN_WIDTH_PROPERTY}, ${width}px)` };
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
  column: { stage?: string; label: string; cards: ReadonlyArray<unknown> };
  className?: string;
  style?: React.CSSProperties | undefined;
  handle?: React.ReactNode;
  summary?: string | null;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label={props.column.label}
      data-column={props.column.stage}
      style={props.style}
      className={cn("relative flex min-h-0 flex-col gap-2", props.className)}
    >
      {props.handle}
      <ColumnHeader label={props.column.label} count={props.column.cards.length} />
      {props.summary ? (
        <p className="px-1 pb-1 text-xs leading-snug text-(--m-muted)">{props.summary}</p>
      ) : null}
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overflow-x-hidden pb-3",
          HIDE_SCROLLBAR,
        )}
      >
        {props.children}
      </div>
    </section>
  );
}

function ShippedColumn(props: {
  board: ReadonlyArray<StageColumn>;
  selectedCardId: string | undefined;
  onOpenCard: (cardId: string) => void;
  width: number | null;
  handle?: React.ReactNode;
}) {
  return (
    <section
      aria-label="Shipped"
      data-column="shipped"
      style={columnStyle(props.width)}
      className={cn(
        "relative flex min-h-0 shrink-0 flex-col",
        props.width === null && "w-40 xl:w-44",
      )}
    >
      {props.handle}
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overflow-x-hidden pb-3",
          HIDE_SCROLLBAR,
        )}
      >
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
  const [prefs, updatePrefs] = useBoardColumnPrefs(props.boardId);
  if (groups.length === 0) return <p className="text-(--m-muted)">No cards.</p>;
  const groupWidth = prefs.groupWidth ?? DEFAULT_GROUP_COLUMN_WIDTH;
  // One width for every group column; the handle on each one edits the shared value.
  const commitWidth = (width: number) =>
    updatePrefs((current) => ({ ...current, groupWidth: width }));
  return (
    <div
      data-group-grid
      className={cn("flex min-h-0 flex-1 gap-2.5 overflow-x-auto", HIDE_SCROLLBAR)}
    >
      {groups.map((group) => (
        <Column
          key={group.key}
          column={group}
          summary={group.summary}
          className="shrink-0"
          style={{ width: `var(${COLUMN_WIDTH_PROPERTY}, ${groupWidth}px)` }}
          handle={
            <ColumnResizeHandle
              columnKey="group"
              label={group.label}
              edge="right"
              width={groupWidth}
              liveTarget={(handle) => handle.closest<HTMLElement>("[data-group-grid]")}
              onCommit={commitWidth}
              onReset={() => updatePrefs((current) => ({ ...current, groupWidth: null }))}
            />
          }
        >
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
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overflow-x-hidden pe-4 pb-4",
        HIDE_SCROLLBAR,
      )}
    >
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
        className={cn("flex shrink-0 gap-1 overflow-x-auto", HIDE_SCROLLBAR)}
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
