import type { ReactNode } from "react";

import { cn } from "../../lib/utils";

/** One titled block of the mission overview. */
export function MissionSection(props: {
  title: string;
  caption?: ReactNode;
  accessory?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const headingId = `mission-section-${props.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <section
      aria-labelledby={headingId}
      className={cn(
        "flex min-w-0 flex-col gap-2 rounded-lg border border-border/60 p-4",
        props.className,
      )}
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <h2 id={headingId} className="text-sm font-medium text-foreground">
          {props.title}
        </h2>
        {props.caption ? (
          <p className="min-w-0 text-xs text-muted-foreground">{props.caption}</p>
        ) : null}
        {props.accessory ? <div className="ms-auto shrink-0">{props.accessory}</div> : null}
      </div>
      {props.children}
    </section>
  );
}
