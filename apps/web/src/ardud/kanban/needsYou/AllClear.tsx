import { askOutcome } from "@t3tools/client-runtime/ardud/kanban";
import { CircleCheckIcon } from "lucide-react";
import { useEffect } from "react";

import { loadClosedAsks, useAskStore } from "./askStore";
import { sameDay } from "./snoozeTimes";
import { Btn } from "./ui";

/** The queue is clear: what today came to, and the way to what he answered. */
export function AllClear(props: {
  nowMs: number;
  waiting: number;
  snoozed: number;
  onHistory: () => void;
}) {
  const closed = useAskStore((state) => state.closed);
  useEffect(() => {
    void loadClosedAsks();
  }, []);
  const answered =
    closed === null
      ? null
      : closed.filter(
          (entry) =>
            askOutcome(entry.ask) !== null &&
            entry.ask.answer !== undefined &&
            sameDay(entry.ask.answer.at, props.nowMs),
        ).length;
  const facts: ReadonlyArray<readonly [string, number | null]> = [
    ["Answered today", answered],
    ["Waiting on agents", props.waiting],
    ["Snoozed", props.snoozed],
  ];
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto p-7 scrollbar-gutter-both max-sm:p-4">
      <div className="flex max-w-full flex-col items-start gap-3">
        <CircleCheckIcon aria-hidden className="size-9 text-(--m-accent-text)" strokeWidth={1.5} />
        <div>
          <p className="text-xl font-semibold">Nothing needs you</p>
          <p className="mt-1 text-sm text-(--m-muted)">
            Agents carry on with what you answered. New asks show up here.
          </p>
        </div>
        <dl className="flex flex-wrap gap-x-7 gap-y-3">
          {facts.map(([name, value]) => (
            <div key={name} className="flex flex-col-reverse">
              <dd className="text-xl font-semibold tabular-nums">{value ?? "–"}</dd>
              <dt className="text-xs text-(--m-muted)">{name}</dt>
            </div>
          ))}
        </dl>
        <Btn onClick={props.onHistory} className="mt-1">
          See what you answered
        </Btn>
      </div>
    </div>
  );
}
