export const controlChars = (
  text: string,
): { readonly offset: number; readonly char: number; readonly count: number } | null => {
  let first: { offset: number; char: number } | null = null;
  let count = 0;
  for (let offset = 0; offset < text.length; offset++) {
    const char = text.charCodeAt(offset);
    if ((char < 0x20 && char !== 0x09 && char !== 0x0a && char !== 0x0d) || char === 0x7f) {
      first ??= { offset, char };
      count++;
    }
  }
  return first === null ? null : { ...first, count };
};

export const textProblem = (
  fields: ReadonlyArray<readonly [name: string, value: string | null | undefined]>,
): string | null => {
  for (const [name, value] of fields) {
    if (value == null) continue;
    const bad = controlChars(value);
    if (bad === null) continue;
    const code = bad.char.toString(16).toUpperCase().padStart(4, "0");
    return `${name} has a control character U+${code} at offset ${bad.offset} (${bad.count} in all). Board text can't hold control characters other than tab and newlines, so nothing was saved. This usually means a broken decode; in Code Mode, Uint8Array.from(text, fn) ignores fn, so decode base64 with Uint8Array.fromBase64(b64).`;
  }
  return null;
};
