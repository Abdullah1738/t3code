import { ImageUpIcon, MinusIcon, PlusIcon, RepeatIcon, Trash2Icon } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { useAtomValue } from "@effect/atom-react";

import {
  boardModelSelection,
  modelName,
  poolAddLevel,
  poolListed,
  poolViews,
  type KanbanBoardState,
} from "@t3tools/client-runtime/ardud/kanban";
import {
  effortOptionId,
  mergeSelection,
  resolveSelection,
  selectionEffort,
} from "@t3tools/client-runtime/ardud/models/harnessRouting";
import {
  KANBAN_BOARD_ICONS,
  KANBAN_BOARD_IMAGE_MAX,
  kanbanBoardIcon,
  type KanbanBoard,
  type KanbanBoardIcon,
  type KanbanInstructions,
  type ModelSelection,
  type ProviderInstanceId,
  type ProviderOptionSelection,
  type ServerProviderModel,
  type ServerProvider,
  type EnvironmentId,
  KANBAN_WS_METHODS,
} from "@t3tools/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  createModelSelection,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";
import type { UnifiedSettings } from "@t3tools/contracts/settings";

import { Switch } from "../../components/ui/switch";
import { cn } from "../../lib/utils";
import { BOARD_ICONS, BoardIcon } from "./boardIcon";
import { kanban, runAction, useKanbanPermission } from "./kanbanStore";
import { toastManager } from "../../components/ui/toast";
import { Chip } from "./parts";
import {
  currentSlots,
  editedSlots,
  failedSlot,
  observeSlots,
  sendPoolSlots,
  sentSlots,
  type SlotWrites,
} from "./slotCount";
import { ProviderModelPicker } from "../../components/chat/ProviderModelPicker";
import { TraitsPicker } from "../../components/chat/TraitsPicker";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { getProviderModelCapabilities } from "../../providerModels";

type SelectionResult = ReturnType<typeof mergeSelection>;
type ModelCatalog = ReadonlyArray<Pick<ProviderInstanceEntry, "instanceId" | "models">>;

const selectionConflict = (reason: string): SelectionResult => ({ kind: "conflict", reason });

/** Resolve only after checking the source: E1 deliberately drops incompatible options when mapping. */
export function checkedBoardSelection(selection: ModelSelection, catalog: ModelCatalog): SelectionResult {
  const seen = new Set<string>();
  const nativeEffort = effortOptionId(selection.instanceId);
  for (const option of selection.options ?? []) {
    if (seen.has(option.id)) return selectionConflict(`Option ${option.id} is specified more than once.`);
    seen.add(option.id);
    if (["variant", "effort", "reasoningEffort"].includes(option.id) &&
        option.id !== "variant" && option.id !== nativeEffort) {
      return selectionConflict(`Option ${option.id} is not an effort option for ${selection.instanceId}.`);
    }
  }
  const folded = mergeSelection(selection, {});
  if (folded.kind === "conflict") return folded;
  const resolved = resolveSelection(folded.selection);
  if (resolved.kind === "conflict") return resolved;
  if (resolved.kind === "mapped") {
    const lost = (folded.selection.options ?? []).find(
      (option) => option.id !== nativeEffort && option.id !== "variant" &&
        !resolved.selection.options?.some((carried) => carried.id === option.id && carried.value === option.value),
    );
    if (lost) return selectionConflict(`Routing would discard option ${lost.id}.`);
  }
  const target = resolved.selection;
  const model = catalog.find((entry) => entry.instanceId === target.instanceId)?.models
    .find((entry) => entry.slug === target.model);
  if (!model) return selectionConflict(`${target.instanceId}/${target.model} is not in the model list.`);
  const descriptors = model.capabilities?.optionDescriptors ?? [];
  for (const option of target.options ?? []) {
    const descriptor = descriptors.find((entry) => entry.id === option.id);
    if (!descriptor || (descriptor.type === "boolean"
      ? typeof option.value !== "boolean"
      : typeof option.value !== "string" || !descriptor.options.some((choice) => choice.id === option.value))) {
      return selectionConflict(`${target.model} does not offer ${option.id} ${String(option.value)}.`);
    }
  }
  return { kind: "selection", selection: target };
}

