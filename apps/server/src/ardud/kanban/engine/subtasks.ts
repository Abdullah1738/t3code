/**
 * A card's subtasks: its flow as steps (write the PR, review, merge and
 * deploy, tell the reporter, read back). Pure rules; KanbanService applies them.
 */
import {
  kanbanOpenStep,
  kanbanStepSubtasks,
  type KanbanActor,
  type KanbanCard,
  type KanbanSubtask,
} from "@t3tools/contracts";

const MAX_SUBTASKS = 30;
const MAX_TEXT = 500;

export interface SubtaskInput {
  /** An existing subtask's id keeps its state; leave out for a new one. */
  readonly id?: string | undefined;
  /** Same step as another means any order; leave out for the step after the previous entry. */
  readonly step?: number | undefined;
  readonly text: string;
  readonly owner: KanbanSubtask["owner"];
}

/**
 * What an evaluator does first on a card a thread or a script made: the prompt
 * it came with is a note, and the work thread (maybe the cheapest model) only
 * gets the prompt.
 */
export const PACKET_SUBTASK =
  "Write the packet: read what the card points at (sessions, PRs, the code, the architecture) and rewrite its prompt with card_edit so the cheapest model can do it: scope, files, steps, tests, and when it's done. Add the rest of the plan.";

/** Puts the packet first; every step the inputs set moves one later. */
export const withPacketStep = (
  inputs: ReadonlyArray<SubtaskInput>,
): ReadonlyArray<SubtaskInput> => [
  { step: 1, text: PACKET_SUBTASK, owner: "evaluator" },
  ...inputs.map((input) => (input.step === undefined ? input : { ...input, step: input.step + 1 })),
];

export type SubtaskPlan =
  | { readonly ok: true; readonly subtasks: ReadonlyArray<KanbanSubtask> }
  | { readonly ok: false; readonly reason: string };

/**
 * Who is marking a subtask. Evaluators can mark any; a worker only its own
 * kind. A reviewer marks none: its verdict ticks the review's subtasks.
 */
export type SubtaskRole = "work" | "review" | "evaluator";

export type MarkCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const idNumber = (id: string) => Number.parseInt(id.replace(/^s/, ""), 10) || 0;

/**
 * Replaces a card's plan with `inputs`. Listed ids keep their state; new
 * entries get the next id. A done or skipped subtask left out stays: what
 * happened isn't rewritten, only what's still to do.
 */
export function planSubtasks(
  existing: ReadonlyArray<KanbanSubtask>,
  inputs: ReadonlyArray<SubtaskInput>,
): SubtaskPlan {
  const byId = new Map(existing.map((subtask) => [subtask.id, subtask]));
  let nextId = existing.reduce((max, subtask) => Math.max(max, idNumber(subtask.id)), 0);
  const listed = new Set<string>();
  const planned: Array<KanbanSubtask> = [];
  let step = 0;
  for (const input of inputs) {
    const text = input.text.trim();
    if (text.length === 0) return { ok: false, reason: "a subtask needs text" };
    if (text.length > MAX_TEXT) {
      return { ok: false, reason: `a subtask is at most ${MAX_TEXT} characters` };
    }
    if (input.step !== undefined && (!Number.isInteger(input.step) || input.step < 1)) {
      return { ok: false, reason: "a subtask's step is a whole number from 1" };
    }
    step = input.step ?? step + 1;
    const id = input.id?.trim();
    if (id) {
      const known = byId.get(id);
      if (!known) return { ok: false, reason: `the card has no subtask ${id}` };
      if (listed.has(id)) return { ok: false, reason: `subtask ${id} is listed twice` };
      listed.add(id);
      planned.push({ ...known, step, text, owner: input.owner });
    } else {
      nextId += 1;
      planned.push({
        id: `s${nextId}`,
        step,
        text,
        owner: input.owner,
        state: "open",
        note: null,
        doneBy: null,
        doneAt: null,
      });
    }
  }
  const kept = existing.filter((subtask) => !listed.has(subtask.id) && subtask.state !== "open");
  const subtasks = [...planned, ...kept].toSorted((a, b) => a.step - b.step);
  if (subtasks.length > MAX_SUBTASKS) {
    return { ok: false, reason: `a card has at most ${MAX_SUBTASKS} subtasks` };
  }
  return { ok: true, subtasks };
}

