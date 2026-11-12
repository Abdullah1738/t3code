/** Values stay inside the redactor; neither diagnostics nor errors may serialize them. */
export const strings = (value: unknown): string[] => {
  if (value === undefined) return [];
  if (typeof value === "string") return value ? [value] : [];
  if (Array.isArray(value)) return [JSON.stringify(value), ...value.flatMap(strings)];
  if (value !== null && typeof value === "object")
    return [
      JSON.stringify(value),
      ...Object.entries(value).flatMap(([key, v]) => [key, ...strings(v)]),
    ];
  return [JSON.stringify(value)];
};

export function longestBackslashRun(text: string): number {
  let longest = 0;
  let run = 0;
  for (const character of text) {
    run = character === "\\" ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return longest;
}

/** Bound nesting by actual escape runs, rather than guessing a fixed JSON depth. */
export function escapedNeedles(needles: readonly string[], maxBackslashes: number): string[] {
  const variants = new Set<string>();
  for (const needle of needles) {
    if (!needle) continue;
    let current = needle;
    variants.add(current);
    while (true) {
      const escaped = JSON.stringify(current).slice(1, -1);
      if (escaped === current || longestBackslashRun(escaped) > maxBackslashes) break;
      variants.add(escaped);
      current = escaped;
    }
  }
  return [...variants].sort((a, b) => b.length - a.length);
}

const equalJson = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (Array.isArray(left))
    return (
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((v, i) => equalJson(v, right[i]))
    );
  if (
    !left ||
    !right ||
    typeof left !== "object" ||
    typeof right !== "object" ||
    Array.isArray(right)
  )
    return false;
  const a = left as Record<string, unknown>,
    b = right as Record<string, unknown>;
  return (
    Object.keys(a).length === Object.keys(b).length &&
    Object.entries(a).every(([k, v]) => Object.hasOwn(b, k) && equalJson(v, b[k]))
  );
};
const matchesJsonValue = (value: unknown, needles: readonly string[]) =>
  typeof value !== "string" &&
  needles.some((n) => {
    try {
      if (jsonNumber.test(n.trim())) {
        const exact = decimalValue(n.trim());
        return (
          typeof value === "number" &&
          exact !== undefined &&
          exact === decimalValue(JSON.stringify(value))
        );
      }
      return equalJson(parseJson(n), value);
    } catch (error) {
      if (
        error instanceof DuplicateJsonKeyError ||
        error instanceof LossyJsonNumberError ||
        error instanceof InvalidJsonRecordError
      )
        throw error;
      return false;
    }
  });

// oxlint-disable-next-line no-control-regex -- JSON forbids literal control characters inside string tokens.
const jsonStringTokens = /"(?:\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})|[^"\\\u0000-\u001f])*"/g;

export class DuplicateJsonKeyError extends Error {
  constructor() {
    super("Redaction refuses duplicate JSON object keys.");
  }
}

export class LossyJsonNumberError extends Error {
  constructor() {
    super("Redaction refuses lossy JSON numeric values.");
  }
}
export class InvalidJsonRecordError extends Error {
  constructor() {
    super("Redaction refuses incomplete encoded JSON strings.");
  }
}
const jsonNumber = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const decimalValue = (text: string) => {
  const parts = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!parts) return undefined;
  let digits = (parts[2]! + (parts[3] ?? "")).replace(/^0+/, "");
  if (!digits) return parts[1] + "0";
  const exponent = parts[4] ?? "0";
  if (exponent.replace(/^[+-]?0*/, "").length > 6) return undefined;
  let scale = BigInt(exponent) - BigInt((parts[3] ?? "").length);
  const trimmed = digits.replace(/0+$/, "");
  scale += BigInt(digits.length - trimmed.length);
  digits = trimmed;
  return `${parts[1]}${digits}e${scale}`;
};

