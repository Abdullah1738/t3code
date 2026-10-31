import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { boardModelSelection, poolAddLevel, poolListed } from "./viewModel.ts";

const id = (value: string) => ProviderInstanceId.make(value);
const provider = (
  instanceId: string,
  models: ReadonlyArray<{ slug: string; isCustom?: boolean }>,
  enabled = true,
) => ({ instanceId: id(instanceId), enabled, models });
const at = (instanceId: string, model: string) => ({ instanceId: id(instanceId), model });

describe("poolAddLevel", () => {
  const select = (currentValue: string | undefined, isDefault: string | null) => ({
    id: "variant",
    type: "select" as const,
    ...(currentValue ? { currentValue } : {}),
    options: ["low", "high", "max"].map((value) =>
      value === isDefault ? { id: value, isDefault: true } : { id: value },
    ),
  });
  const models = [
    { slug: "a", capabilities: { optionDescriptors: [select("high", "low")] } },
    { slug: "b", capabilities: { optionDescriptors: [select(undefined, "max")] } },
    // Like the live "opus" provider: levels, but no default among them.
    { slug: "c", capabilities: { optionDescriptors: [select(undefined, null)] } },
    { slug: "d", capabilities: { optionDescriptors: [] } },
  ];

  it("adds a new model at the provider's default level, or none", () => {
    expect(poolAddLevel(models, "a", [])).toEqual({ variant: "high" });
    expect(poolAddLevel(models, "b", [])).toEqual({ variant: "max" });
    expect(poolAddLevel(models, "c", [])).toEqual({ variant: null });
    expect(poolAddLevel(models, "d", [])).toEqual({ variant: null });
  });

  it("adds a pooled model at a level none of its pools has, never with no level", () => {
    expect(poolAddLevel(models, "a", ["low"])).toEqual({ variant: "high" });
    expect(poolAddLevel(models, "a", ["high"])).toEqual({ variant: "low" });
    expect(poolAddLevel(models, "c", ["max"])).toEqual({ variant: "low" });
    expect(poolAddLevel(models, "c", [null])).toEqual({ variant: "low" });
  });

  it("has nothing to add once every level is pooled, or for a pooled model with no levels", () => {
    expect(poolAddLevel(models, "a", ["low", "high", "max"])).toBeNull();
    expect(poolAddLevel(models, "d", [null])).toBeNull();
  });
});

describe("boardModelSelection", () => {
  it("keeps the variant as the board's variant option", () => {
    expect(
      boardModelSelection({ instanceId: id("opencode"), model: "m", variant: "xhigh" }),
    ).toEqual({
      instanceId: "opencode",
      model: "m",
      options: [{ id: "variant", value: "xhigh" }],
    });
  });

  it("omits options when the picker has no variant", () => {
    expect(boardModelSelection({ instanceId: id("codex"), model: "gpt", variant: null })).toEqual({
      instanceId: "codex",
      model: "gpt",
    });
  });
});

describe("poolListed", () => {
  const providers = [
    provider("codex", [{ slug: "gpt-a" }, { slug: "gpt-hidden" }]),
    provider("claude", [{ slug: "opus" }], false),
  ];

  it("is listed when the instance is enabled and offers the slug", () => {
    expect(poolListed(at("codex", "gpt-a"), providers, {})).toBe(true);
  });

  it("is not listed when the model is hidden in settings", () => {
    const settings = { providerModelPreferences: { codex: { hiddenModels: ["gpt-hidden"] } } };
    expect(poolListed(at("codex", "gpt-hidden"), providers, settings)).toBe(
      false,
    );
  });

  it("stays listed when a custom model is hidden", () => {
    const withCustom = [provider("codex", [{ slug: "my-custom", isCustom: true }])];
    const settings = { providerModelPreferences: { codex: { hiddenModels: ["my-custom"] } } };
    expect(poolListed(at("codex", "my-custom"), withCustom, settings)).toBe(
      true,
    );
  });

  it("is not listed when the instance is disabled", () => {
    expect(poolListed(at("claude", "opus"), providers, {})).toBe(false);
  });

  it("is not listed when the instance is absent from a non-empty list", () => {
    expect(poolListed(at("cursor", "x"), providers, {})).toBe(false);
  });

  it("is not listed when the instance doesn't offer the slug", () => {
    expect(poolListed(at("codex", "gone"), providers, {})).toBe(false);
  });

  it("is unknown when there are no providers yet", () => {
    expect(poolListed(at("codex", "gpt-a"), [], {})).toBe(null);
  });

  it("is unknown when an enabled instance has no models yet", () => {
    const probing = [provider("codex", [])];
    expect(poolListed(at("codex", "gpt-a"), probing, {})).toBe(null);
  });
});
