import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BoxRunner, type Harness } from "../src/runner.ts";
import { claudeHarness } from "../src/claude.ts";
import { HarnessFailure } from "../src/harness-failure.ts";
import { opaqueId } from "../../spectrum-bridge/src/remote-protocol.ts";

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).reverse().forEach(fn => fn()));
function fixture(harness: Harness, io: ConstructorParameters<typeof BoxRunner>[2] = {}) {
  const root = mkdtempSync(join(tmpdir(), "box-authority-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const config = { root, boxId: "bx_test", epoch: "test", token: "t".repeat(32), callbackToken: "c".repeat(32),
    callbackUrl: "http://callback", privateKey: "unused", system: "system" };
  const runner = new BoxRunner(config, harness, { callbackReady: async () => true, fetch: async () => Response.json({ accepted: true }), ...io });
  cleanup.push(() => runner.db.close());
  const request = (path: string, body: unknown) => new Request(`http://box${path}`, { method: "POST", headers: { authorization: `Bearer ${config.token}` }, body: JSON.stringify(body) });
  const lease = () => runner.handle(request("/lease", { boxId: config.boxId, epoch: config.epoch }));
  return { root, runner, request, lease };
}

test.each(["router", "callback"])("slow %s readiness for a minute renews authority without aborting the running turn", async target => {
  let now = 0, healthy = true, began!: () => void, finish!: () => void, signal: AbortSignal | undefined;
  const started = new Promise<void>(resolve => { began = resolve; });
  const completed = new Promise<void>(resolve => { finish = resolve; });
  const probe = async () => { if (!healthy) now += 6000; return healthy; };
  const s = fixture({ run: async input => { signal = input.signal; began(); await completed; return "NO_REPLY"; } }, {
    now: () => now, modelReady: target === "router" ? probe : async () => true,
    callbackReady: target === "callback" ? probe : async () => true,
  });
  await s.lease(); s.runner.enqueue(opaqueId("slow"), { text: "PRIVATE_INPUT" });
  const turn = s.runner.tick(); await started; healthy = false;
  for (let n = 0; n < 10; n++) {
    const response = await s.lease(); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ routerReady: target !== "router", callbackReady: target !== "callback" });
    await s.runner.tick(); expect(signal!.aborted).toBe(false);
  }
  expect(now).toBe(60_000); finish(); await turn;
  expect(s.runner.db.query("SELECT 1 FROM interruptions").get()).toBeNull();
  expect(s.runner.db.query<{ state: string }, []>("SELECT state FROM inbox").get()!.state).toBe("done");
});

test.each(["none", "send", "bus", "react", "files", "builtin", "share", "pending-send", "failed-bus"])("authority expiry retries once only with zero effects: %s", async effect => {
  let now = 0, began!: () => void;
  let started = new Promise<void>(resolve => { began = resolve; });
  const s = fixture({ run: ({ signal }) => new Promise((_resolve, reject) => {
    signal!.addEventListener("abort", () => reject(new Error("PRIVATE_FAILURE")), { once: true }); began();
  }) }, { now: () => now, share: async () => ({ accepted: true }), fetch: async () => {
    if (effect === "pending-send") throw new Error("PRIVATE_AMBIGUOUS");
    return Response.json({ accepted: true }, { status: effect === "failed-bus" ? 403 : 200 });
  } });
  const id = opaqueId(`effect:${effect}`); await s.lease(); s.runner.enqueue(id, { text: "PRIVATE_INPUT" });
  const turn = s.runner.tick(); await started;
  if (effect === "builtin") {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/harness-failure.ts"), "--tool", s.root, id], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    child.stdin.write('{"tool_input":"PRIVATE_TOOL_INPUT"}'); child.stdin.end();
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect([out, err, code]).toEqual(["", "", 0]);
  } else if (effect === "share") {
    expect((await s.runner.handle(s.request("/share", {}))).status).toBe(200);
  } else if (effect !== "none") {
    const action = s.runner.action(opaqueId(effect), effect === "bus" || effect === "failed-bus" ? "/agent-answer" : effect === "pending-send" ? "/send" : `/${effect}`, {});
    if (effect === "pending-send") await expect(action).rejects.toThrow("PRIVATE_AMBIGUOUS"); else await action;
  }
  now = 20_001; await s.runner.tick(); await turn;
  const row = s.runner.db.query<Record<string, unknown>, []>("SELECT * FROM interruptions").get()!;
  expect(row).toMatchObject({ reason: "authority-expired", last_lease_at: 0, retried: Number(effect === "none") });
  expect(row.tool_actions).toBe(effect === "none" ? 0 : 1);
  expect(row.sends).toBe(Number(effect === "send")); expect(row.bus_actions).toBe(Number(effect === "bus"));
  expect(JSON.stringify(row)).not.toContain("PRIVATE_");
  const state = () => s.runner.db.query<{ state: string }, []>("SELECT state FROM inbox").get()!.state;
  expect(state()).toBe(effect === "none" ? "pending" : "interrupted");
  if (effect === "none") {
    started = new Promise<void>(resolve => { began = resolve; }); await s.lease();
    const retry = s.runner.tick(); await started; now += 20_001; await s.runner.tick(); await retry;
    expect(state()).toBe("interrupted");
    expect(s.runner.db.query<{ retried: number }, []>("SELECT retried FROM interruptions").get()!.retried).toBe(0);
  }
});

