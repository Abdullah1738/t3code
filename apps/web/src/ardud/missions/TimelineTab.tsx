import { useEffect, useMemo, useState } from "react";

import type { MissionId } from "@t3tools/contracts";
import {
  actorChoices,
  actorNames,
  consequences,
  EMPTY_TIMELINE_FILTER,
  filterTimeline,
  formatDayLabel,
  formatTimeOfDay,
  inTimelineRange,
  kindChoices,
  lineage,
  needsOlderTimeline,
  restartEvent,
  timelineDays,
  timelineReaches,
  timelineRows,
  toggleFilter,
  type FilterChoice,
  type MissionTimelineEvent,
  type TimelineDay,
  type TimelineFilter,
  type TimelineLine,
  type TimelineRange,
} from "@t3tools/client-runtime/ardud/missions";

import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";
import { revertChange } from "./deskCommands";
import { Figure, FoldRow, PageLine, Segmented } from "./deskParts";
import { RevertButton } from "./MissionForms";
import { MissionSection } from "./MissionSection";
import {
  useMasterRoleId,
  useMissionLanes,
  useMissionRecovery,
  useMissionRoles,
} from "./missionsStore";
import { loadOlderTimeline, useTimelineWindow } from "./useMissionFeeds";
import { useNowMs } from "./useNowMs";

// Timeline tab: the mission's log under day heads, with a Kind and a Who
// facet column beside it. Today and 7 days page back on their own; All pages
// on request. A line with causes or consequences opens its lineage in place.

const RANGES: ReadonlyArray<{ value: TimelineRange; label: string }> = [
  { value: "today", label: "Today" },
  { value: "week", label: "7 days" },
  { value: "all", label: "All" },
];

const DAY_ROWS = 20;
const WHO_SHOWN = 6;

const capitalised = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export function TimelineTab(props: { missionId: MissionId }) {
  const { missionId } = props;
  const log = useTimelineWindow(missionId);
  const masterRoleId = useMasterRoleId(missionId);
  const lanes = useMissionLanes(missionId);
  const roles = useMissionRoles(missionId);
  const restart = useMissionRecovery(missionId)?.[0] ?? null;
  const nowMs = useNowMs();
  const [range, setRange] = useState<TimelineRange>("week");
  const [filter, setFilter] = useState<TimelineFilter>(EMPTY_TIMELINE_FILTER);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [openDays, setOpenDays] = useState<ReadonlySet<string>>(new Set());
  // Set by "Jump to the restart": the instant the restart was found.
  const [jumpTo, setJumpTo] = useState<string | null>(null);

  const names = useMemo(() => actorNames(lanes ?? [], roles?.roles ?? []), [lanes, roles]);
  const view = useMemo(() => {
    if (!log) return null;
    const inRange = log.events.filter((event) => inTimelineRange(event, range, nowMs));
    const shown = filterTimeline(inRange, filter);
    return {
      kinds: kindChoices(inRange),
      actors: actorChoices(inRange, masterRoleId, names),
      total: inRange.length,
      count: shown.length,
      days: timelineDays(timelineRows(shown, log.events, masterRoleId, names), nowMs),
    };
  }, [log, range, filter, masterRoleId, names, nowMs]);

  // Today and 7 days page back until the oldest loaded event leaves the range.
  useEffect(() => {
    if (log && needsOlderTimeline(log, range, nowMs)) {
      loadOlderTimeline(missionId).catch(() => undefined);
    }
  }, [log, range, nowMs, missionId]);

  // Jump to the restart: page back until the log reaches it.
  const reached = log !== undefined && jumpTo !== null && timelineReaches(log, jumpTo);
  useEffect(() => {
    if (log && jumpTo !== null && !timelineReaches(log, jumpTo)) {
      loadOlderTimeline(missionId).catch(() => undefined);
    }
  }, [log, jumpTo, missionId]);
  const focus = reached && log && jumpTo !== null ? restartEvent(log.events, jumpTo) : null;

  const focusKey = useMemo(() => {
    if (!focus || !view) return null;
    // Runs fold into their newest event: the focused event sits in the last
    // row that starts at or after it.
    const at = Date.parse(focus.at);
    let found: { day: string; row: string } | null = null;
    for (const day of view.days) {
      for (const row of day.rows) {
        if (Date.parse(row.event.at) >= at) found = { day: day.key, row: row.key };
      }
    }
    return found;
  }, [focus, view]);

  const focusRow = focusKey?.row ?? null;
  useEffect(() => {
    if (focusRow === null) return;
    document
      .getElementById(`timeline-${focusRow}`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focusRow]);

  if (!log || !view) return <p className="text-sm text-(--m-muted)">Loading timeline…</p>;
  const oldest = log.events.at(-1);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <PageLine
        actions={
          <>
            <Segmented
              label="Range"
              value={range}
              options={RANGES}
              onChange={(value) => {
                setRange(value);
                setJumpTo(null);
              }}
            />
            {restart ? (
              <Button
                size="sm"
                variant="outline"
                disabled={jumpTo !== null && !reached}
                onClick={() => {
                  setRange("all");
                  setFilter(EMPTY_TIMELINE_FILTER);
                  setJumpTo(restart.detectedAt);
                }}
              >
                Jump to the restart
              </Button>
            ) : null}
          </>
        }
      >
        <Figure>{log.events.length}</Figure> events
        {oldest ? ` since ${formatDayLabel(oldest.at)}` : null}
      </PageLine>

      <div className="grid min-w-0 items-start gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-3 lg:sticky lg:top-6 lg:gap-5.5">
          <Facet
            title="Kind"
            all={view.total}
            choices={view.kinds}
            picked={filter.groups}
            onAll={() => setFilter({ ...filter, groups: [] })}
            onToggle={(value) =>
              setFilter({ ...filter, groups: toggleFilter(filter.groups, value) })
            }
          />
          <Facet
            title="Who"
            choices={view.actors}
            picked={filter.actors}
            fold={WHO_SHOWN}
            onToggle={(value) =>
              setFilter({ ...filter, actors: toggleFilter(filter.actors, value) })
            }
          />
        </div>

        <MissionSection title="Events" caption={view.count}>
          {view.days.length === 0 ? <p className="text-sm text-(--m-muted)">No events</p> : null}
          {view.days.map((day) => (
            <DaySection
              key={day.key}
              day={day}
              events={log.events}
              open={openDays.has(day.key) || focusKey?.day === day.key}
              onOpen={() => setOpenDays(new Set([...openDays, day.key]))}
              openKey={openKey}
              focusKey={focusRow}
              onToggle={(key) => setOpenKey(openKey === key ? null : key)}
            />
          ))}
          {range === "all" && log.hasOlder ? (
            <FoldRow
              hidden={1}
              label="Older events"
              onShow={() => {
                loadOlderTimeline(missionId).catch(() => undefined);
              }}
            />
          ) : null}
        </MissionSection>
      </div>
    </div>
  );
}

