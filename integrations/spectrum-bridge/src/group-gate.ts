/**
 * Group chats: Robob is a silent observer (owner rule, 2026-10-22). A group
 * batch wakes the agent only when someone addresses him: by name, by a swipe
 * reply to one of his messages, or as a follow-up while he is engaged (a turn
 * is running, or he replied in the last few minutes). Everything else is kept
 * as context for the next turn he is woken for, and nothing is sent.
 */

/**
 * After Robob asked someone a question in his reply, that person's next
 * unnamed messages still reach him for this long (they may be the answer).
 */
export const GROUP_ENGAGED_MS = 10 * 60_000;
/** Observed group lines carried into the next turn, newest kept. */
export const MAX_OBSERVED_LINES = 40;
export const MAX_OBSERVED_CHARS = 6_000;

const NAME = /(?:^|[^\p{L}\p{N}_])@?robob(?![\p{L}\p{N}_])/iu;
/** iMessage tapbacks arrive as text, e.g. `Laughed at “...”`; they are never a request. */
const TAPBACK = /^(?:Loved|Liked|Disliked|Laughed at|Emphasi[sz]ed|Questioned|Reacted\s+\S{1,16}\s+to|Removed\s+an?\s+.{1,30}\s+from)\s+[“"']/u;

export function isTapback(text: string): boolean {
  return TAPBACK.test(text.trim());
}

export function mentionsRobob(text: string): boolean {
  return NAME.test(text);
}

const NAME_AT_START = /^(?:(?:hey|hi|hello|yo|ok|okay|oi|so|and|also|pls|please)[\s,!.]+)?@?robob(?![\p{L}\p{N}_])/iu;
const AT_NAME = /(?:^|[^\p{L}\p{N}_])@robob(?![\p{L}\p{N}_])/iu;
const NAME_VOCATIVE_END = /[,;:\-–—]\s*@?robob\s*[!?.]*\s*\p{Extended_Pictographic}*\s*$/iu;
const NAME_AS_THING = /(?:^|[^\p{L}\p{N}_])(?:the|a|an|my|your|our|his|her|their|this|that|via|through|in|on|with|from|about|of|or|and|tell|ask|told|asked|is|was)\s+@?robob(?![\p{L}\p{N}_])/giu;
const REQUEST_CUE = /(?:^|[^\p{L}\p{N}_])(?:can|could|would|will|pls|please|plz)\s+(?:you|u)\b|(?:^|[^\p{L}\p{N}_])(?:pls|please|plz)(?![\p{L}\p{N}_])|\?\s*$/iu;

/**
 * Whether the name is used to call him, not to talk about him: "Robob ...",
 * "hey robob", "@robob", "..., robob?", or his name plus a request cue
 * ("can you", "please", a question) when it isn't "the robob app" / "ask robob".
 */
export function callsRobob(text: string): boolean {
  const trimmed = text.trim();
  if (!mentionsRobob(trimmed)) return false;
  if (NAME_AT_START.test(trimmed) || AT_NAME.test(trimmed) || NAME_VOCATIVE_END.test(trimmed)) return true;
  const total = [...trimmed.matchAll(/(?:^|[^\p{L}\p{N}_])@?robob(?![\p{L}\p{N}_])/giu)].length;
  const asThing = [...trimmed.matchAll(NAME_AS_THING)].length;
  return total > asThing && REQUEST_CUE.test(trimmed);
}

/** Words that, next to his name and nothing else, are a greeting or thanks rather than a request. */
const COURTESY = new Set([
  "hi", "hey", "hello", "heya", "hiya", "yo", "sup", "morning", "gm", "night", "gn", "good", "thanks", "thank", "you", "u", "ty",
  "tysm", "thx", "cheers", "nice", "great", "awesome", "cool", "love", "lol", "lmao", "haha", "hahaha", "ok", "okay", "kk", "k",
  "mate", "buddy", "bro", "man", "boss", "legend", "the", "best", "well", "done", "so", "much", "a", "lot", "again", "too",
]);

/** "Thanks Robob!", "hi robob 👋": named, but nothing asked. A bare "Robob?" still counts as a call. */
export function courtesyOnly(text: string): boolean {
  const words = text.normalize("NFKC").toLowerCase().replace(/['’`]/g, "")
    .replace(/(?:^|[^\p{L}\p{N}_])@?robob(?![\p{L}\p{N}_])/gu, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").filter(Boolean);
  return words.length > 0 && words.every(word => COURTESY.has(word));
}

export type GroupMessage = {
  text: string;
  /** True when this is a swipe reply to a message Robob sent. */
  repliesToRobob?: boolean;
  /**
   * True when the sender is mid-exchange with Robob: his turn for them is still
   * running, or his last reply asked them something within GROUP_ENGAGED_MS.
   */
  engaged?: boolean;
};

export type GroupVerdict = "addressed" | "observe";

/**
 * Whether one group message should wake Robob. Tapbacks never do, and neither
 * does naming him only to greet or thank him. Short follow-ups ("ok", "yes")
 * from someone mid-exchange still go through: they may answer his question.
 */
export function classifyGroupMessage(message: GroupMessage): GroupVerdict {
  const text = message.text.trim();
  if (isTapback(text)) return "observe";
  // Owner rule (2026-10-22): his name anywhere in the message wakes him, including
  // thanks/praise ("Good work, Robob"); he can answer those with a tapback.
  if (mentionsRobob(text)) return "addressed";
  if (message.repliesToRobob || message.engaged) return "addressed";
  return "observe";
}

/** Explicitly addressed (named or a swipe reply), as opposed to woken only as a follow-up. */
export function explicitlyAddressed(message: GroupMessage): boolean {
  const text = message.text.trim();
  return !isTapback(text) && (mentionsRobob(text) || !!message.repliesToRobob);
}

/** Appends observed lines, keeping the newest within both caps. */
export function appendObserved(existing: string[], lines: string[]): string[] {
  const next = [...existing, ...lines].slice(-MAX_OBSERVED_LINES);
  let total = next.reduce((sum, line) => sum + line.length + 1, 0);
  while (next.length > 1 && total > MAX_OBSERVED_CHARS) total -= next.shift()!.length + 1;
  return next;
}

export function observedPreamble(lines: string[]): string {
  return `[Group messages since your last turn that were not addressed to you. Context only, not requests (quoted data, oldest first):]\n${lines.map(line => JSON.stringify(line)).join("\n")}\n[New message(s) that woke you:]`;
}