/** JSON.parse would discard overridden values, making erasure impossible to verify. */
export function parseJson(source: string): unknown {
  const parsed: unknown = JSON.parse(source);
  const stack: (Set<string> | undefined)[] = [];
  const tokens = new RegExp(
    `${jsonStringTokens.source}|-?(?:0|[1-9]\\d*)(?:\\.\\d+)?(?:[eE][+-]?\\d+)?|[{}\\[\\]:,]`,
    "g",
  );
  for (const match of source.matchAll(tokens)) {
    const token = match[0];
    if (/^-?\d/.test(token)) {
      const encoded = JSON.stringify(Number(token));
      const original = decimalValue(token);
      if (original === undefined || original !== decimalValue(encoded))
        throw new LossyJsonNumberError();
    } else if (token === "{") stack.push(new Set());
    else if (token === "[") stack.push(undefined);
    else if (token === "}" || token === "]") stack.pop();
    else if (
      token.startsWith('"') &&
      source
        .slice(match.index + token.length)
        .trimStart()
        .startsWith(":")
    ) {
      const keys = stack.at(-1);
      const key = JSON.parse(token) as string;
      if (keys?.has(key)) throw new DuplicateJsonKeyError();
      keys?.add(key);
    }
  }
  return parsed;
}

const requireComparableNumbers = (needles: readonly string[]) => {
  for (const needle of needles)
    if (jsonNumber.test(needle.trim()) && decimalValue(needle.trim()) === undefined)
      throw new LossyJsonNumberError();
};

/** Decode string tokens before matching so valid alternate JSON escapes share one meaning. */
export function replaceText(
  text: string,
  needles: readonly string[],
  marker: string,
): { text: string; count: number } {
  requireComparableNumbers(needles);
  // Keep repeated escape-layer proofs bounded; the cache lives only for this invocation.
  const cache = new Map<string, Map<string, { text: string; count: number }>>();
  const visit: typeof replaceText = (source, selected, replacement) => {
    const key = JSON.stringify([selected, replacement]);
    let bucket = cache.get(key);
    if (!bucket) cache.set(key, (bucket = new Map()));
    const cached = bucket.get(source);
    if (cached) return cached;
    // Each output stays verifiable before overlapping streamed copies change its context.
    if (selected.length > 1) for (const needle of selected) visit(source, [needle], replacement);
    let structured = false;
    const semantic = selected.filter((needle) => {
      if (jsonNumber.test(needle.trim())) {
        structured = true;
        return true;
      }
      try {
        const value = parseJson(needle);
        structured = true;
        return typeof value !== "string";
      } catch (error) {
        if (
          error instanceof DuplicateJsonKeyError ||
          error instanceof LossyJsonNumberError ||
          error instanceof InvalidJsonRecordError
        )
          throw error;
        return false;
      }
    });
    const replaced = replaceTextContent(source, selected, replacement, visit, structured);
    let decoded = replaced.text;
    while (true) {
      const next = decoded.replace(
        /\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})/g,
        (escape) => JSON.parse(`"${escape}"`) as string,
      );
      if (next === decoded) break;
      decoded = next;
      if (
        escapedNeedles(selected, longestBackslashRun(decoded)).some((needle) =>
          decoded.includes(needle),
        ) ||
        // Decoding JSON syntax can itself produce an incomplete container around unrelated data.
        (semantic.length && replaceTextContent(decoded, semantic, replacement, visit, false).count)
      )
        throw new InvalidJsonRecordError();
    }
    bucket.set(source, replaced);
    return replaced;
  };
  return visit(text, needles, marker);
}

