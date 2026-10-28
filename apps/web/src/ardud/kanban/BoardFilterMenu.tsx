import { ListFilterIcon } from "lucide-react";

import {
  activeFilterCount,
  clearFilters,
  filterFacets,
  toggleFilterValue,
  type BoardFilterPrefs,
  type FilterFacet,
  type KanbanBoardState,
} from "@t3tools/client-runtime/ardud/kanban";

import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../../components/ui/menu";
import { cn } from "../../lib/utils";

/** Priorities are stored as numbers; every other facet keeps its string value. */
function facetValue(facet: FilterFacet, value: string): number | string {
  return facet === "priorities" ? Number(value) : value;
}

function isPicked(prefs: BoardFilterPrefs, facet: FilterFacet, value: string): boolean {
  const picked: ReadonlyArray<number | string> = prefs[facet];
  return picked.includes(facetValue(facet, value));
}

/**
 * The Filter control: priority, goal, project and model, several values per
 * facet. The menu stays open while values toggle. Settled has its own menu.
 */
export function BoardFilterMenu(props: {
  readonly state: KanbanBoardState;
  readonly prefs: BoardFilterPrefs;
  readonly narrow: boolean;
  readonly onChange: (prefs: BoardFilterPrefs) => void;
}) {
  const { state, prefs, onChange } = props;
  const count = activeFilterCount(prefs);
  const facets = filterFacets(state, prefs.settled);
  const label = count > 0 ? `Filter · ${count}` : "Filter";

  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            aria-label={label}
            className={cn(
              "inline-flex h-8 max-w-48 shrink-0 items-center gap-1.5 rounded-full px-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)",
              count > 0
                ? "bg-(--m-text) text-(--m-ground)"
                : "bg-(--m-chip) text-(--m-text) hover:bg-(--m-active)",
            )}
          />
        }
      >
        <ListFilterIcon className="size-3.5 shrink-0" aria-hidden />
        <span className={cn("truncate", props.narrow ? "sr-only" : "")}>{label}</span>
      </MenuTrigger>
      <MenuPopup align="start" side="bottom" className="max-h-[70vh] overflow-y-auto">
        {facets.map((view) => (
          <MenuGroup key={view.facet}>
            <MenuGroupLabel>{view.label}</MenuGroupLabel>
            {view.options.map((option) => (
              <MenuCheckboxItem
                key={`${view.facet}:${option.value}`}
                checked={isPicked(prefs, view.facet, option.value)}
                onCheckedChange={() =>
                  onChange(toggleFilterValue(prefs, view.facet, facetValue(view.facet, option.value)))
                }
                closeOnClick={false}
              >
                <span className="flex-1 truncate">{option.label}</span>
                <span className="ms-4 text-xs text-(--m-muted) tabular-nums">{option.count}</span>
              </MenuCheckboxItem>
            ))}
          </MenuGroup>
        ))}
        {count > 0 ? (
          <>
            <MenuSeparator />
            <MenuItem onClick={() => onChange(clearFilters(prefs))}>Clear filters</MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
