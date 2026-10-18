import { memo, useCallback, useMemo, useState } from "react";
import { Link, useLocation, useParams } from "@tanstack/react-router";
import { ChevronRightIcon, InboxIcon, LayersIcon } from "lucide-react";
import * as Schema from "effect/Schema";

import type { Lane, MissionId, MissionListItem } from "@t3tools/contracts";
import {
  badgeCount,
  foldLaneCounts,
  healthLabel,
  isRequestUnread,
  sortLanesProblemsFirst,
  splitQuietLanes,
  totalNeedsYou,
  type LaneFold,
} from "@t3tools/client-runtime/ardud/missions";

import { CollapsibleSectionHeader } from "../../components/ui/collapsible-section-header";
import { SidebarGroup, useSidebar } from "../../components/ui/sidebar";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { cn } from "../../lib/utils";
import { useMissionLanes, useMissionList, useOwnerRequests } from "./missionsStore";
import { HEALTH_DOT_CLASS, LANE_DOT_CLASS, LANE_TEXT_CLASS } from "./missionTone";

const SIDEBAR_STATE_KEY = "t3code:ardud-missions:sidebar";
const SidebarState = Schema.Struct({
  collapsed: Schema.Boolean,
  /** Missions whose sub-missions are showing. */
  open: Schema.Array(Schema.String),
});
type SidebarState = typeof SidebarState.Type;
const INITIAL_STATE: SidebarState = { collapsed: false, open: [] };

const rowClassName =
  "flex h-8 min-w-0 items-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring pointer-coarse:h-10";

/**
 * The Missions group above the thread list. One list subscription feeds every
 * row; lane lists subscribe only while someone has them open.
 */
export function MissionsSidebarGroup() {
  const list = useMissionList();
  const [state, setState] = useLocalStorage(SIDEBAR_STATE_KEY, INITIAL_STATE, SidebarState);
  const activeMissionId = useParams({
    strict: false,
    select: (params) => (typeof params.missionId === "string" ? params.missionId : null),
  });
  const { isMobile, setOpenMobile } = useSidebar();
  const closeMobileSidebar = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  const toggleMission = useCallback(
    (missionId: string) =>
      setState((current) => ({
        ...current,
        open: current.open.includes(missionId)
          ? current.open.filter((id) => id !== missionId)
          : [...current.open, missionId],
      })),
    [setState],
  );

  const missions = list?.missions ?? [];
  if (missions.length === 0) return null;

  const expanded = !state.collapsed;
  return (
    <SidebarGroup aria-label="Missions">
      <div className="mx-0.5 h-8">
        <CollapsibleSectionHeader
          expanded={expanded}
          onClick={() => setState((current) => ({ ...current, collapsed: !current.collapsed }))}
        >
          Missions
        </CollapsibleSectionHeader>
      </div>
      {expanded ? (
        <ul className="flex flex-col gap-0.5">
          <InboxRow count={totalNeedsYou(missions)} onNavigate={closeMobileSidebar} />
          <PortfolioRow onNavigate={closeMobileSidebar} />
          {missions.map((mission) => (
            <MissionSidebarRow
              key={mission.id}
              mission={mission}
              isActive={mission.id === activeMissionId}
              isOpen={state.open.includes(mission.id)}
              onToggle={toggleMission}
              onNavigate={closeMobileSidebar}
            />
          ))}
        </ul>
      ) : null}
    </SidebarGroup>
  );
}

