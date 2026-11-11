import { LegendList } from "@legendapp/list/react";
import { memo } from "react";

import type { BoardRow } from "@t3tools/client-runtime/ardud/kanban";

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
const ROW_GAP_PX = 8;

export type BoardRowVariant = "tile" | "raised" | "staged" | "shipped";

/** A phone gets one card per row; a portrait iPad two or three (17rem cards, 8px gaps). */
export const listColumns = (width: number | null) =>
  width === null ? 1 : Math.max(1, Math.floor((width + ROW_GAP_PX) / (272 + ROW_GAP_PX)));

export function LaneHeader(props: { label: string; count: number; tone?: "warn" }) {
  return (
    <div
      className={cn(
        "flex h-6 shrink-0 items-center justify-between px-1 text-xs pointer-coarse:h-8 pointer-coarse:text-sm",
        props.tone === "warn" ? "text-(--m-warning)" : "text-(--m-muted)",
      )}
    >
      <span className="font-medium">{props.label}</span>
      <span className="tabular-nums">{props.count}</span>
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
        "grid w-full grid-cols-[12px_1fr] items-start gap-1.75 rounded-lg bg-(--m-surface) px-1.5 py-1.25 text-left text-xs text-(--m-muted) outline-none hover:bg-(--m-active) hover:text-(--m-text) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent) pointer-coarse:min-h-11 pointer-coarse:py-2 pointer-coarse:text-sm",
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
  variant: BoardRowVariant;
  selected: boolean;
  onOpenCard: (cardId: string) => void;
}) {
  const { row } = props;
  if (row.kind === "head") return <LaneHeader label={row.label} count={row.count} />;
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
      showStage={props.variant === "staged"}
      selected={props.selected}
      onOpen={props.onOpenCard}
    />
  );
});

const rowKey = (row: BoardRow) => row.key;
const rowType = (row: BoardRow) => row.kind;

/**
 * A lane's rows in their own scroller. `header` scrolls with the rows (the phone
 * list's pinned block and stage tabs); `columns` lays cards out as a grid.
 */
export const BoardRows = memo(function BoardRows(props: {
  rows: ReadonlyArray<BoardRow>;
  variant?: BoardRowVariant | undefined;
  selectedCardId: string | undefined;
  onOpenCard: (cardId: string) => void;
  className?: string | undefined;
  header?: React.ReactNode;
  columns?: number | undefined;
  /** Shown instead of rows when the lane has none. */
  empty?: React.ReactNode;
}) {
  const variant = props.variant ?? "tile";
  const columns = props.columns ?? 1;
  const dense = variant === "shipped";
  const selected = props.selectedCardId;

  if (props.rows.length <= VIRTUAL_ROWS_MIN) {
    return (
      <div
        className={cn(
          "flex min-h-0 flex-col overflow-y-auto overflow-x-hidden",
          dense ? "gap-1" : "gap-2",
          HIDE_SCROLLBAR,
          props.className,
        )}
      >
        {props.header}
        {props.rows.length === 0 ? props.empty : null}
        {columns > 1 ? (
          <div
            className="grid gap-2"
            style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
          >
            {props.rows.map((row) => (
              <RowView
                key={row.key}
                row={row}
                variant={variant}
                selected={row.kind === "card" && row.card.id === selected}
                onOpenCard={props.onOpenCard}
              />
            ))}
          </div>
        ) : (
          props.rows.map((row) => (
            <RowView
              key={row.key}
              row={row}
              variant={variant}
              selected={row.kind === "card" && row.card.id === selected}
              onOpenCard={props.onOpenCard}
            />
          ))
        )}
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
      numColumns={columns}
      {...(columns > 1 ? { columnWrapperStyle: { columnGap: ROW_GAP_PX } } : {})}
      {...(props.header ? { ListHeaderComponent: <>{props.header}</> } : {})}
      className={cn("min-h-0 overflow-x-hidden", HIDE_SCROLLBAR, props.className)}
      renderItem={({ item }) => (
        <div className={dense ? "pb-1" : "pb-2"}>
          <RowView
            row={item}
            variant={variant}
            selected={item.kind === "card" && item.card.id === selected}
            onOpenCard={props.onOpenCard}
          />
        </div>
      )}
    />
  );
});
