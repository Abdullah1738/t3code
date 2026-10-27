import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS, type KanbanBlock } from "@t3tools/contracts";

/** A file the board can post: an uploaded image or file, as the block carries it. */
export type ChatAttachmentBlock = Extract<KanbanBlock, { _tag: "attachment" }>["attachment"];

/** Blocks for one post: the text first (if any), then one attachment block per file. */
export function composerBlocks(
  text: string,
  attachments: ReadonlyArray<ChatAttachmentBlock>,
): KanbanBlock[] {
  const blocks: KanbanBlock[] = [];
  if (text.length > 0) blocks.push({ _tag: "md", text });
  for (const attachment of attachments) blocks.push({ _tag: "attachment", attachment });
  return blocks;
}

/** Discussion title: the first non-empty line of the text, else the first file name, else "Request". */
export function composerTitleSource(text: string, fileNames: ReadonlyArray<string>): string {
  const firstLine = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return firstLine ?? fileNames[0] ?? "Request";
}

/** Error text when the draft count is over the per-message limit, else null. */
export function composerLimitError(count: number): string | null {
  return count > PROVIDER_SEND_TURN_MAX_ATTACHMENTS
    ? `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`
    : null;
}
