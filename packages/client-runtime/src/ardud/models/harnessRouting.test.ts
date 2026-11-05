import { describe, expect, it } from "vite-plus/test";
import type { ModelSelection } from "@t3tools/contracts";

import {
  HARNESS_MAP,
  HARNESS_MAP_VERSION,
  effortOptionId,
  mergeSelection,
  openCodeModelFamily,
  postCutoverSelectionProblem,
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
  it.each(HARNESS_MAP.map((row) => [row.from.model, row] as const))("maps %s", (_name, row) => {
    const mapped = resolveSelection(
      sel(row.from.instanceId, row.from.model, [{ id: "variant", value: "high" }]),
    );
    expect(mapped.kind).toBe("mapped");
    if (mapped.kind !== "mapped") return;
    expect(mapped.selection.instanceId).toBe(row.to.instanceId);
    expect(mapped.selection.model).toBe(row.to.model);
    expect(mapped.selection.options).toEqual([{ id: row.to.effortOptionId, value: "high" }]);
  });

  it("sends a bare legacy route to its target with no option when there is no effort", () => {
    expect(resolveSelection(sel("opencode", "opus/gpt-6-astra"))).toEqual({
      kind: "mapped",
      selection: { instanceId: "codex", model: "gpt-6-astra" },
      from: { instanceId: "opencode", model: "opus/gpt-6-astra" },
      effort: null,
    });
  });

  it("routes every Terra selection, at every effort, to codex-cu", () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      expect(
        resolveSelection(
          sel("opencode", "opus/cx/gpt-6.1-terra", [{ id: "variant", value: effort }]),
        ),
      ).toMatchObject({
        kind: "mapped",
        selection: {
          instanceId: "codex-cu",
          model: "gpt-6.1-terra",
          options: [{ id: "reasoningEffort", value: effort }],
        },
      });
    }
    expect(resolveSelection(sel("opencode", "opus/cx/gpt-6.1-terra#max"))).toMatchObject({
      kind: "mapped",
      selection: { instanceId: "codex-cu", options: [{ id: "reasoningEffort", value: "max" }] },
    });
  });

  it("maps the real OpenCode fallback id, opencode layso/gpt-6-astra, to codex", () => {
    // Literal input, not read back from HARNESS_MAP, so a wrong row can't pass this test.
    expect(resolveSelection(sel("opencode", "layso/gpt-6-astra"))).toEqual({
      kind: "mapped",
      selection: { instanceId: "codex", model: "gpt-6-astra" },
      from: { instanceId: "opencode", model: "layso/gpt-6-astra" },
      effort: null,
    });
    expect(
      resolveSelection(sel("opencode", "layso/gpt-6-astra", [{ id: "variant", value: "xhigh" }])),
    ).toMatchObject({
      kind: "mapped",
      selection: { instanceId: "codex", options: [{ id: "reasoningEffort", value: "xhigh" }] },
    });
  });

  it("does not treat a bare layso instance as a route", () => {
    const selection = sel("layso", "gpt-6-astra");
    expect(resolveSelection(selection)).toEqual({ kind: "unchanged", selection });
  });

  it("leaves unrelated OpenCode models unchanged", () => {
    for (const model of ["surplus/glm-5.3-flash", "kimi/k2", "muse/muse-1", "or/x#high"]) {
      const selection = sel("opencode", model, [{ id: "variant", value: "high" }]);
      expect(resolveSelection(selection)).toEqual({ kind: "unchanged", selection });
    }
  });

  it.each([
    ["opus/claude-future", "claudeAgent"],
    ["opus/cc/claude-future#max", "claudeAgent"],
    ["or/anthropic/claude-future", "claudeAgent"],
    ["anthropic/unknown-model", "claudeAgent"],
    ["claude-future", "claudeAgent"],
    ["opus/cx/gpt-future", "codex"],
    ["layso/gpt-future#xhigh", "codex"],
    ["or/openai/gpt-future", "codex"],
    ["openai/unknown-model", "codex"],
    ["openai/o3", "codex"],
    ["gpt-future", "codex"],
  ])("refuses unmapped family model %s instead of retaining OpenCode", (model, target) => {
    expect(resolveSelection(sel("opencode", model))).toEqual({
      kind: "conflict",
      reason: expect.stringContaining(`select a model on ${target}`),
    });
  });

  it("does not use a family match to guess an alias or change native selections", () => {
    for (const instanceId of ["claudeAgent", "codex", "codex-cu", "custom"]) {
      const selection = sel(instanceId, "gpt-future");
      expect(resolveSelection(selection)).toEqual({ kind: "unchanged", selection });
    }
    expect(HARNESS_MAP_VERSION).toBe(2);
  });

  it("recognizes families without substring matches against unrelated model names", () => {
    expect(openCodeModelFamily("opus/cc/claude-haiku-5-5#xhigh")).toBe("claude");
    expect(openCodeModelFamily("opus/cx/gpt-6.1-terra#max")).toBe("openai");
    for (const model of ["surplus/glm", "or/someone/not-gpt-model", "muse/claudette", "kimi/k2"]) {
      expect(openCodeModelFamily(model)).toBeNull();
    }
  });
});

