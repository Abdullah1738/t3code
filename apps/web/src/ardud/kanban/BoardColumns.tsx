import { Link } from "@tanstack/react-router";
import { ArrowRightIcon } from "lucide-react";
import { useState } from "react";
import * as Schema from "effect/Schema";

import {
  DEFAULT_GROUP_COLUMN_WIDTH,
  toggleColumn,
  type BoardColumnKey,
  type BoardFilter,
  type BoardLane,
  type BoardLens,
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
  VIRTUAL_ROWS_MIN,
  type BoardRowVariant,
  type OnBoardGroup,
} from "./BoardRows";
import { ColumnResizeHandle, COLUMN_WIDTH_PROPERTY } from "./ColumnResizeHandle";
import { GoalBar, Glyph, stageGlyph } from "./parts";
import { useBoardColumnPrefs } from "./useBoardColumnPrefs";

const FOCUS =
  "outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)";

export function BoardColumns(props: {
  boardId: string;
  /** The board as the engine derived it: lanes of rows that keep their identity while unchanged. */
  model: BoardModel;
  group: GroupBy;
  filter: BoardFilter;
  lens: BoardLens;
  selectedCardId: string | undefined;
  onOpenCard: (cardId: string) => void;
  onOpenGoal: (goalId: string) => void;
  onClearFilters: () => void;
  /** Opens, folds or expands a state group inside a column. */
  onGroup: OnBoardGroup;
}) {
  // The board's own width decides, not the screen's: an iPad with the sidebar open
  // is a wide screen with a narrow board.
  const [width, setWidth] = useState<number | null>(null);
  const narrowScreen = useMediaQuery("max-sm");
  const mediumScreen = useMediaQuery("max-lg");
  const coarse = useMediaQuery({ pointer: "coarse" });
  // A phone shows one column at a time. Between that and the full grid (a tablet, a
  // desktop with a narrow board) the columns keep a readable width and scroll sideways.
  const phone = width === null ? narrowScreen : width < PHONE_MAX_WIDTH;
  const compact =
    width === null
      ? mediumScreen
      : width < (coarse ? STAGE_GRID_MIN_WIDTH_COARSE : STAGE_GRID_MIN_WIDTH_FINE);
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
      {shownGoals.length > 0 && !phone ? (
        <div className={cn("flex shrink-0 gap-2.5 overflow-x-auto pe-5", HIDE_SCROLLBAR)}>
          {shownGoals.map((entry) => (
            <button
              key={entry.goal.id}
              type="button"
              onClick={() => props.onOpenGoal(entry.goal.id)}
              className={cn(
                "grid min-w-56 flex-1 grid-cols-[auto_1fr_auto] items-center gap-3 rounded-xl bg-(--m-surface) px-3.5 py-2.5 text-left text-sm hover:bg-(--m-active) pointer-coarse:py-3.5 pointer-coarse:text-base",
                FOCUS,
              )}
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
        phone ? (
          <StageList {...props} />
        ) : (
          <StageGrid {...props} wide={wide} compact={compact} />
        )
      ) : (
        <GroupGrid {...props} />
      )}
    </div>
  );
}

type ColumnsProps = Parameters<typeof BoardColumns>[0];

/** Below this the board is a phone's: one column at a time. */
const PHONE_MAX_WIDTH = 640;
// The widths at which every column fits beside Needs you without scrolling: four state
// columns, the folded shipped strip, Needs you with its right margin, and the gaps.
// Narrower than this, Needs you moves into the sideways scroller with the rest.
const STAGE_GRID_MIN_WIDTH_FINE = 4 * 184 + 56 + 256 + 20 + 5 * 10; // 1118
const STAGE_GRID_MIN_WIDTH_COARSE = 4 * 208 + 56 + 272 + 20 + 5 * 10; // 1230
const SHIPPED_OPEN_MIN_WIDTH = 1500;
const STATE_COLUMNS = ["todo", "working", "needs_review", "in_review"] as const;
const SHIPPED_KEY = "t3code:kanban:board:shipped";
const SHIPPED_SCHEMA = Schema.NullOr(Schema.Literals(["open", "folded"]));

function StageGrid(props: ColumnsProps & { wide: boolean; compact: boolean }) {
  const board = props.model;
  const [prefs, updatePrefs] = useBoardColumnPrefs(props.boardId);
  const [shipped, setShipped] = useLocalStorage(SHIPPED_KEY, null, SHIPPED_SCHEMA);
  // Lane keys come from the model; the columns here are always BoardColumnKeys.
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

  // Columns share the spare width; a saved drag width wins over the layout's default.
  const stateColumn = (key: (typeof STATE_COLUMNS)[number]) => {
    const lane = board.active.find((entry) => entry.key === key);
    if (!lane) return null;
    if (hidden(key)) {
      return (
        <HiddenColumnRail
          key={key}
          label={lane.label}
          count={lane.count}
          onShow={() => toggle(key)}
        />
      );
    }
    const saved = widthOf(key);
    return (
      <Column
        key={key}
        lane={lane}
        stage={key}
        selectedCardId={props.selectedCardId}
        onOpenCard={props.onOpenCard}
        onGroup={props.onGroup}
        className={
          saved !== null
            ? "shrink-0"
            : props.compact
              ? "min-w-62 flex-1"
              : "min-w-46 flex-1 pointer-coarse:min-w-52"
        }
        style={columnStyle(saved)}
        handle={
          <ColumnResizeHandle
            columnKey={key}
            label={lane.label}
            edge="right"
            width={saved}
            onCommit={(width) => setWidth(key, width)}
            onReset={() => resetWidth(key)}
          />
        }
      />
    );
  };

  const ownerVirtual = board.owner.rows.length > VIRTUAL_ROWS_MIN;
  const owner = ownerHidden ? (
    <HiddenColumnRail
      label={board.owner.label}
      count={board.owner.count}
      onShow={() => toggle("needs_owner")}
      className={props.compact ? undefined : "me-5 mb-4"}
    />
  ) : (
    // A column like the others: header on the same line, its cards in a tinted well
    // that grows with them, so an empty Needs you isn't a full-height band.
    <section
      aria-label={board.owner.label}
      data-column="needs_owner"
      className={cn(
        "relative flex min-h-0 shrink-0 flex-col gap-2",
        !props.compact && "me-5 mb-4",
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
      <NeedsYouLink boardId={props.boardId} label={board.owner.label} count={board.owner.count} />
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
  );

  return (
    <div className="flex min-h-0 flex-1 gap-2.5">
      {/* On a wide board Needs you stays outside the scroller so it never slides away. */}
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-[3.6] gap-2.5 overflow-x-auto",
          props.compact && "pe-5 pb-4",
          HIDE_SCROLLBAR,
        )}
      >
        {STATE_COLUMNS.map(stateColumn)}
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
        {props.compact ? owner : null}
      </div>
      {props.compact ? null : owner}
    </div>
  );
}

/** The Needs you column's heading: the count, and the way to the page that answers them. */
function NeedsYouLink(props: { boardId: string; label: string; count: number }) {
  return (
    <Link
      to="/needs-you"
      search={{ board: props.boardId }}
      aria-label={`${props.label}: ${props.count}. Open Needs you for this board`}
      className={cn(
        "flex h-6 shrink-0 items-center justify-between rounded-md px-1 text-xs text-(--m-warning) hover:bg-(--m-warnband) pointer-coarse:h-8 pointer-coarse:text-sm",
        FOCUS,
      )}
    >
      <span className="font-medium">{props.label}</span>
      <span className="flex items-center gap-1 tabular-nums">
        {props.count.toLocaleString("en-US")}
        <ArrowRightIcon aria-hidden className="size-3" />
      </span>
    </Link>
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
      className={cn(
        "flex w-14 shrink-0 flex-col items-center gap-4 rounded-xl bg-(--m-surface) py-3 hover:bg-(--m-active)",
        FOCUS,
      )}
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
  className?: string | undefined;
}) {
  return (
    <button
      type="button"
      onClick={props.onShow}
      aria-label={`Show ${props.label} (${props.count})`}
      className={cn(
        "flex h-full min-h-24 w-8 shrink-0 flex-col items-center gap-2 rounded-xl bg-(--m-surface) py-3 text-xs text-(--m-muted) hover:bg-(--m-active) hover:text-(--m-text)",
        FOCUS,
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
  onGroup?: OnBoardGroup;
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
        onGroup={props.onGroup}
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
          className={cn(
            "inline-flex h-5 items-center rounded-full px-2 font-medium text-(--m-text) hover:bg-(--m-active) pointer-coarse:h-11 pointer-coarse:px-3.5",
            FOCUS,
          )}
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
        className={cn(
          "h-8 rounded-full bg-(--m-chip) px-3.5 text-sm font-medium hover:bg-(--m-active) pointer-coarse:h-11",
          FOCUS,
        )}
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

/** What the phone's column switcher calls each column: short enough for four to fit. */
const SHORT_LABELS: Record<string, string> = {
  todo: "To-Do",
  working: "Working",
  needs_review: "Review",
  in_review: "Waiting",
  needs_owner: "Needs you",
};

/** Phone layout: one column at a time, picked from a switcher that scrolls away with the cards. */
function StageList(props: ColumnsProps) {
  const board = props.model;
  const lanes = [...board.active, board.owner, ...board.shipped];
  const firstFull = lanes.find((lane) => lane.count > 0)?.key ?? "todo";
  const [picked, setPicked] = useState<string | null>(null);
  const key = picked ?? firstFull;
  const current = lanes.find((lane) => lane.key === key) ?? lanes[0];
  const stuck = props.lens === "stuck";

  if (stuck) {
    // Few cards, and the point is to see them all: every column, one under the other.
    return (
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pe-4 pb-4",
          HIDE_SCROLLBAR,
        )}
      >
        {board.active.map((lane) => (
          <section key={lane.key} aria-label={lane.label} className="flex flex-col gap-2">
            <LaneHeader label={lane.label} count={lane.count} />
            <BoardRows
              rows={lane.rows}
              selectedCardId={undefined}
              onOpenCard={props.onOpenCard}
              className="max-h-[70dvh]"
            />
          </section>
        ))}
      </div>
    );
  }

  const header = (
    <div
      role="tablist"
      aria-label="Column"
      className={cn("flex shrink-0 gap-1 overflow-x-auto pb-3", HIDE_SCROLLBAR)}
    >
      {lanes.map((lane) => {
        const selected = lane.key === key;
        return (
          <button
            key={lane.key}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => setPicked(lane.key)}
            className={cn(
              "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-sm font-medium whitespace-nowrap pointer-coarse:h-11 pointer-coarse:px-4 pointer-coarse:text-base",
              FOCUS,
              selected ? "bg-(--m-text) text-(--m-ground)" : "bg-(--m-chip) text-(--m-muted)",
            )}
          >
            {SHORT_LABELS[lane.key] ?? lane.label}
            <span className="tabular-nums opacity-70">{lane.count.toLocaleString("en-US")}</span>
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col pe-4">
      <BoardRows
        key={key}
        rows={current?.rows ?? []}
        variant={key === "needs_owner" ? "raised" : undefined}
        selectedCardId={undefined}
        onOpenCard={props.onOpenCard}
        onGroup={props.onGroup}
        header={header}
        className="flex-1 pb-4"
        empty={<p className="px-1 py-1 text-sm text-(--m-muted)">Nothing here</p>}
      />
    </div>
  );
}
