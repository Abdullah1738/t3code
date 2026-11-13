import { LegendList } from "@legendapp/list/react";
import { ChevronRightIcon } from "lucide-react";
import { memo } from "react";

import type { BoardGroupState, BoardRow } from "@t3tools/client-runtime/ardud/kanban";

import { cn } from "../../lib/utils";
import { CardTile } from "./CardTile";
import { Glyph, stageGlyph } from "./parts";

export const HIDE_SCROLLBAR = "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

/**
 * Lanes up to this long render every row, as they always did. Longer ones mount only
 * the rows near the viewport: a 1,000-card To-Do keeps a few dozen tiles in the page.
 */
export const VIRTUAL_ROWS_MIN = 40;

/** How far past the viewport rows stay mounted, so a fast scroll doesn't show gaps. */
const DRAW_DISTANCE_PX = 700;

/** "raised" is a Needs you tile on its tinted well; "asks" is the same tile without a well. */
export type BoardRowVariant = "tile" | "raised" | "asks" | "staged" | "shipped";

/** Opens, folds or expands a state group; `id` is the group row's. */
export type OnBoardGroup = (id: string, state: BoardGroupState) => void;

const FOCUS =
  "outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)";

export function LaneHeader(props: { label: string; count: number; tone?: "warn" }) {
  return (
    <div
      className={cn(
        "flex h-6 shrink-0 items-center justify-between px-1 text-xs pointer-coarse:h-8 pointer-coarse:text-sm",
        props.tone === "warn" ? "text-(--m-warning)" : "text-(--m-muted)",
      )}
    >
      <h2 className={cn("font-medium", props.tone === "warn" ? "" : "text-(--m-text)")}>
        {props.label}
      </h2>
      <span className="tabular-nums">{props.count.toLocaleString("en-US")}</span>
    </div>
  );
}

const ShippedRow = memo(function ShippedRow(props: {
  id: string;
  title: string;
  stage: Parameters<typeof stageGlyph>[0];
  selected: boolean;
  onOpen: (cardId: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => props.onOpen(props.id)}
      aria-current={props.selected ? "true" : undefined}
      className={cn(
        "grid w-full grid-cols-[12px_1fr] items-start gap-1.75 rounded-lg bg-(--m-surface) px-1.5 py-1.25 text-left text-xs text-(--m-muted) hover:bg-(--m-active) hover:text-(--m-text) pointer-coarse:min-h-11 pointer-coarse:py-2 pointer-coarse:text-sm",
        FOCUS,
        props.selected && "text-(--m-text) ring-2 ring-inset ring-(--m-text)",
      )}
    >
      <Glyph kind={stageGlyph(props.stage)} className="mt-0.75" />
      <span className="line-clamp-2 wrap-break-word">{props.title}</span>
    </button>
  );
});

const RowView = memo(function RowView(props: {
  row: BoardRow;
  /** The lane's first row: a group heading there needs no space above it. */
  first: boolean;
  variant: BoardRowVariant;
  selected: boolean;
  onOpenCard: (cardId: string) => void;
  onGroup: OnBoardGroup | undefined;
}) {
  const { row, onGroup } = props;
  switch (row.kind) {
    case "head":
      return <LaneHeader label={row.label} count={row.count} />;
    case "group": {
      const inner = (
        <>
          {row.foldable ? (
            <ChevronRightIcon
              aria-hidden
              className={cn(
                "size-3.5 shrink-0 transition-transform duration-150 motion-reduce:transition-none",
                row.open && "rotate-90",
              )}
            />
          ) : null}
          <span className="min-w-0 leading-tight wrap-break-word">{row.label}</span>
          <span className="ms-auto tabular-nums">{row.count.toLocaleString("en-US")}</span>
        </>
      );
      const layout = cn(
        "flex min-h-7 w-full items-center gap-1.5 rounded-lg px-1 py-1 text-xs text-(--m-muted) pointer-coarse:min-h-11 pointer-coarse:text-sm",
        !props.first && "mt-1.5",
      );
      return row.foldable && onGroup ? (
        <button
          type="button"
          aria-expanded={row.open}
          onClick={() => onGroup(row.id, row.open ? "closed" : "open")}
          className={cn(layout, "text-left hover:text-(--m-text)", FOCUS)}
        >
          {inner}
        </button>
      ) : (
        <div className={layout}>{inner}</div>
      );
    }
    case "more":
      return (
        <button
          type="button"
          aria-label={`Show ${row.count.toLocaleString("en-US")} more`}
          onClick={(event) => {
            if (onGroup) showMore(event.currentTarget, () => onGroup(row.id, "all"));
          }}
          className={cn(
            "flex h-7 w-full items-center rounded-lg px-1 text-left text-xs text-(--m-muted) tabular-nums hover:text-(--m-text) pointer-coarse:h-11 pointer-coarse:text-sm",
            FOCUS,
          )}
        >
          {row.count.toLocaleString("en-US")} more
        </button>
      );
    case "reasons":
      return (
        <ul className="flex flex-col gap-1.5 rounded-xl bg-(--m-surface) px-2.75 py-2.25 text-xs pointer-coarse:text-sm">
          {row.items.map((item) => (
            <li key={item.label} className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 wrap-break-word">{item.label}</span>
              <span className="shrink-0 text-(--m-muted) tabular-nums">
                {item.count.toLocaleString("en-US")}
              </span>
            </li>
          ))}
        </ul>
      );
    case "note":
      return (
        <p className="px-1 py-1 text-xs text-(--m-muted) pointer-coarse:text-sm">{row.text}</p>
      );
    case "card":
      if (props.variant === "shipped") {
        return (
          <ShippedRow
            id={row.card.id}
            title={row.card.title}
            stage={row.card.stage}
            selected={props.selected}
            onOpen={props.onOpenCard}
          />
        );
      }
      return (
        <CardTile
          card={row.card}
          raised={props.variant === "raised"}
          asks={props.variant === "raised" || props.variant === "asks"}
          showStage={props.variant === "staged"}
          selected={props.selected}
          onOpen={props.onOpenCard}
        />
      );
  }
});

