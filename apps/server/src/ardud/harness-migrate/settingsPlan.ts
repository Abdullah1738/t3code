import type {
  ModelFavorite as ModelFavoriteSchema,
  ModelSelection,
  ProviderInstanceId,
  ServerSettings,
  ServerSettingsPatch,
} from "@t3tools/contracts";

type ModelFavorite = typeof ModelFavoriteSchema.Type;

import { planSelection, type SelectionPlan } from "./selectionPlan.ts";

const OVERRIDE_FIELDS = [
  "defaultModelSelection",
  "sourceControlWriterModelSelection",
  "reviewGuideModelSelection",
] as const;
type OverrideField = (typeof OVERRIDE_FIELDS)[number];

export const projectOverrideRef = (projectId: string, field: OverrideField): string =>
  `projectSettingsOverrides:${encodeURIComponent(projectId)}:${field}`;

export const parseProjectOverrideRef = (ref: string): { projectId: string; field: OverrideField } | null => {
  const [prefix, id, field, ...extra] = ref.split(":");
  if (prefix !== "projectSettingsOverrides" || !id || !field || extra.length !== 0 ||
      !OVERRIDE_FIELDS.some((candidate) => candidate === field)) return null;
  try {
    return { projectId: decodeURIComponent(id), field: field as OverrideField };
  } catch {
    return null;
  }
};

/**
 * One settings field the migration rewrites. `before` and `after` are the whole field: a list,
 * a map, or one selection. A ledger row restores the field as a whole, never an element of it.
 */
export interface SettingsChange {
  readonly field: string;
  readonly before: unknown;
  readonly after: unknown;
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
    changes.push({ field, before: selection, after: plan.next });
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

  // Favorites: the whole list is one ledger field, so a rollback restores the list as it was,
  // never one element of it. An unmapped favorite comes back unchanged.
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
      return { provider: plan.next.instanceId as ProviderInstanceId, model: plan.next.model };
    });
    if (favoritesChanged) {
      patch.favorites = favorites;
      changes.push({ field: "favorites", before: settings.favorites, after: favorites });
    }
  }

  // Hidden models: a hidden slug that maps is copied to the new instance; the old entry stays, so
  // nothing a user hid is lost. The whole map is one ledger field.
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
      const written = next as NonNullable<ServerSettingsPatch["providerModelPreferences"]>;
      patch.providerModelPreferences = written;
      changes.push({
        field: "providerModelPreferences",
        before: settings.providerModelPreferences,
        after: written,
      });
    }
  }

  // Per-project overrides: one ledger field per project and selection, holding that selection only.
  // textGenerationModelSelection stays.
  const overrides = settings.projectSettingsOverrides;
  const nextOverrides: Record<string, Record<string, unknown>> = {};
  let overridesChanged = false;
  for (const [projectId, override] of Object.entries(overrides)) {
    const projectFields: Record<string, unknown> = {};
    for (const field of OVERRIDE_FIELDS) {
      const current = override[field];
      const fieldPath = projectOverrideRef(projectId, field);
      const selection = withSelection(changes, conflicts, fieldPath, current);
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
