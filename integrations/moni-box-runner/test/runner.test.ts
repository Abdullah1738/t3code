import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { BoxRunner, type Harness } from "../src/runner.ts";
import { claudeHarness } from "../src/claude.ts";
import { opaqueId, seal } from "../../spectrum-bridge/src/remote-protocol.ts";
const clean: (() => void)[] = [];
afterEach(() => clean.splice(0).reverse().forEach(f => f()));
function setup(harness: Harness) {
  const root = mkdtempSync(join(tmpdir(), "box-runner-")); clean.push(() => rmSync(root, { recursive: true, force: true }));
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const runner = new BoxRunner({ root, boxId: "bx_test", epoch: "test", token: "a".repeat(40), callbackToken: "b".repeat(40), callbackUrl: "http://127.0.0.1:1234", privateKey: keys.privateKey, system: "unchanged baseline" }, harness,
    { fetch: (async (url, init) => { calls.push({ path: String(url), body: JSON.parse(String(init?.body)) }); return Response.json({ epoch: "test", accepted: true }); }) });
  clean.push(() => runner.db.close());
  const request = (path: string, body: unknown) => new Request(`http://box${path}`, { method: "POST", headers: { authorization: `Bearer ${"a".repeat(40)}` }, body: JSON.stringify(body) });
  return { root, keys, runner, calls, request, lease: () => runner.handle(request("/lease", { boxId: "bx_test", epoch: "test" })) };
}
test("durable admission, duplicates, paused mode, tampering and box identity", async () => {
  const s = setup({ run: async () => "NO_REPLY" }); const id = opaqueId("event");
  const envelope = { id, epoch: "test", sealed: seal(s.keys.publicKey, { text: "hello" }) };
  expect((await s.runner.handle(s.request("/deliver", envelope))).status).toBe(503);
  expect((await s.runner.handle(s.request("/lease", { boxId: "bx_other", epoch: "test" }))).status).toBe(409);
  await s.lease();
  expect((await s.runner.handle(s.request("/deliver", envelope))).status).toBe(200);
  expect((await s.runner.handle(s.request("/deliver", envelope))).status).toBe(200);
  expect(s.runner.db.query<{ n: number }, []>("SELECT count(*) n FROM inbox").get()!.n).toBe(1);
  expect((await s.runner.handle(s.request("/deliver", { ...envelope, sealed: { ...envelope.sealed, tag: "bad" } }))).status).toBe(400);
});
test("fake harness replies are durably queued and callback payloads stay on the box", async () => {
  const inputs: string[] = []; const s = setup({ run: async ({ text }) => { inputs.push(text); return "reply"; } });
  await s.lease(); s.runner.enqueue(opaqueId("event"), { text: "input" }); await s.runner.tick();
  expect(inputs).toEqual(["input"]); expect(s.calls.find(c => c.path.endsWith("/send"))?.body.text).toBe("reply");
  expect(s.calls.find(c => c.path.endsWith("/send"))?.body.inboxId).toBe(opaqueId("event"));
  expect(s.runner.db.query<{ state: string }, []>("SELECT state FROM inbox").get()!.state).toBe("done");
});
test("Claude CLI uses the box home, router helper environment and explicit resume id", async () => {
  const s = setup({ run: async () => "" }); mkdirSync(join(s.root, "work"));
  const fake = join(s.root, "fake-claude");
  writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > args.txt\ncat > input.txt\nprintf '%s' "$CLAUDE_CONFIG_DIR|$ANTHROPIC_BASE_URL" > env.txt\nprintf '{"result":"answer"}'\n`, { mode: 0o700 });
  const routerKeyFile = join(s.root, "router-key"); writeFileSync(routerKeyFile, "test-router-key", { mode: 0o600 });
  const harness = claudeHarness(s.root, fake, "claude-opus-5-5", { routerKeyFile });
  await harness.run({ id: opaqueId("x"), session: "session", resume: true, text: "prompt", system: "system" });
  expect(readFileSync(join(s.root, "work/args.txt"), "utf8")).toContain("--resume\nsession");
  expect(readFileSync(join(s.root, "work/input.txt"), "utf8")).toBe("prompt");
  const [configDir, base] = readFileSync(join(s.root, "work/env.txt"), "utf8").split("|");
  expect(configDir).toBe(`${s.root}/claude`); expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
});

test("attachment preparation can retry without repeating a harness; swipe context includes raw handles", async () => {
  const inputs: string[] = []; const s = setup({ run: async ({ text }) => { inputs.push(text); return "NO_REPLY"; } });
  let available = false;
  // This runner has an injected fetch; use a fresh one so the media response can change independently.
  const r = new BoxRunner({ ...s.runner.config, root: join(s.root, "retry") }, { run: async ({ text }) => { inputs.push(text); return "NO_REPLY"; } }, {
    callbackReady: async () => true,
    fetch: (async url => String(url).includes("media.example") ? available ? new Response("file") : new Response("", { status: 503 }) : Response.json({ accepted: true })),
  }); clean.push(() => r.db.close());
  await r.handle(s.request("/lease", { boxId: "bx_test", epoch: "test" }));
  r.enqueue(opaqueId("file"), { id: "raw-handle", text: "yes", replyTo: "previous-handle", threadOrigin: "origin-handle", attachments: [{ guid: "https://media.example/file", fileName: "document.txt" }] });
  await r.tick(); expect(inputs).toHaveLength(0);
  expect(r.db.query<{ state: string }, []>("SELECT state FROM inbox").get()!.state).toBe("pending");
  available = true; await r.tick(); expect(inputs).toHaveLength(1);
  for (const value of ["raw-handle", "previous-handle", "origin-handle", "Attachment:"]) expect(inputs[0]).toContain(value);
});
test("old backlog latency and failed metrics cannot block subsequent messages", async () => {
  const texts: string[] = []; const s = setup({ run: async ({ text }) => { texts.push(text); return "NO_REPLY"; } });
  await s.lease();
  s.runner.enqueue(opaqueId("old"), { text: "old", receivedAt: Date.now() - 25 * 3600_000 });
  s.runner.enqueue(opaqueId("next"), { text: "next" });
  await s.runner.tick(); await s.runner.tick(); expect(texts).toEqual(["old", "next"]);
});

test("rejected metrics are dropped without blocking the next inbox turn", async () => {
  const s = setup({ run: async () => "NO_REPLY" }); const texts: string[] = [];
  const r = new BoxRunner({ ...s.runner.config, root: join(s.root, "bad-metrics") }, { run: async ({ text }) => { texts.push(text); return "NO_REPLY"; } }, {
    callbackReady: async () => true,
    fetch: async url => String(url).endsWith("/metrics") ? new Response("", { status: 400 }) : Response.json({ accepted: true }),
  }); clean.push(() => r.db.close());
  await r.handle(s.request("/lease", { boxId: "bx_test", epoch: "test" }));
  r.enqueue(opaqueId("old-event"), { text: "old", receivedAt: Date.now() - 25 * 3600_000 });
  r.enqueue(opaqueId("following-event"), { text: "next" });
  await r.tick(); await r.tick(); expect(texts).toEqual(["old", "next"]);
});

test("long replies retain their full text across bounded send operations", async () => {
  const reply = "🙂".repeat(15000); const s = setup({ run: async () => reply });
  await s.lease(); s.runner.enqueue(opaqueId("long"), { text: "explain" }); await s.runner.tick();
  const parts = s.calls.filter(c => c.path.endsWith("/send")).map(c => String(c.body.text));
  expect(parts.length).toBeGreaterThan(1); expect(parts.join("")).toBe(reply); expect(parts.every(p => p.length <= 12000)).toBe(true);
});

test("pausing the backend interrupts the active harness and fences its tool turn", async () => {
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  const s = setup({ run: ({ signal }) => new Promise((_resolve, reject) => { signal!.addEventListener("abort", () => reject(new Error("paused"))); started(); }) });
  await s.lease(); s.runner.enqueue(opaqueId("active"), { text: "long task" });
  const tick = s.runner.tick(); await ready; s.runner.pause(); await tick;
  expect(s.runner.db.query<{ state: string }, []>("SELECT state FROM inbox").get()!.state).toBe("interrupted");
  expect(s.runner.db.query<{ interrupted_at: number }, []>("SELECT interrupted_at FROM inbox").get()!.interrupted_at).toBeGreaterThan(0);
});

test.each([false, true])("events expose only fence metadata with hasSend=%s; resolving done releases the next turn", async hasSend => {
  const canary = "PRIVATE_FENCE_INPUT_AND_REPLY";
  const s = setup({ run: async ({ id }) => {
    if (id === opaqueId("first")) {
      if (hasSend) await s.runner.action(opaqueId("tool-send"), "/send", { text: canary });
      throw new Error(canary);
    }
    return "NO_REPLY";
  } });
  await s.lease();
  const id = opaqueId("first"), next = opaqueId("next");
  s.runner.enqueue(id, { id: "wake:legacy", kind: "wake", text: canary });
  s.runner.enqueue(next, { kind: "inbound", text: canary });
  await s.runner.tick(); await s.runner.tick();
  const response = await (await s.runner.handle(s.request("/events", {}))).text();
  expect(response).not.toContain(canary);
  expect(JSON.parse(response)).toEqual({ events: [
    { id, state: "interrupted", failure: null, kind: "wake", interruptedAt: expect.any(Number), hasSend },
    { id: next, state: "pending", failure: null, kind: "inbound", interruptedAt: null, hasSend: false },
  ] });
  expect((await s.runner.handle(s.request("/resolve", { id, state: "done", reconciled: true }))).status).toBe(200);
  expect((await s.runner.handle(s.request("/resolve", { id, state: "pending", reconciled: true }))).status).toBe(409);
  await s.runner.tick();
  expect(await (await s.runner.handle(s.request("/events", {}))).json()).toEqual({ events: [] });
});

test.each(["automatic", "manual-done", "resumed-no-reply", "resumed-replied"])("automatic retry distinguishes an automatic tombstone from %s completion", async completion => {
  let attempts = 0;
  const harness = { run: async () => { if (++attempts === 1) throw new Error("interrupted"); return completion === "resumed-replied" ? "reply" : "NO_REPLY"; } };
  const s = setup(harness), id = opaqueId("wake"), dm = opaqueId("dm");
  await s.lease(); s.runner.enqueue(id, { kind: "wake", text: "private" }); s.runner.enqueue(dm, { kind: "inbound", text: "dm" });
  await s.runner.tick();
  const automatic = { id, state: "done", reconciled: true, autoFailMs: 0 };
  if (completion === "automatic") expect((await s.runner.handle(s.request("/resolve", automatic))).status).toBe(200);
  else {
    expect((await s.runner.handle(s.request("/resolve", { id, state: completion === "manual-done" ? "done" : "pending", reconciled: true }))).status).toBe(200);
    if (completion !== "manual-done") await s.runner.tick();
  }
  if (completion === "resumed-replied") expect(s.calls.filter(c => c.path.endsWith("/send"))).toHaveLength(1);
  const reopened = new BoxRunner(s.runner.config, harness, { callbackReady: async () => true }); clean.push(() => reopened.db.close());
  await reopened.handle(s.request("/lease", { boxId: "bx_test", epoch: "test" }));
  expect((await reopened.handle(s.request("/resolve", automatic))).status).toBe(completion === "automatic" ? 200 : 409);
  expect(reopened.db.query<{ state: string }, [string]>("SELECT state FROM inbox WHERE id=?").get(id)?.state).toBe("done");
});

test("legacy schema upgrades timestamp crash interruption and recognize old reply actions without exposing text", async () => {
  const s = setup({ run: async () => "NO_REPLY" }), root = join(s.root, "legacy"); mkdirSync(root);
  const db = new Database(join(root, "agent.sqlite")), id = opaqueId("legacy");
  db.exec("CREATE TABLE inbox(seq INTEGER PRIMARY KEY,id TEXT UNIQUE,payload TEXT,state TEXT); CREATE TABLE actions(id TEXT PRIMARY KEY,path TEXT,payload TEXT,result TEXT,state TEXT)");
  db.query("INSERT INTO inbox(id,payload,state) VALUES (?,?,'running')").run(id, JSON.stringify({ id: "wake:old", text: "PRIVATE_OLD" }));
  db.query("INSERT INTO actions VALUES (?,'/send',?,NULL,'pending')").run(opaqueId(`reply:${id}:0`), JSON.stringify({ text: "PRIVATE_OLD" })); db.close();
  for (const now of [1234, 5678]) {
    const runner = new BoxRunner({ ...s.runner.config, root }, { run: async () => "NO_REPLY" }, { now: () => now, callbackReady: async () => true });
    clean.push(() => runner.db.close());
    await runner.handle(s.request("/lease", { boxId: "bx_test", epoch: "test" }));
    const metadata = await (await runner.handle(s.request("/events", {}))).text();
    expect(metadata).not.toContain("PRIVATE_OLD");
    expect(JSON.parse(metadata)).toEqual({ events: [
      { id, state: "interrupted", failure: null, kind: "wake", interruptedAt: 1234, hasSend: true },
    ], actions: [{ id: opaqueId(`reply:${id}:0`).slice(0, 12), path: "/send", attempts: 0, lastStatus: null, nextAt: null, inboxId: null }] });
  }
});

test.each([
  { state: "interrupted", action: "/send", hasSend: true },
  { state: "running", action: "/send", hasSend: true },
  { state: "pending", action: "/send", hasSend: false },
  { state: "interrupted", action: "/metrics", hasSend: false },
  { state: "interrupted", action: null, hasSend: false },
])("legacy attribution: $state with $action reports hasSend=$hasSend", async ({ state, action, hasSend }) => {
  const s = setup({ run: async () => "NO_REPLY" }), root = join(s.root, "legacy-tool"); mkdirSync(root);
  const db = new Database(join(root, "agent.sqlite")), id = opaqueId("legacy-tool");
  db.exec("CREATE TABLE inbox(seq INTEGER PRIMARY KEY,id TEXT UNIQUE,payload TEXT,state TEXT); CREATE TABLE actions(id TEXT PRIMARY KEY,path TEXT,payload TEXT,result TEXT,state TEXT)");
  db.query("INSERT INTO inbox(id,payload,state) VALUES (?,?,?)").run(id, JSON.stringify({ text: "PRIVATE_LEGACY_TOOL" }), state);
  if (action) db.query("INSERT INTO actions VALUES (?,?,?,NULL,'done')").run(opaqueId("custom-operation"), action, JSON.stringify({ text: "PRIVATE_LEGACY_TOOL" }));
  db.close();
  for (let restart = 0; restart < 2; restart++) {
    const runner = new BoxRunner({ ...s.runner.config, root }, { run: async () => "NO_REPLY" }, { callbackReady: async () => true }); clean.push(() => runner.db.close());
    await runner.handle(s.request("/lease", { boxId: "bx_test", epoch: "test" }));
    const events = await (await runner.handle(s.request("/events", {}))).json() as { events: { id: string; hasSend: boolean }[] };
    expect(events.events.find(e => e.id === id)?.hasSend).toBe(hasSend);
    expect(JSON.stringify(events)).not.toContain("PRIVATE_LEGACY_TOOL");
    const next = opaqueId("post-migration"); runner.enqueue(next, { text: "PRIVATE_LEGACY_TOOL" });
    runner.db.query("UPDATE inbox SET state='interrupted' WHERE id=?").run(next);
    const later = await (await runner.handle(s.request("/events", {}))).json() as { events: { id: string; hasSend: boolean }[] };
    expect(later.events.find(e => e.id === next)?.hasSend).toBe(false);
  }
});

test.each([0, 1, 100, 101, 1000])("events paginate %s rows within the CLI cap and keep an exact tail count", async count => {
  const s = setup({ run: async () => "NO_REPLY" }); await s.lease();
  const ids = Array.from({ length: count }, (_, i) => opaqueId(`page:${i}`));
  s.runner.db.transaction(() => { for (const id of ids) s.runner.enqueue(id, { kind: "wake", text: "PRIVATE_PAGE_CONTENT" }); })();
  let after: string | undefined; const seen: string[] = [];
  do {
    const response = await (await s.runner.handle(s.request("/events", { after }))).text();
    expect(Buffer.byteLength(response)).toBeLessThan(128 * 1024); expect(response).not.toContain("PRIVATE_PAGE_CONTENT");
    const page = JSON.parse(response) as { events: { id: string }[]; nextCursor?: string; remaining?: number };
    expect(page.events.length).toBeLessThanOrEqual(100); seen.push(...page.events.map(e => e.id));
    expect(page.remaining ?? 0).toBe(count - seen.length); after = page.nextCursor;
  } while (after);
  expect(seen).toEqual(ids);
});

test("head-only probe skips more than a page of attachment failures and counts the entire blocked tail", async () => {
  const s = setup({ run: async () => "NO_REPLY" }); await s.lease();
  s.runner.db.transaction(() => {
    for (let i = 0; i < 1200; i++) {
      const id = opaqueId(`head:${i}`); s.runner.enqueue(id, { text: "PRIVATE_HEAD" });
      if (i < 150) s.runner.db.query("UPDATE inbox SET state='attachment-failed' WHERE id=?").run(id);
      if (i === 150) s.runner.db.query("UPDATE inbox SET state='interrupted' WHERE id=?").run(id);
    }
  })();
  const response = await (await s.runner.handle(s.request("/events", { headOnly: true }))).json() as { events: { id: string }[]; remaining: number };
  expect(response.events.map(e => e.id)).toEqual([opaqueId("head:150")]); expect(response.remaining).toBe(1049);
  for (const after of ["", "a".repeat(12), "G".repeat(64), 12, false, null]) expect((await s.runner.handle(s.request("/events", { after }))).status).toBe(400);
  for (const headOnly of ["true", 1, null]) expect((await s.runner.handle(s.request("/events", { headOnly }))).status).toBe(400);
});

test("permanent scope refusals fail reactions while temporary unavailability backs off without holding the inbox", async () => {
  for (const status of [400, 403, 404, 413, 422, 503]) {
    const s = setup({ run: async () => "NO_REPLY" }); let available = false, now = 1000; const texts: string[] = [];
    const r = new BoxRunner({ ...s.runner.config, root: join(s.root, `scope-${status}`) }, { run: async ({ text }) => { texts.push(text); return "NO_REPLY"; } }, {
      now: () => now,
      callbackReady: async () => true,
      fetch: async url => String(url).endsWith("/react") && !available ? new Response("", { status }) : Response.json({ accepted: true }),
    }); clean.push(() => r.db.close());
    await r.action(opaqueId("refused-reaction"), "/react", { target: "unknown", kind: "love" });
    r.enqueue(opaqueId("following"), { text: "next" }); await r.handle(s.request("/lease", { boxId: "bx_test", epoch: "test" }));
    await r.tick();
    expect(texts).toEqual(["next"]);
    expect(r.db.query<{ state: string }, []>("SELECT state FROM actions WHERE path='/react'").get()!.state).toBe(status === 503 ? "pending" : "failed");
    available = true; await r.tick(); expect(texts).toEqual(["next"]);
    if (status === 503) {
      expect(r.db.query("SELECT attempts,last_status,next_at,state FROM actions WHERE path='/react'").get()).toEqual({ attempts: 1, last_status: 503, next_at: 6000, state: "pending" });
      now = 6000; await r.tick();
      expect(r.db.query<{ state: string }, []>("SELECT state FROM actions WHERE path='/react'").get()!.state).toBe("done");
    }
  }
});

test("each callback requires a live lease even when an earlier callback expires it", async () => {
  const s = setup({ run: async () => "NO_REPLY" }); let now = 0; const calls: number[] = [];
  const r = new BoxRunner({ ...s.runner.config, root: join(s.root, "expiring-flush") }, { run: async () => "NO_REPLY" }, {
    now: () => now, callbackReady: async () => true,
    fetch: async () => { calls.push(now); now += 21_000; return Response.json({ accepted: true }); },
  }); clean.push(() => r.db.close());
  for (const text of ["first", "second"]) await r.action(opaqueId(text), "/send", { text });
  await r.handle(s.request("/lease", { boxId: "bx_test", epoch: "test" })); await r.flush();
  expect(calls).toEqual([0]);
  expect(r.db.query<{ state: string }, []>("SELECT state FROM actions ORDER BY rowid DESC LIMIT 1").get()!.state).toBe("pending");
  await r.handle(s.request("/lease", { boxId: "bx_test", epoch: "test" })); await r.flush(); expect(calls).toEqual([0, 21_000]);
});

test("permanent attachment failures retain their envelope, notify once and allow following messages; transient rows retry in order", async () => {
  const cases: { name: string; response: () => Response; permanent: boolean; guid?: string }[] = [
    ...[400, 401, 402, 403, 404, 405, 406, 407, 409, 410, 411, 412, 413, 414, 415, 416, 417, 418, 421, 422, 423, 424, 426, 428, 431, 451].map(status => ({ name: String(status), response: () => new Response("", { status }), permanent: true })),
    ...[408, 425, 429, 500, 503].map(status => ({ name: String(status), response: () => new Response("", { status }), permanent: false })),
    { name: "network", response: () => { throw new Error("network private data"); }, permanent: false },
    { name: "declared-size", response: () => new Response("", { headers: { "content-length": String(100 * 1024 * 1024 + 1) } }), permanent: true },
    { name: "stream-size", response: () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(100 * 1024 * 1024 + 1)); c.close(); } })), permanent: true },
    { name: "invalid-url", response: () => new Response(""), permanent: true, guid: "https://" },
  ];
  for (const row of cases) {
    const s = setup({ run: async () => "NO_REPLY" }); let available = false; const texts: string[] = [], sent: string[] = [], logs: string[] = [];
    const r = new BoxRunner({ ...s.runner.config, root: join(s.root, row.name) }, { run: async ({ text }) => { texts.push(text); return "NO_REPLY"; } }, {
      callbackReady: async () => true, log: code => logs.push(code),
      fetch: async (url, init) => {
        if (String(url).startsWith("https://media.example")) return available ? new Response("file") : row.response();
        if (String(url).endsWith("/send")) sent.push(JSON.parse(String(init?.body)).text);
        return Response.json({ accepted: true });
      },
    }); clean.push(() => r.db.close());
    const id = opaqueId("failed-file"), payload = { text: "file request", attachments: [{ guid: row.guid ?? "https://media.example/file", fileName: "retained.txt" }] };
    r.enqueue(id, payload); r.enqueue(opaqueId("next"), { text: "next" }); await r.handle(s.request("/lease", { boxId: "bx_test", epoch: "test" }));
    await r.tick(); await r.tick();
    expect(texts).toEqual(row.permanent ? ["next"] : []);
    const saved = r.db.query<{ payload: string; state: string }, [string]>("SELECT payload,state FROM inbox WHERE id=?").get(id)!;
    expect(JSON.parse(saved.payload)).toEqual(payload); expect(saved.state).toBe(row.permanent ? "attachment-failed" : "pending");
    expect(sent).toHaveLength(row.permanent ? 1 : 0); expect(logs.join()).not.toContain("private");
    if (row.permanent) {
      const events = await (await r.handle(s.request("/events", {}))).json() as { events: { id: string; failure: string }[] };
      expect(events.events.find(e => e.id === id)?.failure).toBeTruthy();
      expect((await r.handle(s.request("/resolve", { id, state: "done" }))).status).toBe(400);
      expect((await r.handle(s.request("/resolve", { id, state: row.guid ? "done" : "pending", reconciled: true }))).status).toBe(200);
    }
    available = true; await r.tick(); await r.tick();
    expect(texts.some(t => t.includes("file request"))).toBe(!row.guid); expect(texts.filter(t => t === "next")).toHaveLength(1);
    expect(sent).toHaveLength(row.permanent ? 1 : 0);
  }
}, 20_000);

test("empty attachment succeeds and resolution of an unknown event refuses", async () => {
  const s = setup({ run: async () => "NO_REPLY" }); const texts: string[] = [];
  const r = new BoxRunner({ ...s.runner.config, root: join(s.root, "empty") }, { run: async ({ text }) => { texts.push(text); return "NO_REPLY"; } }, {
    callbackReady: async () => true, fetch: async () => new Response(null, { status: 204 }),
  }); clean.push(() => r.db.close());
  await r.handle(s.request("/lease", { boxId: "bx_test", epoch: "test" }));
  r.enqueue(opaqueId("empty"), { text: "empty", attachments: [{ guid: "https://media.example/empty" }] }); await r.tick();
  expect(texts).toHaveLength(1);
  expect((await r.handle(s.request("/resolve", { id: opaqueId("unknown"), state: "done", reconciled: true }))).status).toBe(409);
});


test("delivery status exposes only requested ids and pickup times, including completed turns", async () => {
  const s = setup({ run: async () => "NO_REPLY" }); await s.lease();
  const id = opaqueId("bus-status");
  s.runner.enqueue(id, { text: "PRIVATE_BUS_TEXT", agentExpiresAt: Date.now() + 600_000 });
  const status = () => s.runner.handle(s.request("/delivery-status", { ids: [id], epoch: "test" }));
  expect(await (await status()).json()).toEqual({ deliveries: [{ id, accepted: true, deliveredAt: null }] });
  await s.runner.tick();
  const body = await (await status()).text();
  expect(JSON.parse(body)).toEqual({ deliveries: [{ id, accepted: true, deliveredAt: expect.any(Number) }] });
  expect(body).not.toContain("PRIVATE_BUS_TEXT");
  expect((await s.runner.handle(s.request("/delivery-status", { ids: [id], epoch: "wrong" }))).status).toBe(400);
  expect((await s.runner.handle(s.request("/delivery-status", { ids: Array(51).fill(id), epoch: "test" }))).status).toBe(400);
});

test.each(["missing-executable", "not-executable", "missing-workdir"])("Claude %s failure never confirms bus pickup", async failure => {
  const s = setup({ run: async () => "NO_REPLY" });
  const root = join(s.root, "launch-failure"); mkdirSync(root);
  if (failure !== "missing-workdir") mkdirSync(join(root, "work"));
  const keyFile = join(root, "router-key"); writeFileSync(keyFile, "test-router-key", { mode: 0o600 });
  const executable = join(root, "fake-claude");
  if (failure !== "missing-executable") writeFileSync(executable, '#!/bin/sh\ncat >/dev/null\nprintf \'{"result":"NO_REPLY"}\'\n', { mode: failure === "not-executable" ? 0o600 : 0o700 });
  const runner = new BoxRunner({ ...s.runner.config, root }, claudeHarness(root, executable, "test", { routerKeyFile: keyFile }), {
    callbackReady: async () => true, modelReady: async () => true, fetch: async () => Response.json({ accepted: true }),
  }); clean.push(() => runner.db.close());
  await runner.handle(s.request("/lease", { boxId: "bx_test", epoch: "test" }));
  const id = opaqueId(failure); runner.enqueue(id, { id: `wake:agent-bus:${failure}`, text: "PRIVATE_BUS_TEXT", agentExpiresAt: Date.now() + 600_000 });
  await runner.tick();
  expect(runner.db.query("SELECT state,delivered_at FROM inbox WHERE id=?").get(id)).toEqual({ state: "interrupted", delivered_at: null });
  expect(runner.db.query("SELECT 1 FROM settings WHERE key='started'").get()).toBeNull();
  expect(runner.db.query("SELECT 1 FROM settings WHERE key='bus-yield-human'").get()).toBeNull();
  const status = await (await runner.handle(s.request("/delivery-status", { ids: [id], epoch: "test" }))).text();
  expect(JSON.parse(status)).toEqual({ deliveries: [{ id, accepted: true, deliveredAt: null }] });
  expect(status).not.toContain("PRIVATE_BUS_TEXT");
});

test.each([false, true])("an unfinished harness reports pickup only after handoff (fails=%s)", async fails => {
  const entered = Promise.withResolvers<void>(), handoff = Promise.withResolvers<void>(), acknowledged = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  const s = setup({ run: async ({ onStarted }) => {
    entered.resolve(); await handoff.promise; onStarted!(); onStarted!(); acknowledged.resolve(); await finish.promise;
    if (fails) throw new Error("PRIVATE_HARNESS_FAILURE");
    return "NO_REPLY";
  } }); await s.lease();
  const id = opaqueId("delayed-handoff"); s.runner.enqueue(id, { id: "wake:agent-bus:handoff", text: "PRIVATE_BUS_TEXT" });
  const status = async () => (await (await s.runner.handle(s.request("/delivery-status", { ids: [id], epoch: "test" }))).json()).deliveries[0].deliveredAt;
  const tick = s.runner.tick();
  try {
    await entered.promise; expect(await status()).toBeNull();
    expect(s.runner.db.query("SELECT 1 FROM settings WHERE key='started'").get()).toBeNull();
    handoff.resolve(); await acknowledged.promise;
    const pickedUpAt = await status(); expect(pickedUpAt).toBeGreaterThan(0);
    expect(s.runner.db.query("SELECT value FROM settings WHERE key='bus-yield-human'").get()).toEqual({ value: "true" });
    finish.resolve(); await tick;
    expect(await status()).toBe(pickedUpAt);
    expect(s.runner.db.query<{ state: string }, [string]>("SELECT state FROM inbox WHERE id=?").get(id)?.state).toBe(fails ? "interrupted" : "done");
  } finally { handoff.resolve(); finish.resolve(); await tick; }
});

test.each([false, true])("Claude handoff is confirmed before its result, including later failure=%s", async fails => {
  const s = setup({ run: async () => "NO_REPLY" });
  const root = join(s.root, "handoff"); mkdirSync(join(root, "work"), { recursive: true });
  const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() { entered.resolve(); await finish.promise; return new Response(); } });
  clean.push(() => server.stop(true));
  const keyFile = join(root, "router-key"); writeFileSync(keyFile, "test-router-key", { mode: 0o600 });
  const executable = join(root, "fake-claude");
  writeFileSync(executable, `#!${process.execPath}\nawait Bun.stdin.text();\nawait fetch("http://127.0.0.1:${server.port}");\n${fails ? "process.exit(7);" : 'console.log(JSON.stringify({ result: "NO_REPLY" }));'}\n`, { mode: 0o700 });
  const runner = new BoxRunner({ ...s.runner.config, root }, claudeHarness(root, executable, "test", { routerKeyFile: keyFile }), {
    callbackReady: async () => true, fetch: async () => Response.json({ accepted: true }),
  }); clean.push(() => runner.db.close());
  await runner.handle(s.request("/lease", { boxId: "bx_test", epoch: "test" }));
  const id = opaqueId("real-handoff"); runner.enqueue(id, { id: "wake:agent-bus:real-handoff", text: "PRIVATE_BUS_TEXT" });
  const tick = runner.tick();
  try {
    await Promise.race([entered.promise, tick.then(() => { throw new Error("Harness ended before the result gate"); })]);
    const before = await (await runner.handle(s.request("/delivery-status", { ids: [id], epoch: "test" }))).json();
    expect(before.deliveries[0].deliveredAt).toBeGreaterThan(0);
    expect(runner.db.query("SELECT state FROM inbox WHERE id=?").get(id)).toEqual({ state: "running" });
    finish.resolve(); await tick;
    expect(await (await runner.handle(s.request("/delivery-status", { ids: [id], epoch: "test" }))).json()).toEqual(before);
    expect(runner.db.query("SELECT state FROM inbox WHERE id=?").get(id)).toEqual({ state: fails ? "interrupted" : "done" });
  } finally { finish.resolve(); await tick; }
});