/**
 * Pressing "N more" removes the pressed row: focus moves to a card it revealed
 * instead of dropping to the page.
 */
function showMore(button: HTMLButtonElement, expand: () => void): void {
  const lane: ParentNode = button.closest("section, main") ?? document;
  const cards = () => [...lane.querySelectorAll<HTMLElement>("[data-card]")];
  const before = new Set(cards().map((tile) => tile.dataset.card));
  expand();
  let tries = 0;
  const focusRevealed = () => {
    // The topmost new card stands where the pressed row stood; a long list's rows
    // are not in the page in reading order, so position decides, not order.
    let revealed: HTMLElement | null = null;
    let top = Number.POSITIVE_INFINITY;
    for (const tile of cards()) {
      if (before.has(tile.dataset.card)) continue;
      const at = tile.getBoundingClientRect().top;
      if (at < top) {
        top = at;
        revealed = tile;
      }
    }
    if (revealed) revealed.focus({ preventScroll: true });
    else if ((tries += 1) < 12) requestAnimationFrame(focusRevealed);
  };
  requestAnimationFrame(focusRevealed);
}

const rowKey = (row: BoardRow) => row.key;
const rowType = (row: BoardRow) => row.kind;

/**
 * A lane's rows in their own scroller. `header` scrolls away with the rows (the
 * phone list's column switcher).
 */
export const BoardRows = memo(function BoardRows(props: {
  rows: ReadonlyArray<BoardRow>;
  variant?: BoardRowVariant | undefined;
  selectedCardId: string | undefined;
  onOpenCard: (cardId: string) => void;
  onGroup?: OnBoardGroup | undefined;
  className?: string | undefined;
  header?: React.ReactNode;
  /** Shown instead of rows when the lane has none. */
  empty?: React.ReactNode;
  /** Every row in the page, no scroller of its own: for a short list inside a page that scrolls. */
  plain?: boolean;
  /**
   * Cards in the lane. It picks the renderer, so that opening or folding a group
   * (which changes the row count, not this) never swaps the scroller and loses the place.
   */
  count?: number | undefined;
}) {
  const variant = props.variant ?? "tile";
  const dense = variant === "shipped";
  const selected = props.selectedCardId;

  if (props.plain || (props.count ?? props.rows.length) <= VIRTUAL_ROWS_MIN) {
    return (
      <div
        className={cn(
          "flex min-h-0 flex-col",
          props.plain ? "shrink-0" : "overflow-x-hidden overflow-y-auto",
          dense ? "gap-1" : "gap-2",
          HIDE_SCROLLBAR,
          props.className,
        )}
      >
        {props.header}
        {props.rows.length === 0 ? props.empty : null}
        {props.rows.map((row, index) => (
          <RowView
            key={row.key}
            row={row}
            first={index === 0}
            variant={variant}
            selected={row.kind === "card" && row.card.id === selected}
            onOpenCard={props.onOpenCard}
            onGroup={props.onGroup}
          />
        ))}
      </div>
    );
  }

  return (
    <LegendList<BoardRow>
      data={props.rows}
      keyExtractor={rowKey}
      getItemType={rowType}
      extraData={selected}
      estimatedItemSize={dense ? 36 : 104}
      drawDistance={DRAW_DISTANCE_PX}
      {...(props.header ? { ListHeaderComponent: <>{props.header}</> } : {})}
      className={cn("min-h-0 overflow-x-hidden", HIDE_SCROLLBAR, props.className)}
      renderItem={({ item, index }) => (
        <div className={dense ? "pb-1" : "pb-2"}>
          <RowView
            row={item}
            first={index === 0}
            variant={variant}
            selected={item.kind === "card" && item.card.id === selected}
            onOpenCard={props.onOpenCard}
            onGroup={props.onGroup}
          />
        </div>
      )}
    />
  );
});
