import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { antigravityHarness } from "../src/antigravity.ts";
import { HarnessFailure } from "../src/harness-failure.ts";

// A fake agy ACP server: just enough protocol to drive the harness, recording what it saw.
const FAKE_AGY = `#!${process.execPath}
import { Database } from "bun:sqlite";
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
let buf = "", cancelled = false;
process.on("SIGTERM", () => { note({ terminatedAt: Date.now() }); process.exit(0); });
// Keep the fake alive after stdin EOF so shutdown is observable through its SIGTERM handler.
setInterval(() => {}, 1000);
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
    else if (m.method === "session/cancel") {
      cancelled = true;
      note({ cancelledAt: Date.now() });
      void ask("session/request_permission", { options: [{ optionId: "late", kind: "allow_once" }] }).then(r => note({ latePermission: r }));
    }
    else if (m.method === "session/prompt") void (async () => {
      const text = m.params.prompt.map(p => p.text).join("\\n");
      const sid = m.params.sessionId;
      if (text.includes("ABORT")) return;
      if (text.includes("FAIL")) { out({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: "private failure text" } }); return; }
      if (text.includes("RATE_LIMIT")) {
        for (;;) {
          const response = await fetch(process.env.AGY_LLM_GATEWAY_URL + "/v1beta/models/x:streamGenerateContent", { method: "POST",
            headers: { authorization: "Bearer " + process.env.AGY_LLM_GATEWAY_API_KEY }, body: "{}" });
          if (cancelled) return;
          if (response.status !== 429) break;
          if (text.includes("STALL")) return;
        }
      }
      update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Let me check. " } });
      if (text.includes("TOOL")) {
        const options = text.includes("NO_ALLOW") ? [] : [
          { optionId: "aa", kind: "allow_always" }, { optionId: "ao", kind: "allow_once" }, { optionId: "ro", kind: "reject_once" }];
        const r = await ask("session/request_permission", { sessionId: sid, toolCall: { title: "date" }, options });
        const db = new Database(process.cwd() + "/../agent.sqlite", { readonly: true });
        const marked = db.query("SELECT value FROM settings WHERE key LIKE 'side-effects:%'").get()?.value ?? 0;
        db.close();
        note({ permission: r, markedBeforeTool: Number(marked) });
        if (r.outcome.outcome !== "selected" || !r.outcome.optionId.startsWith("a")) { reply({ stopReason: "end_turn" }); return; }
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

function setup(options: { bin?: string; gateway?: (req: Request, body: string) => Response | Promise<Response> } = {}) {
  const root = mkdtempSync(join(tmpdir(), "moni-agy-")), bin = join(root, "bin");
  mkdirSync(bin); mkdirSync(join(root, "work"));
  writeFileSync(join(bin, "agy_acp_server.par"), FAKE_AGY, { mode: 0o700 }); chmodSync(join(bin, "agy_acp_server.par"), 0o700);
  writeFileSync(join(bin, "localharness_external"), "#!/bin/sh\n", { mode: 0o700 }); chmodSync(join(bin, "localharness_external"), 0o700);
  const key = randomUUID(), keyFile = join(root, "key");
  writeFileSync(keyFile, key, { mode: 0o600 }); chmodSync(keyFile, 0o600);
  const upstream: { apiKey: string | null; googKey: string | null; auth: string | null }[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const body = await req.text(); upstream.push({ apiKey: req.headers.get("x-api-key"), googKey: req.headers.get("x-goog-api-key"), auth: req.headers.get("authorization") });
    return options.gateway ? options.gateway(req, body) : Response.json({ ok: true });
  } });
  const db = new Database(join(root, "agent.sqlite"));
  db.exec("CREATE TABLE inbox(seq INTEGER PRIMARY KEY, id TEXT UNIQUE, payload TEXT, state TEXT); CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);");
  const id = createHash("sha256").update(randomUUID()).digest("hex");
  db.query("INSERT INTO inbox(id,payload,state) VALUES (?,'{}','running')").run(id);
  const logs: string[] = [];
  const details: unknown[] = [];
  const harness = antigravityHarness(root, options.bin ?? bin, "ag/gemini-4-neon-high", { routerKeyFile: keyFile, boxRouterPort: server.port }, (code, detail) => { logs.push(code); details.push(detail); });
  cleanup.push(() => { server.stop(true); db.close(); rmSync(root, { recursive: true, force: true }); });
  const records = () => readFileSync(join(root, "antigravity", "record.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
  const effects = () => Number(db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key=?").get(`side-effects:${id}`)?.value ?? 0);
  return { root, key, id, db, harness, upstream, records, effects, logs, details };
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
  expect(recs.find(r => r.permission).markedBeforeTool).toBe(1);
  expect(t.effects()).toBe(2);
  expect(recs.find(r => r.gateway !== undefined).gateway).toBe(200);
  expect(recs.find(r => r.badGateway !== undefined).badGateway).toBe(401);
  expect(t.upstream).toEqual([{ apiKey: t.key, googKey: t.key, auth: null }]);
  expect(JSON.parse(readFileSync(join(t.root, "antigravity", "sessions.json"), "utf8"))).toEqual({ "runner-session": "agy-1" });
});

test("resume uses the mapped agy session; a read-only tool is not a side effect", async () => {
  const t = setup();
  await t.harness.run({ id: t.id, session: "s1", resume: false, text: "hello", system: "SYS" });
  expect(await t.harness.run({ id: t.id, session: "s1", resume: true, text: "READ it", system: "CHANGED SYSTEM" })).toBe("final answer");
  const recs = t.records();
  expect(recs.filter(r => r.method === "session/new").length).toBe(1);
  expect(recs.find(r => r.method === "session/resume").params.sessionId).toBe("agy-1");
  expect(t.effects()).toBe(0);
  expect(recs.filter(r => r.method === "session/prompt").map(r => r.params.prompt[0].text)).toEqual([
    "<system_instructions>\nSYS\n</system_instructions>", "<system_instructions>\nCHANGED SYSTEM\n</system_instructions>",
  ]);
});

test("resume without a mapping (session started under Claude) starts a new agy session", async () => {
  const t = setup();
  expect(await t.harness.run({ id: t.id, session: "claude-era", resume: true, text: "hi", system: "SYS" })).toBe("Let me check. final answer");
  const recs = t.records();
  expect(recs.some(r => r.method === "session/resume")).toBe(false);
  expect(recs.filter(r => r.method === "session/new").length).toBe(1);
  expect(t.logs.filter(code => code === "agy-session-reset")).toHaveLength(1);
});

test("a saved session that agy cannot resume resets once and still answers", async () => {
  const t = setup();
  await t.harness.run({ id: t.id, session: "s1", resume: false, text: "hi", system: "SYS" });
  rmSync(join(t.root, "antigravity", "known.json"));
  expect(await t.harness.run({ id: t.id, session: "s1", resume: true, text: "hello", system: "NEW SYS" })).toBe("Let me check. final answer");
  expect(t.records().filter(r => r.method === "session/new")).toHaveLength(2);
  expect(t.logs.filter(code => code === "agy-session-reset")).toHaveLength(1);
});

test("a permission request with no allow option is answered with cancelled", async () => {
  const t = setup();
  await t.harness.run({ id: t.id, session: "s1", resume: false, text: "TOOL NO_ALLOW", system: "SYS" });
  expect(t.records().find(r => r.permission).permission).toEqual({ outcome: { outcome: "cancelled" } });
  expect(t.effects()).toBe(0);
});

test("abort sends cancel, then gives agy a grace period before SIGTERM", async () => {
  const t = setup(), controller = new AbortController();
  const reason = new Error("test abort");
  await expect(t.harness.run({ id: t.id, session: "s1", resume: false, text: "ABORT", system: "SYS", signal: controller.signal,
    onStarted: () => controller.abort(reason) })).rejects.toBe(reason);
  const recs = t.records();
  expect(recs.find(r => r.method === "session/cancel").params.sessionId).toBe("agy-1");
  expect(recs.find(r => r.terminatedAt).terminatedAt - recs.find(r => r.cancelledAt).cancelledAt).toBeGreaterThanOrEqual(4_500);
  expect(recs.find(r => r.latePermission).latePermission).toEqual({ outcome: { outcome: "cancelled" } });
  expect(t.effects()).toBe(0);
  expect(readdirSync(join(t.root, "antigravity-tmp"))).toEqual([]);
}, 15_000);

test("gate retries stop on the third 429 and produce HarnessFailure", async () => {
  const t = setup({ gateway: () => Response.json({ error: "private" }, { status: 429, headers: { "Retry-After": "0.001" } }) });
  await expect(t.harness.run({ id: t.id, session: "s1", resume: false, text: "RATE_LIMIT", system: "SYS" })).rejects.toBeInstanceOf(HarnessFailure);
  expect(t.upstream).toHaveLength(3);
  expect(t.logs.filter(code => code === "router-retry")).toHaveLength(2);
  expect(JSON.stringify(t.details)).not.toContain("private");
});

test("an incomplete 429 reset body is bounded by ten seconds", async () => {
  const t = setup({ gateway: () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("{")); } }), { status: 429 }) });
  await expect(t.harness.run({ id: t.id, session: "s1", resume: false, text: "RATE_LIMIT STALL", system: "SYS" })).rejects.toBeInstanceOf(HarnessFailure);
  expect(t.upstream).toHaveLength(1);
  expect(t.logs).toContain("harness-exit");
}, 20_000);

test("a successful gate retry clears the rate-limit count for the next turn", async () => {
  let count = 0;
  const t = setup({ gateway: () => Response.json({}, { status: ++count % 3 === 0 ? 200 : 429, headers: { "Retry-After": "0.001" } }) });
  for (const resume of [false, true]) {
    expect(await t.harness.run({ id: t.id, session: "s1", resume, text: "RATE_LIMIT", system: "SYS" })).toBe("Let me check. final answer");
  }
  expect(count).toBe(6);
});

test("gate waits for Retry-After before forwarding the buffered body again", async () => {
  const times: number[] = [];
  const t = setup({ gateway: () => {
    times.push(performance.now());
    return Response.json({}, { status: times.length === 1 ? 429 : 200, headers: { "Retry-After": "0.05" } });
  } });
  await t.harness.run({ id: t.id, session: "s1", resume: false, text: "RATE_LIMIT", system: "SYS" });
  expect(times).toHaveLength(2);
  expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(45);
});

test.each([401, 500, 503])("gate does not retry status %s", async status => {
  const t = setup({ gateway: () => Response.json({}, { status, headers: { "Retry-After": "0" } }) });
  await t.harness.run({ id: t.id, session: "s1", resume: false, text: "RATE_LIMIT", system: "SYS" });
  expect(t.upstream).toHaveLength(1);
  expect(t.logs).not.toContain("router-retry");
});

test("a 429 arriving during cancellation cannot restart the retry timer", async () => {
  const controller = new AbortController(), reason = new Error("cancel during request");
  const t = setup({ gateway: () => { controller.abort(reason); return Response.json({}, { status: 429 }); } });
  await expect(t.harness.run({ id: t.id, session: "s1", resume: false, text: "RATE_LIMIT", system: "SYS", signal: controller.signal })).rejects.toBe(reason);
  expect(t.upstream).toHaveLength(1);
  expect(t.logs).not.toContain("router-retry");
}, 15_000);

test.each([
  { name: "fractional Retry-After", after: "0.001", body: "{}", encoding: "", retries: true },
  { name: "zero Retry-After", after: "0", body: "{}", encoding: "", retries: true },
  { name: "HTTP date Retry-After", after: new Date(Date.now() - 1000).toUTCString(), body: "{}", encoding: "", retries: true },
  { name: "seconds reset hint", after: null, body: '{"error":"pool_lock reset after 0.001s"}', encoding: "", retries: true },
  { name: "milliseconds reset hint", after: null, body: '{"error":"reset after 1ms"}', encoding: "", retries: true },
  { name: "compressed reset hint", after: null, body: '{"error":"reset after 1ms"}', encoding: "gzip", retries: true },
  { name: "header overrides body", after: "0", body: '{"error":"reset after 60s"}', encoding: "", retries: true },
  { name: "long Retry-After", after: "60", body: '{"error":"reset after 1ms"}', encoding: "", retries: false },
  { name: "long reset hint", after: null, body: '{"error":"reset after 60s"}', encoding: "", retries: false },
  { name: "invalid Retry-After", after: "no", body: '{"error":"reset after 1ms"}', encoding: "", retries: false },
  { name: "negative Retry-After", after: "-1", body: "{}", encoding: "", retries: false },
  { name: "no reset hint", after: null, body: "{}", encoding: "", retries: false },
])("429 $name", async ({ after, body, encoding, retries }) => {
  let count = 0;
  const bodies: string[] = [];
  const t = setup({ gateway: (_req, requestBody) => {
    bodies.push(requestBody);
    return ++count === 1 ? new Response(encoding === "gzip" ? gzipSync(body) : body, { status: 429, headers: {
      ...(after === null ? {} : { "Retry-After": after }), ...(encoding ? { "Content-Encoding": encoding } : {}),
    } }) : Response.json({});
  } });
  const result = t.harness.run({ id: t.id, session: "s1", resume: false, text: "RATE_LIMIT", system: "SYS" });
  if (retries) expect(await result).toBe("Let me check. final answer");
  else await expect(result).rejects.toBeInstanceOf(HarnessFailure);
  expect(count).toBe(retries ? 2 : 1);
  expect(bodies).toEqual(retries ? ["{}", "{}"] : ["{}"]);
});

// Uses only synthetic prompts and a local stub, never Moni's running agent or router.
test.skipIf(!process.env.MONI_TEST_REAL_AGY_DIR)("agy 1.3.0 retries two 429s and refreshes instructions on resume", async () => {
  let count = 0;
  const bodies: string[] = [];
  const t = setup({ bin: process.env.MONI_TEST_REAL_AGY_DIR, gateway: (_req, body) => {
    count++;
    bodies.push(body);
    if (count <= 2) return Response.json({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "pool_lock: reset after 2s" } },
      { status: 429, headers: { "Retry-After": "2" } });
    const data = { candidates: [{ content: { role: "model", parts: [{ text: "stub-ok" }] }, finishReason: "STOP", index: 0 }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } };
    return new Response(`data: ${JSON.stringify(data)}\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    expect(await t.harness.run({ id: t.id, session: "probe", resume: false, text: "Say stub-ok", system: "Answer briefly.", signal: controller.signal })).toBe("stub-ok");
    console.log(JSON.stringify({ code: "agy-retry-probe", attempts: count, outcome: "success" }));
    expect(count).toBe(3);
    expect(bodies.at(-1)).toContain("Answer briefly.");
    expect(await t.harness.run({ id: t.id, session: "probe", resume: true, text: "Say stub-ok again", system: "Updated instructions.", signal: controller.signal })).toBe("stub-ok");
    expect(bodies.at(-1)).toContain("Updated instructions.");
    expect(t.logs).not.toContain("agy-session-reset");
  } finally { clearTimeout(timer); }
}, 110_000);