describe("post-cutover explicit selections", () => {
  it.each([
    ["opus/claude-opus-5-5", "claudeAgent/claude-opus-5-5"],
    ["opus/cx/gpt-6.1-sol", "codex/gpt-6.1-sol"],
    ["opus/cx/gpt-6.1-terra#max", "codex-cu/gpt-6.1-terra"],
  ])("names the verified native target for %s", (model, target) => {
    expect(postCutoverSelectionProblem(sel("opencode", model))).toContain(`use ${target} instead`);
  });

  it("refuses unknown family models without guessing a model", () => {
    expect(postCutoverSelectionProblem(sel("opencode", "opus/claude-future"))).toContain(
      "No verified native harness mapping",
    );
  });

  it("allows native selections and unrelated OpenCode models", () => {
    expect(postCutoverSelectionProblem(sel("codex-cu", "gpt-6.1-terra"))).toBeNull();
    expect(postCutoverSelectionProblem(sel("opencode", "surplus/glm"))).toBeNull();
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
      selection: {
        instanceId: "claudeAgent",
        model: "claude-haiku-5-5",
        options: [{ id: "effort", value: "xhigh" }],
      },
      effort: "xhigh",
    });
  });

  it("accepts a suffix that matches the variant option", () => {
    expect(
      resolveSelection(
        sel("opencode", "opus/cx/gpt-6.1-sol#xhigh", [{ id: "variant", value: "xhigh" }]),
      ),
    ).toMatchObject({
      kind: "mapped",
      selection: { instanceId: "codex", options: [{ id: "reasoningEffort", value: "xhigh" }] },
    });
  });

  it("reports a suffix and a different variant as a conflict", () => {
    expect(
      resolveSelection(
        sel("opencode", "opus/cx/gpt-6.1-sol#xhigh", [{ id: "variant", value: "max" }]),
      ).kind,
    ).toBe("conflict");
  });
});

