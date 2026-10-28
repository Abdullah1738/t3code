import { type KeyboardEvent } from "react";

import { clampColumnWidth, clampGroupWidth, type BoardColumnKey } from "@t3tools/client-runtime/ardud/kanban";

import { useResizeDrag } from "../../hooks/useResizeDrag";
import { cn } from "../../lib/utils";

export const COLUMN_WIDTH_PROPERTY = "--col-w";
const KEY_STEP = 16;

/**
 * Drag handle on a column edge. Live drag writes --col-w on the column, and the
 * width is saved once on release, so the board never re-renders per pointer move.
 */
export function ColumnResizeHandle(props: {
  /** "group" for the shared width of non-stage grouping columns. */
  columnKey: BoardColumnKey | "group";
  label: string;
  edge: "left" | "right";
  /** Current px width, or null when the column is still sized by default. */
  width: number | null;
  /** Measured width used as the drag start when the column has no saved width. */
  measure: () => number;
  onCommit: (width: number) => void;
  onReset: () => void;
}) {
  const clamp = (value: number) =>
    props.columnKey === "group"
      ? clampGroupWidth(value)
      : clampColumnWidth(props.columnKey, value);
  const handlers = useResizeDrag<HTMLDivElement>((event) => {
    const host = event.currentTarget.parentElement;
    const startWidth = props.width ?? props.measure();
    return {
      width: startWidth,
      edge: props.edge,
      resize(value) {
        const next = clamp(value);
        host?.style.setProperty(COLUMN_WIDTH_PROPERTY, `${next}px`);
        return next;
      },
      finish(finalWidth, moved) {
        if (moved) props.onCommit(finalWidth);
      },
      // The live var must not outlive the drag: a stale value would override the next saved width.
      cleanup() {
        host?.style.removeProperty(COLUMN_WIDTH_PROPERTY);
      },
    };
  }, props.columnKey);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const delta =
      event.key === "ArrowRight" || event.key === "ArrowUp"
        ? KEY_STEP
        : event.key === "ArrowLeft" || event.key === "ArrowDown"
          ? -KEY_STEP
          : 0;
    if (delta === 0) return;
    event.preventDefault();
    const base = props.width ?? props.measure();
    const flip = props.edge === "left" ? -1 : 1;
    props.onCommit(clamp(base + delta * flip));
  };

  const current = props.width ?? props.measure();

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${props.label}`}
      aria-valuemin={140}
      aria-valuemax={560}
      aria-valuenow={Math.round(current)}
      tabIndex={0}
      onDoubleClick={props.onReset}
      onKeyDown={onKeyDown}
      className={cn(
        "group absolute inset-y-0 z-10 w-2 cursor-col-resize select-none outline-none focus-visible:ring-2 focus-visible:ring-(--m-accent)",
        props.edge === "right" ? "-right-1" : "-left-1",
      )}
      {...handlers}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors duration-150 group-hover:bg-(--m-muted) group-active:bg-(--m-accent)"
      />
    </div>
  );
}
