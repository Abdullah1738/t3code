import {
  DEFAULT_STARTER_LAYOUT,
  VIEW_BUILTIN_SECTION_TITLES,
  VIEW_CATALOG_VERSION,
  VIEW_TAB_TITLES,
  viewPinnedStrip,
  type MissionId,
  type MissionViewsSnapshot,
  type ViewLayoutDefinition,
  type ViewLayoutEntry,
  type ViewLayoutOp,
} from "@t3tools/contracts";

import type {
  Listener,
  MissionViewChange,
  MissionViewsState,
  MissionsSource,
  Unsubscribe,
} from "../source.ts";
import { fail } from "./util.ts";

// Sample views records: every mission starts from the recommended starter
// layout and the section menu edits it the way the server's layout ops do.

export interface ViewsContext {
  readonly memo: <T>(key: string, compute: () => T) => T;
  readonly commit: () => void;
  readonly watch: <T>(read: () => T, listener: Listener<T>) => Unsubscribe;
  readonly nowIso: () => string;
  readonly localId: (prefix: string) => string;
  readonly ownerWaiting: (missionId: string) => number;
  readonly requestsUnread: (missionId: string) => number;
}

export type ViewsSource = Pick<MissionsSource, "subscribeViews" | "changeView">;

const titleOf = (entry: ViewLayoutEntry): string => {
  if (entry.title !== null) return entry.title;
  switch (entry.section._tag) {
    case "builtin":
      return VIEW_BUILTIN_SECTION_TITLES[entry.section.kind];
    case "tab":
      return `${VIEW_TAB_TITLES[entry.section.tab]} tab`;
    case "custom":
      return entry.key;
  }
};

/** Places `entry` as the `index`-th entry of its region, clamped to the region's end. */
function insertInRegion(
  entries: ReadonlyArray<ViewLayoutEntry>,
  entry: ViewLayoutEntry,
  index: number | undefined,
): ViewLayoutEntry[] {
  const next = [...entries];
  const regionAt = next.flatMap((other, at) => (other.region === entry.region ? [at] : []));
  if (index !== undefined && index < regionAt.length) {
    next.splice(regionAt[index] ?? next.length, 0, entry);
    return next;
  }
  const last = regionAt.at(-1);
  next.splice(last === undefined ? next.length : last + 1, 0, entry);
  return next;
}

/** Applies the ops the section menu sends; returns the change list or an error. */
export function applyFixtureLayoutOps(
  layout: ViewLayoutDefinition,
  ops: ReadonlyArray<ViewLayoutOp>,
): { readonly layout: ViewLayoutDefinition; readonly changes: string[] } | string {
  let entries = [...layout.entries];
  const changes: string[] = [];
  for (const op of ops) {
    if (op._tag === "add") {
      if (entries.some((entry) => entry.key === op.entry.key)) {
        return `Layout key ${op.entry.key} is taken.`;
      }
      entries = insertInRegion(entries, op.entry, op.index);
      changes.push(`added ${titleOf(op.entry)}`);
      continue;
    }
    if (!("key" in op)) return `The sample layout does not take ${op._tag}.`;
    const at = entries.findIndex((entry) => entry.key === op.key);
    const entry = entries[at];
    if (entry === undefined) return `No layout entry ${op.key}.`;
    const swap = (next: ViewLayoutEntry) => {
      entries = entries.map((other, position) => (position === at ? next : other));
    };
    switch (op._tag) {
      case "hide":
        swap({ ...entry, hidden: true });
        changes.push(`hid ${titleOf(entry)}`);
        break;
      case "show":
        swap({ ...entry, hidden: false });
        changes.push(`showed ${titleOf(entry)}`);
        break;
      case "rename":
        swap({ ...entry, title: op.title });
        changes.push(
          op.title === null
            ? `reset the title of ${titleOf(entry)}`
            : `renamed ${titleOf(entry)} to ${op.title}`,
        );
        break;
      case "move": {
        const region = op.region ?? entry.region;
        entries = insertInRegion(
          entries.filter((_, position) => position !== at),
          { ...entry, region },
          op.index,
        );
        changes.push(`moved ${titleOf(entry)}${region === entry.region ? "" : ` to ${region}`}`);
        break;
      }
      case "remove":
        entries = entries.filter((_, position) => position !== at);
        changes.push(`removed ${titleOf(entry)}`);
        break;
      case "replace":
        return "The sample layout does not take replace.";
    }
  }
  return { layout: { ...layout, entries }, changes };
}

interface MissionViews {
  readonly layout: ViewLayoutDefinition;
  readonly version: number;
  readonly changedAt: string;
  readonly changes: ReadonlyArray<MissionViewChange>;
}

export function createViews(ctx: ViewsContext): ViewsSource {
  const { memo, commit, watch, nowIso, localId } = ctx;
  const records = new Map<string, MissionViews>();

  const recordOf = (missionId: string): MissionViews =>
    records.get(missionId) ?? {
      layout: DEFAULT_STARTER_LAYOUT.layout,
      version: 1,
      changedAt: DEFAULT_STARTER_LAYOUT.changedAt,
      changes: [],
    };

  const stateOf = (missionId: MissionId): MissionViewsState =>
    memo(`views:${missionId}`, () => {
      const record = recordOf(missionId);
      const waiting = {
        ownerWaiting: ctx.ownerWaiting(missionId),
        requestsUnread: ctx.requestsUnread(missionId),
      };
      const pinned = viewPinnedStrip(record.layout, waiting);
      const snapshot: MissionViewsSnapshot = {
        missionId,
        catalogVersion: VIEW_CATALOG_VERSION,
        revision: record.version - 1,
        templates: [],
        sections: [],
        layout: {
          missionId,
          layout: record.layout,
          version: record.version,
          changedBy: record.version === 1 ? DEFAULT_STARTER_LAYOUT.changedBy : { _tag: "owner" },
          by: record.version === 1 ? "system" : "owner",
          changedAt: record.changedAt,
          changeNote: null,
          seededFrom: DEFAULT_STARTER_LAYOUT.version,
        },
        starter: DEFAULT_STARTER_LAYOUT,
        ...waiting,
        pinnedStrip: pinned.needsYou || pinned.requests,
        pinned,
        changesToday: 0,
      };
      return { snapshot, changes: record.changes };
    });

  return {
    subscribeViews: (missionId, listener) => watch(() => stateOf(missionId), listener),

    changeView(request) {
      if (request.method !== "editLayout") {
        return fail("invalid", "Sample missions have no custom sections.");
      }
      const { missionId, ops, expectedVersion } = request.input;
      const record = recordOf(missionId);
      if (expectedVersion !== undefined && expectedVersion !== record.version) {
        return fail("conflict", "The layout changed; try again.");
      }
      const applied = applyFixtureLayoutOps(record.layout, ops);
      if (typeof applied === "string") return fail("invalid", applied);
      const at = nowIso();
      const summary = `The owner ${applied.changes.join(", ")}`;
      records.set(missionId, {
        layout: applied.layout,
        version: record.version + 1,
        changedAt: at,
        changes: [{ id: localId("view-change"), at, by: "owner", summary }, ...record.changes],
      });
      commit();
      return Promise.resolve();
    },
  };
}
