import type { ViewLongText, ViewLongTextInput } from "@t3tools/contracts";

// Long row values (a report's text) never ride the views snapshot. A block
// asks for one when it shows, which is when its collapsible opens. Reports
// don't change once written, so a loaded text is kept for the next open; only
// the last few stay, since a daily report runs past 100k characters.

export type ViewLongTextState =
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly value: ViewLongText }
  | { readonly status: "failed"; readonly error: unknown };

/** A small store for `useSyncExternalStore`: states keep their identity until they change. */
export interface ViewLongTexts {
  readonly get: (key: string) => ViewLongTextState | undefined;
  readonly subscribe: (listener: () => void) => () => void;
  /** Loads a value not loaded or loading yet; `retry` also reloads a failed one. */
  readonly request: (input: ViewLongTextInput, options?: { readonly retry?: boolean }) => void;
}

/** One string per value, stable across snapshots that rebuild the input. */
export const viewLongTextKey = (input: ViewLongTextInput): string =>
  [input.missionId, input.ref.kind, input.ref.id, input.path].join("\u0000");

const LOADING: ViewLongTextState = { status: "loading" };

export function createViewLongTexts(
  fetch: (input: ViewLongTextInput) => Promise<ViewLongText>,
  keep = 12,
): ViewLongTexts {
  const states = new Map<string, ViewLongTextState>();
  const listeners = new Set<() => void>();
  const set = (key: string, state: ViewLongTextState) => {
    states.delete(key);
    states.set(key, state);
    for (const oldest of states.keys()) {
      if (states.size <= keep) break;
      if (states.get(oldest)?.status !== "loading") states.delete(oldest);
    }
    for (const listener of listeners) listener();
  };
  return {
    get: (key) => states.get(key),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    request: (input, options) => {
      const key = viewLongTextKey(input);
      const state = states.get(key);
      if (state !== undefined && !(options?.retry === true && state.status === "failed")) return;
      set(key, LOADING);
      fetch(input).then(
        (value) => set(key, { status: "loaded", value }),
        (error: unknown) => set(key, { status: "failed", error }),
      );
    },
  };
}
