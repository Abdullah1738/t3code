import { KANBAN_BACKLOG, OrchestratorMcpFailure, type McpReasonClass } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Asks from "../engine/asks.ts";
import { modelSelectionResult } from "../engine/defaults.ts";
import type { ExactEdits } from "../engine/exactEdits.ts";
import { optionLabelRefusesApproval, planSubtasks } from "../engine/subtasks.ts";
import { controlChars, textProblem } from "../engine/text.ts";
import { WAIT_ARGS_MAX } from "../engine/waits.ts";
import type { KanbanToolkit } from "./tools.ts";

type Input<K extends keyof typeof KanbanToolkit.tools> =
  (typeof KanbanToolkit.tools)[K]["parametersSchema"]["Type"];

const invalid = (message: string, invalidField: string | undefined, reasonClass: McpReasonClass) =>
  new OrchestratorMcpFailure({
    code: "invalid_request",
    reason: "invalid_args",
    reasonClass,
    ...(invalidField === undefined ? {} : { invalidField }),
    message,
  });

const isIsoTime = (value: string) => {
  const date = DateTime.make(value);
  const day = DateTime.make(`${value.slice(0, 10)}T00:00:00.000Z`);
  return (
    /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) &&
    Option.isSome(date) &&
    Option.isSome(day) &&
    DateTime.formatIso(day.value).slice(0, 10) === value.slice(0, 10)
  );
};

// Schema decoding already precedes access checks. These semantic checks must also
// precede caller lookup, which can wait for a SQLite reader before the board gate.
const text = (
  input: object,
  labels: Readonly<Record<string, string>> = {},
  skip: ReadonlyArray<string> = [],
): OrchestratorMcpFailure | undefined => {
  const visit = (value: unknown, path: string, label?: string): string | undefined => {
    if (typeof value === "string")
      return controlChars(value) === null ? undefined : (textProblem([[path, value]]) ?? undefined);
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      const problem = visit(child, label ?? (path ? `${path}.${key}` : key), label);
      if (problem) return problem;
    }
    return;
  };
  for (const [field, value] of Object.entries(input)) {
    if (skip.includes(field)) continue;
    const problem = visit(value, labels[field] ?? field, labels[field]);
    if (problem) return invalid(problem, field, "other");
  }
  return;
};

const editsProblem = (edits: typeof ExactEdits.Type | undefined, field: string, label: string) => {
  const removable = new Set<string>();
  for (const edit of (edits ?? []).toReversed()) {
    let replacement = edit.newString;
    // A later exact edit may remove temporary markers. Whether it does needs stored text.
    for (const char of removable) replacement = replacement.replaceAll(char, " ");
    const problem = textProblem([[label, replacement]]);
    if (problem) return invalid(problem, field, "other");
    for (const char of edit.oldString) {
      if (controlChars(char) !== null) removable.add(char);
    }
  }
  return;
};

const cardFields = (input: Input<"card_edit"> | Input<"card_create">, creating = false) => {
  const problem = text(input, { subtasks: "subtask text" }, ["promptEdits", "subtaskEdits"]);
  if (problem) return problem;
  const ids = new Set<string>();
  for (const subtask of input.subtasks ?? []) {
    const id = subtask.id?.trim();
    if (id && ids.has(id)) return invalid(`subtask ${id} is listed twice`, "subtasks", "conflict");
    if (id) ids.add(id);
    // Whether an explicit id exists (including legacy ids) is checked under the gate.
    if (!id && (subtask.text === undefined || subtask.owner === undefined))
      return invalid("a new subtask needs text and owner", "subtasks", "missing_required");
    if (subtask.clearGate !== undefined) {
      if (!id)
        return invalid("clearGate needs an existing subtask id", "subtasks", "missing_required");
      if (subtask.gate != null)
        return invalid(
          "clearGate cannot be combined with an explicit gate",
          "subtasks",
          "conflict",
        );
      const length = subtask.clearGate.trim().length;
      if (length < 10 || length > 300)
        return invalid("clearGate needs a reason of 10–300 characters", "subtasks", "too_long");
    }
  }
  // Only guaranteed-new entries can be checked without their stored owners or state.
  const plan = planSubtasks(
    [],
    (input.subtasks ?? []).filter((subtask) => creating || subtask.id === undefined),
  );
  if (!plan.ok) return invalid(plan.reason, "subtasks", "other");
  if (input.models?.length === 0)
    return invalid("models needs at least one model", "models", "missing_required");
  for (const [field, model] of [
    ["model", input.model],
    ...(input.models ?? []).map((model) => ["models", model] as const),
  ] as const) {
    if (model === undefined) continue;
    const selection = modelSelectionResult(model, false);
    if (selection.kind === "conflict") return invalid(selection.reason, field, "conflict");
  }
  return;
};

