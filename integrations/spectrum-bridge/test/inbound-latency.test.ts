import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { OpenChamber, type MessageRecord, type SessionRecord } from "../src/openchamber.ts";
import { Router } from "../src/router.ts";
import { Store } from "../src/store.ts";
import type { ChatContext } from "../src/chats.ts";
import type { NormalizedInbound } from "../src/photon.ts";
import { toolLog } from "../src/toollog.ts";
import { captureReadTiming, completionChecked, includeReadTiming, startTickRead, tickRead, timeTick } from "../src/tick-timing.ts";
import { ControlClient } from "../src/control.ts";
import { captureLogs } from "./log-fixture.ts";
import { FAILED_INBOUND_REPLAY_MAX_AGE_MS } from "../src/inbound-failure.ts";

const hash = (id: string) => `msg_${createHash("sha256").update(id).digest("hex")}`;
const now = Date.parse("2026-11-13T10:00:00Z");
class Backend extends OpenChamber {
  steer?: ConstructorParameters<typeof Router>[1]["steer"];
  async sessionBusy() { return false; }
  prompts: string[] = [];
  targets: string[] = [];
  records: MessageRecord[] = [];
  unavailable = false;
  constructor() { super("http://127.0.0.1:1"); }
  override async request<T>(): Promise<T | undefined> { throw new Error("Unexpected backend call"); }
  override async createChat() { return { id: "ses_1", directory: "/Chats/ses_1" } as SessionRecord; }
  override async isSessionAutoAccepting() { return false; }
  override async permissions() { return []; }
  override async questions() { return []; }
  override async children() { return []; }
  override async statuses() { return {}; }
  override async getSession(id: string, directory: string) { return { id, directory, title: "Chat", time: { created: now, updated: now } } as SessionRecord; }
  override async messages() { return this.records; }
  override async promptAccepted(_id: string, _dir: string, id: string) { return this.records.some(r => r.id === id && r.type === "user"); }
  override async prompt(_id: string, _dir: string, id: string, text: string) {
    this.prompts.push(id);
    this.targets.push(_id);
    if (this.unavailable) throw new Error("unavailable");
    this.records.push({ id, type: "user", text, time: { created: Date.now() } });
  }
}
const stores: Store[] = [];
afterEach(() => { stores.splice(0).forEach(s => s.close()); setSystemTime(); });
function setup(slug = "owner", overrides: Partial<ConstructorParameters<typeof Router>[3]> = {}) {
  setSystemTime(now);
  const store = new Store(":memory:"); stores.push(store);
  const backend = new Backend();
  const logs: string[] = [], alerts: string[] = [];
  const ctx: ChatContext = {
    chat: { key: "dm:+15555550123", slug, kind: "dm", title: slug },
    roleOf: () => ({ role: "admin", name: slug }), typing: () => false, react: async () => {},
  };
  if (slug === "owner") ctx.chat.kind = "owner";
  const router = new Router(store, backend, { read: async () => {}, typing: async () => {}, downloadAttachment: async () => { throw new Error("unexpected file"); } }, {
    owner: "+15555550123", chatGuid: ctx.chat.key, timezone: "Asia/Dubai", skillPath: "/test/imessage/SKILL.md",
    alertSkillPath: "/test/telegram/SKILL.md", alertSocketPath: "/test/telegram.sock", openCodeConfigRoot: "/nonexistent/config", quietMs: 0,
    context: ctx, log: (event, code) => logs.push(`${event} ${code ?? ""}`), notifyFailure: async (_text, key) => { alerts.push(key); return true; }, ...overrides,
  });
  const input = (id: string, age = 120_000) => store.acceptInbound(id, { id, text: id, source: "typed", attachments: [], isAudioMessage: false, receivedAt: now - age } satisfies NormalizedInbound);
  const states = () => store.db.query<{ state: string }, []>("SELECT state FROM inbound ORDER BY rowid").all().map(r => r.state);
  return { store, backend, router, input, states, logs, alerts, ctx };
}

function stalledProbe(id = "stalled", age = 120_000, earlier: string[] = []) {
  const h = setup();
  h.input(id, age);
  const route = { id: "ses_original", directory: "/Chats/ses_original", generation: 1 };
  h.store.set("route", route);
  h.store.set(`failed-delivery:${id}`, { ...route, inboundId: id, messageId: hash(id), earlier, startedAt: now - age, phase: "unknown" });
  h.store.updateInbound(id, "processing");
  return h;
}
const probeTimeout = () => Object.assign(new Error("PRIVATE +971501234567 /Users/private/file https://private.test/?token=PRIVATE"), { name: "TimeoutError", code: "timeout" });

test("timed-out replay probes back off 1m to 10m then accept the original row", async () => {
  const h = stalledProbe("stalled", 120_000, ["older-private-id"]);
  const probes: string[] = [];
  let accepted = false;
  h.backend.promptAccepted = async (_session, _dir, id) => { probes.push(id); if (!accepted) throw probeTimeout(); return true; };
  let at = now;
  for (const delay of [60_000, 120_000, 240_000, 480_000, 600_000, 600_000]) {
    setSystemTime(at); await h.router.checkInboundLatency();
    const count = probes.length;
    expect(probes).toEqual(Array(count).fill(hash("stalled")));
    expect(h.states()).toEqual(["processing"]);
    setSystemTime(at + delay - 1); await h.router.checkInboundLatency();
    expect(probes).toHaveLength(count);
    at += delay + 1_000;
  }
  expect(probes).toHaveLength(6);
  accepted = true;
  setSystemTime(at); await h.router.checkInboundLatency();
  expect(probes).toHaveLength(7);
  expect(h.states()).toEqual(["done"]);
  expect(h.backend.prompts).toEqual([]);
});

