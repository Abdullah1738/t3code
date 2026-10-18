import { useMemo, useState } from "react";

import type { Lane, SubMission, SubMissionId } from "@t3tools/contracts";
import {
  formatRelative,
  laneActions,
  laneGroups,
  laneRows,
  mergeTargets,
  type LaneActionId,
  type LaneGroup,
  type LaneRow,
  type MissionOverviewSnapshot,
} from "@t3tools/client-runtime/ardud/missions";

import { Button } from "../../components/ui/button";
import { MutedLines, PairActionForm, PickForm, TextActionForm } from "./MissionForms";
import { MissionSection } from "./MissionSection";
import { useMissionLanes, useMissionRoles, useMissionWork } from "./missionsStore";
import {
  handOffLane,
  mergeLanes,
  moveLane,
  nudgeLane,
  splitLane,
  setLaneParked,
} from "./operationCommands";

// Lanes tab, placeholder presentation. Grouping, gauges, succession history and
// action availability come from client-runtime (lanesViewModel).

export function LanesTab(props: { overview: MissionOverviewSnapshot; nowMs: number }) {
  const missionId = props.overview.mission.id;
  const lanes = useMissionLanes(missionId);
  const roles = useMissionRoles(missionId);
  const work = useMissionWork(missionId);
  const subMissions = props.overview.subMissions;
  const groups = useMemo(() => {
    if (!lanes || !roles || !work) return null;
    const rows = laneRows(lanes, {
      roles: roles.roles,
      bindings: roles.bindings,
      workItems: work.items,
      subMissions,
    });
    return laneGroups(rows);
  }, [lanes, roles, work, subMissions]);
  const [showQuiet, setShowQuiet] = useState(false);

  if (!groups || !lanes) return <p className="text-sm text-muted-foreground">Loading lanes…</p>;
  const context = { lanes, subMissions, nowMs: props.nowMs };
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {groups.shown.map((group) => (
        <LaneGroupSection key={group.status} group={group} context={context} />
      ))}
      {groups.quietLine ? (
        <div className="flex flex-col gap-2">
          <Button
            size="sm"
            variant="ghost"
            className="self-start"
            aria-expanded={showQuiet}
            onClick={() => setShowQuiet((open) => !open)}
          >
            {groups.quietLine}
          </Button>
          {showQuiet
            ? groups.quiet.map((group) => (
                <LaneGroupSection key={group.status} group={group} context={context} />
              ))
            : null}
        </div>
      ) : null}
    </div>
  );
}

interface LaneContext {
  readonly lanes: ReadonlyArray<Lane>;
  readonly subMissions: ReadonlyArray<SubMission>;
  readonly nowMs: number;
}

function LaneGroupSection(props: { group: LaneGroup; context: LaneContext }) {
  return (
    <MissionSection title={`${props.group.label} (${props.group.rows.length})`}>
      <ul className="flex flex-col divide-y divide-border/60">
        {props.group.rows.map((row) => (
          <LaneItem key={row.lane.id} row={row} context={props.context} />
        ))}
      </ul>
    </MissionSection>
  );
}

function LaneItem(props: { row: LaneRow; context: LaneContext }) {
  const { row, context } = props;
  const { lane } = row;
  const [action, setAction] = useState<LaneActionId | null>(null);
  return (
    <li className="flex flex-col gap-1 py-2 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium text-foreground">{lane.name}</span>
        <span className="text-muted-foreground">{lane.purpose}</span>
      </div>
      <MutedLines
        lines={[
          row.subMissionTitle,
          lane.statusReason,
          row.role ? `Lead ${row.role.name}${row.model ? ` on ${row.model}` : ""}` : "No lead role",
          row.pendingModel ? `Switches to ${row.pendingModel} on its next turn` : null,
          row.context
            ? `Context ${row.context.label}${row.context.tone === "ok" ? "" : ` (${row.context.tone})`}${
                row.context.successionLine ? ` · ${row.context.successionLine}` : ""
              }`
            : null,
          row.currentItem ? `Working on ${row.currentItem.title}` : null,
          lane.lastEvidence
            ? `Last evidence ${formatRelative(lane.lastEvidence.at, context.nowMs)}: ${lane.lastEvidence.summary}`
            : null,
          row.successions.length > 0
            ? `Earlier threads: ${row.successions.map((binding) => binding.threadId).join(", ")}`
            : null,
        ]}
      />
      <div className="flex flex-wrap gap-1">
        {laneActions(lane).map((entry) => (
          <Button
            key={entry.id}
            size="xs"
            variant={action === entry.id ? "secondary" : "ghost"}
            disabled={entry.unavailable !== null}
            title={entry.unavailable ?? undefined}
            onClick={() => {
              if (entry.id === "park" || entry.id === "resume") {
                if (entry.id === "resume") void setLaneParked(lane, false);
                else setAction(action === "park" ? null : "park");
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
          context={context}
          onDone={() => setAction(null)}
        />
      ) : null}
    </li>
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
          label="What should the lane look at?"
          submitLabel="Send nudge"
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
          label="Why pause it? (optional)"
          submitLabel="Pause lane"
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
