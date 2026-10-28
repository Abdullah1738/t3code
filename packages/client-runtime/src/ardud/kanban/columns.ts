import { STAGE_LABELS } from "./viewModel.ts";

/** Stage columns on the board, in display order: active stages, shipped, then Needs Owner. */
export const BOARD_COLUMNS = [
  "todo",
  "working",
  "needs_review",
  "in_review",
  "shipped",
  "needs_owner",
] as const;

export type BoardColumnKey = (typeof BOARD_COLUMNS)[number];

export const BOARD_COLUMN_LABELS: Record<BoardColumnKey, string> = {
  todo: STAGE_LABELS.todo,
  working: STAGE_LABELS.working,
  needs_review: STAGE_LABELS.needs_review,
  in_review: STAGE_LABELS.in_review,
  shipped: "Shipped",
  needs_owner: STAGE_LABELS.needs_owner,
};

export interface BoardColumnPrefs {
  /** Saved px widths. A column with no entry keeps its default sizing. */
  readonly widths: Partial<Record<BoardColumnKey, number>>;
  readonly hidden: ReadonlyArray<BoardColumnKey>;
  /** One shared width for every column in a non-stage grouping; null is the default. */
  readonly groupWidth: number | null;
}

export const DEFAULT_GROUP_COLUMN_WIDTH = 256;

export const EMPTY_BOARD_COLUMN_PREFS: BoardColumnPrefs = {
  widths: {},
  hidden: [],
  groupWidth: null,
};

const COLUMN_WIDTH_RANGE: Record<BoardColumnKey, readonly [number, number]> = {
  todo: [140, 560],
  working: [140, 560],
  needs_review: [140, 560],
  in_review: [140, 560],
  shipped: [140, 560],
  needs_owner: [200, 560],
};

export const GROUP_COLUMN_WIDTH_RANGE = [180, 560] as const;

const isColumnKey = (value: unknown): value is BoardColumnKey =>
  typeof value === "string" && (BOARD_COLUMNS as ReadonlyArray<string>).includes(value);

const inRange = (value: unknown, [min, max]: readonly [number, number]): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;

/** Clamps a stage or shipped column to its range. */
export function clampColumnWidth(key: BoardColumnKey, px: number): number {
  const [min, max] = COLUMN_WIDTH_RANGE[key];
  if (!Number.isFinite(px)) return min;
  return Math.min(max, Math.max(min, px));
}

export function clampGroupWidth(px: number): number {
  const [min, max] = GROUP_COLUMN_WIDTH_RANGE;
  if (!Number.isFinite(px)) return DEFAULT_GROUP_COLUMN_WIDTH;
  return Math.min(max, Math.max(min, px));
}

/**
 * Keeps only what the board understands. Anything malformed falls back
 * to the default rather than throwing, so a bad stored value can't break the board.
 */
export function sanitizeBoardColumnPrefs(value: unknown): BoardColumnPrefs {
  if (typeof value !== "object" || value === null) return EMPTY_BOARD_COLUMN_PREFS;
  const raw = value as Record<string, unknown>;

  const widths: Partial<Record<BoardColumnKey, number>> = {};
  if (typeof raw.widths === "object" && raw.widths !== null) {
    for (const [key, width] of Object.entries(raw.widths as Record<string, unknown>)) {
      if (!isColumnKey(key)) continue;
      const range = COLUMN_WIDTH_RANGE[key];
      if (!inRange(width, range)) continue;
      widths[key] = width;
    }
  }

  const hidden: BoardColumnKey[] = [];
  if (Array.isArray(raw.hidden)) {
    for (const key of raw.hidden) {
      if (isColumnKey(key) && !hidden.includes(key)) hidden.push(key);
    }
  }

  const groupWidth = inRange(raw.groupWidth, GROUP_COLUMN_WIDTH_RANGE) ? raw.groupWidth : null;

  return { widths, hidden, groupWidth };
}

export function toggleColumn(prefs: BoardColumnPrefs, key: BoardColumnKey): BoardColumnPrefs {
  const hidden = prefs.hidden.includes(key)
    ? prefs.hidden.filter((entry) => entry !== key)
    : [...prefs.hidden, key];
  return { ...prefs, hidden };
}

/** Resets saved widths. Hidden columns stay hidden, since that is a separate choice. */
export function resetColumnWidths(prefs: BoardColumnPrefs): BoardColumnPrefs {
  return { ...prefs, widths: {}, groupWidth: null };
}

export function showAllColumns(prefs: BoardColumnPrefs): BoardColumnPrefs {
  return { ...prefs, hidden: [] };
}
