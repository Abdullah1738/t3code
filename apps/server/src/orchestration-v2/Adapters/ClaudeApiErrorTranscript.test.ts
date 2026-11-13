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
  { status: null, formatted: "Connection refused (ECONNREFUSED)" },
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
      assert.equal(result?.status, error.status ?? undefined);
      assert.isUndefined(
        yield* readLastApiError({ ...input, since: Date.parse("2026-11-08T11:00:00Z") }),
      );
      assert.isUndefined(
        yield* readLastApiError({ ...input, filePath: path.join(directory, "missing.jsonl") }),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each([
  { name: "real response", message: { model: "claude-haiku-5-5" }, clears: true },
  {
    name: "null error on real response",
    message: { model: "claude-haiku-5-5" },
    error: null,
    clears: true,
  },
  { name: "synthetic response", message: { model: "<synthetic>" }, clears: false },
  {
    name: "model error",
    message: { model: "claude-haiku-5-5" },
    error: "model_not_found",
    clears: false,
  },
  {
    name: "API error message",
    message: { model: "claude-haiku-5-5" },
    isApiErrorMessage: true,
    clears: false,
  },
  {
    name: "sidechain response",
    message: { model: "claude-haiku-5-5" },
    isSidechain: true,
    clears: false,
  },
  {
    name: "nested response",
    message: { model: "claude-haiku-5-5" },
    parent_tool_use_id: "tool",
    clears: false,
  },
  { name: "empty model", message: { model: "" }, clears: false },
  { name: "missing model", message: {}, clears: false },
])("invalidates recovered transcript errors only after a $name", (response) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const configDir = yield* fs.makeTempDirectoryScoped();
      const projectDir = path.join(configDir, "projects", "-tmp-project");
      yield* fs.makeDirectory(projectDir, { recursive: true });
      const filePath = path.join(projectDir, "session.jsonl");
      const earlier = {
        type: "system",
        subtype: "api_error",
        timestamp: "2026-11-08T10:00:01Z",
        error: { status: 502, formatted: "502 old timeout" },
      };
      const success = { ...response, type: "assistant", timestamp: "2026-11-08T10:00:02Z" };
      const input = {
        configDir,
        filePath,
        sessionId: "session",
        since: Date.parse("2026-11-08T10:00:00Z"),
      };
      yield* fs.writeFileString(
        filePath,
        [earlier, success].map((record) => JSON.stringify(record)).join("\n") + "\n",
      );
      assert.equal((yield* readLastApiError(input))?.status, response.clears ? undefined : 502);
      yield* fs.writeFileString(
        filePath,
        [
          earlier,
          success,
          {
            ...earlier,
            timestamp: "2026-11-08T10:00:03Z",
            error: { status: 401, formatted: "401 current auth failure" },
          },
        ]
          .map((record) => JSON.stringify(record))
          .join("\n") + "\n",
      );
      assert.equal((yield* readLastApiError(input))?.status, 401);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
