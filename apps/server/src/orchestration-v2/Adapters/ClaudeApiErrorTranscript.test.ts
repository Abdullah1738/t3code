import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  readLastApiError,
  isNetworkApiError,
  isTransientApiError,
} from "./ClaudeApiErrorTranscript.ts";

it.effect.each([
  { status: 401, formatted: "401 authentication_error: Invalid authentication credentials" },
  { status: 502, formatted: "502 fetch connect timeout" },
  { status: 502, formatted: "502 ERR_HTTP2_STREAM_ERROR: NGHTTP2_ENHANCE_YOUR_CALM" },
  { status: undefined, formatted: "Connection dropped (ECONNRESET)" },
  { status: null, formatted: "Connection refused (ECONNREFUSED)" },
  { message: "Request timed out.", connection: null, isNetworkDown: false, noResponse: null },
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
      assert.equal(result?.formatted, "formatted" in error ? error.formatted : error.message);
      assert.equal(result?.status, ("status" in error ? error.status : undefined) ?? undefined);
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

it.each([
  ...["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ENOTFOUND"].map((connectionCode) => ({
    formatted: "Connection failed",
    connectionCode,
    expected: true,
  })),
  { formatted: "Request timed out.", expected: true },
  { formatted: "Connection error before any HTTP response.", expected: true },
  { formatted: "Claude API no HTTP response: unknown.", expected: true },
  { formatted: "upstream connection lost", expected: true },
  { formatted: "502 fetch connect timeout", expected: true },
  { formatted: "No response", noResponse: true, expected: true },
  { formatted: "Network down", isNetworkDown: true, expected: true },
  ...[400, 401, 403, 404, 429].map((status) => ({
    status,
    formatted: "Connection dropped (ECONNRESET)",
    expected: false,
  })),
  { formatted: "authentication failed ECONNRESET", expected: false },
  { formatted: "usage limit reached ECONNRESET", expected: false },
  { formatted: "usage limit reached; no HTTP response", expected: false },
  { formatted: "quota exceeded ECONNRESET", expected: false },
  { formatted: "Unknown error", expected: false },
])("classifies the native network cause $formatted", (input) => {
  assert.equal(isNetworkApiError(input), input.expected);
});

it.each([false, true])("allows native upstream 404 only after a response: %s", (successful) => {
  for (const formatted of ["HTTP 404", "404 model_not_found", "404 model not found"])
    assert.equal(isTransientApiError({ status: 404, formatted }, successful), successful);
  for (const status of [400, 401, 403, 413, 429])
    assert.isFalse(isTransientApiError({ status, formatted: "HTTP error" }, successful));
  for (const formatted of [
    "401 authentication failed",
    "403 forbidden",
    "429 rate limit",
    "usage limit reached",
    "invalid API key",
  ])
    assert.isFalse(isTransientApiError({ status: 404, formatted }, successful));
});
