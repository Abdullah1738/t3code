// @effect-diagnostics globalDate:off - Load times render on the reader's clock and zone.
import type { EnvironmentConnectionPhase } from "../../connection/presentation.ts";
import { formatDayLabel, formatTimeOfDay } from "./time.ts";

export type Unsubscribe = () => void;
export type Listener<T> = (value: T) => void;

/**
 * Latest-value cache over one source subscription, shaped for React's
 * `useSyncExternalStore` (and any other client). The source subscription opens
 * with the first reader and closes with the last (or a keep-alive after it), so
 * a screen pays for exactly one subscription however many rows read it.
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

/**
 * The connection chip's word for a phase: null while connected (or before the
 * first connection attempt has a phase at all).
 */
export function connectionLabel(phase: EnvironmentConnectionPhase | null): string | null {
  switch (phase) {
    case null:
    case "connected":
      return null;
    case "connecting":
      return "Connecting";
    case "reconnecting":
      return "Reconnecting";
    default:
      return "Offline";
  }
}

/**
 * The Desk offline line for a block that has nothing loaded yet: says why it
 * is empty instead of loading forever. Null while the first connection is
 * still being made or the server is connected; a failed read shows the error
 * line instead.
 */
export function feedOfflineLines(
  phase: EnvironmentConnectionPhase | null,
): { readonly title: string; readonly detail: string } | null {
  const title = connectionLabel(phase);
  if (title === null || phase === "connecting") return null;
  return { title, detail: "Loads when the server is back." };
}

export type SnapshotOpen<T> = (emit: Listener<T>, fail: Listener<unknown>) => Unsubscribe;

export interface SnapshotStoreOptions {
  readonly now?: () => number;
  /**
   * How long the source stays open after the last reader leaves. Coming back
   * within it finds the feed still live, so the screen neither reopens the
   * subscription nor repaints with a refetched copy. 0 closes at once.
   */
  readonly keepAliveMs?: number;
}

export function createSnapshotStore<T>(
  open: SnapshotOpen<T>,
  options: SnapshotStoreOptions = {},
): SnapshotStore<T> {
  const now = options.now ?? Date.now;
  const keepAliveMs = Math.max(0, options.keepAliveMs ?? 0);
  let value: T | undefined;
  let close: Unsubscribe | null = null;
  let failure: FeedFailure | undefined;
  let lastLoadedAt: number | null = null;
  // Each opening gets its own generation so a late emit or failure from a
  // closed subscription is ignored.
  let generation = 0;
  let idle: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();

  const cancelIdle = () => {
    if (idle === null) return;
    clearTimeout(idle);
    idle = null;
  };

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
      stop();
      // Kept open with nobody looking: the next reader starts fresh instead.
      if (listeners.size === 0) return;
      failure = { error, lastLoadedAt };
      notify();
    };
    const opened = open(emit, fail);
    // A source may fail while it opens.
    if (own === generation && failure === undefined) close = opened;
    else opened();
  };

  const stop = () => {
    cancelIdle();
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
      cancelIdle();
      if (close === null && failure === undefined) start();
      return () => {
        listeners.delete(onChange);
        if (listeners.size > 0) return;
        // Nobody is looking: the next reader starts fresh.
        failure = undefined;
        if (keepAliveMs === 0 || close === null) {
          stop();
          return;
        }
        cancelIdle();
        // @effect-diagnostics-next-line globalTimers:off - Plain callback store shared by web and mobile.
        idle = setTimeout(stop, keepAliveMs);
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
  options: SnapshotStoreOptions = {},
): (key: K) => SnapshotStore<T> {
  const stores = new Map<K, SnapshotStore<T>>();
  return (key) => {
    const existing = stores.get(key);
    if (existing) return existing;
    const store = createSnapshotStore<T>((emit, fail) => open(key, emit, fail), options);
    stores.set(key, store);
    return store;
  };
}

/**
 * Reads several stores as one. Subscribing opens them all; `ready` turns true
 * once each has answered with a value or a failure, and stays true after, so
 * a screen that has shown does not blank while one feed retries.
 */
export function createSnapshotGate(stores: ReadonlyArray<SnapshotStore<unknown>>): {
  readonly subscribe: (onChange: () => void) => () => void;
  readonly ready: () => boolean;
} {
  let shown = false;
  return {
    subscribe: (onChange) => {
      const stops = stores.map((store) => store.subscribe(onChange));
      return () => {
        for (const stop of stops) stop();
      };
    },
    ready: () => {
      if (!shown) {
        shown = stores.every((store) => store.get() !== undefined || store.failure() !== undefined);
      }
      return shown;
    },
  };
}