/** Change a target without carrying options to a different model or instance. */
export function boardModelChange(
  base: ModelSelection,
  instanceId: ProviderInstanceId,
  model: string,
  catalog: ModelCatalog,
  apply: boolean,
): SelectionResult {
  if (!apply) return { kind: "selection", selection: boardModelSelection({ instanceId, model }) };
  const checkedBase = mergeSelection(base, {});
  if (checkedBase.kind === "conflict") return checkedBase;
  const routedBase = resolveSelection(checkedBase.selection);
  if (routedBase.kind === "conflict") return routedBase;
  const target = checkedBoardSelection(boardModelSelection({ instanceId, model }), catalog);
  if (target.kind === "conflict") return target;
  const same = routedBase.selection.instanceId === target.selection.instanceId &&
    routedBase.selection.model === target.selection.model;
  if (!same) return target;
  const preserved = checkedBoardSelection(base, catalog);
  if (preserved.kind === "conflict") return preserved;
  const effort = selectionEffort(target.selection);
  const merged = mergeSelection(preserved.selection, effort === null ? {} : { variant: effort });
  return merged.kind === "conflict" ? merged : checkedBoardSelection(merged.selection, catalog);
}

/** Only explicit edits from TraitsPicker replace options; its implicit defaults are display-only. */
export function boardTraitsChange(
  base: ModelSelection,
  displayed: ReadonlyArray<ProviderOptionSelection> | undefined,
  next: ReadonlyArray<ProviderOptionSelection> | undefined,
  catalog: ModelCatalog,
): SelectionResult {
  const checked = mergeSelection(base, {});
  if (checked.kind === "conflict") return checked;
  const validBase = checkedBoardSelection(base, catalog);
  if (validBase.kind === "conflict") return validBase;
  const before = new Map((displayed ?? []).map((option) => [option.id, option.value]));
  const after = new Map((next ?? []).map((option) => [option.id, option.value]));
  if (after.size !== (next?.length ?? 0)) return selectionConflict("An option is specified more than once.");
  const changed = new Set([...before.keys(), ...after.keys()].filter((id) => before.get(id) !== after.get(id)));
  const nativeEffort = effortOptionId(base.instanceId);
  const effortChanged = changed.has(nativeEffort) || changed.has("variant");
  const options = [
    ...(base.options ?? []).filter((option) => !changed.has(option.id) &&
      !(effortChanged && (option.id === nativeEffort || option.id === "variant"))),
    ...(next ?? []).filter((option) => changed.has(option.id)),
  ];
  const suppliedEffort = options.some((option) => option.id === nativeEffort || option.id === "variant");
  const model = effortChanged && suppliedEffort ? checked.selection.model : base.model;
  const merged = mergeSelection({ ...base, model }, { options });
  return merged.kind === "conflict" ? merged : checkedBoardSelection(merged.selection, catalog);
}

/** A pool level change keeps its secondary options and never changes the pool's model. */
export function boardPoolLevelChange(
  base: ModelSelection,
  effort: string | null,
  catalog: ModelCatalog,
): SelectionResult {
  const checked = mergeSelection(base, {});
  if (checked.kind === "conflict") return checked;
  const validBase = checkedBoardSelection(base, catalog);
  if (validBase.kind === "conflict") return validBase;
  const merged = mergeSelection(base, { variant: effort });
  if (merged.kind === "conflict") return merged;
  const result = checkedBoardSelection(merged.selection, catalog);
  if (result.kind === "selection" &&
      (result.selection.instanceId !== base.instanceId || result.selection.model !== base.model)) {
    return selectionConflict("Migrate this pool before changing its reasoning level.");
  }
  return result;
}

