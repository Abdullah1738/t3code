import { afterEach, expect, test } from "bun:test";
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
});

test("permanent scope refusals fail one action while temporary unavailability retains it", async () => {
  for (const status of [400, 403, 404, 413, 422, 503]) {
    const s = setup({ run: async () => "NO_REPLY" }); let available = false; const texts: string[] = [];
    const r = new BoxRunner({ ...s.runner.config, root: join(s.root, `scope-${status}`) }, { run: async ({ text }) => { texts.push(text); return "NO_REPLY"; } }, {
      callbackReady: async () => true,
      fetch: async url => String(url).endsWith("/react") && !available ? new Response("", { status }) : Response.json({ accepted: true }),
    }); clean.push(() => r.db.close());
    await r.action(opaqueId("refused-reaction"), "/react", { target: "unknown", kind: "love" });
    r.enqueue(opaqueId("following"), { text: "next" }); await r.handle(s.request("/lease", { boxId: "bx_test", epoch: "test" }));
    await r.tick();
    expect(texts).toEqual(status === 503 ? [] : ["next"]);
    expect(r.db.query<{ state: string }, []>("SELECT state FROM actions WHERE path='/react'").get()!.state).toBe(status === 503 ? "pending" : "failed");
    available = true; await r.tick(); expect(texts).toEqual(["next"]);
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
