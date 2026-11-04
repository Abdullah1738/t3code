// @effect-diagnostics globalDate:off - synchronous transport diagnostics must not depend on an Effect clock.
import { RotatingFileSink } from "@t3tools/shared/logging";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";

export const LARGE_REPLY_BYTES = 1024 * 1024;
const LOG_MAX_BYTES = 5 * 1024 * 1024;

export interface LargeReply {
  readonly kind: "ws" | "mcp";
  readonly name: string;
  readonly bytes: number;
}

export interface LargeReplyRecorder {
  readonly record: (entry: LargeReply) => void;
}

export const make = (filePath: string): LargeReplyRecorder => {
  let sink: RotatingFileSink | undefined;
  try {
    sink = new RotatingFileSink({ filePath, maxBytes: LOG_MAX_BYTES, maxFiles: 1 });
  } catch {
    // Diagnostics must not prevent a server from starting or returning a reply.
  }
  return {
    record: ({ kind, name, bytes }) => {
      try {
        if (bytes < LARGE_REPLY_BYTES || sink === undefined) return;
        sink.write(`${JSON.stringify({ at: new Date().toISOString(), kind, name, bytes })}\n`);
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
    return make(path.join(path.dirname(serverTracePath), "large-replies.ndjson"));
  }),
);
