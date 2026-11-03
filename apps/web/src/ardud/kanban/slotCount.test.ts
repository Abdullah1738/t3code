import { describe, expect, it } from "vite-plus/test";

import {
  committedSlots,
  currentSlots,
  editedSlots,
  failedSlot,
  observeSlots,
  sentSlots,
  type SlotWrites,
} from "./slotCount";

describe("committedSlots", () => {
  it("accepts whole counts without an upper cap", () => {
    expect(committedSlots("12", 5, 0)).toBe(12);
    expect(committedSlots(" 0012 ", 5, 0)).toBe(12);
    expect(committedSlots("250", 5, 0)).toBe(250);
  });

  it("keeps the current count for invalid or unchanged input", () => {
    expect(committedSlots("", 5, 0)).toBeNull();
    expect(committedSlots("abc", 5, 0)).toBeNull();
    expect(committedSlots("3.5", 5, 0)).toBeNull();
    expect(committedSlots("-2", 5, 0)).toBeNull();
    expect(committedSlots("99999999999999999999", 5, 0)).toBeNull();
    expect(committedSlots("5", 5, 0)).toBeNull();
  });

  it("clamps to the supplied bounds", () => {
    expect(committedSlots("0", 3, 1)).toBe(1);
    expect(committedSlots("4", 0, 0, 0)).toBeNull();
  });

  it("does not restore an untouched draft after another client changes the pool", () => {
    expect(editedSlots("5", false, 0, 0)).toBeNull();
    expect(editedSlots("5", true, 0, 0)).toBe(5);
    expect(editedSlots("12", true, 0, 0)).toBe(12);
    expect(editedSlots("12", true, 12, 0)).toBeNull();
    expect(editedSlots("abc", true, 0, 0)).toBeNull();
  });

  it("preserves the latest count when the feed acknowledges an earlier write", () => {
    const initial = { feed: 5, sent: [] };
    const first = sentSlots(initial, { id: 1, value: 12 });
    const second = sentSlots(first, { id: 2, value: currentSlots(first) + 1 });
    const intermediate = observeSlots(second, 12);
    expect(currentSlots(intermediate) + 1).toBe(14);
    const third = sentSlots(intermediate, { id: 3, value: 14 });
    expect(currentSlots(observeSlots(third, 13))).toBe(14);
    expect(currentSlots(observeSlots(third, 14))).toBe(14);
  });

  it("retires every write a coalesced feed covers, then follows a real change", () => {
    const sent = [12, 13, 12].reduce(
      (state, value, index) => sentSlots(state, { id: index + 1, value }),
      { feed: 5, sent: [] } as SlotWrites,
    );
    const coalesced = observeSlots(sent, 12);
    expect(coalesced.sent).toEqual([]);
    const remote = observeSlots(coalesced, 13);
    expect(currentSlots(remote)).toBe(13);
    expect(currentSlots(remote) + 1).toBe(14);
  });

  it("adopts an unrelated feed change and removes failed writes", () => {
    const initial = { feed: 5, sent: [] };
    const pending = sentSlots(sentSlots(initial, { id: 1, value: 12 }), {
      id: 2,
      value: 13,
    });
    expect(currentSlots(observeSlots(pending, 7))).toBe(7);
    expect(currentSlots(failedSlot(pending, 2))).toBe(12);
    expect(currentSlots(failedSlot(pending, 1))).toBe(13);
    expect(currentSlots(failedSlot(failedSlot(pending, 1), 2))).toBe(5);
  });
});
