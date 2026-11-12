import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import type * as SchemaIssue from "effect/SchemaIssue";

const CodexAppServerRequestOperation = Schema.Literals([
  "decode-payload",
  "encode-payload",
  "handle-request",
  "receive-response",
]);
type CodexAppServerRequestOperation = typeof CodexAppServerRequestOperation.Type;

const CodexAppServerSchemaIssueKind = Schema.Literals([
  "Filter",
  "Encoding",
  "Pointer",
  "Composite",
  "AnyOf",
  "InvalidType",
  "InvalidValue",
  "MissingKey",
  "UnexpectedKey",
  "Forbidden",
  "OneOf",
]);
type CodexAppServerSchemaIssueKind = typeof CodexAppServerSchemaIssueKind.Type;

interface CodexAppServerSchemaIssueDiagnostics {
  readonly issueCount: number;
  readonly issueKinds: ReadonlyArray<CodexAppServerSchemaIssueKind>;
  readonly maximumPathDepth: number;
}

const schemaIssueDiagnostics = (root: SchemaIssue.Issue): CodexAppServerSchemaIssueDiagnostics => {
  let issueCount = 0;
  let maximumPathDepth = 0;
  const issueKinds = new Set<CodexAppServerSchemaIssueKind>();

  const visit = (issue: SchemaIssue.Issue, pathDepth: number): void => {
    issueCount += 1;
    issueKinds.add(issue._tag);
    maximumPathDepth = Math.max(maximumPathDepth, pathDepth);
    switch (issue._tag) {
      case "Filter":
      case "Encoding":
        visit(issue.issue, pathDepth);
        break;
      case "Pointer":
        visit(issue.issue, pathDepth + issue.path.length);
        break;
      case "Composite":
      case "AnyOf":
        for (const child of issue.issues) visit(child, pathDepth);
        break;
    }
  };

  visit(root, 0);
  return {
    issueCount,
    issueKinds: [...issueKinds],
    maximumPathDepth,
  };
};

const CodexAppServerPayloadKind = Schema.Literals([
  "null",
  "array",
  "string",
  "number",
  "boolean",
  "bigint",
  "object",
  "symbol",
  "function",
  "undefined",
]);
type CodexAppServerPayloadKind = typeof CodexAppServerPayloadKind.Type;

const payloadKind = (payload: unknown): CodexAppServerPayloadKind => {
  if (payload === null) return "null";
  if (Array.isArray(payload)) return "array";
  return typeof payload;
};

const protocolMessageFields = ["id", "method", "params", "result", "error"] as const;

const CodexAppServerProtocolMessageField = Schema.Literals(protocolMessageFields);

export interface CodexAppServerRequestDiagnostics {
  readonly method?: string;
  readonly requestId?: string;
  readonly operation?: CodexAppServerRequestOperation;
  readonly cause?: unknown;
  readonly issueCount?: number;
  readonly issueKinds?: ReadonlyArray<CodexAppServerSchemaIssueKind>;
  readonly maximumPathDepth?: number;
  readonly payloadKind?: CodexAppServerPayloadKind;
}

export const CodexAppServerProtocolParseOperation = Schema.Literals([
  "encode-wire-message",
  "decode-wire-message",
  "route-wire-message",
  "decode-notification-payload",
  "decode-request-payload",
  "decode-response-payload",
]);
export type CodexAppServerProtocolParseOperation = typeof CodexAppServerProtocolParseOperation.Type;

export const CodexAppServerTransportOperation = Schema.Literals([
  "read-input-stream",
  "read-process-exit-status",
]);
export type CodexAppServerTransportOperation = typeof CodexAppServerTransportOperation.Type;

export const CodexAppServerIdentifierPurpose = Schema.Literals([
  "provider-event",
  "command-approval-request",
  "file-change-approval-request",
  "mcp-elicitation-request",
  "app-permission-approval-request",
  "user-input-request",
]);
export type CodexAppServerIdentifierPurpose = typeof CodexAppServerIdentifierPurpose.Type;

