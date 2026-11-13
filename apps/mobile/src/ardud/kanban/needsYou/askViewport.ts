export interface AskRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Every clipping ancestor matters, including horizontally scrolled columns. */
export function askInViewport(row: AskRect | null, clips: ReadonlyArray<AskRect | null>): boolean {
  if (row === null || clips.length === 0) return false;
  let left = -Infinity,
    top = -Infinity,
    right = Infinity,
    bottom = Infinity;
  for (const rect of [row, ...clips]) {
    if (
      rect === null ||
      !Object.values(rect).every(Number.isFinite) ||
      rect.width <= 0 ||
      rect.height <= 0
    )
      return false;
    left = Math.max(left, rect.x);
    top = Math.max(top, rect.y);
    right = Math.min(right, rect.x + rect.width);
    bottom = Math.min(bottom, rect.y + rect.height);
  }
  return right > left && bottom > top;
}

export interface AskViewport {
  readonly measure: () => Promise<AskRect | null>;
  readonly subscribe: (run: () => void) => () => void;
}

export function createAskViewport(measure: AskViewport["measure"]) {
  const listeners = new Set<() => void>();
  let pending: Promise<AskRect | null> | undefined;
  return {
    // A scroll measures its viewport once, shared by all rows checked in that frame.
    measure: () => (pending ??= measure()),
    subscribe: (run: () => void) => {
      listeners.add(run);
      return () => {
        listeners.delete(run);
      };
    },
    refresh: () => {
      pending = undefined;
      for (const run of listeners) run();
    },
  };
}
