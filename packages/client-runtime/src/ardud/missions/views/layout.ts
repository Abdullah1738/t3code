import {
  BUILTIN_VIEW_TEMPLATES,
  DEFAULT_STARTER_LAYOUT,
  STOCK_VIEW_TEMPLATES,
  VIEW_BUILTIN_SECTION_TITLES,
  VIEW_TAB_TITLES,
  viewPinnedStrip,
  type ApplyViewBundleInput,
  type EditViewLayoutInput,
  type MissionId,
  type MissionViewsSnapshot,
  type RemoveViewInput,
  type RestoreViewInput,
  type ViewAuthor,
  type ViewBuiltinSectionKind,
  type ViewLayoutDefinition,
  type ViewLayoutEntry,
  type ViewLayoutOp,
  type ViewPinned,
  type ViewRegion,
  type ViewSection,
  type ViewTabKind,
} from "@t3tools/contracts";

// The mission page is the layout record: an ordered list of entries, each a
// built-in section, a tab or a custom section, placed in a region. These
// helpers turn it into what the page renders and the section menu's changes
// into views RPC inputs.

export type ViewPageRegion = "main" | "rail" | "sub-mission";

export interface ViewSectionEntry {
  readonly key: string;
  readonly kind: ViewBuiltinSectionKind | "custom";
  readonly region: ViewRegion;
  readonly title: string;
  readonly hidden: boolean;
  /** A custom section whose record is removed or missing; restorable from the Views tab. */
  readonly removed: boolean;
  /** Custom sections only. */
  readonly section: ViewSection | null;
  /** Quiet by-you / by-master marker for custom sections. */
  readonly by: ViewAuthor | null;
}

export interface ViewTabEntry {
  readonly key: string;
  readonly tab: ViewTabKind;
  readonly title: string;
  readonly hidden: boolean;
}

export interface ResolvedViewLayout {
  readonly missionId: MissionId;
  readonly version: number;
  /** Header entries (the stats row), in order, visible only. */
  readonly header: ReadonlyArray<ViewSectionEntry>;
  /** Visible tabs in order. The overview tab is always reachable while anything is pinned. */
  readonly tabs: ReadonlyArray<ViewTabEntry>;
  readonly main: ReadonlyArray<ViewSectionEntry>;
  readonly rail: ReadonlyArray<ViewSectionEntry>;
  /** Stacked (one column) order: every visible overview section in entry order. */
  readonly stacked: ReadonlyArray<ViewSectionEntry>;
  /** Sections a sub-mission page shows. */
  readonly subMission: ReadonlyArray<ViewSectionEntry>;
  /** Hidden entries, removed custom sections and built-ins missing from the layout. */
  readonly setAside: ReadonlyArray<ViewSectionEntry>;
  readonly hiddenTabs: ReadonlyArray<ViewTabEntry>;
  readonly pinned: ViewPinned;
  /** Shown when either part of `pinned` is set. */
  readonly pinnedStrip: boolean;
  readonly by: ViewAuthor;
  readonly changedAt: string;
}

export interface ViewWaitingCounts {
  readonly ownerWaiting: number;
  readonly requestsUnread: number;
}

const OVERVIEW_REGIONS: ReadonlySet<ViewRegion> = new Set(["header", "main", "rail"]);

const BUILTIN_KINDS = Object.keys(
  VIEW_BUILTIN_SECTION_TITLES,
) as ReadonlyArray<ViewBuiltinSectionKind>;

function sectionEntry(
  entry: ViewLayoutEntry,
  sections: ReadonlyMap<string, ViewSection>,
): ViewSectionEntry | null {
  switch (entry.section._tag) {
    case "tab":
      return null;
    case "builtin":
      return {
        key: entry.key,
        kind: entry.section.kind,
        region: entry.region,
        title: entry.title ?? VIEW_BUILTIN_SECTION_TITLES[entry.section.kind],
        hidden: entry.hidden,
        removed: false,
        section: null,
        by: null,
      };
    case "custom": {
      const section = sections.get(entry.section.sectionId) ?? null;
      return {
        key: entry.key,
        kind: "custom",
        region: entry.region,
        title: entry.title ?? section?.definition.title ?? entry.key,
        hidden: entry.hidden,
        removed: section === null || section.status === "removed",
        section,
        by: section?.createdBy ?? null,
      };
    }
  }
}

