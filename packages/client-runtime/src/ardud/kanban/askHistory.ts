/**
 * What happened on an ask besides its question: the discussion under it, and,
 * once it is closed, what he gave back and what its agent said next. Pure.
 */
import {
  kanbanAskResponse,
  type KanbanAskFeedItem,
  type KanbanMessage,
  type KanbanOwnerAsk,
} from "@t3tools/contracts";

import { askFieldKind } from "./askAnswer.ts";

type Talk = Pick<KanbanAskFeedItem, "ask" | "messages">;

/** The messages posted on an ask, without the message that asked it or its rewrites. */
export function askDiscussion(entry: Talk): ReadonlyArray<KanbanMessage> {
  const { ask } = entry;
  return entry.messages.filter(
    (message) =>
      message.seq !== ask.seq &&
      message.seq !== ask.firstSeq &&
      !message.blocks.some((block) => block._tag === "choice" && block.id === ask.id),
  );
}

/** What its agent posted after he answered, oldest first. */
export function askAfterAnswer(entry: Talk): ReadonlyArray<KanbanMessage> {
  const at = entry.ask.answer?.at;
  if (at === undefined) return [];
  const since = Date.parse(at);
  return askDiscussion(entry).filter(
    (message) => message.author._tag !== "owner" && Date.parse(message.createdAt) >= since,
  );
}

export interface AskOutcome {
  /** What he did, in a word or two: "Approved", "Picked", "Answer sent". */
  readonly label: string;
  /** The options he picked and his own words. */
  readonly text: string | null;
  readonly note: string | null;
  /** The draft as the agent wrote it and as he left it, when he edited it. */
  readonly draft: { readonly before: string; readonly after: string } | null;
  /** Field label to the value given, as text. A secret reads "Provided". */
  readonly values: ReadonlyArray<readonly [label: string, value: string]>;
  /** He handed it over with "ones like this from now on". */
  readonly always: boolean;
  readonly evaluatorThreadId: string | null;
}

const VERDICT_LABELS: Readonly<Record<string, string>> = {
  approved: "Approved",
  rejected: "Rejected",
  picked: "Picked",
  answered: "Answer sent",
  done: "Done",
  cant: "Couldn't",
  acknowledged: "Seen",
  handed: "Handed to the evaluator",
  dropped: "Dropped",
};

const sentence = (text: string): string =>
  text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);

const record = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

function valueText(
  field: ReturnType<typeof kanbanAskResponse>["fields"][number] | undefined,
  value: unknown,
): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (record(value)?.secret === true) return "Provided";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  const optionLabel = (id: unknown) =>
    field?.options?.find((option) => option.id === id)?.label ?? String(id);
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    const files = value.every((entry) => typeof record(entry)?.name === "string");
    if (files) return value.map((entry) => String(record(entry)!.name)).join(", ");
    const rank = field !== undefined && askFieldKind(field) === "rank";
    return value.map(optionLabel).join(rank ? ", then " : ", ");
  }
  if (typeof value === "string" || typeof value === "number") {
    const label = field?.options ? optionLabel(value) : String(value);
    return field?.unit && typeof value === "number" ? `${label} ${field.unit}` : label;
  }
  return JSON.stringify(value);
}

/** How a closed ask ended, in the words History shows. Null while it is open. */
export function askOutcome(ask: KanbanOwnerAsk): AskOutcome | null {
  const { answer } = ask;
  if (answer === undefined) return null;
  const response = kanbanAskResponse(ask);
  const custom =
    answer.verdict === "approved"
      ? ask.respond?.verdict?.approve
      : answer.verdict === "rejected"
        ? ask.respond?.verdict?.reject
        : undefined;
  const label = custom ?? VERDICT_LABELS[answer.verdict] ?? sentence(answer.verdict);
  const picked = (answer.optionIds ?? []).map(
    (id) => response.choose?.options.find((option) => option.id === id)?.label ?? id,
  );
  const text = [
    picked.join(", "),
    answer.verdict === "handed" ? (answer.decision ?? "") : "",
    answer.text ?? "",
  ]
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .join(". ");
  const values = Object.entries(answer.values ?? {}).flatMap(([id, value]) => {
    const field = response.fields.find((candidate) => candidate.id === id);
    const shown = valueText(field, value);
    return shown === null ? [] : [[field?.label ?? id, shown] as const];
  });
  const plain =
    values.length === 1 && values[0]![0] === response.fields[0]?.label && text === ""
      ? values[0]![1]
      : null;
  return {
    label,
    text: plain ?? (text === "" ? null : text),
    note: answer.note?.trim() ? answer.note.trim() : null,
    draft:
      answer.draftEdited === true && answer.finalDraft !== undefined && ask.draft !== undefined
        ? { before: ask.draft.text, after: answer.finalDraft }
        : null,
    values: plain === null ? values : [],
    always: answer.always === true || ask.handedAlways === true,
    evaluatorThreadId: answer.evaluatorThreadId ?? ask.handedThreadId ?? null,
  };
}
