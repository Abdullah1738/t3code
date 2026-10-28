import type { KanbanBoardState } from "./boardState.ts";
import { type BoardFilter, modelName, type SettledFilter, visibleCards } from "./viewModel.ts";

export const PRIORITY_LABELS = ["Urgent", "High", "Normal", "Low", "Backlog"] as const;

export function priorityLabel(priority: number): string {
  return PRIORITY_LABELS[priority - 1] ?? "Normal";
}

export type FilterFacet = "priorities" | "goalIds" | "projects" | "models";

export const FILTER_FACETS: ReadonlyArray<FilterFacet> = [
  "priorities",
  "goalIds",
  "projects",
  "models",
];

/** Per-board filter choices. An empty facet means "no narrowing". */
export interface BoardFilterPrefs {
  readonly priorities: ReadonlyArray<number>;
  /** Goal ids; "" means "No goal". */
  readonly goalIds: ReadonlyArray<string>;
  /** Project names; "" means "No project". */
  readonly projects: ReadonlyArray<string>;
  /** Model names from modelName(); "" means "No model". */
  readonly models: ReadonlyArray<string>;
  readonly settled: SettledFilter;
}

export const EMPTY_FILTER_PREFS: BoardFilterPrefs = {
  priorities: [],
  goalIds: [],
  projects: [],
  models: [],
  settled: "hide",
};

const SETTLED_VALUES: ReadonlyArray<SettledFilter> = ["hide", "only", "include"];

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? [...new Set(value.filter((item) => typeof item === "string"))] : [];

/** Drops values that don't fit: a bad settled falls back to "hide". */
export function sanitizeBoardFilterPrefs(value: unknown): BoardFilterPrefs {
  if (typeof value !== "object" || value === null) return EMPTY_FILTER_PREFS;
  const raw = value as Record<string, unknown>;
  const priorities = Array.isArray(raw.priorities)
    ? [
        ...new Set(
          raw.priorities.filter(
            (item): item is number =>
              typeof item === "number" && Number.isInteger(item) && item >= 1 && item <= 5,
          ),
        ),
      ]
    : [];
  return {
    priorities,
    goalIds: stringList(raw.goalIds),
    projects: stringList(raw.projects),
    models: stringList(raw.models),
    settled: SETTLED_VALUES.find((option) => option === raw.settled) ?? "hide",
  };
}

/** Adds the value to its facet, or removes it when already picked. */
export function toggleFilterValue(
  prefs: BoardFilterPrefs,
  facet: FilterFacet,
  value: number | string,
): BoardFilterPrefs {
  const list: ReadonlyArray<number | string> = prefs[facet];
  const next = list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
  return { ...prefs, [facet]: next };
}

/** Resets every facet and keeps the settled choice. */
export function clearFilters(prefs: BoardFilterPrefs): BoardFilterPrefs {
  return { ...EMPTY_FILTER_PREFS, settled: prefs.settled };
}

export function activeFilterCount(prefs: BoardFilterPrefs): number {
  return FILTER_FACETS.reduce((total, facet) => total + prefs[facet].length, 0);
}

export interface FilterOption {
  readonly value: string;
  readonly label: string;
  readonly count: number;
}

export interface FilterFacetView {
  readonly facet: FilterFacet;
  readonly label: string;
  readonly options: ReadonlyArray<FilterOption>;
}

const byName = ([a]: [string, number], [b]: [string, number]) => a.localeCompare(b);

/**
 * The facets a board offers, counted over the cards visible under `settled`
 * alone, so each count is what picking that value would show before the
 * other facets narrow it. A facet with no options is left out.
 */
export function filterFacets(state: KanbanBoardState, settled: SettledFilter): FilterFacetView[] {
  const cards = visibleCards(state, { settled });

  const priorities: FilterOption[] = [1, 2, 3, 4, 5].map((priority) => ({
    value: String(priority),
    label: priorityLabel(priority),
    count: cards.filter((card) => card.priority === priority).length,
  }));

  const goalCounts = new Map<string, number>();
  let noGoal = 0;
  for (const card of cards) {
    if (card.goalId === null) noGoal += 1;
    else goalCounts.set(card.goalId, (goalCounts.get(card.goalId) ?? 0) + 1);
  }
  const goals: FilterOption[] = [...state.goals.values()]
    .filter((goal) => goal.status === "active")
    .map((goal) => ({ value: goal.id, label: goal.name, count: goalCounts.get(goal.id) ?? 0 }));
  if (goals.length > 0) goals.push({ value: "", label: "No goal", count: noGoal });

  const projectCounts = new Map<string, number>();
  let noProject = 0;
  for (const card of cards) {
    if (card.projects.length === 0) noProject += 1;
    for (const project of card.projects) {
      projectCounts.set(project, (projectCounts.get(project) ?? 0) + 1);
    }
  }
  const projects: FilterOption[] = [...projectCounts]
    .sort(byName)
    .map(([name, count]) => ({ value: name, label: name, count }));
  // Kept at count 0 too: if the last unassigned card gets a project, a saved
  // "No project" pick must still match something instead of silently clearing.
  if (projects.length > 0) {
    projects.push({ value: "", label: "No project", count: noProject });
  }

  const modelCounts = new Map<string, number>();
  let noModel = 0;
  for (const card of cards) {
    const name = modelName(card.model);
    if (name === "") noModel += 1;
    else modelCounts.set(name, (modelCounts.get(name) ?? 0) + 1);
  }
  const models: FilterOption[] = [...modelCounts]
    .sort(byName)
    .map(([name, count]) => ({ value: name, label: name, count }));
  if (models.length > 0 && noModel > 0) {
    models.push({ value: "", label: "No model", count: noModel });
  }

  const facets: FilterFacetView[] = [
    { facet: "priorities", label: "Priority", options: priorities },
    { facet: "goalIds", label: "Goal", options: goals },
    { facet: "projects", label: "Project", options: projects },
    { facet: "models", label: "Model", options: models },
  ];
  return facets.filter((view) => view.options.length > 0);
}

/**
 * The BoardFilter for the saved prefs. A selected value that is no longer an
 * option (a finished goal, a project nobody uses) is dropped, so a stale pick
 * can't hide every card.
 */
export function boardFilter(
  state: KanbanBoardState,
  prefs: BoardFilterPrefs,
  query: string,
): BoardFilter {
  const options = new Map(
    filterFacets(state, prefs.settled).map((view) => [
      view.facet,
      new Set(view.options.map((option) => option.value)),
    ]),
  );
  const keep = <T extends string | number>(facet: FilterFacet, values: ReadonlyArray<T>) => {
    const allowed = options.get(facet);
    return values.filter((value) => allowed?.has(String(value)) === true);
  };
  return {
    priorities: keep("priorities", prefs.priorities),
    goalIds: keep("goalIds", prefs.goalIds),
    projects: keep("projects", prefs.projects),
    models: keep("models", prefs.models),
    query,
    settled: prefs.settled,
  };
}
