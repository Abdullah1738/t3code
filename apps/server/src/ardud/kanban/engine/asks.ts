/** A card's questions for the owner: blocking ones hold it in Needs Owner, async ones don't. */
import {
  KANBAN_ASK_ANSWER_FIELD,
  KANBAN_ASK_SECRET_PROVIDED,
  kanbanAskIsFreeText,
  KANBAN_ASK_FIELD_TYPES,
  kanbanAskChanges,
  kanbanAskExpired,
  kanbanAskKind,
  kanbanAskResponse,
  kanbanAskRevision,
  kanbanOpenAsks,
  type KanbanActor,
  type KanbanAskAction,
  type KanbanAskAnswer,
  type KanbanAskBlock,
  type KanbanAskChange,
  type KanbanAskDraft,
  type KanbanAskField,
  type KanbanAskFieldOption,
  type KanbanAskOption,
  type KanbanAskRespond,
  type KanbanAskResponse,
  type KanbanAskTaskStep,
  type KanbanBlock,
  type KanbanCard,
  type KanbanError,
  type KanbanOwnerAsk,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import { stubBlockAt } from "./messagePages.ts";

/** An upload as a board message or an ask's file field holds it. */
export type AskFile = Extract<KanbanBlock, { readonly _tag: "attachment" }>["attachment"];

/** Ids are never reused, so an answer to an old ask can't land on a new one. */
export const nextAskId = (card: Pick<KanbanCard, "asks">) => `q${card.asks.length + 1}`;

export const addAsk = (
  card: KanbanCard,
  text: string,
  blocking: boolean,
  by: KanbanActor,
  at: string,
): KanbanCard => ({
  ...card,
  asks: [...card.asks, { id: nextAskId(card), text, blocking, by, at, seq: null, closedAt: null }],
});

export const findOpenAsk = (card: KanbanCard, askId: string) =>
  kanbanOpenAsks(card).find((ask) => ask.id === askId);

/**
 * Closes the open asks that match (all by default). `answer` records how each
 * closed; an ask that already has one keeps it.
 */
export const closeAsks = (
  card: KanbanCard,
  at: string,
  which: (ask: KanbanOwnerAsk) => boolean = () => true,
  answer?: (ask: KanbanOwnerAsk) => KanbanAskAnswer | undefined,
): KanbanCard =>
  card.asks.some((ask) => ask.closedAt === null && which(ask))
    ? {
        ...card,
        asks: card.asks.map((ask) => {
          if (ask.closedAt !== null || !which(ask)) return ask;
          const record = ask.answer ?? answer?.(ask);
          // Closed asks are nobody's turn any more; how it was handed over stays on the answer.
          const {
            clarifyAskedAt: _clarify,
            handedAt: _handed,
            snoozedUntil: _snoozed,
            backFromSnoozeAt: _back,
            handedAlways: always,
            handedThreadId: evaluatorThreadId,
            ...rest
          } = ask;
          return record === undefined
            ? { ...rest, closedAt: at }
            : {
                ...rest,
                closedAt: at,
                answer: {
                  ...record,
                  ...(always === true ? { always } : {}),
                  ...(evaluatorThreadId === undefined ? {} : { evaluatorThreadId }),
                },
              };
        }),
      }
    : card;

export const updateAsk = (
  card: KanbanCard,
  askId: string,
  patch: Partial<Omit<KanbanOwnerAsk, "id" | "by" | "at">>,
): KanbanCard => ({
  ...card,
  asks: card.asks.map((ask) => (ask.id === askId ? { ...ask, ...patch } : ask)),
});

/** The newest open blocking ask: whoever asked it gets the owner's answer. */
export const openBlockingAsk = (card: KanbanCard) =>
  kanbanOpenAsks(card).findLast((ask) => ask.blocking);

export const ASK_LIMITS = {
  title: 200,
  context: 4_000,
  options: 12,
  optionLabel: 200,
  optionDetail: 1_000,
  draft: 20_000,
  target: 500,
  actionSummary: 2_000,
  command: 4_000,
  evidence: 10,
  evidenceLine: 1_000,
  undo: 2_000,
  changeLabel: 200,
  changeText: 20_000,
  /** Texts one ask replaces. */
  changes: 8,
  kind: 40,
  optionConsequence: 1_000,
  verdictLabel: 40,
  /** Values one ask collects, so it stays one thing. */
  fields: 8,
  fieldLabel: 200,
  fieldHint: 500,
  fieldOptions: 12,
  fieldUnit: 20,
  fieldAccepts: 10,
  fieldFiles: 8,
  /** A text field's value; a longtext one takes `answerText`. */
  fieldText: 2_000,
  /** A custom field's value as JSON, in UTF-8 bytes. */
  customBytes: 8 * 1024,
  taskSteps: 8,
  taskStep: 500,
  taskLink: 500,
  basis: 500,
  batchKey: 80,
  revisionNote: 500,
  note: 4_000,
  answerText: 20_000,
  /** Blocks shown with an ask. */
  blocks: 12,
  /** Of those, images and files. */
  attachments: 8,
  /** One md or collapse block's text, in characters. */
  blockText: 20_000,
  /** One html block, in UTF-8 bytes. */
  htmlBytes: 256 * 1024,
  /** A body past this many UTF-8 bytes is a stub on the card and whole on the single-ask read. */
  inlineBytes: 4 * 1024,
} as const;

/** The fields of an ask its asker writes, beyond the question itself. */
export type AskFields = Partial<
  Pick<
    KanbanOwnerAsk,
    | "kind"
    | "title"
    | "context"
    | "options"
    | "multi"
    | "draft"
    | "action"
    | "changes"
    | "respond"
    | "to"
    | "basis"
    | "expiresAt"
    | "batchKey"
    | "blocks"
  >
>;

type Format = "markdown" | "text";
interface ChangeInput {
  readonly label: string;
  readonly before: string;
  readonly after: string;
  readonly format?: Format | undefined;
}

/** A field as its asker writes it: `type` defaults to text, ids to `f1`, `f2`, ... */
export interface AskFieldInput {
  readonly id?: string | undefined;
  readonly label: string;
  readonly type?: string | undefined;
  readonly required?: boolean | undefined;
  readonly hint?: string | undefined;
  readonly default?: unknown;
  readonly unit?: string | undefined;
  readonly min?: number | undefined;
  readonly max?: number | undefined;
  readonly options?:
    | ReadonlyArray<string | { readonly id?: string | undefined; readonly label: string }>
    | undefined;
  readonly multi?: boolean | undefined;
  readonly accepts?: ReadonlyArray<string> | undefined;
  readonly maxFiles?: number | undefined;
  readonly block?: number | undefined;
}

/**
 * What the owner gives back, as its asker writes it. Parts add to what the
 * ask's contents already imply (a draft implies edit and verdict); `false`
 * drops an implied part.
 */
export interface AskRespondInput {
  readonly verdict?:
    | boolean
    | { readonly approve?: string | undefined; readonly reject?: string | undefined }
    | undefined;
  readonly choose?:
    | boolean
    | {
        readonly multi?: boolean | undefined;
        readonly min?: number | undefined;
        readonly max?: number | undefined;
      }
    | undefined;
  readonly fields?: ReadonlyArray<AskFieldInput> | false | undefined;
  readonly edit?: boolean | string | undefined;
  readonly task?:
    | false
    | {
        readonly steps?:
          | ReadonlyArray<string | { readonly text: string; readonly link?: string | undefined }>
          | undefined;
        readonly proof?: string | undefined;
      }
    | undefined;
  readonly ack?: boolean | undefined;
}

export interface AskFieldsInput {
  /** A label: a preset name or any other short string. */
  readonly kind?: string | undefined;
  readonly title?: string | undefined;
  readonly context?: string | undefined;
  /** A bare string is a label; ids default to `o1`, `o2`, ... */
  readonly options?:
    | ReadonlyArray<
        | string
        | {
            readonly id?: string | undefined;
            readonly label: string;
            readonly detail?: string | undefined;
            readonly recommended?: boolean | undefined;
            readonly consequence?: string | undefined;
            /** Index into `blocks` of what shows this option. */
            readonly block?: number | undefined;
          }
      >
    | undefined;
  readonly multi?: boolean | undefined;
  readonly draft?:
    | {
        readonly text: string;
        readonly format?: Format | undefined;
        readonly target?: string | undefined;
      }
    | undefined;
  readonly action?:
    | {
        readonly summary: string;
        readonly command?: string | undefined;
        readonly target?: string | undefined;
        readonly evidence?: ReadonlyArray<string> | undefined;
        readonly undo?: string | undefined;
      }
    | undefined;
  /** One text being replaced; the same as a one-item `changes`. */
  readonly change?: ChangeInput | undefined;
  readonly changes?: ReadonlyArray<ChangeInput> | undefined;
  readonly respond?: AskRespondInput | undefined;
  /** "owner" (the default) or "evaluator". */
  readonly to?: string | undefined;
  readonly basis?: string | undefined;
  readonly expiresAt?: string | undefined;
  readonly batchKey?: string | undefined;
  /** Evidence and visuals; an empty list clears them on an edit. */
  readonly blocks?: ReadonlyArray<KanbanBlock> | undefined;
}

export type AskProblem = { readonly code: KanbanError["code"]; readonly detail: string };
const invalid = (detail: string): AskProblem => ({ code: "invalid", detail });
const isProblem = (value: unknown): value is AskProblem =>
  typeof value === "object" && value !== null && "code" in value && "detail" in value;

/** Every string an ask input carries, for the board's control-character check. */
export const askTextFields = (
  input: AskFieldsInput,
): ReadonlyArray<readonly [string, string | undefined]> => [
  ["title", input.title],
  ["context", input.context],
  ...(input.options ?? []).flatMap((option) =>
    typeof option === "string"
      ? [["option", option] as const]
      : [
          ["option", option.label] as const,
          ["option detail", option.detail] as const,
          ["option consequence", option.consequence] as const,
        ],
  ),
  ["draft", input.draft?.text],
  ["draft target", input.draft?.target],
  ["action", input.action?.summary],
  ["action command", input.action?.command],
  ["action target", input.action?.target],
  ...(input.action?.evidence ?? []).map((line) => ["action evidence", line] as const),
  ["action undo", input.action?.undo],
  ...[...(input.change ? [input.change] : []), ...(input.changes ?? [])].flatMap((change) => [
    ["change label", change.label] as const,
    ["change before", change.before] as const,
    ["change after", change.after] as const,
  ]),
  ["kind", input.kind],
  ...respondTextFields(input.respond),
  ["basis", input.basis],
  ["batchKey", input.batchKey],
];

const respondTextFields = (
  respond: AskRespondInput | undefined,
): ReadonlyArray<readonly [string, string | undefined]> => {
  if (respond === undefined) return [];
  const verdict = typeof respond.verdict === "object" ? respond.verdict : undefined;
  const task = respond.task === false ? undefined : respond.task;
  return [
    ["approve label", verdict?.approve],
    ["reject label", verdict?.reject],
    ...(respond.fields === false ? [] : (respond.fields ?? [])).flatMap((field) => [
      ["field id", field.id] as const,
      ["field label", field.label] as const,
      ["field hint", field.hint] as const,
      ["field unit", field.unit] as const,
      ["field default", typeof field.default === "string" ? field.default : undefined] as const,
      ...(field.options ?? []).map(
        (option) => ["field option", typeof option === "string" ? option : option.label] as const,
      ),
      ...(field.accepts ?? []).map((entry) => ["field accepts", entry] as const),
    ]),
    ...(task?.steps ?? []).flatMap((step) =>
      typeof step === "string"
        ? [["task step", step] as const]
        : [["task step", step.text] as const, ["task link", step.link] as const],
    ),
  ];
};

const tooLong = (name: string, value: string, max: number) =>
  value.length > max
    ? invalid(`${name} is at most ${max} characters (got ${value.length})`)
    : undefined;

/** A trimmed optional line: absent when empty. */
const line = (name: string, value: string | undefined, max: number) => {
  const text = value?.trim() ?? "";
  if (text === "") return undefined;
  return tooLong(name, text, max) ?? text;
};

/** Drops absent keys, so stored asks never hold `undefined`. */
const compact = <T extends object>(value: { [K in keyof T]: T[K] | undefined }): T =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;

const utf8Bytes = (text: string) => Buffer.byteLength(text, "utf8");

/**
 * The limits on what an ask shows beside its question. The blocks themselves
 * are stored through the discussion post path (the ask's message), which runs
 * its own text checks and adopts the files.
 */
export const askBlocksProblem = (blocks: ReadonlyArray<KanbanBlock>): AskProblem | undefined => {
  if (blocks.length > ASK_LIMITS.blocks) {
    return invalid(`an ask takes at most ${ASK_LIMITS.blocks} blocks (got ${blocks.length})`);
  }
  const files = blocks.filter((block) => block._tag === "attachment" || block._tag === "image");
  if (files.length > ASK_LIMITS.attachments) {
    return invalid(
      `an ask takes at most ${ASK_LIMITS.attachments} images and files (got ${files.length}): keep the ones he needs to decide`,
    );
  }
  for (const block of blocks) {
    switch (block._tag) {
      case "choice":
        return invalid(
          "an ask's blocks can't hold a poll or pick: put the answers in options, they are the ask's own field",
        );
      case "md":
      case "collapse": {
        const long = tooLong(`a ${block._tag} block`, block.text, ASK_LIMITS.blockText);
        if (long) return long;
        break;
      }
      case "html": {
        const bytes = utf8Bytes(block.html);
        if (bytes > ASK_LIMITS.htmlBytes) {
          return invalid(
            `an html block on an ask is at most ${ASK_LIMITS.htmlBytes / 1024} KB (got ${Math.ceil(bytes / 1024)} KB): trim the page, or attach it as a file`,
          );
        }
        if (block.html.trim() === "") return invalid("an html block needs its html");
        break;
      }
      case "image":
        if (!block.alt?.trim()) {
          return invalid("an image on an ask needs alt text saying what it shows");
        }
        break;
      default:
        break;
    }
  }
  return undefined;
};

/** Ask blocks as the card keeps them: big bodies become stubs, read whole from the ask's message. */
export const inlineBlocks = (blocks: ReadonlyArray<KanbanBlock>): ReadonlyArray<KanbanAskBlock> =>
  blocks.flatMap((block) =>
    block._tag === "choice" ? [] : [stubBlockAt(block, ASK_LIMITS.inlineBytes)],
  );

/** Blocks without picks, which an ask never holds. */
export const askOnly = (blocks: ReadonlyArray<KanbanBlock>): ReadonlyArray<KanbanAskBlock> =>
  blocks.filter((block): block is KanbanAskBlock => block._tag !== "choice");

/**
 * The ask's blocks as its message stored them (they lead the message), trimmed
 * for the card. Nothing when the ask shows none.
 */
export const storedBlocks = (
  message: ReadonlyArray<KanbanBlock>,
  count: number,
): { readonly blocks?: ReadonlyArray<KanbanAskBlock> } =>
  count > 0 ? { blocks: inlineBlocks(message.slice(0, count)) } : {};

const changesOf = (input: AskFieldsInput): ReadonlyArray<ChangeInput> => [
  ...(input.change ? [input.change] : []),
  ...(input.changes ?? []),
];

const givenFields = (respond: AskRespondInput | undefined) =>
  respond?.fields === false ? [] : (respond?.fields ?? []);

const inferKind = (input: AskFieldsInput): string =>
  input.draft
    ? "draft"
    : input.action
      ? "action"
      : changesOf(input).length > 0
        ? "change"
        : input.respond?.ack === true
          ? "notice"
          : input.respond?.task
            ? "task"
            : givenFields(input.respond).length > 0
              ? "input"
              : (input.options?.length ?? 0) > 1
                ? "decision"
                : "question";

const NEEDS: Record<string, string> = {
  question: "a question ask takes the question, context and (when the answers are known) options",
  decision: "a decision ask needs at least two options",
  draft: "a draft ask needs draft: { text } with the exact text you will post or send",
  action: "an action ask needs action: { summary } saying what will be done",
  change: "a change ask needs change: { label, before, after } (or changes, one per text)",
  input: "an input ask needs respond: { fields } saying what he fills in",
  rank: "a rank ask needs at least two options to put in order",
};

/** Why a secret field's value is refused anywhere but the app's private channel. Never repeats a value. */
const SECRET_PRIVATE =
  "is a secret: he enters it in the app's private field and you get a one-use secretRef. It is never sent or stored as a value";

/** The parts a kind brings by its name alone. Any other kind brings what its contents imply. */
const presetRespond = (kind: string, input: AskFieldsInput): AskRespondInput => {
  const label = input.title?.trim();
  switch (kind) {
    case "notice":
      return { ack: true };
    case "signoff":
      return { verdict: { approve: "Passes", reject: "Fails" } };
    case "task":
      return { task: {} };
    case "secret":
      return {
        fields: [{ id: "secret", label: label || "Secret", type: "secret", required: true }],
      };
    case "file":
      return { fields: [{ id: "file", label: label || "File", type: "file", required: true }] };
    case "rank":
      return {
        fields: [
          {
            id: "rank",
            label: label || "Order",
            type: "rank",
            required: true,
            options: (input.options ?? []).map((option) =>
              typeof option === "string" ? option : { id: option.id, label: option.label },
            ),
          },
        ],
      };
    default:
      return {};
  }
};

/** What the ask's contents imply, in the asker's own form, so given parts can add to it. */
const impliedRespond = (kind: string, input: AskFieldsInput, options: number): AskRespondInput => {
  if (kind === "rank") return presetRespond(kind, input);
  const exhibit =
    input.draft !== undefined || input.action !== undefined || changesOf(input).length > 0;
  return {
    ...(options > 0 ? { choose: true } : exhibit ? { verdict: true } : {}),
    ...(input.draft !== undefined ? { edit: true } : {}),
    ...presetRespond(kind, input),
  };
};

const FIELD_ID = /^[A-Za-z0-9_-]{1,40}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const fieldOptions = (
  name: string,
  raw: AskFieldInput["options"],
): ReadonlyArray<KanbanAskFieldOption> | AskProblem => {
  const options: Array<KanbanAskFieldOption> = [];
  for (const entry of raw ?? []) {
    const option = typeof entry === "string" ? { label: entry } : entry;
    const label = option.label.trim();
    if (label === "") continue;
    const long = tooLong(`an option of ${name}`, label, ASK_LIMITS.optionLabel);
    if (long) return long;
    const id = option.id?.trim() || `o${options.length + 1}`;
    if (options.some((existing) => existing.id === id)) {
      return invalid(`${name}: option id "${id}" is used twice`);
    }
    options.push({
      id: id as KanbanAskFieldOption["id"],
      label: label as KanbanAskFieldOption["label"],
    });
  }
  if (options.length < 2) return invalid(`${name} needs at least two options`);
  if (options.length > ASK_LIMITS.fieldOptions) {
    return invalid(`${name} takes at most ${ASK_LIMITS.fieldOptions} options`);
  }
  return options;
};

const isType = (type: string): type is (typeof KANBAN_ASK_FIELD_TYPES)[number] =>
  (KANBAN_ASK_FIELD_TYPES as ReadonlyArray<string>).includes(type);

/** One field as stored, or why it can't be. `blockTags` are the tags of the ask's blocks. */
const fieldOf = (
  raw: AskFieldInput,
  index: number,
  blockTags: ReadonlyArray<string>,
): KanbanAskField | AskProblem => {
  const id = raw.id?.trim() || `f${index + 1}`;
  if (!FIELD_ID.test(id)) {
    return invalid(`field id "${id}" must be 1 to 40 letters, digits, - or _`);
  }
  const name = `field "${id}"`;
  const label = line(`${name} label`, raw.label, ASK_LIMITS.fieldLabel);
  if (label === undefined) return invalid(`${name} needs a label saying what to fill in`);
  if (isProblem(label)) return label;
  const type = raw.type?.trim() || "text";
  if (!isType(type)) {
    return invalid(`${name}: type "${type}" is not one of ${KANBAN_ASK_FIELD_TYPES.join(", ")}`);
  }
  if (type === "secret" && raw.default !== undefined && raw.default !== null) {
    return invalid(`${name}: a secret field takes no default`);
  }
  const hint = line(`${name} hint`, raw.hint, ASK_LIMITS.fieldHint);
  if (isProblem(hint)) return hint;
  const base = { id: id as KanbanAskField["id"], label, type };
  let typed: Partial<KanbanAskField> = {};
  switch (type) {
    case "number": {
      for (const [key, value] of [
        ["min", raw.min],
        ["max", raw.max],
      ] as const) {
        if (value !== undefined && !Number.isFinite(value)) {
          return invalid(`${name}: ${key} is not a number`);
        }
      }
      if (raw.min !== undefined && raw.max !== undefined && raw.min > raw.max) {
        return invalid(`${name}: min is above max`);
      }
      const unit = line(`${name} unit`, raw.unit, ASK_LIMITS.fieldUnit);
      if (isProblem(unit)) return unit;
      typed = compact<Partial<KanbanAskField>>({ unit, min: raw.min, max: raw.max });
      break;
    }
    case "select":
    case "rank": {
      const options = fieldOptions(name, raw.options);
      if (isProblem(options)) return options;
      typed = compact<Partial<KanbanAskField>>({
        options,
        multi: type === "select" && raw.multi === true ? true : undefined,
      });
      break;
    }
    case "file": {
      const accepts = (raw.accepts ?? []).map((entry) => entry.trim()).filter(Boolean);
      if (accepts.length > ASK_LIMITS.fieldAccepts) {
        return invalid(`${name}: accepts takes at most ${ASK_LIMITS.fieldAccepts} entries`);
      }
      if (
        raw.maxFiles !== undefined &&
        (!Number.isInteger(raw.maxFiles) ||
          raw.maxFiles < 1 ||
          raw.maxFiles > ASK_LIMITS.fieldFiles)
      ) {
        return invalid(`${name}: maxFiles is 1 to ${ASK_LIMITS.fieldFiles}`);
      }
      typed = compact<Partial<KanbanAskField>>({
        accepts: accepts.length > 0 ? accepts : undefined,
        maxFiles: raw.maxFiles as KanbanAskField["maxFiles"],
      });
      break;
    }
    case "custom": {
      if (raw.block === undefined || blockTags[raw.block] !== "html") {
        return invalid(
          `${name}: a custom field needs block, the index in blocks of the html page that produces its value`,
        );
      }
      typed = { block: raw.block as KanbanAskField["block"] };
      break;
    }
    default:
      break;
  }
  const field: KanbanAskField = {
    ...base,
    ...compact<Partial<KanbanAskField>>({
      required: raw.required === true ? true : undefined,
      hint,
    }),
    ...typed,
  };
  if (raw.default === undefined || raw.default === null) return field;
  if (type === "file" || type === "custom") {
    return invalid(`${name}: a ${type} field takes no default`);
  }
  const start = fieldValue(field, raw.default);
  if (isProblem(start)) return invalid(`${name} default: ${start.detail}`);
  return { ...field, default: start.value as KanbanAskField["default"] };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const accepted = (accepts: ReadonlyArray<string>, file: AskFile) =>
  accepts.some((entry) => {
    const rule = entry.toLowerCase();
    const mime = file.mimeType.toLowerCase();
    if (rule.startsWith(".")) return file.name.toLowerCase().endsWith(rule);
    return rule.endsWith("/*") ? mime.startsWith(rule.slice(0, -1)) : mime === rule;
  });

/** A file field's value: the uploads as the attachment store names them. */
const fileValue = (field: KanbanAskField, value: unknown): ReadonlyArray<AskFile> | null => {
  const list = Array.isArray(value) ? value : [value];
  const files: Array<AskFile> = [];
  for (const entry of list) {
    if (
      !isRecord(entry) ||
      (entry.type !== "image" && entry.type !== "file") ||
      typeof entry.id !== "string" ||
      typeof entry.name !== "string" ||
      typeof entry.mimeType !== "string" ||
      typeof entry.sizeBytes !== "number"
    ) {
      return null;
    }
    files.push({
      type: entry.type,
      id: entry.id,
      name: entry.name,
      mimeType: entry.mimeType,
      sizeBytes: entry.sizeBytes,
    } as AskFile);
  }
  return files.length > 0 ? files : null;
};

/**
 * One field's value, checked against the field and normalized, or what is
 * wrong with it. The problem never repeats the value.
 */
export const fieldValue = (
  field: KanbanAskField,
  value: unknown,
): { readonly value: unknown } | AskProblem => {
  switch (field.type) {
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return invalid("is not a number");
      if (field.min !== undefined && value < field.min) {
        return invalid(`is below ${field.min}${field.unit ? ` ${field.unit}` : ""}`);
      }
      if (field.max !== undefined && value > field.max) {
        return invalid(`is above ${field.max}${field.unit ? ` ${field.unit}` : ""}`);
      }
      return { value };
    }
    case "date": {
      if (
        typeof value !== "string" ||
        !DATE.test(value) ||
        Option.isNone(DateTime.make(`${value}T00:00:00Z`))
      ) {
        return invalid("is not a date (YYYY-MM-DD)");
      }
      return { value };
    }
    case "datetime": {
      const time = typeof value === "string" ? DateTime.make(value) : Option.none();
      if (Option.isNone(time)) return invalid("is not a time (ISO 8601)");
      return { value: DateTime.formatIso(time.value) };
    }
    case "toggle":
      return typeof value === "boolean" ? { value } : invalid("is not true or false");
    case "select": {
      const ids = (Array.isArray(value) ? value : [value]).filter(
        (entry): entry is string => typeof entry === "string",
      );
      const known = (field.options ?? []).map((option) => option.id as string);
      if (ids.length === 0 || ids.some((id) => !known.includes(id))) {
        return invalid(`takes ${field.multi ? "some" : "one"} of ${known.join(", ")}`);
      }
      const unique = [...new Set(ids)];
      if (field.multi !== true && unique.length > 1) return invalid("takes one option");
      return { value: field.multi === true ? unique : unique[0] };
    }
    case "rank": {
      const known = (field.options ?? []).map((option) => option.id as string);
      const order = Array.isArray(value) ? value : [];
      const complete =
        order.length === known.length &&
        new Set(order).size === known.length &&
        order.every((id) => typeof id === "string" && known.includes(id));
      return complete
        ? { value: order }
        : invalid(`takes every one of ${known.join(", ")} once, in order`);
    }
    case "file": {
      const files = fileValue(field, value);
      if (files === null) {
        return invalid("takes the uploaded files: [{ type, id, name, mimeType, sizeBytes }]");
      }
      const max = field.maxFiles ?? 1;
      if (files.length > max) return invalid(`takes at most ${max} file${max === 1 ? "" : "s"}`);
      const wrong = field.accepts ? files.find((file) => !accepted(field.accepts!, file)) : null;
      if (wrong) return invalid(`takes ${field.accepts!.join(", ")} (got ${wrong.mimeType})`);
      return { value: files };
    }
    case "secret":
      return invalid(SECRET_PRIVATE);
    case "custom": {
      const json = JSON.stringify(value);
      if (json === undefined) return invalid("is not a JSON value");
      if (utf8Bytes(json) > ASK_LIMITS.customBytes) {
        return invalid(`is at most ${ASK_LIMITS.customBytes / 1024} KB of JSON`);
      }
      return { value: JSON.parse(json) as unknown };
    }
    default: {
      // text, longtext, and any type a newer build wrote.
      if (typeof value !== "string" || value.trim() === "") return invalid("is not text");
      const max = field.type === "longtext" ? ASK_LIMITS.answerText : ASK_LIMITS.fieldText;
      return value.length > max ? invalid(`is at most ${max} characters`) : { value };
    }
  }
};

/** The stored response parts for what the asker gave on top of what the ask implies. */
const respondOf = (
  kind: string,
  input: AskFieldsInput,
  options: ReadonlyArray<KanbanAskOption>,
  blockTags: ReadonlyArray<string>,
  blocking: boolean,
): KanbanAskRespond | undefined | AskProblem => {
  const given = input.respond;
  const preset = presetRespond(kind, input);
  // The first five kinds and unknown ones need nothing stored: their contents say it all.
  if (given === undefined && Object.keys(preset).length === 0) return undefined;
  const merged: AskRespondInput = {
    ...impliedRespond(kind, input, options.length),
    ...compact<AskRespondInput>(given ?? {}),
  };

  let verdict: KanbanAskRespond["verdict"];
  if (merged.verdict !== undefined && merged.verdict !== false) {
    const labels = merged.verdict === true ? {} : merged.verdict;
    const approve = line("approve label", labels.approve, ASK_LIMITS.verdictLabel);
    if (isProblem(approve)) return approve;
    const reject = line("reject label", labels.reject, ASK_LIMITS.verdictLabel);
    if (isProblem(reject)) return reject;
    verdict = compact<NonNullable<KanbanAskRespond["verdict"]>>({ approve, reject });
  }

  let choose: KanbanAskRespond["choose"];
  if (merged.choose !== undefined && merged.choose !== false) {
    if (options.length === 0) return invalid("choose needs options to pick from");
    const limits = merged.choose === true ? {} : merged.choose;
    const multi = input.multi === true || limits.multi === true;
    const max = limits.max ?? (multi ? options.length : 1);
    const min = limits.min ?? 1;
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < 1 || min > max) {
      return invalid("choose: min and max are whole numbers with 0 <= min <= max");
    }
    if (max > options.length) return invalid(`choose: max is above the ${options.length} options`);
    if (!multi && max > 1) return invalid("choose: max above 1 needs multi");
    choose = compact<NonNullable<KanbanAskRespond["choose"]>>({
      min: limits.min as NonNullable<KanbanAskRespond["choose"]>["min"],
      max: limits.max as NonNullable<KanbanAskRespond["choose"]>["max"],
    });
  }

  const rawFields = merged.fields === false ? [] : (merged.fields ?? []);
  if (rawFields.length > ASK_LIMITS.fields) {
    return invalid(
      `an ask takes at most ${ASK_LIMITS.fields} fields (got ${rawFields.length}): ask one thing per ask`,
    );
  }
  const fields: Array<KanbanAskField> = [];
  for (const [index, raw] of rawFields.entries()) {
    const field = fieldOf(raw, index, blockTags);
    if (isProblem(field)) return field;
    if (fields.some((existing) => existing.id === field.id)) {
      return invalid(`field id "${field.id}" is used twice`);
    }
    fields.push(field);
  }

  let edit: string | undefined;
  if (merged.edit !== undefined && merged.edit !== false) {
    if (merged.edit !== true && merged.edit !== "draft") {
      return invalid(`edit: only "draft" can be edited (got "${merged.edit}")`);
    }
    if (input.draft === undefined) return invalid("edit needs a draft for him to edit");
    edit = "draft";
  }

  let task: KanbanAskRespond["task"];
  if (merged.task !== undefined && merged.task !== false) {
    const rawSteps = merged.task.steps ?? [];
    if (rawSteps.length > ASK_LIMITS.taskSteps) {
      return invalid(`a task takes at most ${ASK_LIMITS.taskSteps} steps (got ${rawSteps.length})`);
    }
    const steps: Array<KanbanAskTaskStep> = [];
    for (const raw of rawSteps) {
      const step = typeof raw === "string" ? { text: raw } : raw;
      const text = line("a task step", step.text, ASK_LIMITS.taskStep);
      if (text === undefined) continue;
      if (isProblem(text)) return text;
      const link = line("a task link", step.link, ASK_LIMITS.taskLink);
      if (isProblem(link)) return link;
      steps.push(compact<KanbanAskTaskStep>({ text, link }));
    }
    const proof = merged.task.proof?.trim() || undefined;
    if (proof !== undefined && !fields.some((field) => field.id === proof)) {
      return invalid(`task proof "${proof}" is not one of the ask's fields`);
    }
    task = compact<NonNullable<KanbanAskRespond["task"]>>({ steps, proof });
  }

  const ack = merged.ack === true;
  if (ack) {
    if (verdict || choose || fields.length > 0 || task || edit) {
      return invalid(
        "a notice takes nothing back: drop the other response parts, or ask a real question instead",
      );
    }
    if (blocking) {
      return invalid("a notice can't block: there is nothing for the card to wait for");
    }
  }
  const respond = compact<KanbanAskRespond>({
    verdict,
    choose,
    fields: fields.length > 0 ? fields : undefined,
    edit,
    task,
    ack: ack ? true : undefined,
  });
  return Object.keys(respond).length > 0 ? respond : undefined;
};

