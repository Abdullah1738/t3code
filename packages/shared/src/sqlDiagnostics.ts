import { sha256 } from "@noble/hashes/sha2";

const token =
  /\uFEFF|(?:--[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|(?:[xX]?'(?:''|[^'])*(?:'|$))|(?:"(?:""|[^"])*(?:"|$)|`(?:``|[^`])*(?:`|$)|\[[^\]]*(?:\]|$))|(?:\?(?:\d+)?|[:@$][A-Za-z_0-9$\u0080-\u{10ffff}]+(?:::[A-Za-z_0-9$\u0080-\u{10ffff}]*)*(?:\([^)]*\))?)|(?:\b0[xX][\da-fA-F_]+\b|(?:\b\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?[\d_]+)?)|(?:[A-Za-z_\u0080-\u{10ffff}][A-Za-z_0-9$\u0080-\u{10ffff}]*)|(?:->>|->|>=|<=|<>|!=|==|\|\||<<|>>)|(?:\S)/gu;

/** SQLite tokens, before binding expansion. Comments and values never reach diagnostics. */
export function normalizeSql(sql: string): string {
  // SQLite treats NUL as the end of SQL, even when the supplied text continues.
  const nul = sql.indexOf("\0");
  const input = nul < 0 ? sql : sql.slice(0, nul);
  const tokens: string[] = [];
  let statementStart = 0;
  let pragmaArgument = false;
  let defaultArgument = false;
  let defaultDepth = 0;
  let moduleDepth = 0;
  // Outside SQLite's literal contexts, quotes identify names (DQS expressions are disabled).
  for (const match of input.matchAll(token)) {
    const value = match[0];
    if (value === "\uFEFF" || value.startsWith("--") || value.startsWith("/*")) continue;
    if (moduleDepth > 0) {
      if (value === "(") moduleDepth++;
      if (value === ")" && --moduleDepth === 0) tokens.push(value);
      continue;
    }
    if (value === ";") {
      tokens.push(value);
      statementStart = tokens.length;
      pragmaArgument = false;
      defaultArgument = false;
      defaultDepth = 0;
      moduleDepth = 0;
      continue;
    }
    let header = statementStart;
    if (/^EXPLAIN$/i.test(tokens[header] ?? "")) {
      header++;
      if (/^QUERY$/i.test(tokens[header] ?? "") && /^PLAN$/i.test(tokens[header + 1] ?? ""))
        header += 2;
    }
    const createKind = header + (/^(?:TEMP|TEMPORARY)$/i.test(tokens[header + 1] ?? "") ? 2 : 1);
    // Modules own their argument grammar. Treat it as an opaque value rather than
    // interpreting module strings as SQL identifiers (including FTS tokenizer options).
    if (
      /^CREATE$/i.test(tokens[header] ?? "") &&
      /^VIRTUAL$/i.test(tokens[createKind] ?? "") &&
      /^TABLE$/i.test(tokens[createKind + 1] ?? "") &&
      /^USING$/i.test(tokens.at(-2) ?? "") &&
      value === "("
    ) {
      tokens.push(value, "?");
      moduleDepth = 1;
      continue;
    }
    // ATTACH/DETACH resolve bare identifiers as string-valued filename/schema expressions.
    if (/^(?:ATTACH|DETACH)$/i.test(tokens[header] ?? "")) {
      tokens.push(/^(?:DATABASE|AS|KEY)$/i.test(value) ? value : "?");
      continue;
    }
    if (defaultDepth > 0) {
      if (value === "(") defaultDepth++;
      if (value === ")") defaultDepth--;
      continue;
    }
    if (defaultArgument) {
      if (value === "+" || value === "-") continue;
      tokens.push("?");
      defaultArgument = false;
      if (value === "(") defaultDepth = 1;
      continue;
    }
    const ddl = /^ALTER$/i.test(tokens[header] ?? "")
      ? /^TABLE$/i.test(tokens[header + 1] ?? "")
      : /^CREATE$/i.test(tokens[header] ?? "") &&
        /^TABLE$/i.test(
          tokens[header + (/^(?:TEMP|TEMPORARY)$/i.test(tokens[header + 1] ?? "") ? 2 : 1)] ?? "",
        );
    // SQLite treats bare/quoted DEFAULT terms as values. An expression's entire
    // value is omitted, including nested parentheses, rather than guessing at identifiers.
    if (ddl && /^DEFAULT$/i.test(value)) {
      tokens.push(value);
      defaultArgument = true;
      continue;
    }
    if (/^PRAGMA$/i.test(tokens[header] ?? "") && (value === "=" || value === "(")) {
      pragmaArgument = true;
      tokens.push(value);
      continue;
    }
    if (pragmaArgument && value !== ")") {
      tokens.push("?");
      continue;
    }
    if (/^(?:[xX]?'|[?:@$]|\d|\.\d)/.test(value) || /^(?:TRUE|FALSE|NULL)$/i.test(value)) {
      if (
        /^(?:\d|\.\d)/.test(value) &&
        /^[+-]$/.test(tokens.at(-1) ?? "") &&
        /^(?:=|!=|<>|==|>=|<=|>|<|\(|,|[+*/%&|~-]|<<|>>|->>|->|\|\||SELECT|THEN|ELSE|WHEN|LIMIT|OFFSET|BETWEEN|AND|OR|NOT|CASE|BY|RETURNING|WHERE|HAVING|ON|DISTINCT|ALL|FROM|IS|LIKE|GLOB|REGEXP|MATCH|ESCAPE|ROWS|RANGE|GROUPS)$/i.test(
          tokens.at(-2) ?? "",
        )
      )
        tokens.pop();
      tokens.push("?");
    } else tokens.push(value);
  }
  return tokens.join(" ");
}

/** Locates placeholders without mistaking quoted identifier contents for parameters. */
export function sqlParameterOffsets(normalized: string): ReadonlyArray<number> {
  const offsets: number[] = [];
  for (const match of normalized.matchAll(token)) if (match[0] === "?") offsets.push(match.index);
  return offsets;
}

export function sqlFingerprint(normalized: string): string {
  return Array.from(sha256(new TextEncoder().encode(normalized)).slice(0, 12), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export const SQL_STATEMENT_MAX_BYTES = 16 * 1024;
export const SQL_STATEMENT_MAX_COUNT = 2_000;

/** Owned by the boot's file tracer. Both sets stop growing at the statement cap. */
export function makeSqlDiagnostics() {
  const statements = new Set<string>();
  const plans = new Set<string>();
  return {
    statement(fingerprint: string, normalized: string) {
      if (statements.has(fingerprint) || statements.size >= SQL_STATEMENT_MAX_COUNT) return;
      statements.add(fingerprint);
      // Reserve space for the event envelope and JSON escaping, not just UTF-16 characters.
      let text = normalized;
      while (
        new TextEncoder().encode(JSON.stringify(text)).byteLength >
        SQL_STATEMENT_MAX_BYTES - 512
      )
        text = text.slice(0, Math.floor(text.length * 0.9));
      return {
        "sql.fingerprint": fingerprint,
        "sql.statement": text,
        "sql.statement.truncated": text !== normalized,
      };
    },
    plan(fingerprint: string) {
      if (!statements.has(fingerprint) || plans.has(fingerprint)) return;
      plans.add(fingerprint);
      return {
        "sql.fingerprint": fingerprint,
        "sql.plan.mode": "disposable-copy",
        "sql.plan.status": "required",
      };
    },
  };
}