/** Find an unoccupied level after mapping, so adding an alias cannot pause an existing pool. */
export function boardPoolAddition(
  instanceId: ProviderInstanceId,
  model: string,
  catalog: ModelCatalog,
  pools: ReadonlyArray<{ readonly model: ModelSelection }>,
  apply: boolean,
): SelectionResult | null {
  if (!apply) {
    const level = poolAddLevel(instanceId, catalog.find((entry) => entry.instanceId === instanceId)?.models ?? [],
      model, pools.filter((pool) => pool.model.instanceId === instanceId && pool.model.model === model)
        .map((pool) => selectionEffort(pool.model)));
    return level === null ? null : { kind: "selection", selection: boardModelSelection({ instanceId, model, variant: level.variant }) };
  }
  const target = checkedBoardSelection(boardModelSelection({ instanceId, model }), catalog);
  if (target.kind === "conflict") return target;
  const existing: Array<string | null> = [];
  for (const pool of pools) {
    const resolved = resolveSelection(pool.model);
    if (resolved.kind === "conflict") return resolved;
    if (resolved.selection.instanceId === target.selection.instanceId && resolved.selection.model === target.selection.model) {
      if (resolved.kind === "mapped") {
        return selectionConflict("Migrate the existing pool before adding another reasoning level.");
      }
      existing.push(selectionEffort(resolved.selection));
    }
  }
  const level = poolAddLevel(target.selection.instanceId,
    catalog.find((entry) => entry.instanceId === target.selection.instanceId)?.models ?? [],
    target.selection.model, existing);
  if (level === null) return null;
  return checkedBoardSelection(boardModelSelection({
    instanceId: target.selection.instanceId, model: target.selection.model, variant: level.variant,
  }), catalog);
}

/** The pool picker edits reasoning only; other options stay attached to the pool. */
export function boardTraitModels(
  models: ReadonlyArray<ServerProviderModel>,
  selection: ModelSelection,
  effortOnly: boolean,
): ReadonlyArray<ServerProviderModel> {
  const effortId = effortOptionId(selection.instanceId);
  return models.map((model) => {
    if (model.slug !== selection.model || !model.capabilities?.optionDescriptors) return model;
    return {
      ...model,
      capabilities: {
        ...model.capabilities,
        optionDescriptors: model.capabilities.optionDescriptors
          .filter((descriptor) => !effortOnly || descriptor.id === effortId)
          .map((descriptor) => descriptor.id === effortId ? { ...descriptor, label: "Reasoning" } : descriptor),
      },
    };
  });
}

function reportSelectionConflict(result: SelectionResult): ModelSelection | null {
  if (result.kind === "selection") return result.selection;
  toastManager.add({ type: "error", title: "Couldn't change the model", description: result.reason });
  return null;
}

// Past this many slots the row shows "busy of slots" as text instead of squares.
const SLOT_SQUARES_MAX = 16;

export function SettingsView(props: { state: KanbanBoardState }) {
  const environmentId = usePrimaryEnvironmentId();
  if (environmentId === null) return null;
  return <SettingsBody environmentId={environmentId} state={props.state} />;
}

