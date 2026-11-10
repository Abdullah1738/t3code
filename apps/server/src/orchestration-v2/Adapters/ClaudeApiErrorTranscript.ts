import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { readContainedWorkflowFile } from "../workflowFileRead.ts";

const errorLine = Schema.Struct({
  type: Schema.Literal("system"),
  subtype: Schema.Literal("api_error"),
  timestamp: Schema.String,
  error: Schema.Struct({
    status: Schema.optional(Schema.NullOr(Schema.Number)),
    formatted: Schema.String,
  }),
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

// Claude's SDK omits the system/api_error transcript record and can replace it
// with a synthetic model_not_found. Only read the bounded tail on API failure.
export const readLastApiError = Effect.fn("ClaudeApiErrorTranscript.readLastApiError")(
  function* (input: {
    readonly configDir: string;
    readonly filePath: string;
    readonly sessionId: string;
    readonly since: number;
  }) {
    if (!/^[a-zA-Z0-9_-]+$/.test(input.sessionId)) return undefined;
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
            formatted: record.error.formatted,
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
