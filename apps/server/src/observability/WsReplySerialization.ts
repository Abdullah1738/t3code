import { RpcSerialization } from "effect/rpc";

import { LARGE_REPLY_BYTES, type LargeReplyRecorder, utf8BytesIfLarge } from "./LargeReplyLog.ts";
import { jsonExceedsBudget, MAX_REPLY_BYTES, REPLY_TOO_LARGE } from "../ardud/http/replyBudget.ts";

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
      const threadIds = new Map<string | number, string>();
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
                pending.set(message.id, message.tag);
                if (
                  (message.tag === "orchestration.subscribeThread" ||
                    message.tag === "orchestration.getThreadProjection") &&
                  "payload" in message &&
                  typeof message.payload === "object" &&
                  message.payload !== null &&
                  "threadId" in message.payload &&
                  typeof message.payload.threadId === "string"
                ) {
                  threadIds.set(message.id, message.payload.threadId);
                }
              } else if (
                message._tag === "Interrupt" &&
                "requestId" in message &&
                (typeof message.requestId === "string" || typeof message.requestId === "number")
              ) {
                pending.delete(message.requestId);
                threadIds.delete(message.requestId);
              }
            }
          } catch {
            // Tracking is best-effort and must not change the incoming message.
          }
          return messages;
        },
        encode: (response) => {
          if (jsonExceedsBudget(response)) {
            const requestId =
              typeof response === "object" && response !== null && "requestId" in response
                ? response.requestId
                : undefined;
            try {
              log.record({
                kind: "ws",
                name:
                  requestId === undefined
                    ? "unknown"
                    : (pending.get(requestId as string | number) ?? "unknown"),
                ...(threadIds.has(requestId as string | number)
                  ? { threadId: threadIds.get(requestId as string | number) }
                  : {}),
                bytes: MAX_REPLY_BYTES + 1,
                rejected: true,
              });
            } catch {
              /* Diagnostics cannot bypass the cap. */
            }
            if (requestId !== undefined) {
              pending.delete(requestId as string | number);
              threadIds.delete(requestId as string | number);
              throw new Error(REPLY_TOO_LARGE);
            }
            return parser.encode({
              _tag: "Defect",
              defect: { _tag: "ReplyTooLarge", message: REPLY_TOO_LARGE },
            });
          }
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
            const method = requestId === undefined ? undefined : pending.get(requestId);
            const threadId = requestId === undefined ? undefined : threadIds.get(requestId);
            if (tag === "Exit" && requestId !== undefined) {
              pending.delete(requestId);
              threadIds.delete(requestId);
            }
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
                  method ?? (typeof tag === "string" && protocolTags.has(tag) ? tag : "unknown"),
                ...(threadId === undefined ? {} : { threadId }),
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
