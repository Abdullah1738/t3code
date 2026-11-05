/**
 * One driver-aware map from OpenCode model ids to Claude Code / Codex selections.
 *
 * Pure functions only, shared by the server (kanban rules, control API) and the
 * clients (board view model). A selection's effort lives in the option its instance
 * names: "effort" for Claude, "reasoningEffort" for Codex and codex-cu, and "variant"
 * for OpenCode and every other instance.
 */
import type {
  ModelSelection,
  ProviderInstanceId,
  ProviderOptionSelection,
} from "@t3tools/contracts";

/** Version of the mapping policy, so stored mappings can be traced. */
export const HARNESS_MAP_VERSION = 2;

export type EffortOptionId = "effort" | "reasoningEffort" | "variant";

export interface HarnessRoute {
  readonly instanceId: string;
  readonly model: string;
  readonly effortOptionId: EffortOptionId;
}

export interface HarnessMapRow {
  readonly from: { readonly instanceId: string; readonly model: string };
  readonly to: HarnessRoute;
}

const OPENCODE = "opencode";
const CLAUDE = "claudeAgent";
const CODEX = "codex";
const CODEX_CU = "codex-cu";

/** Verified legacy routes. An unlisted Claude/OpenAI id is a conflict, not a fallback. */
export const HARNESS_MAP: ReadonlyArray<HarnessMapRow> = [
  {
    from: { instanceId: OPENCODE, model: "opus/claude-opus-5-5" },
    to: { instanceId: CLAUDE, model: "claude-opus-5-5", effortOptionId: "effort" },
  },
  {
    from: { instanceId: OPENCODE, model: "opus/claude-sonnet-5-5" },
    to: { instanceId: CLAUDE, model: "claude-sonnet-5-5", effortOptionId: "effort" },
  },
  {
    // Old alias for the same Sonnet route.
    from: { instanceId: OPENCODE, model: "opus/claude-sonnet-5" },
    to: { instanceId: CLAUDE, model: "claude-sonnet-5-5", effortOptionId: "effort" },
  },
  {
    from: { instanceId: OPENCODE, model: "opus/cc/claude-haiku-5-5" },
    to: { instanceId: CLAUDE, model: "claude-haiku-5-5", effortOptionId: "effort" },
  },
  {
    from: { instanceId: OPENCODE, model: "opus/cx/gpt-6.1-sol" },
    to: { instanceId: CODEX, model: "gpt-6.1-sol", effortOptionId: "reasoningEffort" },
  },
  {
    from: { instanceId: OPENCODE, model: "opus/gpt-6-astra" },
    to: { instanceId: CODEX, model: "gpt-6-astra", effortOptionId: "reasoningEffort" },
  },
  {
    from: { instanceId: OPENCODE, model: "opus/cx/gpt-6.1-terra" },
    to: { instanceId: CODEX_CU, model: "gpt-6.1-terra", effortOptionId: "reasoningEffort" },
  },
  {
    // The old provider-block fallback.
    from: { instanceId: OPENCODE, model: "layso/gpt-6-astra" },
    to: { instanceId: CODEX, model: "gpt-6-astra", effortOptionId: "reasoningEffort" },
  },
];

/** Non-effort options that exist on the target, so they carry over. OpenCode-only ones drop. */
const CARRIED_OPTIONS: Readonly<Record<string, ReadonlyArray<string>>> = {
  [CLAUDE]: ["fastMode"],
  [CODEX]: ["serviceTier"],
  [CODEX_CU]: ["serviceTier"],
};

const rowKey = (instanceId: string, model: string) => `${instanceId}|${model}`;
const ROWS_BY_SOURCE = new Map(
  HARNESS_MAP.map((row) => [rowKey(row.from.instanceId, row.from.model), row] as const),
);

/** Which option holds a selection's effort: "effort" for Claude, "reasoningEffort" for Codex, "variant" otherwise. */
export function effortOptionId(instanceId: string): EffortOptionId {
  if (instanceId === CLAUDE) return "effort";
  if (instanceId === CODEX || instanceId === CODEX_CU) return "reasoningEffort";
  return "variant";
}

/** Option ids that can carry an effort on an instance. "variant" is always one, as the compatibility name. */
function effortIds(instanceId: string): ReadonlyArray<string> {
  const native = effortOptionId(instanceId);
  return native === "variant" ? ["variant"] : [native, "variant"];
}

/** Every option id that carries an effort, on any instance. */
const EFFORT_IDS: ReadonlyArray<string> = ["variant", "effort", "reasoningEffort"];

/** Family recognition is deliberately broader than the verified mapping table. */
export function openCodeModelFamily(model: string): "claude" | "openai" | null {
  const parts = splitLegacySuffix(model).model.split("/");
  if (parts.some((part) => /^(?:anthropic|cc)$|^claude(?:$|[-_.])/i.test(part))) return "claude";
  if (
    parts.some((part) => /^(?:openai|cx)$|^(?:gpt|chatgpt)(?:$|[-_.])|^o\d(?:$|[-_.])/i.test(part))
  ) {
    return "openai";
  }
  return null;
}