function tabEntry(entry: ViewLayoutEntry): ViewTabEntry | null {
  if (entry.section._tag !== "tab") return null;
  return {
    key: entry.key,
    tab: entry.section.tab,
    title: entry.title ?? VIEW_TAB_TITLES[entry.section.tab],
    hidden: entry.hidden,
  };
}

const shows = (entry: ViewSectionEntry): boolean => !entry.hidden && !entry.removed;

/** Resolves a layout record to the ordered sections and tabs a mission page renders. */
export function resolveViewLayout(
  missionId: MissionId,
  layout: ViewLayoutDefinition,
  sections: ReadonlyArray<ViewSection>,
  waiting: ViewWaitingCounts,
  meta: { readonly version: number; readonly by: ViewAuthor; readonly changedAt: string },
): ResolvedViewLayout {
  const byId = new Map(sections.map((section) => [section.id as string, section]));
  const entries = layout.entries.flatMap((entry) => {
    const resolved = sectionEntry(entry, byId);
    return resolved === null ? [] : [resolved];
  });
  const tabs = layout.entries.flatMap((entry) => {
    const resolved = tabEntry(entry);
    return resolved === null ? [] : [resolved];
  });
  const pinned = viewPinnedStrip(layout, waiting);
  const pinnedStrip = pinned.needsYou || pinned.requests;
  const visibleTabs = tabs.filter((tab) => !tab.hidden);
  // What waits on the owner must stay reachable: a pinned strip lives on the
  // overview, so the overview tab comes back while it is set.
  const reachableTabs =
    pinnedStrip && tabs.length > 0 && !visibleTabs.some((tab) => tab.tab === "overview")
      ? [
          {
            key: "tab-overview",
            tab: "overview" as const,
            title: VIEW_TAB_TITLES.overview,
            hidden: false,
          },
          ...visibleTabs,
        ]
      : visibleTabs;
  const present = new Set(
    entries.flatMap((entry) => (entry.kind === "custom" ? [] : [entry.kind])),
  );
  const missing: ReadonlyArray<ViewSectionEntry> = BUILTIN_KINDS.filter(
    (kind) => !present.has(kind),
  ).map((kind) => ({
    key: kind,
    kind,
    region: viewStarterRegionOf(kind),
    title: VIEW_BUILTIN_SECTION_TITLES[kind],
    hidden: true,
    removed: true,
    section: null,
    by: null,
  }));
  return {
    missionId,
    version: meta.version,
    header: entries.filter((entry) => entry.region === "header" && shows(entry)),
    tabs: reachableTabs,
    main: entries.filter((entry) => entry.region === "main" && shows(entry)),
    rail: entries.filter((entry) => entry.region === "rail" && shows(entry)),
    stacked: entries.filter(
      (entry) => entry.region !== "header" && OVERVIEW_REGIONS.has(entry.region) && shows(entry),
    ),
    subMission: entries.filter((entry) => entry.region === "sub-mission" && shows(entry)),
    setAside: [...entries.filter((entry) => !shows(entry)), ...missing],
    hiddenTabs: tabs.filter((tab) => tab.hidden),
    pinned,
    pinnedStrip,
    by: meta.by,
    changedAt: meta.changedAt,
  };
}

/** Resolves the layout a views snapshot carries. */
export function resolveViewSnapshotLayout(
  snapshot: Pick<
    MissionViewsSnapshot,
    "missionId" | "layout" | "sections" | "ownerWaiting" | "requestsUnread"
  >,
): ResolvedViewLayout {
  return resolveViewLayout(
    snapshot.missionId,
    snapshot.layout.layout,
    snapshot.sections,
    { ownerWaiting: snapshot.ownerWaiting, requestsUnread: snapshot.requestsUnread },
    {
      version: snapshot.layout.version,
      by: snapshot.layout.by,
      changedAt: snapshot.layout.changedAt,
    },
  );
}

