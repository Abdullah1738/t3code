import { describe, expect, it } from "vite-plus/test";
import type { ModelSelection } from "@t3tools/contracts";

import {
  HARNESS_MAP,
  effortOptionId,
  mergeSelection,
  resolveSelection,
  selectionEffort,
  splitLegacySuffix,
} from "./harnessRouting.ts";

const sel = (
  instanceId: string,
  model: string,
  options?: ReadonlyArray<{ id: string; value: string | boolean }>,
) => ({ instanceId, model, ...(options ? { options } : {}) }) as unknown as ModelSelection;

describe("harness map", () => {
  it.each(HARNESS_MAP.map((row) => [row.from.model, row] as const))(
    "maps %s",
    (_name, row) => {
      const mapped = resolveSelection(
        sel(row.from.instanceId, row.from.model, [{ id: "variant", value: "high" }]),
      );
      expect(mapped.kind).toBe("mapped");
      if (mapped.kind !== "mapped") return;
      expect(mapped.selection.instanceId).toBe(row.to.instanceId);
      expect(mapped.selection.model).toBe(row.to.model);
      expect(mapped.selection.options).toEqual([{ id: row.to.effortOptionId, value: "high" }]);
    },
  );

  it("sends a bare legacy route to its target with no option when there is no effort", () => {
    expect(resolveSelection(sel("opencode", "opus/gpt-6-astra"))).toEqual({
      kind: "mapped",
      selection: { instanceId: "codex", model: "gpt-6-astra" },
      from: { instanceId: "opencode", model: "opus/gpt-6-astra" },
      effort: null,
    });
  });

  it("keeps the terra route on codex-cu and the layso fallback on codex", () => {
    expect(resolveSelection(sel("opencode", "opus/cx/gpt-6.1-terra#xhigh"))).toMatchObject({
      kind: "mapped",
      selection: { instanceId: "codex-cu", model: "gpt-6.1-terra" },
    });
    expect(resolveSelection(sel("layso", "gpt-6-astra"))).toMatchObject({
      kind: "mapped",
      selection: { instanceId: "codex", model: "gpt-6-astra" },
    });
  });

  it("leaves unrelated OpenCode models unchanged", () => {
    for (const model of ["surplus/glm-5.3-flash", "kimi/k2", "muse/muse-1", "or/x#high"]) {
      const selection = sel("opencode", model, [{ id: "variant", value: "high" }]);
      expect(resolveSelection(selection)).toEqual({ kind: "unchanged", selection });
    }
  });
});

describe("legacy suffix", () => {
  it("splits a trailing #word only", () => {
    expect(splitLegacySuffix("opus/cx/gpt-6.1-sol#xhigh")).toEqual({
      model: "opus/cx/gpt-6.1-sol",
      effort: "xhigh",
    });
    expect(splitLegacySuffix("opus/gpt-6-astra")).toEqual({
      model: "opus/gpt-6-astra",
      effort: null,
    });
  });

  it("maps a suffix into the target effort option", () => {
    expect(resolveSelection(sel("opencode", "opus/cc/claude-haiku-5-5#xhigh"))).toMatchObject({
      kind: "mapped",
      selection: { instanceId: "claudeAgent", model: "claude-haiku-5-5", options: [{ id: "effort", value: "xhigh" }] },
      effort: "xhigh",
    });
  });

  it("accepts a suffix that matches the variant option", () => {
    expect(
      resolveSelection(sel("opencode", "opus/cx/gpt-6.1-sol#xhigh", [{ id: "variant", value: "xhigh" }])),
    ).toMatchObject({
      kind: "mapped",
      selection: { instanceId: "codex", options: [{ id: "reasoningEffort", value: "xhigh" }] },
    });
  });

  it("reports a suffix and a different variant as a conflict", () => {
    expect(
      resolveSelection(sel("opencode", "opus/cx/gpt-6.1-sol#xhigh", [{ id: "variant", value: "max" }])).kind,
    ).toBe("conflict");
  });
});

describe("carried options", () => {
  it("keeps fastMode for Claude and drops OpenCode-only options", () => {
    const result = resolveSelection(
      sel("opencode", "opus/claude-opus-5-5", [
        { id: "variant", value: "max" },
        { id: "fastMode", value: true },
        { id: "agent", value: "build" },
      ]),
    );
    expect(result).toMatchObject({
      kind: "mapped",
      selection: {
        instanceId: "claudeAgent",
        options: [
          { id: "effort", value: "max" },
          { id: "fastMode", value: true },
        ],
      },
    });
  });

  it("is idempotent for an already mapped selection", () => {
    const mapped = sel("claudeAgent", "claude-opus-5-5", [{ id: "effort", value: "max" }]);
    expect(resolveSelection(mapped)).toEqual({ kind: "unchanged", selection: mapped });
  });
});

describe("effort reading", () => {
  it("reads each driver's own option", () => {
    expect(effortOptionId("claudeAgent")).toBe("effort");
    expect(effortOptionId("codex")).toBe("reasoningEffort");
    expect(effortOptionId("codex-cu")).toBe("reasoningEffort");
    expect(effortOptionId("opencode")).toBe("variant");
    expect(selectionEffort(sel("claudeAgent", "x", [{ id: "effort", value: "max" }]))).toBe("max");
    expect(selectionEffort(sel("opencode", "x", [{ id: "effort", value: "max" }]))).toBeNull();
    expect(selectionEffort(null)).toBeNull();
  });
});

describe("mergeSelection", () => {
  const claude = sel("claudeAgent", "claude-opus-5-5", [
    { id: "effort", value: "max" },
    { id: "fastMode", value: true },
  ]);

  it("inherits options for the same instance and model", () => {
    expect(mergeSelection(claude, {})).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
      options: [
        { id: "fastMode", value: true },
        { id: "effort", value: "max" },
      ],
    });
  });

  it("clears options on an explicit empty list", () => {
    expect(mergeSelection(claude, { options: [] })).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
    });
  });

  it("clears the effort on variant null", () => {
    expect(mergeSelection(claude, { variant: null })).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
      options: [{ id: "fastMode", value: true }],
    });
  });

  it("a variant patch replaces the effort and never coexists with it", () => {
    const result = mergeSelection(claude, { variant: "xhigh" });
    expect(result.options).toEqual([
      { id: "fastMode", value: true },
      { id: "effort", value: "xhigh" },
    ]);
    expect(result.options?.filter((option) => option.id === "effort")).toHaveLength(1);
    expect(result.options?.some((option) => option.id === "variant")).toBe(false);
  });

  it("drops inherited options when the model changes", () => {
    expect(mergeSelection(claude, { model: "claude-sonnet-5-5" })).toEqual({
      instanceId: "claudeAgent",
      model: "claude-sonnet-5-5",
    });
  });
});
