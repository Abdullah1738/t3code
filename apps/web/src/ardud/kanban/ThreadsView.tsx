import { Link } from "@tanstack/react-router";
import type { KanbanThreadRow } from "@t3tools/contracts";
import { ageView } from "@t3tools/client-runtime/ardud/common";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { useBoardThreads } from "./kanbanStore";
import { cn } from "../../lib/utils";

/**
 * The board's runs in two groups: Evaluators (purpose) and Cards (number and
 * title). Running runs come first; ended history is collapsed. Each row opens
 * its thread, which is read-only there because the board drives it.
 */
export function ThreadsView(props: { boardId: string; nowMs: number }) {
  const threads = useBoardThreads(props.boardId);
  if (threads === undefined) return null;
  if (threads.length === 0) return <p className="text-(--m-muted)">No threads yet.</p>;

  const evaluators = threads.filter((row) => row.role === "evaluator");
  const cardRuns = threads.filter((row) => row.role !== "evaluator");

  return (
    <div className="flex flex-col gap-6">
      <ThreadGroup
        title="Evaluators"
        empty="No evaluator threads yet."
        rows={evaluators}
        nowMs={props.nowMs}
      />
      <ThreadGroup title="Cards" empty="No card threads yet." rows={cardRuns} nowMs={props.nowMs} />
    </div>
  );
}

function ThreadGroup(props: {
  title: string;
  empty: string;
  rows: ReadonlyArray<KanbanThreadRow>;
  nowMs: number;
}) {
  const running = props.rows.filter((row) => row.running);
  const ended = props.rows.filter((row) => !row.running);
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-(--m-muted) text-sm font-medium">{props.title}</h3>
      {props.rows.length === 0 ? (
        <p className="text-(--m-muted) text-sm">{props.empty}</p>
      ) : (
        <>
          {running.map((row) => (
            <ThreadRow key={row.threadId} row={row} nowMs={props.nowMs} />
          ))}
          {ended.length === 0 ? null : (
            <details className="group">
              <summary className="text-(--m-muted) cursor-pointer text-sm">
                Ended · {ended.length}
              </summary>
              <div className="mt-2 flex flex-col gap-2">
                {ended.map((row) => (
                  <ThreadRow key={row.threadId} row={row} nowMs={props.nowMs} />
                ))}
              </div>
            </details>
          )}
        </>
      )}
    </section>
  );
}

function ThreadRow(props: { row: KanbanThreadRow; nowMs: number }) {
  const { row } = props;
  const environmentId = usePrimaryEnvironmentId();
  // Card identity and purpose stay visible next to the title, so repeated
  // evaluator runs and renamed or reused card threads can be told apart.
  const identity =
    row.role === "evaluator"
      ? `Evaluator · ${row.purpose ?? "run"}`
      : row.cardNumber !== null
        ? `Card #${row.cardNumber}${row.cardTitle ? ` ${row.cardTitle}` : ""}`
        : "Card";
  const body = (
    <>
      <span className="flex min-w-0 flex-col">
        <span className="min-w-0 truncate font-medium">{row.title ?? identity}</span>
        <span className="text-(--m-muted) min-w-0 truncate text-xs">
          {identity}
          {row.model === null ? "" : ` · ${row.model.model}`}
          {row.lastActivityAt === null
            ? ""
            : ` · ${ageView(row.lastActivityAt, props.nowMs)?.label ?? ""} ago`}
        </span>
      </span>
      <span className="text-(--m-muted) shrink-0 text-xs">{row.running ? "running" : "ended"}</span>
    </>
  );
  const className = cn(
    "flex items-center justify-between gap-3 rounded-md border px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)",
  );
  if (!environmentId) return <div className={className}>{body}</div>;
  return (
    <Link
      to="/$environmentId/$threadId"
      params={{ environmentId, threadId: row.threadId }}
      className={className}
    >
      {body}
    </Link>
  );
}
