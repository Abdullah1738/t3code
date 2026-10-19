import { useMemo, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { CrosshairIcon, MessageCircleQuestionIcon, PauseIcon, PlayIcon } from "lucide-react";

import type { MissionId, MissionOverview, SubMissionId } from "@t3tools/contracts";
import {
  badgeCount,
  formatCountdown,
  formatDayLabel,
  formatPercent,
  laneTotal,
  nextMilestone,
  poolUsageView,
  priorityStack,
  type MissionOverviewSnapshot,
} from "@t3tools/client-runtime/ardud/missions";

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
import { cn } from "../../lib/utils";
import { GlyphCount, HealthStatus } from "./cards/chips";
import { setMissionFocus, toggleMissionPaused } from "./missionCommands";
import { useMissionList, useYourRequests } from "./missionsStore";
import {
  RequestComposer,
  RequestsUnreadLink,
  unreadRequests,
  useRequestOpener,
} from "./sections/YourRequests";

/** Title, the owner's controls, goal, focus and the mission's headline numbers. */
export function MissionHead(props: { overview: MissionOverviewSnapshot; nowMs: number }) {
  const { overview, nowMs } = props;
  const { mission } = overview;
  return (
    <section aria-labelledby="mission-title" className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-h-8 min-w-0 items-center gap-3">
        <h1
          id="mission-title"
          className="min-w-0 flex-1 text-base leading-6 font-semibold text-balance"
        >
          {mission.title}
        </h1>
        <div className="flex shrink-0 items-center gap-1">
          <FocusMenu overview={overview} />
          <PauseButton
            missionId={mission.id}
            title={mission.title}
            paused={mission.status === "paused"}
          />
          <AskTheMaster missionId={mission.id} />
        </div>
      </div>
      {mission.goal ? (
        <p className="max-w-[72ch] text-sm text-pretty text-muted-foreground">{mission.goal}</p>
      ) : null}
      <FocusBar overview={overview} />
      <MissionStats overview={overview} nowMs={nowMs} />
    </section>
  );
}

function FocusMenu(props: { overview: MissionOverview }) {
  const { mission } = props.overview;
  const rows = useMemo(
    () =>
      priorityStack(props.overview.subMissions).filter((row) => row.subMission.status === "active"),
    [props.overview.subMissions],
  );
  // Focus has no end time: it stays on until someone ends it (the focus bar or the master).
  const setFocus = (value: unknown) => {
    if (typeof value !== "string" || value === mission.focusSubMissionId) return;
    void setMissionFocus(mission.id, value as SubMissionId);
  };
  if (rows.length === 0) return null;
  return (
    <Menu>
      <MenuTrigger render={<Button variant="ghost-muted" size="sm" />}>
        <CrosshairIcon aria-hidden />
        <span className="max-sm:sr-only">Focus</span>
      </MenuTrigger>
      <MenuPopup align="end" side="bottom">
        <MenuGroup>
          <MenuGroupLabel>Focus on</MenuGroupLabel>
          <MenuRadioGroup value={mission.focusSubMissionId ?? ""} onValueChange={setFocus}>
            {rows.map((row) => (
              <MenuRadioItem key={row.subMission.id} value={row.subMission.id} closeOnClick>
                <span className="w-4 shrink-0 text-xs text-muted-foreground tabular-nums">
                  {row.position}
                </span>
                {row.subMission.title}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

/** Shown while one sub-mission is the only one taking new work. */
function FocusBar(props: { overview: MissionOverview }) {
  const { mission, subMissions } = props.overview;
  if (mission.focusSubMissionId === null) return null;
  const focused = subMissions.find((sub) => sub.id === mission.focusSubMissionId);
  return (
    <div
      role="status"
      className="mt-3.5 flex max-w-140 min-w-0 items-center gap-2.5 rounded-lg bg-update/14 py-1.5 ps-3 pe-1.5 text-sm"
    >
      <CrosshairIcon aria-hidden className="size-4 shrink-0 text-update-foreground" />
      <span className="min-w-0 flex-1 truncate font-medium">
        Focused on {focused?.title ?? "a closed sub-mission"}
      </span>
      <Button variant="outline" size="sm" onClick={() => void setMissionFocus(mission.id, null)}>
        End focus
      </Button>
    </div>
  );
}

function PauseButton(props: { missionId: MissionId; title: string; paused: boolean }) {
  return (
    <Button variant="ghost-muted" size="sm" onClick={() => void toggleMissionPaused(props)}>
      {props.paused ? <PlayIcon aria-hidden /> : <PauseIcon aria-hidden />}
      <span className="max-sm:sr-only">{props.paused ? "Resume" : "Pause"}</span>
    </Button>
  );
}

/** A question to the master from any tab: it opens one of Your requests. */
function AskTheMaster(props: { missionId: MissionId }) {
  const [open, setOpen] = useState(false);
  const openRequest = useRequestOpener(props.missionId);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button variant="outline" size="sm" />}>
        <MessageCircleQuestionIcon aria-hidden />
        <span className="max-sm:sr-only">Ask the master</span>
      </PopoverTrigger>
      <PopoverPopup align="end" side="bottom" className="w-80">
        <PopoverTitle>Ask the master</PopoverTitle>
        <div className="mt-2">
          <RequestComposer
            missionId={props.missionId}
            autoFocus
            onOpened={(id) => {
              setOpen(false);
              openRequest(id);
            }}
          />
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/** The head's numbers: one term and one value each, empty ones left out. */
function MissionStats(props: { overview: MissionOverviewSnapshot; nowMs: number }) {
  const { overview, nowMs } = props;
  const { mission } = overview;
  const milestone = useMemo(() => nextMilestone(overview.milestones), [overview.milestones]);
  const lanes = overview.lanes;
  const lanesTotal = laneTotal(lanes);
  const countdown = milestone?.targetAt ? formatCountdown(milestone.targetAt, nowMs) : "";
  return (
    <dl className="mt-4.5 grid grid-cols-2 gap-x-6 gap-y-4 sm:flex sm:flex-wrap sm:gap-x-12 sm:gap-y-4.5">
      <Stat term={milestone?.targetAt ? formatDayLabel(milestone.targetAt) : "Health"}>
        <HealthStatus health={mission.health} paused={mission.status === "paused"} />
      </Stat>
      {countdown ? (
        <Stat term="Time left">
          <span className={cn(countdown.startsWith("overdue") && "text-error-foreground")}>
            {countdown}
          </span>
        </Stat>
      ) : null}
      {milestone && milestone.total > 0 ? (
        <Stat term="Milestones">
          {milestone.done > 0 || milestone.atRisk > 0 ? (
            <>
              {milestone.done > 0 ? (
                <GlyphCount kind="done" count={milestone.done} label={`${milestone.done} done,`} />
              ) : null}
              {milestone.atRisk > 0 ? (
                <GlyphCount
                  kind="risk"
                  count={milestone.atRisk}
                  label={`${milestone.atRisk} at risk,`}
                />
              ) : null}
              <OfTotal total={milestone.total} />
            </>
          ) : (
            milestone.total
          )}
        </Stat>
      ) : null}
      {lanesTotal > 0 ? (
        <Stat term="Lanes">
          {lanes.stuck > 0 || lanes.waiting > 0 ? (
            <>
              {lanes.stuck > 0 ? (
                <GlyphCount kind="bad" count={lanes.stuck} label={`${lanes.stuck} stuck,`} />
              ) : null}
              {lanes.waiting > 0 ? (
                <GlyphCount
                  kind="wait"
                  tone="risk"
                  count={lanes.waiting}
                  label={`${lanes.waiting} waiting,`}
                />
              ) : null}
              <OfTotal total={lanesTotal} />
            </>
          ) : (
            lanesTotal
          )}
        </Stat>
      ) : null}
      <NeedsYouStat missionId={mission.id} />
      {overview.usageShare !== null && Number.isFinite(overview.usageShare) ? (
        <Stat term="Guaranteed share used">
          <span className={cn(overview.usageShare > 1 && "text-warning-foreground")}>
            {formatPercent(overview.usageShare)}
          </span>
        </Stat>
      ) : null}
      {overview.poolUsage.map((pool) => {
        const view = poolUsageView(pool, nowMs, mission.masterRoleId);
        return (
          <Stat key={view.id} term={view.label}>
            <span
              className={cn(
                view.tone === "out" && "text-error-foreground",
                view.tone === "tight" && "text-warning-foreground",
              )}
            >
              <span aria-hidden>{view.value}</span>
              <span className="sr-only">{view.detail}</span>
            </span>
          </Stat>
        );
      })}
    </dl>
  );
}

/** What waits on the owner here, and answers to their requests not yet read. */
function NeedsYouStat(props: { missionId: MissionId }) {
  const list = useMissionList();
  const requests = useYourRequests(props.missionId);
  const count = list?.missions.find((mission) => mission.id === props.missionId)?.needsYou ?? 0;
  const answered = unreadRequests(requests).length > 0;
  if (count === 0 && !answered) return null;
  return (
    <Stat term="Needs you">
      {count > 0 ? (
        <Link
          to="/missions/inbox"
          search={{ mission: props.missionId }}
          className="rounded-sm text-update-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          {badgeCount(count)}
          <span className="sr-only"> in the inbox</span>
        </Link>
      ) : null}
      <span className="font-normal">
        <RequestsUnreadLink missionId={props.missionId} requests={requests} />
      </span>
    </Stat>
  );
}

/** Value above its term, as in the design's stat row. */
function Stat(props: { term: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col-reverse gap-0.5">
      <dt className="truncate text-xs text-muted-foreground">{props.term}</dt>
      <dd className="flex min-w-0 items-center gap-3 text-base leading-6 font-semibold tabular-nums">
        {props.children}
      </dd>
    </div>
  );
}

function OfTotal(props: { total: number }) {
  return <span className="text-xs font-normal text-muted-foreground">of {props.total}</span>;
}
