import {
  VIEW_BUILTIN_SECTION_TITLES,
  type ViewBuiltinSectionKind,
  type ViewRegion,
} from "@t3tools/contracts";
import type { ResolvedViewLayout, ViewSectionEntry } from "@t3tools/client-runtime/ardud/missions";

// The phone board is one column, so it shows the layout's stacked order. The
// lanes summary and open discussions are not layout entries; they sit where
// the web board puts them: lanes under Needs you, discussions on top of the
// main column.

export type BoardSlot =
  | { readonly type: "figures" }
  | {
      readonly type: "pinned";
      readonly kind: "needs-you" | "your-requests";
      readonly entry: ViewSectionEntry;
    }
  | { readonly type: "lanes" }
  | { readonly type: "discussions" }
  | { readonly type: "section"; readonly entry: ViewSectionEntry };

const builtin = (kind: ViewBuiltinSectionKind, region: ViewRegion): ViewSectionEntry => ({
  key: kind,
  kind,
  region,
  title: VIEW_BUILTIN_SECTION_TITLES[kind],
  hidden: false,
  removed: false,
  section: null,
  by: null,
});

/** The board before the mission's views load, or when it has none. */
const DEFAULT_SLOTS: ReadonlyArray<BoardSlot> = [
  { type: "figures" },
  { type: "section", entry: builtin("needs-you", "rail") },
  { type: "discussions" },
  { type: "section", entry: builtin("your-requests", "main") },
  { type: "lanes" },
  { type: "section", entry: builtin("since-last-looked", "main") },
  { type: "section", entry: builtin("path-to-milestone", "rail") },
  { type: "section", entry: builtin("sub-missions", "main") },
  { type: "section", entry: builtin("with-the-master", "rail") },
];

export function boardSlotKey(slot: BoardSlot): string {
  switch (slot.type) {
    case "pinned":
      return `pinned:${slot.entry.key}`;
    case "section":
      return `section:${slot.entry.key}`;
    default:
      return slot.type;
  }
}

/** What the board shows, top to bottom, for a resolved layout (null before views load). */
export function boardSlots(layout: ResolvedViewLayout | null): ReadonlyArray<BoardSlot> {
  if (layout === null) return DEFAULT_SLOTS;
  const slots: BoardSlot[] = [];
  if (layout.header.some((entry) => entry.kind === "header-stats")) slots.push({ type: "figures" });
  const pinned = (kind: "needs-you" | "your-requests") => {
    const entry = layout.setAside.find((candidate) => candidate.kind === kind);
    if (entry) slots.push({ type: "pinned", kind, entry });
  };
  if (layout.pinned.needsYou) pinned("needs-you");
  if (layout.pinned.requests) pinned("your-requests");

  // The stats row is the figures, wherever the layout puts it.
  const sections = layout.stacked.filter((entry) => entry.kind !== "header-stats");
  const body: BoardSlot[] = sections.map((entry) => ({ type: "section", entry }));
  const lanesAt = sections.findIndex((entry) => entry.kind === "needs-you") + 1;
  body.splice(lanesAt, 0, { type: "lanes" });
  const firstMain = body.findIndex(
    (slot) => slot.type === "section" && slot.entry.region === "main",
  );
  body.splice(firstMain === -1 ? body.length : firstMain, 0, { type: "discussions" });
  return [...slots, ...body];
}
