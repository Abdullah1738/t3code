import { afterEach, expect, setSystemTime, test } from "bun:test";
import { createHash } from "node:crypto";
import { createApi } from "../src/api.ts";
import { GROUP_APP_REFUSAL } from "../src/line.ts";
import type { Photon } from "../src/photon.ts";
import { Shares } from "../src/share.ts";
import { Store } from "../src/store.ts";

const stores: Store[] = [];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const send = { text: "Hello **there**", effect: "confetti", subject: "Hi", dedupeKey: "send-1", sessionId: "current" };
const poll = { title: "Lunch?", options: ["Pizza", "Sushi"], dedupeKey: "poll-1", sessionId: "current" };
const app = { url: "https://apps.test/tracker/", caption: "Tracker", subcaption: "Today", trailingCaption: "3",
  trailingSubcaption: "left", summary: "Open tracker", dedupeKey: "app-1", sessionId: "current" };

function setup(options: Partial<Parameters<typeof createApi>[0]> = {}) {
  setSystemTime(Date.parse("2026-09-10T00:00:00Z"));
  const store = new Store(":memory:");
  stores.push(store);
  const state = { enabled: true, chat: "iMessage;-;+15555550123" as string | undefined, health: {} as Record<string, unknown> };
  const photon: Pick<Photon, "react"> = { async react() { throw new Error("Unexpected reaction"); } };
  const api = createApi({ store, photon, router: () => undefined, chatGuid: () => state.chat, enabled: () => state.enabled,
    health: () => state.health, ...options });
  const post = (path: string, body: unknown) => api(new Request(`http://bridge${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }));
  store.set("route", { id: "current", generation: 5 });
  return { store, state, api, post };
}

afterEach(() => {
  setSystemTime();
  for (const store of stores.splice(0)) store.close();
});

test("send, poll, and app queue session-bound conversation operations idempotently", async () => {
  const h = setup();
  for (const [path, body, prefix, content] of [
    ["/send", send, "send", { text: send.text, effect: "confetti", subject: "Hi" }],
    ["/poll", poll, "poll", { text: "", poll: { title: "Lunch?", options: ["Pizza", "Sushi"] } }],
    ["/app", app, "app", { text: "", app: { url: app.url, caption: "Tracker", subcaption: "Today", trailingCaption: "3",
      trailingSubcaption: "left", summary: "Open tracker" } }],
  ] as const) {
    const id = `${prefix}:${hash(body.dedupeKey)}`;
    const first = await h.post(path, body);
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ id, created: true });
    expect(h.store.getOperation(id) as unknown).toEqual({ id, kind: "conversation", ...content, sessionId: "current", generation: 5,
      state: "pending", attempts: 0 });
    expect(h.store.get<{ spec: string }>(`api:${prefix}:${id}`)).toBeDefined();
    const again = await h.post(path, body);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ id, created: false });
  }
  expect(h.store.pendingOutbox()).toHaveLength(3);
});

test("a rule-breaking /send gets one 422 and queues nothing; the retry queues", async () => {
  const logged: string[] = [];
  const h = setup({
    replyCheck: text => text.includes("Giardia") ? { rule: "banned", reason: 'this chat banned "giardia"' } : undefined,
    log: (event, code) => logged.push(`${event}:${code ?? ""}`),
  });
  const bad = { ...send, text: "Giardia again?", dedupeKey: "bad-1" };
  const bounced = await h.post("/send", bad);
  expect(bounced.status).toBe(422);
  expect(await bounced.json()).toEqual({ error: 'Nothing was sent: this chat banned "giardia". Rewrite and send again.' });
  expect(h.store.pendingOutbox()).toHaveLength(0);
  expect(logged).toEqual(["reply-bounced:banned"]);

  // Same turn, second try: the bounce window still holds, so the check is skipped and the send queues.
  const retry = await h.post("/send", { ...bad, text: "Got it, here is the answer.", dedupeKey: "bad-2" });
  expect(retry.status).toBe(202);
  expect(h.store.pendingOutbox()).toHaveLength(1);
  expect(logged).toEqual(["reply-bounced:banned"]);
});

test("an accepted rule-breaking send replays as 200 after the turn changes, and bounce state is untouched", async () => {
  const h = setup({ replyCheck: text => text.includes("Giardia") ? { rule: "banned", reason: 'this chat banned "giardia"' } : undefined });
  const ok = { ...send, text: "Hello there", dedupeKey: "replay-1" };
  expect((await h.post("/send", ok)).status).toBe(202);
  // The accepted text is then replayed with a banned word added to the same key: a conflict, not a bounce.
  const turn = () => h.store.set("activeTurn", { messageId: "m-2" });
  const bad = { ...send, text: "Giardia again", dedupeKey: "replay-2" };
  h.store.set("activeTurn", { messageId: "m-1" });
  const rejected = await h.post("/send", bad);
  expect(rejected.status).toBe(422);
  const bounceBefore = h.store.get<unknown>("reply-bounce");
  // Identical replay after the turn changed and the bounce window would have expired.
  turn();
  const replay = await h.post("/send", ok);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual({ id: `send:${hash("replay-1")}`, created: false });
  expect(h.store.get<unknown>("reply-bounce")).toEqual(bounceBefore);
  // A different text under an accepted key is a conflict (409) and records no bounce.
  const conflict = await h.post("/send", { ...ok, text: "Giardia changed it" });
  expect(conflict.status).toBe(409);
  expect(h.store.get<unknown>("reply-bounce")).toEqual(bounceBefore);
});

test("app cards are refused in a group chat with a reason, while send still queues there", async () => {
  const h = setup();
  h.state.chat = "group:GRP-1";
  const refused = await h.post("/app", app);
  expect(refused.status).toBe(422);
  expect(await refused.json()).toEqual({ error: GROUP_APP_REFUSAL });
  expect(h.store.pendingOutbox()).toEqual([]);
  expect((await h.post("/send", send)).status).toBe(202);
});

test("optional send and app fields are omitted rather than stored as blanks", async () => {
  const h = setup();
  const minimal = await h.post("/send", { text: "plain", dedupeKey: "m", sessionId: "current" });
  expect(minimal.status).toBe(202);
  const op = h.store.getOperation(`send:${hash("m")}`)!;
  expect("effect" in op || "subject" in op).toBe(false);
  expect((await h.post("/app", { url: "https://x.test", caption: "c", dedupeKey: "a", sessionId: "current" })).status).toBe(202);
  expect(h.store.getOperation(`app:${hash("a")}`)?.app).toEqual({ url: "https://x.test", caption: "c" });
});

test("changed content under the same dedupe key, or a stale route, is rejected without writes", async () => {
  const h = setup();
  expect((await h.post("/send", send)).status).toBe(202);
  expect((await h.post("/poll", poll)).status).toBe(202);
  const snapshot = () => ({ outbox: h.store.db.query("SELECT * FROM outbox").all(), kv: h.store.db.query("SELECT * FROM kv").all() });
  const before = snapshot();
  for (const [path, body] of [["/send", { ...send, text: "other" }], ["/send", { ...send, effect: "slam" }],
    ["/poll", { ...poll, options: ["Pizza", "Tacos"] }]] as const) {
    expect((await h.post(path, body)).status).toBe(409);
  }
  expect(snapshot()).toEqual(before);
  for (const route of [null, { id: "other", generation: 5 }, { id: "current", generation: -1 }, { id: "current", generation: 1.5 }]) {
    h.store.set("route", route);
    expect((await h.post("/send", { ...send, dedupeKey: "new" })).status).toBe(409);
    expect((await h.post("/poll", { ...poll, dedupeKey: "new" })).status).toBe(409);
    expect((await h.post("/app", { ...app, dedupeKey: "new" })).status).toBe(409);
  }
  expect(h.store.pendingOutbox()).toHaveLength(2);
});

test("readiness and Origin gates apply to the new routes", async () => {
  const h = setup();
  h.state.enabled = false;
  for (const [path, body] of [["/send", send], ["/poll", poll], ["/app", app]] as const) {
    expect((await h.post(path, body)).status).toBe(503);
    const origin = await h.api(new Request(`http://bridge${path}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://x" }, body: JSON.stringify(body) }));
    expect(origin.status).toBe(403);
    expect((await h.api(new Request(`http://bridge${path}`))).status).toBe(404);
  }
  expect(h.store.pendingOutbox()).toEqual([]);
});

