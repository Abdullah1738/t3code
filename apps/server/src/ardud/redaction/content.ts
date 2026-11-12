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
      if (error instanceof DuplicateJsonKeyError || error instanceof LossyJsonNumberError)
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

/** Decode string tokens before matching so valid alternate JSON escapes share one meaning. */
export function replaceText(
  text: string,
  needles: readonly string[],
  marker: string,
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
      if (
        value !== undefined &&
        needles.some(
          (needle) => jsonNumber.test(needle.trim()) && decimalValue(needle.trim()) === value,
        )
      )
        return { text: marker, count: 1 };
      return plain(source);
    }
    const replaced = replaceText(source, needles, marker);
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
        if (error instanceof DuplicateJsonKeyError || error instanceof LossyJsonNumberError)
          throw error;
        /* This is ordinary text, not another JSON string body. */
      }
    }
    return replaced;
  };
  const syntax = (source: string) => {
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
    // The provider logger's timestamp brackets are framing, not a JSON array.
    const header = source.match(/^\uFEFF?\[[^\]\r\n]+\] (?:NTIVE|CANON|ORCH): /u)?.[0] ?? "";
    let prefix = header;
    let json = source.slice(header.length);
    try {
      parseJson(json);
    } catch (error) {
      if (error instanceof DuplicateJsonKeyError || error instanceof LossyJsonNumberError)
        throw error;
      const first = source.search(/[[{]/);
      if (first >= 0) {
        prefix = source.slice(0, first);
        json = source.slice(first);
      }
    }
    try {
      const changed = values(parseJson(json));
      if (valueCount)
        source = prefix + JSON.stringify(changed) + (source.endsWith("\n") ? "\n" : "");
    } catch (error) {
      if (error instanceof DuplicateJsonKeyError || error instanceof LossyJsonNumberError)
        throw error;
      /* Non-JSON logs still contain independently decodable string tokens. */
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
    return { text: parts.join(""), count: count + valueCount };
  };
  const isJson = (source: string) => {
    try {
      parseJson(source);
      return true;
    } catch (error) {
      if (error instanceof DuplicateJsonKeyError || error instanceof LossyJsonNumberError)
        throw error;
      return false;
    }
  };
  if (isJson(text)) return syntax(text);
  let count = 0;
  const parts: string[] = [];
  let ordinary = "";
  const flush = () => {
    const lines = (ordinary.match(/[^\n]*\n|[^\n]+$/g) ?? []).map(syntax);
    const tokens = {
      text: lines.map((v) => v.text).join(""),
      count: lines.reduce((n, v) => n + v.count, 0),
    };
    const replaced = tokens.count ? tokens : plain(ordinary);
    parts.push(replaced.text);
    count += replaced.count;
    ordinary = "";
  };
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    if (isJson(line)) {
      flush();
      const replaced = syntax(line);
      parts.push(replaced.text);
      count += replaced.count;
    } else ordinary += line;
  }
  flush();
  return { text: parts.join(""), count };
}

export function replaceScalarText(text: string, needles: readonly string[], marker: string) {
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
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        replaceScalarText(k, needles, marker).text,
        replaceValue(v, needles, marker),
      ]),
    );
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