test("replay catch records safe probe positions and a stable hashed row ref", async () => {
  const id = "PRIVATE +971501234567 /Users/private/file https://private.test/?token=PRIVATE";
  const h = stalledProbe(id, 120_000, ["PRIVATE_EARLIER"]);
  h.backend.promptAccepted = async () => { throw probeTimeout(); };
  const rows = await captureLogs(async () => {
    await h.router.checkInboundLatency();
    setSystemTime(now + 61_000); await h.router.checkInboundLatency();
  });
  const catches = rows.filter(row => row.error?.tag === "router.catch1");
  expect(catches).toHaveLength(2);
  for (const row of catches) expect(row).toMatchObject({
    ids: { inboundId: `row_${createHash("sha256").update(id).digest("hex").slice(0, 16)}` },
    props: { probeIndex: 0, probeCount: 2 }, error: { name: "TimeoutError", code: "timeout", causeKey: "code.timeout" },
  });
  expect(JSON.stringify(rows)).not.toMatch(/PRIVATE|971501234567|\/Users\/private|https:\/\//);
});

test("a non-timeout probe error still checks earlier ids without backing off", async () => {
  const h = stalledProbe("stalled", 120_000, ["earlier"]);
  const probes: string[] = [];
  h.backend.promptAccepted = async (_session, _dir, id) => {
    probes.push(id);
    if (id === hash("stalled")) throw new Error("backend error");
    return false;
  };
  await h.router.checkInboundLatency();
  setSystemTime(now + 1_000); await h.router.checkInboundLatency();
  expect(probes).toEqual([hash("stalled"), "earlier", hash("stalled"), "earlier"]);
});

test("a cooling row does not block a different row's acceptance", async () => {
  const h = stalledProbe();
  let probes = 0;
  h.backend.promptAccepted = async () => { probes++; throw probeTimeout(); };
  await h.router.checkInboundLatency();
  h.input("other");
  h.store.set("failed-delivery:other", { id: "ses_original", directory: "/Chats/ses_original", generation: 1,
    inboundId: "other", messageId: hash("other"), startedAt: now - 120_000, phase: "unknown" });
  h.store.updateInbound("other", "processing");
  h.backend.promptAccepted = async () => { probes++; return true; };
  setSystemTime(now + 1_000); await h.router.checkInboundLatency();
  expect(probes).toBe(2);
  expect(h.states()).toEqual(["processing", "done"]);
});

test("backoff leaves stuck-wake alerts active for every sealed member", async () => {
  const h = stalledProbe("wake:leader", 15 * 60_000);
  h.input("wake:member", 15 * 60_000);
  h.store.set("batch:wake:leader", { batchIds: ["wake:leader", "wake:member"] });
  h.store.updateInbound("wake:member", "batched");
  let probes = 0;
  h.backend.promptAccepted = async () => { probes++; throw probeTimeout(); };
  for (const minute of [0, 1, 3, 5, 6]) {
    setSystemTime(now + minute * 60_000); await h.router.checkInboundLatency();
  }
  expect(probes).toBe(3);
  expect(h.alerts).toEqual(["imessage-stuck-wake:wake:leader", "imessage-stuck-wake:wake:member"]);
  expect(h.states()).toEqual(["processing", "batched"]);
});

test("backoff ends before the replay horizon and an absent row still replays", async () => {
  const h = stalledProbe("deadline", FAILED_INBOUND_REPLAY_MAX_AGE_MS - 10 * 60_000 - 30_000);
  let probes = 0;
  let failing = true;
  h.backend.promptAccepted = async () => { probes++; if (failing) throw probeTimeout(); return false; };
  await h.router.checkInboundLatency();
  setSystemTime(now + 29_000); await h.router.checkInboundLatency();
  expect(probes).toBe(1);
  // The nominal minute backoff is cut short at ten minutes before expiry.
  setSystemTime(now + 30_000); await h.router.checkInboundLatency();
  expect(probes).toBe(2);
  failing = false;
  setSystemTime(now + 31_000); await h.router.checkInboundLatency();
  expect(probes).toBeGreaterThan(2);
  expect(h.states()).toEqual(["done"]);
  expect(h.backend.prompts).toEqual([hash("deadline")]);
});

test.each(["owner", "moni"])("inbound latency sweep wakes idle %s once using the row request id", async slug => {
  const h = setup(slug); h.input("idle");
  await h.router.checkInboundLatency(); setSystemTime(now + 1000); await h.router.checkInboundLatency();
  expect(h.backend.prompts).toEqual([hash("idle")]); expect(h.states()).toEqual(["done"]);
});

test("inbound latency sweep leaves other chats alone", async () => {
  const h = setup("guest"); h.input("idle"); await h.router.checkInboundLatency();
  expect(h.backend.prompts).toEqual([]); expect(h.states()).toEqual(["pending"]);
});

test.each(["failed", "interrupted", "succeeded"] as const)("batch admission retains latency receipts and the turn's %s outcome after recovery", async outcome => {
  const h = setup(); for (const [i, id] of ["a", "b", "c"].entries()) h.input(id, 2000 - i * 500);
  await h.router.tick(); expect(h.states()).toEqual(["done", "done", "done"]);
  expect(h.logs.filter(l => l.startsWith("inbound-latency"))).toEqual(["a", "b", "c"].map((id, i) =>
    `inbound-latency id=${id} receivedAt=${new Date(now - 2000 + i * 500).toISOString()} deliveredAt=${new Date(now).toISOString()} ms=${2000 - i * 500}`));
  h.backend.records.push({ id: "terminal", type: "idle", outcome, firstTurnFailure: outcome === "failed", time: { created: now } });
  await h.router.tick();
  const expected = outcome === "succeeded" ? "done" : "failed";
  expect(h.states()).toEqual([expected, expected, expected]);
  const failures = ["a", "b", "c"].map(id => h.store.inboundFailure(id));
  if (outcome !== "succeeded") for (const failure of failures) expect(failure).toMatchObject({ stage: "execution", threadId: "ses_1" });
  setSystemTime(now + 120_000);
  await h.router.checkInboundLatency();
  await h.router.checkFailedInbound();
  expect(h.states()).toEqual([expected, expected, expected]);
  expect(["a", "b", "c"].map(id => h.store.inboundFailure(id))).toEqual(failures);
  expect(h.backend.prompts).toEqual([hash("a")]);
  expect(h.logs.filter(l => l.startsWith("inbound-latency"))).toHaveLength(3);
});

test("legacy batched members are repaired without replaying their completed leader", async () => {
  const h = setup(); h.input("leader", 86400_000); h.input("member", 86400_000);
  h.store.set("batch:leader", { batchIds: ["leader", "member"] }); h.store.updateInbound("leader", "done"); h.store.updateInbound("member", "batched");
  await h.router.checkInboundLatency(); expect(h.states()).toEqual(["done", "done"]); expect(h.backend.prompts).toEqual([]);
});

test("batched wake is retried under its leader id once, then Telegram reports each stuck row once", async () => {
  const h = setup(); for (const id of ["wake:leader", "wake:member"]) h.input(id, 15 * 60_000);
  h.store.set("batch:wake:leader", { id: "wake:member", text: "background update", batchIds: ["wake:leader", "wake:member"], attachments: [], receivedAt: now - 15 * 60_000 });
  h.store.updateInbound("wake:leader", "processing"); h.store.updateInbound("wake:member", "batched");
  const route = { id: "ses_1", directory: "/Chats/ses_1", generation: 1 };
  h.store.set("route", route);
  h.store.set("failed-delivery:wake:leader", { ...route, inboundId: "wake:leader", messageId: hash("wake:leader"), startedAt: now - 15 * 60_000, phase: "unknown" });
  h.backend.unavailable = true;
  await h.router.checkInboundLatency(); expect(h.backend.prompts).toEqual([hash("wake:leader")]);
  setSystemTime(now + 1000); await h.router.checkInboundLatency(); expect(h.backend.prompts).toHaveLength(1);
  setSystemTime(now + 5 * 60_000); await h.router.checkInboundLatency();
  setSystemTime(now + 6 * 60_000); await h.router.checkInboundLatency();
  expect(h.alerts).toEqual(["imessage-stuck-wake:wake:leader", "imessage-stuck-wake:wake:member"]); expect(h.backend.prompts).toHaveLength(1);
});

test("admitted critical wake retains #932's alert without a stuck-wake duplicate", async () => {
  const h = setup(); h.input("wake:critical", 0);
  const payload = { id: "wake:critical", text: "[Watcher event from robob-watch money-cases, not typed by the owner.]\nEvent:\nPayment needs attention", attachments: [], isAudioMessage: false, receivedAt: now };
  h.store.updateInbound("wake:critical", "pending", payload);
  await h.router.tick();
  h.backend.records.push({ id: "failure", type: "idle", outcome: "failed", firstTurnFailure: true, time: { created: now } });
  await h.router.tick();
  setSystemTime(now + 120_000); await h.router.checkFailedInbound();
  setSystemTime(now + 21 * 60_000); await h.router.checkInboundLatency();
  expect(h.states()).toEqual(["failed"]); expect(h.alerts).toEqual(["bridge-failed:wake:critical"]);
});

test("latency receipt repair preserves an already failed batch member and its reason", async () => {
  const h = setup(); h.input("leader"); h.input("member");
  h.store.set("batch:leader", { batchIds: ["leader", "member"] });
  h.store.set("batch-phase:leader", "accepted");
  h.store.updateInbound("leader", "processing");
  const failure = { stage: "execution", message: "provider failed", threadId: "ses_1", at: now };
  h.store.updateInbound("member", "failed", undefined, failure);
  await h.router.checkInboundLatency();
  expect(h.states()).toEqual(["done", "failed"]);
  expect(h.store.inboundFailure("member")).toEqual(failure);
  expect(h.backend.prompts).toEqual([]);
});

test("three unaccepted wake members return to pending together on delivery failure", async () => {
  const h = setup(); for (const id of ["wake:a", "wake:b", "wake:c"]) h.input(id, 0);
  h.backend.unavailable = true;
  await h.router.tick();
  setSystemTime(now + 60_000); await h.router.tick();
  setSystemTime(now + 120_000); await h.router.tick();
  expect(h.states()).toEqual(["pending", "pending", "pending"]);
});

test("latency deadline overrides quiet extended by a later row", async () => {
  const h = setup(); h.input("old", 120_000); h.input("fresh", 0);
  h.ctx.typing = () => true;
  await h.router.checkInboundLatency();
  expect(h.backend.prompts).toEqual([hash("old")]); expect(h.states()).toEqual(["done", "done"]);
});

test("sweep does not replay an ancient orphan or a batch sent to an earlier route", async () => {
  const h = setup(); h.input("wake:ancient", 7 * 3600_000); h.input("moved", 120_000);
  h.store.set("failed-delivery:moved", { id: "old", directory: "/old", generation: 1, messageId: hash("moved"), phase: "unknown" });
  h.store.set("route", { id: "new", directory: "/new", generation: 2 });
  await h.router.checkInboundLatency(); expect(h.backend.prompts).toEqual([]);
});

test("a wake admitted after its retry is reconciled before the five-minute alert", async () => {
  const h = setup(); h.input("wake:late", 15 * 60_000); h.backend.unavailable = true;
  await h.router.checkInboundLatency(); expect(h.backend.prompts).toEqual([hash("wake:late")]);
  h.backend.records.push({ id: hash("wake:late"), type: "user", text: "late", time: { created: now } });
  setSystemTime(now + 5 * 60_000); await h.router.checkInboundLatency();
  expect(h.states()).toEqual(["done"]); expect(h.alerts).toEqual([]); expect(h.backend.prompts).toHaveLength(1);
});

test("an orphan without its original destination is reported without risking replay", async () => {
  const h = setup(); h.input("wake:unknown", 15 * 60_000); h.store.updateInbound("wake:unknown", "batched");
  await h.router.checkInboundLatency(); setSystemTime(now + 5 * 60_000); await h.router.checkInboundLatency();
  expect(h.backend.prompts).toEqual([]); expect(h.alerts).toEqual(["imessage-stuck-wake:wake:unknown"]);
});

test("failed leader stays owned by #932 and does not also earn a stuck-wake alert", async () => {
  const h = setup(); h.input("wake:failed", 15 * 60_000); h.input("wake:member", 15 * 60_000);
  h.store.set("batch:wake:failed", { batchIds: ["wake:failed", "wake:member"] });
  h.store.updateInbound("wake:failed", "failed"); h.store.updateInbound("wake:member", "batched");
  await h.router.checkInboundLatency(); setSystemTime(now + 5 * 60_000); await h.router.checkInboundLatency();
  expect(h.backend.prompts).toEqual([]); expect(h.alerts).toEqual([]);
});

test.each(["pending", "processing"])("latency recovery pins the original route and sealed members (%s)", async state => {
  const h = setup("owner", { rotateAfterMs: 1 }); h.input("original"); h.input("member"); h.input("newer", 0);
  const route = { id: "ses_original", directory: "/Chats/ses_original", generation: 1, createdAt: now - 10 * 3600_000 };
  h.store.set("route", route);
  h.store.set("failed-delivery:original", { ...route, inboundId: "original", messageId: hash("original"), startedAt: now - 120_000, phase: "unknown" });
  h.store.set("batch:original", { id: "member", text: "original\nmember", attachments: [], receivedAt: now - 120_000, batchIds: ["original", "member"] });
  h.store.updateInbound("original", state); h.store.updateInbound("member", "batched");
  await h.router.checkInboundLatency();
  expect(h.backend.targets).toEqual(["ses_original"]);
  expect(h.states()).toEqual(["done", "done", "pending"]);
});

test.each(["wake:late-leader", "late-leader"])("late receipt retains its snapshot members across a concurrent batch release (%s)", async leader => {
  const h = setup(); const wake = leader.startsWith("wake:"); const member = wake ? "wake:late-member" : "late-member";
  h.input(leader, 15 * 60_000); h.input(member, 15 * 60_000);
  const route = { id: "ses_original", directory: "/Chats/ses_original", generation: 1 };
  h.store.set("route", route);
  h.store.set(`failed-delivery:${leader}`, { ...route, inboundId: leader, messageId: hash(leader), startedAt: now - 15 * 60_000, phase: "unknown" });
  h.store.set(`batch:${leader}`, { batchIds: [leader, member] });
  h.store.updateInbound(leader, "processing"); h.store.updateInbound(member, "batched");
  if (wake) for (const id of [leader, member]) h.store.set(`stuck-wake-retry:${id}`, now - 5 * 60_000);
  h.backend.promptAccepted = async () => {
    h.store.set(`batch:${leader}`, null); h.store.updateInbound(leader, "pending"); h.store.updateInbound(member, "pending");
    return true;
  };
  await h.router.checkInboundLatency();
  expect(h.states()).toEqual(["done", "done"]); expect(h.alerts).toEqual([]); expect(h.backend.prompts).toEqual([]);
});

test.each(["read-error", "active-turn"])("requesting a wake retry does not spend its POST attempt while blocked by %s", async blocked => {
  const h = setup(); h.input("wake:blocked", 15 * 60_000);
  const route = { id: "ses_original", directory: "/Chats/ses_original", generation: 1 };
  h.store.set("route", route);
  h.store.set("failed-delivery:wake:blocked", { ...route, inboundId: "wake:blocked", messageId: hash("wake:blocked"), startedAt: now - 15 * 60_000, phase: "unknown" });
  h.store.set("batch:wake:blocked", { id: "wake:blocked", text: "update", attachments: [], receivedAt: now - 15 * 60_000, batchIds: ["wake:blocked"] });
  if (blocked === "read-error") h.backend.promptAccepted = async () => { throw new Error("unreadable"); };
  else h.store.set("activeTurn", { ...route, messageId: "busy", startedAt: now, phase: "running", background: true });
  await h.router.checkInboundLatency(); expect(h.backend.prompts).toEqual([]);
  expect(h.store.get("stuck-wake-attempt:wake:blocked")).toBeUndefined();
  h.backend.promptAccepted = async () => false; h.store.set("activeTurn", null);
  setSystemTime(now + 1000); await h.router.checkInboundLatency();
  expect(h.backend.prompts).toEqual([hash("wake:blocked")]); expect(h.backend.targets).toEqual(["ses_original"]);
});


describe("latency recovery races", () => {
const stamp = Date.parse('2026-11-13T10:00:00Z');
const hash = (id: string) => `msg_${createHash('sha256').update(id).digest('hex')}`;
const stores: Store[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); setSystemTime(); });
class Backend extends OpenChamber {
  records: MessageRecord[] = [];
  prompts: Array<{ session: string, id: string }> = [];
  creates = 0;
  lookup?: (session: string, id: string) => Promise<boolean>;
  unavailable = false;
  constructor() { super('http://127.0.0.1:1'); }
  override async request<T>(): Promise<T | undefined> { throw new Error('Unexpected backend call'); }
  override async createChat() { this.creates++; return { id: `ses_new_${this.creates}`, directory: '/Chats/new' } as SessionRecord; }
  override async isSessionAutoAccepting() { return false; }
  override async permissions() { return []; }
  override async questions() { return []; }
  override async children() { return []; }
  override async statuses() { return {}; }
  override async getSession(id: string, directory: string) { return { id, directory, title: 'Chat', time: { created: stamp, updated: stamp } } as SessionRecord; }
  override async messages() { return this.records; }
  override async promptAccepted(session: string, _dir: string, id: string) { return this.lookup ? this.lookup(session, id) : this.records.some(r => r.id === id && r.type === 'user'); }
  override async prompt(session: string, _dir: string, id: string, text: string) {
    this.prompts.push({ session, id });
    if (this.unavailable) throw new Error('unavailable');
    this.records.push({ id, type: 'user', text, time: { created: Date.now() } });
  }
}
function setup(replyMode?: "tool") {
  setSystemTime(stamp);
  const store = new Store(':memory:'); stores.push(store);
  const backend = new Backend();
  const alerts: string[] = [];
  let notify = async (_text: string, key: string) => { alerts.push(key); return true; };
  const ctx: ChatContext = { chat: { key: 'dm:+15555550123', slug: 'owner', kind: 'owner', title: 'owner' }, roleOf: () => ({ role: 'admin', name: 'owner' }), typing: () => false, react: async () => {} };
  const router = new Router(store, backend, { read: async () => {}, typing: async () => {}, downloadAttachment: async () => { throw new Error('unexpected'); } }, {
    owner: '+15555550123', chatGuid: ctx.chat.key, timezone: 'Asia/Dubai', skillPath: '/test/imessage/SKILL.md', alertSkillPath: '/test/telegram/SKILL.md', alertSocketPath: '/test/telegram.sock', openCodeConfigRoot: '/nonexistent/config', quietMs: 0, context: ctx, replyMode, notifyFailure: (text, key) => notify(text, key),
  });
  const add = (id: string, age = 15 * 60_000) => store.acceptInbound(id, { id, text: id, source: 'typed', attachments: [], isAudioMessage: false, receivedAt: stamp - age });
  const states = () => store.db.query<{ id: string, state: string }, []>('SELECT id, state FROM inbound ORDER BY rowid').all();
  const route = { id: 'ses_1', directory: '/Chats/ses_1', generation: 1 };
  const original = (id: string) => {
    store.set('route', route);
    store.set(`failed-delivery:${id}`, { ...route, inboundId: id, messageId: hash(id), startedAt: stamp - 15 * 60_000, phase: 'unknown' });
  };
  return { store, backend, router, alerts, add, states, original, route, setNotify: (fn: typeof notify) => { notify = fn; } };
}


test('a late batch receipt during the first alert must suppress alerts for its remaining members', async () => {
  const h = setup(); for (const id of ['wake:a', 'wake:b']) h.add(id);
  h.original('wake:a');
  h.store.updateInbound('wake:a', 'processing'); h.store.updateInbound('wake:b', 'batched');
  h.store.set('batch:wake:a', { id: 'wake:b', text: 'a\nb', batchIds: ['wake:a', 'wake:b'], attachments: [], receivedAt: stamp - 15 * 60_000 });
  h.store.set('stuck-wake-retry:wake:a', stamp); h.store.set('stuck-wake-retry:wake:b', stamp);
  h.store.set('stuck-wake-attempt:wake:a', stamp); h.store.set('stuck-wake-attempt:wake:b', stamp);
  h.setNotify(async (_text, key) => {
    h.alerts.push(key);
    h.backend.records.push({ id: hash('wake:a'), type: 'user', text: 'a\nb', time: { created: Date.now() } });
    return true;
  });
  setSystemTime(stamp + 5 * 60_000); await h.router.checkInboundLatency();
  expect(h.alerts).toEqual(['imessage-stuck-wake:wake:a']);
});
test('real timer order must preserve the original id while recovering an orphan wake', async () => {
  const h = setup(); h.add('wake:timer'); h.original('wake:timer');
  h.store.updateInbound('wake:timer', 'processing');
  h.store.set('batch:wake:timer', { id: 'wake:timer', text: 'background', batchIds: ['wake:timer'], attachments: [], receivedAt: stamp - 15 * 60_000 });
  h.store.set('synthetic-retry:wake:timer', { attempts: 0, nextAt: 0, prompts: [{ sessionId: h.route.id, directory: h.route.directory, generation: 1, messageId: hash('wake:timer'), startedAt: stamp - 15 * 60_000 }] });
  h.backend.unavailable = true;
  // Same call order as main.ts and sb-main.ts.
  await Promise.all([h.router.checkInboundLatency(), h.router.tick(), h.router.checkFailedInbound()]);
  setSystemTime(stamp + 30_000);
  await Promise.all([h.router.checkInboundLatency(), h.router.tick(), h.router.checkFailedInbound()]);
  expect(h.backend.prompts.map(p => p.id)).toEqual([hash('wake:timer')]);
});
test('sweep acceptance of a steer must preserve typed ownership of its watcher turn', async () => {
  const h = setup('tool');
  let entered!: () => void, release!: () => void;
  const seen = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  Object.assign(h.backend, { steer: async () => { entered(); await gate; return 'steered' as const; } });
  h.add('wake:active', 0); await h.router.tick();
  h.add('typed-steer', 120_000);
  const tick = h.router.tick(); await seen;
  h.backend.records.push({ id: hash('typed-steer'), type: 'user', text: 'typed-steer', time: { created: Date.now() } });
  await h.router.checkInboundLatency();
  release(); await tick;
  h.backend.records.push({ id: 'failure', type: 'idle', outcome: 'failed', time: { created: Date.now() } });
  await h.router.tick();
  const controls = h.store.pendingOutbox().filter(row => row.kind === 'control').map(row => row.text);
  expect(controls).toContain('Something went wrong on my end with that one. Mind trying again?');
});
test('a sweep replay started before six hours must stop retrying after its original horizon', async () => {
  const h = setup(); h.add('typed-expiring', (6 * 60 - 1) * 60_000); h.original('typed-expiring');
  h.store.updateInbound('typed-expiring', 'processing');
  h.store.set('batch:typed-expiring', { id: 'typed-expiring', text: 'old instruction', source: 'typed', batchIds: ['typed-expiring'], attachments: [], receivedAt: stamp - (6 * 60 - 1) * 60_000 });
  h.backend.unavailable = true;
  await h.router.checkInboundLatency();
  setSystemTime(stamp + 2 * 60_000); await h.router.tick();
  expect(h.backend.prompts).toHaveLength(1);
});
test.each([1, 2, 10])('numbered synthetic attempt %s receives its one same-id orphan retry', async number => {
  const h = setup(); const id = 'wake:numbered'; h.add(id); h.original(id);
  const messageId = hash(`${id}:${number}`);
  h.store.set(`failed-delivery:${id}`, { ...h.route, inboundId: id, messageId, startedAt: stamp - 15 * 60_000, phase: 'unknown' });
  h.store.set(`batch:${id}`, { id, text: 'background', attachments: [], receivedAt: stamp - 15 * 60_000, batchIds: [id] });
  h.store.set(`synthetic-retry:${id}`, { attempts: number, nextAt: 0, prompts: [{ sessionId: h.route.id, directory: h.route.directory, generation: 1, messageId, startedAt: stamp - 15 * 60_000 }] });
  h.store.updateInbound(id, 'processing');
  await Promise.all([h.router.checkInboundLatency(), h.router.tick(), h.router.checkFailedInbound()]);
  setSystemTime(stamp + 1000);
  await Promise.all([h.router.checkInboundLatency(), h.router.tick(), h.router.checkFailedInbound()]);
  expect(h.backend.prompts.map(p => p.id)).toEqual([messageId]);
});

test('the production timer must not POST further retries after its one stuck-wake attempt', async () => {
  const h = setup(); const id = 'wake:only-once'; h.add(id); h.original(id);
  h.store.updateInbound(id, 'processing');
  h.store.set(`batch:${id}`, { id, text: 'background', attachments: [], receivedAt: stamp - 15 * 60_000, batchIds: [id] });
  h.backend.unavailable = true;
  for (const elapsed of [0, 60_000, 120_000, 150_000, 210_000, 270_000, 300_000]) {
    setSystemTime(stamp + elapsed);
    await Promise.all([h.router.checkInboundLatency(), h.router.tick(), h.router.checkFailedInbound()]);
  }
  expect(h.backend.prompts).toHaveLength(1);
  expect(h.alerts).toEqual([`imessage-stuck-wake:${id}`]);
});

test.each(['wake:first-lookup', 'typed-first-lookup'])('slow earlier receipt %s protects every later batch before awaiting', async first => {
  const h = setup(); const leader = 'wake:later-batch'; const member = 'wake:later-member';
  for (const id of [first, leader, member]) h.add(id);
  h.original(first); h.original(leader);
  h.store.updateInbound(leader, 'processing'); h.store.updateInbound(member, 'batched');
  h.store.set(`synthetic-retry:${first}`, { attempts: 1, nextAt: stamp + 60_000, prompts: [] });
  h.store.set(`batch:${leader}`, { id: member, text: 'leader\nmember', batchIds: [leader, member], attachments: [], receivedAt: stamp - 15 * 60_000 });
  for (const id of [leader, member]) h.store.set(`synthetic-retry:${id}`, { attempts: 0, nextAt: 0, prompts: [{ sessionId: h.route.id, directory: h.route.directory, generation: 1, messageId: hash(leader), startedAt: stamp - 15 * 60_000 }] });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  h.backend.lookup = async (_session, id) => { if (id === hash(first)) { await gate; return false; } return id === hash(leader); };
  h.backend.records.push({ id: hash(leader), type: 'user', text: 'leader\nmember', time: { created: stamp } });
  const sweep = h.router.checkInboundLatency();
  await Promise.all([h.router.tick(), h.router.checkFailedInbound()]);
  const during = { states: h.states(), batch: h.store.get(`batch:${leader}`) };
  release(); await sweep;
  expect(h.states().filter(r => [leader, member].includes(r.id)).map(r => r.state)).toEqual(['done', 'done']);
});
});


