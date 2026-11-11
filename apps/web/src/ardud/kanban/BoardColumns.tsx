import { useState } from "react";
import * as Schema from "effect/Schema";

import {
  DEFAULT_GROUP_COLUMN_WIDTH,
  toggleColumn,
  type BoardColumnKey,
  type BoardFilter,
  type BoardLane,
  type BoardModel,
  type BoardRow,
  type GroupBy,
} from "@t3tools/client-runtime/ardud/kanban";
import type { KanbanStage } from "@t3tools/contracts";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { observeResize } from "../../lib/observeResize";
import { cn } from "../../lib/utils";
import {
  BoardRows,
  HIDE_SCROLLBAR,
  LaneHeader,
  listColumns,
  VIRTUAL_ROWS_MIN,
  type BoardRowVariant,
} from "./BoardRows";
import { ColumnResizeHandle, COLUMN_WIDTH_PROPERTY } from "./ColumnResizeHandle";
import { GoalBar, Glyph, stageGlyph } from "./parts";
import { useBoardColumnPrefs } from "./useBoardColumnPrefs";

export function BoardColumns(props: {
  boardId: string;
  /** The board as the engine derived it: lanes of rows that keep their identity while unchanged. */
  model: BoardModel;
  group: GroupBy;
  filter: BoardFilter;
  selectedCardId: string | undefined;
  onOpenCard: (cardId: string) => void;
  onOpenGoal: (goalId: string) => void;
  onClearFilters: () => void;
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
  const { model, filter } = props;
  if (model.total === 0) {
    return <NoCardsMatch searching={(filter.query ?? "") !== ""} onClear={props.onClearFilters} />;
  }
  const picked = filter.goalIds ?? [];
  const shownGoals =
    picked.length > 0 ? model.goals.filter((entry) => picked.includes(entry.goal.id)) : model.goals;

  return (
    <div ref={measure} className="flex min-h-0 flex-1 flex-col gap-3.5">
      {shownGoals.length > 0 ? (
        <div className={cn("flex shrink-0 gap-2.5 overflow-x-auto pe-5", HIDE_SCROLLBAR)}>
          {shownGoals.map((entry) => (
            <button
              key={entry.goal.id}
              type="button"
              onClick={() => props.onOpenGoal(entry.goal.id)}
              className="grid min-w-56 flex-1 grid-cols-[auto_1fr_auto] items-center gap-3 rounded-xl bg-(--m-surface) px-3.5 py-2.5 text-left text-sm outline-none hover:bg-(--m-active) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent) pointer-coarse:py-3.5 pointer-coarse:text-base"
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
          // The list's own width, less its right margin.
          <StageList {...props} columns={listColumns(width === null ? null : width - 16)} />
        ) : (
          <StageGrid {...props} wide={wide} />
        )
      ) : (
        <GroupGrid {...props} />
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
const REVIEW_STAGES = ["needs_review", "in_review"] as const;
const SHIPPED_KEY = "t3code:kanban:board:shipped";
const SHIPPED_SCHEMA = Schema.NullOr(Schema.Literals(["open", "folded"]));

function StageGrid(props: ColumnsProps & { wide: boolean }) {
  const board = props.model;
  const [prefs, updatePrefs] = useBoardColumnPrefs(props.boardId);
  const [shipped, setShipped] = useLocalStorage(SHIPPED_KEY, null, SHIPPED_SCHEMA);
  // Stage keys come from the model; the columns here are always BoardColumnKeys.
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
  const shippedCount = board.shipped.reduce((sum, lane) => sum + lane.count, 0);
  // A search that found shipped cards shows them, whatever the fold: a card looked up
  // by number is often one that shipped.
  const searching = (props.filter.query ?? "") !== "";
  const shippedOpen =
    searching && shippedCount > 0 ? true : shipped === null ? props.wide : shipped === "open";

  const shippedHidden = hidden("shipped");
  const ownerHidden = hidden("needs_owner");
  const stageLane = (stage: KanbanStage) => board.active.find((lane) => lane.key === stage);

  // Work columns take the spare width; the review stack shares one column. A saved drag
  // width still wins over the layout's default for that column.
  const workColumn = (stage: KanbanStage) => {
    const lane = stageLane(stage);
    if (!lane) return null;
    if (hidden(stage)) {
      return (
        <HiddenColumnRail
          key={stage}
          label={lane.label}
          count={lane.count}
          onShow={() => toggle(stage)}
        />
      );
    }
    const saved = widthOf(stage);
    return (
      <Column
        key={stage}
        lane={lane}
        stage={stage}
        selectedCardId={props.selectedCardId}
        onOpenCard={props.onOpenCard}
        className={saved === null ? "min-w-52 flex-[1.4] pointer-coarse:min-w-56" : "shrink-0"}
        style={columnStyle(saved)}
        handle={
          <ColumnResizeHandle
            columnKey={stage}
            label={lane.label}
            edge="right"
            width={saved}
            onCommit={(width) => setWidth(stage, width)}
            onReset={() => resetWidth(stage)}
          />
        }
      />
    );
  };

  // A hidden review stage is restored from inside the shared stack, so it never adds a
  // rail beside the stack and never widens the row.
  const reviewRestore = (stage: KanbanStage) => {
    const lane = stageLane(stage);
    if (!lane || !hidden(stage)) return null;
    return (
      <button
        type="button"
        onClick={() => toggle(stage)}
        aria-label={`Show ${lane.label} (${lane.count})`}
        className="flex min-w-0 items-center justify-between gap-2 rounded-lg bg-(--m-surface) px-2 py-1 text-xs text-(--m-muted) outline-none hover:bg-(--m-active) hover:text-(--m-text) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent) pointer-coarse:min-h-11 pointer-coarse:text-sm"
      >
        <span className="min-w-0 truncate font-medium">{lane.label}</span>
        <span className="shrink-0 tabular-nums">{lane.count} hidden · show</span>
      </button>
    );
  };

  const reviewColumn = (stage: KanbanStage) => {
    const lane = stageLane(stage);
    if (!lane || hidden(stage)) return null;
    return (
      <Column
        key={stage}
        lane={lane}
        stage={stage}
        selectedCardId={props.selectedCardId}
        onOpenCard={props.onOpenCard}
        className="min-h-0 shrink"
      />
    );
  };

  const reviewStages = REVIEW_STAGES.filter((stage) => !hidden(stage));
  // Both review stages share one column, so the stack takes the wider saved width.
  const reviewSaved = reviewStages.reduce<number | null>((widest, stage) => {
    const saved = widthOf(stage);
    return saved === null ? widest : Math.max(widest ?? 0, saved);
  }, null);
  const setReviewWidth = (width: number) =>
    updatePrefs((current) => ({
      ...current,
      widths: { ...current.widths, needs_review: width, in_review: width },
    }));
  const resetReviewWidth = () =>
    updatePrefs((current) => {
      const widths = { ...current.widths };
      for (const stage of REVIEW_STAGES) delete widths[stage];
      return { ...current, widths };
    });
  const ownerVirtual = board.owner.rows.length > VIRTUAL_ROWS_MIN;
  return (
    <div className="flex min-h-0 flex-1 gap-2.5">
      {/* Needs Owner stays outside the scroller so it never slides off a narrow screen. */}
      <div
        className={cn("flex min-h-0 min-w-0 flex-[3.6] gap-2.5 overflow-x-auto", HIDE_SCROLLBAR)}
      >
        {workColumn("todo")}
        {workColumn("working")}
        {reviewStages.length === 0 ? (
          // Both review stages hidden: no stack, no resize handle, just the two restore controls.
          <div className="flex w-44 shrink-0 flex-col gap-2 pointer-coarse:w-52">
            {reviewRestore("needs_review")}
            {reviewRestore("in_review")}
          </div>
        ) : (
          <div
            data-review-stack
            className={cn(
              "relative flex min-h-0 flex-col gap-3",
              reviewSaved === null ? "min-w-44 flex-1 pointer-coarse:min-w-52" : "shrink-0",
            )}
            style={columnStyle(reviewSaved)}
          >
            <ColumnResizeHandle
              columnKey="needs_review"
              label="Review"
              edge="right"
              width={reviewSaved}
              onCommit={setReviewWidth}
              onReset={resetReviewWidth}
            />
            {reviewRestore("needs_review")}
            {reviewColumn("needs_review")}
            {reviewRestore("in_review")}
            {reviewColumn("in_review")}
          </div>
        )}
        {shippedHidden ? (
          <HiddenColumnRail label="Shipped" count={shippedCount} onShow={() => toggle("shipped")} />
        ) : shippedOpen ? (
          <ShippedColumn
            rows={board.shippedRows}
            selectedCardId={props.selectedCardId}
            onOpenCard={props.onOpenCard}
            width={widthOf("shipped")}
            onFold={() => setShipped("folded")}
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
        ) : (
          <FoldedShipped lanes={board.shipped} onOpen={() => setShipped("open")} />
        )}
      </div>
      {/* A column like the others: header on the same line, its cards in a tinted well
          that grows with them, so an empty Needs Owner isn't a full-height band. */}
      {ownerHidden ? (
        <HiddenColumnRail
          label={board.owner.label}
          count={board.owner.count}
          onShow={() => toggle("needs_owner")}
          className="me-5 mb-4"
        />
      ) : (
        <section
          aria-label={board.owner.label}
          data-column="needs_owner"
          className={cn(
            "relative me-5 mb-4 flex min-h-0 shrink-0 flex-col gap-2",
            widthOf("needs_owner") === null ? "w-64 pointer-coarse:w-68" : "",
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
          <LaneHeader label={board.owner.label} count={board.owner.count} tone="warn" />
          {/* A long list has no height of its own once only part of it is mounted,
              so the well then fills the column. */}
          <div
            className={cn(
              "flex min-h-0 flex-col rounded-xl bg-(--m-warnband) p-2",
              ownerVirtual && "flex-1",
            )}
          >
            <BoardRows
              rows={board.owner.rows}
              variant="raised"
              selectedCardId={props.selectedCardId}
              onOpenCard={props.onOpenCard}
              className={ownerVirtual ? "flex-1" : undefined}
              empty={
                <p className="px-1.5 py-1 text-xs text-(--m-muted) pointer-coarse:text-sm">
                  Nothing waiting on you
                </p>
              }
            />
          </div>
        </section>
      )}
    </div>
  );
}

/** Folded shipped strip: one button, the stage glyph and count per stage, top to bottom. */
function FoldedShipped(props: { lanes: ReadonlyArray<BoardLane>; onOpen: () => void }) {
  return (
    <button
      type="button"
      aria-expanded={false}
      aria-label="Show shipped cards"
      onClick={props.onOpen}
      className="flex w-14 shrink-0 flex-col items-center gap-4 rounded-xl bg-(--m-surface) py-3 outline-none hover:bg-(--m-active) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)"
    >
      {props.lanes.map((lane) => (
        <span
          key={lane.key}
          className="flex flex-col items-center gap-1.5 text-xs text-(--m-muted) tabular-nums pointer-coarse:text-sm"
        >
          <Glyph kind={stageGlyph(lane.key as KanbanStage)} />
          {lane.count}
        </span>
      ))}
    </button>
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

function Column(props: {
  lane: BoardLane;
  stage?: string;
  variant?: BoardRowVariant;
  selectedCardId: string | undefined;
  onOpenCard: (cardId: string) => void;
  className?: string;
  style?: React.CSSProperties | undefined;
  handle?: React.ReactNode;
}) {
  const { lane } = props;
  return (
    <section
      aria-label={lane.label}
      data-column={props.stage}
      style={props.style}
      className={cn("relative flex min-h-0 flex-col gap-2", props.className)}
    >
      {props.handle}
      <LaneHeader label={lane.label} count={lane.count} />
      {lane.summary ? (
        <p className="px-1 pb-1 text-xs leading-snug text-(--m-muted)">{lane.summary}</p>
      ) : null}
      <BoardRows
        rows={lane.rows}
        variant={props.variant}
        selectedCardId={props.selectedCardId}
        onOpenCard={props.onOpenCard}
        className="flex-1 pb-3"
      />
    </section>
  );
}

function ShippedColumn(props: {
  rows: ReadonlyArray<BoardRow>;
  selectedCardId: string | undefined;
  onOpenCard: (cardId: string) => void;
  width: number | null;
  handle?: React.ReactNode;
  onFold: () => void;
}) {
  return (
    <section
      aria-label="Shipped"
      data-column="shipped"
      style={columnStyle(props.width)}
      className={cn("relative flex min-h-0 shrink-0 flex-col", props.width === null && "w-60")}
    >
      {props.handle}
      <div className="flex h-6 shrink-0 items-center justify-between px-1 text-xs text-(--m-muted) pointer-coarse:h-11 pointer-coarse:text-sm">
        <span className="font-medium">Shipped</span>
        <button
          type="button"
          aria-expanded={true}
          aria-label="Fold shipped cards"
          onClick={props.onFold}
          className="inline-flex h-5 items-center rounded-full px-2 font-medium text-(--m-text) outline-none hover:bg-(--m-active) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent) pointer-coarse:h-11 pointer-coarse:px-3.5"
        >
          Fold
        </button>
      </div>
      <BoardRows
        rows={props.rows}
        variant="shipped"
        selectedCardId={props.selectedCardId}
        onOpenCard={props.onOpenCard}
        className="flex-1 pb-3"
      />
    </section>
  );
}

function NoCardsMatch(props: { searching: boolean; onClear: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3 pe-5">
      <p className="text-(--m-muted)">
        {props.searching
          ? // The board feed carries no descriptions: only an opened card's is on this device.
            "No cards match. Descriptions are searched only on cards you have opened."
          : "No cards match these filters."}
      </p>
      <button
        type="button"
        onClick={props.onClear}
        className="h-8 rounded-full bg-(--m-chip) px-3.5 text-sm font-medium outline-none hover:bg-(--m-active) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)"
      >
        Clear filters
      </button>
    </div>
  );
}

function GroupGrid(props: ColumnsProps) {
  const groups = props.model.groups;
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
          lane={group}
          variant="staged"
          selectedCardId={props.selectedCardId}
          onOpenCard={props.onOpenCard}
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
        />
      ))}
    </div>
  );
}

/** Phone layout: Needs Owner pinned on top, then one stage at a time. */
function StageList(props: ColumnsProps & { columns: number }) {
  const board = props.model;
  const lanes = [...board.active, ...board.shipped];
  const firstFull = lanes.find((lane) => lane.count > 0)?.key ?? "todo";
  const [picked, setPicked] = useState<string | null>(null);
  const stage = picked ?? firstFull;
  const current = lanes.find((lane) => lane.key === stage) ?? lanes[0];

  // The pinned block and the tabs scroll away with the cards: they are the list's header.
  const header = (
    <div className="flex flex-col gap-3 pb-1">
      {board.owner.rows.length > 0 ? (
        <div className="flex flex-col gap-2 rounded-2xl bg-(--m-warnband) p-2.5">
          <LaneHeader label={board.owner.label} count={board.owner.count} tone="warn" />
          <BoardRows
            rows={board.owner.rows}
            variant="raised"
            selectedCardId={undefined}
            onOpenCard={props.onOpenCard}
            columns={props.columns}
            // A pinned block longer than a screen scrolls inside itself.
            className={board.owner.rows.length > VIRTUAL_ROWS_MIN ? "h-[60dvh]" : undefined}
          />
        </div>
      ) : null}
      <div
        role="tablist"
        aria-label="Stage"
        className={cn("flex shrink-0 gap-1 overflow-x-auto", HIDE_SCROLLBAR)}
      >
        {lanes.map((lane) => {
          const selected = lane.key === stage;
          return (
            <button
              key={lane.key}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => setPicked(lane.key)}
              className={cn(
                "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-sm font-medium whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent) pointer-coarse:h-11 pointer-coarse:px-4 pointer-coarse:text-base",
                selected ? "bg-(--m-text) text-(--m-ground)" : "bg-(--m-chip) text-(--m-muted)",
              )}
            >
              {lane.label}
              <span className="tabular-nums opacity-70">{lane.count}</span>
            </button>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col pe-4">
      <BoardRows
        key={stage}
        rows={current?.rows ?? []}
        selectedCardId={undefined}
        onOpenCard={props.onOpenCard}
        columns={props.columns}
        header={header}
        className="flex-1 pb-4"
      />
    </div>
  );
}
