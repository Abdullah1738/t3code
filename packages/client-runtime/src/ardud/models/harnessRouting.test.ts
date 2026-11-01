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
