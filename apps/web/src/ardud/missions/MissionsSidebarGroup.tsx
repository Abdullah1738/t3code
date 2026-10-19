import { memo, useCallback, useMemo } from "react";
import { Link, useLocation, useParams, useSearch } from "@tanstack/react-router";
import { InboxIcon, PanelsTopLeftIcon } from "lucide-react";
import * as Schema from "effect/Schema";

import type { MissionId, MissionListItem } from "@t3tools/contracts";
import { badgeCount, laneTotal, totalNeedsYou } from "@t3tools/client-runtime/ardud/missions";

import { CollapsibleSectionHeader } from "../../components/ui/collapsible-section-header";
import { SidebarGroup, useSidebar } from "../../components/ui/sidebar";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { cn } from "../../lib/utils";
import { CountBadge, GlyphCount, HealthGlyph, needsYouLabel, UnreadDot } from "./cards/chips";
import { useMissionList, useYourRequests } from "./missionsStore";
import { unreadRequests } from "./sections/YourRequests";
import "./missions.css";

const SIDEBAR_STATE_KEY = "t3code:ardud-missions:sidebar";
const SidebarState = Schema.Struct({ collapsed: Schema.Boolean });
type SidebarState = typeof SidebarState.Type;
const INITIAL_STATE: SidebarState = { collapsed: false };

const rowClassName =
  "flex h-8 min-w-0 items-center gap-2 rounded-md px-2.5 text-sm text-sidebar-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring pointer-coarse:h-11";
const subRowClassName =
  "flex h-7.5 min-w-0 items-center gap-2 rounded-md px-2 text-sm text-sidebar-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring pointer-coarse:h-11";

function rowState(isActive: boolean) {
  return isActive ? "bg-sidebar-row-active" : "hover:bg-sidebar-row-hover";
}

/**
 * The Missions group above the thread list: the inbox, all missions, and one
 * row per mission. The open mission lists its sub-missions and lanes.
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
        <ul className="flex flex-col gap-px pb-3.5">
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
  return (
    <li>
      <div className={cn(rowClassName, "pe-1", rowState(isActive))}>
        <Link
          to="/missions/$missionId"
          params={{ missionId: mission.id }}
          onClick={onNavigate}
          aria-current={isActive ? "page" : undefined}
          className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <HealthGlyph health={mission.health} paused={paused} />
          <span className={cn("min-w-0 truncate", paused && "text-sidebar-muted-foreground")}>
            {mission.title}
          </span>
        </Link>
        <RequestsAnsweredLink missionId={mission.id} onNavigate={onNavigate} />
        <NeedsYouLink missionId={mission.id} count={mission.needsYou} onNavigate={onNavigate} />
      </div>
      {isActive ? <MissionSubRows mission={mission} onNavigate={onNavigate} /> : null}
    </li>
  );
});

/** Sub-missions on one rank/glyph/title grid, then the lanes row. */
function MissionSubRows(props: { mission: MissionListItem; onNavigate: () => void }) {
  const { mission, onNavigate } = props;
  const activeSub = useSearch({
    strict: false,
    select: (search) => (typeof search.sub === "string" ? search.sub : null),
  });
  const lanes = laneTotal(mission.lanes);
  if (mission.subMissions.length === 0 && lanes === 0) return null;
  return (
    <ul
      aria-label={`${mission.title} sub-missions`}
      className="mb-1 ms-3.5 flex flex-col border-s border-sidebar-border py-0.5 ps-2.5"
    >
      {mission.subMissions.map((sub) => {
        const subPaused = sub.status === "paused";
        const isActive = sub.id === activeSub;
        return (
          <li key={sub.id}>
            <Link
              to="/missions/$missionId"
              params={{ missionId: mission.id }}
              search={{ sub: sub.id }}
              onClick={onNavigate}
              aria-current={isActive ? "true" : undefined}
              className={cn(subRowClassName, rowState(isActive))}
            >
              <span className="w-3 shrink-0 text-end text-xs text-sidebar-muted-foreground tabular-nums">
                {sub.order + 1}
              </span>
              <HealthGlyph health={sub.health} paused={subPaused} />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate",
                  subPaused && "text-sidebar-muted-foreground",
                )}
              >
                {sub.title}
              </span>
              {sub.needsYou > 0 ? (
                <CountBadge count={sub.needsYou} label={needsYouLabel(sub.needsYou)} />
              ) : null}
            </Link>
          </li>
        );
      })}
      {lanes > 0 ? (
        <LanesRow
          missionId={mission.id}
          total={lanes}
          stuck={mission.lanes.stuck}
          waiting={mission.lanes.waiting}
          onNavigate={onNavigate}
        />
      ) : null}
    </ul>
  );
}

/** "37 lanes" with stuck and waiting counts; opens the mission's lanes. */
function LanesRow(props: {
  missionId: MissionId;
  total: number;
  stuck: number;
  waiting: number;
  onNavigate: () => void;
}) {
  const isActive = useSearch({
    strict: false,
    select: (search) => search.tab === "lanes",
  });
  const noun = props.total === 1 ? "lane" : "lanes";
  const problems = [
    props.stuck > 0 ? `${props.stuck} stuck` : null,
    props.waiting > 0 ? `${props.waiting} waiting` : null,
  ].filter((part) => part !== null);
  const label = `${props.total} ${noun}${problems.length > 0 ? `: ${problems.join(", ")}` : ""}`;
  return (
    <li>
      <Link
        to="/missions/$missionId"
        params={{ missionId: props.missionId }}
        search={{ tab: "lanes" }}
        onClick={props.onNavigate}
        aria-label={label}
        aria-current={isActive ? "true" : undefined}
        className={cn(subRowClassName, rowState(isActive))}
      >
        <span aria-hidden className="w-3 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-sidebar-muted-foreground">
          <span className="tabular-nums">{props.total}</span> {noun}
        </span>
        <span aria-hidden className="flex shrink-0 items-center gap-2.5 text-xs font-medium">
          {props.stuck > 0 ? (
            <GlyphCount kind="bad" count={props.stuck} label={`${props.stuck} stuck`} />
          ) : null}
          {props.waiting > 0 ? (
            <GlyphCount
              kind="wait"
              tone="risk"
              count={props.waiting}
              label={`${props.waiting} waiting`}
            />
          ) : null}
        </span>
      </Link>
    </li>
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
        <InboxIcon aria-hidden className="size-4 shrink-0 text-sidebar-muted-foreground" />
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
        <PanelsTopLeftIcon aria-hidden className="size-4 shrink-0 text-sidebar-muted-foreground" />
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
      className="flex h-4.5 shrink-0 items-center gap-1 rounded-sm px-1 text-xs font-medium text-update-foreground tabular-nums outline-none hover:bg-update/12 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
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
