import type {
  MissionId,
  MissionViewsSnapshot,
  RunViewSourceInput,
  SetViewSourceInput,
  ViewDataSourceId,
  ViewHistory,
  ViewHistoryInput,
} from "@t3tools/contracts";

// The owner's Sources list on the Views tab: each script source with its last
// run, and the inputs its Refresh and Disable/Enable buttons send.

export type ViewSourceStatus = "off" | "running" | "failed";

export interface ViewSourceItem {
  readonly id: ViewDataSourceId;
  readonly missionId: MissionId;
  readonly title: string;
  readonly version: number;
  readonly enabled: boolean;
  /** Null when the last run went fine. */
  readonly status: ViewSourceStatus | null;
  /** Rows of the last good run; null before one. */
  readonly rows: number | null;
  readonly ranAt: string | null;
  readonly error: string | null;
  readonly canRun: boolean;
}

/** Active sources by title; removed ones stay out of the list. */
export function viewSourceItems(
  snapshot: Pick<MissionViewsSnapshot, "sources" | "sourceRuns">,
): ReadonlyArray<ViewSourceItem> {
  const runs = new Map((snapshot.sourceRuns ?? []).map((run) => [run.sourceId, run]));
  return (snapshot.sources ?? [])
    .filter((listing) => listing.status === "active")
    .map((listing): ViewSourceItem => {
      const run = runs.get(listing.id) ?? null;
      const status: ViewSourceStatus | null = !listing.enabled
        ? "off"
        : run?.running
          ? "running"
          : run?.error
            ? "failed"
            : null;
      return {
        id: listing.id,
        missionId: listing.missionId,
        title: listing.title,
        version: listing.version,
        enabled: listing.enabled,
        status,
        rows: run?.okAt ? run.rows : null,
        ranAt: run?.ranAt ?? null,
        error: run?.error ?? null,
        canRun: status !== "off" && status !== "running",
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title));
}

export const viewSourceRunInput = (item: ViewSourceItem): RunViewSourceInput => ({
  missionId: item.missionId,
  sourceId: item.id,
});

export const viewSourceToggleInput = (item: ViewSourceItem): SetViewSourceInput => ({
  missionId: item.missionId,
  sourceId: item.id,
  enabled: !item.enabled,
  expectedVersion: item.version,
});

export const viewSourceHistoryInput = (
  item: Pick<ViewSourceItem, "missionId" | "id">,
): ViewHistoryInput => ({
  missionId: item.missionId,
  target: { _tag: "source", id: item.id },
});

/** The script at `version`; the listing leaves code out, so it reads through history. */
export function viewSourceCode(history: ViewHistory, version: number): string | null {
  const value = history.entries.find((entry) => entry.version === version)?.value;
  if (typeof value !== "object" || value === null || !("code" in value)) return null;
  return typeof value.code === "string" ? value.code : null;
}
