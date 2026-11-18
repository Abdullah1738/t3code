import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { claudeHarness } from "../src/claude.ts";
import { routerConfig, routerReady, ROUTER_KEY_ERROR } from "../src/router-auth.ts";
import { BoxRunner } from "../src/runner.ts";
import { opaqueId } from "../../spectrum-bridge/src/remote-protocol.ts";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { startRouterGate } from "../src/router-auth.ts";

const clean: (() => void)[] = [];
afterEach(() => clean.splice(0).reverse().forEach(fn => fn()));
function root() { const path = mkdtempSync(join(tmpdir(), "box-router-auth-")); clean.push(() => rmSync(path, { recursive: true, force: true })); mkdirSync(join(path, "work")); return path; }
function contents(dir: string, skip: string): string {
  return readdirSync(dir).filter(name => join(dir, name) !== skip).map(name => { const path = join(dir, name); return lstatSync(path).isDirectory() ? contents(path, skip) : readFileSync(path).toString(); }).join("");
}

test("Claude sends through the configured loopback router with a helper; secret never enters argv, env, logs or settings", async () => {
  const dir = root(), keyFile = join(dir, "key 'quoted"), key = randomUUID(); writeFileSync(keyFile, key, { mode: 0o600 });
  let authenticated = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async req => { authenticated = req.headers.get("x-api-key") === key && (await req.text()).includes("turn"); return Response.json({ ok: true }); } });
  clean.push(() => { server.stop(true); });
  const fake = join(dir, "fake-claude");
  writeFileSync(fake, `#!${process.execPath}\nimport {writeFileSync,readFileSync} from 'node:fs';
const args=process.argv.slice(2);writeFileSync('trace.json',JSON.stringify({args,env:process.env}));
const settings=JSON.parse(readFileSync(args[args.indexOf('--settings')+1],'utf8'));
const child=Bun.spawn(['/bin/sh','-c',settings.apiKeyHelper],{stdout:'pipe',stderr:'pipe'});
const key=await new Response(child.stdout).text();if(await child.exited!==0||!key)process.exit(1);
await fetch(process.env.ANTHROPIC_BASE_URL+'/v1/messages',{method:'POST',headers:{'x-api-key':key},body:await new Response(Bun.stdin.stream()).text()});
console.log(JSON.stringify({result:'answer'}));\n`, { mode: 0o700 });
  const names = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "RCLAUDE_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "ANTHROPIC_DEFAULT_OPUS_MODEL"];
  const saved = new Map(names.map(name => [name, process.env[name]]));
  const parentSecret = randomUUID(); for (const name of names) process.env[name] = parentSecret;
  const logs: string[] = [];
  try {
    const harness = claudeHarness(dir, fake, "claude-opus-5-5", { boxRouterPort: server.port, routerKeyFile: keyFile }, code => logs.push(code));
    expect(await harness.run({ id: opaqueId("turn"), session: "session", resume: true, text: "turn", system: "system" })).toBe("answer");
  } finally { for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } }
  expect(authenticated).toBe(true);
  const trace = JSON.parse(readFileSync(join(dir, "work/trace.json"), "utf8"));
  expect(trace.env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(trace.env.ANTHROPIC_BASE_URL).not.toBe(`http://127.0.0.1:${server.port}`);
  for (const name of names.filter(name => name !== "ANTHROPIC_BASE_URL")) expect(trace.env[name]).toBeUndefined();
  expect(trace.args).toContain("--setting-sources"); expect(trace.args[trace.args.indexOf("--setting-sources") + 1]).toBe("");
  expect(trace.args).toContain("--resume"); expect(trace.args).toContain("session");
  expect(contents(dir, keyFile) + logs.join()).not.toContain(key); expect(contents(dir, keyFile)).not.toContain(parentSecret);
  const settings = JSON.parse(readFileSync(join(dir, "claude/router-settings.json"), "utf8")); expect(settings.fastMode).toBe(false); expect(settings.apiKeyHelper).toContain("9router-key-helper");
});

