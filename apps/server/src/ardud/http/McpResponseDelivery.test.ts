// @effect-diagnostics nodeBuiltinImport:off -- loopback lifecycle tests use no live server or wall-clock waits.
import * as NodeHttp from "node:http";
import { describe, expect, it } from "vite-plus/test";
import { makeHttpSocketTelemetry, type SocketRecord } from "./HttpSocketTelemetry.ts";
import * as McpResponseDelivery from "./McpResponseDelivery.ts";

async function heldRequest() {
  const records: Array<{ name: string; fields: SocketRecord }> = [];
  const server = makeHttpSocketTelemetry((name, fields) =>
    records.push({ name, fields }),
  ).instrument(NodeHttp.createServer());
  const entered = Promise.withResolvers<{
    request: NodeHttp.IncomingMessage;
    response: NodeHttp.ServerResponse;
  }>();
  server.on("request", (request, response) => {
    request.resume();
    request.once("end", () => entered.resolve({ request, response }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected loopback listener");
  const client = NodeHttp.request({
    host: "127.0.0.1",
    port: address.port,
    path: "/mcp?codemode=false",
    method: "POST",
    agent: false,
  });
  const result = new Promise<string>((resolve) => {
    client.on("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "error"));
    client.on("response", (response) => {
      let text = "";
      response.on("data", (chunk) => {
        text += chunk;
      });
      response.on("end", () => resolve(text));
    });
  });
  client.end("{}");
  const { request, response } = await entered.promise;
  const delivery = McpResponseDelivery.forRequest(request)!;
  return {
    server,
    client,
    request,
    response,
    delivery,
    records,
    result,
    close: async () => {
      client.destroy();
      request.socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("MCP response delivery", () => {
  it("does not destroy a fully read request whose handler is still running", async () => {
    const t = await heldRequest();
    try {
      const bytes = t.request.socket.bytesRead;
      t.server.emit("timeout", t.request.socket);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(t.request.socket.bytesRead).toBe(bytes);
      expect(t.request.socket.destroyed).toBe(false);
      expect(t.delivery.snapshot().responseDelivery).toBe("pending");
      t.response.end("saved");
      expect(await t.result).toBe("saved");
      expect(t.delivery.snapshot().responseDelivery).toBe("finished");
      expect(t.records.filter((r) => r.name.endsWith("mcpResponseDropped"))).toEqual([]);
    } finally {
      await t.close();
    }
  });

  it("records a client disconnect before the handler writes its saved result", async () => {
    const t = await heldRequest();
    try {
      t.delivery.tool = "subtask_done";
      const closed = new Promise<void>((resolve) => t.response.once("close", resolve));
      t.client.destroy();
      await closed;
      expect(t.delivery.snapshot()).toMatchObject({
        responseDelivery: "closed",
        responseCloseReason: "peer_end",
      });
      t.response.end("saved");
      expect(t.delivery.snapshot().responseDelivery).toBe("closed");
      expect(t.records.filter((r) => r.name.endsWith("mcpResponseDropped"))).toMatchObject([
        {
          fields: {
            tool: "subtask_done",
            responseDelivery: "closed",
            responseCloseReason: "peer_end",
            activeRequests: 1,
          },
        },
      ]);
    } finally {
      await t.close();
    }
  });
});