const MissionSidebarRow = memo(function MissionSidebarRow(props: {
  mission: MissionListItem;
  isActive: boolean;
  isOpen: boolean;
  onToggle: (missionId: string) => void;
  onNavigate: () => void;
}) {
  const { mission, isActive, isOpen, onToggle, onNavigate } = props;
  const paused = mission.status === "paused";
  const fold = useMemo(() => foldLaneCounts(mission.lanes), [mission.lanes]);
  const subListId = `mission-${mission.id}-subs`;

  return (
    <li>
      <div
        className={cn(
          rowClassName,
          "group/mission text-sidebar-foreground",
          isActive ? "bg-sidebar-row-active" : "hover:bg-sidebar-row-hover",
        )}
      >
        <button
          type="button"
          aria-expanded={isOpen}
          aria-controls={subListId}
          aria-label={`${isOpen ? "Hide" : "Show"} sub-missions of ${mission.title}`}
          onClick={() => onToggle(mission.id)}
          className="flex h-full w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground/70 outline-none hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-3.5 transition-transform motion-reduce:transition-none",
              isOpen && "rotate-90",
            )}
          />
        </button>
        <Link
          to="/missions/$missionId"
          params={{ missionId: mission.id }}
          onClick={onNavigate}
          aria-current={isActive ? "page" : undefined}
          className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md pe-1.5 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <HealthDot health={mission.health} paused={paused} />
          <span className={cn("min-w-0 truncate", paused && "text-sidebar-muted-foreground")}>
            {mission.title}
          </span>
          {paused ? (
            <span className="shrink-0 text-2xs font-normal text-sidebar-muted-foreground/70">
              paused
            </span>
          ) : null}
        </Link>
        <RequestsAnsweredLink missionId={mission.id} onNavigate={onNavigate} />
        <NeedsYouLink missionId={mission.id} count={mission.needsYou} onNavigate={onNavigate} />
      </div>
      {isOpen ? (
        <div id={subListId} className="ms-3.5 border-s border-sidebar-border ps-1.5">
          <ol aria-label={`${mission.title} sub-missions`} className="flex flex-col">
            {mission.subMissions.map((sub) => (
              <li key={sub.id}>
                <Link
                  to="/missions/$missionId"
                  params={{ missionId: mission.id }}
                  search={{ sub: sub.id }}
                  onClick={onNavigate}
                  className={cn(
                    rowClassName,
                    "h-7 gap-2 px-1.5 text-xs text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground pointer-coarse:h-9",
                  )}
                >
                  <span className="w-3 shrink-0 text-end text-2xs text-sidebar-muted-foreground/60 tabular-nums">
                    {sub.order + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{sub.title}</span>
                  {sub.status === "paused" ? (
                    <span className="shrink-0 text-2xs text-sidebar-muted-foreground/70">
                      paused
                    </span>
                  ) : null}
                  {sub.needsYou > 0 ? (
                    <span className="shrink-0 text-2xs font-medium text-warning-foreground tabular-nums">
                      {badgeCount(sub.needsYou)}
                    </span>
                  ) : null}
                  <HealthDot health={sub.health} paused={sub.status === "paused"} />
                </Link>
              </li>
            ))}
          </ol>
          {fold.total > 0 ? <LaneFoldRow missionId={mission.id} fold={fold} /> : null}
        </div>
      ) : null}
    </li>
  );
});

/** Top row of the group: the all-missions inbox and everything waiting on the owner. */
function InboxRow(props: { count: number; onNavigate: () => void }) {
  const isActive = useLocation({ select: (location) => location.pathname === "/missions/inbox" });
  return (
    <li>
      <Link
        to="/missions/inbox"
        onClick={props.onNavigate}
        aria-current={isActive ? "page" : undefined}
        className={cn(
          rowClassName,
          "gap-2 ps-2 pe-1 text-sm font-medium text-sidebar-foreground",
          isActive ? "bg-sidebar-row-active" : "hover:bg-sidebar-row-hover",
        )}
      >
        <InboxIcon aria-hidden className="size-3.5 shrink-0 text-sidebar-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">Inbox</span>
        {props.count > 0 ? (
          <span className="shrink-0 text-2xs font-medium text-warning-foreground tabular-nums">
            {badgeCount(props.count)}
          </span>
        ) : null}
      </Link>
    </li>
  );
}

function PortfolioRow(props: { onNavigate: () => void }) {
  const isActive = useLocation({
    select: (location) => location.pathname === "/missions/portfolio",
  });
  return (
    <li>
      <Link
        to="/missions/portfolio"
        onClick={props.onNavigate}
        aria-current={isActive ? "page" : undefined}
        className={cn(
          rowClassName,
          "gap-2 ps-2 pe-1 text-sm font-medium text-sidebar-foreground",
          isActive ? "bg-sidebar-row-active" : "hover:bg-sidebar-row-hover",
        )}
      >
        <LayersIcon aria-hidden className="size-3.5 shrink-0 text-sidebar-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">Portfolio</span>
      </Link>
    </li>
  );
}

/** Answered requests the owner has not opened: an update dot and the count. */
function RequestsAnsweredLink(props: { missionId: MissionId; onNavigate: () => void }) {
  const requests = useOwnerRequests(props.missionId);
  const unread = useMemo(() => (requests ?? []).filter(isRequestUnread), [requests]);
  const first = unread[0];
  if (!first) return null;
  const label = `${unread.length} ${unread.length === 1 ? "request" : "requests"} answered`;
  return (
    <Link
      to="/missions/$missionId"
      params={{ missionId: props.missionId }}
      search={{ request: first.id }}
      onClick={props.onNavigate}
      aria-label={label}
      className="flex h-5 shrink-0 items-center gap-1 rounded-full px-1 text-2xs font-medium text-update-foreground tabular-nums outline-none hover:bg-update/12 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <span aria-hidden className="size-1.5 rounded-full bg-update" />
      {badgeCount(unread.length)}
    </Link>
  );
}