export interface AskFieldsContext {
  readonly blocking: boolean;
  /** The tags of the blocks the ask keeps, when the input brings no new ones. */
  readonly keptBlockTags?: ReadonlyArray<string> | undefined;
}

/**
 * Checks and normalizes what an asker wrote into the stored fields. `kind` is
 * a label, inferred from what the ask carries when left out; what the owner
 * gives back comes from `respond` on top of what the contents imply.
 */
export const askFields = (
  input: AskFieldsInput,
  rules: AskFieldsContext = { blocking: false },
): AskFields | AskProblem => {
  const named = input.kind?.trim();
  if (named !== undefined && named.length > ASK_LIMITS.kind) {
    return invalid(`kind is a short label, at most ${ASK_LIMITS.kind} characters`);
  }
  const kind = named || inferKind(input);
  const rawChanges = changesOf(input);
  const bodies = [
    ...(input.draft !== undefined ? ["draft"] : []),
    ...(input.action !== undefined ? ["action"] : []),
    ...(rawChanges.length > 0 ? ["change"] : []),
  ];
  const own = kind === "draft" || kind === "action" || kind === "change" ? kind : null;
  const stray = own === null ? bodies.slice(1) : bodies.filter((name) => name !== own);
  if (stray.length > 0) {
    return invalid(
      `a ${kind} ask can't carry ${own === null ? bodies.join(" and ") : stray.join(" or ")}: ask one thing per ask${NEEDS[kind] ? ` (${NEEDS[kind]})` : ""}`,
    );
  }
  if (own !== null && !bodies.includes(own)) return invalid(NEEDS[kind]!);

  const title = line("title", input.title, ASK_LIMITS.title);
  if (isProblem(title)) return title;
  const context = line("context", input.context, ASK_LIMITS.context);
  if (isProblem(context)) return context;
  const basis = line("basis", input.basis, ASK_LIMITS.basis);
  if (isProblem(basis)) return basis;
  const batchKey = line("batchKey", input.batchKey, ASK_LIMITS.batchKey);
  if (isProblem(batchKey)) return batchKey;
  const to = input.to?.trim() || "owner";
  if (to !== "owner" && to !== "evaluator") {
    return invalid(`an ask goes to "owner" (the default) or "evaluator" (got "${to}")`);
  }

  const blocks = input.blocks ?? [];
  const blocksProblem = askBlocksProblem(blocks);
  if (blocksProblem) return blocksProblem;
  const blockTags =
    input.blocks !== undefined ? blocks.map((block) => block._tag) : (rules.keptBlockTags ?? []);

  let expiresAt: string | undefined;
  if (input.expiresAt !== undefined && input.expiresAt.trim() !== "") {
    const time = DateTime.make(input.expiresAt);
    if (Option.isNone(time)) return invalid("expiresAt is not a time (use ISO 8601)");
    expiresAt = DateTime.formatIso(time.value);
  }

  // A rank ask's options are the items to order: they live on its field.
  const raw =
    kind === "rank" && givenFields(input.respond).length === 0 ? [] : (input.options ?? []);
  if (raw.length > ASK_LIMITS.options) {
    return invalid(`an ask takes at most ${ASK_LIMITS.options} options (got ${raw.length})`);
  }
  const options: Array<KanbanAskOption> = [];
  for (const entry of raw) {
    const option = typeof entry === "string" ? { label: entry } : entry;
    const label = option.label.trim();
    // An empty label is dropped, as the pick block always did.
    if (label === "") continue;
    const long = tooLong("an option label", label, ASK_LIMITS.optionLabel);
    if (long) return long;
    const detail = line("an option detail", option.detail, ASK_LIMITS.optionDetail);
    if (isProblem(detail)) return detail;
    const consequence = line(
      "an option consequence",
      option.consequence,
      ASK_LIMITS.optionConsequence,
    );
    if (isProblem(consequence)) return consequence;
    if (
      option.block !== undefined &&
      (!Number.isInteger(option.block) || blockTags[option.block] === undefined)
    ) {
      return invalid(
        `option "${label}": block ${option.block} is not in blocks (it has ${blockTags.length}; the first is 0)`,
      );
    }
    // Counted after empty labels are dropped, as the pick block always numbered them.
    const id = option.id?.trim() || `o${options.length + 1}`;
    if (options.some((existing) => existing.id === id)) {
      return invalid(`option id "${id}" is used twice`);
    }
    options.push(
      compact<KanbanAskOption>({
        id: id as KanbanAskOption["id"],
        label: label as KanbanAskOption["label"],
        detail,
        recommended: option.recommended === true ? true : undefined,
        consequence,
        block: option.block as KanbanAskOption["block"],
      }),
    );
  }
  if (kind === "decision" && options.length < 2) return invalid(NEEDS.decision!);
  if (kind === "input" && givenFields(input.respond).length === 0) return invalid(NEEDS.input!);

  let draft: KanbanAskDraft | undefined;
  if (input.draft !== undefined) {
    if (input.draft.text.trim() === "") return invalid(NEEDS.draft!);
    const long = tooLong("draft text", input.draft.text, ASK_LIMITS.draft);
    if (long) return long;
    const target = line("draft target", input.draft.target, ASK_LIMITS.target);
    if (isProblem(target)) return target;
    draft = compact<KanbanAskDraft>({
      text: input.draft.text,
      format: input.draft.format ?? "markdown",
      target,
    });
  }

  let action: KanbanAskAction | undefined;
  if (input.action !== undefined) {
    const summary = line("action summary", input.action.summary, ASK_LIMITS.actionSummary);
    if (summary === undefined) return invalid(NEEDS.action!);
    if (isProblem(summary)) return summary;
    const command = line("action command", input.action.command, ASK_LIMITS.command);
    if (isProblem(command)) return command;
    const target = line("action target", input.action.target, ASK_LIMITS.target);
    if (isProblem(target)) return target;
    const undo = line("action undo", input.action.undo, ASK_LIMITS.undo);
    if (isProblem(undo)) return undo;
    const evidence = (input.action.evidence ?? [])
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
    if (evidence.length > ASK_LIMITS.evidence) {
      return invalid(`action evidence takes at most ${ASK_LIMITS.evidence} lines`);
    }
    for (const entry of evidence) {
      const long = tooLong("an action evidence line", entry, ASK_LIMITS.evidenceLine);
      if (long) return long;
    }
    action = compact<KanbanAskAction>({
      summary,
      command,
      target,
      evidence: evidence.length > 0 ? evidence : undefined,
      undo,
    });
  }

  if (rawChanges.length > ASK_LIMITS.changes) {
    return invalid(
      `an ask takes at most ${ASK_LIMITS.changes} changes (got ${rawChanges.length}): attach a diff as a file for more`,
    );
  }
  const changes: Array<KanbanAskChange> = [];
  for (const entry of rawChanges) {
    const label = line("change label", entry.label, ASK_LIMITS.changeLabel);
    if (label === undefined) return invalid(NEEDS.change!);
    if (isProblem(label)) return label;
    const before = tooLong("change before", entry.before, ASK_LIMITS.changeText);
    if (before) return before;
    const after = tooLong("change after", entry.after, ASK_LIMITS.changeText);
    if (after) return after;
    if (entry.before === entry.after) {
      return invalid("a change ask needs before and after to differ");
    }
    changes.push({
      label,
      before: entry.before,
      after: entry.after,
      format: entry.format ?? "markdown",
    });
  }

  const respond = respondOf(kind, input, options, blockTags, rules.blocking);
  if (isProblem(respond)) return respond;
  if (to === "evaluator" && respond?.fields?.some((field) => field.type === "secret")) {
    return invalid("a secret field is for the owner: only he can give a secret");
  }

  return compact<AskFields>({
    kind,
    title,
    context,
    options: options.length > 0 ? options : undefined,
    multi:
      options.length > 0 &&
      (input.multi === true ||
        (typeof input.respond?.choose === "object" && input.respond.choose.multi === true))
        ? true
        : undefined,
    draft,
    action,
    changes: changes.length > 0 ? changes : undefined,
    respond,
    to: to === "evaluator" ? to : undefined,
    basis,
    expiresAt: expiresAt as AskFields["expiresAt"],
    batchKey,
    // Whole here; `inlineBlocks` trims them once the ask's message holds them.
    blocks: blocks.length > 0 ? askOnly(blocks) : undefined,
  });
};