function replaceTextContent(
  text: string,
  needles: readonly string[],
  marker: string,
  visit: typeof replaceText,
  structuredProof: boolean,
): { text: string; count: number } {
  const plain = (source: string) => {
    let count = 0;
    let next = source;
    for (const needle of escapedNeedles(needles, longestBackslashRun(source))) {
      const parts = next.split(needle);
      count += parts.length - 1;
      next = parts.join(marker);
    }
    return { text: next, count };
  };
  const decoded = (source: string): { text: string; count: number } => {
    if (needles.includes(source)) return { text: marker, count: 1 };
    // Numeric string fields stay strings; compare nested numbers without a lossy Number conversion.
    if (jsonNumber.test(source.trim())) {
      const value = decimalValue(source.trim());
      if (value === undefined && needles.some((needle) => jsonNumber.test(needle.trim())))
        throw new LossyJsonNumberError();
      if (
        value !== undefined &&
        needles.some(
          (needle) => jsonNumber.test(needle.trim()) && decimalValue(needle.trim()) === value,
        )
      )
        return { text: marker, count: 1 };
      return plain(source);
    }
    const replaced = visit(source, needles, marker);
    if (replaced.count) return replaced;
    // Some log fields contain JSON string bodies without their outer quotes.
    if (source.includes("\\")) {
      try {
        const value: unknown = parseJson(`"${source}"`);
        if (typeof value === "string" && value !== source) {
          const inner = decoded(value);
          if (inner.count)
            return { text: JSON.stringify(inner.text).slice(1, -1), count: inner.count };
        }
      } catch (error) {
        if (
          error instanceof DuplicateJsonKeyError ||
          error instanceof LossyJsonNumberError ||
          error instanceof InvalidJsonRecordError
        )
          throw error;
        /* This is ordinary text, not another JSON string body. */
      }
    }
    return replaced;
  };
  const parseRegion = (source: string) => {
    try {
      return { value: parseJson(source) };
    } catch (error) {
      if (
        error instanceof DuplicateJsonKeyError ||
        error instanceof LossyJsonNumberError ||
        error instanceof InvalidJsonRecordError
      )
        throw error;
      return undefined;
    }
  };
  // Framing and surrounding plaintext are not part of the encoded JSON value.
  const jsonRegions = (source: string) => {
    const regions: { start: number; end: number; value: unknown; rawToken?: boolean }[] = [];
    const lines: typeof regions = [];
    const headers: { start: number; end: number }[] = [];
    let offset = 0;
    for (const line of source.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
      const start = offset;
      offset += line.length;
      const frame = line.match(/^\uFEFF?(?:\[[^\]\r\n]+\] )?(?:NTIVE|CANON|ORCH): /u)?.[0];
      const header = frame ?? (line.startsWith("\uFEFF") ? "\uFEFF" : "");
      if (frame) headers.push({ start, end: start + frame.length });
      const parsed = parseRegion(line.slice(header.length));
      if (parsed)
        lines.push({
          start: start + header.length,
          end: offset - (line.endsWith("\n") ? 1 : 0),
          value: parsed.value,
        });
    }
    const quotedToken = new RegExp(jsonStringTokens.source, "y");
    let lineIndex = 0;
    let headerIndex = 0;
    for (let start = 0; start < source.length; start++) {
      while (headerIndex < headers.length && headers[headerIndex]!.end <= start) headerIndex++;
      const header = headers[headerIndex];
      if (header && header.start <= start && start < header.end) {
        start = header.end - 1;
        continue;
      }
      while (lineIndex < lines.length && lines[lineIndex]!.end <= start) lineIndex++;
      const line = lines[lineIndex];
      if (line && line.start <= start && start < line.end) {
        start = line.end - 1;
        continue;
      }
      if (source[start] === '"') {
        quotedToken.lastIndex = start;
        const token = quotedToken.exec(source);
        if (token) {
          regions.push({
            start,
            end: start + token[0].length,
            value: parseJson(token[0]),
            rawToken: true,
          });
          start += token[0].length - 1;
          continue;
        }
        // A truncated encoded value cannot be verified by scanning its raw bytes.
        if (source.slice(start).includes("\\")) {
          const literal = escapedNeedles(needles, longestBackslashRun(source)).some((needle) => {
            const at = source.lastIndexOf(needle, start);
            return (
              at >= 0 &&
              start < at + needle.length &&
              !source.slice(at + needle.length).includes("\\")
            );
          });
          if (!literal) throw new InvalidJsonRecordError();
        }
      }

      if (source[start] !== "{" && source[start] !== "[") continue;
      if (
        source[start] === "[" &&
        /^\[(?:\d{4}-\d{2}-\d{2}[T ][^\]\r\n]+|\d{2}:\d{2}:\d{2}(?:\.\d+)?)\](?=\s)/u.test(
          source.slice(start),
        )
      ) {
        start = source.indexOf("]", start);
        continue;
      }
      const structured =
        source[start] === "{" ||
        /^\[\s*(?:["{[\]\-0-9]|true\b|false\b|null\b|$)/u.test(source.slice(start));
      const stack: string[] = [];
      let quoted = false;
      let escaped = false;
      let complete = false;
      let stopped = source.length;
      for (let end = start; end < source.length; end++) {
        const character = source[end]!;
        if (quoted) {
          if (escaped) escaped = false;
          else if (character === "\\") escaped = true;
          else if (character === '"') quoted = false;
        } else if (character === '"') quoted = true;
        else if (character === "{" || character === "[") stack.push(character);
        else if (character === "}" || character === "]") {
          if (stack.pop() !== (character === "}" ? "{" : "[")) {
            stopped = end + 1;
            break;
          }
          if (!stack.length) {
            const parsed = parseRegion(source.slice(start, end + 1));
            stopped = end + 1;
            if (parsed) {
              complete = true;
              regions.push({ start, end: end + 1, value: parsed.value });
              start = end;
            }
            break;
          }
        }
      }
      if (!complete && structured && structuredProof) {
        const covered = escapedNeedles(needles, longestBackslashRun(source)).some((needle) => {
          const at = source.lastIndexOf(needle, start);
          return at >= 0 && at + needle.length >= stopped;
        });
        if (!covered) throw new InvalidJsonRecordError();
      }
    }
    regions.push(
      ...lines.filter(
        (line) => !regions.some((region) => region.start < line.end && line.start < region.end),
      ),
    );
    return regions.sort((a, b) => a.start - b.start);
  };
  const syntax = (source: string, parsed?: { value: unknown }) => {
    let valueCount = 0;
    const values = (value: unknown): unknown => {
      if (matchesJsonValue(value, needles)) {
        valueCount++;
        return marker;
      }
      if (Array.isArray(value)) return value.map(values);
      if (value && typeof value === "object")
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, values(v)]));
      return value;
    };
    if (parsed) {
      const changed = values(parsed.value);
      if (valueCount) source = JSON.stringify(changed) + (source.endsWith("\n") ? "\n" : "");
    }
    let end = 0;
    let count = 0;
    const parts: string[] = [];
    for (const match of source.matchAll(jsonStringTokens)) {
      parts.push(source.slice(end, match.index));
      const value = decoded(parseJson(match[0]) as string);
      parts.push(value.count ? JSON.stringify(value.text) : match[0]);
      count += value.count;
      end = match.index + match[0].length;
    }
    parts.push(source.slice(end));
    const rewritten = parts.join("");
    // Key replacement must remain injective, including in JSON embedded in logs.
    if (parsed) parseJson(rewritten);
    return { text: rewritten, count: count + valueCount };
  };
  const whole = parseRegion(text);
  if (whole) return syntax(text, whole);
  let count = 0;
  let regions = jsonRegions(text);
  // Raw output can contain complete JSON values. Match across their boundaries
  // only with surrounding text or multiple values, preserving JSON delimiters.
  const ranges: { start: number; end: number }[] = [];
  for (const needle of escapedNeedles(needles, longestBackslashRun(text))) {
    for (
      let start = text.indexOf(needle);
      start >= 0;
      start = text.indexOf(needle, start + needle.length)
    ) {
      const end = start + needle.length;
      const overlaps = regions.filter((region) => region.start < end && start < region.end);
      if (
        overlaps.some(
          (region) =>
            region.rawToken &&
            ((start < region.start && region.start < end && end < region.end) ||
              (region.start < start && start < region.end && region.end < end)),
        )
      )
        throw new InvalidJsonRecordError();
      const surrounding = overlaps.length
        ? text.slice(start, overlaps[0]!.start) + text.slice(overlaps.at(-1)!.end, end)
        : "";
      if (
        overlaps.length &&
        overlaps.every((region) => start <= region.start && region.end <= end) &&
        (overlaps.length > 1 ||
          /\S/u.test(surrounding) ||
          overlaps.every((region) => region.rawToken)) &&
        ranges.every((range) => end <= range.start || range.end <= start)
      )
        ranges.push({ start, end });
    }
  }
  if (ranges.length) {
    let end = 0;
    const chunks: string[] = [];
    for (const range of ranges.sort((a, b) => a.start - b.start)) {
      chunks.push(text.slice(end, range.start), marker);
      end = range.end;
    }
    text = chunks.join("") + text.slice(end);
    count = ranges.length;
    regions = jsonRegions(text);
  }
  const parts: string[] = [];
  const raw = (source: string) => {
    const candidates: { start: number; end: number }[] = [];
    for (const needle of escapedNeedles(needles, longestBackslashRun(source))) {
      for (
        let start = source.indexOf(needle);
        start >= 0;
        start = source.indexOf(needle, start + needle.length)
      )
        candidates.push({ start, end: start + needle.length });
    }
    const numbers = new Set(
      needles
        .filter((needle) => jsonNumber.test(needle.trim()))
        .map((needle) => decimalValue(needle.trim())),
    );
    if (numbers.size)
      for (const match of source.matchAll(
        /(^|[^\p{L}\p{N}_.])(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)(?![\p{L}\p{N}_.])/gu,
      )) {
        const value = decimalValue(match[2]!);
        if (value === undefined) throw new LossyJsonNumberError();
        if (value !== undefined && numbers.has(value)) {
          const start = match.index + match[1]!.length;
          candidates.push({ start, end: start + match[2]!.length });
        }
      }
    const chosen: typeof candidates = [];
    for (const candidate of candidates.sort(
      (a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start,
    ))
      if (chosen.every((range) => candidate.end <= range.start || range.end <= candidate.start))
        chosen.push(candidate);
    const chunks: string[] = [];
    let end = 0;
    for (const range of chosen.sort((a, b) => a.start - b.start)) {
      chunks.push(source.slice(end, range.start), marker);
      end = range.end;
    }
    const tokens = syntax(chunks.join("") + source.slice(end));
    parts.push(tokens.text);
    count += chosen.length + tokens.count;
  };
  let end = 0;
  for (const region of regions) {
    raw(text.slice(end, region.start));
    const replaced = syntax(text.slice(region.start, region.end), region);
    parts.push(replaced.text);
    count += replaced.count;
    end = region.end;
  }
  raw(text.slice(end));
  const rewritten = parts.join("");
  // Removing a known literal can expose an unmatched quote that previously paired across outputs.
  if (count) jsonRegions(rewritten);
  return { text: rewritten, count };
}