function NeedsYouLink(props: { missionId: MissionId; count: number; onNavigate: () => void }) {
  if (props.count === 0) return null;
  const label = `${props.count} ${props.count === 1 ? "item needs" : "items need"} you`;
  return (
    <Link
      to="/missions/inbox"
      search={{ mission: props.missionId }}
      onClick={props.onNavigate}
      aria-label={label}
      className="me-1 flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-warning/12 px-1.5 text-2xs font-medium text-warning-foreground tabular-nums outline-none hover:bg-warning/20 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring dark:bg-warning/16"
    >
      {badgeCount(props.count)}
    </Link>
  );
}

function HealthDot(props: { health: MissionListItem["health"]; paused: boolean }) {
  const label = props.paused ? "Paused" : healthLabel(props.health);
  return (
    <span
      role="img"
      aria-label={label}
      className={cn(
        "size-2 shrink-0 rounded-full",
        props.paused ? "bg-muted-foreground/25" : HEALTH_DOT_CLASS[props.health],
      )}
    />
  );
}

/** "37 lanes: 21 working, 2 stuck, 14 idle", expanding to the lanes on demand. */
function LaneFoldRow(props: { missionId: MissionId; fold: LaneFold }) {
  const [open, setOpen] = useState(false);
  const listId = `mission-${props.missionId}-lanes`;
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={`${props.fold.line}. ${open ? "Hide" : "Show"} lanes`}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          rowClassName,
          "h-7 w-full cursor-pointer gap-1 px-1.5 text-start text-2xs text-sidebar-muted-foreground hover:bg-sidebar-row-hover pointer-coarse:h-9",
        )}
      >
        <span className="w-3 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          <span className="tabular-nums">{props.fold.total}</span>{" "}
          {props.fold.total === 1 ? "lane" : "lanes"}
          {props.fold.parts.map((part, index) => (
            <span key={part.tone} className={LANE_TEXT_CLASS[part.tone]}>
              {index === 0 ? ": " : ", "}
              <span className="tabular-nums">{part.count}</span> {part.label}
            </span>
          ))}
        </span>
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 transition-transform motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
      </button>
      {open ? <LaneList id={listId} missionId={props.missionId} /> : null}
    </div>
  );
}

function LaneList(props: { id: string; missionId: MissionId }) {
  const lanes = useMissionLanes(props.missionId);
  const { active, quiet } = useMemo(() => {
    const split = splitQuietLanes(lanes ?? []);
    return { active: sortLanesProblemsFirst(split.active), quiet: split.quiet };
  }, [lanes]);
  if (lanes === undefined) return null;
  return (
    <div id={props.id} className="flex flex-col pb-1">
      <ul aria-label="Active lanes" className="flex flex-col">
        {active.map((lane) => (
          <LaneRow key={lane.id} lane={lane} />
        ))}
      </ul>
      {quiet.length > 0 ? (
        <p className="px-1.5 py-1 ps-6.5 text-2xs leading-4 text-sidebar-muted-foreground/60">
          {quiet.length} quiet: {quiet.map((lane) => lane.name).join(", ")}
        </p>
      ) : null}
    </div>
  );
}

function LaneRow(props: { lane: Lane }) {
  const { lane } = props;
  return (
    <li className="flex h-6 min-w-0 items-center gap-2 px-1.5 text-2xs text-sidebar-muted-foreground">
      <span className="flex w-3 shrink-0 justify-end">
        <span
          aria-hidden
          className={cn("size-1.5 shrink-0 rounded-full", LANE_DOT_CLASS[lane.status])}
        />
      </span>
      <span className="shrink-0 font-medium text-sidebar-foreground/85">{lane.name}</span>
      <span className="sr-only">{lane.status}</span>
      {lane.status === "stuck" || lane.status === "waiting" ? (
        <span
          className={cn(
            "min-w-0 truncate",
            lane.status === "stuck" ? "text-destructive-foreground" : "text-warning-foreground",
          )}
        >
          {lane.statusReason ?? lane.status}
        </span>
      ) : null}
    </li>
  );
}