test("a failed metadata hook blocks tools instead of silently granting replay eligibility", async () => {
  const s = fixture({ run: async () => "NO_REPLY" });
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/harness-failure.ts"), "--tool", s.root, opaqueId("missing")], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).toBe(2); expect(await new Response(child.stdout).text()).toBe(""); expect(await new Response(child.stderr).text()).toBe("");
});

test("harness stderr drains into a bounded private tail and only exit metadata is retained", async () => {
  const s = fixture({ run: async () => "NO_REPLY" }); mkdirSync(join(s.root, "work"));
  const executable = join(s.root, "fake-claude"), keyFile = join(s.root, "key");
  writeFileSync(keyFile, "PRIVATE_KEY", { mode: 0o600 });
  writeFileSync(executable, '#!/bin/sh\ncat >/dev/null\ni=0; while [ "$i" -lt 300 ]; do printf PRIVATE_KEY_PRIVATE_TEXT >&2; i=$((i+1)); done\nexit 7\n', { mode: 0o700 });
  const logs: unknown[] = [];
  const harness = claudeHarness(s.root, executable, "test", { routerKeyFile: keyFile }, (code, detail) => logs.push({ code, detail }));
  await expect(harness.run({ id: opaqueId("stderr"), session: "session", resume: false, text: "private", system: "system" }))
    .rejects.toMatchObject({ detail: { exitCode: 7, stderrBytes: 2048 } });
  expect(logs).toEqual([{ code: "harness-exit", detail: { exitCode: 7, signal: null, stderrBytes: 2048 } }]);
  expect(JSON.stringify(logs)).not.toContain("PRIVATE_");
});


test.each(["disabled", "harness-exit"] as const)("%s with zero actions still fences and retains only child diagnostics", async reason => {
  let began!: () => void, fail!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const detail = { exitCode: 143, signal: "SIGTERM", stderrBytes: 2048 };
  const s = fixture({ run: ({ signal }) => new Promise((_resolve, reject) => {
    fail = () => reject(new HarnessFailure(detail)); signal!.addEventListener("abort", fail); began();
  }) }, { now: () => 1000 });
  await s.lease(); s.runner.enqueue(opaqueId(reason), { text: "PRIVATE_CAUSE" });
  const turn = s.runner.tick(); await started;
  if (reason === "disabled") s.runner.pause(); else fail();
  await turn;
  expect(s.runner.db.query<Record<string, unknown>, []>("SELECT * FROM interruptions").get()).toMatchObject({
    reason, last_lease_at: 1000, exit_code: 143, signal: "SIGTERM", stderr_bytes: 2048, tool_actions: 0, retried: 0,
  });
  expect(s.runner.db.query<{ state: string }, []>("SELECT state FROM inbox").get()!.state).toBe("interrupted");
});

