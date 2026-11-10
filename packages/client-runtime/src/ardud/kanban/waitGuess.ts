import type { KanbanWaitKind } from "@t3tools/contracts";

/**
 * A best-effort reading of what an old card waits on, from the free text
 * agents wrote before card_wait existed (a stalled reason, a subtask, a link
 * label, a comment or a wake note). It is a guess and always shown as one.
 * The phrasings are the ones found on real cards; the order below decides
 * when a text matches several.
 */
export interface WaitGuess {
  readonly on: KanbanWaitKind;
  /** The card number it names, for `card`. */
  readonly cardNumber: number | null;
  /** The text it was read from, cut short. */
  readonly from: string;
}

const HOLD = String.raw`(?:wait(?:s|ing)?|hold(?:s|ing)?|held|blocked|gated?)`;
// A card reference: "#2694", but not "repo#350", "PR #1100" or "PR451".
const CARD_REF = String.raw`(?<![\w/])(?<!\bPR\s)#(\d+)\b`;

const CI = new RegExp(
  String.raw`\b${HOLD}\b[^.;\n]{0,40}\bCI\b|\bCI\b[^.;\n]{0,24}\b(?:hold|pending|running|to (?:pass|finish|go green))\b|\bhosted run\b`,
  "i",
);
const PUSH = new RegExp(
  [
    String.raw`\bnew head\b`,
    String.raw`\bhead moves\b`,
    String.raw`\bpush(?:es|ed)?\b[^.;\n]{0,40}\b(?:fix|commit|head)`,
    String.raw`\b(?:fix|commits?)\b[^.;\n]{0,24}\bpush`,
    String.raw`\bwait(?:s|ing)? for [^.;\n]{0,40}'s fix\b`,
    String.raw`\bwait(?:s|ing)? (?:on|for) (?:the )?(?:author|dev|developer)\b`,
    String.raw`\bmark (?:it|the PR) ready\b`,
  ].join("|"),
  "i",
);
const CARD = new RegExp(String.raw`\b${HOLD}\b[^.;\n]{0,24}?\b(?:on|for|by|until|behind)\s+${CARD_REF}`, "i");
const MERGE = new RegExp(
  [
    String.raw`\bmerge (?:gate|hold)\b`,
    String.raw`\bhold(?:s|ing)? (?:the )?merge\b`,
    String.raw`\bmerge waits\b`,
    String.raw`\b${HOLD}\b[^.;\n]{0,60}\b(?:to |is |are |gets? )?merged?\b`,
    String.raw`\buntil\b[^.;\n]{0,40}\bmerges?\b`,
    String.raw`\b(?:waiting|waits?) (?:on|for) (?:the )?merge\b`,
  ].join("|"),
  "i",
);
const OWNER = new RegExp(
  String.raw`\b(?:owner|abdullah)(?:'s)? (?:go|ok|okay|approval|answer|reply|decision)\b|\bmerge go\b|\b${HOLD}\b[^.;\n]{0,24}\b(?:the owner|abdullah)\b`,
  "i",
);
const TIME = /\b(?:re-?check|check[- ]back)\b|\bstill held\b/i;
// "waiting on jashwanth9845", "waiting on Pavan: ...": a person, so the PR's author.
const PERSON = /\bwait(?:s|ing)? (?:on|for) (?!the\b|a\b|an\b|ci\b|pr\b|merge\b|it\b|#)([A-Za-z][\w-]{1,38})\b/i;

const cut = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
};

/** What one text says the card waits on, or null when it says nothing recognisable. */
export function guessWait(text: string | null | undefined): WaitGuess | null {
  if (!text?.trim()) return null;
  const guess = (on: KanbanWaitKind, cardNumber: number | null = null): WaitGuess => ({
    on,
    cardNumber,
    from: cut(text),
  });
  // "Dependency hold, not a CI wait: ..." names CI only to rule it out.
  if (CI.test(text.replace(/\bnot (?:a |an )?CI\b[^.;:,\n]*/gi, ""))) return guess("ci");
  if (PUSH.test(text)) return guess("push");
  const card = CARD.exec(text);
  if (card?.[1]) return guess("card", Number(card[1]));
  // Before merge: "held for the owner's go on the merge" waits on him, not on the PR.
  if (OWNER.test(text)) return guess("owner_go");
  if (MERGE.test(text)) return guess("merge");
  if (PERSON.test(text)) return guess("push");
  if (TIME.test(text)) return guess("time");
  return null;
}

/** The first text that says something, in the order given (put the newest and most direct first). */
export function guessWaitFrom(texts: ReadonlyArray<string | null | undefined>): WaitGuess | null {
  for (const text of texts) {
    const guess = guessWait(text);
    if (guess !== null) return guess;
  }
  return null;
}
