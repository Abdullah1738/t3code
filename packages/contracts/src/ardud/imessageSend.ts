import * as Schema from "effect/Schema";

/** iMessage effects the bridge can send. Mirrors the bridge CLI's `EFFECT_NAMES`. */
export const IMESSAGE_SEND_EFFECTS = [
  "slam",
  "loud",
  "gentle",
  "invisible",
  "confetti",
  "fireworks",
  "balloons",
  "heart",
  "lasers",
  "celebration",
  "sparkles",
  "spotlight",
  "echo",
] as const;
export type ImessageSendEffect = (typeof IMESSAGE_SEND_EFFECTS)[number];

export const IMESSAGE_SEND_MAX_TEXT = 12_000;

/** The bridge CLI's chat slug rule (`chatSlug` in spectrum-bridge `cli.ts`). */
export const IMESSAGE_CHAT_SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;

// Control characters the bridge CLI refuses in paths and session ids.
// eslint-disable-next-line no-control-regex -- the CLI refuses these, so refuse them first.
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/;

const NoControlChars = Schema.makeFilter(
  (value: string) => !CONTROL_CHARS.test(value) || "must not contain control characters",
);

/**
 * Input for the `imessage_send` MCP tool. The server runs the iMessage bridge
 * CLI with these values, so they follow the CLI's own limits.
 */
export const ImessageSendMcpInput = Schema.Struct({
  text: Schema.optional(
    Schema.String.check(Schema.isMaxLength(IMESSAGE_SEND_MAX_TEXT)).annotate({
      description:
        "Message text, plain text only (no markdown tables). With `file` it becomes the caption.",
    }),
  ),
  file: Schema.optional(
    Schema.String.check(
      Schema.isMaxLength(4_096),
      Schema.makeFilter((value: string) => value.startsWith("/") || "must be an absolute path"),
      NoControlChars,
    ).annotate({
      description: "Absolute path of an image or file to send (up to 20 MiB).",
    }),
  ),
  to: Schema.optional(
    Schema.String.check(Schema.isPattern(IMESSAGE_CHAT_SLUG_PATTERN)).annotate({
      description:
        "Another chat's slug (e.g. `moni`). Only from the owner's chat. Omit to text the chat this thread serves.",
    }),
  ),
  effect: Schema.optional(
    Schema.Literals(IMESSAGE_SEND_EFFECTS).annotate({
      description: "iMessage effect for a text message. Not with `to` or `file`.",
    }),
  ),
  session: Schema.optional(
    Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(200),
      Schema.makeFilter((value: string) => !/\s/.test(value) || "must not contain whitespace"),
      NoControlChars,
    ).annotate({
      description:
        "CURRENT_SESSION_ID from the bridge context. Defaults to this thread's root thread.",
    }),
  ),
  key: Schema.optional(
    Schema.String.check(Schema.isMaxLength(200), NoControlChars).annotate({
      description:
        "Dedupe key. Defaults to one derived from this call, so a retry never sends twice.",
    }),
  ),
}).check(
  Schema.makeFilter((input) => {
    const hasText = input.text !== undefined && input.text.trim().length > 0;
    if (!hasText && input.file === undefined) return "Pass `text`, `file`, or both.";
    if (input.effect !== undefined && input.to !== undefined)
      return "`effect` cannot be combined with `to`.";
    if (input.effect !== undefined && input.file !== undefined)
      return "`effect` only applies to text messages, not `file`.";
    if (input.to !== undefined && input.file !== undefined)
      return "`to` only sends text; send files in the chat this thread serves.";
    if (input.key !== undefined && input.key.trim().length === 0) return "`key` must not be blank.";
    return true;
  }),
);
export type ImessageSendMcpInput = typeof ImessageSendMcpInput.Type;

export const ImessageSendMcpResult = Schema.Struct({
  /** Bridge outbox id: `send:<64 hex>` or `file:<64 hex>`. */
  id: Schema.String,
  /** False when the key matched an earlier send, so nothing new was queued. */
  created: Schema.Boolean,
  /** The chat slug it went to, or `owner` for the chat this thread serves. */
  chat: Schema.String,
});
export type ImessageSendMcpResult = typeof ImessageSendMcpResult.Type;
