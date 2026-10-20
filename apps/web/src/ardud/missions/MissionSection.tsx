import type { ReactNode } from "react";

import { cn } from "../../lib/utils";

/** A Desk panel: one tone step above the page, no border or shadow at rest. */
export const PANEL_CLASS =
  "flex min-w-0 flex-col gap-1.5 rounded-3xl bg-(--m-surface) px-4.5 pt-4 pb-4.5 text-(--m-text) sm:px-6 sm:pt-5 sm:pb-5.5";

/** Quiet marker for a section whose data is fixture sample, not the server's. */
export function SampleMark() {
  return <span className="shrink-0 text-xs text-(--m-muted)">Sample</span>;
}

/** One titled panel of a mission page. */
export function MissionSection(props: {
  title: string;
  caption?: ReactNode;
  accessory?: ReactNode;
  /** The section reads a feed the server does not serve yet. */
  sample?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const headingId = `mission-section-${props.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <section aria-labelledby={headingId} className={cn(PANEL_CLASS, props.className)}>
      <div className="flex min-h-8 min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5">
        <h2 id={headingId} className="text-sm font-semibold">
          {props.title}
        </h2>
        {props.caption ? (
          <span className="min-w-0 text-xs text-(--m-muted)">{props.caption}</span>
        ) : null}
        {props.sample ? <SampleMark /> : null}
        {props.accessory ? <div className="ms-auto shrink-0">{props.accessory}</div> : null}
      </div>
      {props.children}
    </section>
  );
}