export function replaceScalarText(text: string, needles: readonly string[], marker: string) {
  requireComparableNumbers(needles);
  if (needles.includes(text)) return { text: marker, count: 1 };
  if (jsonNumber.test(text.trim())) {
    const replaced = replaceText(JSON.stringify(text), needles, marker);
    return { text: parseJson(replaced.text) as string, count: replaced.count };
  }
  return replaceText(text, needles, marker);
}

export function replaceValue(value: unknown, needles: readonly string[], marker: string): unknown {
  if (matchesJsonValue(value, needles)) return marker;
  if (typeof value === "string") return replaceScalarText(value, needles, marker).text;
  if (Array.isArray(value)) return value.map((v) => replaceValue(v, needles, marker));
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).map(
      ([k, v]) =>
        [replaceScalarText(k, needles, marker).text, replaceValue(v, needles, marker)] as const,
    );
    if (new Set(entries.map(([key]) => key)).size !== entries.length)
      throw new DuplicateJsonKeyError();
    return Object.fromEntries(entries);
  }
  return value;
}

const outputKeys = new Set([
  "output",
  "result",
  "stdout",
  "stderr",
  "aggregatedOutput",
  "aggregated_output",
]);
const outputWrappers = new Set(["payload", "item", "activity", "data", "tool", "state"]);
export function outputs(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(outputs);
  if (!value || typeof value !== "object") return [];
  const fields = value as Record<string, unknown>;
  return Object.entries(fields).flatMap(([key, v]) =>
    outputKeys.has(key) || (key === "content" && fields.type === "tool_result")
      ? key === "content" && Array.isArray(v)
        ? v.flatMap((block) =>
            block &&
            typeof block === "object" &&
            block.type === "text" &&
            typeof block.text === "string"
              ? [block.text]
              : strings(block),
          )
        : strings(v)
      : outputWrappers.has(key)
        ? outputs(v)
        : [],
  );
}

