import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { readContainedWorkflowFile } from "../workflowFileRead.ts";

const errorLine = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.Literal("system"),
    subtype: Schema.Literal("api_error"),
    timestamp: Schema.String,
    error: Schema.Struct({
      status: Schema.optional(Schema.Number),
      formatted: Schema.String,
    }),
  }),
);
const decodeLine = Schema.decodeUnknownOption(errorLine);

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
        return decoded.value.error;
      }
    }
    return undefined;
  },
);
