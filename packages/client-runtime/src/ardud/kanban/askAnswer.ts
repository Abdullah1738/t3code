/**
 * What the owner has filled in on one ask, and the answer that goes to the
 * server for it. Pure: everything is decided from `kanbanAskResponse(ask)`,
 * never from the ask's kind, so an ask of a kind nobody has sent before is
 * checked and sent the same way.
 */
import * as DateTime from "effect/DateTime";

import {
  KANBAN_ASK_ANSWER_FIELD,
  kanbanAskResponse,
  kanbanResponseTakesWords,
  type KanbanAskField,
  type KanbanAskResponse,
  type KanbanOwnerAsk,
} from "@t3tools/contracts";

/** A file the attachment store already holds, as an answer carries it. */
export interface AskAnswerFile {
  readonly type: "image" | "file";
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
}

/** The field types this build draws; any other type is shown and checked as text. */
export type AskFieldKind =
  | "text"
  | "longtext"
  | "number"
  | "date"
  | "datetime"
  | "toggle"
  | "select"
  | "rank"
  | "file"
  | "secret"
  | "custom";

const FIELD_KINDS: ReadonlySet<string> = new Set([
  "text",
  "longtext",
  "number",
  "date",
  "datetime",
  "toggle",
  "select",
  "rank",
  "file",
  "secret",
  "custom",
]);

export const askFieldKind = (field: Pick<KanbanAskField, "type">): AskFieldKind =>
  FIELD_KINDS.has(field.type) ? (field.type as AskFieldKind) : "text";

/** Limits the server applies, so a value it would refuse is caught while typing. */
export const ASK_ANSWER_LIMITS = {
  text: 2_000,
  longtext: 20_000,
  note: 4_000,
  customBytes: 8 * 1024,
} as const;

/**
 * Everything typed, picked or ticked on one ask. Values are held the way their
 * input holds them (a number as its text, a datetime as `YYYY-MM-DDTHH:mm`) and
 * converted when the answer is built. A secret's value is never kept here: its
 * entry is `{ secret: true }` once the private channel has taken it.
 */
export interface AskForm {
  readonly optionIds: ReadonlyArray<string>;
  /** His own words in place of a pick. */
  readonly ownWords: string;
  readonly values: Readonly<Record<string, unknown>>;
  /** The draft as he left it; null while untouched. */
  readonly draft: string | null;
  /** He said no and the page is asking what is wrong. */
  readonly refusing: boolean;
  readonly why: string;
  readonly note: string;
  /** Task steps he ticked. For his eyes only; never sent. */
  readonly steps: ReadonlyArray<number>;
}

const defaultValue = (field: KanbanAskField): unknown => {
  switch (askFieldKind(field)) {
    case "rank":
      return Array.isArray(field.default)
        ? field.default
        : (field.options ?? []).map((option) => option.id);
    case "toggle":
      return field.default === true;
    case "number":
      return typeof field.default === "number" ? String(field.default) : "";
    case "select":
      return field.multi === true
        ? Array.isArray(field.default)
          ? field.default
          : []
        : typeof field.default === "string"
          ? field.default
          : "";
    case "file":
    case "secret":
      return undefined;
    case "custom":
      return field.default;
    default:
      return typeof field.default === "string" ? field.default : "";
  }
};

/** A fresh form for an ask: each field at its default, nothing picked. */
export function askFormFor(ask: KanbanOwnerAsk): AskForm {
  const response = kanbanAskResponse(ask);
  const values: Record<string, unknown> = {};
  for (const field of response.fields) values[field.id] = defaultValue(field);
  return {
    optionIds: [],
    ownWords: "",
    values,
    draft: null,
    refusing: false,
    why: "",
    note: "",
    steps: [],
  };
}

/**
 * The form to show after the agent edited the ask: what he typed is kept
 * wherever the new version still has a place for it.
 */
