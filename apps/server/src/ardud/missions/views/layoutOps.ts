/**
 * Layout edits as pure functions over the layout record. Order is array
 * order; `index` on move/add counts entries within the target region.
 */
import {
  VIEW_BUILTIN_SECTION_TITLES,
  VIEW_TAB_TITLES,
  type ViewIssue,
  type ViewLayoutDefinition,
  type ViewLayoutEntry,
  type ViewLayoutOp,
  type ViewRegion,
} from "@t3tools/contracts";

export interface AppliedOps {
  readonly layout: ViewLayoutDefinition;
  readonly issues: ReadonlyArray<ViewIssue>;
  /** Plain-language change list for the timeline summary. */
  readonly changes: ReadonlyArray<string>;
}

export const entryTitle = (entry: ViewLayoutEntry, sectionTitle?: string): string => {
  if (entry.title !== null) return entry.title;
  switch (entry.section._tag) {
    case "builtin":
      return VIEW_BUILTIN_SECTION_TITLES[entry.section.kind];
    case "tab":
      return `${VIEW_TAB_TITLES[entry.section.tab]} tab`;
    case "custom":
      return sectionTitle ?? entry.key;
  }
};

/** Inserts `entry` so it is the `index`-th entry of its region (clamped to the region's end). */
export const insertInRegion = (
  entries: ReadonlyArray<ViewLayoutEntry>,
  entry: ViewLayoutEntry,
  index: number | undefined,
): Array<ViewLayoutEntry> => {
  const next = [...entries];
  const regionAt = next.flatMap((other, at) => (other.region === entry.region ? [at] : []));
  if (index !== undefined && index < regionAt.length) {
    next.splice(regionAt[index] ?? next.length, 0, entry);
    return next;
  }
  const last = regionAt.at(-1);
  next.splice(last === undefined ? next.length : last + 1, 0, entry);
  return next;
};

export interface OpsContext {
  /** The starter layout's definition, for `reset`; null when editing the starter itself. */
  readonly starter: ViewLayoutDefinition | null;
  readonly sectionTitle: (sectionId: string) => string | undefined;
}

export const applyLayoutOps = (
  layout: ViewLayoutDefinition,
  ops: ReadonlyArray<ViewLayoutOp>,
  context: OpsContext,
): AppliedOps => {
  let entries: Array<ViewLayoutEntry> = [...layout.entries];
  let limits = layout.limits;
  const issues: Array<ViewIssue> = [];
  const changes: Array<string> = [];

  const titleOf = (entry: ViewLayoutEntry) =>
    entryTitle(
      entry,
      entry.section._tag === "custom" ? context.sectionTitle(entry.section.sectionId) : undefined,
    );

  ops.forEach((op, index) => {
    const path = `ops[${index}]`;
    const find = (key: string) => {
      const at = entries.findIndex((entry) => entry.key === key);
      if (at < 0)
        issues.push({ path: `${path}.key`, code: "shape", detail: `no layout entry ${key}` });
      return at;
    };
    const update = (key: string, change: (entry: ViewLayoutEntry) => ViewLayoutEntry) => {
      const at = find(key);
      const entry = entries[at];
      if (entry === undefined) return undefined;
      const next = change(entry);
      entries = entries.map((other, position) => (position === at ? next : other));
      return next;
    };
    switch (op._tag) {
      case "hide": {
        const entry = update(op.key, (e) => ({ ...e, hidden: true }));
        if (entry !== undefined) changes.push(`hid ${titleOf(entry)}`);
        return;
      }
      case "show": {
        const entry = update(op.key, (e) => ({ ...e, hidden: false }));
        if (entry !== undefined) changes.push(`showed ${titleOf(entry)}`);
        return;
      }
      case "rename": {
        const before = entries.find((e) => e.key === op.key);
        const entry = update(op.key, (e) => ({ ...e, title: op.title }));
        if (entry !== undefined && before !== undefined) {
          changes.push(
            op.title === null
              ? `reset the title of ${titleOf(before)}`
              : `renamed ${titleOf(before)} to ${op.title}`,
          );
        }
        return;
      }
      case "replace": {
        const before = entries.find((e) => e.key === op.key);
        const entry = update(op.key, (e) => ({ ...e, section: op.section }));
        if (entry !== undefined && before !== undefined) {
          changes.push(`replaced ${titleOf(before)} with ${titleOf(entry)}`);
        }
        return;
      }
      case "move": {
        const at = find(op.key);
        const entry = entries[at];
        if (entry === undefined) return;
        const region: ViewRegion = op.region ?? entry.region;
        const moved = { ...entry, region };
        entries = insertInRegion(
          entries.filter((_, position) => position !== at),
          moved,
          op.index,
        );
        changes.push(`moved ${titleOf(entry)}${region === entry.region ? "" : ` to ${region}`}`);
        return;
      }
      case "remove": {
        const at = find(op.key);
        const entry = entries[at];
        if (entry === undefined) return;
        entries = entries.filter((_, position) => position !== at);
        changes.push(`removed ${titleOf(entry)}`);
        return;
      }
      case "add": {
        if (entries.some((entry) => entry.key === op.entry.key)) {
          issues.push({
            path: `${path}.entry.key`,
            code: "duplicate",
            detail: `layout key ${op.entry.key} is taken`,
          });
          return;
        }
        entries = insertInRegion(entries, op.entry, op.index);
        changes.push(`added ${titleOf(op.entry)}`);
        return;
      }
      case "limits":
        limits = op.limits;
        changes.push(
          `set limits to ${op.limits.templates} templates, ${op.limits.sections} sections, ${op.limits.changesPerDay} changes a day`,
        );
        return;
      case "set":
        entries = [...op.layout.entries];
        limits = op.layout.limits;
        changes.push("rebuilt the layout");
        return;
      case "reset":
        if (context.starter === null) {
          issues.push({ path, code: "shape", detail: "reset applies to mission layouts" });
          return;
        }
        // The mission's own sections stay on the board.
        entries = [
          ...context.starter.entries,
          ...entries.filter((entry) => entry.section._tag === "custom"),
        ];
        limits = context.starter.limits;
        changes.push("reset to the starter layout");
        return;
    }
  });

  return { layout: { entries, limits }, issues, changes };
};