function SettingsBody(props: { environmentId: EnvironmentId; state: KanbanBoardState }) {
  const { environmentId, state } = props;
  const board = state.board;
  const pools = poolViews(state);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const settings = useEnvironmentSettings(environmentId);
  const apply = settings.ardudHarnessMigration?.selections === "apply";
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings, null),
  );
  const update = (input: Omit<Parameters<typeof kanban.updateBoard>[0], "boardId">) =>
    void runAction("Couldn't save", () => kanban.updateBoard({ boardId: board.id, ...input }));
  const canEdit = useKanbanPermission(KANBAN_WS_METHODS.boardUpdate);
  const canPool = useKanbanPermission(KANBAN_WS_METHODS.poolSet);
  // The level "Add model" gives a new pool; null when every level of it is pooled.
  const addLevel = (instanceId: ProviderInstanceId, model: string) =>
    boardPoolAddition(instanceId, model, instanceEntries, pools, apply);
  const editNote = canEdit ? undefined : "Your connection can't change the board";
  const poolNote = canPool ? undefined : "Your connection can't change pools";

  return (
    <div className="flex max-w-225 flex-col gap-5.5 pb-12">
      <Section title="Icon">
        <IconPicker
          board={board}
          disabled={!canEdit}
          disabledReason={editNote}
          onChange={(icon) => update({ icon, iconImage: null })}
          onImage={(iconImage) => update({ iconImage })}
        />
      </Section>
      <Section title="Pools">
        {pools.map((pool) => {
          const listed = poolListed(pool.model, providers, settings);
          const unlisted = listed === false;
          const blocked = !canPool || unlisted;
          const blockedReason = unlisted ? "This model is no longer in the model list" : poolNote;
          const entry = instanceEntries.find(
            (candidate) => candidate.instanceId === pool.model.instanceId,
          );
          const effort = selectionEffort(pool.model);
          return (
            <div
              key={pool.key}
              className="grid min-h-12.5 grid-cols-[minmax(90px,130px)_auto_1fr_auto_auto_auto] items-center gap-4.5 py-1.5 not-last:border-b not-last:border-(--m-rule)"
            >
              <span className="flex min-w-0 flex-col">
                <span className="flex min-w-0 items-baseline gap-1.5">
                  <span className="truncate font-medium">{pool.name}</span>
                  {effort && (!entry || unlisted) ? (
                    <span className="text-xs text-(--m-muted)">{effort}</span>
                  ) : null}
                </span>
                {unlisted ? (
                  <span className="text-xs text-(--m-muted)">Not in model list</span>
                ) : null}
              </span>
              <span className="flex min-w-0 items-center">
                {entry && !unlisted ? (
                  <TraitsPicker
                    provider={entry.driverKind}
                    instanceId={pool.model.instanceId}
                    models={apply ? boardTraitModels(entry.models, pool.model, true) : entry.models}
                    model={pool.model.model}
                    prompt=""
                    onPromptChange={() => {}}
                    modelOptions={pool.model.options ?? []}
                    allowPromptInjectedEffort={false}
                    planModeEnabled={settings.planModeEnabled}
                    disabled={blocked}
                    onModelOptionsChange={(options) => {
                      const level = selectionEffort(
                        createModelSelection(pool.model.instanceId, pool.model.model, options),
                      );
                      if (level === effort) return;
                      const next = apply
                        ? reportSelectionConflict(boardPoolLevelChange(pool.model, level, instanceEntries))
                        : boardModelSelection({ instanceId: pool.model.instanceId, model: pool.model.model, variant: level });
                      if (!next) return;
                      void runAction("Couldn't change the pool's level", () =>
                        kanban.setPool(
                          board.id,
                          next,
                          undefined,
                          { replaces: pool.key },
                        ),
                      );
                    }}
                  />
                ) : null}
              </span>
              <span
                className="flex flex-wrap gap-1"
                role="img"
                aria-label={`${pool.busy} of ${pool.slots} busy`}
              >
                {pool.slots > SLOT_SQUARES_MAX ? (
                  <span className="text-xs text-(--m-muted) tabular-nums">
                    {pool.busy} of {pool.slots} busy
                  </span>
                ) : (
                  Array.from({ length: pool.slots }, (_, index) => (
                    <i
                      key={index}
                      className={cn(
                        "size-3.5 rounded-sm",
                        index < pool.busy ? "bg-(--m-accent)" : "bg-(--m-bar-4)",
                      )}
                    />
                  ))
                )}
              </span>
              <Stepper
                label={`${pool.name} slots`}
                value={pool.slots}
                min={0}
                max={unlisted ? 0 : undefined}
                disabled={blocked}
                disabledReason={blockedReason}
                onChange={(slots, dropped) =>
                  sendPoolSlots(
                    board.id,
                    pool.key,
                    slots,
                    (value) =>
                      runAction("Couldn't change the pool", () =>
                        kanban.setPool(board.id, pool.model, value, { replaces: pool.key }),
                      ),
                    dropped,
                  )
                }
              />
              <Switch
                size="sm"
                checked={pool.slots > 0}
                // An unlisted pool can always be paused (switch off); switching it on is refused.
                disabled={!canPool || (unlisted && pool.slots === 0)}
                title={blockedReason}
                aria-label={`${pool.name} pool on`}
                onCheckedChange={(on) =>
                  sendPoolSlots(board.id, pool.key, on ? Math.max(1, pool.busy) : 0, (value) =>
                    runAction("Couldn't change the pool", () =>
                      kanban.setPool(board.id, pool.model, value, { replaces: pool.key }),
                    ),
                  )
                }
              />
              {pool.slots === 0 && pool.busy === 0 && canPool ? (
                <button
                  type="button"
                  aria-label={`Remove ${pool.name} pool`}
                  title="Remove pool"
                  onClick={() =>
                    void runAction("Couldn't remove the pool", () =>
                      kanban.removePool(board.id, pool.model, { replaces: pool.key }),
                    )
                  }
                  className="grid size-7 place-items-center rounded-full text-(--m-muted) outline-none hover:bg-(--m-chip) hover:text-(--m-text) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)"
                >
                  <Trash2Icon aria-hidden className="size-3.5" />
                </button>
              ) : (
                <span aria-hidden className="size-7" />
              )}
            </div>
          );
        })}
        <div className="flex h-12.5 items-center justify-between gap-4 py-1.5">
          <span className="text-sm text-(--m-muted)">Add model</span>
          <ProviderModelPicker
            environmentId={environmentId}
            activeInstanceId={instanceEntries[0]?.instanceId ?? ("" as ProviderInstanceId)}
            model=""
            triggerLabel="Add model"
            lockedProvider={null}
            instanceEntries={instanceEntries}
            modelOptionsByInstance={getCustomModelOptionsByInstance(
              settings,
              providers,
              instanceEntries[0]?.instanceId ?? null,
              null,
            )}
            disabled={!canPool}
            getModelDisabledReason={(instanceId, model) =>
              addLevel(instanceId, model) === null ? "Already in pools" : null
            }
            onInstanceModelChange={(instanceId, model) => {
              const level = addLevel(instanceId, model);
              if (level === null) return;
              const selection = reportSelectionConflict(level);
              if (!selection) return;
              void runAction("Couldn't add the model", () =>
                kanban.setPool(board.id, selection, 0),
              );
            }}
          />
        </div>
      </Section>
      <Section title="Models">
        <ModelPickerRow
          label="Board manager"
          value={board.managerModel}
          environmentId={environmentId}
          instanceEntries={instanceEntries}
          settings={settings}
          providers={providers}
          apply={apply}
          disabled={!canEdit}
          disabledReason={editNote}
          onChange={(managerModel) => update({ managerModel })}
        />
        <ModelPickerRow
          label="Evaluator"
          value={board.evaluatorModel}
          environmentId={environmentId}
          instanceEntries={instanceEntries}
          settings={settings}
          providers={providers}
          apply={apply}
          disabled={!canEdit}
          disabledReason={editNote}
          onChange={(evaluatorModel) => update({ evaluatorModel })}
        />
        <ModelPickerRow
          label="New cards"
          value={board.defaultCardModel}
          environmentId={environmentId}
          instanceEntries={instanceEntries}
          settings={settings}
          providers={providers}
          apply={apply}
          disabled={!canEdit}
          disabledReason={editNote}
          onChange={(defaultCardModel) => update({ defaultCardModel })}
        />
      </Section>
      <Section title="Review">
        {board.reviewChains.map((chain, chainIndex) => {
          const isDefault = chain.name === board.defaultReviewChain;
          // Each step edit sends the whole chain list in one updateBoard. The server validates
          // every step on every write, so the write is only atomic if it carries every change.
          const saveStep = (index: number, next: ModelSelection) =>
            update({
              reviewChains: board.reviewChains.map((c, ci) =>
                ci === chainIndex
                  ? { ...c, steps: c.steps.map((s, si) => (si === index ? next : s)) }
                  : c,
              ),
            });
          return (
            <div
              key={chain.name}
              className="flex min-h-13 flex-wrap items-center gap-x-4 gap-y-2 py-2 not-last:border-b not-last:border-(--m-rule)"
            >
              <span className="w-24 font-medium">{chain.name}</span>
              <span className="flex flex-1 flex-wrap items-center gap-1.5">
                {chain.steps.map((step, index) => (
                  <span key={`${step.model}:${index}`} className="flex items-center gap-1.5">
                    {index > 0 ? <span className="text-(--m-muted)">→</span> : null}
                    <ProviderModelPicker
                      environmentId={environmentId}
                      activeInstanceId={step.instanceId}
                      model={step.model}
                      lockedProvider={null}
                      instanceEntries={instanceEntries}
                      modelOptionsByInstance={getCustomModelOptionsByInstance(
                        settings,
                        providers,
                        step.instanceId,
                        step.model,
                      )}
                      disabled={!canEdit}
                      triggerLabel={modelName(step)}
                      onInstanceModelChange={(nextInstanceId, model) => {
                        const next = reportSelectionConflict(boardModelChange(step, nextInstanceId, model, instanceEntries, apply));
                        if (next) saveStep(index, next);
                      }}
                    />
                    {(() => {
                      const entry = instanceEntries.find(
                        (candidate) => candidate.instanceId === step.instanceId,
                      );
                      const models = entry && apply ? boardTraitModels(entry.models, step, false) : entry?.models;
                      const displayed = entry && models && apply
                        ? buildProviderOptionSelectionsFromDescriptors(getProviderOptionDescriptors({
                            caps: getProviderModelCapabilities(models, step.model, entry.driverKind, settings.planModeEnabled),
                            selections: step.options,
                          }))
                        : undefined;
                      return entry && models ? (
                        <TraitsPicker
                          provider={entry.driverKind}
                          instanceId={step.instanceId}
                          models={models}
                          model={step.model}
                          prompt=""
                          onPromptChange={() => {}}
                          modelOptions={step.options ?? []}
                          allowPromptInjectedEffort={false}
                          planModeEnabled={settings.planModeEnabled}
                          disabled={!canEdit}
                          onModelOptionsChange={(options) => {
                            const next = apply
                              ? reportSelectionConflict(boardTraitsChange(step, displayed, options, instanceEntries))
                              : createModelSelection(step.instanceId, step.model, options);
                            if (next) saveStep(index, next);
                          }}
                        />
                      ) : null;
                    })()}
                  </span>
                ))}
                <span className="flex items-center gap-1 text-xs text-(--m-muted)">
                  <RepeatIcon className="size-3.5" aria-hidden />
                  until clear
                </span>
              </span>
              {isDefault ? (
                <Chip className="bg-(--m-band) text-(--m-accent-text)">Default</Chip>
              ) : (
                <button
                  type="button"
                  disabled={!canEdit}
                  title={editNote}
                  onClick={() => update({ defaultReviewChain: chain.name })}
                  className="h-7 rounded-full px-2.5 text-sm font-medium text-(--m-muted) outline-none hover:text-(--m-text) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)"
                >
                  Make default
                </button>
              )}
            </div>
          );
        })}
      </Section>
      <Section title="Instructions" plain>
        <Instructions
          board={board}
          disabled={!canEdit}
          disabledReason={editNote}
          onSave={(instructions) => update({ instructions })}
        />
      </Section>
    </div>
  );
}