/** Whether `role` may set subtask `id` to `state`. */
export function checkMark(
  card: Pick<KanbanCard, "number" | "subtasks">,
  id: string,
  state: KanbanSubtask["state"],
  role: SubtaskRole,
  note: string | null,
): MarkCheck {
  const subtask = card.subtasks.find((candidate) => candidate.id === id);
  if (!subtask) return { ok: false, reason: `card #${card.number} has no subtask ${id}` };
  if (subtask.state === state) return { ok: false, reason: `subtask ${id} is already ${state}` };
  if (state === "skipped" && !note?.trim()) {
    return { ok: false, reason: "say why the subtask is skipped" };
  }
  if (role === "evaluator") return { ok: true };
  if (role === "review") {
    return {
      ok: false,
      reason: "a review ticks its subtasks with its verdict (card_review_result)",
    };
  }
  if (state === "open") return { ok: false, reason: "only an evaluator reopens a subtask" };
  if (subtask.owner !== role) {
    return {
      ok: false,
      reason: `subtask ${id} is for the ${OWNER_NAMES[subtask.owner]}, not you`,
    };
  }
  if (subtask.step !== kanbanOpenStep(card)) {
    return {
      ok: false,
      reason: `subtask ${id} is in step ${subtask.step}; finish step ${kanbanOpenStep(card)} first`,
    };
  }
  return { ok: true };
}

export const markSubtask = (
  subtasks: ReadonlyArray<KanbanSubtask>,
  id: string,
  state: KanbanSubtask["state"],
  note: string | null,
  by: KanbanActor,
  at: string,
): ReadonlyArray<KanbanSubtask> =>
  subtasks.map((subtask) =>
    subtask.id !== id
      ? subtask
      : state === "open"
        ? { ...subtask, state, note: null, doneBy: null, doneAt: null }
        : { ...subtask, state, note: note?.trim() || null, doneBy: by, doneAt: at },
  );

/** A passed review marks the review subtasks of the step the card is on. */
export function passReview(
  card: Pick<KanbanCard, "subtasks">,
  by: KanbanActor,
  at: string,
): ReadonlyArray<KanbanSubtask> {
  const ids = new Set(kanbanStepSubtasks(card, "review").map((subtask) => subtask.id));
  return card.subtasks.map((subtask) =>
    ids.has(subtask.id)
      ? { ...subtask, state: "done", note: "Review passed", doneBy: by, doneAt: at }
      : subtask,
  );
}

/**
 * Stages a card goes back to work from once its plan's next step is the
 * worker's, when no thread is on it. Todo is already there; working always has
 * a live thread; in_review has none once its review passed and it waits for
 * its PRs; needs_owner waits on the owner's answer.
 */
export const BACK_TO_WORK_FROM: ReadonlySet<KanbanCard["stage"]> = new Set([
  "needs_review",
  "in_review",
  "completed",
  "deployed",
  "verified",
]);

/** After a passed review: whether the step the card is on now has work for its worker. */
export const workAfterReview = (card: Pick<KanbanCard, "subtasks">) =>
  kanbanStepSubtasks(card, "work").length > 0;

export const OWNER_NAMES: Record<KanbanSubtask["owner"], string> = {
  work: "worker",
  review: "reviewer",
  evaluator: "evaluator",
};

/** The plan as brief lines, with what's done and what's next. */
export function subtaskLines(card: Pick<KanbanCard, "subtasks">): string | null {
  if (card.subtasks.length === 0) return null;
  const current = kanbanOpenStep(card);
  const rows = card.subtasks.map((subtask) => {
    const mark =
      subtask.state === "done"
        ? "done"
        : subtask.state === "skipped"
          ? "skipped"
          : subtask.step === current
            ? "now"
            : "later";
    const note = subtask.note ? `: ${subtask.note}` : "";
    return `- ${subtask.id} step ${subtask.step}, ${OWNER_NAMES[subtask.owner]} (${mark}${note}): ${subtask.text}`;
  });
  return `Subtasks (same step means any order; a step opens when the ones before are done or skipped):\n${rows.join("\n")}`;
}

/** The wake note that sends a card's worker to its next step. */
export const nextStepNote = (card: Pick<KanbanCard, "subtasks">, lead = "") =>
  `${lead}Next on the plan:\n${subtaskLines(card)}\n\nDo this step's work subtasks, mark each with subtask_done, then card_move to needs_review.`;

/** Ids of open subtasks, for refusals: "s1, s3". */
export const subtaskIds = (subtasks: ReadonlyArray<KanbanSubtask>) =>
  subtasks.map((subtask) => subtask.id).join(", ");