test.each(["wake:slow", "typed:slow"])("later ambiguous body survives watchdog release behind %s", async first => {
  const h = setup(); const leader = "wake:active-leader"; const member = "wake:active-member";
  for (const id of [first, leader, member]) h.input(id, 15 * 60_000);
  const route = { id: "ses_original", directory: "/Chats/ses_original", generation: 1 };
  h.store.set("route", route);
  const original = (id: string) => ({ ...route, inboundId: id, messageId: hash(id), startedAt: now - 15 * 60_000, phase: "unknown", attempt: 2, attemptAt: now - 14 * 60_000 });
  h.store.set(`failed-delivery:${first}`, original(first));
  h.store.set(`failed-delivery:${leader}`, original(leader));
  h.store.set("activeTurn", original(leader));
  h.store.set(`batch:${leader}`, { id: member, text: `${leader}\n${member}`, batchIds: [leader, member], attachments: [], receivedAt: now - 15 * 60_000 });
  h.store.set(`batch-phase:${leader}`, "submitting");
  h.store.updateInbound(leader, "processing"); h.store.updateInbound(member, "batched");
  h.store.set(`synthetic-retry:${first}`, { attempts: 1, nextAt: now + 10 * 60_000, prompts: [] });
  for (const id of [leader, member]) h.store.set(`synthetic-retry:${id}`, { attempts: 0, nextAt: 0, prompts: [{ sessionId: route.id, directory: route.directory, generation: 1, messageId: hash(leader), startedAt: now - 15 * 60_000 }] });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  h.backend.promptAccepted = async (_session, _directory, id) => { if (id === hash(first)) await gate; return h.backend.records.some(r => r.id === id && r.type === "user"); };
  const sweep = h.router.checkInboundLatency();
  await h.router.tick();
  release(); await sweep;
  // A typed message has priority over the released wake; finish its run before checking the wake body.
  if (!first.startsWith("wake:")) h.backend.records.push({ id: "typed-finished", type: "idle", outcome: "succeeded", time: { created: now + 60_000 } });
  setSystemTime(now + 60_000);
  await Promise.all([h.router.checkInboundLatency(), h.router.tick(), h.router.checkFailedInbound()]);
  expect(h.backend.records.find(r => r.id === hash(leader))).toMatchObject({ text: `${leader}\n${member}` });
  expect(h.states().slice(1)).toEqual(["done", "done"]);
});


