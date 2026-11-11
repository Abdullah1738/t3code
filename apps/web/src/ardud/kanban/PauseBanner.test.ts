import { describe, expect, it } from "vitest";

import { pausedBy } from "./PauseBanner";

describe("pausedBy", () => {
  it("names the owner as the reader", () => {
    expect(pausedBy("owner")).toBe("You");
  });

  it("never shows the thread id behind an evaluator", () => {
    expect(
      pausedBy(
        "evaluator thread:project:ardud-opencode-import%3Aproject%3A%2FVolumes%2FExternalSSD%2Ft3code-fork:3b959c35",
      ),
    ).toBe("The evaluator");
  });

  it("falls back to a plain name for anything else", () => {
    expect(pausedBy("thread abc")).toBe("A card thread");
    expect(pausedBy("script nightly")).toBe("An agent");
    expect(pausedBy("")).toBe("An agent");
  });
});
