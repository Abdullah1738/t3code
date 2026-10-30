import { Columns2Icon } from "lucide-react";

import {
  BOARD_COLUMN_LABELS,
  BOARD_COLUMNS,
  showAllColumns,
  resetColumnWidths,
  toggleColumn,
  type BoardColumnKey,
} from "@t3tools/client-runtime/ardud/kanban";

import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../../components/ui/menu";
import { cn } from "../../lib/utils";
import { useBoardColumnPrefs } from "./useBoardColumnPrefs";

/** Show or hide each stage column, plus Show all and Reset widths. Stage grouping only. */
export function BoardColumnsMenu(props: { boardId: string }) {
  const [prefs, updatePrefs] = useBoardColumnPrefs(props.boardId);
  const anyHidden = prefs.hidden.length > 0;
  const anyResized = Object.keys(prefs.widths).length > 0 || prefs.groupWidth !== null;

  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            aria-label="Columns"
            className={cn(
              "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent) pointer-coarse:h-11 pointer-coarse:text-base",
              anyHidden
                ? "bg-(--m-text) text-(--m-ground)"
                : "bg-(--m-chip) text-(--m-text) hover:bg-(--m-active)",
            )}
          />
        }
      >
        <Columns2Icon className="size-3.5 shrink-0" aria-hidden />
        <span className="max-md:sr-only">Columns</span>
      </MenuTrigger>
      <MenuPopup align="start" side="bottom">
        {BOARD_COLUMNS.map((key: BoardColumnKey) => (
          <MenuCheckboxItem
            key={key}
            // Stays open so several columns can be toggled in one go.
            closeOnClick={false}
            checked={!prefs.hidden.includes(key)}
            onCheckedChange={() => updatePrefs((current) => toggleColumn(current, key))}
          >
            {BOARD_COLUMN_LABELS[key]}
          </MenuCheckboxItem>
        ))}
        <MenuSeparator />
        <MenuItem disabled={!anyHidden} onClick={() => updatePrefs(showAllColumns)}>
          Show all
        </MenuItem>
        <MenuItem disabled={!anyResized} onClick={() => updatePrefs(resetColumnWidths)}>
          Reset widths
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
