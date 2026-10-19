import type { MissionProvenance, TrustedChat } from "@t3tools/contracts";
import { normalizeText, ok, refuse, type Outcome } from "./shared.ts";

/**
 * An iMessage the owner or Moni sent, as read (read only) from the iMessage
 * bridge's inbound store or Moni's chat history. Only messages the Mac
 * received count: rows the Mac sent (agents use `imsg send`) never do.
 */
export interface InboundMessage {
  readonly id: string;
  readonly chat: TrustedChat;
  readonly text: string;
  /** Epoch milliseconds the message arrived. */
  readonly receivedAt: number;
  /**
   * True only when the bridge stored the row verbatim from a message he typed.
   * Rows the bridge composed (poll votes, wakes, nudges) or rows without the
   * marker are never his words.
   */
  readonly typed: boolean;
  /** The message guid he swipe-replied to, when he did. */
  readonly replyTo?: string | undefined;
}

/**
 * Ids the bridge mints for itself (watcher wakes, secret prompts, resets,
 * poll votes). Agents and watchers can create `wake:` rows through the bridge
 * API with any text, and a poll vote's text is composed by the bridge, so
 * these never carry the owner's word.
 */
export const SYNTHETIC_INBOUND_PREFIXES = ["wake:", "secret:", "reset:", "poll-vote:"] as const;

export const isSyntheticInboundId = (id: string): boolean =>
  SYNTHETIC_INBOUND_PREFIXES.some((prefix) => id.startsWith(prefix));

/** Inbound older than the record (minus clock skew) cannot be about it. */
export const INBOUND_CLOCK_SKEW_MS = 2 * 60_000;

/**
 * The components that may redeem an iMessage the owner typed as his word:
 * the iMessage bridge, and the mission CLI the owner's iMessage agent runs.
 * Every other caller (Telegram, crw, agents, MCP tools, the shared control
 * token) is refused before anything is looked up.
 */
export const INBOUND_REDEEMERS: ReadonlyArray<string> = ["spectrum-bridge", "mission-cli"];

export const canRedeemInbound = (caller: MissionProvenance): boolean =>
  caller._tag === "system" && INBOUND_REDEEMERS.includes(caller.component);

/** How much of his message is kept as the quote on what it did. */
export const INBOUND_QUOTE_MAX_CHARS = 2000;

const quoteOf = (text: string) => {
  const flat = text.normalize("NFC").trim();
  return flat.length <= INBOUND_QUOTE_MAX_CHARS
    ? flat
    : `${flat.slice(0, INBOUND_QUOTE_MAX_CHARS - 1)}\u2026`;
};

/** Refuses a caller that may not redeem the owner's iMessage, or null. */
export const redeemerRefusal = <A>(caller: MissionProvenance, what: string): Outcome<A> | null =>
  canRedeemInbound(caller)
    ? null
    : refuse(
        "forbidden",
        `${what} by iMessage is only for the iMessage bridge or the mission CLI credential, not ${caller._tag === "system" ? caller.component : caller._tag}.`,
      );

export interface VerifyInboundCommand {
  /** Who is redeeming the message; only `INBOUND_REDEEMERS` may. */
  readonly caller: MissionProvenance;
  readonly inboundId: string;
  /** What the lookup found, or null when no source has that id. */
  readonly inbound: InboundMessage | null;
  /** The record (or its current revision) being acted on; the message must not predate it. */
  readonly notBefore: string;
  /** Clock skew allowed before `notBefore`; revision epochs pass 0. */
  readonly skewMs?: number;
  readonly what: string;
}

export type OwnerIMessage = Extract<MissionProvenance, { _tag: "owner-imessage" }>;

/**
 * The only way an iMessage becomes owner provenance: a redeeming caller, and a
 * real message the owner (or Moni) typed, received after the record (or its
 * revision) opened. What the action records is the caller's reading of his
 * words; his words ride along as the quote, so it can be audited. Anything
 * less fails closed, and the owner confirms in the app.
 */
