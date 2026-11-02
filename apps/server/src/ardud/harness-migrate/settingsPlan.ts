import type {
  ModelFavorite as ModelFavoriteSchema,
  ModelSelection,
  ProviderInstanceId,
  ServerSettings,
  ServerSettingsPatch,
} from "@t3tools/contracts";

type ModelFavorite = typeof ModelFavoriteSchema.Type;

import { planSelection, type SelectionPlan } from "./selectionPlan.ts";

/** One settings field the migration rewrites: where it lives and what it becomes. */
export interface SettingsChange {
  readonly field: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly plan: Extract<SelectionPlan, { _tag: "mapped" }>;
}

/** Every change and conflict in the settings, computed without writing anything. */
export interface SettingsPlan {
  readonly changes: ReadonlyArray<SettingsChange>;
  readonly conflicts: ReadonlyArray<{ readonly field: string; readonly reason: string }>;
  /** The full patch to send to ServerSettingsService.updateSettings, or null when nothing changes. */
  readonly patch: ServerSettingsPatch | null;
}

const withSelection = (
  changes: Array<SettingsChange>,
  conflicts: Array<{ readonly field: string; readonly reason: string }>,
  field: string,
  selection: ModelSelection | null | undefined,
): ModelSelection | null | undefined => {
  if (selection === null || selection === undefined) return selection;
  const plan = planSelection(selection);
  if (plan._tag === "conflict") {
    conflicts.push({ field, reason: plan.reason });
    return selection;
  }
  if (plan._tag === "mapped") {
    changes.push({ field, before: selection, after: plan.next, plan });
    return plan.next;
  }
  return selection;
};

/**
 * Plans the settings rewrite. The card's list: default model, favorites (the field is
 * `provider`), provider model preferences (hidden models move only for mapped slugs),
 * source-control writer, review guide, and per-project overrides. `textGenerationModelSelection`
 * is never touched, since GLM stays on OpenCode.
 */
export const planSettings = (settings: ServerSettings): SettingsPlan => {
  const changes: Array<SettingsChange> = [];
  const conflicts: Array<{ readonly field: string; readonly reason: string }> = [];
  const patch: {
    -readonly [K in keyof ServerSettingsPatch]?: ServerSettingsPatch[K];
  } = {};

  const defaultSelection = withSelection(
    changes,
    conflicts,
    "defaultModelSelection",
    settings.defaultModelSelection,
  );
  if (defaultSelection !== settings.defaultModelSelection) {
    patch.defaultModelSelection = defaultSelection ?? null;
  }

  const writer = withSelection(
    changes,
    conflicts,
    "sourceControlWriterModelSelection",
    settings.sourceControlWriterModelSelection,
  );
  if (writer !== settings.sourceControlWriterModelSelection) {
    patch.sourceControlWriterModelSelection = writer ?? null;
  }

  const review = withSelection(
    changes,
    conflicts,
    "reviewGuideModelSelection",
    settings.reviewGuideModelSelection,
  );
  if (review !== settings.reviewGuideModelSelection) {
    patch.reviewGuideModelSelection = review ?? null;
  }

  // Favorites carry `provider` (the instance) and a model slug. Plan them as the selection
  // they name; an unmapped favorite comes back unchanged.
  if (settings.favorites !== null) {
    let favoritesChanged = false;
    const favorites: Array<ModelFavorite> = settings.favorites.map((favorite) => {
      const plan = planSelection({
        instanceId: favorite.provider,
        model: favorite.model,
      } as ModelSelection);
      if (plan._tag === "conflict") {
        conflicts.push({ field: "favorites", reason: plan.reason });
        return favorite;
      }
      if (plan._tag !== "mapped") return favorite;
      favoritesChanged = true;
      changes.push({
        field: "favorites",
        before: favorite,
        after: { provider: plan.next.instanceId, model: plan.next.model },
        plan,
      });
      return { provider: plan.next.instanceId as ProviderInstanceId, model: plan.next.model };
    });
    if (favoritesChanged) patch.favorites = favorites;
  }

  // A hidden slug that maps is copied to the new instance; the old entry stays as it was, so
  // nothing a user hid is lost. Unmapped entries are left untouched.
  if (settings.providerModelPreferences !== null) {
    const next: Record<string, { hiddenModels: Array<string>; modelOrder: Array<string> }> = {};
    for (const [instanceId, preference] of Object.entries(settings.providerModelPreferences)) {
      next[instanceId] = {
        hiddenModels: [...preference.hiddenModels],
        modelOrder: [...preference.modelOrder],
      };
    }
    let preferencesChanged = false;
    for (const [instanceId, preference] of Object.entries(settings.providerModelPreferences)) {
      for (const slug of preference.hiddenModels) {
        const plan = planSelection({ instanceId, model: slug } as ModelSelection);
        if (plan._tag !== "mapped") continue;
        const target = next[plan.next.instanceId] ?? { hiddenModels: [], modelOrder: [] };
        next[plan.next.instanceId] = target;
        if (!target.hiddenModels.includes(plan.next.model)) {
          target.hiddenModels.push(plan.next.model);
          preferencesChanged = true;
        }
      }
    }
    if (preferencesChanged) {
      patch.providerModelPreferences = next as NonNullable<
        ServerSettingsPatch["providerModelPreferences"]
      >;
    }
  }

  // Per-project overrides: only their three selection fields. textGenerationModelSelection stays.
  const overrides = settings.projectSettingsOverrides;
  const nextOverrides: Record<string, Record<string, unknown>> = {};
  let overridesChanged = false;
  for (const [projectId, override] of Object.entries(overrides)) {
    const projectFields: Record<string, unknown> = {};
    const fields = [
      "defaultModelSelection",
      "sourceControlWriterModelSelection",
      "reviewGuideModelSelection",
    ] as const;
    for (const field of fields) {
      const current = override[field];
      const selection = withSelection(
        changes,
        conflicts,
        `projectSettingsOverrides.${projectId}.${field}`,
        current,
      );
      if (selection !== current) {
        projectFields[field] = selection;
        overridesChanged = true;
      }
    }
    nextOverrides[projectId] = { ...override, ...projectFields };
  }
  if (overridesChanged) {
    patch.projectSettingsOverrides = nextOverrides as NonNullable<
      ServerSettingsPatch["projectSettingsOverrides"]
    >;
  }

  const hasPatch = Object.keys(patch).length > 0;
  return { changes, conflicts, patch: hasPatch ? (patch as ServerSettingsPatch) : null };
};
