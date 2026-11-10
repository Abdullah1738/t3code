import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { readLastApiError } from "./ClaudeApiErrorTranscript.ts";

it.effect.each([
  { status: 401, formatted: "401 authentication_error: Invalid authentication credentials" },
  { status: 502, formatted: "502 fetch connect timeout" },
  { status: 502, formatted: "502 ERR_HTTP2_STREAM_ERROR: NGHTTP2_ENHANCE_YOUR_CALM" },
  { status: undefined, formatted: "Connection dropped (ECONNRESET)" },
])("recovers the original API cause before synthetic model_not_found: $formatted", (error) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const configDir = yield* fs.makeTempDirectoryScoped();
      const directory = path.join(configDir, "projects", "-tmp-project");
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(
        path.join(directory, "session.jsonl"),
        [
          JSON.stringify({
            type: "system",
            subtype: "api_error",
            timestamp: "2026-11-08T10:55:33Z",
            error,
          }),
          JSON.stringify({
            type: "assistant",
            error: "model_not_found",
            timestamp: "2026-11-08T10:55:34Z",
          }),
          "",
        ].join("\n"),
      );
      const input = {
        configDir,
        filePath: path.join(directory, "session.jsonl"),
        sessionId: "session",
        since: Date.parse("2026-11-08T10:00:00Z"),
      };
      const result = yield* readLastApiError(input);
      assert.equal(result?.formatted, error.formatted);
      assert.equal(result?.status, error.status);
      assert.isUndefined(
        yield* readLastApiError({ ...input, since: Date.parse("2026-11-08T11:00:00Z") }),
      );
      assert.isUndefined(
        yield* readLastApiError({ ...input, filePath: path.join(directory, "missing.jsonl") }),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