export const verifyInbound = (command: VerifyInboundCommand): Outcome<OwnerIMessage> => {
  const { inboundId, inbound } = command;
  const notRedeemer = redeemerRefusal<OwnerIMessage>(command.caller, command.what);
  if (notRedeemer !== null) return notRedeemer;
  if (inboundId.trim().length === 0) {
    return refuse("provenance-required", `${command.what} by iMessage needs the inbound id.`);
  }
  if (isSyntheticInboundId(inboundId)) {
    return refuse(
      "provenance-invalid",
      `Inbound ${inboundId} is a bridge wake, poll vote or system message, not something the owner typed.`,
    );
  }
  if (inbound === null || inbound.id !== inboundId) {
    return refuse(
      "provenance-invalid",
      `No iMessage ${inboundId} from the owner's or Moni's chat was found.`,
    );
  }
  if (!inbound.typed) {
    return refuse(
      "provenance-invalid",
      `Inbound ${inboundId} was composed by the bridge (a poll vote or note), not typed by the owner.`,
    );
  }
  const notBefore = Date.parse(command.notBefore);
  const skew = command.skewMs ?? INBOUND_CLOCK_SKEW_MS;
  if (Number.isFinite(notBefore) && inbound.receivedAt < notBefore - skew) {
    return refuse(
      "provenance-invalid",
      `iMessage ${inboundId} arrived before the ${command.what.toLowerCase()} target (or its latest revision) existed.`,
    );
  }
  return ok({
    _tag: "owner-imessage",
    chat: inbound.chat,
    inboundId: inbound.id,
    quote: quoteOf(inbound.text),
  });
};

// ---------------------------------------------------------------------------
// Option collisions. An ask's options must read apart: two options (by label,
// id, or one's label and the other's id) that one short reply would name
// together are refused when the ask opens, so whoever reads his answer never
// has to guess between them.

type Words = ReadonlyArray<string>;

const wordsOf = (text: string): Words => {
  const normalized = normalizeText(text);
  return normalized.length === 0 ? [] : normalized.split(" ");
};

const phrases = (list: ReadonlyArray<string>): ReadonlyArray<Words> => list.map(wordsOf);

/** Words that may lead an option choice. */
const SELECT = phrases([
  "go",
  "go with",
  "pick",
  "choose",
  "option",
  "use",
  "take",
  "ok",
  "yes",
  "please",
]);
/** Words that may close a choice without changing it. */
const COURTESY = phrases(["please", "pls", "thanks", "thank you", "thx", "ty"]);

interface AnswerOption {
  readonly id: string;
  readonly label: string;
}

