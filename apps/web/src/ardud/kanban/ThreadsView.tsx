import type { KanbanThreadLink } from "@t3tools/contracts";
import type { KanbanBoardState } from "@t3tools/client-runtime/ardud/kanban";

import { useBoardThreads } from "./kanbanStore";

/**
 * The board's threads, grouped by who runs them. Board threads are read-only
 * here: the owner reads a run but does not send into it, same as provider
 * subagents. Cards show their number and title; evaluators show their purpose.
 */
export function ThreadsView(props: { boardId: string; state: KanbanBoardState | undefined }) {
  const threads = useBoardThreads(props.boardId);
  if (threads === undefined) return null;
  if (threads.length === 0) return <p className="text-(--m-muted)">No threads yet.</p>;

  const evaluators = threads.filter((link) => link.role === "evaluator");
  const cardThreads = threads.filter((link) => link.role !== "evaluator");
  const cards = props.state?.cards;
  const cardLabel = (link: KanbanThreadLink) => {
    const card = link.cardId === null ? undefined : cards?.get(link.cardId);
    return card ? `#${card.number} ${card.title}` : (link.cardId ?? "Card");
  };

  return (
    <div className="flex flex-col gap-6">
      <ThreadGroup
        title="Evaluators"
        empty="No evaluator threads yet."
        links={evaluators}
        label={(link) => link.purpose ?? "evaluator"}
      />
      <ThreadGroup
        title="Cards"
        empty="No card threads yet."
        links={cardThreads}
        label={cardLabel}
      />
    </div>
  );
}

function ThreadGroup(props: {
  title: string;
  empty: string;
  links: ReadonlyArray<KanbanThreadLink>;
  label: (link: KanbanThreadLink) => string;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-(--m-muted) text-sm font-medium">{props.title}</h3>
      {props.links.length === 0 ? (
        <p className="text-(--m-muted) text-sm">{props.empty}</p>
      ) : (
        props.links.map((link) => (
          <div
            key={link.threadId}
            className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
          >
            <span className="min-w-0 truncate">{props.label(link)}</span>
            <span className="text-(--m-muted) shrink-0 text-xs">
              {link.role}
              {link.endedAt === null ? " · running" : " · ended"}
            </span>
          </div>
        ))
      )}
    </section>
  );
}
