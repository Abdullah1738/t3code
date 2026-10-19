import type { MissionId, RoomId } from "@t3tools/contracts";

import { Empty, EmptyHeader, EmptyTitle } from "../../components/ui/empty";
import { ScrollArea } from "../../components/ui/scroll-area";
import { SidebarInset } from "../../components/ui/sidebar";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../../components/WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../../components/WorkspacePageContainer";
import { WorkspacePageHeader } from "../../components/WorkspacePageHeader";
import { isElectron } from "../../env";
import { LanesTab } from "./LanesTab";
import { MissionToolbar } from "./MissionHeader";
import { MissionOverviewTab } from "./MissionOverviewTab";
import type { MissionTab } from "./missionSearch";
import { useMissionOverview } from "./missionsStore";
import { RolesTab } from "./RolesTab";
import { RoomsTab } from "./RoomsTab";
import { RulesTab } from "./RulesTab";
import { TimelineTab } from "./TimelineTab";
import { ViewsTab } from "./ViewsTab";
import { WorkTab } from "./WorkTab";
import { LoadingRows } from "./sections/NeedsYou";
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
                <MissionToolbar overview={overview} tab={props.tab} />
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

function MissionPageSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true">
      <h1 className="sr-only">Loading mission</h1>
      <span aria-hidden className="h-3.5 w-2/5 rounded-md bg-(--m-active)" />
      <LoadingRows />
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