const identityKeys = new Set([
  "id",
  "activityId",
  "itemId",
  "nativeId",
  "tool_use_id",
  "toolUseId",
  "toolCallId",
  "callId",
  "callID",
  "call_id",
]);
const identityWrappers = new Set([
  "nativeItemRef",
  "payload",
  "item",
  "activity",
  "data",
  "tool",
  "state",
]);
export function identifies(value: unknown, id: string): boolean {
  if (Array.isArray(value)) return value.some((v) => identifies(v, id));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, v]) =>
      (identityKeys.has(key) && v === id) || (identityWrappers.has(key) && identifies(v, id)),
  );
}

const providerIdKeys = new Set([
  "toolCallId",
  "tool_use_id",
  "toolUseId",
  "callId",
  "callID",
  "call_id",
]);
export function providerItemIds(value: unknown): string[] {
  if (Array.isArray(value)) return [...new Set(value.flatMap(providerItemIds))];
  if (!value || typeof value !== "object") return [];
  const fields = value as Record<string, unknown>;
  const native = fields.nativeItemRef;
  const result: string[] = [];
  if (
    native &&
    typeof native === "object" &&
    "nativeId" in native &&
    typeof native.nativeId === "string"
  )
    result.push(native.nativeId);
  for (const [key, v] of Object.entries(fields)) {
    if (providerIdKeys.has(key) && typeof v === "string" && v) result.push(v);
    else if (identityWrappers.has(key) && v && typeof v === "object" && key !== "nativeItemRef")
      result.push(...providerItemIds(v));
  }
  return [...new Set(result)];
}

