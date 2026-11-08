import * as Effect from "effect/Effect";
import type { RpcServer } from "effect/rpc";
import { jsonExceedsBudget, MAX_REPLY_BYTES, REPLY_TOO_LARGE } from "./replyBudget.ts";
import type { LargeReplyRecorder } from "../../observability/LargeReplyLog.ts";

/** Reject before encoding and interrupt the real request, including its ACK wait and subscriptions. */
export const withReplyBudget = (
  protocol: RpcServer.Protocol["Service"],
  log: LargeReplyRecorder,
  allowedMethods: ReadonlySet<string> = new Set(),
): RpcServer.Protocol["Service"] => {
  let receive: Parameters<RpcServer.Protocol["Service"]["run"]>[0];
  const methods = new Map<string, string>();
  return {
    ...protocol,
    run: (write) => {
      receive = write;
      return protocol.run((clientId, message) => {
        if (message._tag === "Request" && allowedMethods.has(message.tag)) methods.set(`${clientId}:${message.id}`, message.tag);
        return write(clientId, message);
      });
    },
    send: (clientId, response, transferables) =>
      Effect.suspend(() => {
        if (response._tag !== "Chunk" && response._tag !== "Exit")
          return protocol.send(clientId, response, transferables);
        const key = `${clientId}:${response.requestId}`;
        const name = methods.get(key) ?? "unknown";
        if (response._tag === "Exit") methods.delete(key);
        if (!jsonExceedsBudget(response)) return protocol.send(clientId, response, transferables);
        try {
          log.record({ kind: "ws", name, bytes: MAX_REPLY_BYTES + 1, rejected: true });
        } catch {
          /* Diagnostics cannot bypass the cap. */
        }
        const rejected = protocol.send(clientId, {
          _tag: "Exit",
          requestId: response.requestId,
          exit: {
            _tag: "Failure",
            cause: [{ _tag: "Die", defect: { _tag: "ReplyTooLarge", message: REPLY_TOO_LARGE } }],
          },
        });
        return response._tag === "Chunk"
          ? rejected.pipe(
              Effect.andThen(() =>
                receive(clientId, { _tag: "Interrupt", requestId: response.requestId }),
              ),
            )
          : rejected;
      }),
  };
};
