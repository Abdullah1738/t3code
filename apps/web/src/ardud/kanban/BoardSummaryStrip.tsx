import { Link } from "@tanstack/react-router";
import { ArrowRightIcon } from "lucide-react";

import type { BoardSummary } from "@t3tools/client-runtime/ardud/kanban";

import { cn } from "../../lib/utils";

const count = (value: number) => value.toLocaleString("en-US");

function Cell(props: { label: string; className?: string | undefined; children: React.ReactNode }) {
  return (
    <div className={cn("flex min-w-0 flex-col justify-start px-4 py-2.5", props.className)}>
      <dt className="truncate text-xs text-(--m-muted)">{props.label}</dt>
      <dd className="text-xl leading-7 font-semibold whitespace-nowrap tabular-nums">
        {props.children}
      </dd>
    </div>
  );
}

/**
 * The board in five numbers, one divided container: what runs, what could, what
 * can't, who it waits on. They count the whole board, whatever the filter shows.
 */
export function BoardSummaryStrip(props: {
  boardId: string;
  summary: BoardSummary;
  /** Two cells a row instead of one row of five. */
  phone: boolean;
  className?: string | undefined;
}) {
  const { summary, phone } = props;
  const share = summary.slots > 0 ? Math.min(1, summary.running / summary.slots) : 0;
  const rule = "border-(--m-rule)";
  return (
    <dl
      aria-label="Flow"
      className={cn(
        "grid shrink-0 rounded-xl ring-1 ring-(--m-rule) ring-inset",
        phone ? "grid-cols-2" : "grid-cols-[1.5fr_repeat(4,minmax(0,1fr))]",
        props.className,
      )}
    >
      <Cell label="Running now" className={phone ? cn("col-span-2 border-b", rule) : undefined}>
        {count(summary.running)}
        {summary.slots > 0 ? (
          <span className="ms-1.5 text-sm font-normal text-(--m-muted)">
            of {count(summary.slots)} slots
          </span>
        ) : null}
        <span aria-hidden className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-(--m-chip)">
          <span
            className="block h-full rounded-full bg-(--m-accent)"
            style={{ width: `${(share * 100).toFixed(1)}%` }}
          />
        </span>
      </Cell>
      <Cell label="Ready to start" className={phone ? cn("border-b", rule) : cn("border-s", rule)}>
        {count(summary.ready)}
      </Cell>
      <Cell
        label={summary.paused ? "Held by the pause" : "Blocked"}
        className={cn("border-s", rule, phone && "border-b")}
      >
        {count(summary.blocked)}
      </Cell>
      <Cell label="Waiting on authors" className={phone ? undefined : cn("border-s", rule)}>
        {count(summary.authors)}
      </Cell>
      <div className={cn("flex min-w-0 border-s", rule)}>
        <Link
          to="/needs-you"
          search={{ board: props.boardId }}
          className={cn(
            "flex min-w-0 flex-1 flex-col justify-start px-4 py-2.5 outline-none hover:bg-(--m-surface) focus-visible:ring-2 focus-visible:ring-(--m-accent) focus-visible:ring-inset",
            phone ? "rounded-ee-xl" : "rounded-e-xl",
          )}
        >
          <dt className="truncate text-xs text-(--m-muted)">Needs you</dt>
          <dd
            className={cn(
              "flex items-center gap-1.5 text-xl leading-7 font-semibold tabular-nums",
              summary.needsYou > 0 ? "text-(--m-warning)" : "text-(--m-text)",
            )}
          >
            {count(summary.needsYou)}
            <ArrowRightIcon aria-hidden className="size-4" />
          </dd>
        </Link>
      </div>
    </dl>
  );
}
