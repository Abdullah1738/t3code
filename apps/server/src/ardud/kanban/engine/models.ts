import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { ModelSelection, ServerProvider } from "@t3tools/contracts";

import { ProviderRegistry } from "../../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../../serverSettings.ts";

/**
 * Per provider instance id:
 * - a Set of the slugs the composer offers;
 * - "missing": the instance is disabled (an instance absent from a non-empty
 *   list is also missing; `isListed` reads that from the lookup miss);
 * - "unknown": the instance is enabled but has no models (a failed or
 *   refreshing probe). Never read as missing.
 */
export type ListedModelEntry = ReadonlySet<string> | "missing" | "unknown";
export type ListedModels = ReadonlyMap<string, ListedModelEntry>;

type HiddenModels = Readonly<
  Record<string, { readonly hiddenModels: ReadonlyArray<string> } | undefined>
>;

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
  const listed = new Map<string, ListedModelEntry>();
  for (const provider of providers) {
    const instanceId = provider.instanceId as string;
    if (!provider.enabled) {
      listed.set(instanceId, "missing");
      continue;
    }
    if (provider.models.length === 0) {
      listed.set(instanceId, "unknown");
      continue;
    }
    const hidden = new Set(preferences[instanceId]?.hiddenModels ?? []);
    const slugs = provider.models
      .filter((model) => model.isCustom || !hidden.has(model.slug))
      .map((model) => model.slug);
    listed.set(instanceId, new Set(slugs));
  }
  return listed;
};

/**
 * Whether a pool's model is in the composer's list. Null is unknown and must
 * never be read as missing. An instance a non-empty list does not name is missing.
 */
export const isListed = (listed: ListedModels | null, model: ModelSelection): boolean | null => {
  if (listed === null) return null;
  const entry = listed.get(model.instanceId as string);
  if (entry === undefined || entry === "missing") return false;
  if (entry === "unknown") return null;
  return entry.has(model.model);
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