test("expired bus input never starts a new target turn", async () => {
  let calls = 0; const s = setup({ run: async () => { calls++; return "NO_REPLY"; } }); await s.lease();
  const id = opaqueId("bus-expired"); s.runner.enqueue(id, { text: "PRIVATE", agentExpiresAt: Date.now() - 1 });
  await s.runner.tick(); expect(calls).toBe(0);
  const body = await (await s.runner.handle(s.request("/delivery-status", { ids: [id], epoch: "test" }))).json();
  expect(body).toEqual({ deliveries: [{ id, accepted: true, deliveredAt: null }] });
});


test("a readiness check crossing the bus deadline does not start expired work", async () => {
  const s = setup({ run: async () => "NO_REPLY" }); let now = 1_000, calls = 0, checks = 0;
  const runner = new BoxRunner({ ...s.runner.config, root: join(s.root, "expiry-ready") }, { run: async () => { calls++; return "NO_REPLY"; } }, {
    now: () => now, callbackReady: async () => true, fetch: async () => Response.json({ accepted: true }),
    modelReady: async () => { if (++checks > 1) now = 3_000; return true; },
  }); clean.push(() => runner.db.close());
  await runner.handle(s.request("/lease", { boxId: "bx_test", epoch: "test" }));
  runner.enqueue(opaqueId("expires-during-readiness"), { text: "PRIVATE", agentExpiresAt: 2_000 });
  await runner.tick(); expect(runner.active()).toBe(true); expect(calls).toBe(0);
});