test("validation rejects malformed send, poll, and app bodies", async () => {
  const h = setup();
  const invalid: [string, Record<string, unknown>][] = [
    ["/send", { ...send, text: "" }], ["/send", { ...send, text: " " }], ["/send", { ...send, text: "x".repeat(12_001) }],
    ["/send", { ...send, effect: "rainbow" }], ["/send", { ...send, effect: "toString" }], ["/send", { ...send, subject: "a\nb" }],
    ["/send", { ...send, subject: "" }], ["/send", { ...send, sessionId: undefined }], ["/send", { ...send, sessionId: "a b" }],
    ["/send", { ...send, dedupeKey: "" }], ["/send", { ...send, replyTo: "x" }], ["/send", { ...send, generation: 1 }],
    ["/poll", { ...poll, options: ["only"] }], ["/poll", { ...poll, options: Array.from({ length: 13 }, (_, i) => `o${i}`) }],
    ["/poll", { ...poll, options: ["a", "x".repeat(101)] }], ["/poll", { ...poll, options: ["a", ""] }],
    ["/poll", { ...poll, options: ["a", 1] }], ["/poll", { ...poll, options: "a,b" }], ["/poll", { ...poll, options: ["a", "a"] }],
    ["/poll", { ...poll, title: "" }], ["/poll", { ...poll, title: "a\nb" }], ["/poll", { ...poll, sessionId: undefined }],
    ["/app", { ...app, url: "http://apps.test/" }], ["/app", { ...app, url: "file:///etc/passwd" }], ["/app", { ...app, url: "nope" }],
    ["/app", { ...app, url: "https://user:pw@apps.test/" }], ["/app", { ...app, caption: "" }], ["/app", { ...app, caption: undefined }],
    ["/app", { ...app, summary: "x".repeat(501) }], ["/app", { ...app, subcaption: 1 }], ["/app", { ...app, extra: "x" }],
  ];
  for (const [path, body] of invalid) {
    const response = await h.post(path, body);
    expect([path, response.status]).toEqual([path, 400]);
  }
  expect((await h.post("/poll", { ...poll, options: Array.from({ length: 12 }, (_, i) => `o${i}`), dedupeKey: "max" })).status).toBe(202);
  expect((await h.post("/send", { ...send, text: "\u{1F600}".repeat(6_000), dedupeKey: "big" })).status).toBe(202);
  expect(h.store.pendingOutbox()).toHaveLength(2);
});

