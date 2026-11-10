import { ASK_SHORTCUTS } from "@t3tools/client-runtime/ardud/kanban";

import { cn } from "../../../lib/utils";
import { setSingleKeys, useSingleKeys } from "./keysPref";
import { Key, Layer } from "./ui";

export function ShortcutsSheet(props: { open: boolean; onClose: () => void }) {
  const singleKeys = useSingleKeys((state) => state.on);
  return (
    <Layer open={props.open} onClose={props.onClose} title="Keyboard shortcuts" side="center">
      <button
        type="button"
        role="switch"
        aria-checked={singleKeys}
        onClick={() => setSingleKeys(!singleKeys)}
        className="mb-4 flex w-full min-w-0 items-center gap-3 rounded-lg py-1 text-start text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent) pointer-coarse:min-h-11"
      >
        <span
          aria-hidden
          className={cn(
            "flex h-5.5 w-9.5 shrink-0 items-center rounded-full p-0.5 transition-colors duration-150",
            singleKeys ? "bg-(--m-accent)" : "bg-(--m-bar-2)",
          )}
        >
          <span
            className={cn(
              "size-4.5 rounded-full bg-(--m-ground) transition-transform duration-150",
              singleKeys && "translate-x-4",
            )}
          />
        </span>
        <span className="font-medium">One-letter shortcuts</span>
        <span className="text-(--m-muted)">
          {singleKeys ? "On" : "Off. Arrows and Enter still work."}
        </span>
      </button>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-5 gap-y-2.5 text-sm">
        {ASK_SHORTCUTS.map((shortcut) => (
          <div key={shortcut.does} className="contents">
            <dt className="flex items-center gap-1">
              {shortcut.keys.map((key, index) => (
                <span key={key} className="flex items-center gap-1">
                  {index > 0 && shortcut.range ? (
                    <span className="text-(--m-muted)">to</span>
                  ) : null}
                  <Key className="pointer-coarse:inline-grid">{key}</Key>
                </span>
              ))}
            </dt>
            <dd>{shortcut.does}</dd>
          </div>
        ))}
      </dl>
    </Layer>
  );
}
