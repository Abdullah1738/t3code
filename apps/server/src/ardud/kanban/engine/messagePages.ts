import type { KanbanBlock, KanbanMessage } from "@t3tools/contracts";

/** A list page holds at most this many messages... */
export const MESSAGE_PAGE_LIMIT = 50;
/** ...and about this much encoded JSON, but always at least one message. */
export const MESSAGE_PAGE_BYTES = 256 * 1024;
/** md, collapse and html text past this goes out as a stub in list reads and board feeds. */
export const BIG_BLOCK_BYTES = 64 * 1024;
const MD_PREVIEW_CHARS = 2 * 1024;

const utf8Bytes = (text: string) => Buffer.byteLength(text, "utf8");

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** The first `chars` UTF-16 units, never ending inside a surrogate pair. */
const previewOf = (text: string, chars = MD_PREVIEW_CHARS) => {
  if (text.length <= chars) return text;
  const code = text.charCodeAt(chars - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? chars - 1 : chars;
  return `${text.slice(0, end)}…`;
};

/** A big block as its preview, keeping `_tag` so older clients still render it. */
export const stubBlock = (block: KanbanBlock): KanbanBlock => {
  switch (block._tag) {
    case "md":
    case "collapse": {
      const fullBytes = utf8Bytes(block.text);
      if (fullBytes <= BIG_BLOCK_BYTES) return block;
      return { ...block, text: previewOf(block.text), truncated: true, fullBytes };
    }
    case "html": {
      const fullBytes = utf8Bytes(block.html);
      if (fullBytes <= BIG_BLOCK_BYTES) return block;
      const kb = Math.round(fullBytes / 1024);
      const label = block.title?.trim() ? escapeHtml(block.title.trim()) : "Page";
      return {
        ...block,
        html: `<p>${label} (${kb} KB) is too big to show here.</p>`,
        truncated: true,
        fullBytes,
      };
    }
    default:
      return block;
  }
};

/** The message as list reads send it: same object when nothing is big. */
export const stubMessage = (message: KanbanMessage): KanbanMessage => {
  let changed = false;
  const blocks = message.blocks.map((block) => {
    const next = stubBlock(block);
    if (next !== block) changed = true;
    return next;
  });
  return changed ? { ...message, blocks } : message;
};

export const messageBytes = (message: KanbanMessage) => utf8Bytes(JSON.stringify(message));

/**
 * The newest messages of `messages` (oldest first) that fit in `maxBytes`, oldest first.
 * Always keeps the newest one, so a page is never empty while there are messages.
 */
export const fitNewest = (
  messages: ReadonlyArray<KanbanMessage>,
  maxBytes: number,
  size: (message: KanbanMessage) => number = messageBytes,
): ReadonlyArray<KanbanMessage> => {
  let total = 0;
  let start = messages.length;
  while (start > 0) {
    const bytes = size(messages[start - 1]!);
    if (start < messages.length && total + bytes > maxBytes) break;
    total += bytes;
    start -= 1;
  }
  return start === 0 ? messages : messages.slice(start);
};

/** A list page: big blocks stubbed, then cut to the newest that fit the byte budget. */
export const listPage = (
  messages: ReadonlyArray<KanbanMessage>,
  maxBytes = MESSAGE_PAGE_BYTES,
): ReadonlyArray<KanbanMessage> => fitNewest(messages.map(stubMessage), maxBytes);

/** Older clients ask for 200; they get up to that, still under the byte budget. */
export const MESSAGE_PAGE_MAX = 200;
/** Agent reads keep blocks whole, so they get a bigger budget. */
export const AGENT_READ_BYTES = 1024 * 1024;

/** The count asked for, held to the max; 0 or none means `fallback`. */
export const pageLimit = (limit: number | undefined, fallback = MESSAGE_PAGE_LIMIT) =>
  limit === undefined || limit <= 0
    ? Math.min(fallback, MESSAGE_PAGE_MAX)
    : Math.min(limit, MESSAGE_PAGE_MAX);
