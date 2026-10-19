import { useMemo } from "react";
import { Link } from "@tanstack/react-router";

import type { MissionId, RoomId } from "@t3tools/contracts";
import { pageTabs, resolveMissionLayout } from "@t3tools/client-runtime/ardud/missions";

import { Empty, EmptyHeader, EmptyTitle } from "../../components/ui/empty";
import { ScrollArea } from "../../components/ui/scroll-area";
import { SidebarInset } from "../../components/ui/sidebar";
import { Skeleton } from "../../components/ui/skeleton";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../../components/WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../../components/WorkspacePageContainer";
import { WorkspacePageHeader } from "../../components/WorkspacePageHeader";
import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { LanesTab } from "./LanesTab";
import { MissionHead } from "./MissionHeader";
import { MissionOverviewTab } from "./MissionOverviewTab";
import { MISSION_TAB_LABEL, MISSION_TABS, type MissionTab } from "./missionSearch";
import { useMissionOverview, useMissionViews } from "./missionsStore";
import { RolesTab } from "./RolesTab";
import { RoomsTab } from "./RoomsTab";
import { RulesTab } from "./RulesTab";
import { TimelineTab } from "./TimelineTab";
import { ViewsTab } from "./ViewsTab";
import { WorkTab } from "./WorkTab";
import { useNowMs } from "./useNowMs";

/** A mission's page: header with the owner's controls, then one tab. */
export function MissionPage(props: {
  missionId: MissionId;
  tab: MissionTab;
  highlightSubMissionId: string | null;
  roomId: RoomId | null;
  /** Owner request opened on the overview. */
  requestId: string | null;
}) {
  const overview = useMissionOverview(props.missionId);
  const nowMs = useNowMs();
  const title = overview?.mission.title ?? (overview === null ? "Mission not found" : "Mission");

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-(--m-ground) text-(--m-text)">
        <WorkspacePageHeader
          electron={isElectron}
          reserveNativeControls
          className="relative bg-(--m-ground)"
        >
          <WorkspaceBreadcrumb ariaLabel="Mission" className="overflow-hidden">
            <WorkspaceBreadcrumbItem>
              <WorkspaceBreadcrumbText>Missions</WorkspaceBreadcrumbText>
            </WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator />
            <WorkspaceBreadcrumbItem current>
              <WorkspaceBreadcrumbText>{title}</WorkspaceBreadcrumbText>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide" className="min-h-full gap-5">
            {overview === undefined ? (
              <MissionPageSkeleton />
            ) : overview === null ? (
              <MissionNotFound />
            ) : (
              <>
                <MissionHead overview={overview} nowMs={nowMs} />
                <MissionTabs missionId={props.missionId} tab={props.tab} />
                {props.tab === "overview" ? (
                  <MissionOverviewTab
                    overview={overview}
                    nowMs={nowMs}
                    highlightSubMissionId={props.highlightSubMissionId}
                    openRequestId={props.requestId}
                  />
                ) : props.tab === "rooms" ? (
                  <RoomsTab missionId={props.missionId} roomId={props.roomId} nowMs={nowMs} />
                ) : props.tab === "lanes" ? (
                  <LanesTab overview={overview} nowMs={nowMs} />
                ) : props.tab === "work" ? (
                  <WorkTab missionId={props.missionId} nowMs={nowMs} />
                ) : props.tab === "rules" ? (
                  <RulesTab
                    missionId={props.missionId}
                    subMissions={overview.subMissions}
                    nowMs={nowMs}
                  />
                ) : props.tab === "roles" ? (
                  <RolesTab missionId={props.missionId} nowMs={nowMs} />
                ) : props.tab === "views" ? (
                  <ViewsTab missionId={props.missionId} nowMs={nowMs} />
                ) : (
                  <TimelineTab missionId={props.missionId} />
                )}
              </>
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

const ALL_TABS = MISSION_TABS.map((tab) => ({ tab, title: MISSION_TAB_LABEL[tab] }));

/** The layout's tabs in its order and names; every tab until the views record loads. */
function MissionTabs(props: { missionId: MissionId; tab: MissionTab }) {
  const views = useMissionViews(props.missionId);
  const tabs = useMemo(
    () =>
      views
        ? pageTabs(resolveMissionLayout(views.snapshot), MISSION_TAB_LABEL, props.tab)
        : ALL_TABS,
    [views, props.tab],
  );
  return (
    <nav aria-label="Mission sections" className="overflow-x-auto border-b border-(--m-rule)">
      <ul className="flex min-w-max gap-0.5">
        {tabs.map(({ tab, title }) => {
          const active = tab === props.tab;
          return (
            <li key={tab}>
              <Link
                to="/missions/$missionId"
                params={{ missionId: props.missionId }}
                search={tab === "overview" ? {} : { tab }}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative flex h-9 items-center px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring pointer-coarse:h-11",
                  active
                    ? "font-medium text-(--m-text) after:absolute after:inset-x-2.5 after:-bottom-px after:h-0.5 after:rounded-full after:bg-(--m-text)"
                    : "text-(--m-muted) hover:text-(--m-text)",
                )}
              >
                {title}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function MissionPageSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true">
      <h1 className="sr-only">Loading mission</h1>
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-6 w-1/2" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

function MissionNotFound() {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle role="heading" aria-level={1}>
          Mission not found
        </EmptyTitle>
      </EmptyHeader>
    </Empty>
  );
}