export function askFormCarried(ask: KanbanOwnerAsk, previous: AskForm): AskForm {
  const fresh = askFormFor(ask);
  const response = kanbanAskResponse(ask);
  const optionIds = previous.optionIds.filter((id) =>
    (response.choose?.options ?? []).some((option) => option.id === id),
  );
  const values: Record<string, unknown> = { ...fresh.values };
  for (const field of response.fields) {
    if (field.id in previous.values && previous.values[field.id] !== undefined) {
      values[field.id] = previous.values[field.id];
    }
  }
  return { ...previous, optionIds, values, steps: [] };
}

const isEmpty = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  (typeof value === "string" && value.trim() === "") ||
  (Array.isArray(value) && value.length === 0);

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const fileAccepted = (accepts: ReadonlyArray<string>, file: AskAnswerFile): boolean =>
  accepts.some((entry) => {
    const rule = entry.trim().toLowerCase();
    if (rule.startsWith(".")) return file.name.toLowerCase().endsWith(rule);
    if (rule.endsWith("/*")) return file.mimeType.toLowerCase().startsWith(rule.slice(0, -1));
    return file.mimeType.toLowerCase() === rule;
  });

const range = (field: KanbanAskField): string => {
  const unit = field.unit ? ` ${field.unit}` : "";
  if (field.min !== undefined && field.max !== undefined) {
    return `Enter ${field.min} to ${field.max}${unit}`;
  }
  return field.min !== undefined
    ? `Enter ${field.min}${unit} or more`
    : `Enter ${field.max}${unit} or less`;
};

/**
 * What is wrong with one field's value, in the page's words, or null. `required`
 * is passed in because a task's proof field is required only for "done".
 */
export function askFieldProblem(
  field: KanbanAskField,
  value: unknown,
  required: boolean = field.required === true,
): string | null {
  const kind = askFieldKind(field);
  if (kind === "toggle") return null;
  if (kind === "secret") {
    const provided =
      typeof value === "object" &&
      value !== null &&
      (value as { secret?: unknown }).secret === true;
    return provided || !required ? null : "Paste it first";
  }
  if (isEmpty(value)) {
    if (!required) return null;
    if (kind === "file") return "Add the file first";
    if (kind === "custom") return "Pick a value above first";
    if (kind === "select") return "Pick one first";
    return "Fill this in first";
  }
  switch (kind) {
    case "number": {
      const number = typeof value === "number" ? value : Number(String(value).trim());
      if (!Number.isFinite(number)) return "Enter a number";
      if (
        (field.min !== undefined && number < field.min) ||
        (field.max !== undefined && number > field.max)
      ) {
        return range(field);
      }
      return null;
    }
    case "date":
      return typeof value === "string" &&
        DATE.test(value) &&
        !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
        ? null
        : "Pick a date";
    case "datetime":
      return typeof value === "string" && !Number.isNaN(Date.parse(value))
        ? null
        : "Pick a date and time";
    case "select": {
      const ids = Array.isArray(value) ? value : [value];
      const known = new Set<unknown>((field.options ?? []).map((option) => option.id));
      return ids.every((id) => known.has(id)) ? null : "Pick one of the options";
    }
    case "rank": {
      const known = (field.options ?? []).map((option) => option.id as string);
      const order = Array.isArray(value) ? value : [];
      return order.length === known.length && new Set(order).size === known.length
        ? null
        : "Put every item in order";
    }
    case "file": {
      const files = Array.isArray(value) ? (value as ReadonlyArray<AskAnswerFile>) : [];
      const max = field.maxFiles ?? 1;
      if (files.length > max) return max === 1 ? "One file only" : `At most ${max} files`;
      const wrong = field.accepts
        ? files.find((file) => !fileAccepted(field.accepts!, file))
        : null;
      return wrong ? `${wrong.name} is not ${field.accepts!.join(", ")}` : null;
    }
    case "custom": {
      const json = JSON.stringify(value);
      return json !== undefined &&
        new TextEncoder().encode(json).length > ASK_ANSWER_LIMITS.customBytes
        ? "That value is too large to send"
        : null;
    }
    default: {
      const max = kind === "longtext" ? ASK_ANSWER_LIMITS.longtext : ASK_ANSWER_LIMITS.text;
      return typeof value === "string" && value.length > max
        ? `Keep it under ${max.toLocaleString("en-US")} characters`
        : null;
    }
  }
}

