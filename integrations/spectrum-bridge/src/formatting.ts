export type Format = { type: "bold" | "italic" | "strikethrough"; start: number; length: number };
export type FormattedText = { text: string; formatting: Format[] };

const MASK = "\uE000";
// Code, fenced blocks, and URLs are copied verbatim; their characters can never be delimiters.
const PROTECTED = /```[\s\S]*?```|`[^`\n]+`|https?:\/\/[^\s<>]+/g;
const BEFORE = String.raw`(?<=^|[\s(\[{"'\u201C\u2018])`;
const AFTER = String.raw`(?=$|[\s.,;:!?)\]}"'\u201D\u2019])`;
const PATTERNS: [Format["type"], RegExp][] = [
  ["bold", new RegExp(String.raw`${BEFORE}\*\*(?=[^\s*])((?:[^*\n]|\*(?!\*))*?[^\s*])\*\*${AFTER}`, "gmu")],
  ["strikethrough", new RegExp(String.raw`${BEFORE}~~(?=[^\s~])([^~\n]*?[^\s~])~~${AFTER}`, "gmu")],
  ["italic", new RegExp(String.raw`${BEFORE}\*(?=[^\s*])([^*\n]*?[^\s*])\*${AFTER}`, "gmu")],
];

// Models sometimes leak internal blocks into their visible text; never deliver them.
const INTERNAL = String.raw`(?:think(?:ing)?|internal|reasoning|antml:thinking)`;
const INTERNAL_BLOCK = new RegExp(String.raw`<${INTERNAL}(?=[\s>/])[\s\S]*?<\/${INTERNAL}\s*>`, "gi");
const INTERNAL_UNCLOSED = new RegExp(String.raw`<${INTERNAL}>[\s\S]*$`, "i");
const INTERNAL_ORPHAN = new RegExp(String.raw`<\/${INTERNAL}\s*>`, "gi");

// Context-management (DCP) metadata the agent sometimes echoes: <dcp-...> tags and their
// blocks, "[Compressed conversation section]" headers, and bare boundary ids such as
// @162@, @b7@ or @blocked@. An id only counts as a standalone token; code and URLs are
// matched first and kept verbatim, so emails, @mentions and links survive.
const DCP_BLOCK = /<(dcp-[a-z][a-z0-9-]*)(?=[\s>/])[^>]*>[\s\S]*?<\/\1\s*>/gi;
const DCP_TAG = /<\/?dcp-[a-z][a-z0-9-]*(?=[\s>/])[^>]*>/gi;
const DCP_HEADER = /^[^\S\n]*\[Compressed conversation section(?: b\d+)?\][^\S\n]*$/gim;
const DCP_ID = new RegExp(String.raw`${PROTECTED.source}|([^\S\n]*(?<![\p{L}\p{N}_@/\\])@(?:\d+|b\d+|blocked)@(?![\p{L}\p{N}_@/\\]))`, "giu");

/** Removes model-internal blocks and DCP metadata, then tidies the whitespace they leave behind. */
export function stripInternalText(text: string): string {
  return text
    .replace(INTERNAL_BLOCK, " ")
    .replace(INTERNAL_UNCLOSED, "")
    .replace(INTERNAL_ORPHAN, "")
    .replace(DCP_BLOCK, " ")
    .replace(DCP_TAG, " ")
    .replace(DCP_HEADER, "")
    .replace(DCP_ID, (match, id: string | undefined) => id === undefined ? match : "")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Converts conservative light markdown into plain text plus UTF-16 formatting ranges. */
export function formatText(raw: string): FormattedText {
  const text = stripInternalText(raw);
  let masked = text.replace(PROTECTED, match => MASK.repeat(match.length));
  const removed = new Uint8Array(text.length);
  const spans: { type: Format["type"]; start: number; end: number }[] = [];
  for (const [type, pattern] of PATTERNS) {
    const found: { start: number; end: number; width: number }[] = [];
    for (const match of masked.matchAll(pattern)) {
      const width = type === "italic" ? 1 : 2;
      found.push({ start: match.index, end: match.index + match[0].length, width });
    }
    for (const { start, end, width } of found) {
      for (let index = 0; index < width; index++) {
        removed[start + index] = 1;
        removed[end - 1 - index] = 1;
      }
      spans.push({ type, start: start + width, end: end - width });
      // Consumed delimiters must not pair again in a later pattern.
      masked = masked.slice(0, start) + MASK.repeat(width) + masked.slice(start + width, end - width)
        + MASK.repeat(width) + masked.slice(end);
    }
  }
  if (spans.length === 0) return { text, formatting: [] };
  const position = new Uint32Array(text.length + 1);
  let output = "";
  for (let index = 0; index < text.length; index++) {
    position[index] = output.length;
    if (!removed[index]) output += text[index];
  }
  position[text.length] = output.length;
  const formatting = spans
    .map(span => ({ type: span.type, start: position[span.start]!, length: position[span.end]! - position[span.start]! }))
    .filter(format => format.length > 0)
    .sort((a, b) => a.start - b.start || a.length - b.length);
  return { text: output, formatting };
}

/** Longest bubble delivery sends; longer text goes out in several. */
export const BUBBLE_CHARS = 3_500;

/** Splits at code point boundaries and clips formatting into chunk-relative UTF-16 ranges. */
export function splitFormatted(value: FormattedText, size: number): FormattedText[] {
  const characters = Array.from(value.text);
  const chunks: FormattedText[] = [];
  let unitOffset = 0;
  for (let offset = 0; offset < characters.length; offset += size) {
    const text = characters.slice(offset, offset + size).join("");
    const start = unitOffset;
    const end = start + text.length;
    const formatting: Format[] = [];
    for (const format of value.formatting) {
      const from = Math.max(format.start, start);
      const to = Math.min(format.start + format.length, end);
      if (to > from) formatting.push({ type: format.type, start: from - start, length: to - from });
    }
    chunks.push({ text, formatting });
    unitOffset = end;
  }
  return chunks;
}

export const hasUrl = (text: string) => /https?:\/\/\S/i.test(text);

/** Photon only accepts link previews for a message that is exactly one absolute http(s) URL. */
export const isSingleUrl = (text: string) => /^https?:\/\/[^\s<>]+$/i.test(text) && URL.canParse(text);
