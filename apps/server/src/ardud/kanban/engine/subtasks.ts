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

export const inferGate = (text: string): KanbanSubtask["gate"] => {
  if (
    /\b(deploy\w*|install\w*|restart\w*|launchagents?|release(?:s|d)?(?!\s+(?:(?:the|a|an)\s+)?(?:Run\s+Cloud\s+)?(?:sessions?|emulators?|sims?|simulators?|box|boxes|holds?|locks?|slots?|phones?|devices?)\b))\b/i.test(
      text,
    )
  )
    return "deploy";
  if (
    /\b(pay(?:ment|ments)?|purchase\w*|charg(?:e|es|ed|ing)|refund\w*|money transfer)\b/i.test(text)
  )
    return "money";
  if (
    /\b(?:share|provide|enter|paste|set|store|create|generate|issue|rotate|regenerate|revoke|reveal|send|give|hand\s+over|add)\b[^.;\r\n]{0,40}\b(?:secrets?|passwords?|credentials?|tokens?|(?:(?:api|private|signing|ssh)\s+)?keys?)\b/i.test(
      text,
    )
  )
    return "secret";
  return undefined;
};

export const gateOf = (
  subtask: Pick<KanbanSubtask, "owner" | "gate" | "text">,
): KanbanSubtask["gate"] =>
  // Older plans also stored inferred gates on read-only review checklists.
  subtask.owner === "review" ? undefined : (subtask.gate ?? inferGate(subtask.text));

