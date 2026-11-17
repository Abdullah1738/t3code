import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { routerConfig, startRouterGate } from "../src/router-auth.ts";

// The scoped offbox command provides this pinned CLI; ordinary unit tests need only the fake harness.
test.skipIf(!process.env.MONI_TEST_CLAUDE)("native Claude 2.1.322 helper failure cannot send a keyless prompt through the gate", async () => {
  const executable = process.env.MONI_TEST_CLAUDE!;
  const version = Bun.spawn([executable, "--version"], { stdout: "pipe", stderr: "ignore" });
  expect(await new Response(version.stdout).text()).toContain("2.1.322"); expect(await version.exited).toBe(0);
  const root = mkdtempSync(join(tmpdir(), "moni-native-router-")), key = randomUUID(), keyFile = join(root, "key");
  writeFileSync(keyFile, key, { mode: 0o600 }); chmodSync(keyFile, 0o600);
  const requests: (string | null)[] = [];
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    await request.text(); requests.push(request.headers.get("x-api-key"));
    return Response.json({ type: "error", error: { type: "invalid_request_error", message: "offline-probe-stop" } }, { status: 400 });
  } });
  let refused = 0;
  const gate = startRouterGate(routerConfig({ boxRouterPort: upstream.port, routerKeyFile: keyFile }), () => { refused++; });
  async function run(name: string, base: string, helper: string) {
    const dir = join(root, name); mkdirSync(dir, { mode: 0o700 });
    writeFileSync(join(dir, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true }), { mode: 0o600 });
    const settings = join(dir, "settings.json"); writeFileSync(settings, JSON.stringify({ apiKeyHelper: helper, fastMode: false }));
    const child = Bun.spawn([executable, "-p", "--output-format", "json", "--model", "claude-opus-5-5", "--setting-sources", "", "--settings", settings,
      "--tools", "", "--no-session-persistence", "--max-turns", "1"], {
      cwd: dir, env: { PATH: process.env.PATH, HOME: dir, CLAUDE_CONFIG_DIR: dir, ANTHROPIC_BASE_URL: base,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" },
      stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 45_000,
    });
    child.stdin.write("offline-router-probe"); child.stdin.end();
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).not.toBe(0); expect(out + err).not.toContain(key);
    return out + err;
  }
  try {
    await run("valid", gate.url.origin, `cat '${keyFile}'`);
    expect(requests.length).toBeGreaterThan(0); for (const header of requests) expect(header).toBe(key);
    requests.length = 0;
    const output = await run("unguarded", upstream.url.origin, "exit 1");
    const keyless = requests.length;
    for (const header of requests) expect(header?.trim() ?? "").toBe("");
    if (!keyless) expect(output).toMatch(/helper|auth|key/i);
    requests.length = 0;
    await run("guarded", gate.url.origin, "exit 1");
    expect(requests).toEqual([]);
    if (keyless) expect(refused).toBeGreaterThan(0);
    console.log(JSON.stringify({ native: "2.1.322", helperFailureKeylessAttempts: keyless, blockedByGate: refused }));
  } finally { gate.stop(true); upstream.stop(true); rmSync(root, { recursive: true, force: true }); }
}, 150_000);