test.each([
  { slug: "owner", age: 0 }, { slug: "owner", age: 15 * 60_000 },
  { slug: "moni", age: 0 }, { slug: "moni", age: 15 * 60_000 },
])("admitted no-tool failures keep execution retries for %j", async ({ slug, age }) => {
  const h = setup(slug, { droppedBatchMs: 0 }); const id = "wake:admitted-provider-error"; h.input(id, age);
  if (age) {
    const route = { id: "ses_original", directory: "/Chats/ses_original", generation: 1 };
    h.store.set("route", route);
    h.store.set(`failed-delivery:${id}`, { ...route, inboundId: id, messageId: hash(id), startedAt: now - age, phase: "unknown" });
    h.store.set(`batch:${id}`, { id, text: id, source: "typed", attachments: [], isAudioMessage: false, receivedAt: now - age, batchIds: [id] });
    h.store.updateInbound(id, "processing");
  }
  await Promise.all([h.router.checkInboundLatency(), h.router.tick(), h.router.checkFailedInbound()]);
  expect(h.backend.prompts).toHaveLength(1);
  h.backend.records.push({ id: "provider-error", type: "assistant", agent: "build", model: { providerID: "test", id: "model" }, content: [], finish: "error", error: { type: "ProviderError", message: "unavailable" }, time: { created: now, completed: now } });
  h.backend.records.push({ id: "failed-idle", type: "idle", outcome: "failed", time: { created: now } });
  await h.router.tick();
  expect(h.states()).toEqual(["pending"]);
  setSystemTime(now + 120_000);
  await Promise.all([h.router.checkInboundLatency(), h.router.tick(), h.router.checkFailedInbound()]);
  if (age) {
    setSystemTime(now + 121_000);
    await Promise.all([h.router.checkInboundLatency(), h.router.tick(), h.router.checkFailedInbound()]);
  }
  expect(h.backend.prompts).toHaveLength(2);
});


