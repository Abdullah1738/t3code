import { Link } from "@tanstack/react-router";

import type { MissionId, RoomId } from "@t3tools/contracts";
import { healthLabel } from "@t3tools/client-runtime/ardud/missions";

import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../../components/ui/empty";
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
import { MissionSummary } from "./MissionHeader";
import { MissionOverviewTab } from "./MissionOverviewTab";
import { MISSION_TAB_LABEL, MISSION_TABS, type MissionTab } from "./missionSearch";
import { useMissionOverview } from "./missionsStore";
import { RolesTab } from "./RolesTab";
import { RoomsTab } from "./RoomsTab";
import { RulesTab } from "./RulesTab";
import { TimelineTab } from "./TimelineTab";
import { ViewsTab } from "./ViewsTab";
import { WorkTab } from "./WorkTab";
import { HEALTH_DOT_CLASS } from "./missionTone";
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
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader
          electron={isElectron}
          reserveNativeControls
          className="relative bg-background"
        >
          <WorkspaceBreadcrumb ariaLabel="Mission" className="overflow-hidden">
            <WorkspaceBreadcrumbItem>
              <WorkspaceBreadcrumbText>Missions</WorkspaceBreadcrumbText>
            </WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator />
            <WorkspaceBreadcrumbItem current>
              {overview ? (
                <span
                  role="img"
                  aria-label={healthLabel(overview.mission.health)}
                  className={cn(
                    "me-2 size-2 shrink-0 rounded-full",
                    overview.mission.status === "paused"
                      ? "bg-muted-foreground/25"
                      : HEALTH_DOT_CLASS[overview.mission.health],
                  )}
                />
              ) : null}
              <h1 className="truncate">{title}</h1>
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
                <MissionSummary overview={overview} nowMs={nowMs} />
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

function MissionTabs(props: { missionId: MissionId; tab: MissionTab }) {
  return (
    <nav aria-label="Mission sections" className="-mx-1 overflow-x-auto border-b border-border">
      <ul className="flex min-w-max gap-1 px-1">
        {MISSION_TABS.map((tab) => {
          const active = tab === props.tab;
          return (
            <li key={tab}>
              <Link
                to="/missions/$missionId"
                params={{ missionId: props.missionId }}
                search={tab === "overview" ? {} : { tab }}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "-mb-px flex h-9 items-center border-b-2 px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  active
                    ? "border-foreground font-medium text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {MISSION_TAB_LABEL[tab]}
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
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading mission">
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
        <EmptyTitle>Mission not found</EmptyTitle>
        <EmptyDescription>
          It may have been archived. Pick a mission from the sidebar.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
