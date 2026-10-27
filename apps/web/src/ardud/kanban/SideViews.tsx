import { useState } from "react";

import { ageView } from "@t3tools/client-runtime/ardud/common";

import ChatMarkdown from "../../components/ChatMarkdown";
import { cn } from "../../lib/utils";
import { useWiki } from "./kanbanStore";
import { Tabs } from "./parts";
import { ScriptsView } from "./ScriptsView";

export function WikiView(props: { boardId: string; nowMs: number }) {
  const pages = useWiki(props.boardId);
  const [slug, setSlug] = useState<string | undefined>(undefined);
  if (pages === undefined) return null;
  if (pages.length === 0) return <p className="text-(--m-muted)">No pages yet.</p>;
  const page = pages.find((entry) => entry.slug === slug) ?? pages[0];
  return (
    <div className="grid min-h-0 flex-1 gap-6 md:grid-cols-[220px_1fr]">
      <ul className="flex flex-col gap-0.5">
        {pages.map((entry) => (
          <li key={entry.slug}>
            <button
              type="button"
              onClick={() => setSlug(entry.slug)}
              aria-current={entry.slug === page?.slug ? "true" : undefined}
              className={cn(
                "flex h-9 w-full items-center rounded-xl px-2.5 text-left text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)",
                entry.slug === page?.slug
                  ? "bg-(--m-surface)"
                  : "text-(--m-muted) hover:text-(--m-text)",
              )}
            >
              <span className="truncate">{entry.title}</span>
            </button>
          </li>
        ))}
      </ul>
      {page ? (
        <article className="min-w-0 overflow-y-auto pb-10">
          <h2 className="flex items-baseline gap-3 text-xl font-semibold tracking-tight">
            {page.title}
            <span className="text-xs font-normal text-(--m-muted) tabular-nums">
              {ageView(page.updatedAt, props.nowMs)?.label ?? ""}
            </span>
          </h2>
          <div className="mt-3 max-w-[70ch] text-sm leading-relaxed">
            <ChatMarkdown text={page.body} cwd={undefined} headingLevelOffset={2} />
          </div>
        </article>
      ) : null}
    </div>
  );
}

/** Automations and Scripts share one page; automations land later. */
export function AutomationsView(props: {
  boardId: string;
  nowMs: number;
  tab: "automations" | "scripts";
  onTab: (tab: "automations" | "scripts") => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <Tabs
        label="Automations"
        value={props.tab}
        onChange={props.onTab}
        options={[
          { value: "automations", label: "Automations" },
          { value: "scripts", label: "Scripts" },
        ]}
      />
      {props.tab === "automations" ? (
        <p className="text-(--m-muted)">No automations yet.</p>
      ) : (
        <ScriptsView boardId={props.boardId} nowMs={props.nowMs} />
      )}
    </div>
  );
}