const IMAGE_SIZE = 96;

/** Squares and shrinks a picked file so it fits on the board record. */
async function boardImage(file: File): Promise<string | null> {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return null;
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = IMAGE_SIZE;
  canvas.height = IMAGE_SIZE;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    IMAGE_SIZE,
    IMAGE_SIZE,
  );
  bitmap.close();
  for (const [type, quality] of [
    ["image/webp", 0.9],
    ["image/png", undefined],
    ["image/jpeg", 0.85],
  ] as const) {
    const url = canvas.toDataURL(type, quality);
    if (url.startsWith(`data:${type};`) && url.length <= KANBAN_BOARD_IMAGE_MAX) return url;
  }
  return null;
}

function IconPicker(props: {
  board: KanbanBoard;
  disabled: boolean;
  disabledReason: string | undefined;
  onChange: (icon: KanbanBoardIcon | null) => void;
  onImage: (image: string | null) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const image = props.board.iconImage;
  const current = image ? undefined : kanbanBoardIcon(props.board);
  const option = (icon: KanbanBoardIcon | null, label: string, mark: ReactNode) => (
    <button
      key={icon ?? "none"}
      type="button"
      aria-label={label}
      aria-pressed={current === icon}
      disabled={props.disabled}
      title={props.disabledReason}
      onClick={() => {
        if (current !== icon) props.onChange(icon);
      }}
      className={cn(
        "grid size-9 place-items-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)",
        current === icon
          ? "bg-(--m-band) text-(--m-accent-text)"
          : "text-(--m-muted) hover:bg-(--m-chip) hover:text-(--m-text)",
      )}
    >
      {mark}
    </button>
  );
  return (
    <div className="flex flex-wrap gap-1 py-2" role="group" aria-label="Board icon">
      {option(
        null,
        "No icon, show the first letter",
        <BoardIcon board={{ ...props.board, icon: null }} />,
      )}
      {KANBAN_BOARD_ICONS.map((icon) => {
        const Icon = BOARD_ICONS[icon];
        return option(icon, icon, <Icon aria-hidden className="size-4.5" />);
      })}
      <button
        type="button"
        aria-label={image ? "Change the picture" : "Upload a picture"}
        aria-pressed={image !== null}
        disabled={props.disabled}
        title={props.disabledReason}
        onClick={() => fileInput.current?.click()}
        className={cn(
          "grid size-9 place-items-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)",
          image ? "bg-(--m-band)" : "text-(--m-muted) hover:bg-(--m-chip) hover:text-(--m-text)",
        )}
      >
        {image ? (
          <img alt="" src={image} className="size-5.5 rounded-sm object-cover" />
        ) : (
          <ImageUpIcon aria-hidden className="size-4.5" />
        )}
      </button>
      {image ? (
        <button
          type="button"
          disabled={props.disabled}
          title={props.disabledReason}
          onClick={() => props.onImage(null)}
          className="h-9 rounded-lg px-2.5 text-sm font-medium text-(--m-muted) outline-none hover:text-(--m-text) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)"
        >
          Remove picture
        </button>
      ) : null}
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="hidden"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (!file) return;
          void boardImage(file).then((url) => {
            if (url) props.onImage(url);
            else toastManager.add({ type: "error", title: "Couldn't use that picture" });
          });
        }}
      />
    </div>
  );
}

