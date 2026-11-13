import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Rpc, RpcGroup, RpcMessage, RpcSerialization, RpcServer } from "effect/rpc";
import { withReplyBudget } from "./ReplyProtocol.ts";

it.effect("releases a rejected subscription without disconnecting the client socket", () =>
  Effect.gen(function* () {
    const group = RpcGroup.make(
      Rpc.make("orchestration.subscribeThread", {
        payload: { threadId: Schema.String },
        success: Schema.String,
        stream: true,
      }),
    );
    const entries: unknown[] = [];
    const responses = yield* Queue.unbounded<RpcMessage.FromServerEncoded>();
    const receive = yield* Deferred.make<Parameters<RpcServer.Protocol["Service"]["run"]>[0]>();
    const finalized = yield* Deferred.make<void>();
    const protocol = yield* RpcServer.Protocol.make((write) =>
      Effect.gen(function* () {
        yield* Deferred.succeed(receive, write);
        const serialization = yield* RpcSerialization.RpcSerialization;
        return {
          disconnects: yield* Queue.unbounded<number>(),
          send: (_clientId, response) => Queue.offer(responses, response),
          end: () => Effect.void,
          clientIds: Effect.succeed(new Set([0])),
          initialMessage: Effect.succeedNone,
          supportsAck: true,
          supportsTransferables: false,
          supportsSpanPropagation: false,
          supportsNotifications: true,
          codecFor: serialization.codecFor,
        };
      }),
    );
    yield* RpcServer.make(group).pipe(
      Effect.provide(
        group.toLayerHandler("orchestration.subscribeThread", () =>
          Stream.concat(Stream.make("x".repeat(20 * 1024 * 1024)), Stream.never).pipe(
            Stream.ensuring(Deferred.succeed(finalized, undefined)),
          ),
        ),
      ),
      Effect.provideService(
        RpcServer.Protocol,
        withReplyBudget(
          protocol,
          { record: (entry) => entries.push(entry) },
          new Set(["orchestration.subscribeThread"]),
        ),
      ),
      Effect.forkScoped,
    );
    yield* (yield* Deferred.await(receive))(0, {
      _tag: "Request",
      id: "1",
      tag: "orchestration.subscribeThread",
      payload: { threadId: "thread:long" },
      headers: [],
    });
    const reply = yield* Queue.take(responses);
    expect(reply._tag).toBe("Exit");
    expect(JSON.stringify(reply)).toContain("16 MiB limit");
    expect(entries).toMatchObject([
      { name: "orchestration.subscribeThread", threadId: "thread:long", rejected: true },
    ]);
    yield* Deferred.await(finalized);
    yield* (yield* Deferred.await(receive))(0, {
      _tag: "Request",
      id: "2",
      tag: "orchestration.subscribeThread",
      payload: { threadId: "thread:long" },
      headers: [],
    });
    let next = yield* Queue.take(responses);
    while (!(next._tag === "Exit" && next.requestId === "2")) next = yield* Queue.take(responses);
    expect(JSON.stringify(next)).toContain("16 MiB limit");
  }).pipe(Effect.provide(RpcSerialization.layerJson), Effect.scoped),
);
