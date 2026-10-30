import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { boardModelSelection, poolListed } from "./viewModel.ts";

const id = (value: string) => ProviderInstanceId.make(value);
const provider = (
  instanceId: string,
  models: ReadonlyArray<{ slug: string; isCustom?: boolean }>,
  enabled = true,
) => ({ instanceId: id(instanceId), enabled, models });
const at = (instanceId: string, model: string) => ({ instanceId: id(instanceId), model });

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
