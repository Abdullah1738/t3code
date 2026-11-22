import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { antigravityHarness } from "../src/antigravity.ts";
import { HarnessFailure } from "../src/harness-failure.ts";

// A fake agy ACP server: just enough protocol to drive the harness, recording what it saw.
const FAKE_AGY = `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const rec = process.env.GEMINI_HOME + "/record.jsonl";
const note = (o) => appendFileSync(rec, JSON.stringify(o) + "\\n");
const known = process.env.GEMINI_HOME + "/known.json";
note({ env: { token: process.env.AGY_LLM_GATEWAY_API_KEY, url: process.env.AGY_LLM_GATEWAY_URL, models: process.env.AGY_LLM_GATEWAY_MODELS, tmp: process.env.TMPDIR,
  settings: readFileSync(process.env.GEMINI_HOME + "/antigravity-acp/settings.json", "utf8") } });
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let next = 1000; const waiting = new Map();
const ask = (method, params) => new Promise(r => { const id = next++; waiting.set(id, r); out({ jsonrpc: "2.0", id, method, params }); });
const update = (sessionId, update) => out({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
const model = { id: "model", type: "select", currentValue: "ag/gemini-4-neon-high", options: [{ value: "ag/gemini-4-neon-high" }] };
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += new TextDecoder().decode(chunk);
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);
    if (m.method === undefined) { waiting.get(m.id)?.(m.result); continue; }
    note({ method: m.method, params: m.params });
    const reply = (result) => out({ jsonrpc: "2.0", id: m.id, result });
    if (m.method === "initialize") reply({ protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } });
    else if (m.method === "session/new") { writeFileSync(known, JSON.stringify(["agy-1"])); reply({ sessionId: "agy-1", configOptions: [model] }); }
    else if (m.method === "session/resume") {
      const ids = existsSync(known) ? JSON.parse(readFileSync(known, "utf8")) : [];
      if (ids.includes(m.params.sessionId)) reply({ configOptions: [model] }); else out({ jsonrpc: "2.0", id: m.id, error: { code: -32002, message: "not found" } });
    }
    else if (m.method === "session/set_mode" || m.method === "session/set_config_option") reply({});
    else if (m.method === "session/prompt") void (async () => {
      const text = m.params.prompt.map(p => p.text).join("\\n");
      const sid = m.params.sessionId;
      if (text.includes("FAIL")) { out({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: "private failure text" } }); return; }
      update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Let me check. " } });
      if (text.includes("TOOL")) {
        const r = await ask("session/request_permission", { sessionId: sid, toolCall: { title: "date" }, options: [
          { optionId: "aa", kind: "allow_always" }, { optionId: "ao", kind: "allow_once" }, { optionId: "ro", kind: "reject_once" }] });
        note({ permission: r });
        update(sid, { sessionUpdate: "tool_call", toolCallId: "t1", kind: "execute", status: "pending" });
        const gw = await fetch(process.env.AGY_LLM_GATEWAY_URL + "/v1beta/models/x:streamGenerateContent", { method: "POST",
          headers: { authorization: "Bearer " + process.env.AGY_LLM_GATEWAY_API_KEY, "x-goog-api-key": "dummy" }, body: "{}" });
        note({ gateway: gw.status });
        const bad = await fetch(process.env.AGY_LLM_GATEWAY_URL + "/v1beta/x", { method: "POST", headers: { authorization: "Bearer wrong" }, body: "{}" });
        note({ badGateway: bad.status });
      }
      if (text.includes("READ")) update(sid, { sessionUpdate: "tool_call", toolCallId: "t2", kind: "read", status: "pending" });
      update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "final " } });
      update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } });
      reply({ stopReason: "end_turn" });
    })();
  }
}
`;

const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

