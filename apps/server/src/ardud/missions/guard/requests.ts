/**
 * The text an answer to a pending request carries. Answers reach the agent
 * as provider input or as a message, so the guard judges this text like any
 * other send into the thread.
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const encodeJson = Schema.encodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const valueText = (value: unknown): string =>
  typeof value === "string"
    ? value
    : Option.getOrElse(encodeJson(value), () => "(an answer that is not text)");

export const requestAnswerText = (input: {
  readonly requestId: string;
  readonly decision?: string | undefined;
  readonly answers?: Readonly<Record<string, unknown>> | undefined;
  readonly dismissed?: boolean | undefined;
}): string => {
  if (input.dismissed === true) return `Dismiss request ${input.requestId}.`;
  const lines = [`Answer to request ${input.requestId}:`];
  if (input.decision !== undefined) lines.push(`- decision: ${input.decision}`);
  for (const [key, value] of Object.entries(input.answers ?? {})) {
    lines.push(`- ${key}: ${valueText(value)}`);
  }
  return lines.join("\n");
};
