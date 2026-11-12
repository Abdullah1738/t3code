import { CARD_ASK_TOOL_DESCRIPTION } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  ASK_REFERENCE_KINDS,
  ASK_REFERENCE_MOST_USED,
  ASK_REFERENCE_TOLD,
} from "./askReference.ts";
import { SAMPLE_CHOOSE, SAMPLE_DRAFT, SAMPLE_FILL, SAMPLE_TASK } from "./askSamples.ts";

describe("what an ask can be", () => {
  it("splits what agents are told into its sentences and loses none of the words", () => {
    expect(ASK_REFERENCE_TOLD.length).toBeGreaterThan(1);
    expect(ASK_REFERENCE_TOLD.join(" ").replace(/\s+/g, " ")).toBe(
      CARD_ASK_TOOL_DESCRIPTION.replace(/\s+/g, " "),
    );
    for (const sentence of ASK_REFERENCE_TOLD) expect(sentence.trim()).not.toBe("");
  });

  it("finds an example of a kind by what the ask takes back, not only by its name", () => {
    const match = (name: string) => ASK_REFERENCE_KINDS.find(([kind]) => kind === name)![3];
    expect(match("Decision")(SAMPLE_CHOOSE)).toBe(true);
    expect(match("Draft")(SAMPLE_DRAFT)).toBe(true);
    expect(match("Task")(SAMPLE_TASK)).toBe(true);
    expect(match("Secret")(SAMPLE_FILL)).toBe(true);
    expect(match("Rank")(SAMPLE_FILL)).toBe(true);
    expect(match("Notice")(SAMPLE_CHOOSE)).toBe(false);
  });

  it("names five most-used kinds, each with what an agent fills in", () => {
    expect(ASK_REFERENCE_MOST_USED.map((entry) => entry.name)).toEqual([
      "Action",
      "Draft",
      "Decision",
      "Change",
      "Question",
    ]);
    for (const entry of ASK_REFERENCE_MOST_USED) expect(entry.fills.length).toBeGreaterThan(0);
  });
});
