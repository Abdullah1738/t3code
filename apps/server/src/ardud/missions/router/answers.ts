import type {
  OrchestrationV2UserInputQuestion,
  ProviderUserInputAnswers,
} from "@t3tools/contracts";

const valueText = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value === undefined) return "(no answer)";
  return JSON.stringify(value) ?? String(value);
};

/**
 * What an agent's answer to another thread's pending question says, as text
 * the send guard can route or hold. It carries every submitted value, so a
 * routed answer or a knock keeps what was actually answered, not just which
 * questions were touched.
 */
export const answerText = (input: {
  readonly requestId: string;
  readonly questions: ReadonlyArray<OrchestrationV2UserInputQuestion>;
  readonly answers: ProviderUserInputAnswers;
}): string => {
  const known = new Set(input.questions.map((question) => question.id));
  const lines = [`Answer to request ${input.requestId}:`];
  for (const question of input.questions) {
    if (!(question.id in input.answers)) continue;
    lines.push(
      `- ${question.header} (${question.question}): ${valueText(input.answers[question.id])}`,
    );
  }
  for (const [id, value] of Object.entries(input.answers)) {
    if (!known.has(id)) lines.push(`- ${id}: ${valueText(value)}`);
  }
  return lines.join("\n");
};
