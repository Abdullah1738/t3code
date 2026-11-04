// @effect-diagnostics nodeBuiltinImport:off - exercise the on-disk rotation boundary.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import * as LargeReplyLog from "./LargeReplyLog.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

const directories: string[] = [];
const temporaryPath = () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "large-reply-"));
  directories.push(directory);
  return NodePath.join(directory, "large-replies.ndjson");
};

afterEach(() => {
  for (const directory of directories.splice(0)) NodeFS.rmSync(directory, { recursive: true });
});

describe("LargeReplyLog", () => {
  it("ignores replies below the threshold and records only metadata at the threshold", () => {
    const filePath = temporaryPath();
    const log = LargeReplyLog.make(filePath);
    log.record({ kind: "ws", name: "Exit", bytes: LargeReplyLog.LARGE_REPLY_BYTES - 1 });
    expect(NodeFS.existsSync(filePath)).toBe(false);

    const input = {
      kind: "mcp" as const,
      name: "board_get",
      bytes: LargeReplyLog.LARGE_REPLY_BYTES,
      body: "private body text",
      arguments: "private arguments",
    };
    log.record(input);
    const lines = NodeFS.readFileSync(filePath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      at: expect.any(String),
      kind: "mcp",
      name: "board_get",
      bytes: LargeReplyLog.LARGE_REPLY_BYTES,
    });
    expect(lines[0]).not.toContain("private");
  });

  it("rotates a 5 MiB file and replaces the previous backup", () => {
    const filePath = temporaryPath();
    NodeFS.writeFileSync(filePath, "x".repeat(5 * 1024 * 1024));
    NodeFS.writeFileSync(`${filePath}.1`, "old backup");
    const log = LargeReplyLog.make(filePath);
    log.record({ kind: "ws", name: "Exit", bytes: LargeReplyLog.LARGE_REPLY_BYTES });
    expect(NodeFS.statSync(`${filePath}.1`).size).toBe(5 * 1024 * 1024);
    expect(JSON.parse(NodeFS.readFileSync(filePath, "utf8"))).toMatchObject({ name: "Exit" });
    expect(NodeFS.existsSync(`${filePath}.2`)).toBe(false);
  });

  it("does not throw when a write or initialization fails", () => {
    const directory = NodePath.dirname(temporaryPath());
    const log = LargeReplyLog.make(directory);
    expect(() =>
      log.record({ kind: "ws", name: "Exit", bytes: LargeReplyLog.LARGE_REPLY_BYTES }),
    ).not.toThrow();
    expect(() => LargeReplyLog.make("\0").record({ kind: "ws", name: "Exit", bytes: 2e6 })).not.toThrow();
  });

  it.effect("records the real serialized MCP response under the tool's name", () =>
    Effect.scoped(Effect.gen(function* () {
      const entries: LargeReplyLog.LargeReply[] = [];
      const toolkit = Toolkit.make(Tool.make("large_probe", {
        description: "Returns a large test value.",
        success: Schema.Struct({ text: Schema.String }),
      }));
      const serverLayer = McpHttpServer.toolkitRegistration(
        toolkit,
        McpToolAccess.toLayer(toolkit, {
          large_probe: McpToolAccess.reads(() => Effect.succeed({ text: "private".repeat(200_000) })),
        }),
      ).pipe(
        Layer.provideMerge(McpHttpServer.layerMcpTransport),
        Layer.provide(Layer.succeed(LargeReplyLog.LargeReplyLog, { record: (entry) => entries.push(entry) })),
        Layer.provide(Layer.mock(McpSessionRegistry.McpSessionRegistry)({
          resolve: () => Effect.succeed({
            environmentId: EnvironmentId.make("test"),
            requestNamespace: "test",
            thread: {
              threadId: ThreadId.make("test"),
              providerSessionId: "test",
              providerInstanceId: ProviderInstanceId.make("test"),
            },
            client: undefined,
            capabilities: new Set(["orchestration"]),
            issuedAt: 1,
          }),
        })),
      );
      yield* HttpRouter.serve(serverLayer, { disableListenLog: true, disableLogger: true }).pipe(Layer.build);
      const http = yield* HttpClient.HttpClient;
      const headers = { accept: "application/json, text/event-stream", authorization: "Bearer test" };
      const initialized = yield* http.post("/mcp", {
        headers,
        body: HttpBody.text('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}', "application/json"),
      });
      expect(initialized.status).toBe(200);
      const response = yield* http.post("/mcp", {
        headers: { ...headers, "mcp-session-id": initialized.headers["mcp-session-id"]!, "mcp-protocol-version": "2025-06-18" },
        body: HttpBody.text('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"large_probe","arguments":{}}}', "application/json"),
      });
      expect(response.status).toBe(200);
      const body = yield* response.arrayBuffer;
      expect(entries).toEqual([{ kind: "mcp", name: "large_probe", bytes: body.byteLength }]);
    })).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});
