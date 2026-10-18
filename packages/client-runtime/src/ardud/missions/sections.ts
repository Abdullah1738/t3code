import type { MissionId } from "@t3tools/contracts";

import type { OpenForkInput } from "./source.ts";

// The mission overview is an ordered list of sections, not a fixed page. The
// owner and the master hide, move, remove and restore sections; every change
// is logged with who made it. Today the list starts from DEFAULT_SECTIONS and
// lives in the fixture; the views track's layout record replaces both.

export const SECTION_KINDS = [
  "needs-you",
  "your-requests",
  "sub-missions",
  "since-last-looked",
  "path-to-milestone",
  "with-the-master",
] as const;
export type SectionKind = (typeof SECTION_KINDS)[number];

export type SectionRegion = "main" | "rail";
export type SectionAuthor = "owner" | "master";

export interface SectionEntry {
  readonly key: string;
  readonly kind: SectionKind;
  readonly region: SectionRegion;
  readonly hidden: boolean;
  readonly removed: boolean;
  /** Owner or master rename; `null` uses the built-in title. */
  readonly title: string | null;
  readonly changedAt: string | null;
  readonly changedBy: SectionAuthor | null;
}

export interface LayoutChange {
  readonly id: string;
  readonly at: string;
  readonly by: SectionAuthor;
  readonly key: string;
  readonly summary: string;
}

export interface MissionLayout {
  readonly missionId: MissionId;
  /** Order is display order within each region. */
  readonly entries: ReadonlyArray<SectionEntry>;
  /** Newest first. */
  readonly changes: ReadonlyArray<LayoutChange>;
}

export type SectionChange =
  | { readonly type: "hide" }
  | { readonly type: "show" }
  | { readonly type: "move"; readonly region: SectionRegion; readonly index: number }
  | { readonly type: "remove" }
  | { readonly type: "restore" };

export interface ChangeSectionInput {
  readonly missionId: MissionId;
  readonly key: string;
  readonly change: SectionChange;
}

export const SECTION_TITLE: Record<SectionKind, string> = {
  "needs-you": "Needs you",
  "your-requests": "Your requests",
  "sub-missions": "Sub-missions",
  "since-last-looked": "Since you last looked",
  "path-to-milestone": "Path to milestone",
  "with-the-master": "With the master",
};

export const SECTION_REGION_LABEL: Record<SectionRegion, string> = {
  main: "Main column",
  rail: "Side column",
};

const entry = (kind: SectionKind, region: SectionRegion): SectionEntry => ({
  key: kind,
  kind,
  region,
  hidden: false,
  removed: false,
  title: null,
  changedAt: null,
  changedBy: null,
});

/** The recommended starting list, matching the views track's starter layout. */
export const DEFAULT_SECTIONS: ReadonlyArray<SectionEntry> = [
  entry("your-requests", "main"),
  entry("sub-missions", "main"),
  entry("since-last-looked", "main"),
  entry("needs-you", "rail"),
  entry("path-to-milestone", "rail"),
  entry("with-the-master", "rail"),
];

export function defaultLayout(missionId: MissionId): MissionLayout {
  return { missionId, entries: DEFAULT_SECTIONS, changes: [] };
}

export function sectionTitle(section: Pick<SectionEntry, "kind" | "title">): string {
  return section.title ?? SECTION_TITLE[section.kind];
}

/** Sections shown in a region, in order. */
export function visibleSections(layout: MissionLayout, region: SectionRegion): SectionEntry[] {
  return layout.entries.filter((s) => s.region === region && !s.hidden && !s.removed);
}

/** Hidden and removed sections, for the Views tab's restore list. */
export function setAsideSections(layout: MissionLayout): SectionEntry[] {
  return layout.entries.filter((s) => s.hidden || s.removed);
}

/** Needs you can be hidden but not removed: what waits on the owner must stay reachable. */
export function canRemoveSection(section: Pick<SectionEntry, "kind">): boolean {
  return section.kind !== "needs-you";
}

export interface SectionMoves {
  readonly up: number | null;
  readonly down: number | null;
  readonly other: SectionRegion;
}

/** Target indexes for the Move menu; `null` when the section is already at that end. */
export function sectionMoves(layout: MissionLayout, key: string): SectionMoves | null {
  const section = layout.entries.find((s) => s.key === key);
  if (!section) return null;
  const peers = visibleSections(layout, section.region);
  const at = peers.findIndex((s) => s.key === key);
  return {
    up: at > 0 ? at - 1 : null,
    down: at >= 0 && at < peers.length - 1 ? at + 1 : null,
    other: section.region === "main" ? "rail" : "main",
  };
}

export interface PinnedStrip {
  readonly needsYou: boolean;
  readonly requests: boolean;
}

/**
 * What the overview pins under its head when the section that holds it is
 * hidden: items waiting on the owner, and answered requests not yet read.
 */
