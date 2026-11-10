/** A card's questions for the owner: blocking ones hold it in Needs Owner, async ones don't. */
import {
  kanbanAskExpired,
  kanbanAskKind,
  kanbanAskRevision,
  kanbanOpenAsks,
  type KanbanActor,
  type KanbanAskAction,
  type KanbanAskAnswer,
  type KanbanAskBlock,
  type KanbanAskChange,
  type KanbanAskDraft,
  type KanbanAskKind,
  type KanbanAskOption,
  type KanbanBlock,
  type KanbanCard,
  type KanbanError,
  type KanbanOwnerAsk,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import { stubBlockAt } from "./messagePages.ts";

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
          // Closed asks are nobody's turn any more.
          const { clarifyAskedAt: _clarify, handedAt: _handed, ...rest } = ask;
          return record === undefined
            ? { ...rest, closedAt: at }
            : { ...rest, closedAt: at, answer: record };
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
    | "change"
    | "basis"
    | "expiresAt"
    | "batchKey"
    | "blocks"
  >
>;

type Format = "markdown" | "text";
export interface AskFieldsInput {
  readonly kind?: KanbanAskKind | undefined;
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
  readonly change?:
    | {
        readonly label: string;
        readonly before: string;
        readonly after: string;
        readonly format?: Format | undefined;
      }
    | undefined;
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
      : [["option", option.label] as const, ["option detail", option.detail] as const],
  ),
  ["draft", input.draft?.text],
  ["draft target", input.draft?.target],
  ["action", input.action?.summary],
  ["action command", input.action?.command],
  ["action target", input.action?.target],
  ...(input.action?.evidence ?? []).map((line) => ["action evidence", line] as const),
  ["action undo", input.action?.undo],
  ["change label", input.change?.label],
  ["change before", input.change?.before],
  ["change after", input.change?.after],
  ["basis", input.basis],
  ["batchKey", input.batchKey],
];

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

const inferKind = (input: AskFieldsInput): KanbanAskKind =>
  input.draft
    ? "draft"
    : input.action
      ? "action"
      : input.change
        ? "change"
        : (input.options?.length ?? 0) > 1
          ? "decision"
          : "question";

const NEEDS: Record<KanbanAskKind, string> = {
  question: "a question ask takes the question, context and (when the answers are known) options",
  decision: "a decision ask needs at least two options",
  draft: "a draft ask needs draft: { text } with the exact text you will post or send",
  action: "an action ask needs action: { summary } saying what will be done",
  change: "a change ask needs change: { label, before, after }",
};

/**
 * Checks and normalizes what an asker wrote into the stored fields. `kind` is
 * inferred from the body it carries when left out.
 */
