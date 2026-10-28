import { assert, it } from "@effect/vitest";

import type { ModelSelection, ServerProvider } from "@t3tools/contracts";

import { isListed, listedModels } from "./models.ts";

const provider = (
  instanceId: string,
  slugs: ReadonlyArray<string>,
  overrides: { readonly enabled?: boolean; readonly customSlugs?: ReadonlyArray<string> } = {},
): ServerProvider =>
  ({
    instanceId,
    driver: instanceId,
    enabled: overrides.enabled ?? true,
    models: slugs.map((slug) => ({
      slug,
      name: slug,
      isCustom: overrides.customSlugs?.includes(slug) ?? false,
    })),
  }) as unknown as ServerProvider;

const select = (instanceId: string, model: string): ModelSelection =>
  ({ instanceId, model }) as unknown as ModelSelection;

const noHidden = {};

it("lists a model the provider offers", () => {
  const listed = listedModels([provider("opencode", ["opus/a"])], noHidden);
  assert.strictEqual(isListed(listed, select("opencode", "opus/a")), true);
});

it("treats a hidden model as missing", () => {
  const listed = listedModels([provider("opencode", ["opus/a", "opus/b"])], {
    providerModelPreferences: { opencode: { hiddenModels: ["opus/b"] } },
  });
  assert.strictEqual(isListed(listed, select("opencode", "opus/b")), false);
  assert.strictEqual(isListed(listed, select("opencode", "opus/a")), true);
});

it("keeps a hidden custom model listed", () => {
  const listed = listedModels([provider("opencode", ["my/custom"], { customSlugs: ["my/custom"] })], {
    providerModelPreferences: { opencode: { hiddenModels: ["my/custom"] } },
  });
  assert.strictEqual(isListed(listed, select("opencode", "my/custom")), true);
});

it("treats a disabled instance as missing", () => {
  const listed = listedModels([provider("opencode", ["opus/a"], { enabled: false })], noHidden);
  assert.strictEqual(isListed(listed, select("opencode", "opus/a")), false);
});

it("treats an instance absent from a non-empty provider list as missing", () => {
  const listed = listedModels([provider("other", ["x"])], noHidden);
  assert.strictEqual(isListed(listed, select("opencode", "opus/a")), false);
});

it("returns null when there are no providers", () => {
  assert.strictEqual(listedModels([], noHidden), null);
  assert.strictEqual(isListed(null, select("opencode", "opus/a")), null);
});

it("treats an enabled instance with no models as unknown", () => {
  const listed = listedModels([provider("opencode", [])], noHidden);
  assert.strictEqual(isListed(listed, select("opencode", "opus/a")), null);
});