/** Where the recommended starter puts a built-in, for bringing one back. */
export function viewStarterRegionOf(kind: ViewBuiltinSectionKind): ViewRegion {
  const entry = DEFAULT_STARTER_LAYOUT.layout.entries.find(
    (candidate) => candidate.section._tag === "builtin" && candidate.section.kind === kind,
  );
  return entry?.region ?? "main";
}

// ---------------------------------------------------------------------------
// Section menu: Hide / Show / Move / Rename / Remove / Restore

export type ViewSectionChange =
  | { readonly type: "hide" }
  | { readonly type: "show" }
  /** `index` counts the visible sections of the target region, as the page shows them. */
  | { readonly type: "move"; readonly region: ViewPageRegion; readonly index: number }
  | { readonly type: "rename"; readonly title: string | null }
  | { readonly type: "remove" }
  | { readonly type: "restore" };

export type ViewSectionRequest =
  | { readonly method: "editLayout"; readonly input: EditViewLayoutInput }
  | { readonly method: "remove"; readonly input: RemoveViewInput }
  | { readonly method: "restore"; readonly input: RestoreViewInput }
  | { readonly method: "applyBundle"; readonly input: ApplyViewBundleInput };

/** Entry index within `region` for the `index`-th visible section there. */
function regionIndex(
  layout: ViewLayoutDefinition,
  key: string,
  region: ViewRegion,
  visibleIndex: number,
  sections: ReadonlyMap<string, ViewSection>,
): number {
  const peers = layout.entries.filter((entry) => entry.region === region && entry.key !== key);
  const visible = peers.flatMap((entry, at) => {
    const resolved = sectionEntry(entry, sections);
    return resolved !== null && shows(resolved) ? [at] : [];
  });
  if (visibleIndex <= 0) return visible[0] ?? 0;
  if (visibleIndex >= visible.length) {
    const last = visible.at(-1);
    return last === undefined ? peers.length : last + 1;
  }
  return visible[visibleIndex] ?? peers.length;
}

/**
 * The views RPC that makes a section-menu change. Built-in sections live only
 * in the layout; custom sections are records, so removing and restoring them
 * goes through the section record. Null when the change does not apply.
 */
export function viewSectionRequest(
  snapshot: Pick<MissionViewsSnapshot, "missionId" | "layout" | "sections">,
  key: string,
  change: ViewSectionChange,
): ViewSectionRequest | null {
  const layout = snapshot.layout.layout;
  const entry = layout.entries.find((candidate) => candidate.key === key);
  const sections = new Map(snapshot.sections.map((section) => [section.id as string, section]));
  const expectedVersion = snapshot.layout.version;
  const edit = (ops: ReadonlyArray<ViewLayoutOp>): ViewSectionRequest => ({
    method: "editLayout",
    input: { missionId: snapshot.missionId, ops: [...ops], expectedVersion },
  });

  if (entry === undefined) {
    // A built-in that was removed from the layout comes back where the starter puts it.
    if (change.type !== "restore" || !(BUILTIN_KINDS as ReadonlyArray<string>).includes(key)) {
      return null;
    }
    const kind = key as ViewBuiltinSectionKind;
    return edit([
      {
        _tag: "add",
        entry: {
          key: kind,
          section: { _tag: "builtin", kind },
          region: viewStarterRegionOf(kind),
          hidden: false,
          title: null,
        },
      },
    ]);
  }

  const custom =
    entry.section._tag === "custom" ? sections.get(entry.section.sectionId) : undefined;
  switch (change.type) {
    case "hide":
      return entry.hidden ? null : edit([{ _tag: "hide", key }]);
    case "show":
      return entry.hidden ? edit([{ _tag: "show", key }]) : null;
    case "rename":
      return edit([{ _tag: "rename", key, title: change.title }]);
    case "move":
      return edit([
        {
          _tag: "move",
          key,
          region: change.region,
          index: regionIndex(layout, key, change.region, change.index, sections),
        },
      ]);
    case "remove":
      if (custom !== undefined) {
        return custom.status === "removed"
          ? null
          : {
              method: "remove",
              input: {
                missionId: snapshot.missionId,
                ref: { kind: "view-section", id: custom.id },
                expectedVersion: custom.version,
              },
            };
      }
      return edit([{ _tag: "remove", key }]);
    case "restore":
      if (custom !== undefined && custom.status === "removed") {
        return {
          method: "restore",
          input: { missionId: snapshot.missionId, ref: { kind: "view-section", id: custom.id } },
        };
      }
      return entry.hidden ? edit([{ _tag: "show", key }]) : null;
  }
}