test.each([
  ["before-helper", "remove"], ["before-helper", "empty"], ["before-helper", "mode"],
  ["after-helper", "remove"], ["after-helper", "empty"], ["after-helper", "mode"], ["after-helper", "rotate"],
])("%s %s never forwards a prompt after preflight", async (phase, failure) => {
  let forwarded = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { forwarded++; return Response.json({ ok: true }); } });
  clean.push(() => { server.stop(true); });
    const dir = root(), keyFile = join(dir, "key"), fake = join(dir, "fake");
    writeFileSync(keyFile, randomUUID(), { mode: 0o600 });
    const invalidate = failure === "remove" ? "unlinkSync(keyFile)" : failure === "mode" ? "chmodSync(keyFile,0o644)" : `writeFileSync(keyFile,${JSON.stringify(failure === "empty" ? "" : "replacement")})`;
    writeFileSync(fake, `#!${process.execPath}\nimport {chmodSync,readFileSync,unlinkSync,writeFileSync} from 'node:fs';
const keyFile=${JSON.stringify(keyFile)}, args=process.argv.slice(2);
const settings=JSON.parse(readFileSync(args[args.indexOf('--settings')+1],'utf8'));
${phase === "before-helper" ? invalidate : ""};
const helper=Bun.spawn(['/bin/sh','-c',settings.apiKeyHelper],{stdout:'pipe',stderr:'ignore'});
let key=await new Response(helper.stdout).text();if(await helper.exited!==0)key=' ';
${phase === "after-helper" ? invalidate : ""};
const response=await fetch(process.env.ANTHROPIC_BASE_URL+'/v1/messages',{method:'POST',headers:{'x-api-key':key},body:await new Response(Bun.stdin.stream()).text()});
writeFileSync('status',String(response.status));process.exit(response.ok?0:1);\n`, { mode: 0o700 });
    const logs: string[] = [], harness = claudeHarness(dir, fake, "claude-opus-5-5", { boxRouterPort: server.port, routerKeyFile: keyFile }, code => logs.push(code));
    expect(harness.ready!()).toBe(true);
    await expect(harness.run({ id: opaqueId("race"), session: "session", resume: false, text: "privacy-canary", system: "system" })).rejects.toThrow("Harness failed");
    expect(["401", "503"]).toContain(readFileSync(join(dir, "work/status"), "utf8"));
    expect(logs).toEqual([ROUTER_KEY_ERROR, "harness-exit"]); expect(forwarded).toBe(0);
});

test("lease reports router readiness separately while admission waits for the HTTP round trip", async () => {
  const dir = root(); let healthy = false, calls = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req => {
    expect(new URL(req.url).pathname).toBe("/livez"); expect(req.headers.get("x-api-key")).toBeNull();
    return Response.json({ ready: healthy, reason: "not_ready" }, { status: healthy ? 200 : 503 });
  } }); clean.push(() => { server.stop(true); }); const port = server.port;
  const config = { root: dir, boxId: "bx_test", epoch: "test", token: "t".repeat(32), callbackToken: "c".repeat(32), callbackUrl: "http://box", privateKey: "unused", system: "system" };
  const runner = new BoxRunner(config, { run: async () => { calls++; return "NO_REPLY"; } }, {
    modelReady: () => routerReady(routerConfig({ boxLivezPort: port })), callbackReady: async () => true,
    fetch: async () => Response.json({ accepted: true }),
  }); clean.push(() => runner.db.close());
  const lease = () => runner.handle(new Request("http://box/lease", { method: "POST", headers: { authorization: `Bearer ${config.token}` }, body: JSON.stringify({ boxId: config.boxId, epoch: config.epoch }) }));
  runner.enqueue(opaqueId("waiting-for-router"), { text: "turn" });
  expect(await (await lease()).json()).toMatchObject({ routerReady: false, callbackReady: true }); await runner.tick(); expect(calls).toBe(0); expect(runner.active()).toBe(true);
  healthy = true; expect((await lease()).status).toBe(200); await runner.tick(); expect(calls).toBe(1);
  runner.enqueue(opaqueId("after-router-loss"), { text: "next" }); healthy = false;
  expect((await lease()).status).toBe(200); expect(runner.active()).toBe(true);
  await runner.tick(); expect(calls).toBe(1);
  healthy = true; expect((await lease()).status).toBe(200); await runner.tick(); expect(calls).toBe(2);
  runner.pause(); server.stop(true); expect(await (await lease()).json()).toMatchObject({ routerReady: false }); expect(runner.active()).toBe(true);
});