/**
 * An effort option (variant, effort, reasoningEffort) must hold a string. A boolean or other
 * value there is an invalid effort, and it must be reported rather than silently dropped. This
 * covers every effort id on any instance, so a stored or patched invalid effort never vanishes.
 */
function invalidEffort(options: ReadonlyArray<ProviderOptionSelection> | undefined): string | null {
  const bad = (options ?? []).find(
    (option) => EFFORT_IDS.includes(option.id) && typeof option.value !== "string",
  );
  return bad === undefined ? null : `${bad.id} must be a level name, not ${String(bad.value)}`;
}

/** The string values of the options named by `ids`, in order. */
function valuesOf(
  options: ReadonlyArray<ProviderOptionSelection> | undefined,
  ids: ReadonlyArray<string>,
): Array<string> {
  return (options ?? []).flatMap((option) =>
    ids.includes(option.id) && typeof option.value === "string" ? [option.value] : [],
  );
}

const unique = (values: ReadonlyArray<string>): Array<string> => [...new Set(values)];

/** The effort a selection carries in its own instance's option, or null. */
export function selectionEffort(
  selection: {
    readonly instanceId: string;
    readonly options?: ReadonlyArray<ProviderOptionSelection> | undefined;
  } | null,
): string | null {
  if (selection === null) return null;
  const [value] = valuesOf(selection.options, [effortOptionId(selection.instanceId)]);
  return value ?? null;
}

const LEGACY_SUFFIX = /^(.+)#([A-Za-z0-9][A-Za-z0-9_-]*)$/;

/** Splits a trailing `#<word>` off a model id ("…#xhigh" → effort "xhigh"). Other ids are untouched. */
export function splitLegacySuffix(model: string): { model: string; effort: string | null } {
  const match = LEGACY_SUFFIX.exec(model);
  if (!match) return { model, effort: null };
  return { model: match[1] ?? model, effort: match[2] ?? null };
}

/**
 * splitLegacySuffix, but only for an id that names a mapped route. Any other id keeps its
 * `#`, so the rest of the OpenCode catalog stays exactly as it is.
 */
function splitRouteSuffix(
  instanceId: string,
  model: string,
): { model: string; effort: string | null } {
  const split = splitLegacySuffix(model);
  if (split.effort === null || !ROWS_BY_SOURCE.has(rowKey(instanceId, split.model))) {
    return { model, effort: null };
  }
  return split;
}

export type SelectionResolution =
  | {
      readonly kind: "mapped";
      readonly selection: ModelSelection;
      readonly from: { readonly instanceId: string; readonly model: string };
      readonly effort: string | null;
    }
  | { readonly kind: "unchanged"; readonly selection: ModelSelection }
  | { readonly kind: "conflict"; readonly reason: string };

/**
 * Routes one selection through HARNESS_MAP. A legacy `#effort` suffix and the variant
 * option are the same effort: if they name different ones (or the variant is listed
 * twice with different values), the selection is a conflict and nothing is guessed.
 * A selection that is already mapped comes back unchanged.
 */
export function resolveSelection(selection: ModelSelection): SelectionResolution {
  // An invalid effort is refused on every route, mapped or not, so it is never passed on silently.
  const invalid = invalidEffort(selection.options);
  if (invalid !== null) return { kind: "conflict", reason: `${selection.model}: ${invalid}` };
  const split = splitRouteSuffix(selection.instanceId, selection.model);
  const row = ROWS_BY_SOURCE.get(rowKey(selection.instanceId, split.model));
  if (row === undefined) {
    const family = selection.instanceId === OPENCODE ? openCodeModelFamily(selection.model) : null;
    return family === null
      ? { kind: "unchanged", selection }
      : {
          kind: "conflict",
          reason: `No verified native harness mapping for OpenCode model ${selection.model}; select a model on ${family === "claude" ? CLAUDE : CODEX}.`,
        };
  }

  const efforts = unique([
    ...(split.effort === null ? [] : [split.effort]),
    ...valuesOf(selection.options, EFFORT_IDS),
  ]);
  if (efforts.length > 1) {
    return {
      kind: "conflict",
      reason: `${selection.model} names conflicting efforts: ${efforts.join(", ")}`,
    };
  }
  const effort = efforts[0] ?? null;
  const carried = (selection.options ?? []).filter((option) =>
    (CARRIED_OPTIONS[row.to.instanceId] ?? []).includes(option.id),
  );
  const options: Array<ProviderOptionSelection> = [
    ...(effort === null ? [] : [{ id: row.to.effortOptionId, value: effort }]),
    ...carried,
  ];
  return {
    kind: "mapped",
    selection: {
      instanceId: row.to.instanceId as ProviderInstanceId,
      model: row.to.model,
      ...(options.length > 0 ? { options } : {}),
    } as ModelSelection,
    from: { instanceId: row.from.instanceId, model: row.from.model },
    effort,
  };
}

