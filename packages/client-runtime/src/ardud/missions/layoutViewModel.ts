import { VIEW_TAB_TITLES, type MissionViewsSnapshot, type ViewRegion } from "@t3tools/contracts";

import {
  resolveViewLayout,
  type ResolvedViewLayout,
  type ViewPageRegion,
  type ViewSectionChange,
  type ViewSectionEntry,
  type ViewSectionRequest,
  type ViewTabEntry,
  type ViewWaitingCounts,
} from "./views/layout.ts";

// The mission page's layout as the web shows it: overview columns, the
// section menu's moves and the Views tab's grouped list. The record and its
// RPCs live in views/layout.ts.

export const VIEW_REGION_LABEL: Record<ViewRegion, string> = {
  main: "Board main",
  rail: "Board rail",
  header: "Header",
  "sub-mission": "Sub-mission page",
  tabs: "Tabs",
};

/** Group order on the Views tab. */
const REGION_ORDER: ReadonlyArray<ViewRegion> = ["main", "rail", "header", "sub-mission", "tabs"];

/**
 * Resolves the layout with the page's own waiting counts when it has them, so
 * the pinned strip follows the inbox the page already shows.
 */
export function resolveMissionLayout(
  snapshot: MissionViewsSnapshot,
  waiting?: Partial<ViewWaitingCounts>,
): ResolvedViewLayout {
  return resolveViewLayout(
    snapshot.missionId,
    snapshot.layout.layout,
    snapshot.sections,
    {
      ownerWaiting: waiting?.ownerWaiting ?? snapshot.ownerWaiting,
      requestsUnread: waiting?.requestsUnread ?? snapshot.requestsUnread,
    },
    {
      version: snapshot.layout.version,
      by: snapshot.layout.by,
      changedAt: snapshot.layout.changedAt,
    },
  );
}

/** Needs you can be hidden (its items pin under the header) but never removed. */
export const canRemoveViewSection = (entry: Pick<ViewSectionEntry, "kind">): boolean =>
  entry.kind !== "needs-you";

/** The Views tab is how the layout comes back, so it always stays. */
export const canChangeViewTab = (tab: Pick<ViewTabEntry, "tab">): boolean => tab.tab !== "views";

export interface ViewSectionMoves {
  readonly up: ViewSectionChange | null;
  readonly down: ViewSectionChange | null;
  /** To the other board column. */
  readonly across: ViewSectionChange | null;
  readonly acrossLabel: string | null;
}

const NO_MOVES: ViewSectionMoves = { up: null, down: null, across: null, acrossLabel: null };

/** Move targets for a visible board section, in the menu's terms. */
export function viewSectionMoves(layout: ResolvedViewLayout, key: string): ViewSectionMoves {
  const columns: Record<"main" | "rail", ReadonlyArray<ViewSectionEntry>> = {
    main: layout.main,
    rail: layout.rail,
  };
  const region = layout.main.some((entry) => entry.key === key)
    ? "main"
    : layout.rail.some((entry) => entry.key === key)
      ? "rail"
      : null;
  if (region === null) return NO_MOVES;
  const peers = columns[region];
  const at = peers.findIndex((entry) => entry.key === key);
  const other: ViewPageRegion = region === "main" ? "rail" : "main";
  return {
    up: at > 0 ? { type: "move", region, index: at - 1 } : null,
    down: at < peers.length - 1 ? { type: "move", region, index: at + 1 } : null,
    across: { type: "move", region: other, index: columns[other].length },
    acrossLabel: `To ${VIEW_REGION_LABEL[other]}`,
  };
}

export type LayoutRow =
  | { readonly type: "section"; readonly key: string; readonly entry: ViewSectionEntry }
  | { readonly type: "tab"; readonly key: string; readonly entry: ViewTabEntry };

export interface LayoutGroup {
  readonly region: ViewRegion;
  readonly label: string;
  readonly rows: ReadonlyArray<LayoutRow>;
}

