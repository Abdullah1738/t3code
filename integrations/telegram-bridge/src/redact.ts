function urlSpans(text: string) {
  const spans: Array<{ start: number; end: number }> = [];
  const url = /\bhttps?:(?:\\*\/){2}/gi;
  for (let match = url.exec(text); match; match = url.exec(text)) {
    const quote = text[match.index - 1];
    const wrapped = quote === '"' || quote === "'";
    const escaped = wrapped && text[match.index - 2] === "\\";
    let end = url.lastIndex;
    let slashes = 0;
    for (; end < text.length; end++) {
      const char = text[end]!;
      if (/[\s<>]/.test(char)) break;
      if ((wrapped ? char === quote : char === '"')
        && (escaped ? slashes % 4 === 1 : slashes % 2 === 0)) break;
      slashes = char === "\\" ? slashes + 1 : 0;
    }
    spans.push({ start: match.index, end });
    url.lastIndex = end;
  }
  return spans;
}

/** Telegram is a notification channel, never a transport for signed URLs or bearer credentials. */
export function redact(text: string, preserveLength = false): string {
  const mask = (original: string, replacement: string) => {
    if (!preserveLength) return replacement;
    const length = Array.from(original).length;
    const remaining = length - Array.from(replacement).length;
    return remaining < 0 ? "*".repeat(length) : replacement + " ".repeat(remaining);
  };
  const urls = urlSpans(text);
  const token = /\b(?:access[_-]?)?token(?:\\?["'])?\s*(?:[=:]|%3d)\s*/gi;
  const parts: string[] = [];
  let cursor = 0;
  for (let match = token.exec(text); match; match = token.exec(text)) {
    // A URL parameter is masked with its whole URL, without changing quote escapes mid-value.
    if (urls.some(url => url.start >= cursor && match.index >= url.start && match.index < url.end)) continue;
    const start = token.lastIndex;
    let value = start;
    const bearer = /^Bearer\s+/i.exec(text.slice(value));
    if (bearer) value += bearer[0].length;
    const escaped = text[value] === "\\" && /["']/.test(text[value + 1] ?? "");
    const quote = escaped ? text[value + 1] : text[value];
    let end = value;
    if (quote === '"' || quote === "'") {
      end += escaped ? 2 : 1;
      let slashes = 0;
      // JSON strings and JSON-escaped strings have different closing-quote parity.
      for (; end < text.length; end++) {
        const char = text[end];
        if (char === quote && (escaped ? slashes % 4 === 1 : slashes % 2 === 0)) {
          end++;
          break;
        }
        slashes = char === "\\" ? slashes + 1 : 0;
      }
    } else if (text.startsWith("[redacted]", value)) {
      end += "[redacted]".length;
    } else {
      end += /^[^\s&<>"',;)}\]]*/.exec(text.slice(value))![0].length;
      for (const url of urls) {
        if (url.start >= value && url.start <= end) end = Math.max(end, url.end);
      }
    }
    if (end === start) continue;
    parts.push(text.slice(cursor, match.index), mask(text.slice(match.index, end), `${match[0]}[redacted]`));
    cursor = end;
    token.lastIndex = end;
  }
  parts.push(text.slice(cursor));
  text = parts.join("");
  const links: string[] = [];
  cursor = 0;
  for (const { start, end } of urlSpans(text)) {
    const original = text.slice(start, end);
    const query = original.search(/[?#]/);
    const retained = query === -1 ? original : original.slice(0, query);
    const pathToken = /\b(?:access[_-]?)?token\s*(?:[=:]|%3d)/i.exec(retained);
    const replacement = pathToken ? retained.slice(0, pathToken.index + pathToken[0].length) + "[redacted]"
      : query !== -1 ? retained : undefined;
    if (replacement !== undefined) {
      // Closing quote escapes belong to the containing JSON string, not its URL query.
      const tail = /\\*$/.exec(original)![0];
      const content = original.slice(0, original.length - tail.length);
      links.push(text.slice(cursor, start), mask(content, replacement), tail);
      cursor = end;
    }
  }
  links.push(text.slice(cursor));
  return links.join("").replace(/\beyJ[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*){0,2}/g,
    jwt => mask(jwt, "[redacted]"));
}