describe("carried options", () => {
  it.each([
    ["opus/claude-opus-5-5", "effort"],
    ["opus/cx/gpt-6.1-sol", "reasoningEffort"],
    ["opus/cx/gpt-6.1-terra", "reasoningEffort"],
  ])("preserves an already-native effort option on %s", (model, id) => {
    expect(resolveSelection(sel("opencode", model, [{ id, value: "xhigh" }]))).toMatchObject({
      kind: "mapped",
      effort: "xhigh",
      selection: { options: [{ id, value: "xhigh" }] },
    });
  });

  it("refuses disagreement between compatibility and native effort names", () => {
    expect(
      resolveSelection(
        sel("opencode", "opus/cx/gpt-6.1-sol", [
          { id: "variant", value: "high" },
          { id: "reasoningEffort", value: "max" },
        ]),
      ).kind,
    ).toBe("conflict");
    expect(
      mergeSelection(
        sel("opencode", "opus/claude-opus-5-5#high", [{ id: "effort", value: "max" }]),
        {},
      ).kind,
    ).toBe("conflict");
  });

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
  const merged = (base: ModelSelection, patch: Parameters<typeof mergeSelection>[1]) => {
    const result = mergeSelection(base, patch);
    if (result.kind !== "selection") throw new Error(`unexpected conflict: ${result.reason}`);
    return result.selection;
  };
  const conflictOf = (base: ModelSelection, patch: Parameters<typeof mergeSelection>[1]) => {
    const result = mergeSelection(base, patch);
    return result.kind === "conflict" ? result.reason : null;
  };

  it("inherits options for the same instance and model", () => {
    expect(merged(claude, {})).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
      options: [
        { id: "fastMode", value: true },
        { id: "effort", value: "max" },
      ],
    });
  });

  it("clears options on an explicit empty list", () => {
    expect(merged(claude, { options: [] })).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
    });
  });

  it("clears the effort on variant null and keeps the other options", () => {
    expect(merged(claude, { variant: null })).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
      options: [{ id: "fastMode", value: true }],
    });
  });

  it("a variant patch replaces the effort and never coexists with it", () => {
    const result = merged(claude, { variant: "xhigh" });
    expect(result.options).toEqual([
      { id: "fastMode", value: true },
      { id: "effort", value: "xhigh" },
    ]);
    expect(result.options?.filter((option) => option.id === "effort")).toHaveLength(1);
    expect(result.options?.some((option) => option.id === "variant")).toBe(false);
  });

  it("drops inherited options when the model changes", () => {
    expect(merged(claude, { model: "claude-sonnet-5-5" })).toEqual({
      instanceId: "claudeAgent",
      model: "claude-sonnet-5-5",
    });
  });

  it("folds a legacy suffix on the base, so variant null clears it", () => {
    const suffixed = sel("opencode", "opus/cx/gpt-6.1-sol#xhigh");
    expect(merged(suffixed, { variant: null })).toEqual({
      instanceId: "opencode",
      model: "opus/cx/gpt-6.1-sol",
    });
    expect(merged(suffixed, { options: [] })).toEqual({
      instanceId: "opencode",
      model: "opus/cx/gpt-6.1-sol",
    });
    // After the clear the selection resolves to a route with no effort, not back to xhigh.
    const cleared = merged(suffixed, { variant: null });
    expect(resolveSelection(cleared)).toMatchObject({
      kind: "mapped",
      selection: { instanceId: "codex", model: "gpt-6.1-sol" },
      effort: null,
    });
  });

  it("a variant max over a legacy xhigh suffix replaces the effort instead of conflicting", () => {
    const suffixed = sel("opencode", "opus/cx/gpt-6.1-sol#xhigh");
    expect(merged(suffixed, { variant: "max" })).toEqual({
      instanceId: "opencode",
      model: "opus/cx/gpt-6.1-sol",
      options: [{ id: "variant", value: "max" }],
    });
  });

  it("a lone variant patch overrides the base's old effort", () => {
    expect(merged(claude, { variant: "low" }).options).toEqual([
      { id: "fastMode", value: true },
      { id: "effort", value: "low" },
    ]);
  });

  it("reports an explicit effort and a variant that disagree, rather than picking one", () => {
    expect(
      conflictOf(sel("claudeAgent", "claude-opus-5-5"), {
        options: [{ id: "effort", value: "max" }],
        variant: "xhigh",
      }),
    ).toMatch(/conflicting efforts/);
  });

  it("reports duplicate native efforts in one patch rather than taking the last", () => {
    expect(
      conflictOf(sel("codex", "gpt-6.1-sol"), {
        options: [
          { id: "reasoningEffort", value: "high" },
          { id: "reasoningEffort", value: "xhigh" },
        ],
      }),
    ).toMatch(/conflicting efforts/);
  });

  it("reports a suffix in the patch's model that disagrees with its effort option", () => {
    expect(
      conflictOf(sel("opencode", "opus/gpt-6-astra"), {
        model: "opus/cx/gpt-6.1-sol#xhigh",
        options: [{ id: "variant", value: "max" }],
      }),
    ).toMatch(/conflicting efforts/);
  });

  it("reports a clear and an effort in the same patch as a conflict", () => {
    expect(
      conflictOf(claude, { variant: null, options: [{ id: "effort", value: "low" }] }),
    ).toMatch(/clears its effort/);
  });

  it("reports a base that already holds two efforts instead of guessing", () => {
    expect(
      conflictOf(
        sel("codex", "gpt-6.1-sol", [
          { id: "reasoningEffort", value: "high" },
          { id: "reasoningEffort", value: "xhigh" },
        ]),
        {},
      ),
    ).toMatch(/conflicting efforts|already holds/);
  });
});

