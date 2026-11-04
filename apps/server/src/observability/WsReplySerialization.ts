import { RpcSerialization } from "effect/rpc";

import { LARGE_REPLY_BYTES, type LargeReplyRecorder } from "./LargeReplyLog.ts";

const protocolTags = new Set(["Exit", "Chunk", "Defect", "Request", "Pong", "ClientEnd"]);

export const wrap = (
  serialization: RpcSerialization.RpcSerialization["Service"],
  log: LargeReplyRecorder,
  allowedMethods: ReadonlySet<string> = new Set(),
): RpcSerialization.RpcSerialization["Service"] =>
  RpcSerialization.RpcSerialization.of({
    ...serialization,
    makeUnsafe: () => {
      const parser = serialization.makeUnsafe();
      const pending = new Map<string | number, string>();
      return {
        decode: (data) => {
          const messages = parser.decode(data);
          try {
            for (const message of messages) {
              if (typeof message !== "object" || message === null || !("_tag" in message)) continue;
              if (message._tag === "Request" && "id" in message && "tag" in message &&
                (typeof message.id === "string" || typeof message.id === "number") &&
                typeof message.tag === "string" && allowedMethods.has(message.tag)) {
                pending.set(message.id, message.tag);
              } else if (message._tag === "Interrupt" && "requestId" in message &&
                (typeof message.requestId === "string" || typeof message.requestId === "number")) {
                pending.delete(message.requestId);
              }
            }
          } catch {
            // Tracking is best-effort and must not change the incoming message.
          }
          return messages;
        },
        encode: (response) => {
          const encoded = parser.encode(response);
          try {
            const envelope = typeof response === "object" && response !== null ? response : undefined;
            const tag = envelope !== undefined && "_tag" in envelope ? envelope._tag : undefined;
            const requestId = envelope !== undefined && "requestId" in envelope &&
              (typeof envelope.requestId === "string" || typeof envelope.requestId === "number")
              ? envelope.requestId : undefined;
            const method = requestId === undefined ? undefined : pending.get(requestId);
            if (tag === "Exit" && requestId !== undefined) pending.delete(requestId);
            const bytes =
              typeof encoded === "string"
                ? Buffer.byteLength(encoded, "utf8")
                : (encoded?.byteLength ?? 0);
            if (bytes >= LARGE_REPLY_BYTES) {
              log.record({
                kind: "ws",
                name: method ?? (typeof tag === "string" && protocolTags.has(tag) ? tag : "unknown"),
                bytes,
              });
            }
          } catch {
            // A diagnostic failure must not change the serialized response.
          }
          return encoded;
        },
      };
    },
  });
