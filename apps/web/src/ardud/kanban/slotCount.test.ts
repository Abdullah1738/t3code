import { describe, expect, it } from "vite-plus/test";

import { committedSlots, editedSlots, shownSlots } from "./slotCount";

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

  it("steps from the last sent count until the feed moves", () => {
    expect(shownSlots(null, 5)).toBe(5);
    expect(shownSlots({ value: 12, from: 5 }, 5)).toBe(12);
    expect(shownSlots({ value: 12, from: 5 }, 12)).toBe(12);
    expect(shownSlots({ value: 12, from: 5 }, 7)).toBe(7);
  });
});