/** The asker-written fields of a stored ask, as an input, so an edit can be merged and re-checked. */
const fieldsInput = (ask: KanbanOwnerAsk): AskFieldsInput => ({
  kind: ask.kind,
  title: ask.title,
  context: ask.context,
  options: ask.options,
  multi: ask.multi,
  draft: ask.draft,
  action: ask.action,
  changes: ask.changes ?? (ask.change ? [ask.change] : undefined),
  respond: ask.respond,
  to: ask.to,
  basis: ask.basis,
  expiresAt: ask.expiresAt,
  batchKey: ask.batchKey,
});

const FIELD_KEYS = [
  "kind",
  "title",
  "context",
  "options",
  "multi",
  "draft",
  "action",
  "changes",
  "respond",
  "basis",
  "expiresAt",
  "batchKey",
] as const;

export interface AskEdit extends AskFieldsInput {
  readonly question?: string | undefined;
  readonly revisionNote?: string | undefined;
}

/**
 * An open ask with its asker's edit applied: the passed fields replace the
 * stored ones (an empty string or list clears one), the whole ask is checked
 * again, and the revision goes up. Whoever was waiting on the asker (a
 * clarifying question) is not any more. Who it is for doesn't change here.
 */
export const reviseAsk = (
  ask: KanbanOwnerAsk,
  edit: AskEdit,
  at: string,
): KanbanOwnerAsk | AskProblem => {
  const merged: AskFieldsInput = { ...fieldsInput(ask) };
  const change: AskFieldsInput =
    edit.change !== undefined && edit.changes === undefined
      ? { ...edit, changes: [edit.change] }
      : edit;
  for (const key of FIELD_KEYS) {
    if (change[key] !== undefined) (merged as Record<string, unknown>)[key] = change[key];
  }
  const fresh = Boolean(change.draft || change.action || change.changes?.length);
  // A new body decides the kind unless the edit names one.
  if (change.kind === undefined && fresh) {
    (merged as { kind?: string }).kind = inferKind({ ...change, change: undefined });
    for (const body of ["draft", "action", "changes"] as const) {
      if (change[body] === undefined) delete (merged as Record<string, unknown>)[body];
    }
  }
  // What he gives back follows a new kind or body unless the edit says otherwise.
  if (change.respond === undefined && (fresh || (change.kind ?? ask.kind) !== ask.kind)) {
    delete (merged as Record<string, unknown>).respond;
  }
  // Stored blocks may be stubs: only new ones are checked, and kept ones stay as they are.
  const fields = askFields(
    { ...merged, blocks: edit.blocks },
    { blocking: ask.blocking, keptBlockTags: (ask.blocks ?? []).map((block) => block._tag) },
  );
  if (isProblem(fields)) return fields;
  const question = edit.question === undefined ? ask.text : edit.question.trim();
  if (question === "") return invalid("an ask needs the question");
  const note = line("revisionNote", edit.revisionNote, ASK_LIMITS.revisionNote);
  if (isProblem(note)) return note;
  const {
    kind: _kind,
    title: _title,
    context: _context,
    options: _options,
    multi: _multi,
    draft: _draft,
    action: _action,
    change: _change,
    changes: _changes,
    respond: _respond,
    basis: _basis,
    expiresAt: _expiresAt,
    batchKey: _batchKey,
    revisionNote: _note,
    clarifyAskedAt: _clarify,
    blocks: stored,
    ...rest
  } = ask;
  // An edit brings a snoozed ask back: there is something new to read.
  const kept = endSnooze(rest, at);
  return {
    ...kept,
    ...(edit.blocks === undefined && stored !== undefined ? { blocks: stored } : {}),
    ...fields,
    text: question,
    revision: kanbanAskRevision(ask) + 1,
    revisedAt: at as NonNullable<KanbanOwnerAsk["revisedAt"]>,
    ...(note === undefined ? {} : { revisionNote: note }),
  };
};