export function pinnedStrip(
  layout: MissionLayout,
  waiting: { readonly ownerWaiting: number; readonly requestsUnread: number },
): PinnedStrip {
  const shown = (kind: SectionKind) =>
    layout.entries.some((s) => s.kind === kind && !s.hidden && !s.removed);
  return {
    needsYou: waiting.ownerWaiting > 0 && !shown("needs-you"),
    requests: waiting.requestsUnread > 0 && !shown("your-requests"),
  };
}

type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const err = <T>(error: string): Result<T> => ({ ok: false, error });

export interface SectionChangeMeta {
  readonly id: string;
  readonly at: string;
  readonly by: SectionAuthor;
  /** Items waiting on the owner, for the hide summary of Needs you. */
  readonly ownerWaiting?: number;
}

function changeSummary(
  section: SectionEntry,
  change: SectionChange,
  ownerWaiting: number,
  before: MissionLayout,
): string {
  const title = sectionTitle(section);
  switch (change.type) {
    case "hide":
      return section.kind === "needs-you" && ownerWaiting > 0
        ? `Hid ${title}; ${ownerWaiting} waiting ${ownerWaiting === 1 ? "item" : "items"} pinned under the head`
        : `Hid ${title}`;
    case "show":
      return `Showed ${title}`;
    case "remove":
      return `Removed ${title}`;
    case "restore":
      return `Restored ${title}`;
    case "move": {
      if (change.region !== section.region) {
        return `Moved ${title} to the ${change.region === "rail" ? "side" : "main"} column`;
      }
      const at = visibleSections(before, section.region).findIndex((s) => s.key === section.key);
      return change.index < at ? `Moved ${title} up` : `Moved ${title} down`;
    }
  }
}

/**
 * Applies one owner or master change. Changes that would not change anything
 * come back as the same layout, so nothing is logged for them.
 */
export function applySectionChange(
  layout: MissionLayout,
  key: string,
  change: SectionChange,
  meta: SectionChangeMeta,
): Result<MissionLayout> {
  const section = layout.entries.find((s) => s.key === key);
  if (!section) return err("That section is not on this mission.");
  if (change.type === "remove" && !canRemoveSection(section)) {
    return err("Needs you can be hidden, not removed.");
  }
  const stamp = { changedAt: meta.at, changedBy: meta.by };
  let entries: SectionEntry[];
  switch (change.type) {
    case "hide":
    case "show": {
      const hidden = change.type === "hide";
      if (section.hidden === hidden || section.removed) return ok(layout);
      entries = layout.entries.map((s) => (s.key === key ? { ...s, hidden, ...stamp } : s));
      break;
    }
    case "remove":
      if (section.removed) return ok(layout);
      entries = layout.entries.map((s) => (s.key === key ? { ...s, removed: true, ...stamp } : s));
      break;
    case "restore":
      if (!section.hidden && !section.removed) return ok(layout);
      entries = layout.entries.map((s) =>
        s.key === key ? { ...s, hidden: false, removed: false, ...stamp } : s,
      );
      break;
    case "move": {
      if (section.hidden || section.removed) return err("Show the section before moving it.");
      const rest = layout.entries.filter((s) => s.key !== key);
      const peers = rest.filter((s) => s.region === change.region && !s.hidden && !s.removed);
      const index = Math.max(0, Math.min(change.index, peers.length));
      const current = visibleSections(layout, section.region).findIndex((s) => s.key === key);
      if (change.region === section.region && index === current) return ok(layout);
      const moved = { ...section, region: change.region, ...stamp };
      const anchor = peers[index];
      const at = anchor ? rest.indexOf(anchor) : rest.length;
      entries = [...rest.slice(0, at), moved, ...rest.slice(at)];
      break;
    }
  }
  const logged: LayoutChange = {
    id: meta.id,
    at: meta.at,
    by: meta.by,
    key,
    summary: changeSummary(section, change, meta.ownerWaiting ?? 0, layout),
  };
  return ok({ ...layout, entries, changes: [logged, ...layout.changes] });
}

/** Opens a discussion with the master about one section. */
export function discussSectionInput(missionId: MissionId, section: SectionEntry): OpenForkInput {
  return {
    missionId,
    kind: "discuss",
    origin: null,
    question: `About the ${sectionTitle(section)} section`,
  };
}

/** Asks the master to change a section; the master edits the layout and the change is logged. */
export function askSectionChangeInput(
  missionId: MissionId,
  section: SectionEntry,
  text: string,
): Result<OpenForkInput> {
  const ask = text.trim();
  if (ask === "") return err("Say what should change.");
  return ok({
    missionId,
    kind: "owner-question",
    origin: null,
    question: `Change the ${sectionTitle(section)} section: ${ask}`,
  });
}
