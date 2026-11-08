// @effect-diagnostics nodeBuiltinImport:off - the CLI is exercised in an isolated Node process.
import * as NodeChildProcess from "node:child_process";
import * as NodeHttp from "node:http";
import * as NodeURL from "node:url";
import { assert, it } from "@effect/vitest";

it("harness-cutover plan/run/status send authenticated requests and preserve error exits", async ({
  onTestFinished,
}) => {
  const received: Array<{
    method: string | undefined;
    url: string | undefined;
    body: string;
    authorization: string | undefined;
  }> = [];
  let refusal = false;
  const payload = {
    ok: true,
    cutover: {
      active: true,
      completed: false,
      items: [],
      refusals: [] as Array<{ ref: string; reason: string }>,
    },
  };
  const server = NodeHttp.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    received.push({
      method: request.method,
      url: request.url,
      body,
      authorization: request.headers.authorization,
    });
    response.writeHead(refusal ? 409 : 200, { "content-type": "application/json" });
    response.end(
      JSON.stringify(
        refusal
          ? { ok: false, error: { code: "cutover_refused", message: "Readiness refused." } }
          : payload,
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no address");
  const cli = NodeURL.fileURLToPath(new URL("../control/t3ctl.mjs", import.meta.url));
  const invoke = (action: string) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = NodeChildProcess.spawn(process.execPath, [cli, "harness-cutover", action], {
        env: {
          ...process.env,
          T3_CONTROL_URL: `http://127.0.0.1:${address.port}`,
          T3_CONTROL_TOKEN: "fixture-token",
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  for (const action of ["plan", "run", "status"]) {
    const result = await invoke(action);
    assert.strictEqual(result.code, 0);
    assert.deepStrictEqual(JSON.parse(result.stdout), payload);
    assert.notInclude(result.stdout + result.stderr, "fixture-token");
    assert.deepStrictEqual(received.at(-1), {
      method: action === "run" ? "POST" : "GET",
      url: `/api/ardud/control/harness-cutover/${action}`,
      body: action === "run" ? "{}" : "",
      authorization: "Bearer fixture-token",
    });
  }
  payload.cutover.refusals.push({ ref: "t3-codex", reason: "Required native tools are missing." });
  const blocked = await invoke("run");
  assert.strictEqual(blocked.code, 3);
  assert.include(blocked.stdout, "Required native tools are missing.");
  refusal = true;
  const failed = await invoke("run");
  assert.notStrictEqual(failed.code, 0);
  assert.include(failed.stderr, "Readiness refused.");
  const invalid = await invoke("unknown");
  assert.notStrictEqual(invalid.code, 0);
  assert.include(invalid.stderr, "unknown harness-cutover action unknown");
  assert.strictEqual(received.length, 5);
});
