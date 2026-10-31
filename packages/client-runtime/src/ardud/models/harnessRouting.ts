/**
 * One driver-aware map from OpenCode model ids to Claude Code / Codex selections.
 *
 * Pure functions only, shared by the server (kanban rules, control API) and the
 * clients (board view model). A selection's effort lives in the option its
 * instance names: "effort" for Claude, "reasoningEffort" for Codex, and "variant"
 * for OpenCode and everything else.
 */
import type { ModelSelection, ProviderInstanceId, ProviderOptionSelection } from "@t3tools/contracts";

/** Version of HARNESS_MAP. Bump it when a row changes, so stored mappings can be traced. */
export const HARNESS_MAP_VERSION = 1;

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

const CLAUDE = "claudeAgent";
const CODEX = "codex";
const CODEX_CU = "codex-cu";

/** The exact legacy OpenCode ids and the route each one moves to. Anything else is unchanged. */
export const HARNESS_MAP: ReadonlyArray<HarnessMapRow> = [
  {
    from: { instanceId: "opencode", model: "opus/claude-opus-5-5" },
    to: { instanceId: CLAUDE, model: "claude-opus-5-5", effortOptionId: "effort" },
  },
  {
    from: { instanceId: "opencode", model: "opus/claude-sonnet-5-5" },
    to: { instanceId: CLAUDE, model: "claude-sonnet-5-5", effortOptionId: "effort" },
  },
  {
    // Old alias for the same Sonnet route.
    from: { instanceId: "opencode", model: "opus/claude-sonnet-5" },
    to: { instanceId: CLAUDE, model: "claude-sonnet-5-5", effortOptionId: "effort" },
  },
  {
    from: { instanceId: "opencode", model: "opus/cc/claude-haiku-5-5" },
    to: { instanceId: CLAUDE, model: "claude-haiku-5-5", effortOptionId: "effort" },
  },
  {
    from: { instanceId: "opencode", model: "opus/cx/gpt-6.1-sol" },
    to: { instanceId: CODEX, model: "gpt-6.1-sol", effortOptionId: "reasoningEffort" },
  },
  {
    from: { instanceId: "opencode", model: "opus/gpt-6-astra" },
    to: { instanceId: CODEX, model: "gpt-6-astra", effortOptionId: "reasoningEffort" },
  },
  {
    // Computer use only.
    from: { instanceId: "opencode", model: "opus/cx/gpt-6.1-terra" },
    to: { instanceId: CODEX_CU, model: "gpt-6.1-terra", effortOptionId: "reasoningEffort" },
  },
  {
    // The old provider-block fallback.
    from: { instanceId: "layso", model: "gpt-6-astra" },
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

/** Which option holds a selection's effort. Claude uses "effort", Codex "reasoningEffort", the rest "variant". */
export function effortOptionId(instanceId: string): EffortOptionId {
  if (instanceId === CLAUDE) return "effort";
  if (instanceId === CODEX || instanceId === CODEX_CU) return "reasoningEffort";
  return "variant";
}

/** The effort a selection carries in its own instance's option, or null. */
export function selectionEffort(
  selection: {
    readonly instanceId: string;
    readonly options?: ReadonlyArray<ProviderOptionSelection> | undefined;
  } | null,
): string | null {
  if (selection === null) return null;
  const id = effortOptionId(selection.instanceId);
  const value = selection.options?.find((option) => option.id === id)?.value;
  return typeof value === "string" ? value : null;
}

const LEGACY_SUFFIX = /^(.+)#([A-Za-z0-9][A-Za-z0-9_-]*)$/;

/** Splits a trailing `#<word>` off a model id ("…#xhigh" → effort "xhigh"). Other ids are untouched. */
export function splitLegacySuffix(model: string): { model: string; effort: string | null } {
  const match = LEGACY_SUFFIX.exec(model);
  if (!match) return { model, effort: null };
  return { model: match[1] ?? model, effort: match[2] ?? null };
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

function optionString(
  options: ReadonlyArray<ProviderOptionSelection> | undefined,
  id: string,
): string | null {
  const value = options?.find((option) => option.id === id)?.value;
  return typeof value === "string" ? value : null;
}

/**
 * Routes one selection through HARNESS_MAP. A legacy `#effort` suffix and the variant
 * option must agree, or the selection is a conflict and nothing is guessed. Resolving
 * a selection that is already mapped returns it unchanged.
 */
export function resolveSelection(selection: ModelSelection): SelectionResolution {
  const split = splitLegacySuffix(selection.model);
  const row = ROWS_BY_SOURCE.get(rowKey(selection.instanceId, split.model));
  if (row === undefined) return { kind: "unchanged", selection };

  const variant = optionString(selection.options, "variant");
  if (split.effort !== null && variant !== null && variant !== split.effort) {
    return {
      kind: "conflict",
      reason: `${selection.model} says effort ${split.effort} but its variant option is ${variant}`,
    };
  }
  const effort = split.effort ?? variant;
  const carried = (selection.options ?? []).filter((option) =>
    (CARRIED_OPTIONS[row.to.instanceId] ?? []).includes(option.id),
  );
  const options: Array<ProviderOptionSelection> = [
    ...(effort === null ? [] : [{ id: row.to.effortOptionId, value: effort }]),
    ...carried,
  ];
  const mapped: ModelSelection = {
    instanceId: row.to.instanceId as ProviderInstanceId,
    model: row.to.model,
    ...(options.length > 0 ? { options } : {}),
  } as ModelSelection;
  return {
    kind: "mapped",
    selection: mapped,
    from: { instanceId: row.from.instanceId, model: row.from.model },
    effort,
  };
}

/**
 * A partial selection update. Omitted `options` inherit only when the instance and
 * model stay the same. An explicit `options` list replaces them, and `[]` clears them.
 * `variant` is the compatibility field: a string sets the target's effort, null clears it.
 */
export interface SelectionPatch {
  readonly instanceId?: string | undefined;
  readonly model?: string | undefined;
  readonly options?: ReadonlyArray<ProviderOptionSelection> | undefined;
  readonly variant?: string | null | undefined;
}

/**
 * Applies a patch to a selection. For a Claude or Codex target a compatibility variant
 * becomes that target's effort option and replaces any existing effort, so the result
 * never holds both a variant and an effort.
 */
export function mergeSelection(base: ModelSelection, patch: SelectionPatch): ModelSelection {
  const instanceId = patch.instanceId ?? base.instanceId;
  const model = patch.model ?? base.model;
  const sameTarget = instanceId === base.instanceId && model === base.model;
  const start: ReadonlyArray<ProviderOptionSelection> =
    patch.options !== undefined ? patch.options : sameTarget ? (base.options ?? []) : [];

  const effortId = effortOptionId(instanceId);
  const native = effortId === "variant";
  // A variant on a Claude or Codex target is a compatibility effort, and beats an effort in the same list.
  const compat =
    patch.variant !== undefined
      ? patch.variant
      : native
        ? undefined
        : optionString(start, "variant") ?? undefined;
  const rest = start.filter(
    (option) => option.id !== effortId && (native || option.id !== "variant"),
  );
  const effortEntry = start.findLast((option) => option.id === effortId);
  const value = compat !== undefined ? compat : (effortEntry?.value ?? null);
  const options: ReadonlyArray<ProviderOptionSelection> =
    value === null ? rest : [...rest, { id: effortId, value }];
  return {
    instanceId,
    model,
    ...(options.length > 0 ? { options } : {}),
  } as ModelSelection;
}
