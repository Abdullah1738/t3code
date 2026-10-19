import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import * as Schema from "effect/Schema";

import type {
  LaneCounts,
  MissionId,
  MissionRecoveryState,
  RecoveryCause,
} from "@t3tools/contracts";
import {
  boardFacts,
  boardFigures,
  boardGreeting,
  DAY_BIN_MAX_HEIGHT,
  DAY_BIN_MINUTES,
  dayBinHeight,
  dayHourLabel,
  dayLine,
  formatDayLabel,
  formatRelative,
  formatTimeOfDay,
  laneBars,
  laneTotal,
  ownerWaitingEntries,
  stuckLanes,
  type BoardFigure,
  type DayBin,
  type DayLine,
  type MissionInboxSnapshot,
  type MissionOverviewSnapshot,
  type OwnerRequest,
} from "@t3tools/client-runtime/ardud/missions";

import { Button } from "../../components/ui/button";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { cn } from "../../lib/utils";
import { PANEL_CLASS } from "./MissionSection";
import {
  useMissionLanes,
  useMissionReviewPolicy,
  useMissionRooms,
  useMissionTimeline,
} from "./missionsStore";
import { LoadingRows } from "./sections/NeedsYou";
import { FoldButton } from "./sections/SectionShell";
import { useMissionsConnection } from "./useMissionsConnection";

const LINK_FOCUS =
  "outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

/**
 * The top of the board: the greeting with today's facts, the day line of the
 * rooms, and the four figures (hidden when the layout hides the header).
 */