export const card_edit = (input: Input<"card_edit">) => {
  const problem =
    cardFields(input) ??
    editsProblem(input.promptEdits, "promptEdits", "prompt") ??
    editsProblem(input.subtaskEdits, "subtaskEdits", "subtask text");
  if (problem) return problem;
  if (input.prompt !== undefined && input.promptEdits !== undefined)
    return invalid("pass prompt or promptEdits, not both", "prompt", "conflict");
  if (input.subtasks !== undefined && input.subtaskEdits !== undefined)
    return invalid("pass subtasks or subtaskEdits, not both", "subtasks", "conflict");
  if ((input.prompt !== undefined || input.subtasks !== undefined) && !input.basedOn?.trim())
    return invalid(
      "card_edit with prompt or subtasks requires basedOn from the updatedAt of the card you read; use card_get, merge your change, and retry",
      "basedOn",
      "missing_required",
    );
  if (input.basedOn !== undefined && !isIsoTime(input.basedOn))
    return invalid(
      "basedOn must be the ISO updatedAt from the card you read",
      "basedOn",
      "bad_time",
    );
  return;
};

export const card_create = (input: Input<"card_create">) => {
  const problem = cardFields(input, true);
  if (problem) return problem;
  if (!input.prompt.trim() && !input.title?.trim())
    return invalid("a card needs a prompt or a title", "prompt", "missing_required");
  if (input.forThread !== undefined && input.assignToSelf)
    return invalid(
      "Use forThread or assignToSelf, not both. Nothing was saved.",
      "forThread",
      "conflict",
    );
  if (
    input.forThread !== undefined &&
    (input.priority === KANBAN_BACKLOG || input.stage === "needs_owner")
  )
    return invalid(
      "forThread needs a todo card outside the backlog. Nothing was saved.",
      input.priority === KANBAN_BACKLOG ? "priority" : "stage",
      "conflict",
    );
  if (input.assignToSelf && input.priority === KANBAN_BACKLOG)
    return invalid(
      "A backlog card isn't picked up; leave out assignToSelf.",
      "priority",
      "conflict",
    );
  return;
};

export const card_update = (input: Input<"card_update">) => text(input);
export const card_move = (input: Input<"card_move">) => text(input);
export const subtask_done = (input: Input<"subtask_done">) => {
  const problem = text({ note: input.note });
  if (problem) return problem;
  if (input.releasedAt !== undefined) {
    if (!isIsoTime(input.releasedAt))
      return invalid("releasedAt must be an ISO datetime", "releasedAt", "bad_time");
    if (input.state !== "done")
      return invalid("releasedAt requires marking a subtask done", "releasedAt", "conflict");
  }
  if (input.state === "skipped" && !input.note?.trim())
    return new OrchestratorMcpFailure({
      code: "invalid_request",
      reason: "skip_note_required",
      reasonClass: "missing_required",
      invalidField: "note",
      message: "say why the subtask is skipped",
    });
  return;
};
export const card_flag = (input: Input<"card_flag">) => text(input);

export const card_ask = (input: Input<"card_ask">) => {
  const problem = text(input);
  if (problem) return problem;
  if (!input.question.trim())
    return invalid("an ask needs the question", "question", "missing_required");
  if (
    input.options?.some(
      (option) => typeof option !== "string" && option.approves?.some((id) => !id.trim()),
    )
  )
    return invalid("approves needs non-empty subtask ids", "options", "missing_required");
  // No card is supplied here: approval targets and card-dependent rules stay in askOwner.
  const fields = Asks.askFields(
    {
      ...input,
      options: input.options?.map((option) =>
        typeof option === "string" || optionLabelRefusesApproval(option.label)
          ? option
          : { ...option, approves: undefined },
      ),
    },
    { blocking: input.blocking ?? false },
  );
  if (Asks.isAskProblem(fields))
    return invalid(fields.detail, fields.invalidField, fields.reasonClass ?? "other");
  return;
};