/**
 * Every layout entry, hidden ones included, grouped by region in page order.
 * Built-ins missing from the record close their group so they can come back.
 * Empty groups are left out.
 */
export function layoutGroups(
  snapshot: MissionViewsSnapshot,
  layout: ResolvedViewLayout,
): ReadonlyArray<LayoutGroup> {
  const sections = new Map<string, ViewSectionEntry>();
  for (const entry of [
    ...layout.header,
    ...layout.main,
    ...layout.rail,
    ...layout.subMission,
    ...layout.setAside,
  ]) {
    sections.set(entry.key, entry);
  }
  const tabs = new Map<string, ViewTabEntry>();
  for (const tab of [...layout.tabs, ...layout.hiddenTabs]) tabs.set(tab.key, tab);

  const rows = new Map<ViewRegion, LayoutRow[]>();
  const add = (region: ViewRegion, row: LayoutRow) => {
    const list = rows.get(region) ?? [];
    list.push(row);
    rows.set(region, list);
  };
  const placed = new Set<string>();
  for (const entry of snapshot.layout.layout.entries) {
    const section = sections.get(entry.key);
    const tab = tabs.get(entry.key);
    if (section) add(entry.region, { type: "section", key: entry.key, entry: section });
    else if (tab) add(entry.region, { type: "tab", key: entry.key, entry: tab });
    placed.add(entry.key);
  }
  for (const missing of layout.setAside) {
    if (!placed.has(missing.key)) {
      add(missing.region, { type: "section", key: missing.key, entry: missing });
    }
  }
  return REGION_ORDER.flatMap((region) => {
    const list = rows.get(region);
    return list && list.length > 0
      ? [{ region, label: VIEW_REGION_LABEL[region], rows: list }]
      : [];
  });
}

// ardud missions: fix-p3 - Views tab drag and drop
const REGIONS_OF: Record<"tab" | "builtin" | "custom", ReadonlySet<ViewRegion>> = {
  tab: new Set(["tabs"]),
  builtin: new Set(["header", "main", "rail", "sub-mission"]),
  custom: new Set(["main", "rail", "sub-mission"]),
};

/** Whether a dragged entry may land in `region`: tabs stay tabs, custom sections stay off the header. */
export const fitsViewRegion = (row: LayoutRow, region: ViewRegion): boolean =>
  REGIONS_OF[row.type === "tab" ? "tab" : row.entry.kind === "custom" ? "custom" : "builtin"].has(
    region,
  );

export interface ViewDropTarget {
  readonly region: ViewRegion;
  /** The entry it lands before; null for the region's end. */
  readonly before: string | null;
}

/**
 * Where a dragged entry lands. Over an entry of its own region it takes that
 * entry's place; over an entry elsewhere it goes just before it; over a
 * region's free space it goes last.
 */
export function viewDropTarget(
  groups: ReadonlyArray<LayoutGroup>,
  key: string,
  over: { readonly region: ViewRegion; readonly key: string | null },
): ViewDropTarget {
  const rows = groups.find((group) => group.region === over.region)?.rows ?? [];
  const from = rows.findIndex((row) => row.key === key);
  if (over.key === null || from === -1) return { region: over.region, before: over.key };
  const to = rows.findIndex((row) => row.key === over.key);
  const order = rows.filter((row) => row.key !== key);
  // Dragging down puts it after the entry it is over, up puts it before.
  const next = to > from ? order[order.findIndex((row) => row.key === over.key) + 1] : rows[to];
  return { region: over.region, before: next?.key ?? null };
}

/**
 * The groups a drag can land in: every region that takes the dragged entry,
 * empty ones included, so a region emptied by a drag can be filled again.
 */
export function viewDropGroups(
  groups: ReadonlyArray<LayoutGroup>,
  row: LayoutRow | null,
): ReadonlyArray<LayoutGroup> {
  return REGION_ORDER.flatMap((region) => {
    const group = groups.find((candidate) => candidate.region === region);
    if (group !== undefined && group.rows.length > 0) return [group];
    return row !== null && fitsViewRegion(row, region)
      ? [{ region, label: VIEW_REGION_LABEL[region], rows: [] }]
      : [];
  });
}