export interface CodexAppServerProtocolErrorShape {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export class CodexAppServerSpawnError extends Schema.TaggedError<CodexAppServerSpawnError>()(
  "CodexAppServerSpawnError",
  {
    command: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return this.command
      ? `Failed to spawn Codex App Server process for command: ${this.command}`
      : "Failed to spawn Codex App Server process";
  }
}

export class CodexAppServerProcessExitedError extends Schema.TaggedError<CodexAppServerProcessExitedError>()(
  "CodexAppServerProcessExitedError",
  {
    code: Schema.optional(Schema.Number),
    pid: Schema.optionalKey(Schema.Int),
    /** Bounded, redacted tail of the process's stderr; never the whole stream. */
    stderrTail: Schema.optionalKey(Schema.String),
    /** When the exit was observed (ISO); anchors reset times Codex prints without a year. */
    exitedAt: Schema.optionalKey(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    const process = this.pid === undefined ? "process" : `process ${this.pid}`;
    const base =
      this.code === undefined
        ? `Codex App Server ${process} exited`
        : `Codex App Server ${process} exited with code ${this.code}`;
    if (this.stderrTail === undefined) return base;
    const line = lastMeaningfulStderrLine(this.stderrTail);
    return line === undefined ? `${base} (no stderr output)` : `${base}: ${line}`;
  }

  /**
   * Set when Codex's last words were its usage-limit notice; failure
   * classification reads it to report a usage limit with its reset time.
   */
  get providerUsageLimit(): { readonly resetAt: string | null } | undefined {
    const line =
      this.stderrTail === undefined ? undefined : lastMeaningfulStderrLine(this.stderrTail);
    if (line === undefined || !USAGE_LIMIT_PATTERN.test(line)) return undefined;
    return {
      resetAt: codexUsageLimitResetAt(line, this.exitedAt, DateTime.zoneMakeLocal()),
    };
  }
}

const USAGE_LIMIT_PATTERN =
  /you(?:'|’)ve hit your usage limit|usage limit (?:reached|exceeded)|\busageLimitExceeded\b/i;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const RESET_PATTERN =
  /try again (?:at|after) (?:([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:(\d{4}),?\s+)?)?(\d{1,2}):(\d{2})\s*([ap])?\.?m?\b/i;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Reads the reset time from Codex's usage-limit notice, e.g. "try again at
 * Nov 16th, 2026 9:47 AM", "Nov 16th 9:47 AM" or "9:47 AM". Codex prints wall
 * time in `timeZone`; a missing year or date is taken from `exitedAt`, rolling
 * forward when that lands in the past. Null when it cannot be determined.
 */
export function codexUsageLimitResetAt(
  line: string,
  exitedAt: string | undefined,
  timeZone: DateTime.TimeZone,
): string | null {
  const match = RESET_PATTERN.exec(line);
  if (match === null) return null;
  const [, monthName, dayText, yearText, hourText, minuteText, meridiem] = match;
  const minute = Number(minuteText);
  let hour = Number(hourText);
  if (minute > 59 || hour > 23) return null;
  if (meridiem !== undefined) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem.toLowerCase() === "p" ? 12 : 0);
  }
  const month = monthName === undefined ? undefined : MONTHS.indexOf(monthName.toLowerCase()) + 1;
  if (month === 0) return null;
  const day = dayText === undefined ? undefined : Number(dayText);
  const exitedMs = exitedAt === undefined ? Number.NaN : Date.parse(exitedAt);
  const exited = Number.isFinite(exitedMs)
    ? DateTime.toParts(DateTime.makeZonedUnsafe(exitedMs, { timeZone }))
    : undefined;
  if (yearText === undefined && exited === undefined) return null;

  const wallTime = (year: number, monthOfYear: number, dayOfMonth: number): number | null => {
    const zoned = DateTime.makeZoned(
      { year, month: monthOfYear, day: dayOfMonth, hour, minute, second: 0, millisecond: 0 },
      { timeZone, adjustForTimeZone: true },
    );
    if (zoned._tag === "None") return null;
    const parts = DateTime.toParts(zoned.value);
    // Reject dates that roll over, like Feb 31st.
    return parts.month === monthOfYear && parts.day === dayOfMonth
      ? DateTime.toEpochMillis(zoned.value)
      : null;
  };

  let resetMs: number | null;
  if (month !== undefined && day !== undefined) {
    if (yearText !== undefined) {
      resetMs = wallTime(Number(yearText), month, day);
    } else {
      resetMs = wallTime(exited!.year, month, day);
      // "Jan 2nd" seen on Dec 30th means next year; allow a day of clock skew.
      if (resetMs !== null && resetMs < exitedMs - DAY_MS) {
        resetMs = wallTime(exited!.year + 1, month, day);
      }
    }
  } else {
    resetMs = wallTime(exited!.year, exited!.month, exited!.day);
    if (resetMs !== null && resetMs < exitedMs) {
      // The next local calendar day, not +24 h, so DST changes keep the wall time.
      const next = DateTime.toPartsUtc(
        DateTime.add(
          DateTime.makeUnsafe({ year: exited!.year, month: exited!.month, day: exited!.day }),
          { days: 1 },
        ),
      );
      resetMs = wallTime(next.year, next.month, next.day);
    }
  }
  return resetMs === null ? null : DateTime.formatIso(DateTime.makeUnsafe(resetMs));
}

const MAX_STDERR_LINE_CHARS = 300;
// oxlint-disable-next-line no-control-regex -- strips terminal color codes from stderr
const ANSI_ESCAPE_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function lastMeaningfulStderrLine(tail: string): string | undefined {
  const lines = tail.replace(ANSI_ESCAPE_PATTERN, "").split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (line.length === 0) continue;
    return line.length <= MAX_STDERR_LINE_CHARS
      ? line
      : `${line.slice(0, MAX_STDERR_LINE_CHARS - 1)}…`;
  }
  return undefined;
}

export class CodexAppServerProtocolParseError extends Schema.TaggedError<CodexAppServerProtocolParseError>()(
  "CodexAppServerProtocolParseError",
  {
    operation: CodexAppServerProtocolParseOperation,
    method: Schema.optionalKey(Schema.String),
    requestId: Schema.optionalKey(Schema.String),
    payloadKind: Schema.optionalKey(CodexAppServerPayloadKind),
    presentFields: Schema.optionalKey(Schema.Array(CodexAppServerProtocolMessageField)),
    issueCount: Schema.optionalKey(Schema.Number),
    issueKinds: Schema.optionalKey(Schema.Array(CodexAppServerSchemaIssueKind)),
    maximumPathDepth: Schema.optionalKey(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    const method = this.method === undefined ? "" : ` for method '${this.method}'`;
    return `Codex App Server protocol operation '${this.operation}' failed${method}.`;
  }

  static fromSchemaError(
    operation: CodexAppServerProtocolParseOperation,
    cause: Schema.SchemaError,
    context: { readonly method?: string; readonly requestId?: string } = {},
  ) {
    return new CodexAppServerProtocolParseError({
      operation,
      ...context,
      ...schemaIssueDiagnostics(cause.issue),
      cause,
    });
  }

  static fromRequestError(
    operation: CodexAppServerProtocolParseOperation,
    method: string,
    cause: CodexAppServerRequestError,
  ) {
    return new CodexAppServerProtocolParseError({
      operation,
      method,
      ...(cause.issueCount === undefined ? {} : { issueCount: cause.issueCount }),
      ...(cause.issueKinds === undefined ? {} : { issueKinds: cause.issueKinds }),
      ...(cause.maximumPathDepth === undefined ? {} : { maximumPathDepth: cause.maximumPathDepth }),
      cause,
    });
  }

  static fromUnroutableMessage(message: unknown) {
    const diagnostics = { payloadKind: payloadKind(message) };
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      return new CodexAppServerProtocolParseError({
        operation: "route-wire-message",
        ...diagnostics,
      });
    }

    const presentFields = protocolMessageFields.filter((field) => field in message);
    const method =
      "method" in message && typeof message.method === "string" ? message.method : undefined;
    const requestId =
      "id" in message && (typeof message.id === "string" || typeof message.id === "number")
        ? String(message.id)
        : undefined;
    return new CodexAppServerProtocolParseError({
      operation: "route-wire-message",
      ...diagnostics,
      presentFields,
      ...(method === undefined ? {} : { method }),
      ...(requestId === undefined ? {} : { requestId }),
    });
  }
}

export class CodexAppServerTransportError extends Schema.TaggedError<CodexAppServerTransportError>()(
  "CodexAppServerTransportError",
  {
    operation: CodexAppServerTransportOperation,
    pid: Schema.optionalKey(Schema.Int),
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Codex App Server transport operation '${this.operation}' failed.`;
  }
}

export class CodexAppServerIdentifierGenerationError extends Schema.TaggedError<CodexAppServerIdentifierGenerationError>()(
  "CodexAppServerIdentifierGenerationError",
  {
    purpose: CodexAppServerIdentifierPurpose,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Failed to generate Codex App Server identifier for ${this.purpose}.`;
  }
}

export class CodexAppServerInputStreamEndedError extends Schema.TaggedError<CodexAppServerInputStreamEndedError>()(
  "CodexAppServerInputStreamEndedError",
  {},
) {
  override get message() {
    return "Codex App Server input stream ended.";
  }
}

export class CodexAppServerRequestError extends Schema.TaggedError<CodexAppServerRequestError>()(
  "CodexAppServerRequestError",
  {
    code: Schema.Number,
    errorMessage: Schema.String,
    data: Schema.optional(Schema.Unknown),
    method: Schema.optionalKey(Schema.String),
    requestId: Schema.optionalKey(Schema.String),
    operation: Schema.optionalKey(CodexAppServerRequestOperation),
    issueCount: Schema.optionalKey(Schema.Number),
    issueKinds: Schema.optionalKey(Schema.Array(CodexAppServerSchemaIssueKind)),
    maximumPathDepth: Schema.optionalKey(Schema.Number),
    payloadKind: Schema.optionalKey(CodexAppServerPayloadKind),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message() {
    return this.errorMessage;
  }

  static fromProtocolError(
    error: CodexAppServerProtocolErrorShape,
    method: string,
    requestId: string,
  ) {
    return new CodexAppServerRequestError({
      code: error.code,
      errorMessage: error.message,
      ...(error.data !== undefined ? { data: error.data } : {}),
      method,
      requestId,
      operation: "receive-response",
      cause: error,
    });
  }

  static fromAppServerError(error: CodexAppServerError, method: string) {
    if (error._tag === "CodexAppServerRequestError") {
      return error;
    }
    return CodexAppServerRequestError.internalError(
      `Codex App Server request handler failed for method '${method}'`,
      undefined,
      {
        method,
        operation: "handle-request",
        cause: error,
      },
    );
  }

  static parseError(message = "Parse error", data?: unknown) {
    return new CodexAppServerRequestError({
      code: -32700,
      errorMessage: message,
      ...(data !== undefined ? { data } : {}),
    });
  }

  static invalidRequest(message = "Invalid request", data?: unknown) {
    return new CodexAppServerRequestError({
      code: -32600,
      errorMessage: message,
      ...(data !== undefined ? { data } : {}),
    });
  }

  static methodNotFound(method: string) {
    return new CodexAppServerRequestError({
      code: -32601,
      errorMessage: `Method not found: ${method}`,
    });
  }

  static invalidParams(
    message = "Invalid params",
    data?: unknown,
    diagnostics: CodexAppServerRequestDiagnostics = {},
  ) {
    return new CodexAppServerRequestError({
      code: -32602,
      errorMessage: message,
      ...(data !== undefined ? { data } : {}),
      ...diagnostics,
    });
  }

  static invalidPayload(
    method: string,
    operation: "decode-payload" | "encode-payload",
    cause: Schema.SchemaError,
  ) {
    const diagnostics = schemaIssueDiagnostics(cause.issue);
    return new CodexAppServerRequestError({
      code: -32602,
      errorMessage: `Invalid payload for method '${method}' during '${operation}'`,
      data: diagnostics,
      method,
      operation,
      ...diagnostics,
      cause,
    });
  }

  static unexpectedPayload(
    method: string,
    operation: "decode-payload" | "encode-payload",
    payload: unknown,
  ) {
    const diagnostics = { payloadKind: payloadKind(payload) };
    return new CodexAppServerRequestError({
      code: -32602,
      errorMessage: `Method '${method}' does not accept a payload during '${operation}'`,
      data: diagnostics,
      method,
      operation,
      ...diagnostics,
    });
  }

  static internalError(
    message = "Internal error",
    data?: unknown,
    diagnostics: CodexAppServerRequestDiagnostics = {},
  ) {
    return new CodexAppServerRequestError({
      code: -32603,
      errorMessage: message,
      ...(data !== undefined ? { data } : {}),
      ...diagnostics,
    });
  }

  static overloaded(message = "Server overloaded; retry later.", data?: unknown) {
    return new CodexAppServerRequestError({
      code: -32001,
      errorMessage: message,
      ...(data !== undefined ? { data } : {}),
    });
  }

  toProtocolError(): CodexAppServerProtocolErrorShape {
    return {
      code: this.code,
      message: this.errorMessage,
      ...(this.data !== undefined ? { data: this.data } : {}),
    };
  }
}

export const CodexAppServerError = Schema.Union([
  CodexAppServerRequestError,
  CodexAppServerSpawnError,
  CodexAppServerProcessExitedError,
  CodexAppServerProtocolParseError,
  CodexAppServerTransportError,
  CodexAppServerIdentifierGenerationError,
  CodexAppServerInputStreamEndedError,
]);

export type CodexAppServerError = typeof CodexAppServerError.Type;
