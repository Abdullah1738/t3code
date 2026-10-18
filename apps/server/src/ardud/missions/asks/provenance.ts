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
// no punctuation, "don't" -> "dont"); any text that gets recorded (an edit, a
// rewrite note, a free-text answer) must match what he typed up to whitespace.
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

const formsOf = (option: AnswerOption): ReadonlyArray<Words> =>
  [wordsOf(option.label), wordsOf(option.id)].filter((form) => form.length > 0);

/** A one-letter id ("a", "2") inside a sentence is just a word. */
const isLetter = (form: Words) => form.length === 1 && (form[0]?.length ?? 0) === 1;

/**
 * What an iMessage must be to answer an ask. With an option, the reply is
 * that option alone (its label or id, after an optional "go"/"pick", before an
 * optional "please"), so it never carries extra words the option could be
 * read against; a reply with more to say is recorded as a free-text answer
 * (no option) or confirmed in the app. Without an option, the reply is the
 * answer text as he typed it.
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
  return ({ raw, words }) => {
    if (chosen === undefined) return `offer option ${optionId}`;
    if (input.text.trim().length > 0) {
      return "stop at the option (record his extra words as a free-text answer instead)";
    }
    if (asksSomething(raw)) return "make a choice (it asks a question)";
    // Every way to read the reply as [lead words] <option> [rest]; at each
    // split the longest option form wins ("online with backup" over "online").
    const parses: Array<{ readonly optionId: string; readonly rest: Words }> = [];
    for (let split = 0; split < words.length; split++) {
      if (split > 0 && !coveredBy(words.slice(0, split), SELECT)) continue;
      const after = words.slice(split);
      let best: { readonly optionId: string; readonly form: Words } | null = null;
      for (const option of input.options) {
        for (const form of formsOf(option)) {
          if (!startsWith(after, form)) continue;
          if (isLetter(form) && after.length !== 1) continue;
          if (best === null || form.length > best.form.length) best = { optionId: option.id, form };
        }
      }
      if (best !== null)
        parses.push({ optionId: best.optionId, rest: after.slice(best.form.length) });
    }
    const named = new Set(parses.map((parse) => parse.optionId));
    if (!named.has(optionId)) return `pick "${chosen.label}" (option ${optionId})`;
    if (named.size > 1) return "pick one option unambiguously";
    const alone = parses.some(
      (parse) =>
        parse.optionId === optionId && (parse.rest.length === 0 || coveredBy(parse.rest, COURTESY)),
    );
    return alone ? null : `say only the option ("${chosen.label}")`;
  };
};