export const replaceAsk = (card: KanbanCard, next: KanbanOwnerAsk): KanbanCard => ({
  ...card,
  asks: card.asks.map((ask) => (ask.id === next.id ? next : ask)),
});

/** The longest the owner can put an ask away for. */
export const SNOOZE_MAX_MS = 366 * 24 * 60 * 60 * 1000;

/** Without its snooze marks: the owner acted on it, or took the snooze off. */
const withoutSnooze = <A extends Pick<KanbanOwnerAsk, "snoozedUntil" | "backFromSnoozeAt">>(
  ask: A,
): Omit<A, "snoozedUntil" | "backFromSnoozeAt"> => {
  const { snoozedUntil: _until, backFromSnoozeAt: _back, ...rest } = ask;
  return rest;
};

/**
 * Its asker edited it or replied: a snooze still running ends now, and the ask
 * is marked as back since then. One that already ran out is back since it did.
 */
const endSnooze = <A extends Pick<KanbanOwnerAsk, "snoozedUntil" | "backFromSnoozeAt">>(
  ask: A,
  at: string,
): A => {
  if (ask.snoozedUntil === undefined || Date.parse(ask.snoozedUntil) <= Date.parse(at)) return ask;
  const { snoozedUntil: _until, ...rest } = ask;
  return {
    ...rest,
    backFromSnoozeAt: at as NonNullable<KanbanOwnerAsk["backFromSnoozeAt"]>,
  } as unknown as A;
};

