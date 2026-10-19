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
}

/**
 * Ids the bridge mints for itself (watcher wakes, secret prompts, resets).
 * Agents and watchers can create `wake:` rows through the bridge API with any
 * text, so these never carry the owner's word.
 */
export const SYNTHETIC_INBOUND_PREFIXES = ["wake:", "secret:", "reset:"] as const;

export const isSyntheticInboundId = (id: string): boolean =>
  SYNTHETIC_INBOUND_PREFIXES.some((prefix) => id.startsWith(prefix));

/** Inbound older than the record (minus clock skew) cannot be about it. */
export const INBOUND_CLOCK_SKEW_MS = 2 * 60_000;

export interface VerifyInboundCommand {
  readonly inboundId: string;
  /** What the lookup found, or null when no source has that id. */
  readonly inbound: InboundMessage | null;
  /** Says why the reply does not carry the exact answer, or null when it does. */
  readonly check: ReplyCheck;
  /** The record (or its current revision) being answered; the message must not predate it. */
  readonly notBefore: string;
  /** Clock skew allowed before `notBefore`; revision epochs pass 0. */
  readonly skewMs?: number;
  readonly what: string;
}

/**
 * The only way an iMessage becomes owner provenance: a real inbound from the
 * owner's or Moni's chat, received after the record (or its revision) opened,
 * whose whole reply carries exactly the answer being recorded. Anything less
 * fails closed, and the owner confirms in the app.
 */
