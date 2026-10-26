import { activeGoals, goalPage, type KanbanBoardState } from "@t3tools/client-runtime/ardud/kanban";
import { formatDayLabel } from "@t3tools/client-runtime/ardud/missions";

import { Chip, GoalBar, Glyph, stageGlyph } from "./parts";

export function GoalsList(props: {
  state: KanbanBoardState;
  onOpenGoal: (goalId: string) => void;
}) {
  const goals = activeGoals(props.state);
  if (goals.length === 0) return <p className="text-(--m-muted)">No goals yet.</p>;
  return (
    <ul className="flex max-w-3xl flex-col gap-2">
      {goals.map((entry) => (
        <li key={entry.goal.id}>
          <button
            type="button"
            onClick={() => props.onOpenGoal(entry.goal.id)}
            className="grid w-full grid-cols-[minmax(0,1fr)_minmax(80px,200px)_auto] items-center gap-4 rounded-2xl bg-(--m-surface) px-4 py-3.5 text-left outline-none hover:bg-(--m-active) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)"
          >
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate text-base font-medium">{entry.goal.name}</span>
              {entry.goal.now ? (
                <span className="truncate text-sm text-(--m-muted)">{entry.goal.now.text}</span>
              ) : null}
            </span>
            <GoalBar progress={entry.progress} />
            <span className="flex items-center gap-2 text-xs text-(--m-muted) tabular-nums">
              {entry.needsOwner > 0 ? (
                <Glyph kind="wait" label={`${entry.needsOwner} need you`} />
              ) : null}
              {entry.progress.verified}/{entry.progress.total}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function GoalView(props: {
  state: KanbanBoardState;
  goalId: string;
  nowMs: number;
  onOpenCard: (cardId: string) => void;
}) {
  const page = goalPage(props.state, props.goalId, props.nowMs);
  if (!page) return <p className="text-(--m-muted)">This goal is gone.</p>;
  const { progress } = page;
  return (
    <div className="grid gap-9 pb-10 lg:grid-cols-[minmax(0,1fr)_330px]">
      <div className="flex min-w-0 flex-col gap-6">
        <div className="flex flex-col gap-3">
          <h2 className="text-2xl leading-tight font-semibold tracking-tight">{page.goal.name}</h2>
          {page.projects.length > 0 ? (
            <span className="flex flex-wrap gap-1.5">
              {page.projects.map((project) => (
                <Chip key={project}>{project}</Chip>
              ))}
            </span>
          ) : null}
          <div className="flex max-w-xl items-center gap-3">
            <span className="flex-1">
              <GoalBar progress={progress} height={8} />
            </span>
            <span className="text-sm text-(--m-muted) tabular-nums">
              {progress.verified} of {progress.total} verified
            </span>
          </div>
        </div>
        <section className="flex flex-col gap-2">
          <h3 className="flex items-baseline gap-2 text-base font-semibold">
            Now
            {page.now ? (
              <span className="text-xs font-normal text-(--m-muted) tabular-nums">
                {page.now.age}
              </span>
            ) : null}
          </h3>
          <p className="max-w-[62ch] text-base leading-relaxed">
            {page.now?.text ?? <span className="text-(--m-muted)">Nothing yet.</span>}
          </p>
        </section>
        {page.story.length > 0 ? (
          <section className="flex flex-col gap-3">
            <h3 className="text-base font-semibold">Story</h3>
            <ol className="flex max-w-[66ch] flex-col gap-2.5">
              {page.story.map((entry, index) => (
                <li
                  key={`${entry.at}:${entry.text}`}
                  className="grid grid-cols-[26px_84px_1fr] items-baseline gap-2"
                >
                  <span className="font-semibold text-(--m-muted) tabular-nums">{index + 1}</span>
                  <span className="text-xs whitespace-nowrap text-(--m-muted) tabular-nums">
                    {formatDayLabel(entry.at)}
                  </span>
                  <span className="leading-normal">{entry.text}</span>
                </li>
              ))}
            </ol>
          </section>
        ) : null}
      </div>
      <div className="flex flex-col gap-2.5">
        {page.stages.map((column) => (
          <section
            key={column.stage}
            aria-label={column.label}
            className="rounded-xl bg-(--m-surface) px-3 pt-2 pb-1.5"
          >
            <h4 className="flex h-6 items-center justify-between text-xs font-medium text-(--m-muted)">
              {column.label}
              <span className="tabular-nums">{column.cards.length}</span>
            </h4>
            {column.cards.map((card) => (
              <button
                key={card.id}
                type="button"
                onClick={() => props.onOpenCard(card.id)}
                className="-mx-1.5 grid min-h-8 w-[calc(100%+12px)] grid-cols-[14px_1fr_auto] items-center gap-2 rounded-lg px-1.5 text-left text-sm font-medium outline-none hover:bg-(--m-active) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)"
              >
                <Glyph kind={stageGlyph(card.stage)} />
                <span className="truncate">{card.title}</span>
                <span className="text-xs font-normal text-(--m-muted) tabular-nums">
                  #{card.number}
                </span>
              </button>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
