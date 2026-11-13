export interface ChoiceDraft {
  readonly choice: ReadonlyArray<string>;
  readonly text: string;
  readonly against: string | null;
  readonly sent: boolean;
  readonly pending: boolean;
}

export function newestFirst<T>(messages: ReadonlyArray<T> | undefined): ReadonlyArray<T> {
  return messages === undefined ? [] : [...messages].reverse();
}

/** FlatList may report the same end repeatedly, including after a failed or stale read. */
export function createEarlierPageLoader(read: () => Promise<boolean>) {
  let requested: number | null = null;
  let pending = false;
  return async (oldest: number | undefined, retry = false): Promise<boolean> => {
    if (oldest === undefined || oldest <= 1 || pending || (requested === oldest && !retry)) {
      return false;
    }
    requested = oldest;
    pending = true;
    try {
      return await read();
    } finally {
      pending = false;
    }
  };
}

/** In an inverted list, increasing the native offset moves content down. */
export function invertedAnswerOffset(offset: number, overflow: number): number {
  return Math.max(0, offset - overflow);
}

/** Ignore iOS bounce offsets; a few positive points absorb native rounding. */
export function followingNewest(offset: number, dragging: boolean): boolean {
  return !dragging && offset >= 0 && offset <= 4;
}

/** FlatList may have already reported the end while the first short page was mounting. */
export function nearHistoryEnd(offset: number, contentHeight: number, viewportHeight: number) {
  return contentHeight - viewportHeight - offset <= viewportHeight * 0.3;
}

/** A gesture can trigger one page, including its momentum, never a layout-driven cascade. */
export function createHistoryGesture() {
  let active = false;
  let eligible = false;
  return {
    begin(atEnd: boolean) {
      active = true;
      eligible = atEnd;
    },
    scroll(previous: number, current: number) {
      if (active && !eligible && current > previous) eligible = true;
    },
    end() {
      active = false;
    },
    isActive() {
      return active;
    },
    consume() {
      if (active || !eligible) return false;
      eligible = false;
      return true;
    },
    cancel() {
      active = false;
      eligible = false;
    },
  };
}

/** Row state outlives virtualization without re-rendering every other message. */
export function createRowStateStore<T>() {
  const values = new Map<string, T>();
  const listeners = new Map<string, Set<() => void>>();
  return {
    get(key: string): T | null {
      return values.get(key) ?? null;
    },
    set(key: string, value: T | null) {
      if (value === null) values.delete(key);
      else values.set(key, value);
      for (const listener of listeners.get(key) ?? []) listener();
    },
    subscribe(key: string, listener: () => void) {
      let group = listeners.get(key);
      if (group === undefined) {
        group = new Set();
        listeners.set(key, group);
      }
      group.add(listener);
      return () => {
        group.delete(listener);
        if (group.size === 0) listeners.delete(key);
      };
    },
  };
}

export function completeChoiceDraft(
  store: ReturnType<typeof createRowStateStore<ChoiceDraft>>,
  key: string,
  attempt: ChoiceDraft,
  ok: boolean,
  keepOnFailure: boolean,
) {
  if (store.get(key) !== attempt) return;
  const result = ok
    ? { ...attempt, pending: false }
    : keepOnFailure
      ? { ...attempt, sent: false, pending: false }
      : null;
  store.set(key, result);
}
