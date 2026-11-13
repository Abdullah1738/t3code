export const MAX_REPLY_BYTES = 16 * 1024 * 1024;
export const MAX_BUFFERED_COMPRESSION_BYTES = 2 * 1024 * 1024;
export const REPLY_TOO_LARGE =
  "Reply exceeds the 16 MiB limit. Request a smaller page or read one card/thread at a time. A mutation may already be saved; read its state before retrying.";

export class ReplyTooLarge extends Error {
  override readonly name = "ReplyTooLarge";
  constructor() {
    super(REPLY_TOO_LARGE);
  }
}

/** Count before stringify/TextEncoder, where a second full-size copy can exhaust the heap. */
export const jsonExceedsBudget = (value: unknown, limit = MAX_REPLY_BYTES): boolean => {
  let bytes = 0;
  const stringBytes = (text: string) => {
    let size = Buffer.byteLength(text, "utf8") + 2;
    if (size > limit) return size;
    // eslint-disable-next-line no-control-regex -- JSON escapes controls; their wire size must be counted.
    for (const match of text.matchAll(/["\\\u0000-\u001f\ud800-\udfff]/g)) {
      const code = text.charCodeAt(match.index);
      if (code >= 0xd800 && code <= 0xdfff) {
        const paired =
          code <= 0xdbff
            ? text.charCodeAt(match.index + 1) >= 0xdc00 &&
              text.charCodeAt(match.index + 1) <= 0xdfff
            : text.charCodeAt(match.index - 1) >= 0xd800 &&
              text.charCodeAt(match.index - 1) <= 0xdbff;
        if (!paired) size += 3;
      } else size += code < 32 && ![8, 9, 10, 12, 13].includes(code) ? 5 : 1;
      if (size > limit) return size;
    }
    return size;
  };
  const ancestors = new Set<object>();
  const visit = (input: unknown): boolean => {
    if (typeof input === "string") bytes += stringBytes(input);
    else if (input === null || typeof input !== "object") {
      bytes +=
        typeof input === "number"
          ? String(Number.isFinite(input) ? input : null).length
          : input === true
            ? 4
            : input === false
              ? 5
              : 4;
    } else {
      if (ancestors.has(input)) throw new TypeError("Circular reply.");
      ancestors.add(input);
      bytes += 2;
      if (Array.isArray(input)) {
        for (let index = 0; index < input.length; index++) {
          if (index > 0) bytes++;
          if (bytes > limit || visit(input[index])) return true;
        }
      } else {
        let count = 0;
        for (const key of Object.keys(input)) {
          const item = (input as Record<string, unknown>)[key];
          if (item === undefined || typeof item === "function" || typeof item === "symbol")
            continue;
          if (count++ > 0) bytes++;
          bytes += stringBytes(key) + 1;
          if (bytes > limit || visit(item)) return true;
        }
      }
      ancestors.delete(input);
    }
    return bytes > limit;
  };
  return visit(value);
};
