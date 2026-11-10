import type { KanbanAskAction } from "@t3tools/contracts";
import { CheckIcon } from "lucide-react";
import type { ReactNode } from "react";

import { KanbanMarkdown } from "../links";
import { Label } from "./ui";

/**
 * What approving will run, laid out so nothing has to be looked up: the exact
 * command, where it runs, what it changes, the evidence it rests on and how to
 * undo it.
 */
export function ActionDetails(props: { action: KanbanAskAction }) {
  const { action } = props;
  const rows: Array<readonly [string, ReactNode]> = [];
  if (action.target) rows.push(["Where", action.target]);
  if (action.summary) {
    rows.push([
      "Changes",
      <div key="summary" className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
        <KanbanMarkdown text={action.summary} />
      </div>,
    ]);
  }
  if (action.evidence && action.evidence.length > 0) {
    rows.push([
      "Evidence",
      <ul key="evidence" className="flex flex-wrap gap-x-4 gap-y-1">
        {action.evidence.map((line) => (
          <li key={line} className="flex gap-2">
            <CheckIcon aria-hidden className="mt-1 size-3.5 shrink-0 text-(--m-positive)" />
            <span className="min-w-0 [overflow-wrap:anywhere]">{line}</span>
          </li>
        ))}
      </ul>,
    ]);
  }
  if (action.undo) {
    rows.push([
      "To undo",
      <span key="undo" className="[overflow-wrap:anywhere]">
        {action.undo}
      </span>,
    ]);
  }
  return (
    <section aria-label="What this runs" className="rounded-2xl bg-(--m-surface) p-4">
      {action.command ? (
        <>
          <Label className="mb-2">Runs exactly this</Label>
          <pre className="mb-4 overflow-x-auto rounded-xl bg-(--m-ground) px-3.5 py-2.5 font-mono text-sm leading-6 ring-1 ring-inset ring-(--m-rule)">
            <span aria-hidden className="text-(--m-muted) select-none">
              ${" "}
            </span>
            {action.command}
          </pre>
        </>
      ) : null}
      <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-4 gap-y-2.5 max-sm:grid-cols-1 max-sm:gap-y-1">
        {rows.map(([name, value]) => (
          <div key={name} className="contents">
            <dt className="text-sm text-(--m-muted) max-sm:mt-2 max-sm:first:mt-0">{name}</dt>
            <dd className="min-w-0">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
