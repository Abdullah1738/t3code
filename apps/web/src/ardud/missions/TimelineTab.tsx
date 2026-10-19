import { useMemo, useState } from "react";

import type { MissionId } from "@t3tools/contracts";
import {
  actorChoices,
  consequences,
  EMPTY_TIMELINE_FILTER,
  filterTimeline,
  formatDayLabel,
  formatTimeOfDay,
  kindChoices,
  lineage,
  successions,
  timelineRows,
  toggleFilter,
  type FilterChoice,
  type MissionTimelineEvent,
  type TimelineFilter,
} from "@t3tools/client-runtime/ardud/missions";

import { Button } from "../../components/ui/button";
import { MutedLines } from "./MissionForms";
import { MissionSection } from "./MissionSection";
import { isSampleFeed, useMasterRoleId, useMissionTimeline } from "./missionsStore";

// Timeline tab, placeholder presentation. Filters, lineage and successions
// come from client-runtime (timelineViewModel).

export function TimelineTab(props: { missionId: MissionId }) {
  const events = useMissionTimeline(props.missionId);
  const masterRoleId = useMasterRoleId(props.missionId);
  const [filter, setFilter] = useState<TimelineFilter>(EMPTY_TIMELINE_FILTER);
  const [openId, setOpenId] = useState<string | null>(null);
  const view = useMemo(() => {
    if (!events) return null;
    const shown = filterTimeline(events, filter);
    return {
      kinds: kindChoices(events),
      actors: actorChoices(events, masterRoleId),
      rows: timelineRows(shown, events, masterRoleId),
      successions: successions(events, masterRoleId),
    };
  }, [events, filter, masterRoleId]);
  if (!events || !view) return <p className="text-sm text-muted-foreground">Loading timeline…</p>;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <MissionSection title="Filter">
        <ChoiceRow
          label="Kind"
          choices={view.kinds}
          picked={filter.groups}
          onToggle={(value) => setFilter({ ...filter, groups: toggleFilter(filter.groups, value) })}
        />
        <ChoiceRow
          label="Who"
          choices={view.actors}
          picked={filter.actors}
          onToggle={(value) => setFilter({ ...filter, actors: toggleFilter(filter.actors, value) })}
        />
      </MissionSection>

      <MissionSection title={`Events (${view.rows.length})`} sample={isSampleFeed("timeline")}>
        <ul className="flex flex-col divide-y divide-border/60">
          {view.rows.map((row) => (
            <li key={row.event.id} className="flex flex-col gap-0.5 py-1.5 text-sm">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="tabular-nums text-muted-foreground">{eventTime(row.event)}</span>
                <span className="font-medium text-foreground">{row.actor}</span>
                <span className="text-muted-foreground">{row.event.kind}</span>
              </div>
              <p className="text-foreground">{row.event.summary}</p>
              <MutedLines
                lines={[
                  row.causeSummary ? `Because: ${row.causeSummary}` : null,
                  row.consequenceCount > 0
                    ? `Led to ${row.consequenceCount} ${row.consequenceCount === 1 ? "event" : "events"}`
                    : null,
                ]}
              />
              {row.event.causedBy || row.consequenceCount > 0 ? (
                <Button
                  size="xs"
                  variant="ghost"
                  className="self-start"
                  onClick={() => setOpenId(openId === row.event.id ? null : row.event.id)}
                >
                  {openId === row.event.id ? "Hide lineage" : "Show lineage"}
                </Button>
              ) : null}
              {openId === row.event.id ? (
                <ol className="flex flex-col gap-0.5 ps-3 text-xs text-muted-foreground">
                  {[...lineage(row.event, events), ...consequences(row.event, events)].map(
                    (entry) => (
                      <li key={entry.id}>
                        {eventTime(entry)} {entry.summary}
                      </li>
                    ),
                  )}
                </ol>
              ) : null}
            </li>
          ))}
        </ul>
      </MissionSection>

      <MissionSection title="Successions" sample={isSampleFeed("timeline")}>
        {view.successions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No handoffs yet.</p>
        ) : (
          <MutedLines
            lines={view.successions.map(
              (entry) => `${eventTime(entry.event)} ${entry.who}: ${entry.event.summary}`,
            )}
          />
        )}
      </MissionSection>
    </div>
  );
}

function eventTime(event: MissionTimelineEvent) {
  return `${formatDayLabel(event.at)} ${formatTimeOfDay(event.at)}`;
}

function ChoiceRow<T extends string>(props: {
  label: string;
  choices: ReadonlyArray<FilterChoice<T>>;
  picked: ReadonlyArray<T>;
  onToggle: (value: T) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1 text-sm">
      <span className="me-1 text-muted-foreground">{props.label}</span>
      {props.choices.map((choice) => {
        const on = props.picked.includes(choice.value);
        return (
          <Button
            key={choice.value}
            size="xs"
            variant={on ? "secondary" : "ghost"}
            aria-pressed={on}
            onClick={() => props.onToggle(choice.value)}
          >
            {choice.label} ({choice.count})
          </Button>
        );
      })}
    </div>
  );
}
