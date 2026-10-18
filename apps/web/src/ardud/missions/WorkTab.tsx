import { useMemo } from "react";

import type { WorkItem } from "@t3tools/contracts";
import {
  blockedWork,
  formatRelative,
  workEdges,
  workFactsLine,
  workPipeline,
} from "@t3tools/client-runtime/ardud/missions";

import { MutedLines } from "./MissionForms";
import { MissionSection } from "./MissionSection";
import { useMasterRoleId, useMissionWork } from "./missionsStore";

// Work tab, placeholder presentation. Pipeline stages, who holds the ball on
// blocked items and the dependency edges come from client-runtime
// (workViewModel).

export function WorkTab(props: { missionId: WorkItem["missionId"]; nowMs: number }) {
  const work = useMissionWork(props.missionId);
  const masterRoleId = useMasterRoleId(props.missionId);
  const view = useMemo(() => {
    if (!work) return null;
    return {
      pipeline: workPipeline(work.items),
      blocked: blockedWork(work.items, masterRoleId),
      edges: workEdges(work.items),
      titles: new Map(work.items.map((item) => [item.id as string, item.title])),
    };
  }, [work, masterRoleId]);
  if (!view) return <p className="text-sm text-muted-foreground">Loading work…</p>;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <MissionSection title="Blocked, by who holds the ball">
        {view.blocked.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing is blocked.</p>
        ) : (
          <ul className="flex flex-col gap-3 text-sm">
            {view.blocked.map((group) => (
              <li key={group.holder} className="flex flex-col gap-1">
                <span className="font-medium text-foreground">{group.holder}</span>
                <ul className="flex flex-col gap-1 ps-3">
                  {group.items.map((entry) => (
                    <li key={entry.item.id}>
                      {entry.item.title}
                      <MutedLines lines={[entry.waitingOn]} />
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </MissionSection>

      <MissionSection title="Pipeline">
        <ol className="flex flex-col gap-3 text-sm">
          {view.pipeline.map((column) => (
            <li key={column.stage} className="flex flex-col gap-1">
              <span className="font-medium text-foreground">
                {column.label} ({column.items.length})
              </span>
              {column.items.length > 0 ? (
                <ul className="flex flex-col gap-1 ps-3">
                  {column.items.map((item) => (
                    <li key={item.id}>
                      {item.title}
                      <MutedLines
                        lines={[
                          item.pullRequest
                            ? `${item.pullRequest.repository}#${item.pullRequest.number}`
                            : null,
                          workFactsLine(item),
                          `Updated ${formatRelative(item.updatedAt, props.nowMs)}`,
                        ]}
                      />
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ol>
      </MissionSection>

      <MissionSection title="Depends on">
        {view.edges.length === 0 ? (
          <p className="text-sm text-muted-foreground">No dependencies recorded.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {view.edges.map((edge) => (
              <li key={`${edge.from}->${edge.to}`}>
                {view.titles.get(edge.to) ?? edge.to} waits on{" "}
                {view.titles.get(edge.from) ?? edge.from}
                {edge.open ? "" : " (done)"}
              </li>
            ))}
          </ul>
        )}
      </MissionSection>
    </div>
  );
}