export const verifyInbound = (
  command: VerifyInboundCommand,
): Outcome<Extract<MissionProvenance, { _tag: "owner-imessage" }>> => {
  const { inboundId, inbound } = command;
  if (inboundId.trim().length === 0) {
    return refuse("provenance-required", `${command.what} by iMessage needs the inbound id.`);
  }
  if (isSyntheticInboundId(inboundId)) {
    return refuse(
      "provenance-invalid",
      `Inbound ${inboundId} is a bridge wake or system message, not something the owner typed.`,
    );
  }
  if (inbound === null || inbound.id !== inboundId) {
    return refuse(
      "provenance-invalid",
      `No iMessage ${inboundId} from the owner's or Moni's chat was found.`,
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
  const words = wordsOf(inbound.text);
  if (words.length === 0) {
    return refuse("provenance-invalid", `iMessage ${inboundId} has no text to check.`);
  }
  const problem = command.check({ raw: inbound.text, words });
  if (problem !== null) {
    return refuse(
      "provenance-invalid",
      `iMessage ${inboundId} does not ${problem}; confirm it in the app instead.`,
    );
  }
  return ok({ _tag: "owner-imessage", chat: inbound.chat, inboundId: inbound.id });
};

// ---------------------------------------------------------------------------
// Reply formats. Decision words are compared as normalized words (lowercase,
// no punctuation, "don't" -> "dont"); an option label or id is compared as
// typed up to case, spacing and what closes or wraps it; any text that gets
// recorded (an edit, a rewrite note, a free-text answer) must match what he
// typed up to whitespace.
// A reply must be exactly one of these shapes:
//
//   ask, option:      [go | go with | pick | choose | option | use | take | ok | yes] <label or id> [please | thanks]
//   ask, free text:   <answer text>                          (his whole reply, as typed)
//   draft, approve:   approve | ok send it | yes | lgtm | ...  (approval words only)
//   draft, edited:    <approval words>: <edited text>        (or the text on the next line)
//   draft, rewrite:   rewrite: <rewrite note>                (or the note on the next line)
//   draft, drop:      drop it | dont send | skip | cancel | no | ...
//
// Nothing is matched inside a longer sentence, so "do not deploy" never picks
// "deploy", "deploy would be a disaster" picks nothing, and "do not send the
// line hello world" never approves "hello world". A question ("deploy?")
// decides nothing. Anything else is confirmed in the app.

type Words = ReadonlyArray<string>;

/** An inbound reply: what he typed, and its normalized words. */
export interface Reply {
  readonly raw: string;
  readonly words: Words;
}

/** A check over a reply: null when the reply carries the exact answer, else what it lacks. */
export type ReplyCheck = (reply: Reply) => string | null;

const wordsOf = (text: string): Words => {
  const normalized = normalizeText(text);
  return normalized.length === 0 ? [] : normalized.split(" ");
};

/** Text as he typed it, up to whitespace. */
const asTyped = (text: string) => text.normalize("NFC").replace(/\s+/g, " ").trim();

/** A question decides nothing. */
const asksSomething = (raw: string) => /[?\uFF1F]/.test(raw);

/** "<lead>: <body>" or "<lead>\n<body>", split at the first colon or line break. */
const splitAtSeparator = (raw: string): { readonly lead: string; readonly body: string } | null => {
  const match = /[:\uFF1A\n]/.exec(raw);
  return match === null
    ? null
    : { lead: raw.slice(0, match.index), body: raw.slice(match.index + 1) };
};

const phrases = (list: ReadonlyArray<string>): ReadonlyArray<Words> => list.map(wordsOf);

const startsWith = (words: Words, prefix: Words) =>
  prefix.length <= words.length && prefix.every((word, index) => words[index] === word);

/** Whether the words are one or more of the phrases back to back, and nothing else. */
const coveredBy = (words: Words, list: ReadonlyArray<Words>): boolean => {
  if (words.length === 0) return false;
  const reach: Array<boolean> = Array.from({ length: words.length + 1 }, () => false);
  reach[0] = true;
  for (let index = 0; index < words.length; index++) {
    if (!reach[index]) continue;
    const rest = words.slice(index);
    for (const phrase of list) {
      if (phrase.length > 0 && startsWith(rest, phrase)) reach[index + phrase.length] = true;
    }
  }
  return reach[words.length] === true;
};

/** Words that approve a draft by iMessage. */
export const APPROVE_WORDS = [
  "approve",
  "approved",
  "send",
  "send it",
  "yes",
  "ok",
  "okay",
  "go",
  "go ahead",
  "lgtm",
  "ship it",
];
/** Words that drop a draft by iMessage. */
export const DROP_WORDS = [
  "drop",
  "drop it",
  "dont send",
  "dont send it",
  "do not send",
  "do not send it",
  "skip",
  "skip it",
  "kill it",
  "cancel",
  "no",
];
/** Words that lead a rewrite note. */
export const REWRITE_WORDS = ["rewrite", "rewrite it", "redo", "redo it", "revise", "change it"];
/** Words that may lead an option choice. */
export const SELECT_WORDS = [
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
];
/** Words that may close a choice without changing it. */
export const COURTESY_WORDS = ["please", "pls", "thanks", "thank you", "thx", "ty"];
/** Words that turn a reply around; recorded text never starts with one. */
const TURNAROUNDS = new Set([
  "no",
  "not",
  "dont",
  "never",
  "nope",
  "nah",
  "cancel",
  "instead",
  "wait",
  "stop",
  "neither",
  "none",
  "isnt",
  "wont",
  "cant",
  "but",
  "actually",
]);

const APPROVE = phrases(APPROVE_WORDS);
const DROP = phrases(DROP_WORDS);
const REWRITE = phrases(REWRITE_WORDS);
const SELECT = phrases(SELECT_WORDS);
const COURTESY = phrases(COURTESY_WORDS);
const EDIT_CONNECTORS = new Set(["with", "as"]);

/**
 * Text after the separator that gets recorded as his (an edit or a rewrite
 * note): it must be what the relay recorded, have words, and not be a bare
 * decision or start by turning the reply around.
 */
const recordedText = (body: string, recorded: string, what: string): string | null => {
  if (asTyped(body) !== asTyped(recorded)) return `carry the ${what} exactly as recorded`;
  const words = wordsOf(body);
  if (words.length === 0) return `carry a ${what} with words`;
  if (TURNAROUNDS.has(words[0] ?? ""))
    return `carry a ${what} that does not start by turning around`;
  if (coveredBy(words, APPROVE) || coveredBy(words, DROP)) {
    return `carry a ${what} rather than a bare decision`;
  }
  return null;
};

/**
 * What an iMessage must be to approve, rewrite or drop a draft: the decision
 * words themselves, and for an edit or rewrite the exact text after a colon or
 * line break.
 */
export const draftDecisionCheck = (input: {
  readonly action: "approve" | "rewrite" | "drop";
  readonly editedText?: string | undefined;
  readonly rewriteNote?: string | undefined;
}): ReplyCheck => {
  switch (input.action) {
    case "approve": {
      const edited = input.editedText ?? "";
      if (edited.trim().length === 0) {
        return ({ raw, words }) =>
          !asksSomething(raw) && coveredBy(words, APPROVE)
            ? null
            : 'say only an approval ("ok send it", "approve")';
      }
      return ({ raw }) => {
        const parts = splitAtSeparator(raw);
        if (parts === null) return 'put the edited text after "approve:" or on a new line';
        const lead = wordsOf(parts.lead);
        const last = lead.at(-1);
        const bare = last !== undefined && EDIT_CONNECTORS.has(last) ? lead.slice(0, -1) : lead;
        if (asksSomething(parts.lead) || !coveredBy(bare, APPROVE)) {
          return 'start with approval words before the edited text ("approve: <text>")';
        }
        return recordedText(parts.body, edited, "edited text");
      };
    }
    case "rewrite": {
      const note = input.rewriteNote ?? "";
      return ({ raw }) => {
        if (note.trim().length === 0) return "carry a rewrite note";
        const parts = splitAtSeparator(raw);
        if (
          parts === null ||
          asksSomething(parts.lead) ||
          !coveredBy(wordsOf(parts.lead), REWRITE)
        ) {
          return 'say "rewrite: <note>"';
        }
        return recordedText(parts.body, note, "rewrite note");
      };
    }
    case "drop":
      return ({ raw, words }) =>
        !asksSomething(raw) && coveredBy(words, DROP)
          ? null
          : 'say only a drop ("drop it", "dont send")';
  }
};

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

/**
 * What an iMessage must be to answer an ask. With an option, the reply is
 * that option alone (its label or id, after an optional "go"/"pick", before an
 * optional "please"), so it never carries extra words the option could be
 * read against; a reply with more to say is recorded as a free-text answer
 * (no option) or confirmed in the app. A reply that could name more than one
 * option is refused, including one whose lead or courtesy word is itself an
 * option ("yes, no"). Without an option, the reply is the answer text as he
 * typed it.
 */
export const answerCheck = (input: {
  readonly options: ReadonlyArray<AnswerOption>;
  readonly optionId: string | null;
  readonly text: string;
}): ReplyCheck => {
  if (input.optionId === null) {
    return ({ raw }) => {
      if (input.text.trim().length === 0) return "carry an answer";
      return asTyped(raw) === asTyped(input.text)
        ? null
        : "say exactly the answer text (pass his whole reply as typed)";
    };
  }
  const optionId = input.optionId;
  const chosen = input.options.find((option) => option.id === optionId);
  const forms = formsOf(input.options);
  return ({ raw }) => {
    if (chosen === undefined) return `offer option ${optionId}`;
    if (input.text.trim().length > 0) {
      return "stop at the option (record his extra words as a free-text answer instead)";
    }
    if (asksSomething(raw)) return "make a choice (it asks a question)";
    const { named, around } = readChoice(forms, tokensOf(raw));
    const either = new Set([...named, ...around]);
    if (either.size > 1) return "pick one option unambiguously";
    if (either.size === 1 && !either.has(optionId)) {
      return `pick "${chosen.label}" (option ${optionId})`;
    }
    return named.has(optionId) ? null : `say only the option ("${chosen.label}")`;
  };
};
