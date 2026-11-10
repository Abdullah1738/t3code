/**
 * What a reply in an ask's discussion may carry. The server holds replies to
 * the same limits as asks; the composer checks them first so he is told which
 * one he hit instead of getting a refusal. Pure.
 */
import { kanbanAskResponse, type KanbanBlock, type KanbanOwnerAsk } from "@t3tools/contracts";

import { askFieldKind } from "./askAnswer.ts";

export const ASK_REPLY_LIMITS = {
  blocks: 12,
  /** Pictures and files together. */
  media: 8,
  /** One page. */
  htmlBytes: 256 * 1024,
  /** One block of text. */
  textChars: 20_000,
} as const;

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

/** Why a reply can't be sent as it stands, in his words, or null when it can. */
export function askReplyProblem(blocks: ReadonlyArray<KanbanBlock>): string | null {
  if (blocks.length === 0) return "Write something first.";
  const media = blocks.filter(
    (block) => block._tag === "image" || block._tag === "attachment",
  ).length;
  if (media > ASK_REPLY_LIMITS.media) {
    return `A reply takes up to ${ASK_REPLY_LIMITS.media} pictures and files. This one has ${media}.`;
  }
  if (blocks.length > ASK_REPLY_LIMITS.blocks) {
    return `A reply takes up to ${ASK_REPLY_LIMITS.blocks} parts (text, pictures, files). This one has ${blocks.length}.`;
  }
  for (const block of blocks) {
    if (
      (block._tag === "md" || block._tag === "collapse") &&
      block.text.length > ASK_REPLY_LIMITS.textChars
    ) {
      return `Keep a reply under ${ASK_REPLY_LIMITS.textChars.toLocaleString("en-US")} characters. This one has ${block.text.length.toLocaleString("en-US")}.`;
    }
    if (block._tag === "html" && utf8Bytes(block.html) > ASK_REPLY_LIMITS.htmlBytes) {
      return "A page in a reply can be up to 256 KB.";
    }
  }
  return null;
}

/**
 * True when the ask can't close without a secret from him. Such an ask is
 * never handed to the evaluator, which has no way to give one.
 */
export const askRequiresSecret = (ask: KanbanOwnerAsk): boolean => {
  const response = kanbanAskResponse(ask);
  return response.fields.some(
    (field) =>
      askFieldKind(field) === "secret" &&
      (field.required === true || response.task?.proof === field.id),
  );
};
