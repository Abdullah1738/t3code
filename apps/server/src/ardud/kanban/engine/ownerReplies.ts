import { kanbanAskResponse, kanbanAskRevision, type KanbanOwnerAsk } from "@t3tools/contracts";
import { isNegativeOption } from "./subtasks.ts";
import { pickOptions, type AskAnswerInput } from "./asks.ts";

const normalize = (text: string) =>
  text
    .toLowerCase()
    .replaceAll("’", "'")
    .replace(/[.!?]+$/, "")
    .trim();
const YES = new Set(["yes", "approve", "approved", "go", "ok", "okay", "do it"]);
const NO = new Set(["no", "reject", "drop", "drop it", "skip", "leave it", "don't", "dont"]);

export function classifyReply(
  ask: KanbanOwnerAsk,
  text: string,
): { readonly answer: AskAnswerInput } | { readonly candidates: ReturnType<typeof pickOptions> } {
  const words = normalize(text);
  const options = pickOptions(ask);
  const exact = options.filter(
    (option) => normalize(option.label) === words || normalize(option.id) === words,
  );
  const number = /^(?:o|option\s*#?\s*)?(\d+)[.)]?$/.exec(words);
  const numbered = number ? options[Number(number[1]) - 1] : undefined;
  const prefixes = options.filter(
    (option) => words.length > 1 && normalize(option.label).startsWith(`${words} `),
  );
  const mentions = options.filter((option) =>
    ` ${words} `.includes(` ${normalize(option.label)} `),
  );
  if (exact.length === 0 && !NO.has(words) && isNegativeOption(words)) {
    return { answer: { verdict: "text", text, revision: kanbanAskRevision(ask) } };
  }
  // Mentioning one option inside a sentence can negate it; only an exact or prefix choice selects it.
  let candidates =
    exact.length > 0
      ? exact
      : numbered
        ? [numbered]
        : prefixes.length > 0
          ? prefixes
          : mentions.length > 1
            ? mentions
            : [];
  const negative = NO.has(words);
  if (candidates.length === 0 && (YES.has(words) || negative)) {
    candidates = options.filter((option) =>
      negative
        ? isNegativeOption(option.label) || option.id === "reject"
        : /^(yes\b|approve\b|go\b|ok\b|deploy\b|install\b|apply\b|proceed\b)/i.test(option.label) ||
          option.id === "approve",
    );
  }
  if (candidates.length > 1) return { candidates };
  const selected = candidates[0];
  const verdict =
    selected && kanbanAskResponse(ask).verdict && !kanbanAskResponse(ask).choose
      ? selected.id === "approve"
        ? "approved"
        : "rejected"
      : selected
        ? "picked"
        : "text";
  return {
    answer: {
      verdict,
      text,
      revision: kanbanAskRevision(ask),
      ...(verdict === "picked" ? { optionIds: [selected!.id] } : {}),
    },
  };
}
