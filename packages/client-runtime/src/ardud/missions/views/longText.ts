import type { ViewLongText, ViewLongTextInput } from "@t3tools/contracts";

// Long row values (a report's text) never ride the views snapshot. A block
// asks for one when it shows, which is when its collapsible opens. Reports
// don't change once written, so a loaded text is kept for the next open; only
// the last few stay, since a daily report runs past 100k characters. Script
// rows key on their run, so a kept text never outlives the run it came from.
// A value on screen is held, so it never drops out while shown, however many
// are open; only values nobody shows count against the limit.

export type ViewLongTextState =
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly value: ViewLongText }
  | { readonly status: "failed"; readonly error: unknown };

/** A small store for `useSyncExternalStore`: states keep their identity until they change. */
export interface ViewLongTexts {
  readonly get: (key: string) => ViewLongTextState | undefined;
  readonly subscribe: (listener: () => void) => () => void;
  /** Loads a value not loaded or loading yet; `retry` also reloads a failed one. */
  readonly request: (input: ViewLongTextRequest, options?: { readonly retry?: boolean }) => void;
  /** Requests a value and keeps it while shown; call the result when it is not. */
  readonly hold: (input: ViewLongTextRequest) => () => void;
}

/**
 * A value to load. Script rows change with every run, so they carry the run's
 * time (client-only, never sent) and a new run loads afresh.
 */
export interface ViewLongTextRequest extends ViewLongTextInput {
  readonly revision?: string | null;
}

/** One string per value, stable across snapshots that rebuild the input. */
export const viewLongTextKey = (input: ViewLongTextRequest): string =>
  [
    input.missionId,
    input.ref.kind,
    input.ref.id,
    input.path,
    input.sourceId ?? "",
    input.revision ?? "",
  ].join("\u0000");

const wireInput = ({ revision: _revision, ...input }: ViewLongTextRequest): ViewLongTextInput =>
  input;

const LOADING: ViewLongTextState = { status: "loading" };

export function createViewLongTexts(
  fetch: (input: ViewLongTextInput) => Promise<ViewLongText>,
  keep = 12,
): ViewLongTexts {
  const states = new Map<string, ViewLongTextState>();
  const held = new Map<string, number>();
  const listeners = new Set<() => void>();
  const set = (key: string, state: ViewLongTextState) => {
    states.delete(key);
    states.set(key, state);
    let spare = [...states.keys()].filter((kept) => !held.has(kept)).length - keep;
    for (const [oldest, kept] of states) {
      if (spare <= 0) break;
      if (kept.status === "loading" || held.has(oldest)) continue;
      states.delete(oldest);
      spare -= 1;
    }
    for (const listener of listeners) listener();
  };
  const request: ViewLongTexts["request"] = (input, options) => {
    const key = viewLongTextKey(input);
    const state = states.get(key);
    if (state !== undefined && !(options?.retry === true && state.status === "failed")) return;
    set(key, LOADING);
    fetch(wireInput(input)).then(
      (value) => set(key, { status: "loaded", value }),
      (error: unknown) => set(key, { status: "failed", error }),
    );
  };
  return {
    get: (key) => states.get(key),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    request,
    hold: (input) => {
      const key = viewLongTextKey(input);
      held.set(key, (held.get(key) ?? 0) + 1);
      request(input);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const count = (held.get(key) ?? 1) - 1;
        if (count > 0) held.set(key, count);
        else held.delete(key);
      };
    },
  };
}