test.skipIf(!process.env.MONI_TEST_REAL_AGY_DIR)("agy 1.3.0 exhausted 429 retries become HarnessFailure", async () => {
  let count = 0;
  const t = setup({ bin: process.env.MONI_TEST_REAL_AGY_DIR, gateway: () => {
    count++;
    return Response.json({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "private pool_lock: reset after 2s" } },
      { status: 429, headers: { "Retry-After": "2" } });
  } });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const error = await t.harness.run({ id: t.id, session: "probe", resume: false, text: "Say stub-ok", system: "Answer briefly.", signal: controller.signal }).catch(e => e);
    console.log(JSON.stringify({ code: "agy-exhausted-probe", attempts: count, outcome: error instanceof HarnessFailure ? "HarnessFailure" : "unexpected" }));
    expect(error).toBeInstanceOf(HarnessFailure);
    expect(count).toBeGreaterThan(1);
    expect(JSON.stringify(t.details)).not.toContain("private");
  } finally { clearTimeout(timer); }
}, 140_000);

test("a tool is refused when its side effect cannot be recorded", async () => {
  const t = setup();
  t.db.query("UPDATE inbox SET state='done' WHERE id=?").run(t.id);
  await t.harness.run({ id: t.id, session: "s1", resume: false, text: "TOOL", system: "SYS" });
  expect(t.records().find(r => r.permission).permission).toEqual({ outcome: { outcome: "selected", optionId: "ro" } });
  expect(t.logs).toContain("side-effect-mark-failed");
  expect(t.records().find(r => r.permission).markedBeforeTool).toBe(0);
  expect(t.upstream).toHaveLength(0);
});

test("a prompt error is a HarnessFailure without private text in logs", async () => {
  const t = setup();
  const error = await t.harness.run({ id: t.id, session: "s1", resume: false, text: "FAIL", system: "SYS" }).catch(e => e);
  expect(error).toBeInstanceOf(HarnessFailure);
  expect(t.logs).toContain("harness-exit");
  expect(JSON.stringify(t.logs)).not.toContain("private");
  expect(JSON.stringify(t.details)).not.toContain("private");
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