/** The agent replied on a snoozed ask: it comes back. Same card when it wasn't snoozed. */
export const wakeFromSnooze = (card: KanbanCard, askId: string, at: string): KanbanCard => {
  const ask = card.asks.find((entry) => entry.id === askId);
  if (!ask || ask.closedAt !== null) return card;
  const woken = endSnooze(ask, at);
  return woken === ask ? card : replaceAsk(card, woken);
};

/**
 * The owner puts an open ask of his away until `until`, or (null) takes the
 * snooze off. It stays open and keeps holding its card; nobody is told.
 */
export const snoozeAsk = (
  card: KanbanCard,
  ask: KanbanOwnerAsk,
  until: string | null,
  at: string,
): KanbanCard | AskProblem => {
  const ref = `${ask.id} on card #${card.number}`;
  if (ask.closedAt !== null) return { code: "conflict", detail: `${ref} is already closed` };
  if (until === null) return replaceAsk(card, withoutSnooze(ask));
  if (ask.handedAt !== undefined) {
    return invalid(`${ref} is with the evaluator: take it back to snooze it`);
  }
  if (ask.clarifyAskedAt !== undefined) {
    return invalid(`${ref} waits on its asker, not on you: there is nothing to snooze`);
  }
  const time = DateTime.make(until);
  if (Option.isNone(time)) return invalid("until is not a time (use ISO 8601)");
  const ms = DateTime.toEpochMillis(time.value);
  const now = Date.parse(at);
  if (ms <= now) return invalid("until is in the past: snooze to a later time");
  if (ms - now > SNOOZE_MAX_MS) return invalid("until is more than a year away");
  return replaceAsk(card, {
    ...withoutSnooze(ask),
    snoozedUntil: DateTime.formatIso(time.value) as NonNullable<KanbanOwnerAsk["snoozedUntil"]>,
  });
};

/** The owner asked about the ask instead of answering it: it waits on its asker. */
export const markClarify = (card: KanbanCard, askId: string, at: string): KanbanCard =>
  updateAsk(actedOn(card, askId), askId, {
    clarifyAskedAt: at as NonNullable<KanbanOwnerAsk["clarifyAskedAt"]>,
  });

/** The owner acted on an ask (replied, handed it over): any snooze mark on it is done with. */
const actedOn = (card: KanbanCard, askId: string): KanbanCard =>
  card.asks.some(
    (ask) =>
      ask.id === askId && (ask.snoozedUntil !== undefined || ask.backFromSnoozeAt !== undefined),
  )
    ? { ...card, asks: card.asks.map((ask) => (ask.id === askId ? withoutSnooze(ask) : ask)) }
    : card;

const without = (
  card: KanbanCard,
  askId: string,
  key: "clarifyAskedAt" | "handedAt",
): KanbanCard =>
  card.asks.some((ask) => ask.id === askId && ask[key] !== undefined)
    ? {
        ...card,
        asks: card.asks.map((ask) => {
          if (ask.id !== askId) return ask;
          const { [key]: _dropped, ...rest } = ask;
          return rest;
        }),
      }
    : card;

/** The agent replied or fixed the ask: it is the owner's turn again. Same card when nothing waited. */
export const clearClarify = (card: KanbanCard, askId: string): KanbanCard =>
  without(card, askId, "clarifyAskedAt");

/**
 * Why an ask can't be handed to the evaluator, or undefined. An evaluator has
 * no way to give a secret, so an ask that requires one would only come back.
 */
export const handProblem = (card: KanbanCard, ask: KanbanOwnerAsk): AskProblem | undefined => {
  const secret = kanbanAskResponse(ask).fields.find(
    (field) => field.type === "secret" && field.required === true,
  );
  return secret === undefined
    ? undefined
    : invalid(
        `${ask.id} on card #${card.number} needs a secret (${secret.label}) that only you can give, in the app's private field, so the evaluator can't answer it. Answer it yourself, or reject it`,
      );
};

export const markHanded = (
  card: KanbanCard,
  askId: string,
  at: string,
  always = false,
): KanbanCard =>
  updateAsk(actedOn(without(card, askId, "clarifyAskedAt"), askId), askId, {
    handedAt: at as NonNullable<KanbanOwnerAsk["handedAt"]>,
    ...(always ? { handedAlways: true } : {}),
  });

/** The evaluator thread an "every time" hand-over started. Same card when the ask is no longer handed that way. */
export const markHandEvaluator = (
  card: KanbanCard,
  askId: string,
  threadId: NonNullable<KanbanOwnerAsk["handedThreadId"]>,
): KanbanCard =>
  card.asks.some((ask) => ask.id === askId && ask.closedAt === null && ask.handedAlways === true)
    ? updateAsk(card, askId, { handedThreadId: threadId })
    : card;

/** Back with the owner: it is his again, whoever it was first asked to. */
export const clearHanded = (card: KanbanCard, askId: string): KanbanCard =>
  card.asks.some((ask) => ask.id === askId && ask.handedAt !== undefined)
    ? {
        ...card,
        asks: card.asks.map((ask) => {
          if (ask.id !== askId) return ask;
          const {
            handedAt: _handed,
            handedAlways: _always,
            handedThreadId: _thread,
            to: _to,
            ...rest
          } = ask;
          return rest;
        }),
      }
    : card;

/**
 * The options of the ask's pick block, for clients that only know picks: the
 * ask's own, or its two verdicts under the ids `approve` and `reject`.
 */
export const pickOptions = (ask: KanbanOwnerAsk): ReadonlyArray<KanbanAskOption> => {
  const response = kanbanAskResponse(ask);
  if (response.choose) return response.choose.options;
  if (!response.verdict) return [];
  return [
    {
      id: "approve" as KanbanAskOption["id"],
      label: response.verdict.approve as KanbanAskOption["label"],
    },
    {
      id: "reject" as KanbanAskOption["id"],
      label: response.verdict.reject as KanbanAskOption["label"],
    },
  ];
};