test.each(["identity", "gzip", "deflate", "br"])("gate preserves %s response bytes and streaming headers", async encoding => {
  const dir = root(), keyFile = join(dir, "key"), key = randomUUID(); writeFileSync(keyFile, key, { mode: 0o600 });
  const text = 'event: message\ndata: {"text":"hello"}\n\n', plain = Buffer.from(text);
  const bytes = encoding === "gzip" ? gzipSync(plain) : encoding === "deflate" ? deflateSync(plain) : encoding === "br" ? brotliCompressSync(plain) : plain;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(bytes, { headers: {
    "content-type": "text/event-stream", "content-length": String(bytes.length), ...(encoding === "identity" ? {} : { "content-encoding": encoding }),
  } }) }); clean.push(() => { server.stop(true); });
  const gate = startRouterGate(routerConfig({ routerKeyFile: keyFile, boxRouterPort: server.port }), () => {}); clean.push(() => { gate.stop(true); });
  const headers = { "x-api-key": key };
  const response = await fetch(gate.url, { headers }); expect(response.ok).toBe(true); expect(await response.text()).toBe(text);
  const raw = await fetch(gate.url, { headers, decompress: false });
  expect(raw.headers.get("content-encoding")).toBe(encoding === "identity" ? null : encoding);
  expect(raw.headers.get("content-length")).toBe(String(bytes.length)); expect(Buffer.from(await raw.arrayBuffer())).toEqual(bytes);
});

test.each(["unavailable", "throws", "expires"])("router readiness %s at admission never starts or interrupts an unstarted turn", async kind => {
  const dir = root(); let healthy = true, now = 0, calls = 0;
  const config = { root: dir, boxId: "bx_test", epoch: "test", token: "t".repeat(32), callbackToken: "c".repeat(32), callbackUrl: "http://box", privateKey: "unused", system: "system" };
  const runner = new BoxRunner(config, { run: async () => { calls++; return "NO_REPLY"; } }, {
    modelReady: async () => { if (healthy) return true; if (kind === "throws") throw new Error(); if (kind === "expires") { now += 20_001; return true; } return false; },
    callbackReady: async () => true, now: () => now, fetch: async () => Response.json({ accepted: true }),
  }); clean.push(() => runner.db.close());
  const lease = () => runner.handle(new Request("http://box/lease", { method: "POST", headers: { authorization: `Bearer ${config.token}` }, body: JSON.stringify({ boxId: config.boxId, epoch: config.epoch }) }));
  expect((await lease()).status).toBe(200); runner.enqueue(opaqueId("admission-router"), { text: "turn" });
  healthy = false; await runner.tick(); expect(calls).toBe(0); expect(runner.active()).toBe(kind !== "expires");
  expect(runner.db.query<{ state: string }, []>("SELECT state FROM inbox").get()!.state).toBe("pending");
  healthy = true; expect((await lease()).status).toBe(200); await runner.tick(); expect(calls).toBe(1);
});

