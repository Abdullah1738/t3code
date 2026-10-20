// @effect-diagnostics globalDate:off - Load times render on the reader's clock and zone.
import type { Listener, Unsubscribe } from "./source.ts";
import { formatDayLabel, formatTimeOfDay } from "./viewModel.ts";

/**
 * Latest-value cache over one source subscription, shaped for React's
 * `useSyncExternalStore` (and any other client). The source subscription opens
 * with the first reader and closes with the last, so a screen pays for exactly
 * one subscription however many rows read it.
 */
export interface SnapshotStore<T> {
  readonly get: () => T | undefined;
  readonly subscribe: (onChange: () => void) => Unsubscribe;
  /** Set when the read failed; the feed stays closed until `retry`. */
  readonly failure: () => FeedFailure | undefined;
  /** Clears the failure and opens the feed again. */
  readonly retry: () => void;
}

export interface FeedFailure {
  readonly error: unknown;
  /** When the last value arrived (epoch ms); null when nothing ever loaded. */
  readonly lastLoadedAt: number | null;
}

/**
 * The Desk error line for a block whose read failed: "Couldn't load the
 * inbox." then when it last loaded, in the reader's zone (the day too when it
 * was not today). `detail` is null when nothing ever loaded.
 */
export function feedFailureLines(
  what: string,
  failure: Pick<FeedFailure, "lastLoadedAt">,
  nowMs: number,
  timeZone?: string,
): { readonly title: string; readonly detail: string | null } {
  const title = `Couldn't load ${what}.`;
  if (failure.lastLoadedAt === null) return { title, detail: null };
  const at = new Date(failure.lastLoadedAt).toISOString();
  const day = formatDayLabel(at, timeZone);
  const today = formatDayLabel(new Date(nowMs).toISOString(), timeZone);
  const time = formatTimeOfDay(at, timeZone);
  return { title, detail: `Last loaded at ${day === today ? time : `${day} ${time}`}.` };
}

export type SnapshotOpen<T> = (emit: Listener<T>, fail: Listener<unknown>) => Unsubscribe;

export function createSnapshotStore<T>(
  open: SnapshotOpen<T>,
  now: () => number = Date.now,
): SnapshotStore<T> {
  let value: T | undefined;
  let close: Unsubscribe | null = null;
  let failure: FeedFailure | undefined;
  let lastLoadedAt: number | null = null;
  // Each opening gets its own generation so a late emit or failure from a
  // closed subscription is ignored.
  let generation = 0;
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of Array.from(listeners)) listener();
  };

  const start = () => {
    const own = ++generation;
    const emit = (next: T) => {
      if (own !== generation) return;
      lastLoadedAt = now();
      if (Object.is(next, value)) return;
      value = next;
      notify();
    };
    const fail = (error: unknown) => {
      if (own !== generation || failure !== undefined) return;
      failure = { error, lastLoadedAt };
      stop();
      notify();
    };
    const opened = open(emit, fail);
    // A source may fail while it opens.
    if (own === generation && failure === undefined) close = opened;
    else opened();
  };

  const stop = () => {
    generation += 1;
    const closeSource = close;
    close = null;
    closeSource?.();
  };

  return {
    get: () => value,
    failure: () => failure,
    subscribe(onChange) {
      listeners.add(onChange);
      if (close === null && failure === undefined) start();
      return () => {
        listeners.delete(onChange);
        if (listeners.size > 0) return;
        // Nobody is looking: the next reader starts fresh.
        failure = undefined;
        stop();
      };
    },
    retry() {
      if (failure === undefined) return;
      failure = undefined;
      if (listeners.size > 0) start();
      notify();
    },
  };
}

/** One `SnapshotStore` per key, created on first use and reused after. */
export function createKeyedSnapshotStores<K, T>(
  open: (key: K, emit: Listener<T>, fail: Listener<unknown>) => Unsubscribe,
): (key: K) => SnapshotStore<T> {
  const stores = new Map<K, SnapshotStore<T>>();
  return (key) => {
    const existing = stores.get(key);
    if (existing) return existing;
    const store = createSnapshotStore<T>((emit, fail) => open(key, emit, fail));
    stores.set(key, store);
    return store;
  };
}
