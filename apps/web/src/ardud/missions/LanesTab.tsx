import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";

import type { Lane, SubMission, SubMissionId, ThreadId } from "@t3tools/contracts";
import {
  ageView,
  attachedThreadGroups,
  laneActions,
  laneBoard,
  laneRows,
  mergeTargets,
  modelFamily,
  type LaneActionId,
  type LaneGrouping,
  type LanePanel,
  type AttachedThreadRow,
  type LaneRow,
  type MissionOverviewSnapshot,
} from "@t3tools/client-runtime/ardud/missions";

import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { StateGlyph, type StateGlyphKind } from "./cards/chips";
import { DESK_ROW, FeedErrors, FoldRow, Segmented, TabActions, TabLoading } from "./deskParts";
import { PairActionForm, PickForm, TextActionForm } from "./MissionForms";
import { createLane } from "./deskCommands";
import { MissionSection } from "./MissionSection";
import {
  useMissionLanes,
  useMissionRoles,
  useMissionRolesFeed,
  useMissionWork,
  useMissionWorkFeed,
} from "./missionsStore";
import {
  handOffLane,
  mergeLanes,
  moveLane,
  nudgeLane,
  splitLane,
  setLaneParked,
} from "./operationCommands";

// Lanes page (Desk): one line of counts, a Group by switch and one panel per
// group. A row opens in place to its lead, sub-mission, resume note and the
// lane actions. Grouping, ordering and actions come from lanesViewModel.

const GROUPINGS: ReadonlyArray<{ value: LaneGrouping; label: string }> = [
  { value: "state", label: "State" },
  { value: "sub-mission", label: "Sub-mission" },
  { value: "lead", label: "Lead" },
];

const GLYPH: Record<Lane["status"], StateGlyphKind> = {
  stuck: "bad",
  waiting: "wait",
  working: "ok",
  idle: "idle",
  parked: "park",
  retired: "done",
};

export function LanesTab(props: { overview: MissionOverviewSnapshot; nowMs: number }) {
  const missionId = props.overview.mission.id;
  const lanes = useMissionLanes(missionId);
  const roles = useMissionRoles(missionId);
  const work = useMissionWork(missionId);
  const feeds = [useMissionRolesFeed(missionId), useMissionWorkFeed(missionId)];
  const subMissions = props.overview.subMissions;
  const [grouping, setGrouping] = useState<LaneGrouping>("state");
  const [adding, setAdding] = useState(false);
  const board = useMemo(() => {
    if (!lanes || !roles) return null;
    const rows = laneRows(lanes, {
      roles: roles.roles,
      bindings: roles.bindings,
      workItems: work?.items ?? [],
      subMissions,
    });
    const order = [...subMissions].sort((a, b) => a.order - b.order).map((sub) => sub.id);
    return laneBoard(rows, grouping, order);
  }, [lanes, roles, work, subMissions, grouping]);

  if (!board || !lanes)
    return <TabLoading label="Loading lanes…" what="the lanes" feeds={feeds} nowMs={props.nowMs} />;
  const context = { lanes, subMissions, nowMs: props.nowMs };
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <FeedErrors what="the lanes" feeds={feeds} nowMs={props.nowMs} />
      <TabActions>
        <Segmented label="Group by" value={grouping} options={GROUPINGS} onChange={setGrouping} />
        <Button size="sm" variant="outline" onClick={() => setAdding((on) => !on)}>
          New lane
        </Button>
      </TabActions>
      {adding ? (
        <div className="flex flex-col gap-2 rounded-3xl bg-(--m-surface) p-4 sm:p-5">
          <h2 className="text-sm font-semibold">New lane</h2>
          <TextActionForm
            label="Lane name"
            submitLabel="Add lane"
            onSubmit={async (name) => {
              const done = await createLane(missionId, name);
              if (done) setAdding(false);
              return done;
            }}
          />
        </div>
      ) : null}
      {board.panels.map((panel) => (
        <LanePanelSection
          key={`${grouping}:${panel.key}`}
          panel={panel}
          context={context}
          showState={grouping !== "state"}
        />
      ))}
      {/* ardud missions: crw-threads */}
      <ReviewsSection overview={props.overview} />
    </div>
  );
}

const CLOSED_SHOWN = 5;

