/**
 * The six seconds between "he answered" and "it was sent". An answer is held
 * here so Undo can take it back; it goes out when the time is up, when the next
 * answer arrives, or at once when he leaves the page or closes the tab.
 * Pure: the clock and the timer are passed in.
 */

export const ASK_UNDO_MS = 6_000;

export interface HeldSend<T> {
  readonly id: number;
  readonly payload: T;
  /** When it goes out by itself, in epoch ms. */
  readonly dueAt: number;
}

export interface AskSendQueueOptions<T> {
  readonly delayMs?: number;
  readonly now: () => number;
  readonly setTimer: (run: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
  /**
   * Sends one held answer. `leaving` is true when the page is going away, so
   * the request must outlive it (`fetch` with `keepalive`).
   */
  readonly send: (payload: T, leaving: boolean) => void;
  /** Called whenever what is held changes. */
  readonly onChange?: (held: HeldSend<T> | null) => void;
}

export interface AskSendQueue<T> {
  /** Holds an answer. One already held is sent first: only the newest can be undone. */
  readonly hold: (payload: T) => HeldSend<T>;
  /** Takes back the held answer; null when there is none (it already went out). */
  readonly undo: () => T | null;
  /** Sends the held answer now. */
  readonly flush: (leaving?: boolean) => void;
  readonly held: () => HeldSend<T> | null;
}

export function createAskSendQueue<T>(options: AskSendQueueOptions<T>): AskSendQueue<T> {
  const delayMs = options.delayMs ?? ASK_UNDO_MS;
  let current: HeldSend<T> | null = null;
  let timer: unknown = null;
  let nextId = 1;

  const set = (next: HeldSend<T> | null) => {
    current = next;
    options.onChange?.(next);
  };
  const stopTimer = () => {
    if (timer !== null) options.clearTimer(timer);
    timer = null;
  };
  const flush = (leaving = false) => {
    const held = current;
    if (held === null) return;
    stopTimer();
    // Cleared before sending, so a send that reads the queue sees it empty.
    set(null);
    options.send(held.payload, leaving);
  };

  return {
    hold: (payload) => {
      flush();
      const held: HeldSend<T> = { id: nextId++, payload, dueAt: options.now() + delayMs };
      timer = options.setTimer(() => {
        // A stale timer (its answer was undone or already sent) does nothing.
        if (current?.id === held.id) flush();
      }, delayMs);
      set(held);
      return held;
    },
    undo: () => {
      const held = current;
      if (held === null) return null;
      stopTimer();
      set(null);
      return held.payload;
    },
    flush,
    held: () => current,
  };
}

/** Whole seconds left before a held answer goes out; never below zero. */
export const heldSecondsLeft = (held: Pick<HeldSend<unknown>, "dueAt">, nowMs: number): number =>
  Math.max(0, Math.ceil((held.dueAt - nowMs) / 1000));