test.each(["owner", "moni"])("an in-flight latency sweep must not re-adopt an admitted failed wake in %s", async slug => {
  const h = setup(slug, { droppedBatchMs: 0 });
  const id = "wake:admission-during-sweep";
  h.input(id, 15 * 60_000);
  h.backend.unavailable = true;
  await h.router.tick();
  expect(h.backend.prompts).toEqual([hash(id)]);
  expect(h.states()).toEqual(["processing"]);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let firstLookup = true;
  h.backend.promptAccepted = async (_session, _dir, messageId) => {
    if (messageId === hash(id) && firstLookup) { firstLookup = false; await gate; }
    return h.backend.records.some(r => r.id === messageId && r.type === "user");
  };
  const sweep = h.router.checkInboundLatency();
  h.backend.unavailable = false;
  h.backend.records.push({ id: hash(id), type: "user", text: id, time: { created: now } });
  h.backend.records.push({ id: "provider-error", type: "assistant", agent: "build", model: { providerID: "test", id: "model" }, content: [], finish: "error", error: { type: "ProviderError", message: "unavailable" }, time: { created: now, completed: now } });
  h.backend.records.push({ id: "failed-idle", type: "idle", outcome: "failed", time: { created: now } });
  await h.router.tick();
  expect(h.states()).toEqual(["pending"]);
  expect(h.store.get(`synthetic-retry:${id}`)).toMatchObject({ attempts: 1, reason: "errored" });
  release(); await sweep;
  setSystemTime(now + 120_000);
  await Promise.all([h.router.checkInboundLatency(), h.router.tick(), h.router.checkFailedInbound()]);
  expect(h.backend.prompts).toHaveLength(2);
  expect(h.store.get(`synthetic-retry:${id}`)).toMatchObject({ attempts: 1 });
});

