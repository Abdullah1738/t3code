import { PauseIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";

const dayMonth = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });

const day = (atIso: string) => {
  const at = Date.parse(atIso);
  return Number.isFinite(at) ? dayMonth.format(at) : "";
};

/**
 * Who set the pause, as a reader names them. The stored value is "owner" or a
 * role followed by a thread id, which is never shown.
 */
export const pausedBy = (by: string): string => {
  const role = by.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (role === "owner") return "You";
  if (role === "evaluator") return "The evaluator";
  if (role === "work" || role === "review" || role === "thread") return "A card thread";
  return "An agent";
};

/** A note longer than this is folded to two lines until asked for. */
const LONG_NOTE = 220;

/**
 * A paused board says so above everything: since when, how much it still lets
 * through, and the words it was paused with.
 */
export function PauseBanner(props: {
  /** When the pause was set, and by whom ("owner" is the reader). */
  at: string;
  by: string;
  reason: string;
  /** Open cards on the pause's keep list, out of all open cards; unknown off the board view. */
  flow: { readonly through: number; readonly open: number } | null;
  onLift: () => void;
  canLift: boolean;
  className?: string | undefined;
}) {
  const since = day(props.at);
  const who = pausedBy(props.by);
  const long = props.reason.length > LONG_NOTE;
  const [whole, setWhole] = useState(false);
  return (
    <div
      className={cn(
        "flex shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1 rounded-xl bg-(--m-warnband) px-3.5 py-2 text-sm",
        props.className,
      )}
    >
      <PauseIcon aria-hidden className="size-3.5 shrink-0 text-(--m-warning)" />
      <span className="font-medium text-(--m-warning)">
        {since ? `Paused since ${since}` : "Paused"}
      </span>
      {props.flow ? (
        <span className="tabular-nums">
          Lets {props.flow.through.toLocaleString("en-US")} of{" "}
          {props.flow.open.toLocaleString("en-US")} through
        </span>
      ) : null}
      <span className="flex-1" />
      {props.canLift ? (
        <button
          type="button"
          onClick={props.onLift}
          className="h-7 shrink-0 rounded-full bg-(--m-ground) px-3 font-medium outline-none hover:bg-(--m-active) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent) pointer-coarse:h-11 pointer-coarse:px-4"
        >
          Lift the pause
        </button>
      ) : null}
      <p
        className={cn(
          "min-w-0 basis-full wrap-break-word",
          long && !whole ? "line-clamp-2" : "max-h-[40vh] overflow-y-auto",
        )}
      >
        {who}
        {since ? `, ${since}` : ""}: “{props.reason}”
      </p>
      {long ? (
        <button
          type="button"
          aria-expanded={whole}
          onClick={() => setWhole((open) => !open)}
          className="-mx-1 rounded px-1 font-medium text-(--m-muted) underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-(--m-accent) pointer-coarse:min-h-11"
        >
          {whole ? "Show less" : "Show the whole note"}
        </button>
      ) : null}
    </div>
  );
}