const fieldLine = (field: KanbanAskField) => {
  const facts = [
    field.type,
    field.required === true ? "required" : null,
    field.unit ?? null,
    field.min !== undefined ? `min ${field.min}` : null,
    field.max !== undefined ? `max ${field.max}` : null,
    field.options
      ? field.options.map((option) => `${option.id} = ${option.label}`).join("; ")
      : null,
    field.multi === true ? "several" : null,
  ].filter((entry) => entry !== null);
  return `- ${field.label} (\`${field.id}\`: ${facts.join(", ")})${field.hint ? `: ${field.hint}` : ""}`;
};

/** What the owner gives back beyond a pick, as markdown; empty when the pick block says it all. */
const responseDetail = (response: KanbanAskResponse): string => {
  const parts: Array<string> = [];
  const fields = response.fields.filter((field) => field.id !== KANBAN_ASK_ANSWER_FIELD);
  if (fields.length > 0) parts.push(`**To fill in:**\n${fields.map(fieldLine).join("\n")}`);
  if (response.task) {
    parts.push(
      response.task.steps.length > 0
        ? `**For him to do:**\n${response.task.steps
            .map((step, index) => `${index + 1}. ${step.text}${step.link ? ` (${step.link})` : ""}`)
            .join("\n")}`
        : "**For him to do**, then say done or couldn't.",
    );
  }
  if (response.ack) parts.push("For his information: nothing to decide.");
  return parts.join("\n\n");
};

/** Everything the ask carries beyond its question, as markdown; empty for a plain question. */
export const askDetail = (ask: KanbanOwnerAsk): string => {
  const parts: Array<string> = [];
  if (ask.title) parts.push(`**${ask.title}**`);
  if (ask.context) parts.push(ask.context);
  if (ask.draft) {
    parts.push(
      `**Draft${ask.draft.target ? ` (${ask.draft.target})` : ""}:**\n\n${ask.draft.text}`,
    );
  }
  if (ask.action) {
    parts.push(
      [
        `**Action:** ${ask.action.summary}`,
        ask.action.target ? `- Where: ${ask.action.target}` : null,
        ask.action.command ? `- Command: \`${ask.action.command}\`` : null,
        ...(ask.action.evidence ?? []).map((entry) => `- Evidence: ${entry}`),
        ask.action.undo ? `- Undo: ${ask.action.undo}` : null,
      ]
        .filter((entry) => entry !== null)
        .join("\n"),
    );
  }
  for (const change of kanbanAskChanges(ask)) {
    parts.push(
      `**Change: ${change.label}**\n\nBefore:\n\n${change.before}\n\nAfter:\n\n${change.after}`,
    );
  }
  const options = (ask.options ?? []).filter(
    (option) => option.detail || option.recommended || option.consequence,
  );
  if (options.length > 0) {
    parts.push(
      options
        .map(
          (option) =>
            `- **${option.label}**${option.recommended ? " (recommended)" : ""}${option.detail ? `: ${option.detail}` : ""}${option.consequence ? ` Then: ${option.consequence}` : ""}`,
        )
        .join("\n"),
    );
  }
  const response = responseDetail(kanbanAskResponse(ask));
  if (response !== "") parts.push(response);
  if (ask.basis) parts.push(`Based on: ${ask.basis}`);
  return parts.join("\n\n");
};

/**
 * The ask as a discussion message. A plain question is one md block; with
 * options it is a pick whose block id is the ask id and whose option ids are
 * the ask's, so a client that only knows picks can still answer it. An
 * approval with no options of its own gets a pick of its two verdicts.
 * `options` and `multi` are the plain-label form for asks that carry none.
 */
export const askBlocks = (
  ask: KanbanOwnerAsk,
  options: ReadonlyArray<string> = [],
  multi = false,
): ReadonlyArray<KanbanBlock> => {
  const own = pickOptions(ask);
  const labels = options.map((option) => option.trim()).filter((option) => option.length > 0);
  const picks =
    own.length > 0
      ? own.map((option) => ({ id: option.id, label: option.label }))
      : labels.map((label, index) => ({ id: `o${index + 1}`, label }));
  const detail = askDetail(ask);
  if (picks.length === 0) {
    return [{ _tag: "md", text: detail === "" ? ask.text : `${detail}\n\n${ask.text}` }];
  }
  return [
    ...(detail === "" ? [] : [{ _tag: "md" as const, text: detail }]),
    {
      _tag: "choice",
      id: ask.id,
      style: "pick",
      question: ask.text,
      options: picks,
      multi: own.length > 0 ? ask.multi === true : multi,
    } as KanbanBlock,
  ];
};

/** The verdicts an answerer may give; which ones an ask takes depends on its response parts. */
export const OWNER_VERDICTS = [
  "approved",
  "rejected",
  "picked",
  "answered",
  "done",
  "cant",
  "acknowledged",
] as const;
export type OwnerVerdict = (typeof OWNER_VERDICTS)[number];
export interface AskAnswerInput {
  readonly verdict: string;
  readonly optionIds?: ReadonlyArray<string> | undefined;
  readonly text?: string | undefined;
  readonly note?: string | undefined;
  readonly finalDraft?: string | undefined;
  /** Field id to value, for the ask's fields. */
  readonly values?: Readonly<Record<string, unknown>> | undefined;
  /**
   * The revision the answerer saw; a newer one refuses the answer. Required
   * unless the ask is answered in words alone (`kanbanAskIsFreeText`).
   */
  readonly revision?: number | undefined;
}

const conflict = (detail: string): AskProblem => ({ code: "conflict", detail });

/** The verdicts an ask takes, for the message that refuses another one. */
export const verdictsFor = (response: KanbanAskResponse): ReadonlyArray<OwnerVerdict> => [
  ...(response.verdict ? (["approved", "rejected"] as const) : []),
  ...(response.choose ? (["picked"] as const) : []),
  ...(response.task ? (["done", "cant"] as const) : []),
  ...(response.ack ? (["acknowledged"] as const) : (["answered"] as const)),
];

/**
 * What one answer sent to several asks can fill in: a verdict, a pick from
 * the same options, a plain question's free text, or a notice's "seen". Null
 * for an ask that takes anything more (fields, a task, an editable draft):
 * that one is answered on its own.
 */
export const batchShape = (ask: KanbanOwnerAsk): string | null => {
  const response = kanbanAskResponse(ask);
  const plain =
    ask.respond === undefined &&
    response.fields.length === 1 &&
    response.fields[0]?.id === KANBAN_ASK_ANSWER_FIELD;
  if (response.task || response.edit || (response.fields.length > 0 && !plain)) return null;
  if (response.ack) return "ack";
  if (plain) return "text";
  if (response.choose) {
    if (response.verdict) return null;
    const { options, multi, min, max } = response.choose;
    return `choose:${multi}:${min}:${max}:${options.map((option) => `${option.id}=${option.label}`).join("\u0000")}`;
  }
  return response.verdict ? "verdict" : null;
};

/** Every string an answer carries, for the board's control-character check. */
export const answerTextFields = (
  input: AskAnswerInput,
): ReadonlyArray<readonly [string, string | undefined]> => [
  ["answer", input.text],
  ["note", input.note],
  ["finalDraft", input.finalDraft],
  ...Object.entries(input.values ?? {}).flatMap(([id, value]) =>
    (Array.isArray(value) ? value : [value]).map(
      (entry) => [`field "${id}"`, typeof entry === "string" ? entry : undefined] as const,
    ),
  ),
];

const NO_SECRETS: ReadonlySet<string> = new Set();

/** A secret field's one-use ref, as the answer's wake text names it. */
export interface AskSecretRef {
  readonly ref: string;
  readonly expiresAt: string;
  /** Who can use it: the thread that asked, or whichever thread is working the card. */
  readonly redeemer: "asker" | "worker";
}
export type AskSecretRefs = Readonly<Record<string, AskSecretRef>>;

/** What the reader of a secretRef needs to know to use it, and what a failure means. */
const secretRefNote = (secret: AskSecretRef) =>
  `A secretRef stands for a value he typed privately; you never see the value. Pass the ref where a tool takes a secretRef (schedule_task signature.secretRef). It works once, until ${secret.expiresAt}, and only from ${secret.redeemer === "asker" ? "the thread that asked" : "the thread working this card"}. It is kept in memory only: if the tool says the ref is unavailable or expired, Robob restarted or the time ran out, and you ask him for it again with a new ask.`;

/**
 * Who may use the refs for an open ask's secret fields, or why the ask can't
 * take them. An ask a card's own thread raised is that thread's. One an
 * evaluator raised is for whoever works the card: the evaluator's thread ends
 * with its turn and the work thread often does not exist yet.
 */
export const secretPlan = (
  card: KanbanCard,
  ask: KanbanOwnerAsk,
  fieldIds: ReadonlyArray<string>,
):
  | { readonly redeemer: AskSecretRef["redeemer"]; readonly threadId: string | null }
  | AskProblem => {
  const ref = `${ask.id} on card #${card.number}`;
  if (ask.closedAt !== null) return conflict(`${ref} is already closed`);
  const fields = kanbanAskResponse(ask).fields;
  const unknown = fieldIds.filter(
    (id) => !fields.some((field) => field.id === id && field.type === "secret"),
  );
  if (unknown.length > 0) {
    return invalid(`${ref} has no secret field ${unknown.map((id) => `"${id}"`).join(", ")}`);
  }
  if (ask.by._tag === "thread") return { redeemer: "asker", threadId: ask.by.threadId };
  if (ask.by._tag === "evaluator") return { redeemer: "worker", threadId: null };
  return invalid(`${ref} was not raised by an agent, so nobody could use a secret given on it`);
};

/**
 * The stored answer for an owner's (or, for an ask with the evaluator, an
 * evaluator's) answer to an open ask, checked against the ask's response
 * parts, or why it can't be taken. Stale asks conflict: one past its
 * `expiresAt`, or one revised since the answerer read it. A file value comes
 * back as the uploads named; the service keeps the files and swaps them in.
 */
