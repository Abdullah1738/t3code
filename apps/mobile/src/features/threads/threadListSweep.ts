import { resolveThreadListV2SwipeActions, type ThreadListV2ThreadListItem } from "./threadListV2";

/** Row actions a pointer can drag across neighbouring rows, as on web. */
export type ThreadListSweepAction = "settle" | "unsettle" | "unsnooze";

/** Points a pressed row action must travel before it becomes a sweep. */
export const THREAD_LIST_SWEEP_DRAG_DISTANCE = 6;

/** The row's hover action: its lifecycle swipe action, when the server supports it. */
export function threadListSweepActionFor(input: {
  readonly variant: "card" | "slim";
  readonly snoozed: boolean;
  readonly settlementSupported: boolean;
  readonly snoozeSupported: boolean;
}): ThreadListSweepAction | null {
  const { primary } = resolveThreadListV2SwipeActions({ ...input, snoozable: false });
  if (primary === "archive") return null;
  if (primary === "unsnooze" && !input.snoozeSupported) return null;
  return primary;
}

export function isThreadListSweepRow(item: {
  readonly type: string;
}): item is ThreadListV2ThreadListItem {
  return item.type === "v2-thread";
}

/**
 * The section of the thread row at `index`: the shelf it sits under, split
 * into pinned and unpinned rows. Null when `index` is not a thread row.
 */
export function threadListSweepSection(
  items: ReadonlyArray<{ readonly type: string }>,
  index: number,
): string | null {
  const row = items[index];
  if (row === undefined || !isThreadListSweepRow(row)) return null;
  let shelf = "active";
  for (let previous = index - 1; previous >= 0; previous -= 1) {
    const item = items[previous];
    if (item !== undefined && !isThreadListSweepRow(item)) {
      shelf = item.type;
      break;
    }
  }
  return `${shelf}:${row.item.pinned ? "pinned" : "unpinned"}`;
}

function sameSection(a: ThreadListV2ThreadListItem, b: ThreadListV2ThreadListItem): boolean {
  return (
    a.item.pinned === b.item.pinned &&
    a.item.snoozed === b.item.snoozed &&
    a.item.variant === b.item.variant
  );
}

/**
 * Thread rows a sweep from `originKey` to `targetKey` applies to. The sweep
 * stays in the section the origin started in, so overshooting into a
 * neighbouring section (across a shelf header, or from pinned into active)
 * never changes it, and nothing applies once the origin itself moves.
 */
export function resolveThreadListSweepItems(
  items: ReadonlyArray<{ readonly type: string; readonly key: string }>,
  sweep: {
    readonly originKey: string;
    readonly originSection: string;
    readonly targetKey: string;
  },
  canApply: (item: ThreadListV2ThreadListItem) => boolean,
): ThreadListV2ThreadListItem[] {
  const originIndex = items.findIndex((item) => item.key === sweep.originKey);
  const targetIndex = items.findIndex((item) => item.key === sweep.targetKey);
  const origin = items[originIndex];
  if (
    origin === undefined ||
    targetIndex === -1 ||
    !isThreadListSweepRow(origin) ||
    threadListSweepSection(items, originIndex) !== sweep.originSection
  ) {
    return [];
  }
  const step = targetIndex < originIndex ? -1 : 1;
  const swept: ThreadListV2ThreadListItem[] = [];
  for (let index = originIndex; ; index += step) {
    const item = items[index];
    if (item === undefined || !isThreadListSweepRow(item) || !sameSection(origin, item)) break;
    if (canApply(item)) {
      if (step === 1) swept.push(item);
      else swept.unshift(item);
    }
    if (index === targetIndex) break;
  }
  return swept;
}

/**
 * Row under a pointer at content offset `y`. Rows are in list order; a gap or
 * header resolves to the row above it, and a point above the first row
 * resolves to the first row.
 */
export function threadListSweepTargetKey(
  rows: ReadonlyArray<{ readonly key: string; readonly top: number }>,
  y: number,
): string | null {
  let key: string | null = null;
  for (const row of rows) {
    if (key !== null && row.top > y) break;
    key = row.key;
  }
  return key;
}
