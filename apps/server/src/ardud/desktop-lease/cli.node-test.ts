// @effect-diagnostics nodeBuiltinImport:off - exercises the dependency-free CLI against an isolated fake endpoint.
import * as Assert from "node:assert/strict";
import * as ChildProcess from "node:child_process";
import * as Http from "node:http";
import * as Path from "node:path";
import { after, before, describe, it } from "node:test";

const cli = Path.join(process.cwd(), "apps/server/src/ardud/control/t3ctl.mjs");
let server: Http.Server;
let url = "";
let received: { path: string | undefined; authorization: string | undefined; body: unknown }[] = [];

before(async () => {
  server = Http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString();
      received.push({ path: req.url, authorization: req.headers.authorization, body: text ? JSON.parse(text) : null });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ lease: null, queue: [] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("No local test port");
  url = `http://127.0.0.1:${address.port}`;
});
after(async () => await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())));

const run = (...args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
  const proc = ChildProcess.spawn(process.execPath, [cli, ...args], {
    env: { ...process.env, T3_CONTROL_URL: url, T3_CONTROL_TOKEN: "fake-test-token" },
  });
  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
  proc.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
  proc.on("error", reject);
  proc.on("close", (code) => resolve({ code, stdout, stderr }));
});

describe("t3ctl desktop-lease", () => {
  it("sends acquire and call lifecycle requests with the requested fields", async () => {
    received = [];
    const acquired = await run("desktop-lease", "acquire", "--root-thread", "r", "--child-thread", "c", "--task", "t", "--scope", "fixture", "--mode", "native");
    Assert.equal(acquired.code, 0, acquired.stderr);
    Assert.deepEqual(JSON.parse(acquired.stdout), { lease: null, queue: [] });
    Assert.deepEqual(received[0], {
      path: "/api/ardud/control/desktop-lease/acquire", authorization: "Bearer fake-test-token",
      body: { rootThreadId: "r", childThreadId: "c", taskId: "t", scope: "fixture", mode: "native" },
    });
    const ended = await run("desktop-lease", "call-end", "--ticket", "lease", "--call-id", "call", "--outcome", "uncertain");
    Assert.equal(ended.code, 0, ended.stderr);
    Assert.deepEqual(received[1]?.body, { ticket: "lease", callId: "call", outcome: "uncertain" });
  });

  it("does not send an incomplete or unknown operation", async () => {
    received = [];
    Assert.equal((await run("desktop-lease", "release")).code, 2);
    Assert.equal((await run("desktop-lease", "unknown")).code, 2);
    Assert.deepEqual(received, []);
  });
});
