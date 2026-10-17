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
  /** Any of these must appear (normalized) in the message text. */
  readonly expected: ReadonlyArray<string>;
  /** None of these may appear (an approval that also says "don't send"). */
  readonly contradicts?: ReadonlyArray<string>;
  /** The record being answered; the message must not predate it. */
  readonly notBefore: string;
  readonly what: string;
}

/**
 * The only way an iMessage becomes owner provenance: a real inbound from the
 * owner's or Moni's chat, received after the record opened, whose text says
 * what the answer says.
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
  if (Number.isFinite(notBefore) && inbound.receivedAt < notBefore - INBOUND_CLOCK_SKEW_MS) {
    return refuse(
      "provenance-invalid",
      `iMessage ${inboundId} arrived before the ${command.what.toLowerCase()} target existed.`,
    );
  }
  const said = ` ${normalizeText(inbound.text)} `;
  const candidates = command.expected.map(normalizeText).filter((text) => text.length > 0);
  if (candidates.length === 0) {
    return refuse("invalid", `${command.what} has no text to check against the iMessage.`);
  }
  // A one-character option id ("a", "2") only counts as the whole reply;
  // inside a sentence it is just a word.
  const says = (text: string) =>
    text.length === 1 ? said.trim() === text : said.includes(` ${text} `);
  if (!candidates.some(says)) {
    return refuse(
      "provenance-invalid",
      `iMessage ${inboundId} does not say "${command.expected[0] ?? ""}".`,
    );
  }
  const contradiction = (command.contradicts ?? [])
    .map(normalizeText)
    .find((text) => text.length > 0 && said.includes(` ${text} `));
  if (contradiction !== undefined) {
    return refuse(
      "provenance-invalid",
      `iMessage ${inboundId} also says "${contradiction}"; answer it in the app instead.`,
    );
  }
  return ok({ _tag: "owner-imessage", chat: inbound.chat, inboundId: inbound.id });
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
/** Words that drop a draft by iMessage; they also void an approval. */
export const DROP_WORDS = [
  "drop",
  "drop it",
  "dont send",
  "do not send",
  "skip",
  "kill it",
  "cancel",
];

export interface ExpectedText {
  readonly expected: ReadonlyArray<string>;
  readonly contradicts: ReadonlyArray<string>;
}

/**
 * What an iMessage must contain to approve, rewrite or drop a draft: the edit
 * or rewrite note when there is one, otherwise an approve or drop word.
 */
export const expectedForDraftDecision = (input: {
  readonly action: "approve" | "rewrite" | "drop";
  readonly editedText?: string | undefined;
  readonly rewriteNote?: string | undefined;
}): ExpectedText => {
  switch (input.action) {
    case "approve":
      return input.editedText !== undefined && input.editedText.trim().length > 0
        ? { expected: [input.editedText], contradicts: [] }
        : { expected: APPROVE_WORDS, contradicts: DROP_WORDS };
    case "rewrite":
      return {
        expected: input.rewriteNote !== undefined ? [input.rewriteNote] : [],
        contradicts: [],
      };
    case "drop":
      return { expected: DROP_WORDS, contradicts: [] };
  }
};

/**
 * What an iMessage must contain to answer an ask: the answer text when given,
 * else the chosen option's label or id (poll votes quote the label).
 */
export const expectedForAnswer = (input: {
  readonly text: string;
  readonly option: { readonly id: string; readonly label: string } | null;
}): ExpectedText => ({
  expected:
    input.text.trim().length > 0
      ? [input.text]
      : input.option === null
        ? []
        : [input.option.label, input.option.id],
  contradicts: [],
});