/** A field value as the server takes it. */
const wireValue = (field: KanbanAskField, value: unknown): unknown => {
  switch (askFieldKind(field)) {
    case "number":
      return typeof value === "number" ? value : Number(String(value).trim());
    case "datetime":
      // The input holds local wall time; the server takes the instant.
      return DateTime.formatIso(DateTime.makeUnsafe(Date.parse(String(value))));
    case "text":
    case "longtext":
      return String(value);
    default:
      return value;
  }
};

/** The body of `POST .../asks/:ask/answer`. */
export interface AskAnswerBody {
  readonly verdict: string;
  readonly optionIds?: ReadonlyArray<string>;
  readonly text?: string;
  readonly note?: string;
  readonly finalDraft?: string;
  readonly values?: Readonly<Record<string, unknown>>;
  readonly revision?: number;
}

/** The plain question's one field: its value travels as the answer's `text`. */
export const isPlainAnswerField = (
  ask: Pick<KanbanOwnerAsk, "respond">,
  field: Pick<KanbanAskField, "id">,
): boolean => ask.respond === undefined && field.id === KANBAN_ASK_ANSWER_FIELD;

const recommendedId = (response: KanbanAskResponse): string | null =>
  response.choose?.options.find((option) => option.recommended === true)?.id ?? null;

/** The draft text that would be posted: his edit, or the agent's own. */
export const askDraftText = (ask: Pick<KanbanOwnerAsk, "draft">, form: AskForm): string =>
  form.draft ?? ask.draft?.text ?? "";

export const askDraftEdited = (ask: Pick<KanbanOwnerAsk, "draft">, form: AskForm): boolean =>
  form.draft !== null && form.draft.trimEnd() !== (ask.draft?.text ?? "").trimEnd();

export type AskIntent = "primary" | "refuse";

/** Where a problem sits, so the page can mark it and move focus there. */
export type AskProblemKey = "choose" | "why" | "draft" | "note" | `field:${string}`;

export type AskAnswerResult =
  | {
      readonly ok: true;
      readonly body: AskAnswerBody;
      /** What the answer is called once given: "Approved", "Deploy", "Answer sent". */
      readonly label: string;
    }
  | {
      readonly ok: false;
      readonly problems: Readonly<Partial<Record<AskProblemKey, string>>>;
      readonly first: AskProblemKey;
    };

/** Whether a "no" on this ask asks for a reason, and whether it must be given. */
export function askRefusal(response: KanbanAskResponse): {
  readonly label: string;
  readonly why: "required" | "optional" | "none";
  readonly prompt: string;
} | null {
  if (response.ack) return null;
  if (response.task) {
    return { label: "Couldn't", why: "required", prompt: "What stopped you?" };
  }
  if (response.verdict) {
    // A plain Reject goes at once (the note can carry a reason); a named "no"
    // ("Fails", "Don't deploy") is about something specific, so the page asks what.
    const plain = response.verdict.reject === "Reject";
    return {
      label: response.verdict.reject,
      why: plain ? "none" : "optional",
      prompt: "What's wrong?",
    };
  }
  return null;
}

/**
 * His own words, when they are all the form holds for a pick he has to make.
 * Words alone never close such an ask (the server refuses them), so they go
 * out as a reply on it and the ask stays open. Null when the form answers the
 * ask, holds no words, or the ask takes words as its answer.
 */
export function askWordsForReply(ask: KanbanOwnerAsk, form: AskForm): string | null {
  if (form.refusing) return null;
  const response = kanbanAskResponse(ask);
  if (
    response.ack ||
    response.verdict !== null ||
    response.task !== null ||
    response.choose === null ||
    kanbanResponseTakesWords(response)
  ) {
    return null;
  }
  const words = form.ownWords.trim();
  return words !== "" && form.optionIds.length === 0 ? words : null;
}

