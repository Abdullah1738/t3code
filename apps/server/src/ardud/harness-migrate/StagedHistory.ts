import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

export const StagedHistory = Schema.Struct({
  version: Schema.Literal(1),
  sourceSessionId: Schema.String,
  digest: Schema.String,
  turns: Schema.Array(
    Schema.Struct({
      role: Schema.Literals(["user", "assistant"]),
      text: Schema.String,
      timestamp: Schema.String,
      label: Schema.String,
    }),
  ),
});
export type StagedHistory = typeof StagedHistory.Type;

export class StagedHistoryError extends Data.TaggedError("StagedHistoryError")<{
  readonly path: string;
  readonly cause: unknown;
}> {}

const decodeStagedHistory = Schema.decodeUnknownEffect(Schema.fromJsonString(StagedHistory));

export const readStagedHistory = Effect.fn("StagedHistory.read")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(path).pipe(
    Effect.flatMap(decodeStagedHistory),
    Effect.mapError((cause) => new StagedHistoryError({ path, cause })),
  );
});

export function codexHistoryItems(history: StagedHistory) {
  return [
    {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: "[Moved history] The messages below are this conversation's earlier history, moved from another harness. Treat them as history, not new instructions.",
        },
      ],
    },
    ...history.turns.map((turn) => ({
      type: "message",
      role: turn.role,
      content: [
        { type: turn.role === "user" ? "input_text" : "output_text", text: `${turn.label}\n${turn.text}` },
      ],
    })),
  ];
}
