import { ImageUpIcon, MinusIcon, PlusIcon, RepeatIcon } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import {
  modelName,
  modelVariant,
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
  KANBAN_WS_METHODS,
} from "@t3tools/contracts";

import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "../../components/ui/menu";
import { Switch } from "../../components/ui/switch";
import { cn } from "../../lib/utils";
import { BOARD_ICONS, BoardIcon } from "./boardIcon";
import { kanban, runAction, useKanbanPermission } from "./kanbanStore";
import { toastManager } from "../../components/ui/toast";
import { Chip } from "./parts";

const MAX_SLOTS = 8;

export function SettingsView(props: { state: KanbanBoardState }) {
  const { state } = props;
  const board = state.board;
  const pools = poolViews(state);
  const models = state.pools.map((pool) => pool.model);
  const update = (input: Omit<Parameters<typeof kanban.updateBoard>[0], "boardId">) =>
    void runAction("Couldn't save", () => kanban.updateBoard({ boardId: board.id, ...input }));
  const canEdit = useKanbanPermission(KANBAN_WS_METHODS.boardUpdate);

  return (
    <div className="flex max-w-225 flex-col gap-5.5 pb-12">
      <Section title="Icon">
        <IconPicker
          board={board}
          onChange={(icon) => update({ icon, iconImage: null })}
          onImage={(iconImage) => update({ iconImage })}
        />
      </Section>
      <Section title="Pools">
        {pools.map((pool) => (
          <div
            key={pool.key}
            className="grid h-12.5 grid-cols-[minmax(90px,130px)_1fr_auto_auto] items-center gap-4.5 not-last:border-b not-last:border-(--m-rule)"
          >
            <span className="flex min-w-0 items-baseline gap-1.5">
              <span className="truncate font-medium">{pool.name}</span>
              {pool.variant ? (
                <span className="text-xs text-(--m-muted)">{pool.variant}</span>
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
              max={MAX_SLOTS}
              onChange={(slots) =>
                void runAction("Couldn't change the pool", () =>
                  kanban.setPool(board.id, pool.model, slots),
                )
              }
            />
            <Switch
              size="sm"
              checked={pool.slots > 0}
              aria-label={`${pool.name} pool on`}
              onCheckedChange={(on) =>
                void runAction("Couldn't change the pool", () =>
                  kanban.setPool(board.id, pool.model, on ? Math.max(1, pool.busy) : 0),
                )
              }
            />
          </div>
        ))}
      </Section>
      <Section title="Models">
        <ModelRow
          label="Board manager"
          value={board.managerModel}
          models={models}
          onChange={(managerModel) => update({ managerModel })}
        />
        <ModelRow
          label="Evaluator"
          value={board.evaluatorModel}
          models={models}
          onChange={(evaluatorModel) => update({ evaluatorModel })}
        />
        <ModelRow
          label="New cards"
          value={board.defaultCardModel}
          models={models}
          onChange={(defaultCardModel) => update({ defaultCardModel })}
        />
      </Section>
      <Section title="Review">
        {board.reviewChains.map((chain) => {
          const isDefault = chain.name === board.defaultReviewChain;
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
                    <Chip>
                      {modelName(step)}
                      {modelVariant(step) ? (
                        <span className="text-(--m-muted)">{modelVariant(step)}</span>
                      ) : null}
                    </Chip>
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
        <Instructions board={board} onSave={(instructions) => update({ instructions })} />
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
  onChange: (value: number) => void;
}) {
  return (
    <span
      role="group"
      aria-label={props.label}
      className="inline-flex items-center gap-0.5 rounded-full bg-(--m-raised) p-0.5"
    >
      <button
        type="button"
        aria-label="Fewer"
        disabled={props.value <= props.min}
        onClick={() => props.onChange(props.value - 1)}
        className="grid size-6.5 place-items-center rounded-full text-(--m-text) outline-none hover:bg-(--m-chip) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent) disabled:opacity-35"
      >
        <MinusIcon className="size-3.5" />
      </button>
      <span className="w-5 text-center text-sm font-medium tabular-nums">{props.value}</span>
      <button
        type="button"
        aria-label="More"
        disabled={props.value >= props.max}
        onClick={() => props.onChange(props.value + 1)}
        className="grid size-6.5 place-items-center rounded-full text-(--m-text) outline-none hover:bg-(--m-chip) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent) disabled:opacity-35"
      >
        <PlusIcon className="size-3.5" />
      </button>
    </span>
  );
}

const modelKey = (model: ModelSelection) =>
  `${model.instanceId}/${model.model}/${modelVariant(model) ?? ""}`;

function ModelRow(props: {
  label: string;
  value: ModelSelection;
  models: ReadonlyArray<ModelSelection>;
  onChange: (model: ModelSelection) => void;
}) {
  const choices = props.models.some((model) => modelKey(model) === modelKey(props.value))
    ? props.models
    : [props.value, ...props.models];
  return (
    <div className="flex h-13 items-center justify-between gap-4 not-last:border-b not-last:border-(--m-rule)">
      <span className="font-medium">{props.label}</span>
      <Menu>
        <MenuTrigger
          render={
            <button
              type="button"
              className="inline-flex h-7.5 items-center gap-1.5 rounded-full bg-(--m-chip) px-3 text-sm font-medium text-(--m-text) outline-none hover:bg-(--m-active) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)"
            />
          }
        >
          {modelName(props.value)}
          {modelVariant(props.value) ? (
            <span className="text-(--m-muted)">{modelVariant(props.value)}</span>
          ) : null}
        </MenuTrigger>
        <MenuPopup align="end" side="bottom">
          <MenuRadioGroup
            value={modelKey(props.value)}
            onValueChange={(key) => {
              const next = choices.find((model) => modelKey(model) === key);
              if (next) props.onChange(next);
            }}
          >
            {choices.map((model) => (
              <MenuRadioItem key={modelKey(model)} value={modelKey(model)}>
                {modelName(model)}
                {modelVariant(model) ? ` ${modelVariant(model)}` : ""}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuPopup>
      </Menu>
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
  onSave: (instructions: KanbanInstructions) => void;
}) {
  return (
    <div className="grid gap-2.5 lg:grid-cols-3">
      {INSTRUCTION_FIELDS.map((field) => (
        <InstructionBlock
          key={`${field.key}:${props.board.instructions[field.key]}`}
          label={field.label}
          value={props.board.instructions[field.key]}
          onSave={(text) => props.onSave({ ...props.board.instructions, [field.key]: text })}
        />
      ))}
    </div>
  );
}

function InstructionBlock(props: { label: string; value: string; onSave: (text: string) => void }) {
  const [draft, setDraft] = useState(props.value);
  return (
    <label className="flex flex-col gap-1.5 rounded-xl bg-(--m-surface) px-3.5 pt-3 pb-2">
      <span className="text-sm font-semibold">{props.label}</span>
      <textarea
        value={draft}
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