/** The starter differs from what this mission was seeded with; the master may offer it. */
export function viewStarterIsNewer(
  snapshot: Pick<MissionViewsSnapshot, "layout" | "starter">,
): boolean {
  return snapshot.starter.version > snapshot.layout.seededFrom;
}

/** Takes the newer starter layout; the mission's own sections stay where they are. */
export function viewStarterRequest(
  snapshot: Pick<MissionViewsSnapshot, "missionId" | "layout" | "starter">,
): ViewSectionRequest | null {
  if (!viewStarterIsNewer(snapshot)) return null;
  return {
    method: "editLayout",
    input: {
      missionId: snapshot.missionId,
      ops: [{ _tag: "reset" }],
      expectedVersion: snapshot.layout.version,
      changeNote: `Took the starter layout v${snapshot.starter.version}.`,
    },
  };
}

/** Copies another mission's card templates and portable sections in one change. */
export function viewCopyRequest(missionId: MissionId, from: MissionId): ViewSectionRequest {
  return {
    method: "applyBundle",
    input: { missionId, templates: [], sections: [], copyFrom: { missionId: from } },
  };
}

/** Removes a custom card template, or brings a removed one back. */
export function viewTemplateRequest(
  snapshot: Pick<MissionViewsSnapshot, "missionId" | "templates">,
  templateId: string,
  change: "remove" | "restore",
): ViewSectionRequest | null {
  const template = snapshot.templates.find((item) => item.id === templateId);
  if (template === undefined) return null;
  const ref = { kind: "view-template", id: template.id } as const;
  if (change === "remove") {
    return template.status === "removed"
      ? null
      : {
          method: "remove",
          input: { missionId: snapshot.missionId, ref, expectedVersion: template.version },
        };
  }
  return template.status === "removed"
    ? { method: "restore", input: { missionId: snapshot.missionId, ref } }
    : null;
}

export interface ViewKitTemplate {
  readonly id: string;
  readonly name: string;
  readonly by: ViewAuthor;
  readonly removed: boolean;
  readonly changedAt: string;
}

export interface ViewCardKit {
  /** Built-in and stock card names still in use; a custom template with a stock key replaces it. */
  readonly builtIn: ReadonlyArray<string>;
  /** The mission's own templates, active first, newest change first. */
  readonly custom: ReadonlyArray<ViewKitTemplate>;
}

export function viewCardKit(snapshot: Pick<MissionViewsSnapshot, "templates">): ViewCardKit {
  const taken = new Set(
    snapshot.templates
      .filter((template) => template.status === "active")
      .map((template) => template.definition.key),
  );
  const stock = STOCK_VIEW_TEMPLATES.filter((template) => !taken.has(template.definition.key));
  // Hermes has no `toSorted`; `map` already returned a fresh array.
  const custom = snapshot.templates
    .map((template) => ({
      id: template.id,
      name: template.definition.name,
      by: template.by,
      removed: template.status === "removed",
      changedAt: template.changedAt,
    }))
    .sort(
      (a, b) => Number(a.removed) - Number(b.removed) || b.changedAt.localeCompare(a.changedAt),
    );
  return {
    builtIn: [...BUILTIN_VIEW_TEMPLATES, ...stock].map((template) => template.definition.name),
    custom,
  };
}
