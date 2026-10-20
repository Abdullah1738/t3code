// @effect-diagnostics nodeBuiltinImport:off - the client under test is plain Node by design.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";

// @ts-expect-error plain ESM module without declarations
import { ControlApiError, ControlClient, discoverConfig } from "./client.mjs";

let server: NodeHttp.Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

const listen = (handler: Parameters<typeof NodeHttp.createServer>[1]) =>
  new Promise<string>((resolve) => {
    server = NodeHttp.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server!.address();
      resolve(`http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`);
    });
  });

describe("discoverConfig", () => {
  it("reads a chmod 600 token file and rejects a readable one", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ctl-"));
    const file = NodePath.join(dir, "ardud-control.json");
    NodeFS.writeFileSync(file, JSON.stringify({ url: "http://127.0.0.1:1/", token: "abc" }));
    NodeFS.chmodSync(file, 0o600);
    expect(discoverConfig({ tokenFile: file })).toEqual({
      url: "http://127.0.0.1:1",
      token: "abc",
    });
    NodeFS.chmodSync(file, 0o644);
    expect(() => discoverConfig({ tokenFile: file })).toThrow(/chmod 600/);
  });

  it("skips token files that do not exist and uses the next one", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ctl-"));
    const file = NodePath.join(dir, "next.json");
    NodeFS.writeFileSync(file, JSON.stringify({ url: "http://127.0.0.1:2", token: "next" }), {
      mode: 0o600,
    });
    const previous = process.env.T3_CONTROL_TOKEN_FILE;
    process.env.T3_CONTROL_TOKEN_FILE = file;
    try {
      expect(
        discoverConfig({ tokenFile: NodePath.join(dir, "missing.json"), component: "x" }),
      ).toEqual({ url: "http://127.0.0.1:2", token: "next" });
    } finally {
      if (previous === undefined) delete process.env.T3_CONTROL_TOKEN_FILE;
      else process.env.T3_CONTROL_TOKEN_FILE = previous;
    }
  });
});

describe("ControlClient", () => {
  it("sends the bearer token and surfaces API errors", async () => {
    const url = await listen((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.headers.authorization !== "Bearer t0k") {
        response.statusCode = 401;
        response.end(JSON.stringify({ ok: false, error: { code: "unauthorized", message: "no" } }));
        return;
      }
      response.end(JSON.stringify({ ok: true, threads: [], total: 0, path: request.url }));
    });
    const client = new ControlClient({ url, token: "t0k" });
    const result = await client.listThreads({ origin: "imessage", active: true });
    expect(result.path).toBe("/api/ardud/control/threads?origin=imessage&active=true");
    const bad = new ControlClient({ url, token: "wrong" });
    await expect(bad.projects()).rejects.toBeInstanceOf(ControlApiError);
  });

  it("parses SSE frames and resumes with Last-Event-ID", async () => {
    const seen: Array<string | undefined> = [];
    const url = await listen((request, response) => {
      seen.push(request.headers["last-event-id"] as string | undefined);
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (seen.length === 1) {
        response.write('retry: 3000\nid: 5\nevent: ready\ndata: {"type":"ready"}\n\n');
        response.write(": ping\n\n");
        response.write(
          'id: 6\nevent: thread.status\ndata: {"type":"thread.status","threadId":"t"}\n\n',
        );
        response.end();
        return;
      }
      response.write(
        'id: 9\nevent: message.completed\ndata: {"type":"message.completed","text":"hi"}\n\n',
      );
    });
    const client = new ControlClient({ url, token: "t" });
    const controller = new AbortController();
    const events: Array<{ type: string; sequence: number }> = [];
    for await (const event of client.events({ signal: controller.signal })) {
      events.push(event);
      if (events.length === 2) controller.abort();
    }
    expect(events).toEqual([
      { type: "thread.status", threadId: "t", sequence: 6 },
      { type: "message.completed", text: "hi", sequence: 9 },
    ]);
    expect(seen).toEqual([undefined, "6"]);
  });
});