export const card_wait = (input: Input<"card_wait">) => {
  const problem = text({ note: input.note });
  if (problem) return problem;
  if (input.clear) return;
  const on = input.on ?? (input.script === undefined ? undefined : "script");
  if (on === undefined)
    return invalid("Pass on (what the card waits on) or clear.", "on", "missing_required");
  if (input.script !== undefined && on !== "script")
    return invalid(
      `script goes with on: script. ${on} is one of the board's own checks, and a script can't stand in for it.`,
      "script",
      "conflict",
    );
  if (!input.note?.trim())
    return invalid(
      "A wait needs a one-line note: what exactly is awaited.",
      "note",
      "missing_required",
    );
  if (input.until !== undefined && !Number.isFinite(Date.parse(input.until)))
    return invalid(`until is not a time: ${input.until}`, "until", "bad_time");
  if (on === "time" && input.until === undefined)
    return invalid("a time wait needs until", "until", "missing_required");
  if (on === "card" && input.waitsOn === undefined)
    return invalid("say which card to wait on (waitsOn)", "waitsOn", "missing_required");
  if (on === "owner_go" && input.ask === undefined)
    return invalid(
      "an owner_go wait points at an open question: ask it first with card_ask, then pass its id (q1, q2...) as ask",
      "ask",
      "missing_required",
    );
  if (on === "script" && !input.script?.trim())
    return invalid(
      "a script wait names the board script that checks it (script)",
      "script",
      "missing_required",
    );
  if (on === "script" && input.args !== undefined) {
    if (JSON.stringify(input.args).length > WAIT_ARGS_MAX)
      return invalid(
        `args is too big: keep it under ${WAIT_ARGS_MAX} characters of JSON`,
        "args",
        "too_long",
      );
    const every = input.args.everyMs;
    if (every !== undefined && !(typeof every === "number" && Number.isFinite(every)))
      return invalid(
        "args.everyMs is how often to check, in milliseconds: a number",
        "args",
        "bad_type",
      );
  }
  return;
};

export const discussion_post = (input: Input<"discussion_post">) => {
  const problem = text(input, { text: "message", blocks: "message" });
  if (problem) return problem;
  if (!input.text?.trim() && !input.blocks?.length)
    return invalid("Pass text or blocks.", "text", "missing_required");
  if (input.ask?.trim()) {
    const blocks = [
      ...(input.text?.trim() ? [{ _tag: "md" as const, text: input.text }] : []),
      ...(input.blocks ?? []),
    ];
    const size = Asks.replyBlocksProblem(blocks);
    if (size)
      return invalid(
        size.detail,
        input.blocks === undefined ? "text" : "blocks",
        size.reasonClass ?? "other",
      );
  }
  return;
};

export const wiki_read = (input: Input<"wiki_read">) => {
  if (input.slug !== undefined && input.slugs !== undefined)
    return invalid("Pass slug or slugs, not both.", "slug", "conflict");
  if ((input.section !== undefined || input.outline === true) && input.slug === undefined)
    return invalid("section and outline require slug", "slug", "missing_required");
  if (input.section !== undefined && input.outline === true)
    return invalid("Pass section or outline, not both.", "section", "conflict");
  return;
};

export const wiki_write = (input: Input<"wiki_write">) => {
  const problem =
    text(input, { body: "wiki body" }, ["edits"]) ??
    editsProblem(input.edits, "edits", "wiki body");
  if (problem) return problem;
  if ((input.body === undefined) === (input.edits === undefined))
    return invalid("Pass exactly one of body or edits.", "body", "conflict");
  if (
    !input.slug
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
  )
    return invalid("a wiki page needs a slug", "slug", "missing_required");
  return;
};