test("the one authority retry marker survives a runner restart", async () => {
  let now = 0, began!: () => void;
  let started = new Promise<void>(resolve => { began = resolve; });
  const harness: Harness = { run: ({ signal }) => new Promise((_resolve, reject) => {
    signal!.addEventListener("abort", () => reject(new HarnessFailure({ exitCode: 143, signal: "SIGTERM", stderrBytes: 0 }))); began();
  }) };
  const s = fixture(harness, { now: () => now }); await s.lease();
  const id = opaqueId("durable-retry"); s.runner.enqueue(id, { text: "PRIVATE_RETRY" });
  const first = s.runner.tick(); await started; now = 20_001; await s.runner.tick(); await first;
  const reopened = new BoxRunner(s.runner.config, harness, { now: () => now, callbackReady: async () => true, fetch: async () => Response.json({}) });
  cleanup.push(() => reopened.db.close());
  await reopened.handle(s.request("/lease", { boxId: "bx_test", epoch: "test" }));
  started = new Promise<void>(resolve => { began = resolve; });
  const second = reopened.tick(); await started; now += 20_001; await reopened.tick(); await second;
  expect(reopened.db.query<{ state: string }, []>("SELECT state FROM inbox").get()!.state).toBe("interrupted");
  expect(reopened.db.query<{ retried: number }, []>("SELECT retried FROM interruptions").get()!.retried).toBe(0);
});

test.each([
  { label: "empty", ids: [] }, { label: "over limit", ids: Array.from({ length: 101 }, () => opaqueId("duplicate")) },
  { label: "short id", ids: ["short"] }, { label: "non-string id", ids: [true] },
])("event lookup validates $label", async ({ ids }) => {
  const s = fixture({ run: async () => "NO_REPLY" }); await s.lease();
  const response = await s.runner.handle(s.request("/events", { ids }));
  expect(response.status).toBe(ids.length === 0 ? 200 : 400);
  if (!ids.length) expect(await response.json()).toEqual({ lookup: true, events: [] });
  for (const extra of [{ after: opaqueId("cursor") }, { headOnly: true }]) {
    expect((await s.runner.handle(s.request("/events", { ids: [], ...extra }))).status).toBe(400);
  }
});

test("Claude's configured PreToolUse hook durably records a built-in attempt before it can run", async () => {
  let harness: Harness;
  const s = fixture({ run: input => harness.run(input) }); mkdirSync(join(s.root, "work"));
  const executable = join(s.root, "fake-hook-claude"), keyFile = join(s.root, "key");
  writeFileSync(keyFile, "PRIVATE_KEY", { mode: 0o600 });
  writeFileSync(executable, `#!${process.execPath}
const { readFileSync } = require("node:fs");
const args = process.argv.slice(2);
const settings = JSON.parse(readFileSync(args[args.indexOf("--settings") + 1], "utf8"));
const hook = settings.hooks.PreToolUse[0];
if (hook.matcher !== "*") process.exit(3);
const child = Bun.spawn(["/bin/sh", "-c", hook.hooks[0].command], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
child.stdin.write('{"tool_name":"Bash","tool_input":"PRIVATE_BUILTIN"}'); child.stdin.end();
const code = await child.exited;
if (code !== 0) process.exit(code);
console.log(JSON.stringify({ result: "NO_REPLY" }));
`, { mode: 0o700 });
  harness = claudeHarness(s.root, executable, "test", { routerKeyFile: keyFile });
  await s.lease(); const id = opaqueId("hook-wiring"); s.runner.enqueue(id, { text: "PRIVATE_INPUT" }); await s.runner.tick();
  expect(s.runner.db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key=?").get(`side-effects:${id}`)?.value).toBe("1");
  expect(s.runner.db.query<{ state: string }, [string]>("SELECT state FROM inbox WHERE id=?").get(id)?.state).toBe("done");
});