describe("review regressions", () => {
  // Each case is a finding from the card's review round 1, pinned to literal input.
  const suffixed = sel("opencode", "opus/cx/gpt-6.1-sol#xhigh");

  it("maps the literal OpenCode fallback id opencode layso/gpt-6-astra, independent of the table", () => {
    expect(resolveSelection(sel("opencode", "layso/gpt-6-astra"))).toEqual({
      kind: "mapped",
      selection: { instanceId: "codex", model: "gpt-6-astra" },
      from: { instanceId: "opencode", model: "layso/gpt-6-astra" },
      effort: null,
    });
  });

  it("variant null on a legacy #xhigh base clears the suffix, so resolution keeps no effort", () => {
    const cleared = mergeSelection(suffixed, { variant: null });
    expect(cleared).toEqual({
      kind: "selection",
      selection: { instanceId: "opencode", model: "opus/cx/gpt-6.1-sol" },
    });
    const resolved = resolveSelection(cleared.kind === "selection" ? cleared.selection : suffixed);
    expect(resolved).toMatchObject({ kind: "mapped", effort: null });
    expect(resolved.kind === "mapped" && resolved.selection.options).toBeUndefined();
  });

  it("an explicit empty options list on a #xhigh base clears the suffix too", () => {
    expect(mergeSelection(suffixed, { options: [] })).toEqual({
      kind: "selection",
      selection: { instanceId: "opencode", model: "opus/cx/gpt-6.1-sol" },
    });
  });

  it("variant max on a #xhigh base replaces the effort, with no suffix left behind", () => {
    expect(mergeSelection(suffixed, { variant: "max" })).toEqual({
      kind: "selection",
      selection: {
        instanceId: "opencode",
        model: "opus/cx/gpt-6.1-sol",
        options: [{ id: "variant", value: "max" }],
      },
    });
  });

  it("a patch with effort max and variant xhigh is a conflict, not a silent pick of xhigh", () => {
    const result = mergeSelection(sel("claudeAgent", "claude-opus-5-5"), {
      options: [{ id: "effort", value: "max" }],
      variant: "xhigh",
    });
    expect(result.kind).toBe("conflict");
  });

  it("duplicate native efforts in one patch are a conflict, not the last one", () => {
    const result = mergeSelection(sel("codex", "gpt-6.1-sol"), {
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "reasoningEffort", value: "xhigh" },
      ],
    });
    expect(result.kind).toBe("conflict");
  });

  it("source variants [xhigh, max] with a #xhigh suffix are a conflict, not the first one", () => {
    expect(
      resolveSelection(
        sel("opencode", "opus/cx/gpt-6.1-sol#xhigh", [
          { id: "variant", value: "xhigh" },
          { id: "variant", value: "max" },
        ]),
      ).kind,
    ).toBe("conflict");
  });

  it("a lone variant patch overrides the base's old effort", () => {
    const base = sel("claudeAgent", "claude-opus-5-5", [{ id: "effort", value: "max" }]);
    expect(mergeSelection(base, { variant: "low" })).toEqual({
      kind: "selection",
      selection: {
        instanceId: "claudeAgent",
        model: "claude-opus-5-5",
        options: [{ id: "effort", value: "low" }],
      },
    });
  });

  it("a patch suffix that agrees with its variant is one effort, not a conflict", () => {
    expect(
      mergeSelection(sel("opencode", "opus/gpt-6-astra"), {
        model: "opus/cx/gpt-6.1-sol#xhigh",
        options: [{ id: "variant", value: "xhigh" }],
      }),
    ).toEqual({
      kind: "selection",
      selection: {
        instanceId: "opencode",
        model: "opus/cx/gpt-6.1-sol",
        options: [{ id: "variant", value: "xhigh" }],
      },
    });
  });
});

