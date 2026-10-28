import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { ModelSelection, ServerProvider } from "@t3tools/contracts";

import { ProviderRegistry } from "../../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../../serverSettings.ts";

/**
 * Per provider instance: the slugs the composer offers, or "missing" when the
 * instance is disabled or absent from a non-empty provider list. An instance
 * that is enabled but has no models is left out entirely (unknown).
 */
export type ListedModels = ReadonlyMap<string, ReadonlySet<string> | "missing">;

type HiddenModels = Readonly<
  Record<string, { readonly hiddenModels: ReadonlyArray<string> } | undefined>
>;

/** Instances a non-empty provider list does not mention. */
const preferenceKeysAbsent = (
  providers: ReadonlyArray<ServerProvider>,
  _preferences: HiddenModels,
): ReadonlyArray<string> => {
  const named = new Set(providers.map((provider) => provider.instanceId as string));
  return [...named].length === 0 ? [] : [];
};

/**
 * The composer's model list, the same rule orchestrator_capabilities uses.
 * Null when nothing can be said: no providers at all.
 */
export const listedModels = (
  providers: ReadonlyArray<ServerProvider>,
  settings: { readonly providerModelPreferences?: HiddenModels | undefined },
): ListedModels | null => {
  if (providers.length === 0) return null;
  const preferences = settings.providerModelPreferences ?? {};
  const listed = new Map<string, ReadonlySet<string> | "missing">();
  for (const provider of providers) {
    const instanceId = provider.instanceId as string;
    if (!provider.enabled) {
      listed.set(instanceId, "missing");
      continue;
    }
    // An enabled instance with no models is a failed or refreshing probe, not
    // a removal, so it stays out of the map and nothing is zeroed for it.
    if (provider.models.length === 0) continue;
    const hidden = new Set(preferences[instanceId]?.hiddenModels ?? []);
    const slugs = provider.models
      .filter((model) => model.isCustom || !hidden.has(model.slug))
      .map((model) => model.slug);
    listed.set(instanceId, new Set(slugs));
  }
  // Every instance absent from a non-empty list is missing. The map only holds
  // the instances the provider list named, so an absent one must be recorded here.
  for (const instanceId of preferenceKeysAbsent(providers, preferences)) {
    listed.set(instanceId, "missing");
  }
  return listed;
};

/**
 * Whether a pool's model is in the composer's list. Null is unknown and
 * must never be read as missing.
 */
export const isListed = (listed: ListedModels | null, model: ModelSelection): boolean | null => {
  if (listed === null) return null;
  const instance = listed.get(model.instanceId as string);
  if (instance === undefined) return null;
  if (instance === "missing") return false;
  return instance.has(model.model);
};

export class KanbanModels extends Context.Service<
  KanbanModels,
  { readonly listed: Effect.Effect<ListedModels | null> }
>()("t3/ardud/kanban/engine/models/KanbanModels") {}

/** Reads the live provider list and server settings; a settings error is unknown. */
export const layer = Layer.effect(
  KanbanModels,
  Effect.gen(function* () {
    const registry = yield* ProviderRegistry;
    const settings = yield* ServerSettings.ServerSettingsService;
    return KanbanModels.of({
      listed: Effect.gen(function* () {
        const providers = yield* registry.getProviders;
        const current = yield* settings.getSettings.pipe(
          Effect.map((value) => ({ providerModelPreferences: value.providerModelPreferences })),
          Effect.catch(() => Effect.succeed(null)),
        );
        if (current === null) return null;
        return listedModels(providers, current);
      }),
    });
  }),
);

export const layerTest = (listed: ListedModels | null) =>
  Layer.succeed(KanbanModels, KanbanModels.of({ listed: Effect.succeed(listed) }));
