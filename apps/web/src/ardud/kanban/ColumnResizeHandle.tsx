import { type KeyboardEvent } from "react";

import { clampColumnWidth, clampGroupWidth, type BoardColumnKey } from "@t3tools/client-runtime/ardud/kanban";

import { useResizeDrag } from "../../hooks/useResizeDrag";
import { cn } from "../../lib/utils";

export const COLUMN_WIDTH_PROPERTY = "--col-w";
const KEY_STEP = 16;

/**
 * Drag handle on a column edge. The column is pinned to its measured width for the
 * drag, live moves only rewrite --col-w (no React render per move), and the saved
 * width is committed once on release. The pre-drag inline style is restored on cancel.
 */
export function ColumnResizeHandle(props: {
  /** A stage key, or "group" for the shared width of non-stage grouping columns. */
  columnKey: string;
  label: string;
  edge: "left" | "right";
  /** Saved px width, or null while the column is still sized by its flex default. */
  width: number | null;
  /** Element carrying --col-w for the live drag; defaults to the column itself. */
  liveTarget?: (handle: HTMLElement) => HTMLElement | null;
  onCommit: (width: number) => void;
  onReset: () => void;
}) {
  const clamp = (value: number) =>
    props.columnKey === "group"
      ? clampGroupWidth(value)
      : clampColumnWidth(props.columnKey as BoardColumnKey, value);

  const handlers = useResizeDrag<HTMLDivElement>((event) => {
    const host = event.currentTarget.parentElement;
    if (!host) return null;
    const target = props.liveTarget?.(event.currentTarget) ?? host;
    // The rendered width is the truth: a flex-1 column measures its real share.
    const startWidth = host.getBoundingClientRect().width;
    const previous = { width: host.style.width, flex: host.style.flex };
    host.style.flex = "none";
    host.style.width = `var(${COLUMN_WIDTH_PROPERTY})`;
    target.style.setProperty(COLUMN_WIDTH_PROPERTY, `${startWidth}px`);
    return {
      width: startWidth,
      edge: props.edge,
      resize(value) {
        const next = clamp(value);
        target.style.setProperty(COLUMN_WIDTH_PROPERTY, `${next}px`);
        return next;
      },
      finish(finalWidth, moved) {
        if (moved) props.onCommit(finalWidth);
      },
      cleanup() {
        target.style.removeProperty(COLUMN_WIDTH_PROPERTY);
        host.style.width = previous.width;
        host.style.flex = previous.flex;
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
    const host = event.currentTarget.parentElement;
    if (!host) return;
    event.preventDefault();
    const flip = props.edge === "left" ? -1 : 1;
    // Step from the rendered width, so an unsaved column moves from where it really is.
    props.onCommit(clamp(host.getBoundingClientRect().width + delta * flip));
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${props.label}`}
      aria-valuenow={props.width ?? undefined}
      tabIndex={0}
      onDoubleClick={props.onReset}
      onKeyDown={onKeyDown}
      // Without this, a finger drag inside the horizontal scroller becomes native
      // panning and the browser sends pointercancel before the resize starts.
      className={cn(
        "group absolute inset-y-0 z-10 w-2 touch-none cursor-col-resize select-none outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)",
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