function DaySection(props: {
  day: TimelineDay;
  events: ReadonlyArray<MissionTimelineEvent>;
  open: boolean;
  onOpen: () => void;
  openKey: string | null;
  focusKey: string | null;
  onToggle: (key: string) => void;
}) {
  const { day } = props;
  const rows = props.open ? day.rows : day.rows.slice(0, DAY_ROWS);
  const hidden = day.rows.length - rows.length;
  const where =
    day.heading === "Today" || day.heading === "Yesterday"
      ? day.heading.toLowerCase()
      : `on ${day.heading}`;
  return (
    <section aria-label={day.heading} className="flex min-w-0 flex-col">
      <h3 className="flex items-baseline gap-2 pt-4.5 pb-2 text-sm font-semibold">
        {day.heading}
        <span className="text-xs font-normal text-(--m-muted) tabular-nums">
          {day.count}
          <span className="sr-only"> events</span>
        </span>
      </h3>
      <ol className="flex min-w-0 flex-col">
        {rows.map((row) => (
          <EventRow
            key={row.key}
            row={row}
            events={props.events}
            open={props.openKey === row.key}
            focused={props.focusKey === row.key}
            onToggle={() => props.onToggle(row.key)}
          />
        ))}
      </ol>
      <FoldRow hidden={hidden} label={`${hidden} more ${where}`} onShow={props.onOpen} />
    </section>
  );
}