test.each(["unavailable", "throws"])("failed callback readiness %s renews authority until calls cease", async kind => {
  const dir = root(); let healthy = true, now = 0;
  const config = { root: dir, boxId: "bx_test", epoch: "test", token: "t".repeat(32), callbackToken: "c".repeat(32), callbackUrl: "http://box", privateKey: "unused", system: "system" };
  const runner = new BoxRunner(config, { run: async () => "NO_REPLY" }, { now: () => now, modelReady: async () => true, callbackReady: async () => {
    if (healthy) return true; if (kind === "throws") throw new Error(); return false;
  } }); clean.push(() => runner.db.close());
  const lease = () => runner.handle(new Request("http://box/lease", { method: "POST", headers: { authorization: `Bearer ${config.token}` }, body: JSON.stringify({ boxId: config.boxId, epoch: config.epoch }) }));
  expect((await lease()).status).toBe(200); expect(runner.active()).toBe(true); healthy = false;
  now = 19_999; expect(await (await lease()).json()).toMatchObject({ callbackReady: false }); expect(runner.active()).toBe(true);
  now = 20_000; expect(runner.active()).toBe(true); now = 39_999; expect(runner.active()).toBe(false);
});

test.each(["router", "callback"])("one failed %s renewal cannot abort a healthy active turn", async target => {
  const dir = root(); let now = 0, healthy = true, finish!: () => void, began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const completed = new Promise<void>(resolve => { finish = resolve; }); let signal: AbortSignal | undefined;
  const config = { root: dir, boxId: "bx_test", epoch: "test", token: "t".repeat(32), callbackToken: "c".repeat(32), callbackUrl: "http://box", privateKey: "unused", system: "system" };
  const runner = new BoxRunner(config, { run: async input => { signal = input.signal; began(); await completed; return "NO_REPLY"; } }, {
    now: () => now, modelReady: async () => target !== "router" || healthy,
    callbackReady: async () => target !== "callback" || healthy, fetch: async () => Response.json({ accepted: true }),
  }); clean.push(() => runner.db.close());
  const lease = () => runner.handle(new Request("http://box/lease", { method: "POST", headers: { authorization: `Bearer ${config.token}` }, body: JSON.stringify({ boxId: config.boxId, epoch: config.epoch }) }));
  await lease(); runner.enqueue(opaqueId("healthy-turn"), { text: "synthetic" }); const turn = runner.tick(); await started;
  now = 5000; healthy = false; expect((await lease()).status).toBe(200); await runner.tick();
  expect(signal!.aborted).toBe(false); expect(runner.active()).toBe(true);
  healthy = true; now = 10_000; expect((await lease()).status).toBe(200);
  now = 20_001; await runner.tick(); expect(signal!.aborted).toBe(false);
  finish(); await turn; expect(runner.db.query<{ state: string }, []>("SELECT state FROM inbox").get()!.state).toBe("done");
});

test("a stale failed callback probe cannot revoke a newer successful renewal", async () => {
  const dir = root(); let now = 0, fail!: (ready: boolean) => void, entered!: () => void, slow = false;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const config = { root: dir, boxId: "bx_test", epoch: "test", token: "t".repeat(32), callbackToken: "c".repeat(32), callbackUrl: "http://box", privateKey: "unused", system: "system" };
  const runner = new BoxRunner(config, { run: async () => "NO_REPLY" }, { now: () => now, callbackReady: () => {
    if (!slow) return Promise.resolve(true); entered(); return new Promise<boolean>(resolve => { fail = resolve; });
  } }); clean.push(() => runner.db.close());
  const lease = () => runner.handle(new Request("http://box/lease", { method: "POST", headers: { authorization: `Bearer ${config.token}` }, body: JSON.stringify({ boxId: config.boxId, epoch: config.epoch }) }));
  await lease(); slow = true; const older = lease(); await waiting;
  slow = false; now = 10_000; expect((await lease()).status).toBe(200);
  fail(false); expect((await older).status).toBe(200);
  now = 20_001; expect(runner.active()).toBe(true); now = 30_000; expect(runner.active()).toBe(false);
});