/** Threads crw runs for the mission's PRs; they live here, not in the thread list. */
function ReviewsSection(props: { overview: MissionOverviewSnapshot }) {
  const groups = attachedThreadGroups(props.overview.attachedThreads);
  const [all, setAll] = useState(false);
  if (groups.open.length === 0 && groups.closed.length === 0) return null;
  const closed = all ? groups.closed : groups.closed.slice(0, CLOSED_SHOWN);
  return (
    <MissionSection title="Reviews" caption={groups.open.length}>
      <ul className="flex flex-col">
        {[...groups.open, ...closed].map((row) => (
          <ReviewThreadItem key={row.threadId} row={row} />
        ))}
      </ul>
      {all ? null : (
        <FoldRow hidden={groups.closed.length - closed.length} onShow={() => setAll(true)} />
      )}
    </MissionSection>
  );
}

function ReviewThreadItem(props: { row: AttachedThreadRow }) {
  const environmentId = usePrimaryEnvironmentId();
  const { row } = props;
  const body = <span className="truncate font-medium">{row.title}</span>;
  const rowClass =
    "flex min-w-0 items-baseline justify-between gap-3.5 rounded-xl px-1 py-2.75 text-sm";
  return (
    <li className={DESK_ROW}>
      {environmentId ? (
        <Link
          to="/$environmentId/$threadId"
          params={{ environmentId, threadId: row.threadId }}
          className={cn(
            rowClass,
            "outline-none hover:bg-(--m-active) focus-visible:ring-2 focus-visible:ring-(--m-accent) focus-visible:ring-inset",
          )}
        >
          {body}
        </Link>
      ) : (
        <span className={rowClass}>{body}</span>
      )}
    </li>
  );
}

interface LaneContext {
  readonly lanes: ReadonlyArray<Lane>;
  readonly subMissions: ReadonlyArray<SubMission>;
  readonly nowMs: number;
}

function LanePanelSection(props: { panel: LanePanel; context: LaneContext; showState: boolean }) {
  const { panel } = props;
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const rows = all ? panel.rows : panel.rows.slice(0, panel.shown);
  const hidden = panel.rows.length - rows.length;
  return (
    <MissionSection title={panel.title} caption={panel.rows.length}>
      {rows.length > 0 ? (
        <ul className="flex flex-col">
          {rows.map((row) => (
            <LaneItem
              key={row.lane.id}
              row={row}
              context={props.context}
              open={open === row.lane.id}
              onToggle={() => setOpen(open === row.lane.id ? null : row.lane.id)}
            />
          ))}
        </ul>
      ) : null}
      {all ? null : (
        <FoldRow
          hidden={hidden}
          onShow={() => setAll(true)}
          {...(panel.restLabel && rows.length < panel.rows.length
            ? { label: panel.restLabel }
            : {})}
        />
      )}
    </MissionSection>
  );
}

function LaneItem(props: {
  row: LaneRow;
  context: LaneContext;
  open: boolean;
  onToggle: () => void;
}) {
  const { row } = props;
  const { lane } = row;
  const at = lane.lastActiveAt ?? lane.lastEvidence?.at ?? null;
  const age = at ? ageView(at, props.context.nowMs) : null;
  const message = lane.lastEvidence?.summary ?? lane.statusReason ?? null;
  return (
    <li className={cn(DESK_ROW, props.open && "rounded-xl border-transparent bg-(--m-active)")}>
      <button
        type="button"
        aria-expanded={props.open}
        onClick={props.onToggle}
        className="grid w-full grid-cols-[16px_minmax(0,1fr)_auto] items-baseline gap-x-3.5 gap-y-0.5 rounded-xl px-1 py-2.75 text-start text-sm outline-none focus-visible:ring-2 focus-visible:ring-(--m-accent) focus-visible:ring-inset sm:grid-cols-[16px_minmax(0,10rem)_minmax(0,1fr)_auto]"
      >
        <span className="self-center">
          <StateGlyph kind={GLYPH[lane.status]} label={lane.status} />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{lane.name}</span>
          {lane.purpose && lane.purpose !== message ? (
            <span className="truncate text-xs text-(--m-muted)">{lane.purpose}</span>
          ) : null}
        </span>
        <span className="col-start-2 col-end-4 row-start-2 min-w-0 truncate text-(--m-muted) sm:col-start-3 sm:col-end-4 sm:row-start-1 sm:text-(--m-text)">
          {message}
        </span>
        <span className="col-start-3 row-start-1 flex items-center justify-end gap-3.5 whitespace-nowrap sm:col-start-4">
          <span className="hidden w-16 text-xs text-(--m-muted) sm:inline">
            {modelFamily(row.role?.modelSelection ?? null)}
          </span>
          <span className="w-16 text-end text-xs text-(--m-muted) tabular-nums">{age?.label}</span>
        </span>
      </button>
      {props.open ? <LaneDetail row={row} context={props.context} /> : null}
    </li>
  );
}

