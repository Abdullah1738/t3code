import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId, type ModelSelection, type ServerProviderModel } from "@t3tools/contracts";
import {
  boardModelChange,
  boardPoolAddition,
  boardPoolLevelChange,
  boardTraitModels,
  boardTraitsChange,
  checkedBoardSelection,
} from "./SettingsView";

const id = (value: string) => ProviderInstanceId.make(value);
const selection = (
  instanceId: string,
  model: string,
  options?: ModelSelection["options"],
): ModelSelection => ({ instanceId: id(instanceId), model, ...(options ? { options } : {}) });
const model = (slug: string, effortId: string): ServerProviderModel => ({
  slug,
  name: slug,
  isCustom: false,
  capabilities: {
    optionDescriptors: [
      {
        id: effortId,
        label: "Effort",
        type: "select",
        currentValue: "high",
        options: ["high", "xhigh", "max"].map((value) => ({ id: value, label: value })),
      },
      { id: "fastMode", label: "Fast", type: "boolean", currentValue: false },
      {
        id: "serviceTier",
        label: "Service tier",
        type: "select",
        currentValue: "standard",
        options: ["standard", "priority"].map((value) => ({ id: value, label: value })),
      },
    ],
  },
});
const catalog = [
  { instanceId: id("opencode"), models: [model("other", "variant")] },
  { instanceId: id("claudeAgent"), models: [model("claude-opus-5-5", "effort")] },
  { instanceId: id("codex"), models: [model("gpt-6.1-sol", "reasoningEffort")] },
];

describe("board selection callers", () => {
  it("leaves the legacy model and suffix untouched when routing is off", () => {
    const base = selection("opencode", "other", [{ id: "variant", value: "high" }]);
    expect(boardModelChange(base, id("opencode"), "opus/cx/gpt-6.1-sol#xhigh", catalog, false))
      .toEqual({ kind: "selection", selection: selection("opencode", "opus/cx/gpt-6.1-sol#xhigh") });
  });

  it("maps a suffix to the native effort without inheriting a different model's options", () => {
    const base = selection("opencode", "other", [{ id: "variant", value: "high" }]);
    expect(boardModelChange(base, id("opencode"), "opus/cx/gpt-6.1-sol#xhigh", catalog, true))
      .toEqual({
        kind: "selection",
        selection: selection("codex", "gpt-6.1-sol", [{ id: "reasoningEffort", value: "xhigh" }]),
      });
  });

  it("preserves native secondary settings and ignores implicit defaults on a reasoning edit", () => {
    const base = selection("claudeAgent", "claude-opus-5-5", [
      { id: "effort", value: "high" }, { id: "fastMode", value: true },
    ]);
    const displayed = [
      { id: "effort", value: "high" }, { id: "fastMode", value: true },
      { id: "serviceTier", value: "standard" },
    ];
    const result = boardTraitsChange(base, displayed, [
      { id: "effort", value: "max" }, { id: "fastMode", value: true },
      { id: "serviceTier", value: "standard" },
    ], catalog);
    expect(result.kind).toBe("selection");
    if (result.kind === "selection") {
      expect(result.selection.options).toEqual(expect.arrayContaining([
        { id: "effort", value: "max" }, { id: "fastMode", value: true },
      ]));
      expect(result.selection.options).toHaveLength(2);
    }
  });

  it("refuses conflicting, unsupported and option-losing selections", () => {
    expect(checkedBoardSelection(selection("opencode", "opus/cx/gpt-6.1-sol#xhigh", [
      { id: "variant", value: "high" },
    ]), catalog).kind).toBe("conflict");
    expect(checkedBoardSelection(selection("codex", "gpt-6.1-sol", [
      { id: "reasoningEffort", value: "ultrathink" },
    ]), catalog).kind).toBe("conflict");
    expect(checkedBoardSelection(selection("opencode", "opus/cx/gpt-6.1-sol", [
      { id: "agent", value: "build" },
    ]), catalog).kind).toBe("conflict");
  });

  it("changes a pool level while preserving secondary options and rejects alias moves", () => {
    const base = selection("codex", "gpt-6.1-sol", [
      { id: "reasoningEffort", value: "high" }, { id: "serviceTier", value: "priority" },
    ]);
    const result = boardPoolLevelChange(base, "xhigh", catalog);
    expect(result.kind).toBe("selection");
    if (result.kind === "selection") expect(result.selection.options).toEqual(expect.arrayContaining([
      { id: "reasoningEffort", value: "xhigh" }, { id: "serviceTier", value: "priority" },
    ]));
    expect(boardPoolLevelChange(selection("opencode", "opus/cx/gpt-6.1-sol", [
      { id: "variant", value: "high" },
    ]), "max", catalog).kind).toBe("conflict");
  });

  it("does not add an alias over an unmigrated pool and picks an unoccupied native level", () => {
    const legacy = selection("opencode", "opus/cx/gpt-6.1-sol", [{ id: "variant", value: "high" }]);
    expect(boardPoolAddition(id("codex"), "gpt-6.1-sol", catalog, [{ model: legacy }], true)?.kind)
      .toBe("conflict");
    const native = selection("codex", "gpt-6.1-sol", [{ id: "reasoningEffort", value: "high" }]);
    expect(boardPoolAddition(id("codex"), "gpt-6.1-sol", catalog, [{ model: native }], true))
      .toEqual({ kind: "selection", selection: selection("codex", "gpt-6.1-sol", [
        { id: "reasoningEffort", value: "xhigh" },
      ]) });
  });

  it("labels the native effort Reasoning and exposes only that option for pools", () => {
    const selected = selection("claudeAgent", "claude-opus-5-5");
    const models = boardTraitModels(catalog[1]!.models, selected, true);
    expect(models[0]?.capabilities?.optionDescriptors).toMatchObject([
      { id: "effort", label: "Reasoning" },
    ]);
  });
});