function recoveredBatch(slug: string) {
  const h = setup(slug, { quietMs: undefined });
  h.input("recovered-a"); h.input("recovered-b");
  const route = { id: "ses_original", directory: "/Chats/ses_original", generation: 1 };
  const batch: NormalizedInbound = { id: "recovered-b", text: "recovered-a\nrecovered-b", source: "typed", attachments: [], isAudioMessage: false, receivedAt: now - 120_000, batchIds: ["recovered-a", "recovered-b"] };
  h.store.set("route", route);
  h.store.set("failed-delivery:recovered-a", { ...route, inboundId: "recovered-a", messageId: hash("recovered-a"), startedAt: now - 120_000, phase: "unknown" });
  h.store.set("batch:recovered-a", batch);
  h.store.updateInbound("recovered-a", "processing"); h.store.updateInbound("recovered-b", "batched");
  return { ...h, route, batch };
}

test.each(["owner", "moni"].flatMap(slug => [false, true].flatMap(busy => [0, 1_000].map(elapsed => ({ slug, busy, elapsed })))))
("latency recovery keeps its original members across a preparation arrival %j", async ({ slug, busy, elapsed }) => {
  const h = recoveredBatch(slug);
  let arrived = false;
  h.backend.statuses = async () => {
    if (!arrived && h.store.get("batch-phase:recovered-a") === "preparing") {
      arrived = true;
      h.input("newer-c", 0);
      return busy ? { [h.route.id]: { type: "busy" as const } } : {};
    }
    return {};
  };
  const accept = h.backend.prompt.bind(h.backend);
  h.backend.prompt = async (id, directory, messageId, text) => {
    // The original ambiguous A+B commits before this replay is handled.
    // Idempotency returns that original body even if the retry incorrectly appended C.
    await accept(id, directory, messageId, messageId === hash("recovered-a") ? h.batch.text : text);
  };
  const timer = () => Promise.all([h.router.checkInboundLatency(), h.router.tick(), h.router.checkFailedInbound()]);
  await timer();
  const sealedAfterArrival = h.store.get("batch:recovered-a");
  setSystemTime(now + elapsed);
  await timer();
  expect(arrived).toBe(true);
  expect(h.states()).toEqual(["done", "done", "pending"]);
  expect(h.backend.records.filter(r => r.type === "user")).toEqual([
    expect.objectContaining({ id: hash("recovered-a"), text: h.batch.text }),
  ]);
  expect(sealedAfterArrival).toEqual(h.batch);
  expect(h.store.get<NormalizedInbound>("batch:recovered-a")?.batchIds).toEqual(h.batch.batchIds);
  h.backend.records.push({ id: "original-finished", type: "idle", outcome: "succeeded", time: { created: now + 2_000 } });
  setSystemTime(now + 2_000);
  await timer();
  expect(h.states()).toEqual(["done", "done", "done"]);
  expect(h.backend.records.filter(r => r.type === "user")).toEqual([
    expect.objectContaining({ id: hash("recovered-a"), text: h.batch.text }),
    expect.objectContaining({ id: hash("newer-c"), text: "newer-c" }),
  ]);
});