export function BoardLead(props: {
  overview: MissionOverviewSnapshot;
  inbox: MissionInboxSnapshot | undefined;
  requests: ReadonlyArray<OwnerRequest> | undefined;
  showFigures: boolean;
  nowMs: number;
}) {
  const { overview, inbox, nowMs } = props;
  const missionId = overview.mission.id;
  const events = useMissionTimeline(missionId);
  const rooms = useMissionRooms(missionId);
  const review = useMissionReviewPolicy(missionId);
  const connection = useMissionsConnection();
  const waiting = useMemo(() => (inbox ? ownerWaitingEntries(inbox) : undefined), [inbox]);
  const looked = overview.ownerLastLookedAt;
  const facts = useMemo(
    () =>
      boardFacts({
        waiting: waiting ?? [],
        events: events ?? [],
        ownerLastLookedAt: looked,
        nowMs,
      }),
    [waiting, events, looked, nowMs],
  );
  const line = useMemo(
    () =>
      events
        ? dayLine({
            events,
            roomTitles: new Map((rooms ?? []).map((entry) => [entry.room.id, entry.room.title])),
            masterRoleId: overview.mission.masterRoleId,
            ownerLastLookedAt: looked,
            nowMs,
          })
        : undefined,
    [events, rooms, overview.mission.masterRoleId, looked, nowMs],
  );
  const figures = useMemo(
    () =>
      boardFigures({
        requests: props.requests ?? [],
        lanes: overview.lanes,
        events: events ?? [],
        reviews: review?.reviews ?? [],
        masterRoleId: overview.mission.masterRoleId,
        ownerLastLookedAt: looked,
        nowMs,
      }),
    [props.requests, overview.lanes, events, review, overview.mission.masterRoleId, looked, nowMs],
  );
  const loading: Record<BoardFigure["key"], boolean> = {
    requests: props.requests === undefined,
    lanes: false,
    since: events === undefined,
    reviews: review === undefined,
  };
  // A mission without a review policy has no reviews to count.
  const shown = figures.filter((figure) => figure.key !== "reviews" || review !== null);
  return (
    <div className="grid min-w-0 grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-12">
      <div className="col-span-full flex min-w-0 flex-col py-2 lg:col-span-6 lg:self-center lg:pe-6">
        <h1 className="max-w-[24ch] text-2xl leading-tight font-medium tracking-tight text-balance lg:text-3xl">
          {waiting === undefined
            ? overview.mission.title
            : boardGreeting(overview.mission.title, waiting.length, nowMs)}
        </h1>
        <p className="mt-3.5 flex flex-wrap gap-x-5.5 gap-y-1.5 text-sm text-(--m-muted)">
          {facts.map((fact) => (
            <span key={fact.key}>
              {fact.before}
              <b className="font-medium text-(--m-text)">{fact.strong}</b>
              {fact.after}
            </span>
          ))}
        </p>
      </div>
      <DayPanel line={line} lookedAt={looked} />
      {props.showFigures
        ? shown.map((figure) => (
            <FigurePanel
              key={figure.key}
              missionId={missionId}
              figure={figure}
              loading={loading[figure.key]}
              wide={shown.length === 3}
              stale={connection.lastUpdateAt}
            />
          ))
        : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Day line: one strip per room, 5-minute columns since local midnight

function DayPanel(props: { line: DayLine | undefined; lookedAt: string | null }) {
  const { line } = props;
  return (
    <section
      aria-labelledby="mission-day-line"
      className={cn(PANEL_CLASS, "col-span-full max-lg:order-last lg:col-span-6")}
    >
      <div className="flex min-h-8 min-w-0 items-center gap-2.5">
        <h2 id="mission-day-line" className="text-sm font-semibold">
          Today in the rooms
        </h2>
        <span className="text-xs text-(--m-muted) tabular-nums">since {dayHourLabel(0)}</span>
      </div>
      {line === undefined ? (
        <LoadingRows />
      ) : line.rows.length === 0 ? (
        <p className="pt-2 pb-1 text-sm text-(--m-muted)">No messages yet today.</p>
      ) : (
        <div className="mt-1 rounded-xl bg-(--m-raised) px-3.5 pt-3.5 pb-3 sm:px-4.5 sm:pt-4">
          <p className="mb-3 flex flex-wrap gap-x-5.5 gap-y-1.5 text-sm text-(--m-muted)">
            <span>
              <b className="font-semibold text-(--m-text)">{line.totals.messages}</b>{" "}
              {line.totals.messages === 1 ? "message" : "messages"}
            </span>
            <span>
              <b className="font-semibold text-(--m-accent-text)">{line.totals.masterDecisions}</b>{" "}
              {line.totals.masterDecisions === 1 ? "master decision" : "master decisions"}
            </span>
            <span>
              <b className="font-semibold text-(--m-negative)">{line.totals.blockers}</b>{" "}
              {line.totals.blockers === 1 ? "blocker" : "blockers"}
            </span>
          </p>
          <ul className="flex flex-col">
            {line.rows.map((row) => (
              <li key={row.roomId} className={cn(DAY_ROW_CLASS, "h-7.5")}>
                <span className="truncate text-sm">{row.name}</span>
                <span className="text-end text-xs text-(--m-muted) tabular-nums">{row.total}</span>
                <svg
                  viewBox={`0 0 ${line.minutes} ${DAY_BIN_MAX_HEIGHT}`}
                  preserveAspectRatio="none"
                  role="img"
                  aria-label={`${row.name}: ${row.total} ${row.total === 1 ? "message" : "messages"} today`}
                  className="block h-6 w-full"
                >
                  {line.lookedMinute !== null ? (
                    <rect
                      x={line.lookedMinute}
                      y={0}
                      width={line.minutes - line.lookedMinute}
                      height={DAY_BIN_MAX_HEIGHT}
                      className="fill-(--m-band)"
                    />
                  ) : null}
                  {row.bins.map((bin) => (
                    <DayBinRects key={bin.index} bin={bin} />
                  ))}
                </svg>
              </li>
            ))}
          </ul>
          <DayAxis line={line} lookedAt={props.lookedAt} />
        </div>
      )}
    </section>
  );
}

const DAY_ROW_CLASS =
  "grid min-w-0 grid-cols-[58px_28px_minmax(0,1fr)] items-center gap-x-2 sm:grid-cols-[70px_36px_minmax(0,1fr)] sm:gap-x-3";

/** One 5-minute column stacked from the bottom: blockers, master decisions, the rest. */
function DayBinRects(props: { bin: DayBin }) {
  const { bin } = props;
  const total = bin.blockers + bin.master + bin.other;
  const height = dayBinHeight(total);
  const x = bin.index * DAY_BIN_MINUTES + 0.6;
  const width = DAY_BIN_MINUTES - 1.2;
  let y = DAY_BIN_MAX_HEIGHT;
  const parts = [
    { count: bin.blockers, className: "fill-(--m-negative)" },
    { count: bin.master, className: "fill-(--m-accent)" },
    { count: bin.other, className: "fill-(--m-tick)" },
  ];
  return parts.map((part) => {
    if (part.count === 0) return null;
    const partHeight = (height * part.count) / total;
    y -= partHeight;
    return (
      <rect
        key={part.className}
        x={x}
        y={y}
        width={width}
        height={partHeight}
        className={part.className}
      />
    );
  });
}

/** Hour marks under the strips, and the time he last looked in accent. */
function DayAxis(props: { line: DayLine; lookedAt: string | null }) {
  const { line } = props;
  const looked =
    line.lookedMinute !== null && line.lookedMinute > 0 && props.lookedAt
      ? line.lookedMinute / line.minutes
      : null;
  // Marks too close to the looked label or the right edge would overlap it.
  const hours = line.hours.filter(
    (minute) =>
      minute === 0 ||
      (minute / line.minutes <= 0.9 &&
        (looked === null || Math.abs(minute / line.minutes - looked) > 0.12)),
  );
  return (
    <div aria-hidden className={cn(DAY_ROW_CLASS, "mt-1.5")}>
      <span className="relative col-start-3 h-4.5 text-xs whitespace-nowrap text-(--m-muted) tabular-nums">
        {hours.map((minute) => (
          <span
            key={minute}
            className={cn("absolute top-0", minute > 0 && "-translate-x-1/2")}
            style={{ left: `${(minute / line.minutes) * 100}%` }}
          >
            {dayHourLabel(minute)}
          </span>
        ))}
        {looked !== null && props.lookedAt ? (
          <span
            className={cn(
              "absolute top-0 font-medium text-(--m-accent-text)",
              looked > 0.85 && "-translate-x-full",
            )}
            style={{ left: `${looked * 100}%` }}
          >
            {formatTimeOfDay(props.lookedAt)}
          </span>
        ) : null}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Figures: four link panels

function FigurePanel(props: {
  missionId: MissionId;
  figure: BoardFigure;
  loading: boolean;
  wide: boolean;
  /** When the data last updated, while the connection is down. */
  stale: number | null;
}) {
  const { figure, stale } = props;
  const className = cn(
    "flex min-w-0 flex-col rounded-3xl bg-(--m-surface) px-4 pt-3.5 pb-4 text-(--m-text) transition-colors hover:bg-(--m-raised) sm:px-5.5 sm:pt-4.5 sm:pb-5",
    props.wide ? "lg:col-span-4" : "lg:col-span-3",
    LINK_FOCUS,
  );
  const body = (
    <>
      <span className="text-sm text-(--m-muted)">{figure.label}</span>
      {props.loading ? (
        <>
          <span aria-hidden className="mt-3.5 h-6.5 w-3/5 rounded-lg bg-(--m-active)" />
          <span aria-hidden className="mt-2 h-2.5 w-4/5 rounded-md bg-(--m-active)" />
        </>
      ) : (
        <>
          <span
            className={cn(
              "mt-2 text-2xl leading-tight font-normal tracking-tight tabular-nums sm:mt-3 sm:text-3xl",
              stale !== null && "text-(--m-muted)",
            )}
          >
            {figure.value}
            {figure.unit ? (
              <small className="ms-1 text-sm font-normal tracking-normal text-(--m-muted)">
                {figure.unit}
              </small>
            ) : null}
          </span>
          {stale !== null ? (
            <span className="mt-1 text-xs text-(--m-muted)">
              as of {formatTimeOfDay(new Date(stale).toISOString())}
            </span>
          ) : figure.note ? (
            <span
              className={cn(
                "mt-1 text-xs",
                figure.note.alert ? "font-medium text-(--m-negative)" : "text-(--m-muted)",
              )}
            >
              {figure.note.text}
            </span>
          ) : null}
        </>
      )}
    </>
  );
  const params = { missionId: props.missionId };
  switch (figure.key) {
    case "requests":
      return (
        <Link
          to="/missions/$missionId"
          params={params}
          hash="mission-section-your-requests"
          className={className}
        >
          {body}
        </Link>
      );
    case "since":
      return (
        <Link
          to="/missions/$missionId"
          params={params}
          hash="mission-section-since-last-looked"
          className={className}
        >
          {body}
        </Link>
      );
    case "lanes":
      return (
        <Link
          to="/missions/$missionId"
          params={params}
          search={{ tab: "lanes" }}
          className={className}
        >
          {body}
        </Link>
      );
    case "reviews":
      return (
        <Link
          to="/missions/$missionId"
          params={params}
          search={{ tab: "roles" }}
          className={className}
        >
          {body}
        </Link>
      );
  }
}

// ---------------------------------------------------------------------------
// Lanes: the split of live lanes, then the stuck ones

const BAR_CLASS = ["bg-(--m-bar-1)", "bg-(--m-bar-2)", "bg-(--m-bar-3)", "bg-(--m-bar-4)"];

/** Stuck lanes shown before the fold. */
const FIRST_STUCK = 3;

export function LanesPanel(props: { missionId: MissionId; counts: LaneCounts; nowMs: number }) {
  const lanes = useMissionLanes(props.missionId);
  const [open, setOpen] = useState(false);
  const stuck = useMemo(() => (lanes ? stuckLanes(lanes) : []), [lanes]);
  const total = laneTotal(props.counts);
  if (total === 0) return null;
  const shown = open ? stuck : stuck.slice(0, FIRST_STUCK);
  return (
    <section aria-labelledby="mission-section-lanes" className={PANEL_CLASS}>
      <div className="flex min-h-8 min-w-0 items-center gap-2.5">
        <h2 id="mission-section-lanes" className="text-sm font-semibold">
          Lanes
        </h2>
        <span className="text-xs text-(--m-muted) tabular-nums">{total} live</span>
        <Button
          size="sm"
          variant="ghost-muted"
          className="ms-auto"
          render={
            <Link
              to="/missions/$missionId"
              params={{ missionId: props.missionId }}
              search={{ tab: "lanes" }}
            />
          }
        >
          All
        </Button>
      </div>
      <ul className="flex min-w-0 flex-col">
        {laneBars(props.counts).map((bar, index) => (
          <li key={bar.key} className="grid grid-cols-[minmax(0,1fr)_auto] gap-y-1.5 py-2">
            <span className="text-sm">{bar.label}</span>
            <span className="text-sm text-(--m-muted) tabular-nums">{bar.count}</span>
            <span
              aria-hidden
              className="col-span-full h-2 overflow-hidden rounded-full bg-(--m-raised)"
            >
              <span
                className={cn("block h-full rounded-full", BAR_CLASS[index])}
                style={{ width: `${bar.share * 100}%` }}
              />
            </span>
          </li>
        ))}
      </ul>
      {props.counts.stuck > 0 ? (
        <div className="mt-3 flex min-w-0 flex-col border-t border-(--m-rule) pt-3.5">
          <p className="mb-1 text-sm font-semibold text-(--m-negative) tabular-nums">
            {props.counts.stuck} stuck
          </p>
          {lanes === undefined ? (
            <LoadingRows />
          ) : (
            <ul className="flex min-w-0 flex-col">
              {shown.map((lane) => (
                <li
                  key={lane.id}
                  className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-2.5 py-2"
                >
                  <span className="truncate text-sm font-medium">{lane.name}</span>
                  <time dateTime={lane.updatedAt} className="text-xs text-(--m-muted) tabular-nums">
                    {formatRelative(lane.updatedAt, props.nowMs)}
                  </time>
                  {lane.statusReason ? (
                    <p className="col-span-full line-clamp-2 text-sm text-pretty text-(--m-muted)">
                      {lane.statusReason}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          <FoldButton hidden={stuck.length - shown.length} onShow={() => setOpen(true)} />
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Restart notice: one panel under the header until opened or dismissed

const CAUSE_WORDS: Record<RecoveryCause, string> = {
  "server-restart": "a restart",
  "opencode-restart": "an OpenCode restart",
  "run-interrupted": "interrupted runs",
  succession: "a role handoff",
};

const DISMISSED_KEY = "t3code:missions-restart-dismissed";
const DismissedIncident = Schema.NullOr(Schema.String);

export function RestartNotice(props: {
  missionId: MissionId;
  recovery: MissionRecoveryState | null | undefined;
}) {
  const { recovery } = props;
  const [dismissed, setDismissed] = useLocalStorage(DISMISSED_KEY, null, DismissedIncident);
  if (!recovery || recovery.pending === 0 || dismissed === recovery.incidentId) return null;
  const threads = recovery.pending === 1 ? "thread" : "threads";
  return (
    <section
      aria-labelledby="mission-restart"
      className={cn(
        PANEL_CLASS,
        "grid gap-x-6 gap-y-1.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center",
      )}
    >
      <h2 id="mission-restart" className="text-sm font-semibold">
        Recovered from {CAUSE_WORDS[recovery.cause]} on {formatDayLabel(recovery.at)}
      </h2>
      <div className="flex gap-1.5 sm:col-start-2 sm:row-span-2 sm:row-start-1">
        <Button
          size="sm"
          variant="secondary"
          render={
            <Link
              to="/missions/$missionId"
              params={{ missionId: props.missionId }}
              search={{ tab: "roles" }}
            />
          }
        >
          Open
        </Button>
        <Button size="sm" variant="ghost-muted" onClick={() => setDismissed(recovery.incidentId)}>
          Dismiss
        </Button>
      </div>
      <p className="text-sm text-pretty text-(--m-muted) max-sm:row-start-2">
        {recovery.pending} of {recovery.total} {threads} still to resume or decide
        {recovery.reconcile > 0 ? `, ${recovery.reconcile} to reconcile first` : ""}.
      </p>
    </section>
  );
}
