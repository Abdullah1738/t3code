import { RpcSerialization } from "effect/rpc";

import { LARGE_REPLY_BYTES, type LargeReplyRecorder, utf8BytesIfLarge } from "./LargeReplyLog.ts";

const protocolTags = new Set(["Exit", "Chunk", "Defect", "Request", "Pong", "ClientEnd"]);

interface PendingRequest {
  readonly method: string;
  readonly threadId: string | undefined;
  readonly discussionId: string | undefined;
}

const idField = (payload: unknown, key: "threadId" | "discussionId"): string | undefined => {
  if (typeof payload !== "object" || payload === null || !(key in payload)) return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.length <= 200 ? value : undefined;
};

export const wrap = (
  serialization: RpcSerialization.RpcSerialization["Service"],
  log: LargeReplyRecorder,
  allowedMethods: ReadonlySet<string> = new Set(),
): RpcSerialization.RpcSerialization["Service"] =>
  RpcSerialization.RpcSerialization.of({
    ...serialization,
    makeUnsafe: () => {
      const parser = serialization.makeUnsafe();
      const pending = new Map<string | number, PendingRequest>();
      return {
        decode: (data) => {
          const messages = parser.decode(data);
          try {
            for (const message of messages) {
              if (typeof message !== "object" || message === null || !("_tag" in message)) continue;
              if (
                message._tag === "Request" &&
                "id" in message &&
                "tag" in message &&
                (typeof message.id === "string" || typeof message.id === "number") &&
                typeof message.tag === "string" &&
                allowedMethods.has(message.tag)
              ) {
                const payload = "payload" in message ? message.payload : undefined;
                pending.set(message.id, {
                  method: message.tag,
                  threadId: idField(payload, "threadId"),
                  discussionId: idField(payload, "discussionId"),
                });
              } else if (
                message._tag === "Interrupt" &&
                "requestId" in message &&
                (typeof message.requestId === "string" || typeof message.requestId === "number")
              ) {
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
            const envelope =
              typeof response === "object" && response !== null ? response : undefined;
            const tag = envelope !== undefined && "_tag" in envelope ? envelope._tag : undefined;
            const requestId =
              envelope !== undefined &&
              "requestId" in envelope &&
              (typeof envelope.requestId === "string" || typeof envelope.requestId === "number")
                ? envelope.requestId
                : undefined;
            const request = requestId === undefined ? undefined : pending.get(requestId);
            if (tag === "Exit" && requestId !== undefined) pending.delete(requestId);
            // Size the string the transport is about to send; never re-serialize.
            const bytes =
              typeof encoded === "string"
                ? utf8BytesIfLarge(encoded)
                : encoded !== undefined && encoded.byteLength >= LARGE_REPLY_BYTES
                  ? encoded.byteLength
                  : undefined;
            if (bytes !== undefined) {
              log.record({
                kind: "ws",
                name:
                  request?.method ??
                  (typeof tag === "string" && protocolTags.has(tag) ? tag : "unknown"),
                bytes,
                threadId: request?.threadId,
                discussionId: request?.discussionId,
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
