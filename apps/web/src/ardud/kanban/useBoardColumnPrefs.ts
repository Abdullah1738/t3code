import * as Schema from "effect/Schema";
import { useCallback, useMemo } from "react";

import {
  sanitizeBoardColumnPrefs,
  type BoardColumnPrefs,
} from "@t3tools/client-runtime/ardud/kanban";

import { useLocalStorage } from "../../hooks/useLocalStorage";

// Stored loosely; sanitizeBoardColumnPrefs decides what survives.
const StoredPrefs = Schema.Unknown;

export const boardColumnsStorageKey = (boardId: string) =>
  `t3code:ardud-boards:columns:${boardId}`;

const EMPTY: BoardColumnPrefs = { widths: {}, hidden: [], groupWidth: null };

/** Per-board column prefs in localStorage, sanitized on every read. */
export function useBoardColumnPrefs(boardId: string) {
  const [stored, setStored] = useLocalStorage(boardColumnsStorageKey(boardId), EMPTY, StoredPrefs);
  const prefs = useMemo(() => sanitizeBoardColumnPrefs(stored), [stored]);
  const update = useCallback(
    (next: (prefs: BoardColumnPrefs) => BoardColumnPrefs) => {
      setStored((current: unknown) => sanitizeBoardColumnPrefs(next(sanitizeBoardColumnPrefs(current))));
    },
    [setStored],
  );
  return [prefs, update] as const;
}
