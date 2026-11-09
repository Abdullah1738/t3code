import { describe, expect, it } from "@effect/vitest";
import { jsonExceedsBudget, MAX_REPLY_BYTES } from "./replyBudget.ts";

describe("reply budget", () => {
  it("counts JSON escapes and UTF-8 without allocating the JSON body", () => {
    for (const value of [
      null,
      true,
      false,
      42,
      "ascii",
      '"\\\n\u0000',
      "é😀",
      "\ud800",
      { a: ["x", null], absent: undefined },
    ]) {
      const bytes = Buffer.byteLength(JSON.stringify(value));
      expect(jsonExceedsBudget(value, bytes)).toBe(false);
      expect(jsonExceedsBudget(value, bytes - 1)).toBe(true);
    }
  });
  it("refuses a synthetic giant board before calling toJSON or encoding the body", () => {
    const card = { title: "Big", description: "x".repeat(1024 * 1024) };
    expect(jsonExceedsBudget({ cards: Array.from({ length: 40 }, () => ({ ...card })) })).toBe(
      true,
    );
    expect(jsonExceedsBudget("x".repeat(MAX_REPLY_BYTES))).toBe(true);
  });
});