const structuralKey = (key: string) =>
  /^(?:id|type|status|kind|role|toolName|name|driver|provider|provider_name|adapter_key|runtimeMode|interactionMode|tone|_tag)$|(?:Id|_id|At|_at)$/.test(
    key,
  );
const outputData = (fields: Record<string, unknown>, key: string) =>
  outputKeys.has(key) ||
  (key === "content" && fields.type === "tool_result" && !Array.isArray(fields.content)) ||
  (key === "text" && fields.type === "text");
export function structuralCollision(value: unknown, needles: readonly string[]): boolean {
  if (Array.isArray(value)) return value.some((v) => structuralCollision(v, needles));
  if (!value || typeof value !== "object") return false;
  const fields = value as Record<string, unknown>;
  return Object.entries(fields).some(
    ([key, v]) =>
      (structuralKey(key) &&
        typeof v === "string" &&
        replaceScalarText(v, needles, "[collision]").count > 0) ||
      (!outputData(fields, key) && structuralCollision(v, needles)),
  );
}
export function sameStructure(before: unknown, after: unknown): boolean {
  if (Array.isArray(before))
    return (
      Array.isArray(after) &&
      before.length === after.length &&
      before.every((v, i) => sameStructure(v, after[i]))
    );
  if (!before || typeof before !== "object")
    return before === null ? after === null : typeof before === typeof after;
  if (!after || typeof after !== "object") return false;
  const original = before as Record<string, unknown>;
  const fields = after as Record<string, unknown>;
  return Object.entries(original).every(([key, v]) =>
    !Object.hasOwn(fields, key)
      ? false
      : structuralKey(key) && !/(?:At|_at)$/.test(key)
        ? equalJson(fields[key], v)
        : !outputData(original, key)
          ? sameStructure(v, fields[key])
          : true,
  );
}
