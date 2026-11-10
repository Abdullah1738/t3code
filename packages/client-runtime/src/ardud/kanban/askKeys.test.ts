import { describe, expect, it } from "vite-plus/test";

import { askKeyAction, nextChangeView, type AskKeyContext } from "./askKeys.ts";

const base: AskKeyContext = {
  typing: false,
  onControl: false,
  layerOpen: false,
  answerable: true,
  single: true,
  options: 0,
  changes: 0,
  editable: false,
  refusable: true,
};
const key = (name: string, context: Partial<AskKeyContext> = {}, mods = {}) =>
  askKeyAction({ key: name, ...mods }, { ...base, ...context });

describe("askKeyAction", () => {
  it("maps the demo's keys", () => {
    expect(key("j")).toEqual({ _tag: "move", delta: 1 });
    expect(key("K")).toEqual({ _tag: "move", delta: -1 });
    expect(key("ArrowDown")).toEqual({ _tag: "move", delta: 1 });
    expect(key("a")).toEqual({ _tag: "primary" });
    expect(key("Enter")).toEqual({ _tag: "primary" });
    expect(key("x")).toEqual({ _tag: "refuse" });
    expect(key("n")).toEqual({ _tag: "note" });
    expect(key("r")).toEqual({ _tag: "reply" });
    expect(key("c")).toEqual({ _tag: "card" });
    expect(key("z")).toEqual({ _tag: "undo" });
    expect(key("s")).toEqual({ _tag: "snooze" });
    expect(key("/")).toEqual({ _tag: "search" });
    expect(key("?")).toEqual({ _tag: "shortcuts" });
    expect(key("Escape")).toEqual({ _tag: "close" });
  });

  it("types into a text box instead of acting, except Escape", () => {
    expect(key("a", { typing: true })).toBeNull();
    expect(key("?", { typing: true })).toBeNull();
    expect(key("Escape", { typing: true })).toEqual({ _tag: "close" });
  });

  it("Enter on a control presses that control only", () => {
    expect(key("Enter", { onControl: true })).toBeNull();
    expect(key("a", { onControl: true })).toEqual({ _tag: "primary" });
  });

  it("leaves chords to the app and the browser", () => {
    expect(key("a", {}, { metaKey: true })).toBeNull();
    expect(key("k", {}, { ctrlKey: true })).toBeNull();
  });

  it("only the shortcuts sheet and Escape work under an open layer", () => {
    expect(key("a", { layerOpen: true })).toBeNull();
    expect(key("j", { layerOpen: true })).toBeNull();
    expect(key("?", { layerOpen: true })).toEqual({ _tag: "shortcuts" });
  });

  it("an answered ask still moves and undoes, but takes no answer keys", () => {
    expect(key("a", { answerable: false })).toBeNull();
    expect(key("x", { answerable: false })).toBeNull();
    expect(key("j", { answerable: false })).toEqual({ _tag: "move", delta: 1 });
    expect(key("z", { answerable: false })).toEqual({ _tag: "undo" });
  });

  it("offers a key only when the ask has the part", () => {
    expect(key("x", { refusable: false })).toBeNull();
    expect(key("r", { single: false })).toBeNull();
    expect(key("e")).toBeNull();
    expect(key("e", { editable: true })).toEqual({ _tag: "edit" });
    expect(key("v")).toBeNull();
    expect(key("v", { changes: 1 })).toEqual({ _tag: "view" });
    expect(key("]", { changes: 1 })).toBeNull();
    expect(key("]", { changes: 3 })).toEqual({ _tag: "change", delta: 1 });
    expect(key("[", { changes: 3 })).toEqual({ _tag: "change", delta: -1 });
    expect(key("2", { options: 3 })).toEqual({ _tag: "pick", index: 1 });
    expect(key("4", { options: 3 })).toBeNull();
    expect(key("1")).toBeNull();
  });
});

describe("nextChangeView", () => {
  it("steps After, Before, Changes, and Side by side only on a wide screen", () => {
    expect(nextChangeView("after", true)).toBe("before");
    expect(nextChangeView("diff", true)).toBe("both");
    expect(nextChangeView("both", true)).toBe("after");
    expect(nextChangeView("diff", false)).toBe("after");
    expect(nextChangeView("both", false)).toBe("after");
  });
});
