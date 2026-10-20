import { memo, useCallback, useMemo } from "react";
import { Link, useLocation, useParams, useSearch } from "@tanstack/react-router";
import * as Schema from "effect/Schema";

import type { MissionId, MissionListItem } from "@t3tools/contracts";
import { badgeCount, laneTotal, totalNeedsYou } from "@t3tools/client-runtime/ardud/missions";

import { CollapsibleSectionHeader } from "../../components/ui/collapsible-section-header";
import { SidebarGroup, useSidebar } from "../../components/ui/sidebar";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { cn } from "../../lib/utils";
import { CountBadge, HealthGlyph, needsYouLabel, UnreadDot } from "./cards/chips";
import { useMissionList, useYourRequests } from "./missionsStore";
import { unreadRequests } from "./sections/YourRequests";
import "./missions.css";

const SIDEBAR_STATE_KEY = "t3code:ardud-missions:sidebar";
const SidebarState = Schema.Struct({ collapsed: Schema.Boolean });
type SidebarState = typeof SidebarState.Type;
const INITIAL_STATE: SidebarState = { collapsed: false };

const rowClassName =
  "flex h-8 min-w-0 items-center gap-2 rounded-lg px-2.5 text-sm text-sidebar-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring pointer-coarse:h-11";

function rowState(isActive: boolean) {
  return isActive ? "bg-sidebar-row-active font-medium" : "hover:bg-sidebar-row-hover";
}

/**
 * The Missions group above the thread list: the inbox, all missions, and one
 * row per mission. The open mission shows its lanes row.
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
        <ul className="flex flex-col gap-0.5 pb-3.5">
          <InboxRow count={totalNeedsYou(missions)} onNavigate={closeMobileSidebar} />
          <PortfolioRow onNavigate={closeMobileSidebar} />
          {missions.map((mission) => (
            <MissionSidebarRow
              key={mission.id}
              mission={mission}
              isActive={mission.id === activeMissionId}
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
  onNavigate: () => void;
}) {
  const { mission, isActive, onNavigate } = props;
  const paused = mission.status === "paused";
  // On the lanes tab the lanes row is the current one, not the mission's.
  const lanesOpen = useSearch({ strict: false, select: (search) => search.tab === "lanes" });
  return (
    <li className="flex flex-col gap-0.5">
      <div className={cn(rowClassName, "pe-1", rowState(isActive && !lanesOpen))}>
        <Link
          to="/missions/$missionId"
          params={{ missionId: mission.id }}
          onClick={onNavigate}
          aria-current={isActive && !lanesOpen ? "page" : undefined}
          className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <HealthGlyph health={mission.health} paused={paused} />
          <span className={cn("min-w-0 truncate", paused && "text-sidebar-muted-foreground")}>
            {mission.title}
          </span>
        </Link>
        <RequestsAnsweredLink missionId={mission.id} onNavigate={onNavigate} />
        <NeedsYouLink missionId={mission.id} count={mission.needsYou} onNavigate={onNavigate} />
      </div>
      {isActive && laneTotal(mission.lanes) > 0 ? (
        <LanesRow
          missionId={mission.id}
          working={mission.lanes.working}
          waiting={mission.lanes.waiting}
          isActive={lanesOpen}
          onNavigate={onNavigate}
        />
      ) : null}
    </li>
  );
});

/** Under the open mission: its lanes, with how many work and how many wait. */
function LanesRow(props: {
  missionId: MissionId;
  working: number;
  waiting: number;
  isActive: boolean;
  onNavigate: () => void;
}) {
  return (
    <Link
      to="/missions/$missionId"
      params={{ missionId: props.missionId }}
      search={{ tab: "lanes" }}
      onClick={props.onNavigate}
      aria-current={props.isActive ? "page" : undefined}
      className={cn(rowClassName, "ps-6.5", rowState(props.isActive))}
    >
      <span className="min-w-0 flex-1 truncate">Lanes</span>
      <span className="flex shrink-0 items-center gap-2.5 text-xs font-normal whitespace-nowrap text-sidebar-muted-foreground tabular-nums">
        {props.working > 0 ? <span>{props.working} working</span> : null}
        {props.waiting > 0 ? <span>{props.waiting} waiting</span> : null}
      </span>
    </Link>
  );
}

/** Top row of the group: the all-missions inbox and everything waiting on the owner. */
function InboxRow(props: { count: number; onNavigate: () => void }) {
  const isActive = useLocation({ select: (location) => location.pathname === "/missions/inbox" });
  return (
    <li>
      <Link
        to="/missions/inbox"
        onClick={props.onNavigate}
        aria-current={isActive ? "page" : undefined}
        className={cn(rowClassName, "pe-1", rowState(isActive))}
      >
        <span className="min-w-0 flex-1 truncate">Inbox</span>
        {props.count > 0 ? (
          <CountBadge count={props.count} label={needsYouLabel(props.count)} />
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
        className={cn(rowClassName, rowState(isActive))}
      >
        <span className="min-w-0 flex-1 truncate">All missions</span>
      </Link>
    </li>
  );
}

/** Answered requests the owner has not opened: an update dot and the count. */
function RequestsAnsweredLink(props: { missionId: MissionId; onNavigate: () => void }) {
  const requests = useYourRequests(props.missionId);
  const unread = useMemo(() => unreadRequests(requests), [requests]);
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
      className="flex h-4.5 shrink-0 items-center gap-1 rounded-sm px-1 text-xs font-medium text-(--m-accent-text) tabular-nums outline-none hover:bg-(--m-active) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <UnreadDot />
      {badgeCount(unread.length)}
    </Link>
  );
}

function NeedsYouLink(props: { missionId: MissionId; count: number; onNavigate: () => void }) {
  if (props.count === 0) return null;
  return (
    <Link
      to="/missions/inbox"
      search={{ mission: props.missionId }}
      onClick={props.onNavigate}
      className="shrink-0 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <CountBadge count={props.count} label={needsYouLabel(props.count)} />
    </Link>
  );
}