/** The label of the main button for the form as it stands. */
export function askPrimaryLabel(ask: KanbanOwnerAsk, form: AskForm): string {
  const response = kanbanAskResponse(ask);
  if (response.ack) return "Seen";
  if (askWordsForReply(ask, form) !== null) return "Send as a reply";
  if (form.refusing) {
    const refusal = askRefusal(response);
    return refusal ? `Send: ${refusal.label.toLowerCase()}` : "Send";
  }
  if (response.task) return "Done";
  if (response.verdict) {
    if (response.edit === "draft" && askDraftEdited(ask, form)) return "Send your text";
    return response.verdict.approve;
  }
  if (
    response.choose &&
    !response.choose.multi &&
    form.optionIds.length === 0 &&
    form.ownWords.trim() === "" &&
    recommendedId(response) !== null
  ) {
    return "Accept recommendation";
  }
  return "Send answer";
}

type LooseBody = { readonly [K in keyof AskAnswerBody]: AskAnswerBody[K] | undefined } & {
  readonly verdict: string;
};

/** The body without the keys nothing was given for. */
const clean = (body: LooseBody): AskAnswerBody => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) if (value !== undefined) out[key] = value;
  return out as unknown as AskAnswerBody;
};

/**
 * The answer for the form as it stands, or what stops it. `primary` is the
 * main button (approve, send, done, seen); `refuse` is the "no" (reject,
 * couldn't). A single-pick ask with nothing picked takes its recommended
 * option, as the button says.
 */
export function buildAskAnswer(
  ask: KanbanOwnerAsk,
  form: AskForm,
  intent: AskIntent,
  revision?: number,
): AskAnswerResult {
  const response = kanbanAskResponse(ask);
  const problems: Partial<Record<AskProblemKey, string>> = {};
  const order: Array<AskProblemKey> = [];
  const problem = (key: AskProblemKey, text: string) => {
    if (problems[key] === undefined) order.push(key);
    problems[key] = text;
  };
  const note = response.ack ? undefined : form.note.trim() || undefined;
  if (note !== undefined && note.length > ASK_ANSWER_LIMITS.note) {
    problem(
      "note",
      `Keep the note under ${ASK_ANSWER_LIMITS.note.toLocaleString("en-US")} characters`,
    );
  }
  const fail = (): AskAnswerResult => ({ ok: false, problems, first: order[0]! });

  if (response.ack) {
    return { ok: true, body: clean({ verdict: "acknowledged", revision }), label: "Seen" };
  }

  if (intent === "refuse") {
    const refusal = askRefusal(response);
    if (refusal === null) {
      problem("why", "This ask can't be rejected. Reply to its agent instead.");
      return fail();
    }
    const why = form.why.trim();
    if (refusal.why === "required" && why === "") {
      problem("why", "Say what, so the agent can act on it");
    }
    if (order.length > 0) return fail();
    return {
      ok: true,
      body: clean({
        verdict: response.task ? "cant" : "rejected",
        text: why || undefined,
        note,
        revision,
      }),
      label: refusal.label === "Reject" ? "Rejected" : refusal.label,
    };
  }

  let optionIds = [...form.optionIds];
  const words = form.ownWords.trim();
  if (response.choose) {
    const { min, max, multi } = response.choose;
    if (optionIds.length === 0 && !multi && words === "") {
      const recommended = recommendedId(response);
      if (recommended !== null) optionIds = [recommended];
    }
    if (optionIds.length > max) {
      problem("choose", max === 1 ? "Pick one" : `Pick at most ${max}`);
    } else if (optionIds.length < min && words === "") {
      problem("choose", min === 1 ? "Pick one first" : `Pick at least ${min}`);
    } else if (optionIds.length < min) {
      // Words are not a pick: the page sends them as a reply (`askWordsForReply`), never as the answer.
      problem("choose", "Pick one to answer. Your words alone go as a reply.");
    }
  }

  const values: Record<string, unknown> = {};
  let text: string | undefined = words || undefined;
  for (const field of response.fields) {
    const value = form.values[field.id];
    const proof = response.task?.proof === field.id;
    const wrong = askFieldProblem(field, value, field.required === true || proof);
    if (wrong !== null) {
      problem(`field:${field.id}`, wrong);
      continue;
    }
    if (askFieldKind(field) === "toggle") {
      values[field.id] = value === true;
      continue;
    }
    if (isEmpty(value)) continue;
    if (isPlainAnswerField(ask, field)) {
      text = String(value).trim();
      continue;
    }
    values[field.id] = wireValue(field, value);
  }

  let finalDraft: string | undefined;
  if (response.edit === "draft" && askDraftEdited(ask, form)) {
    if (askDraftText(ask, form).trim() === "") {
      problem("draft", "The draft is empty. Reject it instead.");
    } else {
      finalDraft = askDraftText(ask, form);
    }
  }

  const verdict = response.task
    ? "done"
    : response.verdict
      ? "approved"
      : response.choose && optionIds.length > 0
        ? "picked"
        : "answered";
  if (
    verdict === "answered" &&
    text === undefined &&
    Object.keys(values).length === 0 &&
    order.length === 0
  ) {
    const first = response.fields[0];
    problem(
      response.choose ? "choose" : first ? `field:${first.id}` : "why",
      response.choose ? "Pick one, or type your answer" : "Fill in at least one",
    );
  }
  if (order.length > 0) return fail();

  const label = response.task
    ? "Done"
    : response.verdict
      ? finalDraft !== undefined
        ? "Approved with your edits"
        : response.verdict.approve === "Approve"
          ? "Approved"
          : response.verdict.approve
      : "Answer sent";
  return {
    ok: true,
    body: clean({
      verdict,
      optionIds: optionIds.length > 0 ? optionIds : undefined,
      text,
      note,
      finalDraft,
      values: Object.keys(values).length > 0 ? values : undefined,
      revision,
    }),
    label,
  };
}