test.each([false, true])("a human gets the next separate box turn between bus turns, restart=%s", async restart => {
  const texts: string[] = []; const harness = { run: async ({ text }: { text: string }) => { texts.push(text); return "NO_REPLY"; } };
  const s = setup(harness); await s.lease();
  for (const id of ["wake:agent-bus:a", "wake:agent-bus:b", "human-next"]) s.runner.enqueue(opaqueId(id), { id, text: id, receivedAt: Date.now() - 120_000 });
  await s.runner.tick();
  const runner = restart ? new BoxRunner(s.runner.config, harness, { callbackReady: async () => true, fetch: async () => Response.json({ accepted: true }) }) : s.runner;
  if (restart) { clean.push(() => runner.db.close()); await runner.handle(s.request("/lease", { boxId: "bx_test", epoch: "test" })); }
  await runner.tick(); await runner.tick();
  expect(texts.map(text => text.split("\n").at(-1))).toEqual(["wake:agent-bus:a", "human-next", "wake:agent-bus:b"]);
});

test("continuous box human traffic gives an overdue bus the next free turn, then a human", async () => {
  const texts: string[] = []; const s = setup({ run: async ({ text }) => { texts.push(text); return "NO_REPLY"; } }); await s.lease();
  for (const id of ["human-first", "human-second", "wake:agent-bus:due", "wake:agent-bus:next"]) s.runner.enqueue(opaqueId(id), { id, text: id, receivedAt: Date.now() - 61_000 });
  await s.runner.tick(); await s.runner.tick();
  expect(texts.map(text => text.split("\n").at(-1))).toEqual(["wake:agent-bus:due", "human-first"]);
});

