import { ASK_SHORTCUTS } from "@t3tools/client-runtime/ardud/kanban";

import { Key, Layer } from "./ui";

export function ShortcutsSheet(props: { open: boolean; onClose: () => void }) {
  return (
    <Layer open={props.open} onClose={props.onClose} title="Keyboard shortcuts" side="center">
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
