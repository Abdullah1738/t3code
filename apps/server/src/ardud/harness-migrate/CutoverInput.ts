import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { KanbanCardId, RunId, ThreadId } from "@t3tools/contracts";
import * as ServerConfig from "../../config.ts";

const Input = Schema.Struct({
  version: Schema.Literal(1),
  stoppedCards: Schema.Array(
    Schema.Struct({
      n: Schema.Int,
      stage: Schema.Literals(["working", "in_review"]),
      id: KanbanCardId,
      thread: ThreadId,
    }),
  ),
  interruptedThreads: Schema.Array(Schema.Struct({ threadId: ThreadId, runId: RunId })),
});
export type CutoverInput = typeof Input.Type;

export class CutoverInputError extends Schema.TaggedError<CutoverInputError>()(
  "CutoverInputError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return "Prepare a valid harness-cutover-input.json before cutover.";
  }
}

export class CutoverInputSource extends Context.Service<
  CutoverInputSource,
  {
    readonly read: Effect.Effect<CutoverInput, CutoverInputError>;
    readonly readOptional: Effect.Effect<CutoverInput | null, CutoverInputError>;
  }
>()("t3/ardud/harness-migrate/CutoverInput/CutoverInputSource") {}

export const layer = Layer.effect(
  CutoverInputSource,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Input));
    const file = path.join(config.baseDir, "harness-cutover-input.json");
    const read = fs.readFileString(file).pipe(
      Effect.flatMap(decode),
      Effect.mapError((cause) => new CutoverInputError({ cause })),
    );
    return CutoverInputSource.of({
      read,
      readOptional: fs.exists(file).pipe(
        Effect.mapError((cause) => new CutoverInputError({ cause })),
        Effect.flatMap((exists) => (exists ? read : Effect.succeed(null))),
      ),
    });
  }),
);
