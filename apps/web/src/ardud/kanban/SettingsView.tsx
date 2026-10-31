import { ImageUpIcon, MinusIcon, PlusIcon, RepeatIcon, Trash2Icon } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { useAtomValue } from "@effect/atom-react";

import {
  boardModelSelection,
  modelName,
  modelVariant,
  poolAddLevel,
  poolListed,
  poolViews,
  type KanbanBoardState,
} from "@t3tools/client-runtime/ardud/kanban";
import {
  KANBAN_BOARD_ICONS,
  KANBAN_BOARD_IMAGE_MAX,
  kanbanBoardIcon,
  type KanbanBoard,
  type KanbanBoardIcon,
  type KanbanInstructions,
  type ModelSelection,
  type ProviderInstanceId,
  type ServerProvider,
  type EnvironmentId,
  KANBAN_WS_METHODS,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import type { UnifiedSettings } from "@t3tools/contracts/settings";

import { Switch } from "../../components/ui/switch";
import { cn } from "../../lib/utils";
import { BOARD_ICONS, BoardIcon } from "./boardIcon";
import { kanban, runAction, useKanbanPermission } from "./kanbanStore";
import { toastManager } from "../../components/ui/toast";
import { Chip } from "./parts";
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

const MAX_SLOTS = 8;

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
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings, null),
  );
  const update = (input: Omit<Parameters<typeof kanban.updateBoard>[0], "boardId">) =>
    void runAction("Couldn't save", () => kanban.updateBoard({ boardId: board.id, ...input }));
  const canEdit = useKanbanPermission(KANBAN_WS_METHODS.boardUpdate);
  const canPool = useKanbanPermission(KANBAN_WS_METHODS.poolSet);
  // The level "Add model" gives a new pool; null when every level of it is pooled.
  const addLevel = (instanceId: ProviderInstanceId, model: string) =>
    poolAddLevel(
      instanceId,
      instanceEntries.find((entry) => entry.instanceId === instanceId)?.models ?? [],
      model,
      pools
        .filter((pool) => pool.model.instanceId === instanceId && pool.model.model === model)
        .map((pool) => pool.variant),
    );
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
          return (
            <div
              key={pool.key}
              className="grid min-h-12.5 grid-cols-[minmax(90px,130px)_auto_1fr_auto_auto_auto] items-center gap-4.5 py-1.5 not-last:border-b not-last:border-(--m-rule)"
            >
              <span className="flex min-w-0 flex-col">
                <span className="flex min-w-0 items-baseline gap-1.5">
                  <span className="truncate font-medium">{pool.name}</span>
                  {pool.variant && (!entry || unlisted) ? (
                    <span className="text-xs text-(--m-muted)">{pool.variant}</span>
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
                    models={entry.models}
                    model={pool.model.model}
                    prompt=""
                    onPromptChange={() => {}}
                    modelOptions={pool.model.options ?? []}
                    allowPromptInjectedEffort={false}
                    planModeEnabled={settings.planModeEnabled}
                    disabled={blocked}
                    onModelOptionsChange={(options) => {
                      // Only the level is the pool's; the picker's other options (agent) aren't stored.
                      const variant = modelVariant(
                        createModelSelection(pool.model.instanceId, pool.model.model, options),
                      );
                      if (variant === pool.variant) return;
                      void runAction("Couldn't change the pool's level", () =>
                        kanban.setPool(
                          board.id,
                          boardModelSelection({
                            instanceId: pool.model.instanceId,
                            model: pool.model.model,
                            variant,
                          }),
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
                {Array.from({ length: pool.slots }, (_, index) => (
                  <i
                    key={index}
                    className={cn(
                      "size-3.5 rounded-sm",
                      index < pool.busy ? "bg-(--m-accent)" : "bg-(--m-bar-4)",
                    )}
                  />
                ))}
              </span>
              <Stepper
                label={`${pool.name} slots`}
                value={pool.slots}
                min={0}
                max={unlisted ? 0 : MAX_SLOTS}
                disabled={blocked}
                disabledReason={blockedReason}
                onChange={(slots) =>
                  void runAction("Couldn't change the pool", () =>
                    kanban.setPool(board.id, pool.model, slots, { replaces: pool.key }),
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
                  void runAction("Couldn't change the pool", () =>
                    kanban.setPool(board.id, pool.model, on ? Math.max(1, pool.busy) : 0, {
                      replaces: pool.key,
                    }),
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
              void runAction("Couldn't add the model", () =>
                kanban.setPool(
                  board.id,
                  boardModelSelection({ instanceId, model, variant: level.variant }),
                  0,
                ),
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
                      onInstanceModelChange={(nextInstanceId, model) =>
                        saveStep(index, boardModelSelection({ instanceId: nextInstanceId, model }))
                      }
                    />
                    {(() => {
                      const entry = instanceEntries.find(
                        (candidate) => candidate.instanceId === step.instanceId,
                      );
                      return entry ? (
                        <TraitsPicker
                          provider={entry.driverKind}
                          instanceId={step.instanceId}
                          models={entry.models}
                          model={step.model}
                          prompt=""
                          onPromptChange={() => {}}
                          modelOptions={step.options ?? []}
                          allowPromptInjectedEffort={false}
                          planModeEnabled={settings.planModeEnabled}
                          disabled={!canEdit}
                          onModelOptionsChange={(options) =>
                            saveStep(
                              index,
                              createModelSelection(step.instanceId, step.model, options),
                            )
                          }
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
  max: number;
  disabled?: boolean;
  disabledReason?: string | undefined;
  onChange: (value: number) => void;
}) {
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
        disabled={props.disabled || props.value <= props.min}
        onClick={() => props.onChange(props.value - 1)}
        className="grid size-6.5 place-items-center rounded-full text-(--m-text) outline-none hover:bg-(--m-chip) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent) disabled:opacity-35"
      >
        <MinusIcon className="size-3.5" />
      </button>
      <span className="w-5 text-center text-sm font-medium tabular-nums">{props.value}</span>
      <button
        type="button"
        aria-label="More"
        disabled={props.disabled || props.value >= props.max}
        onClick={() => props.onChange(props.value + 1)}
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
          onInstanceModelChange={(nextInstanceId, model) =>
            props.onChange(boardModelSelection({ instanceId: nextInstanceId, model }))
          }
        />
        {entry ? (
          <TraitsPicker
            provider={entry.driverKind}
            instanceId={instanceId}
            models={entry.models}
            model={props.value.model}
            prompt=""
            onPromptChange={() => {}}
            modelOptions={props.value.options ?? []}
            allowPromptInjectedEffort={false}
            planModeEnabled={props.settings.planModeEnabled}
            disabled={props.disabled}
            onModelOptionsChange={(options) =>
              props.onChange(createModelSelection(instanceId, props.value.model, options))
            }
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