export const askFields = (input: AskFieldsInput): AskFields | AskProblem => {
  const kind = input.kind ?? inferKind(input);
  const bodies = (["draft", "action", "change"] as const).filter(
    (name) => input[name] !== undefined,
  );
  const own = kind === "draft" || kind === "action" || kind === "change" ? kind : null;
  const stray = bodies.filter((name) => name !== own);
  if (stray.length > 0) {
    return invalid(
      `a ${kind} ask can't carry ${stray.join(" or ")}: ask one thing per ask (${NEEDS[kind]})`,
    );
  }
  if (own !== null && input[own] === undefined) return invalid(NEEDS[kind]);

  const title = line("title", input.title, ASK_LIMITS.title);
  if (isProblem(title)) return title;
  const context = line("context", input.context, ASK_LIMITS.context);
  if (isProblem(context)) return context;
  const basis = line("basis", input.basis, ASK_LIMITS.basis);
  if (isProblem(basis)) return basis;
  const batchKey = line("batchKey", input.batchKey, ASK_LIMITS.batchKey);
  if (isProblem(batchKey)) return batchKey;

  const blocks = input.blocks ?? [];
  const blocksProblem = askBlocksProblem(blocks);
  if (blocksProblem) return blocksProblem;

  let expiresAt: string | undefined;
  if (input.expiresAt !== undefined && input.expiresAt.trim() !== "") {
    const time = DateTime.make(input.expiresAt);
    if (Option.isNone(time)) return invalid("expiresAt is not a time (use ISO 8601)");
    expiresAt = DateTime.formatIso(time.value);
  }

  const raw = input.options ?? [];
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
      }),
    );
  }
  if (kind === "decision" && options.length < 2) return invalid(NEEDS.decision);

  let draft: KanbanAskDraft | undefined;
  if (input.draft !== undefined) {
    if (input.draft.text.trim() === "") return invalid(NEEDS.draft);
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
    if (summary === undefined) return invalid(NEEDS.action);
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

  let change: KanbanAskChange | undefined;
  if (input.change !== undefined) {
    const label = line("change label", input.change.label, ASK_LIMITS.changeLabel);
    if (label === undefined) return invalid(NEEDS.change);
    if (isProblem(label)) return label;
    const before = tooLong("change before", input.change.before, ASK_LIMITS.changeText);
    if (before) return before;
    const after = tooLong("change after", input.change.after, ASK_LIMITS.changeText);
    if (after) return after;
    if (input.change.before === input.change.after) {
      return invalid("a change ask needs before and after to differ");
    }
    change = {
      label,
      before: input.change.before,
      after: input.change.after,
      format: input.change.format ?? "markdown",
    };
  }

  return compact<AskFields>({
    kind,
    title,
    context,
    options: options.length > 0 ? options : undefined,
    multi: options.length > 0 && input.multi === true ? true : undefined,
    draft,
    action,
    change,
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
  change: ask.change,
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
  "change",
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
 * again for its kind, and the revision goes up. Whoever was waiting on the
 * asker (a clarifying question) is not any more.
 */
export const reviseAsk = (
  ask: KanbanOwnerAsk,
  edit: AskEdit,
  at: string,
): KanbanOwnerAsk | AskProblem => {
  const merged: AskFieldsInput = { ...fieldsInput(ask) };
  for (const key of FIELD_KEYS) {
    if (edit[key] !== undefined) (merged as Record<string, unknown>)[key] = edit[key];
  }
  // A new body decides the kind unless the edit names one.
  if (edit.kind === undefined && (edit.draft || edit.action || edit.change)) {
    (merged as { kind?: KanbanAskKind }).kind = inferKind(edit);
    for (const body of ["draft", "action", "change"] as const) {
      if (edit[body] === undefined) delete (merged as Record<string, unknown>)[body];
    }
  }
  // Stored blocks may be stubs: only new ones are checked, and kept ones stay as they are.
  const fields = askFields({ ...merged, blocks: edit.blocks });
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
    basis: _basis,
    expiresAt: _expiresAt,
    batchKey: _batchKey,
    revisionNote: _note,
    clarifyAskedAt: _clarify,
    blocks: stored,
    ...kept
  } = ask;
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

/** The owner asked about the ask instead of answering it: it waits on its asker. */
export const markClarify = (card: KanbanCard, askId: string, at: string): KanbanCard =>
  updateAsk(card, askId, { clarifyAskedAt: at as NonNullable<KanbanOwnerAsk["clarifyAskedAt"]> });

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

export const markHanded = (card: KanbanCard, askId: string, at: string): KanbanCard =>
  updateAsk(without(card, askId, "clarifyAskedAt"), askId, {
    handedAt: at as NonNullable<KanbanOwnerAsk["handedAt"]>,
  });

export const clearHanded = (card: KanbanCard, askId: string): KanbanCard =>
  without(card, askId, "handedAt");

const APPROVAL_OPTIONS: ReadonlyArray<KanbanAskOption> = [
  { id: "approve" as KanbanAskOption["id"], label: "Approve" as KanbanAskOption["label"] },
  { id: "reject" as KanbanAskOption["id"], label: "Reject" as KanbanAskOption["label"] },
];

/** The options of the ask's pick block: its own, or Approve / Reject for an approval with none. */
export const pickOptions = (ask: KanbanOwnerAsk): ReadonlyArray<KanbanAskOption> => {
  if (ask.options && ask.options.length > 0) return ask.options;
  const kind = kanbanAskKind(ask);
  return kind === "draft" || kind === "action" || kind === "change" ? APPROVAL_OPTIONS : [];
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
  if (ask.change) {
    parts.push(
      `**Change: ${ask.change.label}**\n\nBefore:\n\n${ask.change.before}\n\nAfter:\n\n${ask.change.after}`,
    );
  }
  const options = (ask.options ?? []).filter((option) => option.detail || option.recommended);
  if (options.length > 0) {
    parts.push(
      options
        .map(
          (option) =>
            `- **${option.label}**${option.recommended ? " (recommended)" : ""}${option.detail ? `: ${option.detail}` : ""}`,
        )
        .join("\n"),
    );
  }
  if (ask.basis) parts.push(`Based on: ${ask.basis}`);
  return parts.join("\n\n");
};

/**
 * The ask as a discussion message. A plain question is one md block; with
 * options it is a pick whose block id is the ask id and whose option ids are
 * the ask's, so a client that only knows picks can still answer it. A draft,
 * action or change with no options of its own gets an Approve / Reject pick.
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

export type OwnerVerdict = "approved" | "rejected" | "picked" | "answered";
export interface AskAnswerInput {
  readonly verdict: OwnerVerdict;
  readonly optionIds?: ReadonlyArray<string> | undefined;
  readonly text?: string | undefined;
  readonly note?: string | undefined;
  readonly finalDraft?: string | undefined;
  /** The revision the answerer saw; a newer one refuses the answer. */
  readonly revision?: number | undefined;
}

const conflict = (detail: string): AskProblem => ({ code: "conflict", detail });

/**
 * The stored answer for an owner's (or, for a handed ask, an evaluator's)
 * verdict on an open ask, or why it can't be taken. Stale asks conflict: one
 * past its `expiresAt`, or one revised since the answerer read it.
 */
export const answerFor = (
  card: KanbanCard,
  ask: KanbanOwnerAsk,
  input: AskAnswerInput,
  by: KanbanActor,
  at: string,
): KanbanAskAnswer | AskProblem => {
  const ref = `${ask.id} on card #${card.number}`;
  if (ask.closedAt !== null) return conflict(`${ref} is already closed`);
  const revision = kanbanAskRevision(ask);
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
  const note = line("note", input.note, ASK_LIMITS.note);
  if (isProblem(note)) return note;
  const text = line("answer", input.text, ASK_LIMITS.answerText);
  if (isProblem(text)) return text;

  const options = pickOptions(ask);
  const ids = [...new Set(input.optionIds ?? [])];
  const unknown = ids.filter((id) => !options.some((option) => option.id === id));
  if (unknown.length > 0) {
    return invalid(
      `${ref} has no option ${unknown.map((id) => `"${id}"`).join(", ")}${options.length > 0 ? ` (it has ${options.map((option) => option.id).join(", ")})` : ""}`,
    );
  }
  if (input.verdict === "picked" && ids.length === 0) {
    return invalid("a picked answer needs optionIds");
  }
  if (ids.length > 1 && ask.multi !== true) {
    return invalid(`${ref} takes one option`);
  }
  if (input.verdict === "answered" && text === undefined) {
    return invalid("an answered verdict needs text: the answer in your own words");
  }

  let finalDraft: string | undefined;
  let draftEdited: boolean | undefined;
  if (input.finalDraft !== undefined) {
    if (ask.draft === undefined) return invalid(`${ref} has no draft`);
    if (input.finalDraft.trim() === "")
      return invalid("finalDraft is empty: reject the draft instead");
    const long = tooLong("finalDraft", input.finalDraft, ASK_LIMITS.draft);
    if (long) return long;
    finalDraft = input.finalDraft;
    draftEdited = finalDraft.trimEnd() !== ask.draft.text.trimEnd();
  } else if (ask.draft !== undefined && input.verdict === "approved") {
    finalDraft = ask.draft.text;
    draftEdited = false;
  }

  const handed = by._tag !== "owner";
  return compact<KanbanAskAnswer>({
    verdict: handed ? "handed" : input.verdict,
    decision: handed ? input.verdict : undefined,
    optionIds: ids.length > 0 ? ids : undefined,
    text,
    note,
    finalDraft,
    draftEdited,
    by,
    at: at as KanbanAskAnswer["at"],
  });
};

const VERDICT_WORD: Record<OwnerVerdict, string> = {
  approved: "APPROVED",
  rejected: "REJECTED",
  picked: "PICKED an answer to",
  answered: "ANSWERED",
};

/**
 * What wakes the agent that acts on an answer. It carries everything, in this
 * order: the verdict, the answer in his own words, his note, the text to post
 * for a draft, the options picked. The note is not saved as a rule anywhere:
 * the agent that reads it decides what to do with it.
 */
export const answerText = (card: KanbanCard, ask: KanbanOwnerAsk, answer: KanbanAskAnswer) => {
  const handed = answer.verdict === "handed";
  const verdict = (handed ? answer.decision : answer.verdict) as OwnerVerdict;
  const who = handed ? "The evaluator, deciding for the owner (he handed it over)," : "The owner";
  const subject = `${ask.id} on card #${card.number}: "${ask.title ?? ask.text}"`;
  const parts: Array<string> = [`${who} ${VERDICT_WORD[verdict]} ${subject}.`];
  if (verdict === "rejected") parts.push("Do not go ahead with it as asked.");
  if (answer.text !== undefined) {
    parts.push(`${handed ? "Its" : "His"} answer:\n${answer.text}`);
  }
  if (answer.note !== undefined) {
    parts.push(
      `${handed ? "Evaluator's" : "Owner's"} note, read this before you act:\n${answer.note}`,
    );
  }
  if (ask.draft !== undefined && verdict !== "rejected" && answer.finalDraft !== undefined) {
    parts.push(
      answer.draftEdited === true
        ? `Post exactly this text (${handed ? "the evaluator" : "the owner"} edited your draft):\n${answer.finalDraft}`
        : "The draft is approved as you wrote it. Post exactly that text.",
    );
  }
  const picked = (answer.optionIds ?? []).flatMap((id) => {
    const option = pickOptions(ask).find((entry) => entry.id === id);
    return option ? [option.label] : [];
  });
  if (picked.length > 0) parts.push(`Picked: ${picked.join("; ")}`);
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

/** The owner handed one ask to the evaluator, which decides it on his behalf. */
export const handText = (card: KanbanCard, ask: KanbanOwnerAsk) =>
  [
    `The owner handed you ${ask.id} on card #${card.number} to decide for him.`,
    askInFull(ask),
    `Decide it with what you know about the card, the board and his rules, then record it with card_ask_answer (card #${card.number}, ask "${ask.id}", verdict, and optionIds / text / note / finalDraft as the ask needs). Whoever asked hears your decision as the answer, marked as yours. If only he can decide, say why with discussion_post (ask "${ask.id}") and give it back with card_ask_change (ask "${ask.id}", action "return").`,
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
