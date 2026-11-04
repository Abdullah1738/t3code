import { describe, expect, it } from "@effect/vitest";
import { RpcSerialization } from "effect/rpc";

import * as WsReplySerialization from "./WsReplySerialization.ts";

describe("WebSocket reply serialization", () => {
  it("records UTF-8 bytes without encoding a response twice", () => {
    const payload = { _tag: "Exit", body: "🔒".repeat(300_000), token: "private" };
    const original = RpcSerialization.json.makeUnsafe().encode(payload)!;
    let encodes = 0;
    const entries: unknown[] = [];
    const wrapped = WsReplySerialization.wrap(
      RpcSerialization.RpcSerialization.of({
        ...RpcSerialization.json,
        makeUnsafe: () => ({
          decode: () => [],
          encode: () => {
            encodes += 1;
            return original;
          },
        }),
      }),
      { record: (entry) => entries.push(entry) },
    );
    expect(wrapped.makeUnsafe().encode(payload)).toBe(original);
    expect(encodes).toBe(1);
    expect(entries).toEqual([{ kind: "ws", name: "Exit", bytes: Buffer.byteLength(original) }]);
  });

  it("returns the identical byte array when the logger throws", () => {
    const original = new Uint8Array(1024 * 1024);
    const wrapped = WsReplySerialization.wrap(
      RpcSerialization.RpcSerialization.of({
        ...RpcSerialization.json,
        makeUnsafe: () => ({ decode: () => [], encode: () => original }),
      }),
      {
        record: () => {
          throw new Error("logging failure");
        },
      },
    );
    expect(wrapped.makeUnsafe().encode({ _tag: "Exit" })).toBe(original);
  });

  it("attributes chunks and exits to the request without exposing arbitrary tags", () => {
    const entries: unknown[] = [];
    const parser = WsReplySerialization.wrap(
      RpcSerialization.json,
      { record: (entry) => entries.push(entry) },
      new Set(["board.get"]),
    ).makeUnsafe();
    parser.decode(
      JSON.stringify({
        _tag: "Request",
        id: "1",
        tag: "board.get",
        payload: { secret: "argument" },
      }),
    );
    parser.decode(JSON.stringify({ _tag: "Request", id: "2", tag: "secret-token", payload: {} }));
    const value = "x".repeat(1024 * 1024);
    const chunk = parser.encode({ _tag: "Chunk", requestId: "1", values: [value] });
    const exit = parser.encode({ _tag: "Exit", requestId: "1", exit: value });
    const unknown = parser.encode({ _tag: "Exit", requestId: "2", exit: value });
    expect(entries).toEqual([
      { kind: "ws", name: "board.get", bytes: Buffer.byteLength(chunk!) },
      { kind: "ws", name: "board.get", bytes: Buffer.byteLength(exit!) },
      { kind: "ws", name: "Exit", bytes: Buffer.byteLength(unknown!) },
    ]);
  });

  it("carries the request's thread and discussion ids, not its payload", () => {
    const entries: unknown[] = [];
    const parser = WsReplySerialization.wrap(
      RpcSerialization.json,
      { record: (entry) => entries.push(entry) },
      new Set(["discussion.get"]),
    ).makeUnsafe();
    parser.decode(
      JSON.stringify({
        _tag: "Request",
        id: "7",
        tag: "discussion.get",
        payload: { threadId: "thread-1", discussionId: "disc-1", body: "private" },
      }),
    );
    const small = parser.encode({ _tag: "Chunk", requestId: "7", values: ["small"] });
    const exit = parser.encode({ _tag: "Exit", requestId: "7", exit: "y".repeat(1024 * 1024) });
    expect(small).toBeDefined();
    expect(entries).toEqual([
      {
        kind: "ws",
        name: "discussion.get",
        bytes: Buffer.byteLength(exit!),
        threadId: "thread-1",
        discussionId: "disc-1",
      },
    ]);
  });
});
