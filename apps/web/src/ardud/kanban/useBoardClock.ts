import { useSyncExternalStore } from "react";

import { createBoardView, type BoardViewEngine } from "@t3tools/client-runtime/ardud/kanban";

/** How coarse the board's clock is: ages and "stuck" thresholds move at most this late. */
export const BOARD_CLOCK_MS = 30_000;

const quantized = () => Math.floor(Date.now() / BOARD_CLOCK_MS) * BOARD_CLOCK_MS;

// One timer for every board, column and tile on screen; nothing on a board runs its own.
let now = quantized();
let timerId: number | null = null;
const listeners = new Set<() => void>();

function tick(): void {
  const next = quantized();
  if (next !== now) {
    now = next;
    for (const listener of listeners) listener();
  }
  // The last listener may have left during the loop: no timer without one.
  timerId =
    listeners.size > 0
      ? window.setTimeout(tick, BOARD_CLOCK_MS - (Date.now() % BOARD_CLOCK_MS) + 5)
      : null;
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    timerId = window.setTimeout(tick, BOARD_CLOCK_MS - (Date.now() % BOARD_CLOCK_MS) + 5);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timerId !== null) {
      window.clearTimeout(timerId);
      timerId = null;
    }
  };
}

function getSnapshot(): number {
  // Between notifications the value must not move; with no timer running nobody is
  // subscribed, so it can catch up.
  if (timerId === null) now = quantized();
  return now;
}

/** Epoch ms on a shared 30-second tick. */
export function useBoardClock(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

const engines = new Map<string, BoardViewEngine>();
const ENGINES_KEPT = 6;

/** The derived-view cache of one board; a few recent boards keep theirs. */
export function boardViewFor(boardId: string): BoardViewEngine {
  const known = engines.get(boardId);
  if (known !== undefined) return known;
  const engine = createBoardView();
  engines.set(boardId, engine);
  if (engines.size > ENGINES_KEPT) {
    const oldest = engines.keys().next().value;
    if (oldest !== undefined) engines.delete(oldest);
  }
  return engine;
}
