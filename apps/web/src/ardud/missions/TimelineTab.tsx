import { type ReactNode, useMemo, useState } from "react";

import type { MissionId } from "@t3tools/contracts";
import {
  actorChoices,
  consequences,
  EMPTY_TIMELINE_FILTER,
  filterTimeline,
  formatTimeOfDay,
  kindChoices,
  lineage,
  timelineDays,
  timelineRows,
  toggleFilter,
  type FilterChoice,
  type MissionTimelineEvent,
  type TimelineFilter,
  type TimelineLine,
} from "@t3tools/client-runtime/ardud/missions";
import { GitBranchIcon } from "lucide-react";

import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";
import { ByMarker } from "./cards/chips";
import { SampleMark } from "./MissionSection";
import { isSampleFeed, useMasterRoleId, useMissionTimeline } from "./missionsStore";
import { useNowMs } from "./useNowMs";

// Timeline tab: the mission's log under day heads. Each line is a time, a
// kicker, the summary and who did it; repeated lines fold into one with a
// count, and a line with causes or consequences opens its lineage in place.

export function TimelineTab(props: { missionId: MissionId }) {
  const events = useMissionTimeline(props.missionId);
  const masterRoleId = useMasterRoleId(props.missionId);
  const nowMs = useNowMs();
  const [filter, setFilter] = useState<TimelineFilter>(EMPTY_TIMELINE_FILTER);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const view = useMemo(() => {
    if (!events) return null;
    return {
      kinds: kindChoices(events),
      actors: actorChoices(events, masterRoleId),
      days: timelineDays(timelineRows(filterTimeline(events, filter), events, masterRoleId), nowMs),
    };
  }, [events, filter, masterRoleId, nowMs]);
  if (!events || !view) return <p className="text-sm text-muted-foreground">Loading timeline…</p>;

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="flex min-w-0 flex-col gap-1.5">
        <ChoiceRow
          label="Kind"
          choices={view.kinds}
          picked={filter.groups}
          onToggle={(value) => setFilter({ ...filter, groups: toggleFilter(filter.groups, value) })}
          aside={isSampleFeed("timeline") ? <SampleMark /> : null}
        />
        <ChoiceRow
          label="Who"
          choices={view.actors}
          picked={filter.actors}
          onToggle={(value) => setFilter({ ...filter, actors: toggleFilter(filter.actors, value) })}
        />
      </div>

      {view.days.length === 0 ? <p className="text-sm text-muted-foreground">No events</p> : null}
      {view.days.map((day) => (
        <section key={day.key} aria-label={day.heading} className="flex min-w-0 flex-col gap-1">
          <h2 className="flex items-baseline gap-2 text-xs font-medium text-muted-foreground">
            {day.heading}
            <span className="tabular-nums">
              {day.count}
              <span className="sr-only"> events</span>
            </span>
          </h2>
          <ol className="flex min-w-0 flex-col">
            {day.rows.map((row) => (
              <TimelineRowItem
                key={row.key}
                row={row}
                events={events}
                open={openKey === row.key}
                onToggle={() => setOpenKey(openKey === row.key ? null : row.key)}
              />
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

function TimelineRowItem(props: {
  row: TimelineLine;
  events: ReadonlyArray<MissionTimelineEvent>;
  open: boolean;
  onToggle: () => void;
}) {
  const { row } = props;
  return (
    <li className="grid min-w-0 grid-cols-[40px_minmax(0,1fr)_auto] items-start gap-x-2.5 border-t border-border/60 py-2 first:border-t-0">
      <time dateTime={row.event.at} className="pt-px text-xs tabular-nums text-muted-foreground">
        {formatTimeOfDay(row.event.at)}
      </time>
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="min-w-0 text-sm text-pretty">
          <span className="me-1.5 text-xs font-medium text-muted-foreground">{row.kicker}</span>
          {row.summary}
          {row.count > 1 ? (
            <span className="ms-1.5 inline-flex rounded-full bg-foreground/6 px-1.5 text-xs tabular-nums text-muted-foreground">
              {row.count}
              <span className="sr-only"> times</span>
            </span>
          ) : null}
        </p>
        {row.lineageSteps > 0 ? (
          <Button
            size="xs"
            variant="ghost-muted"
            className="self-start"
            aria-expanded={props.open}
            onClick={props.onToggle}
          >
            <GitBranchIcon aria-hidden />
            <span className="tabular-nums">{row.lineageSteps}</span>
            <span className="sr-only">steps in lineage</span>
          </Button>
        ) : null}
        {props.open ? <Lineage event={row.event} events={props.events} /> : null}
      </div>
      <span className="flex min-h-5 items-center">
        {row.by ? (
          <ByMarker by={row.by} />
        ) : (
          <span className="max-w-28 truncate text-xs text-muted-foreground">{row.actor}</span>
        )}
      </span>
    </li>
  );
}

function Lineage(props: {
  event: MissionTimelineEvent;
  events: ReadonlyArray<MissionTimelineEvent>;
}) {
  const chain = [...lineage(props.event, props.events), ...consequences(props.event, props.events)];
  return (
    <ol
      aria-label="Lineage"
      className="mt-1 flex min-w-0 flex-col gap-1 border-s border-border ps-3"
    >
      {chain.map((entry) => (
        <li
          key={entry.id}
          className={cn(
            "grid min-w-0 grid-cols-[40px_minmax(0,1fr)] gap-x-2 text-xs",
            entry.id === props.event.id ? "text-foreground" : "text-muted-foreground",
          )}
        >
          <time dateTime={entry.at} className="tabular-nums">
            {formatTimeOfDay(entry.at)}
          </time>
          <span className="min-w-0 text-pretty">{entry.summary}</span>
        </li>
      ))}
    </ol>
  );
}

function ChoiceRow<T extends string>(props: {
  label: string;
  choices: ReadonlyArray<FilterChoice<T>>;
  picked: ReadonlyArray<T>;
  onToggle: (value: T) => void;
  aside?: ReactNode;
}) {
  return (
    <div role="group" aria-label={props.label} className="flex flex-wrap items-center gap-1">
      <span className="me-1 w-10 text-xs text-muted-foreground">{props.label}</span>
      {props.choices.map((choice) => {
        const on = props.picked.includes(choice.value);
        return (
          <Button
            key={choice.value}
            size="xs"
            variant={on ? "secondary" : "ghost-muted"}
            aria-pressed={on}
            onClick={() => props.onToggle(choice.value)}
          >
            {choice.label}
            <span className="tabular-nums text-muted-foreground">{choice.count}</span>
          </Button>
        );
      })}
      {props.aside ? <span className="ms-auto">{props.aside}</span> : null}
    </div>
  );
}
