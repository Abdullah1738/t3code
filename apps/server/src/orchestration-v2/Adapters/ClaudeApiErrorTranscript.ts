import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { readContainedWorkflowFile } from "../workflowFileRead.ts";

const errorLine = Schema.Struct({
  type: Schema.Literal("system"),
  subtype: Schema.Literal("api_error"),
  timestamp: Schema.String,
  error: Schema.Struct({
    status: Schema.optional(Schema.NullOr(Schema.Number)),
    formatted: Schema.optional(Schema.String),
    message: Schema.optional(Schema.String),
    connection: Schema.optional(
      Schema.NullOr(Schema.Struct({ code: Schema.optional(Schema.String) })),
    ),
    isNetworkDown: Schema.optional(Schema.NullOr(Schema.Boolean)),
    noResponse: Schema.optional(Schema.NullOr(Schema.Boolean)),
  }),
  retryAttempt: Schema.optional(Schema.Number),
  maxRetries: Schema.optional(Schema.Number),
  retryInMs: Schema.optional(Schema.Number),
  source: Schema.optional(Schema.String),
});
const assistantLine = Schema.Struct({
  type: Schema.Literal("assistant"),
  timestamp: Schema.String,
  error: Schema.optional(Schema.NullOr(Schema.String)),
  isApiErrorMessage: Schema.optional(Schema.Boolean),
  isSidechain: Schema.optional(Schema.Boolean),
  parent_tool_use_id: Schema.optional(Schema.NullOr(Schema.String)),
  message: Schema.Struct({ model: Schema.String }),
});
const decodeLine = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Union([errorLine, assistantLine])),
);

export const ApiErrorReadObserver = Context.Reference<Effect.Effect<void>>(
  "t3/orchestration/ClaudeApiErrorReadObserver",
  { defaultValue: () => Effect.void },
);

// Claude's SDK omits the system/api_error transcript record and can replace it
// with a synthetic model_not_found. Keep live and terminal reads bounded.
export const readLastApiError = Effect.fn("ClaudeApiErrorTranscript.readLastApiError")(
  function* (input: {
    readonly configDir: string;
    readonly filePath: string;
    readonly sessionId: string;
    readonly since: number;
  }) {
    if (!/^[a-zA-Z0-9_-]+$/.test(input.sessionId)) return undefined;
    const observeRead = yield* ApiErrorReadObserver;
    yield* observeRead;
    const transcript = yield* readContainedWorkflowFile({
      path: input.filePath,
      configDir: input.configDir,
      extension: ".jsonl",
      byteCap: 256 * 1024,
      tail: true,
    }).pipe(Effect.option);
    if (Option.isNone(transcript)) return undefined;
    for (const line of transcript.value.contents.split("\n").toReversed()) {
      const decoded = decodeLine(line);
      if (Option.isSome(decoded) && Date.parse(decoded.value.timestamp) >= input.since) {
        const record = decoded.value;
        if (record.type === "system")
          return {
            timestamp: Date.parse(record.timestamp),
            formatted: record.error.formatted ?? record.error.message ?? "Claude API unknown.",
            message: record.error.message,
            connectionCode: record.error.connection?.code,
            isNetworkDown: record.error.isNetworkDown,
            noResponse: record.error.noResponse,
            retryAttempt: record.retryAttempt,
            maxRetries: record.maxRetries,
            retryInMs: record.retryInMs,
            source: record.source,
            ...(record.error.status == null ? {} : { status: record.error.status }),
          };
        // A real response makes earlier API failures obsolete; synthetic and nested frames do not.
        if (
          record.error == null &&
          record.isApiErrorMessage !== true &&
          record.isSidechain !== true &&
          record.parent_tool_use_id == null &&
          record.message.model.trim() !== "" &&
          record.message.model !== "<synthetic>"
        )
          return undefined;
      }
    }
    return undefined;
  },
);

export type ApiErrorCause = {
  readonly status?: number;
  readonly formatted: string;
  readonly connectionCode?: string | undefined;
  readonly isNetworkDown?: boolean | null | undefined;
  readonly noResponse?: boolean | null | undefined;
};

export function isPermanentApiError(error: ApiErrorCause, hadSuccessfulResponse = false): boolean {
  const upstream404 = error.status === 404 && hadSuccessfulResponse;
  return (
    (error.status !== undefined && error.status >= 400 && error.status < 500 && !upstream404) ||
    /\b(401|403|429)\b|authentication|invalid.api.key|quota|usage.limit/i.test(error.formatted) ||
    (!upstream404 && /model.not.found/i.test(error.formatted))
  );
}

export function isTransientApiError(error: ApiErrorCause, hadSuccessfulResponse = false): boolean {
  return (
    !isPermanentApiError(error, hadSuccessfulResponse) &&
    ((error.status !== undefined && error.status >= 500 && error.status < 600) ||
      (error.status === 404 && hadSuccessfulResponse) ||
      isNetworkApiError(error))
  );
}

export function isNetworkApiError(error: ApiErrorCause): boolean {
  if (isPermanentApiError(error)) return false;
  return (
    ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ENOTFOUND"].includes(
      error.connectionCode ?? "",
    ) ||
    error.isNetworkDown === true ||
    error.noResponse === true ||
    /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND|request timed out|(?:no|before any) HTTP response|upstream connection lost|502.*(?:connect|fetch).*timeout/i.test(
      error.formatted,
    )
  );
}