export const answerFor = (
  card: KanbanCard,
  ask: KanbanOwnerAsk,
  input: AskAnswerInput,
  by: KanbanActor,
  at: string,
  /** Ids of the secret fields he filled in over the app's private channel. */
  secrets: ReadonlySet<string> = NO_SECRETS,
): KanbanAskAnswer | AskProblem => {
  const ref = `${ask.id} on card #${card.number}`;
  if (ask.closedAt !== null) return conflict(`${ref} is already closed`);
  const revision = kanbanAskRevision(ask);
  // Only an ask answered in words alone may be answered without saying which version was read.
  if (input.revision === undefined && !kanbanAskIsFreeText(ask)) {
    return invalid(
      `${ref} needs the revision you are answering, so the answer can't land on a version you did not read. It is at revision ${revision}: read it as it is now, then send revision ${revision} with the answer.`,
    );
  }
  if (input.revision !== undefined && input.revision !== revision) {
    return conflict(
      `${ref} was updated since you read it (revision ${revision}, you answered revision ${input.revision}). Read it again and answer the current one.`,
    );
  }
  if (kanbanAskExpired(ask, Date.parse(at))) {
    return conflict(
      `${ref} expired at ${ask.expiresAt}: what it rests on${ask.basis ? ` (${ask.basis})` : ""} may have changed. Its asker has to renew it before it can be answered.`,
    );
  }
  const response = kanbanAskResponse(ask);
  const ids = [...new Set(input.optionIds ?? [])];
  let verdict = input.verdict;
  // A pick of the two verdict ids, as the ask's pick block sends it, is that verdict.
  if (verdict === "picked" && !response.choose && response.verdict && ids.length === 1) {
    if (ids[0] === "approve" || ids[0] === "reject") {
      verdict = ids[0] === "approve" ? "approved" : "rejected";
      ids.length = 0;
    }
  }
  const takes = verdictsFor(response);
  if (!(takes as ReadonlyArray<string>).includes(verdict)) {
    return invalid(`${ref} takes ${takes.join(", ")} (got "${verdict}")`);
  }
  const refusal = verdict === "rejected" || verdict === "cant";

  const note = line("note", input.note, ASK_LIMITS.note);
  if (isProblem(note)) return note;
  let text = line("answer", input.text, ASK_LIMITS.answerText);
  if (isProblem(text)) return text;

  const options = response.choose?.options ?? [];
  const unknown = ids.filter((id) => !options.some((option) => option.id === id));
  if (unknown.length > 0) {
    return invalid(
      `${ref} has no option ${unknown.map((id) => `"${id}"`).join(", ")}${options.length > 0 ? ` (it has ${options.map((option) => option.id).join(", ")})` : ""}`,
    );
  }
  if (verdict === "picked" && ids.length === 0) {
    return invalid("a picked answer needs optionIds");
  }
  if (response.choose) {
    const { min, max } = response.choose;
    if (ids.length > max) {
      return invalid(max === 1 ? `${ref} takes one option` : `${ref} takes at most ${max} options`);
    }
    // His own words instead of a pick stay possible, as in the card discussion.
    const inWords = verdict === "answered" && ids.length === 0;
    if (!refusal && !inWords && ids.length < min) {
      return invalid(`${ref} takes at least ${min} option${min === 1 ? "" : "s"}`);
    }
  }

  const given = input.values ?? {};
  const stray = Object.keys(given).filter(
    (id) => !response.fields.some((field) => field.id === id),
  );
  if (stray.length > 0) {
    return invalid(
      `${ref} has no field ${stray.map((id) => `"${id}"`).join(", ")}${response.fields.length > 0 ? ` (it has ${response.fields.map((field) => field.id).join(", ")})` : ""}`,
    );
  }
  const strays = [...secrets].filter(
    (id) => !response.fields.some((field) => field.id === id && field.type === "secret"),
  );
  if (strays.length > 0) {
    return invalid(`${ref} has no secret field ${strays.map((id) => `"${id}"`).join(", ")}`);
  }
  const values: Record<string, unknown> = {};
  for (const field of response.fields) {
    const raw = given[field.id];
    if (field.type === "secret") {
      // The value itself never comes this way: only that he gave it does.
      if (raw !== undefined && raw !== null) {
        return invalid(`${ref}: field "${field.id}" (${field.label}) ${SECRET_PRIVATE}`);
      }
      if (secrets.has(field.id)) {
        values[field.id] = KANBAN_ASK_SECRET_PROVIDED;
      } else if (field.required === true && !(verdict === "rejected" || verdict === "cant")) {
        return invalid(
          `${ref}: field "${field.id}" (${field.label}) is a secret only the owner can give, in the app's private field${by._tag === "owner" ? "" : ". Return the ask to him"}`,
        );
      }
      continue;
    }
    const empty = raw === undefined || raw === null || raw === "";
    // A plain question's one field is the answer in his own words.
    if (field.id === KANBAN_ASK_ANSWER_FIELD && ask.respond === undefined) {
      if (!empty && text === undefined) {
        const checked = fieldValue(field, raw);
        if (isProblem(checked)) return invalid(`the answer ${checked.detail}`);
        text = checked.value as string;
      }
      continue;
    }
    const proof = verdict === "done" && response.task?.proof === field.id;
    if (empty) {
      if ((field.required === true || proof) && !refusal) {
        return invalid(`${ref}: field "${field.id}" (${field.label}) is required`);
      }
      continue;
    }
    const checked = fieldValue(field, raw);
    if (isProblem(checked)) {
      return invalid(`${ref}: field "${field.id}" (${field.label}) ${checked.detail}`);
    }
    values[field.id] = checked.value;
  }
  if (verdict === "answered" && text === undefined && Object.keys(values).length === 0) {
    return invalid("an answered verdict needs text: the answer in your own words");
  }

  let finalDraft: string | undefined;
  let draftEdited: boolean | undefined;
  if (input.finalDraft !== undefined) {
    if (ask.draft === undefined) return invalid(`${ref} has no draft`);
    if (response.edit !== "draft") return invalid(`the draft on ${ref} is not his to edit`);
    if (input.finalDraft.trim() === "")
      return invalid("finalDraft is empty: reject the draft instead");
    const long = tooLong("finalDraft", input.finalDraft, ASK_LIMITS.draft);
    if (long) return long;
    finalDraft = input.finalDraft;
    draftEdited = finalDraft.trimEnd() !== ask.draft.text.trimEnd();
  } else if (ask.draft !== undefined && verdict === "approved") {
    finalDraft = ask.draft.text;
    draftEdited = false;
  }

  const handed = by._tag !== "owner";
  return compact<KanbanAskAnswer>({
    verdict: handed ? "handed" : verdict,
    decision: handed ? verdict : undefined,
    optionIds: ids.length > 0 ? ids : undefined,
    text,
    note,
    finalDraft,
    draftEdited,
    values:
      Object.keys(values).length > 0
        ? (values as NonNullable<KanbanAskAnswer["values"]>)
        : undefined,
    by,
    at: at as KanbanAskAnswer["at"],
  });
};

/** The file fields of an answer, so the service can keep their uploads. */
export const answerFiles = (
  ask: KanbanOwnerAsk,
  answer: KanbanAskAnswer,
): ReadonlyArray<{ readonly fieldId: string; readonly files: ReadonlyArray<AskFile> }> =>
  kanbanAskResponse(ask).fields.flatMap((field) => {
    const value = answer.values?.[field.id];
    return field.type === "file" && Array.isArray(value)
      ? [{ fieldId: field.id as string, files: value as unknown as ReadonlyArray<AskFile> }]
      : [];
  });

const verdictLine = (
  verdict: string,
  who: string,
  subject: string,
  response: KanbanAskResponse,
): string => {
  const labels = response.verdict;
  const chose = (label: string, plain: string) => (label === plain ? "" : ` He chose "${label}".`);
  switch (verdict) {
    case "approved":
      return `${who} APPROVED ${subject}.${labels ? chose(labels.approve, "Approve") : ""}`;
    case "rejected":
      return `${who} REJECTED ${subject}.${labels ? chose(labels.reject, "Reject") : ""}`;
    case "picked":
      return `${who} PICKED an answer to ${subject}.`;
    case "done":
      return `${who} has DONE ${subject}.`;
    case "cant":
      return `${who} COULD NOT DO ${subject}.`;
    case "acknowledged":
      return `${who} has SEEN ${subject}.`;
    default:
      return `${who} ANSWERED ${subject}.`;
  }
};

const valueText = (
  field: KanbanAskField,
  value: unknown,
  pathOf: (attachment: AskFile) => string | null,
): string => {
  const label = (id: unknown) =>
    field.options?.find((option) => option.id === id)?.label ?? String(id);
  switch (field.type) {
    case "toggle":
      return value === true ? "yes" : "no";
    case "number":
      return `${String(value)}${field.unit ? ` ${field.unit}` : ""}`;
    case "select":
      return Array.isArray(value) ? value.map(label).join("; ") : label(value);
    case "rank":
      return (Array.isArray(value) ? value : [])
        .map((id, index) => `${index + 1}. ${label(id)}`)
        .join(", ");
    case "file":
      return (Array.isArray(value) ? (value as ReadonlyArray<AskFile>) : [])
        .map((file) => `${file.name} (${pathOf(file) ?? "unavailable"})`)
        .join("; ");
    case "secret":
      return "he entered it privately";
    case "custom":
      return JSON.stringify(value);
    default:
      return String(value);
  }
};

/**
 * What wakes the agent that acts on an answer. It carries everything, in this
 * order: the verdict, the answer in his own words, his note, the options
 * picked, each value he filled in as "label: value", the text to post for a
 * draft. The note is not saved as a rule anywhere: the agent that reads it
 * decides what to do with it. `pathOf` gives a kept file's absolute path.
 */
export const answerText = (
  card: KanbanCard,
  ask: KanbanOwnerAsk,
  answer: KanbanAskAnswer,
  pathOf: (attachment: AskFile) => string | null = () => null,
  /** The one-use ref for each secret field he filled in. Only this text carries them. */
  secrets: AskSecretRefs = {},
) => {
  const handed = answer.verdict === "handed";
  const verdict = (handed ? answer.decision : answer.verdict) ?? "answered";
  const who = handed ? "The evaluator, deciding for the owner (he handed it over)," : "The owner";
  const subject = `${ask.id} on card #${card.number}: "${ask.title ?? ask.text}"`;
  const response = kanbanAskResponse(ask);
  const parts: Array<string> = [verdictLine(verdict, who, subject, response)];
  if (verdict === "rejected") parts.push("Do not go ahead with it as asked.");
  if (verdict === "cant") parts.push("Don't count on it being done.");
  if (answer.text !== undefined) {
    parts.push(`${handed ? "Its" : "His"} answer:\n${answer.text}`);
  }
  if (answer.note !== undefined) {
    parts.push(
      `${handed ? "Evaluator's" : "Owner's"} note, read this before you act:\n${answer.note}`,
    );
  }
  const picked = (answer.optionIds ?? []).flatMap((id) => {
    const option = pickOptions(ask).find((entry) => entry.id === id);
    return option ? [option.label] : [];
  });
  if (picked.length > 0) parts.push(`Picked: ${picked.join("; ")}`);
  const refs: Array<AskSecretRef> = [];
  const filled = response.fields.flatMap((field) => {
    const value = answer.values?.[field.id];
    if (value === undefined) return [];
    const secret = field.type === "secret" ? secrets[field.id] : undefined;
    if (secret !== undefined) refs.push(secret);
    return [
      `${field.label}: ${valueText(field, value, pathOf)}${secret ? `. secretRef: ${secret.ref}` : ""}`,
    ];
  });
  if (filled.length > 0) parts.push(filled.join("\n"));
  if (refs.length > 0) parts.push(secretRefNote(refs[0]!));
  if (ask.draft !== undefined && verdict !== "rejected" && answer.finalDraft !== undefined) {
    parts.push(
      answer.draftEdited === true
        ? `Post exactly this text (${handed ? "the evaluator" : "the owner"} edited your draft):\n${answer.finalDraft}`
        : "The draft is approved as you wrote it. Post exactly that text.",
    );
  }
  return parts.join("\n\n");
};

