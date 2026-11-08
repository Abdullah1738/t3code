// @effect-diagnostics globalDate:off - synchronous transport diagnostics must not depend on an Effect clock.
import { RotatingFileSink } from "@t3tools/shared/logging";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as StreamWriteWatch from "./StreamWriteWatch.ts";

export const LARGE_REPLY_BYTES = 1024 * 1024;
const LOG_MAX_BYTES = 5 * 1024 * 1024;

/** Metadata only: never the payload. */
export interface LargeReply {
  readonly kind: "ws" | "mcp" | "http" | "socket" | "pipe" | "tty" | "stream";
  readonly name: string;
  readonly bytes: number;
  readonly rejected?: boolean | undefined;
  readonly threadId?: string | undefined;
  readonly discussionId?: string | undefined;
  /** Call-site frames for raw stream writes, which have no route name. */
  readonly stack?: ReadonlyArray<string> | undefined;
}

export interface LargeReplyRecorder {
  readonly record: (entry: LargeReply) => void;
}

/**
 * UTF-8 size of a string that might be large. A UTF-16 code unit encodes to at
 * most 3 bytes, so the native length scan only runs for strings that can reach
 * the threshold; ordinary replies pay one comparison.
 */
export const utf8BytesIfLarge = (value: string): number | undefined => {
  if (value.length * 3 < LARGE_REPLY_BYTES) return undefined;
  const bytes = Buffer.byteLength(value, "utf8");
  return bytes >= LARGE_REPLY_BYTES ? bytes : undefined;
};

export const make = (filePath: string): LargeReplyRecorder => {
  let sink: RotatingFileSink | undefined;
  try {
    sink = new RotatingFileSink({ filePath, maxBytes: LOG_MAX_BYTES, maxFiles: 1 });
  } catch {
    // Diagnostics must not prevent a server from starting or returning a reply.
  }
  return {
    record: ({ kind, name, bytes, threadId, discussionId, stack, rejected }) => {
      try {
        if (bytes < LARGE_REPLY_BYTES || sink === undefined) return;
        sink.write(
          `${JSON.stringify({ at: new Date().toISOString(), kind, name, bytes, threadId, discussionId, stack, rejected })}\n`,
        );
      } catch {
        // A full disk or a failed rotation must not affect a reply.
      }
    },
  };
};

export class LargeReplyLog extends Context.Service<LargeReplyLog, LargeReplyRecorder>()(
  "t3/observability/LargeReplyLog",
) {}

export const layer = Layer.effect(
  LargeReplyLog,
  Effect.gen(function* () {
    const { serverTracePath } = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const log = make(path.join(path.dirname(serverTracePath), "large-replies.ndjson"));
    yield* Effect.acquireRelease(
      Effect.sync(() => StreamWriteWatch.install(log)),
      (uninstall) => Effect.sync(uninstall),
    );
    return log;
  }),
);
