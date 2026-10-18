import type { Listener, Unsubscribe } from "./source.ts";

/**
 * Latest-value cache over one source subscription, shaped for React's
 * `useSyncExternalStore` (and any other client). The source subscription opens
 * with the first reader and closes with the last, so a screen pays for exactly
 * one subscription however many rows read it.
 */
export interface SnapshotStore<T> {
  readonly get: () => T | undefined;
  readonly subscribe: (onChange: () => void) => Unsubscribe;
}

export function createSnapshotStore<T>(open: (emit: Listener<T>) => Unsubscribe): SnapshotStore<T> {
  let value: T | undefined;
  let close: Unsubscribe | null = null;
  const listeners = new Set<() => void>();

  const emit = (next: T) => {
    if (Object.is(next, value)) return;
    value = next;
    for (const listener of listeners) listener();
  };

  return {
    get: () => value,
    subscribe(onChange) {
      listeners.add(onChange);
      if (close === null) close = open(emit);
      return () => {
        listeners.delete(onChange);
        if (listeners.size > 0 || close === null) return;
        const closeSource = close;
        close = null;
        closeSource();
      };
    },
  };
}

/** One `SnapshotStore` per key, created on first use and reused after. */
export function createKeyedSnapshotStores<K, T>(
  open: (key: K, emit: Listener<T>) => Unsubscribe,
): (key: K) => SnapshotStore<T> {
  const stores = new Map<K, SnapshotStore<T>>();
  return (key) => {
    const existing = stores.get(key);
    if (existing) return existing;
    const store = createSnapshotStore<T>((emit) => open(key, emit));
    stores.set(key, store);
    return store;
  };
}
