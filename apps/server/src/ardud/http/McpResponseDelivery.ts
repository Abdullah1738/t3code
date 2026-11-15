// @effect-diagnostics nodeBuiltinImport:off -- observes the Node response lifecycle without reading socket data.
import type * as NodeHttp from "node:http";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

type CloseReason = "idle_timeout" | "client_error" | "peer_end" | "socket_error" | "unknown";

export class McpResponseDelivery extends Context.Service<
  McpResponseDelivery,
  {
    readonly settled: Effect.Effect<void>;
    readonly snapshot: () => {
      responseDelivery: "pending" | "finished" | "closed";
      responseElapsedMs: number;
      responseCloseReason?: CloseReason;
    };
    tool?: string;
    callerThreadId?: string;
    closeReason: CloseReason;
  }
>()("t3/ardud/http/McpResponseDelivery") {}

const responses = new WeakMap<object, McpResponseDelivery["Service"]>();

export const forRequest = (source: object) => responses.get(source);

export function observe(
  request: NodeHttp.IncomingMessage,
  response: NodeHttp.ServerResponse,
  dropped: (delivery: McpResponseDelivery["Service"]) => void,
  now = Date.now,
) {
  const startedAt = now();
  const done = Promise.withResolvers<void>();
  let status: "pending" | "finished" | "closed" = "pending";
  let elapsedMs = 0;
  const delivery: McpResponseDelivery["Service"] = {
    settled: Effect.promise(() => done.promise),
    closeReason: "unknown",
    snapshot: () => ({
      responseDelivery: status,
      responseElapsedMs: status === "pending" ? Math.max(0, now() - startedAt) : elapsedMs,
      ...(status === "closed" ? { responseCloseReason: delivery.closeReason } : {}),
    }),
  };
  const settle = (next: "finished" | "closed") => {
    if (status !== "pending") return;
    status = next;
    elapsedMs = Math.max(0, now() - startedAt);
    response.off("finish", finished);
    response.off("close", closed);
    done.resolve();
    if (next === "closed") dropped(delivery);
  };
  // Node's finish means bytes reached the socket, not that the client consumed them.
  const finished = () => settle("finished");
  const closed = () => settle("closed");
  responses.set(request, delivery);
  response.on("finish", finished);
  response.on("close", closed);
  return delivery;
}
