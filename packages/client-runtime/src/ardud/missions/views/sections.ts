import {
  VIEW_HARD_LIMITS,
  type MissionAsset,
  type MissionViewsSnapshot,
  type ViewNodeTag,
  type ViewSection,
  type ViewSectionData,
} from "@t3tools/contracts";

import { refLabel } from "../viewModel.ts";
import { type ViewBindContext } from "./bindings.ts";
import { viewBlock, type ViewBlock, type ViewRowContext } from "./cards.ts";
import { decodeViewBody } from "./decode.ts";

// A custom section is a title and a short body over rows: a query the server
// answers (its rows ride on the views snapshot), or a fixed list of refs.

export interface ViewSectionView {
  readonly id: string;
  readonly title: string;
  readonly blocks: ReadonlyArray<ViewBlock>;
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

export interface ViewSectionOptions {
  readonly nowMs: number;
  readonly masterRoleId?: string | null;
  /** A query section's rows; without them it shows nothing. Refs sections carry their own. */
  readonly data?: ViewSectionData | null;
  readonly assets?: ReadonlyArray<MissionAsset>;
}

type RawRow = {
  readonly key: string;
  readonly ref: ViewRowContext["ref"];
  readonly row: NonNullable<ViewBindContext["row"]>;
};

const rowsOf = (section: ViewSection, data: ViewSectionData | null): ReadonlyArray<RawRow> => {
  const source = section.definition.source;
  if (source._tag === "refs") {
    return source.refs.map((ref) => ({
      key: `${ref.kind}:${ref.id}`,
      ref,
      row: { scope: "refs", value: { ...ref, title: refLabel(ref) }, ref },
    }));
  }
  const kind = source.query.kind;
  return (data?.rows ?? []).slice(0, 20).map((row) => ({
    key: `${row.ref.kind}:${row.ref.id}`,
    ref: row.ref,
    row: { scope: kind, value: row.value, ref: row.ref },
  }));
};

export function viewSection(section: ViewSection, options: ViewSectionOptions): ViewSectionView {
  const data = options.data ?? null;
  const raw = rowsOf(section, data);
  const total =
    section.definition.source._tag === "query" ? (data?.total ?? raw.length) : raw.length;
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
    empty: rows.length === 0 || blocks.length === 0,
    dropped: decoded.dropped,
    madeBy: section.createdBy === "master" ? "master" : null,
  };
}
