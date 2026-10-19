import { useMemo } from "react";
import { Link } from "@tanstack/react-router";

import {
  formatPercent,
  formatTimeOfDay,
  portfolioView,
} from "@t3tools/client-runtime/ardud/missions";

import { Button } from "../../components/ui/button";
import { ScrollArea } from "../../components/ui/scroll-area";
import { SidebarInset } from "../../components/ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../../components/WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../../components/WorkspacePageContainer";
import { WorkspacePageHeader } from "../../components/WorkspacePageHeader";
import { isElectron } from "../../env";
import { MetaRow } from "./cards/chips";
import { MutedLines } from "./MissionForms";
import { MissionSection } from "./MissionSection";
import { isSampleFeed, usePortfolio } from "./missionsStore";
import { movePortfolioMission } from "./operationCommands";

// Portfolio, placeholder presentation: every mission with its tier, guaranteed
// share, borrowing and pool run-out, in cross-mission priority order. The
// owner and the master reorder it the same way (portfolioViewModel).

export function PortfolioPage() {
  const snapshot = usePortfolio();
  // Each mission has its own master, so changes here show the master's role id.
  const view = useMemo(() => (snapshot ? portfolioView(snapshot) : null), [snapshot]);
  // A portfolio built from the missions can't be reordered until the server serves it.
  const sample = isSampleFeed("portfolio");

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader
          electron={isElectron}
          reserveNativeControls
          className="relative bg-background"
        >
          <WorkspaceBreadcrumb ariaLabel="Portfolio" className="overflow-hidden">
            <WorkspaceBreadcrumbItem current>
              <h1 className="truncate">Portfolio</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="readable" className="min-h-full gap-4">
            {!snapshot || !view ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : (
              <>
                <MutedLines
                  lines={[
                    `Guaranteed shares add up to ${formatPercent(view.guaranteedTotal)}${
                      view.overcommitted ? ", more than there is" : ""
                    }`,
                    view.orderLine,
                  ]}
                />
                <MissionSection title="Missions, highest priority first" sample={sample}>
                  <ol className="flex flex-col divide-y divide-border/60">
                    {view.rows.map((row, index) => {
                      const above = view.rows[index - 1]?.mission.missionId;
                      const below = view.rows[index + 1]?.mission.missionId;
                      return (
                        <li
                          key={row.mission.missionId}
                          className="flex flex-col gap-1 py-2 text-sm"
                        >
                          <div className="flex flex-wrap items-baseline gap-x-2">
                            <span className="tabular-nums text-muted-foreground">
                              {row.position}.
                            </span>
                            <Link
                              to="/missions/$missionId"
                              params={{ missionId: row.mission.missionId }}
                              className="font-medium text-foreground underline-offset-2 hover:underline"
                            >
                              {row.mission.title}
                            </Link>
                            <span className="text-muted-foreground">
                              <MetaRow>
                                <span>{row.tierLabel}</span>
                                <span>{row.mission.status}</span>
                              </MetaRow>
                            </span>
                          </div>
                          <MutedLines
                            lines={[
                              row.shareLine,
                              row.usedLine,
                              ...row.pools.map(
                                (pool) =>
                                  `${pool.line}${pool.runOutAt ? `, runs out around ${formatTimeOfDay(pool.runOutAt)}` : ""}`,
                              ),
                              row.changedBy.tier ? `Tier ${row.changedBy.tier}` : null,
                              row.changedBy.shares ? `Shares ${row.changedBy.shares}` : null,
                            ]}
                          />
                          <div className="flex gap-1">
                            <Button
                              size="xs"
                              variant="ghost"
                              disabled={sample || above === undefined}
                              onClick={() => {
                                if (above)
                                  void movePortfolioMission(
                                    snapshot.order,
                                    row.mission.missionId,
                                    above,
                                  );
                              }}
                            >
                              Move up
                            </Button>
                            <Button
                              size="xs"
                              variant="ghost"
                              disabled={sample || below === undefined}
                              onClick={() => {
                                if (below)
                                  void movePortfolioMission(
                                    snapshot.order,
                                    row.mission.missionId,
                                    below,
                                  );
                              }}
                            >
                              Move down
                            </Button>
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                </MissionSection>
              </>
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
