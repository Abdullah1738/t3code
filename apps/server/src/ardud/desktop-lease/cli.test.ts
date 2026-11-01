import * as ChildProcess from "node:child_process";
import * as Http from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../control/t3ctl.mjs", import.meta.url));
let server: Http.Server;
let url = "";
let received: Array<{ path: string | undefined; body: unknown }> = [];

beforeAll(async () => {
  server = Http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString();
      received.push({ path: req.url, body: text ? JSON.parse(text) : null });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ lease: null, queue: [] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("No local test port");
  url = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => await new Promise<void>((resolve, reject) =>
  server.close((error) => error ? reject(error) : resolve())));

const run = (identity: Record<string, string | undefined>, ...args: string[]) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const proc = ChildProcess.spawn(process.execPath, [cli, ...args], {
      env: {
        ...process.env,
        CODEX_THREAD_ID: undefined,
        OPENCODE_SESSION_ID: undefined,
        ...identity,
        T3_CONTROL_URL: url,
        T3_CONTROL_TOKEN: "fake-test-token",
      },
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    proc.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
  });

describe("t3ctl desktop-lease", () => {
  it("uses the Codex native identity for acquire", async () => {
    received = [];
    const result = await run({ CODEX_THREAD_ID: "native-codex", OPENCODE_SESSION_ID: "ses-old" },
      "desktop-lease", "acquire", "--task", "task", "--scope", "fixture", "--mode", "native");
    expect(result.code).toBe(0);
    expect(received).toEqual([{
      path: "/api/ardud/control/desktop-lease/acquire",
      body: { driver: "codex", nativeId: "native-codex", taskId: "task", scope: "fixture", mode: "native" },
    }]);
  });

  it("uses explicit caller flags and falls back to OpenCode", async () => {
    received = [];
    expect((await run({ OPENCODE_SESSION_ID: "ses-root" }, "desktop-lease", "heartbeat", "--ticket", "t")).code).toBe(0);
    expect((await run({ CODEX_THREAD_ID: "another" }, "desktop-lease", "release", "--ticket", "t",
      "--driver", "claudeAgent", "--native-id", "claude", "--agent-id", "child")).code).toBe(0);
    expect(received.map((entry) => entry.body)).toEqual([
      { driver: "opencode", nativeId: "ses-root", ticket: "t" },
      { driver: "claudeAgent", nativeId: "claude", agentId: "child", ticket: "t" },
    ]);
  });

  it("refuses missing or partially specified caller identities without sending a request", async () => {
    received = [];
    const args = ["desktop-lease", "acquire", "--task", "t", "--scope", "fixture", "--mode", "native"];
    const missing = await run({}, ...args);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("no caller identity");
    const partial = await run({ CODEX_THREAD_ID: "other" }, ...args, "--driver", "codex");
    expect(partial.code).toBe(2);
    expect(partial.stderr).toContain("no caller identity");
    expect(received).toEqual([]);
  });

  it("reconciles without a caller and rejects removed actions", async () => {
    received = [];
    expect((await run({}, "desktop-lease", "reconcile", "--ticket", "t", "--evidence", "cleared")).code).toBe(0);
    expect(received).toEqual([{ path: "/api/ardud/control/desktop-lease/reconcile", body: { ticket: "t", evidence: "cleared" } }]);
    expect((await run({}, "desktop-lease", "call-start")).code).toBe(2);
    expect(received).toHaveLength(1);
  });
});