/**
 * What one answer sent to several asks can fill in, mirroring the server's own
 * test: a verdict, a pick from the same options, a plain question's free text,
 * or a notice's "seen". Null for an ask that takes more than that.
 */
export function askBatchShape(ask: KanbanOwnerAsk): string | null {
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
}

/** Why an ask can't ride with a batch, in one short line. */
const batchSkipReason = (ask: KanbanOwnerAsk, shape: string | null): string => {
  const response = kanbanAskResponse(ask);
  if (shape !== null) return "It takes a different answer from the rest.";
  if (response.task) return "It has steps for you to do.";
  if (response.edit) return "It has a draft you can edit.";
  if (response.verdict && response.choose) return "It also asks you to choose.";
  if (response.fields.length > 0) return "It also asks for values.";
  return "It needs its own answer.";
};

export interface AskBatchPlan<T> {
  /** The one shape every included ask shares; null when nothing can be batched. */
  readonly shape: string | null;
  /** Asks one answer can go to. */
  readonly included: ReadonlyArray<T>;
  /** Asks left for their own answer, each with why. */
  readonly skipped: ReadonlyArray<{ readonly item: T; readonly why: string }>;
}

/** Splits a group of asks into the ones one answer fits and the ones it doesn't. */
export function planAskBatch<T extends { readonly ask: KanbanOwnerAsk; readonly expired: boolean }>(
  items: ReadonlyArray<T>,
): AskBatchPlan<T> {
  const counts = new Map<string, number>();
  const shapes = items.map((item) => (item.expired ? null : askBatchShape(item.ask)));
  for (const shape of shapes) if (shape !== null) counts.set(shape, (counts.get(shape) ?? 0) + 1);
  // The shape most of them share; the first one seen breaks a tie.
  let shape: string | null = null;
  for (const [key, count] of counts) {
    if (shape === null || count > (counts.get(shape) ?? 0)) shape = key;
  }
  const included: Array<T> = [];
  const skipped: Array<{ item: T; why: string }> = [];
  items.forEach((item, index) => {
    if (shape !== null && shapes[index] === shape) included.push(item);
    else {
      skipped.push({
        item,
        why: item.expired
          ? "The facts changed. It needs a refresh first."
          : batchSkipReason(item.ask, shapes[index] ?? null),
      });
    }
  });
  return { shape, included, skipped };
}

/** At most this many asks in one batch answer (the server's limit). */
export const ASK_BATCH_MAX = 50;
