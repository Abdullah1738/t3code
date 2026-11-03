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

/** Reconcile local writes with intermediate pool snapshots, preserving newer edits. */
export function observeSlots(state: SlotWrites, feed: number): SlotWrites {
  if (state.feed === feed) return state;
  const match = state.sent.findIndex((write) => write.value === feed);
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
