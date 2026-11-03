/** What a typed slot count commits: a whole number clamped to min..max, or null to keep the current count. */
export function committedSlots(
  text: string,
  current: number,
  min: number,
  max?: number | undefined,
): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const typed = Number(trimmed);
  if (!Number.isSafeInteger(typed)) return null;
  const next = Math.max(min, max === undefined ? typed : Math.min(max, typed));
  return next === current ? null : next;
}

/** Ignore an untouched draft even if the pool changed while the field was focused. */
export function editedSlots(
  text: string,
  edited: boolean,
  current: number,
  min: number,
  max?: number | undefined,
): number | null {
  return edited ? committedSlots(text, current, min, max) : null;
}

export interface SlotWrite {
  readonly id: number;
  readonly value: number;
}

export interface SlotWrites {
  readonly feed: number;
  readonly sent: ReadonlyArray<SlotWrite>;
}

type SlotWriteRequest = {
  write: () => Promise<boolean | void> | boolean | void;
  dropped: () => void;
};

function serialQueue(onIdle: () => void = () => {}) {
  let inFlight = false;
  let queued: SlotWriteRequest | null = null;

  const run = async (request: SlotWriteRequest) => {
    inFlight = true;
    let result: boolean | void;
    try {
      result = await Promise.resolve(request.write());
    } catch {
      result = false;
    }
    if (result === false) request.dropped();
    if (queued !== null) {
      const next = queued;
      queued = null;
      void run(next);
    } else {
      inFlight = false;
      onIdle();
    }
  };

  return (request: SlotWriteRequest) => {
    if (!inFlight) {
      void run(request);
      return;
    }
    const previous = queued;
    queued = request;
    previous?.dropped();
  };
}

/** Serialize writes and discard superseded or failed pending IDs. */
export function serialSender(
  write: (value: number) => Promise<boolean | void> | boolean | void,
  dropped: (id: number) => void,
): (id: number, value: number) => void {
  const send = serialQueue();
  return (id, value) => send({ write: () => write(value), dropped: () => dropped(id) });
}

// A Settings view can unmount while its RPC is pending. Share the queue until it drains.
const poolQueues = new Map<string, ReturnType<typeof serialQueue>>();

export function sendPoolSlots(
  boardId: string,
  poolKey: string,
  value: number,
  write: (value: number) => Promise<boolean | void> | boolean | void,
  dropped: () => void = () => {},
): void {
  const key = JSON.stringify([boardId, poolKey]);
  let send = poolQueues.get(key);
  if (send === undefined) {
    send = serialQueue(() => poolQueues.delete(key));
    poolQueues.set(key, send);
  }
  send({ write: () => write(value), dropped });
}

/**
 * Reconcile local writes with intermediate pool snapshots, preserving newer edits.
 * Matching the last equal write makes a coalesced feed (12, 13, 12 seen only as 12) retire all
 * three; an uncoalesced repeat at worst shows an older count until the next feed update.
 */
export function observeSlots(state: SlotWrites, feed: number): SlotWrites {
  if (state.feed === feed) return state;
  const match = state.sent.findLastIndex((write) => write.value === feed);
  return { feed, sent: match < 0 ? [] : state.sent.slice(match + 1) };
}

export function sentSlots(state: SlotWrites, write: SlotWrite): SlotWrites {
  return { ...state, sent: [...state.sent, write] };
}

export function failedSlot(state: SlotWrites, id: number): SlotWrites {
  const index = state.sent.findIndex((write) => write.id === id);
  if (index < 0) return state;
  return { ...state, sent: state.sent.filter((write) => write.id !== id) };
}

export function currentSlots(state: SlotWrites): number {
  return state.sent.at(-1)?.value ?? state.feed;
}