describe("non-string effort values", () => {
  const maxBase = sel("codex", "gpt-6.1-sol", [{ id: "reasoningEffort", value: "max" }]);

  it("a boolean under reasoningEffort is a conflict, not a silent clear of max", () => {
    const result = mergeSelection(maxBase, {
      options: [{ id: "reasoningEffort", value: false }],
    });
    expect(result.kind).toBe("conflict");
    expect(result.kind === "conflict" ? result.reason : "").toMatch(
      /reasoningEffort must be a level name/,
    );
  });

  it("a boolean under effort or variant is a conflict too, on Claude and OpenCode", () => {
    expect(
      mergeSelection(sel("claudeAgent", "claude-opus-5-5"), {
        options: [{ id: "effort", value: true }],
      }).kind,
    ).toBe("conflict");
    expect(
      mergeSelection(sel("opencode", "opus/gpt-6-astra"), {
        options: [{ id: "variant", value: false }],
      }).kind,
    ).toBe("conflict");
  });

  it("a boolean under an effort id stored on the base is refused, not dropped", () => {
    const stored = sel("codex", "gpt-6.1-sol", [{ id: "reasoningEffort", value: false }]);
    expect(mergeSelection(stored, {}).kind).toBe("conflict");
    expect(resolveSelection(stored).kind).toBe("conflict");
  });

  it("a boolean fastMode still carries through a merge on Claude", () => {
    expect(
      mergeSelection(sel("claudeAgent", "claude-opus-5-5", [{ id: "effort", value: "max" }]), {
        options: [
          { id: "effort", value: "max" },
          { id: "fastMode", value: true },
        ],
      }),
    ).toEqual({
      kind: "selection",
      selection: {
        instanceId: "claudeAgent",
        model: "claude-opus-5-5",
        options: [
          { id: "fastMode", value: true },
          { id: "effort", value: "max" },
        ],
      },
    });
  });

  it("a boolean fastMode still carries through a resolve on Claude", () => {
    expect(
      resolveSelection(
        sel("opencode", "opus/claude-opus-5-5", [
          { id: "variant", value: "max" },
          { id: "fastMode", value: false },
        ]),
      ),
    ).toMatchObject({
      kind: "mapped",
      selection: {
        instanceId: "claudeAgent",
        options: [
          { id: "effort", value: "max" },
          { id: "fastMode", value: false },
        ],
      },
    });
  });
});

describe("conflicting efforts in resolveSelection", () => {
  it("reports a variant list with two values against a legacy suffix", () => {
    expect(
      resolveSelection(
        sel("opencode", "opus/cx/gpt-6.1-sol#xhigh", [
          { id: "variant", value: "xhigh" },
          { id: "variant", value: "max" },
        ]),
      ).kind,
    ).toBe("conflict");
  });

  it("reports two different variants with no suffix as a conflict, not the first one", () => {
    expect(
      resolveSelection(
        sel("opencode", "opus/cx/gpt-6.1-sol", [
          { id: "variant", value: "xhigh" },
          { id: "variant", value: "max" },
        ]),
      ).kind,
    ).toBe("conflict");
  });

  it("treats the same effort given twice as one effort", () => {
    expect(
      resolveSelection(
        sel("opencode", "opus/cx/gpt-6.1-sol#xhigh", [
          { id: "variant", value: "xhigh" },
          { id: "variant", value: "xhigh" },
        ]),
      ),
    ).toMatchObject({
      kind: "mapped",
      selection: { instanceId: "codex", options: [{ id: "reasoningEffort", value: "xhigh" }] },
    });
  });
});