function Section(props: { title: string; plain?: boolean; children: ReactNode }) {
  return (
    <section className="grid gap-3 md:grid-cols-[180px_1fr] md:gap-6">
      <h3 className="text-base font-semibold md:pt-3">{props.title}</h3>
      <div className={props.plain ? undefined : "rounded-2xl bg-(--m-surface) px-4.5 py-1.5"}>
        {props.children}
      </div>
    </section>
  );
}

function Stepper(props: {
  label: string;
  value: number;
  min: number;
  max?: number | undefined;
  disabled?: boolean;
  disabledReason?: string | undefined;
  onChange: (value: number, dropped: () => void) => void;
}) {
  // Typing keeps a draft; it commits on blur or Enter, Escape drops it.
  const [draft, setDraft] = useState<string | null>(null);
  const [writes, setWrites] = useState<SlotWrites>(() => ({ feed: props.value, sent: [] }));
  const observed = observeSlots(writes, props.value);
  if (observed !== writes) setWrites(observed);
  const nextId = useRef(0);
  const edited = useRef(false);
  const cancelled = useRef(false);
  const current = currentSlots(observed);
  const typed = draft !== null && /^\d+$/.test(draft.trim()) ? Number(draft.trim()) : current;
  const base = Number.isSafeInteger(typed) ? typed : current;
  const atMax = base >= (props.max ?? Number.MAX_SAFE_INTEGER);
  const send = (next: number) => {
    const id = ++nextId.current;
    setWrites((state) => sentSlots(observeSlots(state, props.value), { id, value: next }));
    props.onChange(next, () => setWrites((state) => failedSlot(state, id)));
  };
  // While typing, the buttons step the draft, so a click never races the typed number.
  const step = (by: number) => {
    const next = Math.max(
      props.min,
      props.max === undefined ? base + by : Math.min(props.max, base + by),
    );
    if (!Number.isSafeInteger(next)) return;
    if (draft === null) send(next);
    else {
      edited.current = true;
      setDraft(String(next));
    }
  };
  return (
    <span
      role="group"
      aria-label={props.label}
      title={props.disabledReason}
      className="inline-flex items-center gap-0.5 rounded-full bg-(--m-raised) p-0.5"
    >
      <button
        type="button"
        aria-label="Fewer"
        disabled={props.disabled || base <= props.min}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => step(-1)}
        className="grid size-6.5 place-items-center rounded-full text-(--m-text) outline-none hover:bg-(--m-chip) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent) disabled:opacity-35"
      >
        <MinusIcon className="size-3.5" />
      </button>
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        aria-label={`${props.label} count`}
        value={draft ?? String(current)}
        disabled={props.disabled}
        onFocus={(event) => {
          edited.current = false;
          setDraft(String(current));
          event.currentTarget.select();
        }}
        onChange={(event) => {
          edited.current = true;
          setDraft(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            cancelled.current = true;
            event.currentTarget.blur();
          }
        }}
        onBlur={() => {
          const next =
            cancelled.current || draft === null
              ? null
              : editedSlots(draft, edited.current, current, props.min, props.max);
          cancelled.current = false;
          edited.current = false;
          setDraft(null);
          if (next !== null) send(next);
        }}
        className="w-9 rounded-md bg-transparent text-center text-sm font-medium tabular-nums text-(--m-text) outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)"
      />
      <button
        type="button"
        aria-label="More"
        disabled={props.disabled || atMax}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => step(1)}
        className="grid size-6.5 place-items-center rounded-full text-(--m-text) outline-none hover:bg-(--m-chip) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent) disabled:opacity-35"
      >
        <PlusIcon className="size-3.5" />
      </button>
    </span>
  );
}