export const isNegativeOption = (label: string): boolean =>
  /(?:^(?:no\b|not\b|don[’']?t\b|do\s+not\b|reject\b|drop\b|skip\b|leave\b|hold\b|cancel\b|wait\b|stop\b)|\b(?:later|tomorrow|not yet|next week|next month)\b)/i.test(
    label.trim(),
  );

const approvalAction = (text: string): string =>
  text
    .toLowerCase()
    .replace(/\b(?:the|a|an)\b/g, "")
    .trim()
    .replace(/[.!]+$/, "")
    .trim()
    .replace(/^deployment\b/, "deploy")
    .replace(/^installation\b/, "install")
    .replace(/^payment\b/, "pay")
    .replace(/^buy\b/, "purchase")
    .replace(/^sharing\b/, "share")
    .replace(/\s+/g, " ");

const harmlessFollowup = (task: string, target: string): boolean => {
  const text = task
    .trim()
    .replace(/[.!]+$/, "")
    .trim();
  const suffix =
    /(?:\s+(?:(?:and(?:\s+then)?|then)\s+)?|\s*,\s*(?:then\s+)?)(?:read back|read-back|verify|check|confirm|test|report back)(?:\s+(?:its version|it|the result))?$/i.exec(
      text,
    );
  if (!suffix) return false;
  const action = text.slice(0, suffix.index).trimEnd();
  // Keep the suffix raw: removing articles could turn an extra object ("the test") into a verb.
  return !/(?:[.!]|\b(?:a|an|the))$/i.test(action) && approvalAction(action) === target;
};

const approvesGate = (
  label: string,
  gate: NonNullable<KanbanSubtask["gate"]>,
  task: string,
): boolean => {
  const words = label
    .trim()
    .replace(/[.!]+$/, "")
    .trim();
  if (
    isNegativeOption(words) ||
    /\b(?:if|unless|after|before|once|when|pending|first|then)\b/i.test(words)
  )
    return false;
  const command = words
    .replace(/^(?:yes|ok|okay)(?:\s*[,.:;–—-]\s*|\s+)/i, "")
    .replace(/^(?:(?:please|go ahead and)\s+)+/i, "");
  if (/^(?:yes|approve|approved|go|go ahead|go for it|ok|okay|do it|proceed)$/i.test(command))
    return true;
  const action = command.replace(/^(?:approve|approved|authorize)\s+/i, "");
  const normalized = approvalAction(action);
  const target = normalized.replace(/\s+now$/, "");
  const taskAction = approvalAction(task);
  if (target === taskAction.replace(/\s+now$/, "")) return true;
  let verb: RegExp;
  switch (gate) {
    case "deploy":
      verb = /^(?:deploy|install|restart|release)\b/i;
      break;
    case "money":
      verb = /^(?:pay|purchase|buy|charge|refund|transfer)\b/i;
      break;
    case "secret":
      verb = /^(?:share|provide|use|enter|set|rotate|reveal|send|show)\b/i;
      break;
  }
  const operation = action !== command ? normalized : action;
  const matched = verb.exec(operation)?.[0];
  if (!matched) return false;
  const suffix = taskAction.startsWith(target) ? taskAction.slice(target.length) : null;
  if (suffix !== null && action === command && normalized === target)
    return harmlessFollowup(task, target);
  return (
    /^(?:\s+(?:it|this|that|these|those))?(?:\s+now)?$/i.test(operation.slice(matched.length)) ||
    (suffix !== null && harmlessFollowup(task, target))
  );
};

/** Legacy plans have no timestamps: their card's creation is the earliest safe bound. */
export const approvalProblem = (
  card: Pick<KanbanCard, "number" | "asks" | "createdAt">,
  subtask: KanbanSubtask,
): string | null => {
  const gate = gateOf(subtask);
  if (gate === undefined) return null;
  const since = subtask.createdAt ?? card.createdAt;
  const decisions = card.asks
    .filter((ask) => {
      const answer = ask.answer;
      if (!ask.closedAt || !answer || answer.at < since) return false;
      if (answer.verdict === "dropped") return true;
      if (answer.by._tag !== "owner" || (ask.revisedAt ?? ask.at) < since) return false;
      if (ask.draft) return false;
      return (
        inferGate(`${ask.text} ${ask.title ?? ""} ${ask.action?.summary ?? ""}`) === gate ||
        (ask.text.match(/\bs\d+\b/g) ?? []).some((id) => id === subtask.id)
      );
    })
    .toSorted((a, b) => a.answer!.at.localeCompare(b.answer!.at));
  const latest = decisions.at(-1);
  const answer = latest?.answer;
  const approved =
    answer?.verdict === "approved" ||
    (answer?.verdict === "picked" &&
      Boolean(answer.optionIds?.length) &&
      answer.optionIds!.every((id) => {
        const option = latest?.options?.find((entry) => entry.id === id);
        return option !== undefined && approvesGate(option.label, gate, subtask.text);
      }));
  return approved
    ? null
    : `card #${card.number} subtask ${subtask.id} (${gate}: ${subtask.text}) needs Abdullah's approval after it was created; a dropped ask is not approval`;
};

export const MAX_SUBTASKS = 30;
export const MAX_TEXT = 500;

export interface SubtaskInput {
  /** An existing subtask's id keeps its state; leave out for a new one. */
  readonly id?: string | undefined;
  /** Same step as another means any order; leave out for the step after the previous entry. */
  readonly step?: number | undefined;
  readonly text: string;
  readonly owner: KanbanSubtask["owner"];
  readonly gate?: KanbanSubtask["gate"];
  /** For a script's subtask: the name of the board script that does it. Absent: any script on the card's board. */
  readonly script?: string | undefined;
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
  | {
      readonly ok: true;
      readonly subtasks: ReadonlyArray<KanbanSubtask>;
      /** The card's counter after this plan; store it with the card. */
      readonly subtaskSeq: number;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Who is marking a subtask. Evaluators can mark any; a worker only its own
 * kind. A reviewer marks none: its verdict ticks the review's subtasks.
 */
export type SubtaskRole = "work" | "review" | "evaluator" | "script";

export type MarkCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const idNumber = (id: string) => Number.parseInt(id.replace(/^s/, ""), 10) || 0;

/**
 * Replaces a card's plan with `inputs`. Listed ids keep their state; new
 * entries get the next id. A done or skipped subtask left out stays: what
 * happened isn't rewritten, only what's still to do. `seq` is the card's
 * counter of ids ever handed out, so an open subtask dropped from the plan
 * never has its id reused by a later entry.
 */
export function planSubtasks(
  existing: ReadonlyArray<KanbanSubtask>,
  inputs: ReadonlyArray<SubtaskInput>,
  seq = 0,
  at?: string,
): SubtaskPlan {
  const byId = new Map(existing.map((subtask) => [subtask.id, subtask]));
  // Cards saved before the counter existed start from the highest id still on them.
  let nextId = existing.reduce((max, subtask) => Math.max(max, idNumber(subtask.id)), seq);
  const listed = new Set<string>();
  const planned: Array<KanbanSubtask> = [];
  let step = 0;
  for (const input of inputs) {
    const text = input.text.trim();
    if (text.length === 0) return { ok: false, reason: "a subtask needs text" };
    if (text.length > MAX_TEXT) {
      return { ok: false, reason: `a subtask is at most ${MAX_TEXT} characters` };
    }
    const script = input.script?.trim() || undefined;
    if (script && input.owner !== "script") {
      return {
        ok: false,
        reason: `subtask "${text}" names a script, so its owner must be "script"`,
      };
    }
    if (input.step !== undefined && (!Number.isInteger(input.step) || input.step < 1)) {
      return { ok: false, reason: "a subtask's step is a whole number from 1" };
    }
    step = input.step ?? step + 1;
    const id = input.id?.trim();
    if (id) {
      const known = byId.get(id);
      if (!known)
        return {
          ok: false,
          reason: `the card has no subtask ${id}. Existing subtask ids: ${subtaskIds(existing) || "none"}`,
        };
      if (listed.has(id)) return { ok: false, reason: `subtask ${id} is listed twice` };
      listed.add(id);
      const { script: _old, gate: _oldGate, ...rest } = known;
      const previousGate = gateOf(known);
      const gate =
        input.owner === "review" ? undefined : (previousGate ?? gateOf({ ...input, text }));
      planned.push({
        ...rest,
        step,
        text,
        owner: input.owner,
        ...(gate === undefined ? {} : { gate }),
        ...((text !== known.text || script !== known.script || !previousGate) && gate && at
          ? { createdAt: at }
          : {}),
        ...(script ? { script } : {}),
      });
    } else {
      nextId += 1;
      const gate = gateOf({ ...input, text });
      planned.push({
        id: `s${nextId}`,
        step,
        text,
        owner: input.owner,
        ...(gate === undefined ? {} : { gate }),
        ...(at ? { createdAt: at } : {}),
        ...(script ? { script } : {}),
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
  return { ok: true, subtasks, subtaskSeq: nextId };
}

/** Whether `role` may set subtask `id` to `state`. */
export function checkMark(
  card: Pick<KanbanCard, "number" | "subtasks">,
  id: string,
  state: KanbanSubtask["state"],
  role: SubtaskRole,
  note: string | null,
  scriptName: string | null = null,
): MarkCheck {
  const subtask = card.subtasks.find((candidate) => candidate.id === id);
  if (!subtask)
    return {
      ok: false,
      reason: `card #${card.number} has no subtask ${id}. Existing subtask ids: ${subtaskIds(card.subtasks) || "none"}`,
    };
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
  if (
    role === "script" &&
    subtask.script !== undefined &&
    subtask.script.toLowerCase() !== (scriptName ?? "").toLowerCase()
  ) {
    return { ok: false, reason: `subtask ${id} is for the script "${subtask.script}"` };
  }
  if (subtask.step !== kanbanOpenStep(card)) {
    return {
      ok: false,
      reason: `subtask ${id} is in step ${subtask.step}; finish step ${kanbanOpenStep(card)} first`,
    };
  }
  return { ok: true };
}

/** A script hands its subtask back to the evaluator: it must be an open one of its own, on the open step. */
export function checkHandBack(
  card: Pick<KanbanCard, "number" | "subtasks">,
  id: string,
  scriptName: string,
  note: string,
): MarkCheck {
  const subtask = card.subtasks.find((candidate) => candidate.id === id);
  if (!subtask)
    return {
      ok: false,
      reason: `card #${card.number} has no subtask ${id}. Existing subtask ids: ${subtaskIds(card.subtasks) || "none"}`,
    };
  if (!note.trim()) return { ok: false, reason: "say what failed or didn't match" };
  if (subtask.owner !== "script") return { ok: false, reason: `subtask ${id} isn't a script's` };
  if (subtask.state !== "open") {
    return { ok: false, reason: `subtask ${id} is already ${subtask.state}` };
  }
  if (subtask.script !== undefined && subtask.script.toLowerCase() !== scriptName.toLowerCase()) {
    return { ok: false, reason: `subtask ${id} is for the script "${subtask.script}"` };
  }
  if (subtask.step !== kanbanOpenStep(card)) {
    return {
      ok: false,
      reason: `subtask ${id} is in step ${subtask.step}; finish step ${kanbanOpenStep(card)} first`,
    };
  }
  return { ok: true };
}

/** Gives a script's open subtask to the evaluator, with the note saying what failed. */
export const handBack = (
  subtasks: ReadonlyArray<KanbanSubtask>,
  id: string,
  note: string,
): ReadonlyArray<KanbanSubtask> =>
  subtasks.map((subtask) => {
    if (subtask.id !== id) return subtask;
    const { script: _script, ...rest } = subtask;
    return { ...rest, owner: "evaluator", note };
  });

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
  script: "script",
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
    const owner =
      subtask.script === undefined
        ? OWNER_NAMES[subtask.owner]
        : `${OWNER_NAMES[subtask.owner]} "${subtask.script}"`;
    return `- ${subtask.id} step ${subtask.step}, ${owner} (${mark}${note}): ${subtask.text}`;
  });
  return `Subtasks (same step means any order; a step opens when the ones before are done or skipped):\n${rows.join("\n")}`;
}

/** Only the lead is stored; briefs render the plan from the card at delivery. */
export const nextStepNote = (lead = "") =>
  `${lead}Do this step's work subtasks, mark each with subtask_done, then card_move to needs_review.`;

/** Remove plans frozen by older releases, retaining text before and after them. */
export const wakeLead = (note: string | null): string | null => {
  const lead = note
    ?.replace(/\r\n?|[\u2028\u2029]/g, "\n")
    .replace(
      /Next on the plan:\nSubtasks \(same step means any order;[\s\S]*?Do this step's work subtasks, mark each with subtask_done, then card_move to needs_review\./g,
      "",
    )
    .replace(
      /Do this step's work subtasks, mark each with subtask_done, then card_move to needs_review\./g,
      "",
    )
    .trim();
  return lead || null;
};

/** Keep human context while discarding instructions for a finished/removed worker step. */
export const pendingWakeNote = (card: Pick<KanbanCard, "wakeNote" | "subtasks">) => {
  const lead = wakeLead(card.wakeNote);
  let findings = false;
  const cleaned = lead
    ?.split("\n")
    .map((line) => {
      // Findings refer to completed work precisely because it needs fixing;
      // only standalone queued instructions outside that section are obsolete.
      if (/^Review findings \(round \d+\):/.test(line)) findings = true;
      if (findings) {
        if (line === "Fix them, then card_move to needs_review.") findings = false;
        return line;
      }
      const prefix = line.match(/^\s*(?:[-*+]|\d+[.)])\s+/)?.[0] ?? "";
      const body = line.slice(prefix.length);
      const kept = body.split(/(?<=[.!?;])\s+/).filter((instruction) => {
        const request = instruction.trim().match(/^(?:Do\s+(s\d+)\b|(s\d+)\s*:)/i);
        const target = (request?.[1] ?? request?.[2])?.toLowerCase();
        return (
          !target ||
          card.subtasks.some((s) => s.id === target && s.owner === "work" && s.state === "open")
        );
      });
      return kept.length > 0 ? prefix + kept.join(" ") : "";
    })
    .join("\n")
    .trim();
  return cleaned || null;
};

/** Ids of open subtasks, for refusals: "s1, s3". */
export const subtaskIds = (subtasks: ReadonlyArray<KanbanSubtask>) =>
  subtasks.map((subtask) => subtask.id).join(", ");
