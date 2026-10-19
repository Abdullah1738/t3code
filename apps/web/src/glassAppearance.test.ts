import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import { applyGlassOpacity } from "./glassAppearance";

function fakeStyle(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    setProperty: (name: string, value: string | null) => {
      values.set(name, value ?? "");
    },
    removeProperty: (name: string) => {
      const previous = values.get(name) ?? "";
      values.delete(name);
      return previous;
    },
  };
}

describe("applyGlassOpacity", () => {
  it("leaves the theme default in charge until the user moves the slider", () => {
    const style = fakeStyle({ "--glass-opacity": "60%", "--glass-blur": "0px" });
    applyGlassOpacity(style, DEFAULT_UNIFIED_SETTINGS.glassOpacity);
    expect(style.values.has("--glass-opacity")).toBe(false);
    expect(style.values.has("--glass-blur")).toBe(false);
  });

  it("writes a changed opacity inline and drops the blur once fully solid", () => {
    const style = fakeStyle();
    applyGlassOpacity(style, 60);
    expect(style.values.get("--glass-opacity")).toBe("60%");
    expect(style.values.has("--glass-blur")).toBe(false);

    applyGlassOpacity(style, 100);
    expect(style.values.get("--glass-opacity")).toBe("100%");
    expect(style.values.get("--glass-blur")).toBe("0px");
  });
});