function LaneDetail(props: { row: LaneRow; context: LaneContext }) {
  const { row } = props;
  const { lane } = row;
  const environmentId = usePrimaryEnvironmentId();
  const [action, setAction] = useState<LaneActionId | null>(null);
  const actions = laneActions(lane).filter((entry) => entry.unavailable === null);
  const facts: Array<[string, string]> = [
    ["Lead", row.leadName],
    ...(row.subMissionTitle ? [["Sub-mission", row.subMissionTitle] as [string, string]] : []),
    ...(row.currentItem ? [["On", row.currentItem.title] as [string, string]] : []),
    ...(row.context ? [["Context", row.context.label] as [string, string]] : []),
    ...(row.pendingModel
      ? [["Model", `Moves to ${row.pendingModel} at the next idle turn`] as [string, string]]
      : []),
    ...(row.resumeNote ? [["Resume note", row.resumeNote] as [string, string]] : []),
  ];
  return (
    <div className="flex flex-col gap-3 px-1 pb-3 sm:ps-8">
      <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
        {facts.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-(--m-muted)">{label}</dt>
            <dd className="min-w-0 break-words">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap gap-1.5">
        {lane.threadId && environmentId ? (
          <Button
            size="sm"
            variant="outline"
            render={
              <Link
                to="/$environmentId/$threadId"
                params={{ environmentId, threadId: lane.threadId as ThreadId }}
              />
            }
          >
            Open thread
          </Button>
        ) : null}
        {actions.map((entry) => (
          <Button
            key={entry.id}
            size="sm"
            variant={action === entry.id ? "secondary" : "outline"}
            aria-pressed={action === entry.id}
            onClick={() => {
              if (entry.id === "resume") {
                void setLaneParked(lane, false);
                return;
              }
              setAction(action === entry.id ? null : entry.id);
            }}
          >
            {entry.label}
          </Button>
        ))}
      </div>
      {action ? (
        <LaneActionForm
          action={action}
          lane={lane}
          context={props.context}
          onDone={() => setAction(null)}
        />
      ) : null}
    </div>
  );
}

function LaneActionForm(props: {
  action: LaneActionId;
  lane: Lane;
  context: LaneContext;
  onDone: () => void;
}) {
  const { lane, context } = props;
  const done = (ok: boolean) => {
    if (ok) props.onDone();
    return ok;
  };
  switch (props.action) {
    case "nudge":
      return (
        <TextActionForm
          label="Note for the lead"
          placeholder="Note for the lead (optional)"
          submitLabel="Nudge"
          onSubmit={async (text) => done(await nudgeLane(lane.id, text))}
        />
      );
    case "hand-off":
      return (
        <TextActionForm
          label="Handoff note for the fresh thread"
          submitLabel="Hand off"
          onSubmit={async (text) => done(await handOffLane(lane.id, text))}
        />
      );
    case "park":
      return (
        <TextActionForm
          label="Why pause it"
          placeholder="Why pause it (optional)"
          submitLabel="Pause"
          onSubmit={async (text) => done(await setLaneParked(lane, true, text))}
        />
      );
    case "resume":
      return null;
    case "move":
      return (
        <PickForm
          label="Sub-mission"
          options={context.subMissions
            .filter((sub) => sub.status !== "closed" && sub.id !== lane.subMissionId)
            .map((sub) => ({ value: sub.id, label: sub.title }))}
          submitLabel="Move"
          onSubmit={async (value) => done(await moveLane(lane, value as SubMissionId))}
        />
      );
    case "split":
      return (
        <PairActionForm
          firstLabel="New lane name"
          secondLabel="What the new lane does"
          submitLabel="Split"
          onSubmit={async (name, purpose) =>
            done(await splitLane(lane, name, purpose, context.lanes))
          }
        />
      );
    case "merge": {
      const targets = mergeTargets(lane, [...context.lanes]);
      return (
        <PickForm
          label="Merge into"
          options={targets.map((target) => ({ value: target.id, label: target.name }))}
          submitLabel="Merge"
          onSubmit={async (value) => {
            const into = targets.find((target) => target.id === value);
            return into ? done(await mergeLanes(lane, into)) : false;
          }}
        />
      );
    }
  }
}
