import { McpSchema } from "effect/ai";
import * as Option from "effect/Option";
import { AskRespondInput } from "./tools.ts";
import * as Schema from "effect/Schema";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isEvidence = Schema.is(Schema.Array(Schema.String));
const decodeVerdict = Schema.decodeUnknownOption(
  Schema.toCodecJson(AskRespondInput.fields.verdict),
);

/** Add recovery examples only after the tool decoder has refused the input. */
export const boardInputErrorHint = (name: string, input: unknown): string | undefined => {
  if (!isRecord(input)) return;
  if (!["card_ask", "card_ask_change", "discussion_post", "discussion_create"].includes(name))
    return;
  const hints: string[] = [];
  if (Array.isArray(input.blocks)) {
    for (const [index, block] of input.blocks.entries()) {
      if (isRecord(block) && !Object.hasOwn(block, "_tag") && Object.hasOwn(block, "type")) {
        hints.push(`blocks[${index}]: use \`_tag\`, not \`type\`, e.g. {"_tag":"md","text":"…"}`);
      }
    }
  }
  if (name === "discussion_post" || name === "discussion_create")
    return hints.length > 0 ? hints.join("; ") : undefined;
  if (
    isRecord(input.action) &&
    input.action.evidence != null &&
    !isEvidence(input.action.evidence)
  ) {
    hints.push('action.evidence is a list of strings, e.g. ["CI green on abc123"]');
  }
  if (
    isRecord(input.respond) &&
    input.respond.verdict != null &&
    Option.isNone(decodeVerdict(input.respond.verdict))
  ) {
    hints.push(
      'respond.verdict is true or {"approve":"…","reject":"…"}; false removes verdict buttons',
    );
  }
  return hints.length > 0 ? hints.join("; ") : undefined;
};

export const withBoardInputHint =
  (name: string, input: unknown) => (error: McpSchema.InvalidParams | McpSchema.InternalError) => {
    if (error._tag !== "InvalidParams") return error;
    const hint = boardInputErrorHint(name, input);
    return hint === undefined
      ? error
      : new McpSchema.InvalidParams({
          ...error,
          message: `${error.message}\n${hint}`,
        });
  };