/** A board model choice driven by the composer's own picker and effort/variant control. */
function ModelPickerRow(props: {
  label: string;
  value: ModelSelection;
  environmentId: EnvironmentId | null;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  settings: UnifiedSettings;
  providers: ReadonlyArray<ServerProvider>;
  apply: boolean;
  disabled: boolean;
  disabledReason: string | undefined;
  onChange: (model: ModelSelection) => void;
}) {
  const instanceId = props.value.instanceId;
  const modelOptions = getCustomModelOptionsByInstance(
    props.settings,
    props.providers,
    instanceId,
    props.value.model,
  );
  const entry = props.instanceEntries.find((candidate) => candidate.instanceId === instanceId);
  const models = entry && props.apply ? boardTraitModels(entry.models, props.value, false) : entry?.models;
  const displayed = entry && models && props.apply
    ? buildProviderOptionSelectionsFromDescriptors(getProviderOptionDescriptors({
        caps: getProviderModelCapabilities(models, props.value.model, entry.driverKind, props.settings.planModeEnabled),
        selections: props.value.options,
      }))
    : undefined;
  return (
    <div className="flex min-h-13 flex-wrap items-center justify-between gap-x-4 gap-y-2 py-1.5 not-last:border-b not-last:border-(--m-rule)">
      <span className="font-medium">{props.label}</span>
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
        <ProviderModelPicker
          environmentId={props.environmentId}
          activeInstanceId={instanceId}
          model={props.value.model}
          lockedProvider={null}
          instanceEntries={props.instanceEntries}
          modelOptionsByInstance={modelOptions}
          disabled={props.disabled}
          triggerLabel={modelName(props.value)}
          onInstanceModelChange={(nextInstanceId, model) => {
            const next = reportSelectionConflict(boardModelChange(props.value, nextInstanceId, model, props.instanceEntries, props.apply));
            if (next) props.onChange(next);
          }}
        />
        {entry && models ? (
          <TraitsPicker
            provider={entry.driverKind}
            instanceId={instanceId}
            models={models}
            model={props.value.model}
            prompt=""
            onPromptChange={() => {}}
            modelOptions={props.value.options ?? []}
            allowPromptInjectedEffort={false}
            planModeEnabled={props.settings.planModeEnabled}
            disabled={props.disabled}
            onModelOptionsChange={(options) => {
              const next = props.apply
                ? reportSelectionConflict(boardTraitsChange(props.value, displayed, options, props.instanceEntries))
                : createModelSelection(instanceId, props.value.model, options);
              if (next) props.onChange(next);
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

const INSTRUCTION_FIELDS: ReadonlyArray<{ key: keyof KanbanInstructions; label: string }> = [
  { key: "modelRouting", label: "Model routing" },
  { key: "reviewerRouting", label: "Reviewer routing" },
  { key: "escalation", label: "When to ask me" },
];

function Instructions(props: {
  board: KanbanBoard;
  disabled: boolean;
  disabledReason: string | undefined;
  onSave: (instructions: KanbanInstructions) => void;
}) {
  return (
    <div className="grid gap-2.5 lg:grid-cols-3">
      {INSTRUCTION_FIELDS.map((field) => (
        <InstructionBlock
          key={`${field.key}:${props.board.instructions[field.key]}`}
          label={field.label}
          value={props.board.instructions[field.key]}
          disabled={props.disabled}
          disabledReason={props.disabledReason}
          onSave={(text) => props.onSave({ ...props.board.instructions, [field.key]: text })}
        />
      ))}
    </div>
  );
}

function InstructionBlock(props: {
  label: string;
  value: string;
  disabled: boolean;
  disabledReason: string | undefined;
  onSave: (text: string) => void;
}) {
  const [draft, setDraft] = useState(props.value);
  return (
    <label className="flex flex-col gap-1.5 rounded-xl bg-(--m-surface) px-3.5 pt-3 pb-2">
      <span className="text-sm font-semibold">{props.label}</span>
      <textarea
        value={draft}
        disabled={props.disabled}
        title={props.disabledReason}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft !== props.value) props.onSave(draft);
        }}
        rows={6}
        className="min-h-28 resize-y bg-transparent text-sm leading-normal text-(--m-text) outline-none [field-sizing:content] placeholder:text-(--m-muted)"
      />
    </label>
  );
}
