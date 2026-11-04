import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { HttpBody, HttpServerResponse } from "effect/http";

import { LARGE_REPLY_BYTES, type LargeReplyRecorder } from "./LargeReplyLog.ts";

export interface McpReplyCapture {
  name: string | undefined;
  readonly threadId: string | undefined;
}

export const recordResponse = (
  response: HttpServerResponse.HttpServerResponse,
  capture: McpReplyCapture,
  log: LargeReplyRecorder,
): HttpServerResponse.HttpServerResponse => {
  const record = (bytes: number) => {
    try {
      if (capture.name !== undefined && bytes >= LARGE_REPLY_BYTES) {
        log.record({ kind: "mcp", name: capture.name, bytes, threadId: capture.threadId });
      }
    } catch {
      // The response must still go out if diagnostics fail.
    }
  };
  const body = response.body;
  if (body._tag === "Uint8Array") {
    record(body.body.byteLength);
  } else if (body._tag === "Stream") {
    let bytes = 0;
    const measured = body.stream.pipe(
      Stream.map((chunk) => {
        bytes += chunk.byteLength;
        return chunk;
      }),
      Stream.ensuring(Effect.sync(() => record(bytes))),
    );
    return HttpServerResponse.setBody(
      response,
      HttpBody.stream(measured, body.contentType, body.contentLength),
    );
  }
  return response;
};
