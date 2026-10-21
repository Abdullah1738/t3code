/**
 * A role or lane thread's pending question goes to its lead (see
 * `leadTiersOf`), not to the owner's Telegram. This is the text the lead gets:
 * the question itself, and how to answer it or take it to the owner.
 */
import type { OrchestrationV2UserInputQuestion, ThreadId } from "@t3tools/contracts";

/** The router's producer name for these notices: their author in the room. */
export const LEAD_QUESTION_PRODUCER = "lane-questions";

const QUESTION_MAX = 600;
const OPTIONS_MAX = 400;

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

export const leadQuestionKey = (threadId: ThreadId, requestId: string, leadThreadId: ThreadId) =>
  `lead-question:${threadId}:${requestId}:${leadThreadId}`;

export const leadQuestionText = (input: {
  /** What the asking thread is called in the mission (its lane, else its role). */
  readonly asker: string;
  readonly threadId: ThreadId;
  readonly requestId: string;
  /** Empty when the question item is not recorded yet. */
  readonly questions: ReadonlyArray<OrchestrationV2UserInputQuestion>;
}): string => {
  const lines = [`${input.asker} is waiting on a question you lead:`];
  for (const question of input.questions) {
    lines.push(`- ${clip(question.header, 80)}: ${clip(question.question, QUESTION_MAX)}`);
    const options = question.options.map((option) => option.label).join(" / ");
    if (options.length > 0) lines.push(`  Options: ${clip(options, OPTIONS_MAX)}`);
  }
  lines.push(
    "",
    `Answer it with t3_pending_request_respond using threadId ${input.threadId} and requestId ${input.requestId} (t3_pending_request_read shows it in full).`,
    "If only the owner can decide, ask him with mission_ask, then answer it with what he says.",
    "If it is no longer pending, it was answered or dismissed.",
  );
  return lines.join("\n");
};
