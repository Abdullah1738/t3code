// @effect-diagnostics nodeBuiltinImport:off - verify the bytes persisted to the log.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { RpcSerialization } from "effect/rpc";

import * as LargeReplyLog from "./LargeReplyLog.ts";
import * as WsReplySerialization from "./WsReplySerialization.ts";

describe("WebSocket reply serialization", () => {
  it("refuses encoding a giant snapshot as a final transport backstop", () => {
    const entries: unknown[] = [];
    const parser = WsReplySerialization.wrap(
      RpcSerialization.json,
      { record: (entry) => entries.push(entry) },
      new Set(["kanban.subscribe"]),
    ).makeUnsafe();
    parser.decode(
      JSON.stringify({ _tag: "Request", id: "big", tag: "kanban.subscribe", payload: {} }),
    );
    expect(() =>
      parser.encode({
        _tag: "Chunk",
        requestId: "big",
        values: [{ cards: Array(20).fill({ description: "x".repeat(1024 * 1024) }) }],
      }),
    ).toThrow("16 MiB limit");
    expect(entries).toMatchObject([{ kind: "ws", name: "kanban.subscribe", rejected: true }]);
  });
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

  it("never writes unvalidated ID fields or other request and response text to disk", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ws-reply-"));
    const filePath = NodePath.join(directory, "large-replies.ndjson");
    try {
      const parser = WsReplySerialization.wrap(
        RpcSerialization.json,
        LargeReplyLog.make(filePath),
        new Set(["kanban.wiki", "discussion.get"]),
      ).makeUnsafe();
      const payloads = [
        {
          threadId: "secret-thread-argument",
          discussionId: "secret-discussion-argument",
          token: "secret-token",
        },
        { threadId: { value: "secret-nested-thread" }, discussionId: ["secret-nested-discussion"] },
        { threadId: "thread-1", discussionId: "disc-1", body: "secret-body" },
      ];
      const lengths = payloads.map((payload, index) => {
        parser.decode(
          JSON.stringify({
            _tag: "Request",
            id: String(index),
            tag: index === 2 ? "discussion.get" : "kanban.wiki",
            payload,
          }),
        );
        const encoded = parser.encode({
          _tag: "Exit",
          requestId: String(index),
          exit: `secret-response-${"y".repeat(1024 * 1024)}`,
        });
        return Buffer.byteLength(encoded!);
      });
      const text = NodeFS.readFileSync(filePath, "utf8");
      expect(text).not.toContain("secret");
      expect(text).not.toContain("thread-1");
      expect(text).not.toContain("disc-1");
      expect(
        text
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).toEqual(
        lengths.map((bytes, index) => ({
          at: expect.any(String),
          kind: "ws",
          name: index === 2 ? "discussion.get" : "kanban.wiki",
          bytes,
        })),
      );
    } finally {
      NodeFS.rmSync(directory, { recursive: true });
    }
  });
});
