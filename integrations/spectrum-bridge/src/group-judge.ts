/**
 * Group chats: is an unnamed message meant for Robob? Messages that name him or
 * swipe-reply to him never get here; for the rest Jev (TypeSafe's decision
 * model on OpenRouter) reads the recent conversation and returns how likely the
 * message asks Robob something or answers him (owner ask, 2026-10-22, bringing
 * back the classifier the old Moni watcher used).
 */
import type { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const JEV_MODEL = "typesafe/jev-1.13";
/** Same line the Moni classifier settled on: a false wake costs less than a missed request. */
export const JEV_THRESHOLD = 0.45;
/** Messages judged per Jev call. */
export const JEV_CHUNK = 12;
const ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
const CONTEXT_LINES = 15;
const HISTORY_ROWS = 60;
const SENT_ROWS = 200;
const ROBOB = "Robob (AI assistant)";

export class JudgeError extends Error {
  constructor(public readonly code: string) {
    super(`Group judge failed (${code})`);
    this.name = "JudgeError";
  }
}

/** One message in the group, from a person or from Robob. */
export type GroupLine = { id: string; at: number; who: string; robob: boolean; sender?: string; text: string };

export type JudgeState = {
  recent_conversation: string[];
  new_message_from: string;
  new_message: string;
  new_message_is_inline_reply_to?: string;
  previous_message_was_from: string | null;
  minutes_since_robob_last_wrote: number | null;
  robob_last_message_asked_a_question: boolean;
  robob_is_working_on_their_request: boolean;
  minutes_since_they_last_addressed_robob: number | null;
};

/** Returns one probability per state, in order. */
export type GroupJudge = (states: JudgeState[]) => Promise<number[]>;

/** How a sender is labelled for the judge: their name, or a short tag for an unknown guest (never the full number). */
export function speakerName(who: { name: string; role: string }, address: string): string {
  return who.role === "guest" && who.name === address ? `Guest …${address.slice(-4)}` : who.name;
}

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const synthetic = (id: string) => id.startsWith("secret:") || id.startsWith("wake:") || id.startsWith("reset:");

type InboundPayload = { text?: string; sender?: string; receivedAt?: number; sentAt?: number; poll?: unknown; attachments?: unknown[] };
type OutboxPayload = { kind?: string; text?: string; attachment?: { name?: string }; app?: { caption?: string }; poll?: { title?: string } };

/** What a person's row says, as a chat line would show it. */
export function inboundWords(input: { text?: string; attachments?: unknown[] }): string {
  const count = Array.isArray(input.attachments) ? input.attachments.length : 0;
  return (input.text ?? "").trim() || (count ? `[sent ${count === 1 ? "a file" : `${count} files`}]` : "");
}

/**
 * When a person wrote the row. A late delivery keeps the time it was sent, so
 * it doesn't land after Robob's reply to the message that followed it.
 */
export function inboundTime(input: { receivedAt?: number; sentAt?: number }): number | undefined {
  return typeof input.sentAt === "number" ? input.sentAt : typeof input.receivedAt === "number" ? input.receivedAt : undefined;
}

function personLine(id: string, input: InboundPayload, nameOf: (address: string) => string, at: number | undefined): GroupLine | undefined {
  if (synthetic(id) || input.poll || (input.text ?? "").trimStart().startsWith("/")) return;
  if (at === undefined) return;
  const text = inboundWords(input);
  if (!text) return;
  return { id, at, who: input.sender ? nameOf(input.sender) : "Someone", robob: false, sender: input.sender, text };
}

/**
 * History for judging the inbound rows `ids`: every row from HISTORY_ROWS
 * before the earliest of them through the latest, so the oldest message of a
 * backlog still sees what came before it, plus what Robob had sent by then,
 * people and Robob interleaved by time. At most SENT_ROWS of Robob's sent
 * messages in that time span are read (newest first, through the kv_sent_at
 * index), so the cost stays flat as the outbox grows. A row with no time yet
 * (an old row the router hasn't stamped) counts as written `now`, the time the
 * router judges it at, but never after a later row that has a time, so it keeps
 * its place among the people's lines. Without `now` such a row is left out.
 */
export function groupLines(db: Database, nameOf: (address: string) => string, ids: string[], now?: number): GroupLine[] {
  if (!ids.length) return [];
  const span = db.query<{ lo: number | null; hi: number | null }, string[]>(
    `SELECT min(rowid) AS lo, max(rowid) AS hi FROM inbound WHERE id IN (${ids.map(() => "?").join(", ")})`,
  ).get(...ids);
  if (span?.lo == null || span.hi == null) return [];
  const from = db.query<{ rowid: number }, [number]>(
    `SELECT rowid FROM inbound WHERE rowid < ? ORDER BY rowid DESC LIMIT 1 OFFSET ${HISTORY_ROWS - 1}`,
  ).get(span.lo)?.rowid;
  const inbound = db.query<{ id: string; payload: string }, [number, number]>(
    "SELECT id, payload FROM inbound WHERE rowid >= ? AND rowid <= ? ORDER BY rowid",
  ).all(from ?? 0, span.hi).map(row => ({ id: row.id, input: JSON.parse(row.payload) as InboundPayload }));
  const times: (number | undefined)[] = [];
  let next = now ?? Infinity;
  for (let i = inbound.length - 1; i >= 0; i--) {
    const own = inboundTime(inbound[i]!.input);
    if (own !== undefined) next = Math.min(next, own);
    const at = own ?? (now === undefined ? undefined : next);
    times[i] = at !== undefined && Number.isFinite(at) ? at : undefined;
  }
  const lines: GroupLine[] = [];
  let first = Infinity;
  inbound.forEach((row, i) => {
    first = Math.min(first, times[i] ?? Infinity);
    const line = personLine(row.id, row.input, nameOf, times[i]);
    if (line) lines.push(line);
  });
  if (!lines.length) return [];
  // When the window was cut, Robob's older messages would sit next to it without
  // the people's lines in between. The cut is the window's first row, kept or not.
  const after = from === undefined ? 1 : first;
  const until = Math.max(...lines.map(line => line.at));
  const outbox = db.query<{ id: string; payload: string; at: number }, [number, number]>(
    "SELECT o.id, o.payload, CAST(k.value AS INTEGER) AS at FROM kv k JOIN outbox o ON o.id = substr(k.key, 9) "
    // Only whole numbers are send times; CAST would read anything else as 0 or a prefix.
    + "WHERE substr(k.key, 1, 8) = 'sent-at:' AND CAST(k.value AS INTEGER) BETWEEN ? AND ? AND k.value NOT GLOB '*[^0-9]*' "
    + "AND json_extract(o.payload, '$.kind') IN ('conversation', 'control') "
    + `ORDER BY at DESC, o.rowid DESC LIMIT ${SENT_ROWS}`,
  ).all(after, until);
  // Oldest first, so messages Robob sent in the same millisecond keep their queue order.
  for (const row of outbox.reverse()) {
    const op = JSON.parse(row.payload) as OutboxPayload;
    const parts = [op.text?.trim() ?? ""];
    if (op.app?.caption) parts.push(`[card: ${op.app.caption}]`);
    if (op.attachment?.name) parts.push(`[file: ${op.attachment.name}]`);
    if (op.poll?.title) parts.push(`[poll: ${op.poll.title}]`);
    const text = parts.filter(Boolean).join(" ");
    if (text) lines.push({ id: row.id, at: row.at, who: ROBOB, robob: true, text });
  }
  // Stable: rows that share a millisecond keep the order they were pushed in.
  return lines.sort((a, b) => a.at - b.at);
}

/** The person's message a swipe reply points at, as "Name: text". */
export function replyTarget(db: Database, lines: GroupLine[], id: string, nameOf: (address: string) => string): string | undefined {
  const known = lines.find(line => line.id === id);
  if (known) return `${known.who}: ${clip(known.text, 300)}`;
  const row = db.query<{ payload: string }, [string]>("SELECT payload FROM inbound WHERE id = ?").get(id);
  if (!row) return;
  const input = JSON.parse(row.payload) as InboundPayload;
  const text = inboundWords(input);
  return text ? `${input.sender ? nameOf(input.sender) : "Someone"}: ${clip(text, 300)}` : undefined;
}

/** What Jev sees for one new message. `addressed` says whether an earlier row reached Robob. */
export function judgeState(lines: GroupLine[], item: GroupLine, options: {
  timezone: string; replyTo?: string; working: boolean; addressed: (id: string) => boolean;
}): JudgeState {
  const at = lines.findIndex(line => line.id === item.id);
  const before = at >= 0 ? lines.slice(0, at) : lines.filter(line => line.at <= item.at && line.id !== item.id);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: options.timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const minutes = (line: GroupLine | undefined) => line ? Math.max(0, Math.round((item.at - line.at) / 60_000)) : null;
  const last = (match: (line: GroupLine) => boolean) => [...before].reverse().find(match);
  const robobLast = last(line => line.robob);
  const theirLast = item.sender ? last(line => line.sender === item.sender && options.addressed(line.id)) : undefined;
  return {
    recent_conversation: before.slice(-CONTEXT_LINES).map(line => `[${time.format(line.at)}] ${line.who}: ${clip(line.text, 300)}`),
    new_message_from: item.who,
    new_message: clip(item.text, 500),
    ...(options.replyTo ? { new_message_is_inline_reply_to: options.replyTo } : {}),
    previous_message_was_from: before.at(-1)?.who ?? null,
    minutes_since_robob_last_wrote: minutes(robobLast),
    robob_last_message_asked_a_question: !!robobLast && robobLast.text.includes("?"),
    robob_is_working_on_their_request: options.working,
    minutes_since_they_last_addressed_robob: minutes(theirLast),
  };
}

// `K.` is replaced by each message's state key.
const INSTRUCTIONS = [
  "`K.recent_conversation` is a group iMessage chat, oldest first, between people and Robob, an AI assistant with its own number in the group.",
  `Speaker labels are exact: lines labelled "${ROBOB}" were written by Robob, every other line by a person.`,
  "`K.new_message` was just sent by `K.new_message_from` and does not name Robob. Decide whether it is meant for Robob:",
  "asking Robob to do, find, check, book, change or cancel something, asking Robob a question, or answering or adding to something Robob asked or is doing for them.",
  "Without the name, a message is for Robob only when the conversation makes that clear: Robob wrote recently and the message carries on that exchange",
  "(`K.minutes_since_robob_last_wrote`, `K.robob_last_message_asked_a_question`, `K.robob_is_working_on_their_request`, `K.minutes_since_they_last_addressed_robob`).",
  "If Robob has been quiet for about 30 minutes or more, an unnamed request or question is for the other people, not Robob.",
  "Messages between the people (plans, questions to each other, banter, feelings, replies to what another person said, talking about Robob) are not for Robob.",
  "`K.new_message_is_inline_reply_to`, when present, is the person's message it swipe-replies to; people sometimes swipe-reply to someone's message while telling Robob what to do, so judge the words, not just the target.",
  "An instruction (send, book, cancel, change, remind, file, check, go ahead) that picks up what Robob just said or offered is for Robob, even when a short line between the people came in between.",
  "Example: right after Robob answered a question about tomorrow's flight, \"Can you book a car for 11.50 please\" is for Robob; \"What time r we leaving tomo\" or \"How u feeling\" between the people are not.",
  "Missing a real request to Robob is worse than waking it for nothing.",
].join(" ");
const CRITERIA = {
  true: "The message asks Robob to do or answer something, or answers or continues what Robob asked or is doing for them.",
  false: "The message is for the other people in the group (or about Robob), not a request to Robob or an answer to Robob.",
};

export type JevDeps = {
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  keyFile?: string;
  model?: string;
  /** One entry per attempt. */
  timeoutsMs?: number[];
};

/** Jev on OpenRouter. The key is read per call and never logged or echoed. */
export function jevJudge(deps: JevDeps = {}): GroupJudge {
  const model = deps.model ?? JEV_MODEL;
  return async states => {
    if (!states.length) return [];
    const keyFile = deps.keyFile ?? join(homedir(), ".config/opencode/openrouter-key");
    let key: string;
    try { key = (await readFile(keyFile, "utf8")).trim(); } catch { throw new JudgeError("keyUnavailable"); }
    if (!key || /[\s\x00-\x1f\x7f]/.test(key)) throw new JudgeError("keyUnavailable");
    const keys = states.map((_, index) => `m${index}`);
    const body = JSON.stringify({
      model,
      state: Object.fromEntries(keys.map((k, index) => [k, states[index]])),
      questions: Object.fromEntries(keys.map(k => [k, { type: "noul", instructions: INSTRUCTIONS.replaceAll("`K.", `\`${k}.`), criteria: CRITERIA }])),
    });
    let failure = new JudgeError("jevFailed");
    for (const timeoutMs of deps.timeoutsMs ?? [6_000, 4_000]) {
      const signal = AbortSignal.timeout(timeoutMs);
      try {
        let response: Response;
        try {
          response = await (deps.fetch ?? fetch)(ENDPOINT, {
            method: "POST", body, redirect: "error", signal,
            headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-OpenRouter-Title": "spectrum-bridge group gate" },
          });
        } catch { throw new JudgeError(signal.aborted ? "timeout" : "network"); }
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw new JudgeError(`http${response.status}`);
        }
        let result: { answers?: Record<string, { noul?: unknown }> };
        try { result = await response.json() as typeof result; } catch { throw new JudgeError(signal.aborted ? "timeout" : "invalidResponse"); }
        return keys.map(k => {
          const p = result.answers?.[k]?.noul;
          if (typeof p !== "number" || !(p >= 0 && p <= 1)) throw new JudgeError("invalidResponse");
          return p;
        });
      } catch (error) {
        failure = error instanceof JudgeError ? error : new JudgeError("jevFailed");
      }
    }
    throw failure;
  };
}