test.each(["owner", "moni"].flatMap(slug => ["/status", "/new"].map(command => ({ slug, command }))))
("a control still interrupts recovery without unsealing its members %j", async ({ slug, command }) => {
  const h = recoveredBatch(slug);
  let arrived = false;
  h.backend.statuses = async () => {
    if (!arrived && h.store.get("batch-phase:recovered-a") === "preparing") {
      arrived = true;
      h.input(command, 0);
    }
    return {};
  };
  const timer = () => Promise.all([h.router.checkInboundLatency(), h.router.tick(), h.router.checkFailedInbound()]);
  await timer();
  expect(arrived).toBe(true);
  expect(h.backend.prompts).toEqual([]);
  expect(h.states()).toEqual(["pending", "batched", "pending"]);
  expect(h.store.get<NormalizedInbound>("batch:recovered-a")).toEqual(h.batch);
  setSystemTime(now + 1_000);
  await timer();
  if (command === "/new") {
    expect(h.states()).toEqual(["cancelled", "cancelled", "done"]);
    expect(h.backend.prompts).toEqual([]);
    return;
  }
  expect(h.states()).toEqual(["done", "done", "done"]);
  expect(h.backend.records.filter(r => r.type === "user")).toEqual([
    expect.objectContaining({ id: hash("recovered-a"), text: h.batch.text }),
  ]);
});

test.each(["none", "refused", "pending"] as const)("completion snapshot settles before a stalled status read with %s steer", async mode => {
  const h = setup(); h.input("first", 0); await h.router.tick();
  h.backend.messages = async () => [...h.backend.records];
  const entered = Promise.withResolvers<void>();
  const blocked = Promise.withResolvers<Record<string, never>>();
  const replied = Promise.withResolvers<void>();
  const log = h.router as unknown as { options: { log: (event: string, code?: string) => void } };
  const previous = log.options.log;
  log.options.log = (event, code) => { previous(event, code); if (event === "reply-enqueued") replied.resolve(); };
  let reads = 0;
  h.backend.sessionBusy = async () => {
    if (++reads === 1) { entered.resolve(); await blocked.promise; }
    return false;
  };
  if (mode !== "none") {
    h.input("followup", 0);
    h.backend.steer = async () => "refused";
    if (mode === "refused") {
      // A previous refusal leaves its sealed members queued during the cooldown.
      (h.router as unknown as { steerRefusedAt: number }).steerRefusedAt = now;
    }
  }
  const tick = h.router.tick();
  try {
    await entered.promise;
    setSystemTime(now + 1_000);
    h.backend.records = [...h.backend.records,
      { id: "answer-first", type: "assistant", content: [{ type: "text", text: "First answer" }], finish: "stop", time: { created: now, completed: now + 1_000 } },
      { id: "idle-first", type: "idle", outcome: "succeeded", completedAt: now + 1_000, time: { created: now + 1_000 } }];
    await h.router.checkCompletion();
    await replied.promise;
    expect(h.store.getOperation("reply:1:answer-first")?.state).toBe("pending");
    expect(h.logs.filter(line => line.startsWith("run-completed-seen"))).toHaveLength(1);
    // Required prompt admission stays serialized, but optional watch/discovery does not precede it.
    if (mode !== "none") {
      const admitted = Promise.withResolvers<void>();
      const prompt = h.backend.prompt.bind(h.backend);
      h.backend.prompt = async (...args) => { await prompt(...args); admitted.resolve(); };
      await admitted.promise;
      expect(h.backend.prompts).toEqual([hash("first"), hash("followup")]);
    }
  } finally {
    blocked.resolve({}); await tick;
  }
  await h.router.tick();
  expect(h.logs.filter(line => line.startsWith("run-completed-seen"))).toHaveLength(1);
  expect(h.backend.prompts.filter(id => id === hash("followup"))).toHaveLength(mode === "none" ? 0 : 1);
});

test("tick timing has a strict five-second threshold and records read order", async () => {
  let ms = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => ms);
  const write = spyOn(toolLog, "write").mockImplementation(() => {});
  try {
    await timeTick({ chat: "owner" }, async () => { ms = 5_000; });
    expect(write).not.toHaveBeenCalled();
    await timeTick({ chat: "owner" }, async () => {
      completionChecked(); ms = 10_001; tickRead("/threads", 5_001);
    });
    expect(write.mock.calls[0]![0]).toMatchObject({ name: "turn.tick_timing", durationMs: 5_001,
      props: { route: "/threads", slowestReadMs: 5_000, completionCheck: "before" } });
    await timeTick({ chat: "owner" }, async () => {
      ms = 16_002; tickRead("/threads/:id/messages", 10_001); completionChecked();
    });
    expect(write.mock.calls[1]![0]).toMatchObject({ props: { completionCheck: "after", slowestReadMs: 6_001 } });
  } finally { write.mockRestore(); clock.mockRestore(); }
});

test("late completion snapshots after a route rotation cannot reply or change the new route", async () => {
  const h = setup(); h.input("first", 0); await h.router.tick();
  const read = Promise.withResolvers<MessageRecord[]>();
  h.backend.messages = async () => read.promise;
  const pending = h.router.checkCompletion();
  const next = { id: "ses_2", directory: "/Chats/ses_2", generation: 2 };
  h.store.set("route", next); h.store.set("activeTurn", null);
  read.resolve([{ id: hash("first"), type: "user", text: "first", time: { created: now } },
    { id: "late-answer", type: "assistant", content: [{ type: "text", text: "old" }], time: { created: now, completed: now } },
    { id: "late-idle", type: "idle", outcome: "succeeded", time: { created: now } }]);
  await pending;
  expect(h.store.get<typeof next>("route")).toEqual(next);
  expect(h.store.get("activeTurn")).toBeNull();
  expect(h.logs.some(line => line.startsWith("run-completed-seen"))).toBeFalse();
  expect(h.store.getOperation("reply:1:late-answer")).toBeUndefined();
});

test("run-completed-seen records backend completion lag exactly once", async () => {
  const h = setup(); h.input("first", 0); await h.router.tick();
  setSystemTime(now + 2_000);
  h.backend.records.push({ id: "answer", type: "assistant", content: [{ type: "text", text: "Answer" }], finish: "stop", time: { created: now, completed: now + 500 } },
    { id: "idle", type: "idle", outcome: "succeeded", completedAt: now + 500, time: { created: now + 500 } });
  const write = spyOn(toolLog, "write").mockImplementation(() => {});
  try {
    await h.router.tick(); await h.router.tick();
    const seen = write.mock.calls.map(([entry]) => entry).filter(entry => entry.name === "run-completed-seen");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: "perf", props: { completionLagMs: 1_500 } });
  } finally { write.mockRestore(); }
});

test.each([false, true])("completion keeps uncertain steer readback and same-id ownership, accepted=%s", async accepted => {
  const h = setup(); h.input("first", 0); await h.router.tick();
  h.backend.sessionBusy = async () => true;
  let steerCalls = 0;
  h.backend.steer = async (_id, _directory, id, text) => {
    steerCalls++;
    if (steerCalls > 1) return "refused";
    if (accepted) h.backend.records.push({ id, type: "user", text, time: { created: now } });
    throw new Error("reply lost after POST");
  };
  h.input("followup", 0); await h.router.tick();
  h.backend.records = [...h.backend.records,
    { id: "answer", type: "assistant", content: [{ type: "text", text: "Answer" }], finish: "stop", time: { created: now, completed: now } },
    { id: "idle", type: "idle", outcome: "succeeded", time: { created: now } }];
  h.backend.sessionBusy = async () => false;
  await h.router.checkCompletion();
  await h.router.tick(); await h.router.tick();
  expect(h.store.getOperation("reply:1:answer")?.state).toBe("pending");
  expect(h.logs.filter(line => line.startsWith("run-completed-seen"))).toHaveLength(1);
  expect(h.states()).toEqual(["done", "done"]);
  expect(h.backend.prompts.filter(id => id === hash("followup"))).toHaveLength(accepted ? 0 : 1);
  expect(h.backend.records.filter(record => record.type === "user" && record.id === hash("followup"))).toHaveLength(1);
});

