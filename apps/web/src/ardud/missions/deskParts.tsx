import type { ReactNode } from "react";

import { cn } from "../../lib/utils";

// Small Desk pieces the mission tabs share: the page line with its figures,
// the segmented switch, the pill chip and the "N more" row. Colours come from
// the Missions tokens in missions.css.

/** The tab's one summary line, figures in ink, actions at the end. */
export function PageLine(props: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-6 gap-y-3">
      <p className="min-w-0 text-sm text-(--m-muted)">{props.children}</p>
      {props.actions ? (
        <div className="flex flex-wrap items-center gap-2 sm:ms-auto">{props.actions}</div>
      ) : null}
    </div>
  );
}

/** A key number inside a PageLine. */
export function Figure(props: { children: ReactNode }) {
  return <b className="font-medium text-(--m-text) tabular-nums">{props.children}</b>;
}

/** Pill switch between a few options; the pressed one sits raised. */
export function Segmented<T extends string>(props: {
  label: string;
  value: T;
  options: ReadonlyArray<{ readonly value: T; readonly label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div
      role="group"
      aria-label={props.label}
      className="inline-flex gap-0.5 rounded-full bg-(--m-chip) p-0.75"
    >
      {props.options.map((option) => {
        const pressed = option.value === props.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={pressed}
            onClick={() => props.onChange(option.value)}
            className={cn(
              "h-7.5 rounded-full px-3.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-(--m-accent) focus-visible:ring-inset",
              pressed
                ? "bg-(--m-raised) font-medium text-(--m-text)"
                : "text-(--m-muted) hover:text-(--m-text)",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** Pill label: a holder, a kind, a scope. */
export function DeskChip(props: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 max-w-full shrink-0 items-center truncate rounded-full bg-(--m-raised) px-2.5 text-xs font-medium text-(--m-text)",
        props.className,
      )}
    >
      {props.children}
    </span>
  );
}

/** "N more" under a list, full width, quiet. */
export function FoldRow(props: { hidden: number; onShow: () => void; label?: string }) {
  if (props.hidden <= 0) return null;
  return (
    <button
      type="button"
      onClick={props.onShow}
      className="flex h-9 w-full items-center border-t border-(--m-rule) text-start text-sm text-(--m-muted) outline-none hover:text-(--m-text) focus-visible:ring-2 focus-visible:ring-(--m-accent) focus-visible:ring-inset"
    >
      {props.label ?? `${props.hidden} more`}
    </button>
  );
}

/** List rows are split by a hairline in the rule tone; the first one has none. */
export const DESK_ROW = "border-t border-(--m-rule) first:border-t-0";

/** Count beside a panel title. */
export function PanelCount(props: { count: number }) {
  return <span className="text-xs text-(--m-muted) tabular-nums">{props.count}</span>;
}
