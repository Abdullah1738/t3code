import { describe, expect, it } from "vite-plus/test";

import { committedSlots } from "./slotCount";

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
});