function EventRow(props: {
  row: TimelineLine;
  events: ReadonlyArray<MissionTimelineEvent>;
  open: boolean;
  focused: boolean;
  onToggle: () => void;
}) {
  const { row } = props;
  const steps = row.lineageSteps;
  return (
    <li
      id={`timeline-${row.key}`}
      className={cn(
        "grid min-w-0 grid-cols-[44px_minmax(0,1fr)] items-baseline gap-x-3.5 py-3 sm:grid-cols-[52px_minmax(0,1fr)]",
        "border-t border-(--m-rule)",
        props.focused && "rounded-lg bg-(--m-band)",
      )}
    >
      <time dateTime={row.event.at} className="text-xs text-(--m-muted) tabular-nums">
        {formatTimeOfDay(row.event.at)}
      </time>
      <div className="flex min-w-0 flex-col">
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
          <b className="truncate font-semibold">{capitalised(row.actor)}</b>
          <span
            className={cn(
              "text-xs",
              row.by === "owner" ? "text-(--m-accent-text)" : "text-(--m-muted)",
            )}
          >
            {row.kicker}
          </span>
          {row.count > 1 ? (
            <span className="text-xs text-(--m-muted) tabular-nums">
              {row.count}
              <span className="sr-only"> times</span>
            </span>
          ) : null}
        </p>
        <p className="mt-0.75 max-w-prose text-sm text-pretty">{row.summary}</p>
        {row.revert ? (
          <div className="mt-1 self-start">
            <RevertButton
              label={`Revert: ${row.summary}`}
              onRevert={() => revertChange(row.revert!)}
            />
          </div>
        ) : null}
        {row.because ? (
          <p className="mt-1 max-w-prose text-xs text-(--m-muted)">{row.because}</p>
        ) : null}
        {steps > 0 ? (
          <button
            type="button"
            aria-expanded={props.open}
            onClick={props.onToggle}
            className="mt-1 self-start rounded-md text-xs text-(--m-muted) outline-none hover:text-(--m-text) focus-visible:ring-2 focus-visible:ring-(--m-accent) focus-visible:ring-inset"
          >
            {steps === 1 ? "1 linked event" : `${steps} linked events`}
          </button>
        ) : null}
        {props.open ? <Lineage event={row.event} events={props.events} /> : null}
      </div>
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
      className="mt-2.5 flex max-w-prose min-w-0 flex-col rounded-xl bg-(--m-raised) px-3.5 py-3"
    >
      {chain.map((entry) => {
        const here = entry.id === props.event.id;
        return (
          <li
            key={entry.id}
            className="grid min-w-0 grid-cols-[44px_16px_minmax(0,1fr)] items-baseline py-1.25 text-sm"
          >
            <time dateTime={entry.at} className="text-xs text-(--m-muted) tabular-nums">
              {formatTimeOfDay(entry.at)}
            </time>
            <span
              aria-hidden
              className={cn(
                "size-2 self-center rounded-full",
                here ? "bg-(--m-accent)" : "bg-(--m-bar-3)",
              )}
            />
            <span className={cn("min-w-0 text-pretty", here && "font-medium")}>
              {entry.summary}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Facet<T extends string>(props: {
  title: string;
  choices: ReadonlyArray<FilterChoice<T>>;
  picked: ReadonlyArray<T>;
  onToggle: (value: T) => void;
  /** Shows an "All" entry that clears the facet. */
  all?: number;
  onAll?: () => void;
  /** Shows this many, then "N more". */
  fold?: number;
}) {
  const [unfolded, setUnfolded] = useState(false);
  const limit = props.fold ?? props.choices.length;
  const shown = unfolded ? props.choices : props.choices.slice(0, limit);
  const hidden = props.choices.length - shown.length;
  if (props.choices.length === 0) return null;
  return (
    <div role="group" aria-label={props.title} className="flex min-w-0 flex-col gap-1">
      <h2 className="hidden px-2.5 text-xs text-(--m-muted) lg:block">{props.title}</h2>
      <div className="flex min-w-0 gap-1.5 overflow-x-auto lg:flex-col lg:gap-0.5 lg:overflow-visible">
        {props.all !== undefined && props.onAll ? (
          <FacetButton
            label="All"
            count={props.all}
            pressed={props.picked.length === 0}
            onClick={props.onAll}
          />
        ) : null}
        {shown.map((choice) => (
          <FacetButton
            key={choice.value}
            label={capitalised(choice.label)}
            count={choice.count}
            pressed={props.picked.includes(choice.value)}
            onClick={() => props.onToggle(choice.value)}
          />
        ))}
        {hidden > 0 ? (
          <FacetButton label={`${hidden} more`} quiet onClick={() => setUnfolded(true)} />
        ) : null}
      </div>
    </div>
  );
}

function FacetButton(props: {
  label: string;
  count?: number;
  pressed?: boolean;
  quiet?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={props.quiet ? undefined : (props.pressed ?? false)}
      onClick={props.onClick}
      className={cn(
        "flex h-8.5 shrink-0 items-center gap-2 rounded-full px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-(--m-accent) focus-visible:ring-inset lg:h-8 lg:w-full lg:rounded-lg lg:px-2.5",
        props.pressed
          ? "bg-(--m-active) font-medium text-(--m-text)"
          : "bg-(--m-surface) text-(--m-text) hover:bg-(--m-active) lg:bg-transparent lg:hover:bg-(--m-surface)",
        props.quiet && "text-(--m-muted)",
      )}
    >
      <span className="truncate">{props.label}</span>
      {props.count !== undefined ? (
        <span className="ms-auto text-xs font-normal text-(--m-muted) tabular-nums">
          {props.count}
        </span>
      ) : null}
    </button>
  );
}
