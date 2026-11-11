import type { GroupBy } from "@t3tools/client-runtime/ardud/kanban";

export const BOARD_VIEWS = [
  "board",
  "goals",
  "discussions",
  "automations",
  "scripts",
  "wiki",
  "threads",
  "settings",
] as const;
export type BoardView = (typeof BOARD_VIEWS)[number];

export const BOARD_VIEW_LABELS: Record<BoardView, string> = {
  board: "Board",
  goals: "Goals",
  discussions: "Discussions",
  automations: "Automations",
  scripts: "Scripts",
  wiki: "Wiki",
  threads: "Threads",
  settings: "Settings",
};

const GROUPS: ReadonlyArray<GroupBy> = ["stage", "goal", "similar", "project", "model"];
const LENSES = ["stuck"] as const;

export interface BoardSearch {
  readonly view?: BoardView;
  /** Card open in the drawer. */
  readonly card?: string;
  readonly discussion?: string;
  /** Goal page under the Goals view. */
  readonly goal?: string;
  readonly group?: GroupBy;
  /** "stuck" shows only the cards that need a look. */
  readonly lens?: (typeof LENSES)[number];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function oneOf<T extends string>(value: unknown, options: ReadonlyArray<T>): T | undefined {
  return typeof value === "string" && (options as ReadonlyArray<string>).includes(value)
    ? (value as T)
    : undefined;
}

export function parseBoardSearch(raw: Record<string, unknown>): BoardSearch {
  const view = oneOf(raw.view, BOARD_VIEWS);
  const card = text(raw.card);
  const discussion = text(raw.discussion);
  const goal = text(raw.goal);
  const group = oneOf(raw.group, GROUPS);
  const lens = oneOf(raw.lens, LENSES);
  return {
    ...(view && view !== "board" ? { view } : {}),
    ...(card ? { card } : {}),
    ...(discussion ? { discussion } : {}),
    ...(goal ? { goal } : {}),
    ...(group && group !== "stage" ? { group } : {}),
    ...(lens ? { lens } : {}),
  };
}