/** For explicit requests only; inherited selections must still be routed lazily. */
export function postCutoverSelectionProblem(
  selection: Pick<ModelSelection, "instanceId" | "model">,
): string | null {
  if (selection.instanceId !== OPENCODE || openCodeModelFamily(selection.model) === null)
    return null;
  const resolved = resolveSelection(selection);
  if (resolved.kind === "conflict") return resolved.reason;
  if (resolved.kind === "unchanged") return null;
  return `OpenCode model ${selection.model} is unavailable after harness cutover; use ${resolved.selection.instanceId}/${resolved.selection.model} instead.`;
}

export type MergeResult =
  | { readonly kind: "selection"; readonly selection: ModelSelection }
  | { readonly kind: "conflict"; readonly reason: string };

/**
 * A partial selection update. `variant` is the compatibility name for the effort: a string
 * sets it, and null clears it.
 */
export interface SelectionPatch {
  readonly instanceId?: string | undefined;
  readonly model?: string | undefined;
  readonly options?: ReadonlyArray<ProviderOptionSelection> | undefined;
  readonly variant?: string | null | undefined;
}

const conflict = (reason: string): MergeResult => ({ kind: "conflict", reason });

/**
 * A stored selection with its legacy `#effort` suffix folded into its effort option, so the
 * merge rules see one effort. A suffix that disagrees with the option is a conflict.
 */
function foldSuffix(selection: ModelSelection): MergeResult {
  const invalid = invalidEffort(selection.options);
  if (invalid !== null) return conflict(`${selection.model}: ${invalid}`);
  const split = splitRouteSuffix(selection.instanceId, selection.model);
  if (split.effort === null) return { kind: "selection", selection };
  const efforts = unique([split.effort, ...valuesOf(selection.options, EFFORT_IDS)]);
  if (efforts.length > 1) {
    return conflict(`${selection.model} conflicts with its effort option: ${efforts.join(", ")}`);
  }
  const options: Array<ProviderOptionSelection> = [
    ...(selection.options ?? []).filter((option) => !EFFORT_IDS.includes(option.id)),
    { id: effortOptionId(selection.instanceId), value: split.effort },
  ];
  return {
    kind: "selection",
    selection: {
      instanceId: selection.instanceId,
      model: split.model,
      options,
    } as ModelSelection,
  };
}

/**
 * Applies a patch to a selection (validation-core 3.1). Omitted options inherit only for the
 * same instance and model; an explicit list replaces them, and [] clears them. Every effort
 * the patch supplies must agree: its options, its compatibility variant and a legacy suffix on
 * its model. Two different values are a conflict, never a pick. A supplied effort replaces the
 * inherited one, and variant null clears it.
 */
export function mergeSelection(base: ModelSelection, patch: SelectionPatch): MergeResult {
  const folded = foldSuffix(base);
  if (folded.kind === "conflict") return folded;
  const start = folded.selection;

  const invalidPatch = invalidEffort(patch.options);
  if (invalidPatch !== null) return conflict(invalidPatch);
  const instanceId = patch.instanceId ?? start.instanceId;
  const named = splitRouteSuffix(instanceId, patch.model ?? start.model);
  const model = named.model;
  const sameTarget = instanceId === start.instanceId && model === start.model;
  const ids = effortIds(instanceId);

  const supplied = unique([
    ...(named.effort === null ? [] : [named.effort]),
    ...valuesOf(patch.options, ids),
    ...(typeof patch.variant === "string" ? [patch.variant] : []),
  ]);
  if (supplied.length > 1) {
    return conflict(`${model} is given conflicting efforts: ${supplied.join(", ")}`);
  }
  if (patch.variant === null && supplied.length > 0) {
    return conflict(`${model} clears its effort and sets it in one patch`);
  }

  const inherited =
    patch.options === undefined && sameTarget ? unique(valuesOf(start.options, ids)) : [];
  if (inherited.length > 1) {
    return conflict(`${model} already holds conflicting efforts: ${inherited.join(", ")}`);
  }
  const effort = supplied[0] ?? (patch.variant === null ? null : (inherited[0] ?? null));

  const source = patch.options ?? (sameTarget ? (start.options ?? []) : []);
  const carried = source.filter((option) => !ids.includes(option.id));
  const options: Array<ProviderOptionSelection> =
    effort === null ? carried : [...carried, { id: effortOptionId(instanceId), value: effort }];
  return {
    kind: "selection",
    selection: {
      instanceId: instanceId as ProviderInstanceId,
      model,
      ...(options.length > 0 ? { options } : {}),
    } as ModelSelection,
  };
}
