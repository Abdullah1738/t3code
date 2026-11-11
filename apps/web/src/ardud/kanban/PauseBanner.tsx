import { PauseIcon } from "lucide-react";

import { cn } from "../../lib/utils";

const dayMonth = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });

const day = (atIso: string) => {
  const at = Date.parse(atIso);
  return Number.isFinite(at) ? dayMonth.format(at) : "";
};

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
  const who = props.by === "owner" ? "You" : props.by;
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
      <p className="min-w-0 basis-full wrap-break-word">
        {who}
        {since ? `, ${since}` : ""}: “{props.reason}”
      </p>
    </div>
  );
}
