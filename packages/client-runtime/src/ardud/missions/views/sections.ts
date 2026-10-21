import {
  VIEW_HARD_LIMITS,
  type MissionAsset,
  type MissionViewsSnapshot,
  type ViewNodeTag,
  type ViewSection,
  type ViewSectionData,
  type ViewSourceListing,
  type ViewSourceRun,
} from "@t3tools/contracts";

import { formatDayLabel, formatTimeOfDay, refLabel } from "../viewModel.ts";
import { type ViewBindContext } from "./bindings.ts";
import { viewBlock, type ViewBlock, type ViewRowContext } from "./cards.ts";
import { decodeViewBody } from "./decode.ts";

// A custom section is a title and a short body over rows: a query or script
// source the server answers (its rows ride on the views snapshot), or a fixed
// list of refs.

export interface ViewSectionView {
  readonly id: string;
  readonly title: string;
  readonly blocks: ReadonlyArray<ViewBlock>;
  /** Why a source section's rows are stale or missing. */
  readonly notice: string | null;
  /** Sections with no rows and nothing else to show are hidden. */
  readonly empty: boolean;
  readonly dropped: number;
  readonly madeBy: "master" | null;
}

const SECTION_NODES: ReadonlySet<ViewNodeTag> = new Set([
  "text",
  "label",
  "facts",
  "list",
  "table",
  "meter",
  "group",
  // --- views additions ---
  "collapsible",
  "markdown",
  // --- end views additions ---
  // --- blocks additions ---
  "stat",
  "chart",
  "timeline",
  "callout",
  "code",
  // --- end blocks additions ---
]);

export const viewSectionAllows = (tag: ViewNodeTag): boolean => SECTION_NODES.has(tag);

/** The rows the server computed for a query section, from the snapshot. */
export function viewSectionData(
  snapshot: Pick<MissionViewsSnapshot, "sectionData">,
  sectionId: string,
): ViewSectionData | null {
  return snapshot.sectionData?.find((data) => data.sectionId === sectionId) ?? null;
}

/** The script source a section reads, with its latest run. */
export interface ViewSectionSource {
  readonly listing: ViewSourceListing;
  readonly run: ViewSourceRun | null;
}

export function viewSectionSource(
  snapshot: Pick<MissionViewsSnapshot, "sources" | "sourceRuns">,
  section: ViewSection,
): ViewSectionSource | null {
  const source = section.definition.source;
  if (source._tag !== "source") return null;
  const listing = snapshot.sources?.find((entry) => entry.id === source.sourceId);
  if (listing === undefined) return null;
  const run = snapshot.sourceRuns?.find((entry) => entry.sourceId === source.sourceId) ?? null;
  return { listing, run };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** One quiet line when a source isn't feeding its section fresh rows. */
export function viewSourceNotice(source: ViewSectionSource, nowMs: number): string | null {
  if (source.listing.status === "removed" || !source.listing.enabled) return "Source off";
  const run = source.run;
  if (run === null || run.error === null) return null;
  if (run.okAt === null) return "Couldn't refresh";
  const at =
    nowMs - Date.parse(run.okAt) < DAY_MS ? formatTimeOfDay(run.okAt) : formatDayLabel(run.okAt);
  return `Couldn't refresh, showing ${at} rows`;
}

export interface ViewSectionOptions {
  readonly nowMs: number;
  readonly masterRoleId?: string | null;
  /** A query or source section's rows; without them it shows nothing. Refs sections carry their own. */
  readonly data?: ViewSectionData | null;
  /** A source section's script source; its field kinds bind the rows. */
  readonly source?: ViewSectionSource | null;
  readonly assets?: ReadonlyArray<MissionAsset>;
}

type RawRow = {
  readonly key: string;
  readonly ref: ViewRowContext["ref"];
  readonly row: NonNullable<ViewBindContext["row"]>;
};

const rowsOf = (
  section: ViewSection,
  data: ViewSectionData | null,
  source: ViewSectionSource | null,
): ReadonlyArray<RawRow> => {
  const from = section.definition.source;
  if (from._tag === "refs") {
    return from.refs.map((ref) => ({
      key: `${ref.kind}:${ref.id}`,
      ref,
      row: { scope: "refs", value: { ...ref, title: refLabel(ref) }, ref },
    }));
  }
  const rows = (data?.rows ?? []).slice(0, 20);
  if (from._tag === "source") {
    if (source === null) return [];
    const paths = { id: "text" as const, ...source.listing.fields };
    // Script rows are not mission records, so nothing opens them.
    return rows.map((row) => ({
      key: `${row.ref.kind}:${row.ref.id}`,
      ref: null,
      row: { scope: "source", value: row.value, paths },
    }));
  }
  const kind = from.query.kind;
  return rows.map((row) => ({
    key: `${row.ref.kind}:${row.ref.id}`,
    ref: row.ref,
    row: { scope: kind, value: row.value, ref: row.ref },
  }));
};

export function viewSection(section: ViewSection, options: ViewSectionOptions): ViewSectionView {
  const data = options.data ?? null;
  const source = options.source ?? null;
  const raw = rowsOf(section, data, source);
  const total =
    section.definition.source._tag === "refs" ? raw.length : (data?.total ?? raw.length);
  const notice = source === null ? null : viewSourceNotice(source, options.nowMs);
  const context: ViewBindContext = {
    scope: null,
    record: null,
    section: { count: raw.length, total },
    nowMs: options.nowMs,
    masterRoleId: options.masterRoleId ?? null,
    missionId: section.missionId,
  };
  const rows = raw.map((row): ViewRowContext => ({
    key: row.key,
    ref: row.ref,
    context: { ...context, row: row.row },
  }));
  const decoded = decodeViewBody(section.definition.body, {
    maxTop: VIEW_HARD_LIMITS.sectionBody,
    allows: viewSectionAllows,
  });
  const blocks = decoded.nodes.flatMap((node) => {
    const block = viewBlock(node, context, null, { rows, assets: options.assets ?? [] });
    return block === null ? [] : [block];
  });
  return {
    id: section.id,
    title: section.definition.title,
    blocks,
    notice,
    empty: notice === null && (rows.length === 0 || blocks.length === 0),
    dropped: decoded.dropped,
    madeBy: section.createdBy === "master" ? "master" : null,
  };
}
