import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { CrosshairIcon, MessageCircleQuestionIcon, PauseIcon, PlayIcon } from "lucide-react";

import type { MissionOverview, SubMissionId } from "@t3tools/contracts";
import {
  foldLaneCounts,
  formatCountdown,
  formatDayLabel,
  healthLabel,
  nextMilestone,
  priorityStack,
  usageView,
} from "@t3tools/client-runtime/ardud/missions";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "../../components/ui/menu";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../../components/ui/popover";
import { requestConfirmDialog } from "../../confirmDialog";
import { cn } from "../../lib/utils";
import { runMissionAction } from "./missionActions";
import { missionsSource } from "./missionsStore";
import { HEALTH_BADGE_VARIANT, LANE_DOT_CLASS } from "./missionTone";

const NO_FOCUS = "none";

/** Goal, milestone countdown, health, usage and the owner's mission controls. */
export function MissionSummary(props: { overview: MissionOverview; nowMs: number }) {
  const { overview, nowMs } = props;
  const { mission } = overview;
  const paused = mission.status === "paused";
  const milestone = useMemo(() => nextMilestone(overview.milestones), [overview.milestones]);
  const usage = usageView(overview.usageShare);
  const fold = useMemo(() => foldLaneCounts(overview.lanes), [overview.lanes]);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p className="text-sm text-pretty text-muted-foreground">{mission.goal}</p>
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        <Badge variant={paused ? "outline" : HEALTH_BADGE_VARIANT[mission.health]} size="default">
          {paused ? "Paused" : healthLabel(mission.health)}
        </Badge>
        {milestone && milestone.targetAt ? (
          <span className="flex items-center gap-1.5 text-foreground">
            <span className="font-medium">{formatDayLabel(milestone.targetAt)}</span>
            <span className="text-muted-foreground tabular-nums">
              {formatCountdown(milestone.targetAt, nowMs)}
            </span>
            {milestone.atRisk > 0 ? (
              <span className="text-warning-foreground">{milestone.atRisk} at risk</span>
            ) : null}
            <span className="text-muted-foreground tabular-nums">
              {milestone.done}/{milestone.total} done
            </span>
          </span>
        ) : null}
        <span
          className={cn(
            usage.tone === "borrowing"
              ? "text-warning-foreground"
              : usage.tone === "unknown"
                ? "text-muted-foreground/70"
                : "text-muted-foreground",
          )}
        >
          {usage.label}
        </span>
        {fold.total > 0 ? (
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <span className="tabular-nums">{fold.total}</span> lanes
            {fold.parts.map((part) => (
              <span key={part.tone} className="flex items-center gap-1">
                <span
                  aria-hidden
                  className={cn("size-1.5 rounded-full", LANE_DOT_CLASS[part.tone])}
                />
                <span className="tabular-nums">{part.count}</span> {part.label}
              </span>
            ))}
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <FocusMenu overview={overview} />
        <PauseButton missionId={mission.id} title={mission.title} paused={paused} />
        <AskTheMission title={mission.title} />
      </div>
    </div>
  );
}

function FocusMenu(props: { overview: MissionOverview }) {
  const { mission } = props.overview;
  const rows = useMemo(
    () => priorityStack(props.overview.subMissions),
    [props.overview.subMissions],
  );
  const focused = rows.find((row) => row.subMission.id === mission.focusSubMissionId);
  const setFocus = (value: unknown) => {
    const subMissionId =
      typeof value === "string" && value !== NO_FOCUS ? (value as SubMissionId) : null;
    if (subMissionId === mission.focusSubMissionId) return;
    void runMissionAction(
      missionsSource.setMissionFocus({ missionId: mission.id, subMissionId }),
      "Could not change focus",
    );
  };
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            variant={focused ? "secondary" : "outline"}
            size="sm"
            aria-label={focused ? `Focus: ${focused.subMission.title}` : "Focus mode"}
          />
        }
      >
        <CrosshairIcon aria-hidden />
        <span className="max-w-48 truncate">
          {focused ? `Focus: ${focused.subMission.title}` : "Focus"}
        </span>
      </MenuTrigger>
      <MenuPopup align="start" side="bottom">
        <MenuGroup>
          <MenuGroupLabel>Only this sub-mission takes new work</MenuGroupLabel>
          <MenuRadioGroup value={mission.focusSubMissionId ?? NO_FOCUS} onValueChange={setFocus}>
            <MenuRadioItem value={NO_FOCUS} closeOnClick>
              No focus
            </MenuRadioItem>
            {rows
              .filter((row) => row.subMission.status === "active")
              .map((row) => (
                <MenuRadioItem key={row.subMission.id} value={row.subMission.id} closeOnClick>
                  {row.position}. {row.subMission.title}
                </MenuRadioItem>
              ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

function PauseButton(props: {
  missionId: MissionOverview["mission"]["id"];
  title: string;
  paused: boolean;
}) {
  const toggle = async () => {
    if (!props.paused) {
      const confirmed = await (requestConfirmDialog(
        `Pause ${props.title}? Lanes stop at their next safe point and nothing new starts until you resume.`,
      ) ?? Promise.resolve(true));
      if (!confirmed) return;
    }
    await runMissionAction(
      missionsSource.setMissionPaused({ missionId: props.missionId, paused: !props.paused }),
      props.paused ? "Could not resume the mission" : "Could not pause the mission",
    );
  };
  return (
    <Button variant="outline" size="sm" onClick={() => void toggle()}>
      {props.paused ? <PlayIcon aria-hidden /> : <PauseIcon aria-hidden />}
      {props.paused ? "Resume" : "Pause"}
    </Button>
  );
}

/** Stub: asking forks the master so the answer costs no master turn. */
function AskTheMission(props: { title: string }) {
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="default" size="sm" />}>
        <MessageCircleQuestionIcon aria-hidden />
        Ask the mission
      </PopoverTrigger>
      <PopoverPopup align="start" side="bottom" className="w-72">
        <PopoverTitle>Ask {props.title}</PopoverTitle>
        <p className="mt-1 text-sm text-muted-foreground">
          A fork of the master will answer from the mission's records, without taking a master turn.
          Not connected yet; it arrives with rooms.
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          Until then, open the master thread or the{" "}
          <Link to="/missions/inbox" className="underline underline-offset-2">
            inbox
          </Link>
          .
        </p>
      </PopoverPopup>
    </Popover>
  );
}