test.each([false, true])("uncertain steer with held acceptance notices and replies to the original once, late acceptance=%s", async lateAccepted => {
  const h = setup(); h.input("first", 0); await h.router.tick();
  h.backend.messages = async () => [...h.backend.records];
  h.backend.sessionBusy = async () => true;
  let steers = 0;
  h.backend.steer = async () => { steers++; throw new Error("POST outcome unknown"); };
  h.input("followup", 0); await h.router.tick();
  expect(h.store.get("steer-attempt:followup")).toBeDefined();
  const entered = Promise.withResolvers<void>(), receipt = Promise.withResolvers<boolean>();
  const replied = Promise.withResolvers<void>();
  const options = (h.router as unknown as { options: { log: (event: string, code?: string) => void } }).options;
  const log = options.log;
  options.log = (event, code) => { log(event, code); if (event === "reply-enqueued") replied.resolve(); };
  const accepted = h.backend.promptAccepted.bind(h.backend);
  let readbacks = 0;
  h.backend.promptAccepted = async (id, directory, prompt) => {
    if (prompt === hash("followup")) { readbacks++; entered.resolve(); return receipt.promise; }
    return accepted(id, directory, prompt);
  };
  const tick = h.router.tick();
  try {
    await entered.promise;
    setSystemTime(now + 1_000);
    h.backend.records.push(
      { id: "original-answer", type: "assistant", content: [{ type: "text", text: "First answer" }], finish: "stop", time: { created: now, completed: now + 1_000 } },
      { id: "original-idle", type: "idle", outcome: "succeeded", completedAt: now + 1_000, time: { created: now + 1_000 } });
    await h.router.checkCompletion();
    await replied.promise;
    expect(h.logs.filter(line => line.startsWith("run-completed-seen"))).toHaveLength(1);
    expect(h.store.getOperation("reply:1:original-answer")?.state).toBe("pending");
    expect(h.store.get("steer-attempt:followup")).toBeDefined();
    expect(h.states()).toEqual(["done", "processing"]);
    expect(h.backend.prompts).toEqual([hash("first")]);
    expect(steers).toBe(1);
    expect(readbacks).toBe(1);
  } finally {
    h.backend.sessionBusy = async () => false;
    if (lateAccepted) h.backend.records.push({ id: hash("followup"), type: "user", text: "followup", time: { created: now + 1_000 } });
    receipt.resolve(lateAccepted); await tick;
  }
  await h.router.tick();
  expect(h.backend.prompts.filter(id => id === hash("followup"))).toHaveLength(lateAccepted ? 0 : 1);
  expect(h.states()).toEqual(["done", "done"]);
  h.backend.records.push(
    { id: "followup-answer", type: "assistant", content: [{ type: "text", text: "Followup answer" }], finish: "stop", time: { created: now + 1_000, completed: now + 1_000 } },
    { id: "followup-idle", type: "idle", outcome: "succeeded", time: { created: now + 1_000 } });
  await h.router.tick(); await h.router.tick();
  expect(h.store.getOperation("reply:1:followup-answer")?.state).toBe("pending");
  expect(h.logs.filter(line => line.startsWith("run-completed-seen"))).toHaveLength(2);
  expect(h.backend.records.filter(record => record.id === hash("followup"))).toHaveLength(1);
  expect(steers).toBe(1);
});

test.each([true, false])("independent completion GET timing reaches its consuming tick, ok=%s", async ok => {
  const h = setup(); h.input("first", 0); await h.router.tick();
  h.backend.records.push(
    { id: "answer", type: "assistant", content: [{ type: "text", text: "Answer" }], finish: "stop", time: { created: now, completed: now } },
    { id: "idle", type: "idle", outcome: "succeeded", time: { created: now } });
  const response = Promise.withResolvers<Response>(), entered = Promise.withResolvers<void>();
  const client = new ControlClient({ url: "http://127.0.0.1:1", token: "test-token" });
  let ms = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => ms);
  const fetchResponse = Object.assign(() => { entered.resolve(); return response.promise; }, { preconnect: globalThis.fetch.preconnect });
  const fetch = spyOn(globalThis, "fetch").mockImplementation(fetchResponse);
  const write = spyOn(toolLog, "write").mockImplementation(() => {});
  h.backend.messages = async () => { await client.request("GET", "/threads/test/messages"); return [...h.backend.records]; };
  try {
    const producer = h.router.checkCompletion();
    await entered.promise;
    const tick = h.router.tick();
    ms = 6_001;
    response.resolve(Response.json({ ok }, { status: ok ? 200 : 503 }));
    await producer; await tick;
    const timing = write.mock.calls.map(([entry]) => entry).find(entry => entry.name === "turn.tick_timing");
    expect(timing).toMatchObject({ durationMs: 6_001,
      props: { route: "/threads/:id/messages", slowestReadMs: 6_001, completionCheck: ok ? "after" : "unchecked" } });
  } finally { write.mockRestore(); fetch.mockRestore(); clock.mockRestore(); }
});

test("a pending independent completion read is included when the consuming tick yields", async () => {
  let ms = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => ms);
  const write = spyOn(toolLog, "write").mockImplementation(() => {});
  const pending = Promise.withResolvers<void>();
  const producer = captureReadTiming(async () => {
    const finish = startTickRead("/threads/:id", performance.now());
    try { await pending.promise; } finally { finish(); }
  });
  try {
    await timeTick({ chat: "owner" }, async () => { includeReadTiming(producer.timing); ms = 6_001; });
    expect(write.mock.calls.map(([entry]) => entry).find(entry => entry.name === "turn.tick_timing"))
      .toMatchObject({ props: { route: "/threads/:id", slowestReadMs: 6_001, completionCheck: "unchecked" } });
  } finally { pending.resolve(); await producer.result; write.mockRestore(); clock.mockRestore(); }
});

test.each(["owner", "moni"].flatMap(slug => [true, false].map(bus => ({ slug, bus }))))(
  "stuck-wake alerts stay quiet for agent-bus traffic ($slug, bus=$bus)", async ({ slug, bus }) => {
    const h = setup(slug);
    const id = bus ? "wake:agent-bus:stuck" : "wake:watcher-stuck";
    h.input(id, 15 * 60_000);
    h.store.set(`stuck-wake-retry:${id}`, now - 5 * 60_000);
    h.store.set(`stuck-wake-attempt:${id}`, now - 5 * 60_000);
    await h.router.checkInboundLatency();
    expect(h.alerts).toEqual(bus ? [] : [`imessage-stuck-wake:${id}`]);
    expect(h.backend.prompts).toEqual([]);
  },
);