/** The groups with one entry moved, for showing a drop before the server confirms it. */
export function dropLayoutGroups(
  groups: ReadonlyArray<LayoutGroup>,
  key: string,
  target: ViewDropTarget,
): ReadonlyArray<LayoutGroup> {
  const moved = groups.flatMap((group) => group.rows).find((row) => row.key === key);
  if (moved === undefined) return groups;
  return viewDropGroups(groups, moved).map((group) => {
    const rows = group.rows.filter((row) => row.key !== key);
    if (group.region !== target.region) return { ...group, rows };
    const at = target.before === null ? -1 : rows.findIndex((row) => row.key === target.before);
    return { ...group, rows: at === -1 ? [...rows, moved] : rows.toSpliced(at, 0, moved) };
  });
}

/**
 * The layout move for an entry dropped into `region` just before the entry
 * `before` (null drops it at the region's end). Null when the drop changes
 * nothing or the region does not take the entry.
 */
export function viewDropRequest(
  snapshot: Pick<MissionViewsSnapshot, "missionId" | "layout">,
  key: string,
  region: ViewRegion,
  before: string | null,
): ViewSectionRequest | null {
  const entries = snapshot.layout.layout.entries;
  const entry = entries.find((candidate) => candidate.key === key);
  if (entry === undefined || !REGIONS_OF[entry.section._tag].has(region)) return null;
  const peers = entries.filter((other) => other.region === region && other.key !== key);
  const at = before === null ? -1 : peers.findIndex((other) => other.key === before);
  const index = at === -1 ? peers.length : at;
  if (entry.region === region) {
    const current = entries
      .filter((other) => other.region === region)
      .findIndex((other) => other.key === key);
    if (current === index) return null;
  }
  return {
    method: "editLayout",
    input: {
      missionId: snapshot.missionId,
      ops: [{ _tag: "move", key, region, index }],
      expectedVersion: snapshot.layout.version,
    },
  };
}

/** What Discuss on a section sends the master as an owner request. */
export const discussSectionText = (title: string, text: string): string =>
  `About the ${title} section: ${text.trim()}`;

/** What "Ask the master to change" sends as an owner request. */
export const askSectionChangeText = (title: string, text: string): string =>
  `Change the ${title} section: ${text.trim()}`;

export interface PageTab<T extends string> {
  readonly tab: T;
  readonly title: string;
}

/**
 * The tab row a client shows: the layout's visible tabs in order, limited to
 * the tabs this client has, with renamed titles kept and built-in titles in
 * the client's own words. The Views tab and the open tab always show, so a
 * hidden tab opened from a link (or the way back to the layout) stays reachable.
 */
export function pageTabs<T extends string>(
  layout: Pick<ResolvedViewLayout, "tabs" | "hiddenTabs">,
  labels: Readonly<Record<T, string>>,
  current: T,
): ReadonlyArray<PageTab<T>> {
  const has = (tab: string): tab is T => Object.hasOwn(labels, tab);
  const title = (entry: ViewTabEntry & { tab: T }) =>
    entry.title === VIEW_TAB_TITLES[entry.tab] ? labels[entry.tab] : entry.title;
  const rows: Array<PageTab<T>> = [];
  for (const entry of layout.tabs) {
    if (has(entry.tab))
      rows.push({ tab: entry.tab, title: title(entry as ViewTabEntry & { tab: T }) });
  }
  for (const entry of layout.hiddenTabs) {
    const keep = entry.tab === "views" || entry.tab === current;
    if (keep && has(entry.tab) && !rows.some((row) => row.tab === entry.tab)) {
      rows.push({ tab: entry.tab, title: title(entry as ViewTabEntry & { tab: T }) });
    }
  }
  return rows;
}
