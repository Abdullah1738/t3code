import { useMemo } from "react";

import type { MissionId } from "@t3tools/contracts";
import {
  viewSection,
  viewSectionData,
  type MissionViewsState,
  type ResolvedViewLayout,
  type ViewSectionEntry,
} from "@t3tools/client-runtime/ardud/missions";

import { ViewBlocks } from "../cards/ViewBlocks";
import { SectionCount, SectionShell } from "./SectionShell";

// A section the master placed: its rows come from the server's query (or
// its pinned records), drawn with its own blocks. Empty sections hide.

export function CustomSection(props: {
  missionId: MissionId;
  views: MissionViewsState;
  layout: ResolvedViewLayout;
  section: ViewSectionEntry;
  nowMs: number;
}) {
  const { snapshot } = props.views;
  const record = props.section.section;
  const view = useMemo(
    () =>
      record === null
        ? null
        : viewSection(record, {
            nowMs: props.nowMs,
            data: viewSectionData(snapshot, record.id),
            assets: snapshot.assets ?? [],
          }),
    [record, snapshot, props.nowMs],
  );
  if (view === null || view.empty) return null;
  const data = record === null ? null : viewSectionData(snapshot, record.id);
  return (
    <SectionShell
      missionId={props.missionId}
      views={props.views}
      layout={props.layout}
      section={props.section}
      meta={
        data && data.total > data.rows.length ? (
          <SectionCount count={data.total} label={`${data.total} in all`} />
        ) : null
      }
    >
      <ViewBlocks blocks={view.blocks} />
    </SectionShell>
  );
}
