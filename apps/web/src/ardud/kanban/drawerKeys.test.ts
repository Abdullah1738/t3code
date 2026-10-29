import { describe, expect, it } from "vite-plus/test";

import { stepFromKey } from "./drawerKeys.ts";

const plain = {
  key: "ArrowDown",
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  defaultPrevented: false,
  isComposing: false,
  target: null,
};

/** A DOM-free target: `closest` answers with whatever the test wants. */
const target = (owner: unknown) => ({ closest: () => owner }) as unknown as EventTarget;

describe("stepFromKey", () => {
  it("steps ArrowUp back and ArrowDown forward, and ignores other keys", () => {
    expect(stepFromKey({ ...plain, key: "ArrowUp" })).toBe(-1);
    expect(stepFromKey({ ...plain, key: "ArrowDown" })).toBe(1);
    expect(stepFromKey({ ...plain, key: "Enter" })).toBeNull();
  });

  it("ignores arrows with any modifier held", () => {
    for (const modifier of ["altKey", "ctrlKey", "metaKey", "shiftKey"] as const) {
      expect(stepFromKey({ ...plain, [modifier]: true })).toBeNull();
    }
  });

  it("ignores arrows something already handled or an IME is composing", () => {
    expect(stepFromKey({ ...plain, defaultPrevented: true })).toBeNull();
    expect(stepFromKey({ ...plain, isComposing: true })).toBeNull();
  });

  it("ignores arrows typed into an input, textarea, or menu", () => {
    expect(stepFromKey({ ...plain, target: target({}) })).toBeNull();
  });

  it("steps when the target is outside any text field or menu, or there is no target", () => {
    expect(stepFromKey({ ...plain, target: target(null) })).toBe(1);
    expect(stepFromKey({ ...plain, target: null })).toBe(1);
  });
});
