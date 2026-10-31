import { readFileSync } from "node:fs";
import { chmod, rename, writeFile } from "node:fs/promises";
import { stripInternalText } from "./formatting.ts";
import type { Store } from "./store.ts";

/** Per-chat standing rules: `{ [slug]: { banned: string[] } }`. */
export type ReplyRules = Record<string, { banned: string[] }>;
export type ReplyHit = { rule: string; reason: string };

const MAX_MONI_CHARS = 600;
const MALFORMED = "reply-rules.json is unreadable or malformed; fix it before changing bans";
const BOUNCE_WINDOW_MS = 30 * 60_000;
const SENT_TEXTS = 50;

/** Letters and digits only, lowercased, so punctuation and spacing do not hide a banned word. */
const normalizeWords = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const comparable = (text: string) => text.normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
const CARD_TARGET = /\b(?:5542|2342)\b|marriott/i;
const CARD_LIMIT = /\blimits?\b|available (credit|balance)|headroom|balance first/i;
const CARD_DECLINE = /\bdeclined\b/i;
const CARD_SMS = /\b(sms|text)\b/i;

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/**
 * Strict load: a missing file is no rules; a file that exists but is malformed throws, so an edit
 * can never silently rewrite (and wipe) another chat's bans. Entries are normalized and deduped on load.
 */
export function readReplyRulesStrict(path: string): ReplyRules {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(MALFORMED);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(MALFORMED);
  }
  if (!isObject(parsed)) throw new Error(MALFORMED);
  const rules: ReplyRules = {};
  for (const [slug, entry] of Object.entries(parsed)) {
    if (!isObject(entry) || !Array.isArray(entry.banned)) throw new Error(MALFORMED);
    const banned = entry.banned.map(word => typeof word === "string" ? normalizeWords(word) : "");
    if (banned.some(word => !word)) throw new Error(MALFORMED);
    rules[slug] = { banned: [...new Set(banned)] };
  }
  return rules;
}

/** Agent-path read: a bad file means no rules (fail-open for the check, never a 409 on every send). */
export function readReplyRules(path: string): ReplyRules {
  try {
    return readReplyRulesStrict(path);
  } catch {
    return {};
  }
}

/** Returns the first standing rule the text breaks, or undefined when it may be sent. */
export function checkReply(chat: { slug: string; kind: string }, text: string, rules: ReplyRules): ReplyHit | undefined {
  const plain = stripInternalText(text);
  if (chat.kind === "owner" && CARD_TARGET.test(plain) && CARD_LIMIT.test(plain)
    && !(CARD_DECLINE.test(plain) && CARD_SMS.test(plain))) {
    return {
      rule: "card-limit",
      reason: "the Marriott card (2342) can go to about AED -9,400; never blame its limit or say pay the balance first unless you quote a real bank decline SMS",
    };
  }
  const padded = ` ${normalizeWords(plain)} `;
  for (const word of rules[chat.slug]?.banned ?? []) {
    const needle = normalizeWords(word);
    if (needle && padded.includes(` ${needle} `)) return { rule: "banned", reason: `this chat banned "${word}"` };
  }
  if (chat.slug === "moni" && plain.length > MAX_MONI_CHARS && !/^\S+$/.test(plain)) {
    return { rule: "length", reason: "two short paragraphs under 600 characters, then offer 'want the details?'" };
  }
  return undefined;
}

/** False when a bounce for the same turn happened under 30 minutes ago, so a rewrite loop cannot bounce forever. */
export function mayBounce(store: Store, turnKey: string): boolean {
  const last = store.get<{ turn: string; at: number }>("reply-bounce");
  return !(last && last.turn === turnKey && Date.now() - last.at < BOUNCE_WINDOW_MS);
}

export function noteBounce(store: Store, turnKey: string): void {
  store.set("reply-bounce", { turn: turnKey, at: Date.now() });
}

/** Remembers texts sent this turn so a later final reply can be checked against them. */
export function noteSent(store: Store, turnKey: string, text: string): void {
  const saved = store.get<{ turn: string; texts: string[] }>("turn-sends");
  const texts = saved && saved.turn === turnKey ? saved.texts : [];
  store.set("turn-sends", { turn: turnKey, texts: [...texts, comparable(text)].slice(-SENT_TEXTS) });
}

/** Adds or removes a banned word for one chat, writing atomically with mode 0600. */
export async function editBans(path: string, slug: string, action: "ban" | "unban", word: string): Promise<ReplyRules> {
  const rules = readReplyRulesStrict(path);
  const needle = normalizeWords(word);
  const current = new Set(rules[slug]?.banned ?? []);
  if (action === "ban") current.add(needle);
  else current.delete(needle);
  rules[slug] = { banned: [...current] };
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(rules, null, 2)}\n`, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, path);
  return rules;
}