test("health exposes only safe single-line apps fields", async () => {
  const h = setup();
  h.state.health = { appsUrl: "https://apps.test:18400", appsRoot: "/Users/x/.local/share/imessage-apps" };
  expect(await (await h.api(new Request("http://bridge/health"))).json()).toMatchObject(h.state.health);
  h.state.health = { appsUrl: { nested: true }, appsRoot: "bad\npath", appsPublicUrl: "https://legacy:8443" };
  const body = await (await h.api(new Request("http://bridge/health"))).json() as Record<string, unknown>;
  expect(body.appsUrl).toBeUndefined();
  expect(body.appsRoot).toBeUndefined();
  expect(body.appsPublicUrl).toBeUndefined();
});

test("wake queues one framed inbound row per dedupe key, following whatever session is live", async () => {
  const h = setup();
  const body = { text: "Nik replied: ordering today", source: "robob-watch nik-macbook", dedupeKey: "nik-macbook:3" };
  const id = `wake:${hash(body.dedupeKey)}`;
  const first = await h.post("/wake", body);
  expect(first.status).toBe(202);
  expect(await first.json()).toEqual({ id, created: true });
  // Not session-bound: a rotated or missing route still accepts it.
  h.store.set("route", null);
  const again = await h.post("/wake", body);
  expect(again.status).toBe(200);
  expect(await again.json()).toEqual({ id, created: false });
  expect((await h.post("/wake", { ...body, text: "changed" })).status).toBe(409);
  const rows = h.store.pendingInbound();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ id, state: "pending", payload: {
    id, text: "[Watcher event from robob-watch nik-macbook, not typed by the owner. Handle it; reply only if the owner needs to know or act now, otherwise log it to the activity log and end with NO_REPLY.]\nNik replied: ordering today",
    attachments: [], isAudioMessage: false, receivedAt: Date.parse("2026-09-10T00:00:00Z") } });
  expect(h.store.pendingOutbox()).toEqual([]);
});

test("wake is readiness-gated and validates its body", async () => {
  const h = setup();
  const body = { text: "event", source: "watch", dedupeKey: "k" };
  for (const invalid of [{ ...body, text: "" }, { ...body, text: "x".repeat(12_001) }, { ...body, source: "a\nb" },
    { ...body, source: "x".repeat(101) }, { ...body, source: undefined }, { ...body, dedupeKey: "" }, { ...body, sessionId: "current" }]) {
    expect((await h.post("/wake", invalid)).status).toBe(400);
  }
  h.state.enabled = false;
  expect((await h.post("/wake", body)).status).toBe(503);
  h.state.enabled = true;
  h.state.chat = undefined;
  expect((await h.post("/wake", body)).status).toBe(503);
  expect(h.store.pendingInbound()).toEqual([]);
});

test("reactions never target bridge-injected rows", async () => {
  const h = setup();
  expect((await h.post("/wake", { text: "event", source: "watch", dedupeKey: "k" })).status).toBe(202);
  expect((await h.post("/react", { target: `wake:${hash("k")}`, kind: "like" })).status).toBe(403);
});

test("the Photon API serves share routes only when the bridge owns tunnels, even while messaging is down", async () => {
  const h = setup();
  expect((await h.post("/shares", {})).status).toBe(404);
  const store = new Store(":memory:");
  stores.push(store);
  const shares = new Shares({ store, appsRoot: "/nonexistent-apps-root", startTunnel: async () => { throw new Error("unused"); } });
  const api = createApi({ store, photon: { async react() {} }, router: () => undefined, chatGuid: () => undefined, enabled: () => false,
    health: () => ({}), shares });
  const response = await api(new Request("http://bridge/shares", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ shares: [] });
  const missing = await api(new Request("http://bridge/share", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app: "trip" }) }));
  expect(missing.status).toBe(404);
});