test("legacy box asks wait for authoritative deadline metadata across repeated upgrades", async () => {
  let calls = 0; const s = setup({ run: async () => { calls++; return "NO_REPLY"; } });
  const id = opaqueId("legacy-deadline"), payload = { id: "wake:agent-bus:legacy", text: `[Agent request areq_${"a".repeat(64)} from Owner's assistant]PRIVATE`, receivedAt: Date.now() - 700_000 };
  s.runner.db.query("INSERT INTO inbox(id,payload,state) VALUES (?,?,'pending')").run(id, JSON.stringify(payload));
  for (let upgrade = 0; upgrade < 2; upgrade++) {
    const runner = new BoxRunner(s.runner.config, { run: async () => { calls++; return "NO_REPLY"; } }, { callbackReady: async () => true }); clean.push(() => runner.db.close());
    await runner.handle(s.request("/lease", { boxId: "bx_test", epoch: "test" })); await runner.tick(); expect(calls).toBe(0);
    const expiresAt = Date.now() - 1;
    expect((await runner.handle(s.request("/delivery-status", { epoch: "test", ids: [id], deadlines: [{ id, expiresAt }] }))).status).toBe(200);
    await runner.tick(); expect(calls).toBe(0);
    expect(runner.db.query<{ state: string; delivered_at: number | null }, [string]>("SELECT state,delivered_at FROM inbox WHERE id=?").get(id)).toEqual({ state: "done", delivered_at: null });
  }
});