test("missing, empty or unsafe router keys keep turns pending, emit one fixed code and never start a harness", async () => {
  for (const kind of ["missing", "empty", "whitespace", "mode", "symlink", "directory", "multiline"]) {
    const dir = root(), keyFile = join(dir, "key"), marker = join(dir, "work/started");
    if (kind === "directory") mkdirSync(keyFile);
    else if (kind === "symlink") { writeFileSync(join(dir, "target"), "secret", { mode: 0o600 }); symlinkSync(join(dir, "target"), keyFile); }
    else if (kind !== "missing") writeFileSync(keyFile, kind === "empty" ? "" : kind === "whitespace" ? " \n" : kind === "multiline" ? "first\nsecond" : "secret", { mode: kind === "mode" ? 0o644 : 0o600 });
    const fake = join(dir, "fake"); writeFileSync(fake, '#!/bin/sh\ntouch started\ncat >/dev/null\nprintf \'{"result":"NO_REPLY"}\'\n', { mode: 0o700 });
    const logs: string[] = [], harness = claudeHarness(dir, fake, "claude-opus-5-5", { routerKeyFile: keyFile }, code => logs.push(code));
    const runner = new BoxRunner({ root: dir, boxId: "bx_test", epoch: "test", token: "t".repeat(32), callbackToken: "c".repeat(32), callbackUrl: "http://127.0.0.1:1234", privateKey: "unused", system: "system" }, harness, { callbackReady: async () => true, fetch: async () => Response.json({ accepted: true }) });
    clean.push(() => runner.db.close());
    await runner.handle(new Request("http://box/lease", { method: "POST", headers: { authorization: `Bearer ${"t".repeat(32)}` }, body: JSON.stringify({ boxId: "bx_test", epoch: "test" }) }));
    runner.enqueue(opaqueId("queued"), { text: "private turn" }); await runner.tick(); await runner.tick();
    expect(existsSync(marker)).toBe(false); expect(logs).toEqual([ROUTER_KEY_ERROR]);
    expect(runner.db.query<{ state: string }, []>("SELECT state FROM inbox").get()!.state).toBe("pending");
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/router-auth.ts"), "--key", keyFile], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(out).toBe(""); expect(err).toBe(`${ROUTER_KEY_ERROR}\n`); expect(code).toBe(1);
    rmSync(keyFile, { recursive: true, force: true }); writeFileSync(keyFile, "restored-key", { mode: 0o600 }); chmodSync(keyFile, 0o600);
    await runner.tick(); expect(existsSync(marker)).toBe(true); expect(logs).toEqual([ROUTER_KEY_ERROR]);
  }
});

test("router config defaults and port validation cannot introduce other hosts or SSH arguments", () => {
  for (const port of [1024, 19465, 65535]) expect(() => routerConfig({ boxRouterPort: port, boxLivezPort: port })).toThrow("Invalid router configuration");
  expect(routerConfig({ boxLivezPort: 19476, macLivezPort: 20139 })).toMatchObject({ boxLivezPort: 19476, macLivezPort: 20139 });
  expect(routerConfig({})).toEqual({ boxRouterPort: 19465, macRouterPort: 20128, boxLivezPort: 19466, macLivezPort: 20129, routerKeyFile: "/home/user/person/secrets/9router-key" });
  for (const value of [null, true, "19465", "19465:owner:22", 0, 1023, 65536, 19465.5, NaN, Infinity]) {
    for (const field of ["boxRouterPort", "macRouterPort", "boxLivezPort", "macLivezPort"]) expect(() => routerConfig({ [field]: value })).toThrow("Invalid router configuration");
  }
});


test("installer config preflight verifies the secret without printing or writing it", async () => {
  const dir = root(), keyFile = join(dir, "secret"), config = join(dir, "config.json"), key = randomUUID();
  writeFileSync(keyFile, key, { mode: 0o600 }); writeFileSync(config, JSON.stringify({ routerKeyFile: keyFile }));
  for (const [mode, expected] of [[0o600, 0], [0o644, 1]] as const) {
    chmodSync(keyFile, mode);
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/router-auth.ts"), "--check-config", config], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(expected); expect(stdout).toBe(""); expect(stderr).toBe(expected ? `${ROUTER_KEY_ERROR}\n` : "");
    expect(readFileSync(keyFile, "utf8")).toBe(key); expect(contents(dir, keyFile)).not.toContain(key);
  }
});