/** The answer as the ask's pick block shows it, for clients that only read the discussion. */
export const blockAnswer = (
  ask: KanbanOwnerAsk,
  answer: KanbanAskAnswer,
): { readonly choice: ReadonlyArray<string>; readonly text: string | null } => {
  const verdict = answer.verdict === "handed" ? answer.decision : answer.verdict;
  const options = pickOptions(ask);
  const approval = verdict === "approved" ? "approve" : verdict === "rejected" ? "reject" : null;
  const choice =
    answer.optionIds && answer.optionIds.length > 0
      ? answer.optionIds
      : approval !== null && options.some((option) => option.id === approval)
        ? [approval]
        : [];
  const words = [answer.text, answer.note].filter((entry) => entry !== undefined).join("\n\n");
  return { choice, text: words === "" ? (choice.length > 0 ? null : (verdict ?? null)) : words };
};

/**
 * A reply in words answers this ask: it takes words alone and has not expired.
 * Anything with a verdict, a pick, fields, a draft to edit or a task is
 * answered through the ask itself, where the answer is checked.
 */
export const takesReply = (ask: KanbanOwnerAsk, nowMs: number): boolean =>
  ask.closedAt === null && kanbanAskIsFreeText(ask) && !kanbanAskExpired(ask, nowMs);

/**
 * For whoever hears an owner reply which left asks open: his words are not an
 * answer to them. `asks` are the open asks the reply did not close.
 */
export const wordsOnlyNote = (
  card: KanbanCard,
  asks: ReadonlyArray<KanbanOwnerAsk>,
  nowMs: number,
): string =>
  asks
    .map((ask) => {
      const name = `${ask.id} on card #${card.number} ("${ask.title ?? ask.text}")`;
      return kanbanAskExpired(ask, nowMs)
        ? `${name} has expired, so this reply did not answer it. It is still open: ${askerName(ask.by)} asked it and renews it with card_ask_change, or drops it.`
        : `He wrote this in the card's discussion without using the answer on ${name}. It is not an approval, a pick or a decision on that ask: nobody may act as if it were. The ask is still open and now waits on its asker, ${askerName(ask.by)} (the evaluator when that thread cannot hear this): reply to him on it (discussion_post with ask "${ask.id}"), change the ask or ask again (card_ask_change), or drop it.`;
    })
    .join("\n");

/** A pick, or his own words, on an ask's pick block as the structured answer it stands for. */
export const pickAnswer = (
  ask: KanbanOwnerAsk,
  choice: ReadonlyArray<string>,
  words: string,
): AskAnswerInput => ({
  verdict: choice.length > 0 ? "picked" : "answered",
  ...(choice.length > 0 ? { optionIds: choice } : {}),
  ...(words === "" ? {} : { text: words }),
  // The pick was made on the ask's current message: that is the revision it read.
  revision: kanbanAskRevision(ask),
});

/**
 * How an ask closed when it went through the old paths (a reply or pick in the
 * discussion, a drop, a card moved on). The answer itself stays in the discussion.
 */
export const plainAnswer = (by: KanbanActor, at: string, dropped: boolean): KanbanAskAnswer => ({
  verdict: dropped ? "dropped" : "answered",
  by,
  at: at as KanbanAskAnswer["at"],
});

/** For an evaluator passing on an answer whose asker can't hear it any more. */
export const passOnText = (card: KanbanCard, ask: KanbanOwnerAsk, answer: string) =>
  `This answers question ${ask.id} on card #${card.number} ("${ask.text}"), asked by a thread that has moved on. Act on it or pass it on (card_edit, card_thread):\n\n${answer}`;

export const droppedText = (card: KanbanCard, ask: KanbanOwnerAsk, byOwner: boolean) =>
  `Question ${ask.id} on card #${card.number} ("${ask.text}") was dropped${byOwner ? " by the owner" : ""}. Go on without it.`;

/** The ask in full, for an agent that has to act on it without reading the card. */
const askInFull = (ask: KanbanOwnerAsk) => {
  const detail = askDetail(ask);
  const options = pickOptions(ask);
  const shown = ask.blocks?.length ?? 0;
  return [
    `Question (${kanbanAskKind(ask)}): ${ask.text}`,
    detail === "" ? null : detail,
    shown > 0
      ? `It shows ${shown} block${shown === 1 ? "" : "s"} of evidence (text, pages, images or files)${ask.seq === null ? "" : `: read them with discussion_read (card, seq ${ask.seq})`}.`
      : null,
    options.length > 0
      ? `Options${ask.multi === true ? " (several may be picked)" : ""}: ${options.map((option) => `${option.id} = ${option.label}`).join("; ")}`
      : null,
    `It takes the verdict ${verdictsFor(kanbanAskResponse(ask)).join(" or ")}.`,
    kanbanAskIsFreeText(ask)
      ? null
      : `It is at revision ${kanbanAskRevision(ask)}: an answer to it must say so (revision ${kanbanAskRevision(ask)}).`,
  ]
    .filter((entry) => entry !== null)
    .join("\n\n");
};

/**
 * The owner replied on an ask without answering it. `passedOn` is for the
 * evaluator that gets it when the asker can't hear it (a parked or ended
 * thread): the ask stays open, and blocking if it was.
 */
export const clarifyText = (
  card: KanbanCard,
  ask: KanbanOwnerAsk,
  ownerText: string,
  passedOn: boolean,
) =>
  [
    `The owner replied on ${ask.id} on card #${card.number} ("${ask.title ?? ask.text}") without answering it. It stays open${ask.blocking ? " and still holds the card" : ""}, and now waits on you, not on him.`,
    passedOn
      ? "The thread that asked it can't hear this (it is parked or has moved on), so it is yours to handle."
      : null,
    `His message:\n${ownerText}`,
    `Reply to him with discussion_post (card #${card.number}, ask "${ask.id}"): that keeps the ask open and gives him the turn back. If the question, context or options were unclear or wrong, fix the ask itself with card_ask_change (ask "${ask.id}", the fields to change, revisionNote saying what changed) instead of only explaining. Don't treat his message as the answer.`,
    passedOn ? askInFull(ask) : null,
  ]
    .filter((entry) => entry !== null)
    .join("\n\n");

const askerName = (by: KanbanActor) =>
  by._tag === "thread"
    ? `the card's thread (${by.threadId})`
    : by._tag === "evaluator"
      ? `an evaluator (${by.threadId})`
      : "the owner";

/**
 * What an evaluator started by "hand it to the evaluator every time" is told:
 * his words as he wrote them, the ask, and that asks like it are the
 * evaluator's from now on. Nothing is stored as a rule: what to do about it
 * is the evaluator's call.
 */
export const alwaysText = (
  card: KanbanCard,
  cardRef: string,
  ask: KanbanOwnerAsk,
  ownerWords: string | undefined,
) =>
  [
    `The owner handed an ask to the evaluator and said to do that every time for asks like it.`,
    ownerWords?.trim() ? `His words:\n${ownerWords.trim()}` : "He added no words of his own.",
    [
      `The ask: ${ask.id} on card ${cardRef} ("${card.title}"), kind ${kanbanAskKind(ask)}, asked by ${askerName(ask.by)}.`,
      ask.title ? `Title: ${ask.title}` : null,
      `Question: ${ask.text}`,
    ]
      .filter((entry) => entry !== null)
      .join("\n"),
    "He wants asks like this one handled by the evaluator from now on and not sent to him; how to make that happen is your call. This one is already with the card's evaluator to decide.",
  ].join("\n\n");

/**
 * An ask is with the evaluator, which decides it: the owner handed it over,
 * or (`fromOwner` false) its asker addressed it to the evaluator.
 */
export const handText = (card: KanbanCard, ask: KanbanOwnerAsk, fromOwner = true) =>
  [
    fromOwner
      ? `The owner handed you ${ask.id} on card #${card.number} to decide for him.`
      : `${ask.id} on card #${card.number} was asked to you, the evaluator, not to the owner: decide it for him.`,
    askInFull(ask),
    `Decide it with what you know about the card, the board and his rules, then record it with card_ask_answer (card #${card.number}, ask "${ask.id}", verdict, and optionIds / text / values / note / finalDraft as the ask needs). Whoever asked hears your decision as the answer, marked as yours. If only he can decide, say why with discussion_post (ask "${ask.id}") and give it ${fromOwner ? "back" : "to him"} with card_ask_change (ask "${ask.id}", action "return").`,
  ].join("\n\n");

/** The first line of the message that shows an edited ask in its discussion. */
export const revisedLine = (ask: KanbanOwnerAsk) =>
  `Updated ${ask.id} (revision ${kanbanAskRevision(ask)})${ask.revisionNote ? `: ${ask.revisionNote}` : ""}`;

/** What a tool call on an ask returns: never the card, never the prompt. */
export const askSummary = (card: KanbanCard, askId: string) => {
  const ask = card.asks.find((entry) => entry.id === askId);
  return {
    card: card.number,
    stage: card.stage,
    ask: ask
      ? {
          id: ask.id,
          kind: kanbanAskKind(ask),
          revision: kanbanAskRevision(ask),
          blocking: ask.blocking,
          open: ask.closedAt === null,
          blocks: ask.blocks?.length ?? 0,
          ...(ask.clarifyAskedAt === undefined ? {} : { waitingOnAgent: true }),
          ...(ask.handedAt === undefined ? {} : { handed: true }),
        }
      : null,
  };
};

export { isProblem as isAskProblem };
