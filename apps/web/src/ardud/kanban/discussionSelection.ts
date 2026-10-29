import type { ContextMenuItem } from "@t3tools/contracts";
import type { DiscussionRow } from "@t3tools/client-runtime/ardud/kanban";

export interface DiscussionSelection {
  readonly ids: ReadonlySet<string>;
  readonly anchor: string | null;
}

export const EMPTY_DISCUSSION_SELECTION: DiscussionSelection = { ids: new Set(), anchor: null };

/** Cmd/Ctrl-click: adds or removes one; an added one becomes the anchor. */
export function toggleDiscussion(selection: DiscussionSelection, id: string): DiscussionSelection {
  const ids = new Set(selection.ids);
  if (ids.has(id)) {
    ids.delete(id);
    return { ids, anchor: selection.anchor };
  }
  ids.add(id);
  return { ids, anchor: id };
}

/**
 * Shift-click: adds anchor..id (inclusive) in `order`; the anchor stays.
 * Falls back to the open discussion as anchor.
 */
export function selectDiscussionRange(
  selection: DiscussionSelection,
  id: string,
  order: ReadonlyArray<string>,
  openId: string | null,
): DiscussionSelection {
  const anchor = selection.anchor ?? openId;
  const from = anchor === null ? -1 : order.indexOf(anchor);
  const to = order.indexOf(id);
  const ids = new Set(selection.ids);
  if (from === -1 || to === -1) {
    ids.add(id);
    return { ids, anchor: id };
  }
  const [start, end] = from < to ? [from, to] : [to, from];
  for (let index = start; index <= end; index += 1) {
    ids.add(order[index]!);
  }
  return { ids, anchor };
}

export type BulkDiscussionAction = "mark-read" | "settle" | "unsettle";

/** The bulk right-click menu; items with nothing to act on are left out. */
export function bulkDiscussionMenu(
  rows: ReadonlyArray<Pick<DiscussionRow, "unread" | "settledAt">>,
  can: { readonly read: boolean; readonly update: boolean },
): ContextMenuItem<BulkDiscussionAction>[] {
  const unread = rows.filter((row) => row.unread > 0).length;
  const unsettled = rows.filter((row) => row.settledAt === null).length;
  const settled = rows.length - unsettled;
  const items: ContextMenuItem<BulkDiscussionAction>[] = [];
  if (unread > 0) {
    items.push({
      id: "mark-read",
      label: `Mark read (${unread})`,
      disabled: !can.read,
    });
  }
  if (unsettled > 0) {
    items.push({ id: "settle", label: `Settle (${unsettled})`, disabled: !can.update });
  }
  if (settled > 0) {
    items.push({ id: "unsettle", label: `Unsettle (${settled})`, disabled: !can.update });
  }
  return items;
}

/** Which selected ids an action applies to. */
export function bulkDiscussionTargets(
  rows: ReadonlyArray<Pick<DiscussionRow, "id" | "unread" | "settledAt">>,
  action: BulkDiscussionAction,
): string[] {
  return rows
    .filter((row) => {
      if (action === "mark-read") return row.unread > 0;
      if (action === "settle") return row.settledAt === null;
      return row.settledAt !== null;
    })
    .map((row) => row.id);
}