function setup() {
  const root = mkdtempSync(join(tmpdir(), "moni-agy-")), bin = join(root, "bin");
  mkdirSync(bin); mkdirSync(join(root, "work"));
  writeFileSync(join(bin, "agy_acp_server.par"), FAKE_AGY, { mode: 0o700 }); chmodSync(join(bin, "agy_acp_server.par"), 0o700);
  writeFileSync(join(bin, "localharness_external"), "#!/bin/sh\n", { mode: 0o700 }); chmodSync(join(bin, "localharness_external"), 0o700);
  const key = randomUUID(), keyFile = join(root, "key");
  writeFileSync(keyFile, key, { mode: 0o600 }); chmodSync(keyFile, 0o600);
  const upstream: { apiKey: string | null; googKey: string | null; auth: string | null }[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    await req.text(); upstream.push({ apiKey: req.headers.get("x-api-key"), googKey: req.headers.get("x-goog-api-key"), auth: req.headers.get("authorization") });
    return Response.json({ ok: true });
  } });
  const db = new Database(join(root, "agent.sqlite"));
  db.exec("CREATE TABLE inbox(seq INTEGER PRIMARY KEY, id TEXT UNIQUE, payload TEXT, state TEXT); CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);");
  const id = createHash("sha256").update(randomUUID()).digest("hex");
  db.query("INSERT INTO inbox(id,payload,state) VALUES (?,'{}','running')").run(id);
  const logs: string[] = [];
  const harness = antigravityHarness(root, bin, "ag/gemini-4-neon-high", { routerKeyFile: keyFile, boxRouterPort: server.port }, code => { logs.push(code); });
  cleanup.push(() => { server.stop(true); db.close(); rmSync(root, { recursive: true, force: true }); });
  const records = () => readFileSync(join(root, "antigravity", "record.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
  const effects = () => Number(db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key=?").get(`side-effects:${id}`)?.value ?? 0);
  return { root, key, id, db, harness, upstream, records, effects, logs };
}

test("new session: gateway token, permission marks a side effect first, final reply after the last tool call", async () => {
  const t = setup();
  let started = 0;
  const reply = await t.harness.run({ id: t.id, session: "runner-session", resume: false, text: "TOOL please", system: "SYS", onStarted: () => { started++; } });
  expect(reply).toBe("final answer");
  expect(started).toBe(1);
  const recs = t.records();
  const env = recs.find(r => r.env)!.env;
  expect(env.token).not.toBe(t.key); expect(env.token.length).toBeGreaterThan(20);
  expect(env.models).toBe("ag/gemini-4-neon-high");
  expect(JSON.parse(env.settings)).toEqual({ auth: { type: "gateway" } });
  expect(env.tmp.startsWith(join(t.root, "antigravity-tmp"))).toBe(true);
  expect(existsSync(env.tmp)).toBe(false);
  expect(recs.find(r => r.method === "session/set_mode").params.modeId).toBe("default");
  expect(recs.some(r => r.method === "session/set_config_option")).toBe(false);
  const prompt = recs.find(r => r.method === "session/prompt").params.prompt;
  expect(prompt[0].text).toContain("SYS"); expect(prompt[1].text).toBe("TOOL please");
  expect(recs.find(r => r.permission).permission).toEqual({ outcome: { outcome: "selected", optionId: "ao" } });
  expect(t.effects()).toBe(2);
  expect(recs.find(r => r.gateway !== undefined).gateway).toBe(200);
  expect(recs.find(r => r.badGateway !== undefined).badGateway).toBe(401);
  expect(t.upstream).toEqual([{ apiKey: t.key, googKey: t.key, auth: null }]);
  expect(JSON.parse(readFileSync(join(t.root, "antigravity", "sessions.json"), "utf8"))).toEqual({ "runner-session": "agy-1" });
});

test("resume uses the mapped agy session; a read-only tool is not a side effect", async () => {
  const t = setup();
  await t.harness.run({ id: t.id, session: "s1", resume: false, text: "hello", system: "SYS" });
  expect(await t.harness.run({ id: t.id, session: "s1", resume: true, text: "READ it", system: "SYS" })).toBe("final answer");
  const recs = t.records();
  expect(recs.filter(r => r.method === "session/new").length).toBe(1);
  expect(recs.find(r => r.method === "session/resume").params.sessionId).toBe("agy-1");
  expect(t.effects()).toBe(0);
});

test("resume without a mapping (session started under Claude) starts a new agy session", async () => {
  const t = setup();
  expect(await t.harness.run({ id: t.id, session: "claude-era", resume: true, text: "hi", system: "SYS" })).toBe("Let me check. final answer");
  const recs = t.records();
  expect(recs.some(r => r.method === "session/resume")).toBe(false);
  expect(recs.filter(r => r.method === "session/new").length).toBe(1);
  expect(t.logs).toContain("agy-session-new");
});

test("a tool is refused when its side effect cannot be recorded", async () => {
  const t = setup();
  t.db.query("UPDATE inbox SET state='done' WHERE id=?").run(t.id);
  await t.harness.run({ id: t.id, session: "s1", resume: false, text: "TOOL", system: "SYS" });
  expect(t.records().find(r => r.permission).permission).toEqual({ outcome: { outcome: "selected", optionId: "ro" } });
  expect(t.logs).toContain("side-effect-mark-failed");
});

test("a prompt error is a HarnessFailure without private text in logs", async () => {
  const t = setup();
  const error = await t.harness.run({ id: t.id, session: "s1", resume: false, text: "FAIL", system: "SYS" }).catch(e => e);
  expect(error).toBeInstanceOf(HarnessFailure);
  expect(t.logs).toContain("harness-exit");
  expect(JSON.stringify(t.logs)).not.toContain("private");
  expect(readdirSync(join(t.root, "antigravity-tmp"))).toEqual([]);
});

test("ready() is false without the agy binaries", () => {
  const t = setup();
  rmSync(join(t.root, "bin", "localharness_external"));
  expect(t.harness.ready!()).toBe(false);
});

test("config selects the harness and its default model", async () => {
  const { loadRunnerConfig } = await import("../src/main.ts");
  const root = mkdtempSync(join(tmpdir(), "moni-agy-cfg-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const secret = (name: string) => { const p = join(root, name); writeFileSync(p, "x"); return p; };
  const base = { tokenFile: secret("t"), callbackTokenFile: secret("c"), privateKeyFile: secret("k"), systemFile: secret("s") };
  const write = (extra: object) => { const p = join(root, `cfg-${randomUUID()}.json`); writeFileSync(p, JSON.stringify({ ...base, ...extra })); return p; };
  expect(loadRunnerConfig(write({}))).toMatchObject({ harness: "claude", model: "claude-opus-5-5" });
  expect(loadRunnerConfig(write({ harness: "antigravity", antigravity: "/opt/agy" }))).toMatchObject({ harness: "antigravity", model: "ag/gemini-4-neon-high", antigravity: "/opt/agy" });
  expect(() => loadRunnerConfig(write({ harness: "antigravity" }))).toThrow();
  expect(() => loadRunnerConfig(write({ harness: "codex" }))).toThrow();
});
