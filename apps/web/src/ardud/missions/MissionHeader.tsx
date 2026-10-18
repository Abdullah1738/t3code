import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import {
  CrosshairIcon,
  InboxIcon,
  MessageCircleQuestionIcon,
  PauseIcon,
  PlayIcon,
} from "lucide-react";

import type { MissionId, MissionOverview, SubMissionId } from "@t3tools/contracts";
import {
  foldLaneCounts,
  formatCountdown,
  formatDayLabel,
  healthLabel,
  nextMilestone,
  poolUsageView,
  priorityStack,
  splitForks,
  usageView,
  badgeCount,
  type MissionOverviewSnapshot,
} from "@t3tools/client-runtime/ardud/missions";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../../components/ui/menu";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../../components/ui/popover";
import { cn } from "../../lib/utils";
import { setMissionFocus, toggleMissionPaused } from "./missionCommands";
import { AskTheMissionForm, MissionForksList } from "./MissionForksList";
import { useMissionForks, useMissionList, useOwnerRequests } from "./missionsStore";
import { RequestsUnreadLink } from "./sections/YourRequests";
import { HEALTH_BADGE_VARIANT, LANE_DOT_CLASS } from "./missionTone";

/** Goal, milestone countdown, health, usage and the owner's mission controls. */
export function MissionSummary(props: { overview: MissionOverviewSnapshot; nowMs: number }) {
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
      <PoolUsageLine pools={overview.poolUsage} nowMs={nowMs} masterRoleId={mission.masterRoleId} />
      <div className="flex flex-wrap items-center gap-2">
        <FocusMenu overview={overview} />
        <PauseButton missionId={mission.id} title={mission.title} paused={paused} />
        <InboxButton missionId={mission.id} />
        <RequestsUnread missionId={mission.id} />
        <AskTheMission missionId={mission.id} title={mission.title} nowMs={nowMs} />
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
  const focusOn = mission.focusSubMissionId !== null;
  const focused = rows.find((row) => row.subMission.id === mission.focusSubMissionId);
  const focusTitle = focused?.subMission.title ?? "a closed sub-mission";
  // Focus has no end time: it stays on until someone ends it here (or the master does).
  const setFocus = (value: unknown) => {
    if (typeof value !== "string" || value === mission.focusSubMissionId) return;
    void setMissionFocus(mission.id, value as SubMissionId);
  };
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            variant={focusOn ? "secondary" : "outline"}
            size="sm"
            aria-label={focusOn ? `Focus: ${focusTitle}` : "Focus mode"}
          />
        }
      >
        <CrosshairIcon aria-hidden />
        <span className="max-w-48 truncate">{focusOn ? `Focus: ${focusTitle}` : "Focus"}</span>
      </MenuTrigger>
      <MenuPopup align="start" side="bottom">
        <MenuGroup>
          <MenuGroupLabel>Only this sub-mission takes new work</MenuGroupLabel>
          <MenuRadioGroup value={mission.focusSubMissionId ?? ""} onValueChange={setFocus}>
            {rows
              .filter((row) => row.subMission.status === "active")
              .map((row) => (
                <MenuRadioItem key={row.subMission.id} value={row.subMission.id} closeOnClick>
                  {row.position}. {row.subMission.title}
                </MenuRadioItem>
              ))}
          </MenuRadioGroup>
        </MenuGroup>
        {focusOn ? (
          <>
            <MenuSeparator />
            <MenuItem onClick={() => void setMissionFocus(mission.id, null)}>End focus</MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

function PauseButton(props: {
  missionId: MissionOverview["mission"]["id"];
  title: string;
  paused: boolean;
}) {
  return (
    <Button variant="outline" size="sm" onClick={() => void toggleMissionPaused(props)}>
      {props.paused ? <PlayIcon aria-hidden /> : <PauseIcon aria-hidden />}
      {props.paused ? "Resume" : "Pause"}
    </Button>
  );
}

/**
 * "Ask the mission" plus the open discussions (Discuss forks and side
 * questions), so every open fork is one tap from the header.
 */
function AskTheMission(props: { missionId: MissionId; title: string; nowMs: number }) {
  const forks = useMissionForks(props.missionId);
  const openCount = forks ? splitForks(forks).open.length : 0;
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="default" size="sm" />}>
        <MessageCircleQuestionIcon aria-hidden />
        Ask the mission
        {openCount > 0 ? <span className="tabular-nums">· {openCount} open</span> : null}
      </PopoverTrigger>
      <PopoverPopup align="start" side="bottom" className="w-80">
        <PopoverTitle>Ask {props.title}</PopoverTitle>
        <div className="mt-2 flex flex-col gap-3">
          <AskTheMissionForm missionId={props.missionId} />
          <div className="flex flex-col gap-1">
            <h3 className="text-xs font-medium text-muted-foreground">Open discussions</h3>
            <MissionForksList missionId={props.missionId} nowMs={props.nowMs} />
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function RequestsUnread(props: { missionId: MissionId }) {
  return (
    <RequestsUnreadLink missionId={props.missionId} requests={useOwnerRequests(props.missionId)} />
  );
}

/** Header entry to this mission's inbox, with what waits on the owner. */
function InboxButton(props: { missionId: MissionId }) {
  const list = useMissionList();
  const count = list?.missions.find((mission) => mission.id === props.missionId)?.needsYou ?? 0;
  return (
    <Button
      variant="outline"
      size="sm"
      render={<Link to="/missions/inbox" search={{ mission: props.missionId }} />}
    >
      <InboxIcon aria-hidden />
      Inbox
      {count > 0 ? (
        <span className="text-update-foreground tabular-nums">{badgeCount(count)}</span>
      ) : null}
    </Button>
  );
}

/** One compact line per pool the mission draws on. */
function PoolUsageLine(props: {
  pools: MissionOverviewSnapshot["poolUsage"];
  nowMs: number;
  masterRoleId: string | null;
}) {
  if (props.pools.length === 0) return null;
  return (
    <ul aria-label="Pool usage" className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
      {props.pools.map((pool) => {
        const view = poolUsageView(pool, props.nowMs, props.masterRoleId);
        return (
          <li
            key={view.id}
            className={cn(
              view.tone === "out" && "text-destructive-foreground",
              view.tone === "tight" && "text-warning-foreground",
              (view.tone === "ok" || view.tone === "held") && "text-muted-foreground",
            )}
          >
            {view.label} <span className="tabular-nums">{view.value}</span>
            <span className="sr-only">. {view.detail}</span>
          </li>
        );
      })}
    </ul>
  );
}