// An option is compared as he typed it, up to letter case, spacing, curly
// quotes, and what closes or wraps it without changing it: closing
// punctuation, an approving emoji, quotes, and brackets ("(b)", "B)"). Brackets
// around a number stay, since "(100)" can mean a negative amount. Only the
// lead and courtesy words around it are read as words. Signs, currency,
// percentages, digits and URLs are part of the option, so "Pay -100" never
// matches "Pay +100".
const CLOSING =
  /(?:[\s.,!;:\u3002"'\u00BB\u2705\u2714\u2611\u{1F44C}\u{1F44D}\u{1F4AF}\u{1F60A}\u{1F642}\u{1F64F}]|\uFE0F|\p{Emoji_Modifier})+$/u;
const OPENING = /^[\s"'\u00AB]+/u;
const BRACKETED = /^[([{](.*)[)\]}]$/su;
const OPENER = /[([{]/u;
const CLOSER = /[)\]}]$/u;
const DIGIT = /\p{Nd}/u;

/** Text without the punctuation, quotes, brackets or approving emoji that close or wrap it. */
const trimEnds = (text: string): string => {
  let current = text;
  for (;;) {
    let next = current.replace(CLOSING, "").replace(OPENING, "");
    const inside = BRACKETED.exec(next)?.[1];
    if (inside !== undefined && !DIGIT.test(inside)) next = inside;
    else if (CLOSER.test(next) && !OPENER.test(next)) next = next.slice(0, -1);
    if (next === current) return current;
    current = next;
  }
};

const optionKey = (text: string) =>
  trimEnds(
    text
      .normalize("NFKC")
      .replace(/[\u2018\u2019\u02BC]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim(),
  );

const tokensOf = (text: string): Words => {
  const key = optionKey(text);
  return key.length === 0 ? [] : key.split(" ");
};

/** Option ids by the key of each label and id, and how many words each key has. */
interface OptionForms {
  readonly ids: ReadonlyMap<string, ReadonlySet<string>>;
  readonly lengths: ReadonlyArray<number>;
}

const formsOf = (options: ReadonlyArray<AnswerOption>): OptionForms => {
  const ids = new Map<string, Set<string>>();
  for (const option of options) {
    for (const form of [option.label, option.id]) {
      const key = optionKey(form);
      if (key.length > 0) ids.set(key, (ids.get(key) ?? new Set()).add(option.id));
    }
  }
  const lengths = new Set([...ids.keys()].map((key) => key.split(" ").length));
  return { ids, lengths: [...lengths] };
};

const phraseAt = (words: Words, index: number, phrase: Words) =>
  phrase.length > 0 &&
  index + phrase.length <= words.length &&
  phrase.every((word, offset) => words[index + offset] === word);

/** Where an option may start: after none, or one or more, lead words. */
const optionStarts = (words: Words): ReadonlyArray<boolean> => {
  const reach = Array.from({ length: words.length + 1 }, (_, index) => index === 0);
  for (let index = 0; index < words.length; index++) {
    if (!reach[index]) continue;
    for (const phrase of SELECT) {
      if (phraseAt(words, index, phrase)) reach[index + phrase.length] = true;
    }
  }
  return reach;
};

/** Where an option may end: before none, or one or more, courtesy words. */
const optionEnds = (words: Words): ReadonlyArray<boolean> => {
  const reach = Array.from({ length: words.length + 1 }, (_, index) => index === words.length);
  for (let index = words.length - 1; index > 0; index--) {
    reach[index] = COURTESY.some(
      (phrase) => phraseAt(words, index, phrase) && reach[index + phrase.length] === true,
    );
  }
  return reach;
};

const NONE: ReadonlySet<string> = new Set();

const formAt = (forms: OptionForms, words: Words, from: number, to: number) =>
  forms.ids.get(trimEnds(words.slice(from, to).join(" "))) ?? NONE;

/** Options named by a run of words inside [from, to). */
const formsWithin = (forms: OptionForms, words: Words, from: number, to: number) => {
  const found = new Set<string>();
  for (const length of forms.lengths) {
    for (let first = from; first + length <= to; first++) {
      for (const id of formAt(forms, words, first, first + length)) found.add(id);
    }
  }
  return found;
};

/**
 * The options a reply names, read as [lead words] <label or id> [courtesy
 * words] at every split: `named` by the part between, `around` by a run of the
 * lead or courtesy words that is itself an option ("Yes", "Go"). More than one
 * in all means the reply is ambiguous; nothing breaks the tie. Only splits
 * whose middle has as many words as some option are compared.
 */
const readChoice = (
  forms: OptionForms,
  tokens: Words,
  bare: Words = tokens.map(trimEnds),
  withAround = true,
) => {
  const named = new Set<string>();
  const around = new Set<string>();
  const starts = optionStarts(bare);
  const ends = optionEnds(bare);
  for (let start = 0; start < tokens.length; start++) {
    if (!starts[start]) continue;
    for (const length of forms.lengths) {
      const end = start + length;
      if (end > tokens.length || !ends[end]) continue;
      const middle = formAt(forms, tokens, start, end);
      if (middle.size === 0) continue;
      for (const id of middle) named.add(id);
      if (!withAround) continue;
      for (const id of formsWithin(forms, bare, 0, start)) around.add(id);
      for (const id of formsWithin(forms, bare, end, tokens.length)) around.add(id);
    }
  }
  return { named, around };
};

/**
 * Why a set of options can't be answered by iMessage without ambiguity, or
 * null: two options (by label, id, or one's label and the other's id) that
 * one reply would name together, such as "Postgres" and "postgres" or a label
 * "B" beside an option with id "b".
 */
export const optionCollision = (options: ReadonlyArray<AnswerOption>): string | null => {
  const forms = formsOf(options);
  const leads: ReadonlyArray<Words> = [[], ...SELECT];
  const closes: ReadonlyArray<Words> = [[], ...COURTESY];
  for (const option of options) {
    for (const form of [option.label, option.id]) {
      const tokens = tokensOf(form);
      if (tokens.length === 0) continue;
      const bare = tokens.map(trimEnds);
      for (const lead of leads) {
        for (const close of closes) {
          const reply = [...lead, ...tokens, ...close];
          const named = [...readChoice(forms, reply, [...lead, ...bare, ...close], false).named];
          if (named.length > 1) {
            return `Options ${named.join(" and ")} read the same in a reply ("${reply.join(" ")}"); give each a distinct label and id.`;
          }
        }
      }
    }
  }
  return null;
};
