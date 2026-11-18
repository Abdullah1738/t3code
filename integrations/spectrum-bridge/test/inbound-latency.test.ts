import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { OpenChamber, type MessageRecord, type SessionRecord } from "../src/openchamber.ts";
import { Router } from "../src/router.ts";
import { Store } from "../src/store.ts";
import type { ChatContext } from "../src/chats.ts";
import type { NormalizedInbound } from "../src/photon.ts";
import { toolLog } from "../src/toollog.ts";
import { captureReadTiming, completionChecked, includeReadTiming, startTickRead, tickRead, timeTick } from "../src/tick-timing.ts";
import { RobobBackend } from "../src/robob.ts";
import { ProbeBackoff, ProbeBudget } from "../src/probe-policy.ts";
import * as preferences from "../src/preferred-model.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlClient, ControlError } from "../src/control.ts";
import { BoundedTimeout } from "../src/bounded.ts";
import { PromptProbeTracker } from "../src/prompt-probe.ts";
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
  override async request<T>(..._args: Parameters<OpenChamber["request"]>): Promise<T | undefined> { throw new Error("Unexpected backend call"); }
  override async createChat() { return { id: "ses_1", directory: "/Chats/ses_1" } as SessionRecord; }
  override async isSessionAutoAccepting() { return false; }
  override async permissions() { return []; }
  override async questions() { return []; }
  override async children() { return []; }
  override async statuses() { return {}; }
  override async getSession(id: string, directory: string) { return { id, directory, title: "Chat", time: { created: now, updated: now } } as SessionRecord; }
  override async messages() { return this.records; }
  override async promptAccepted(_id: string, _dir: string, id: string) { return this.records.some(r => r.id === id && r.type === "user"); }
  override async prompt(...args: Parameters<OpenChamber["prompt"]>) {
    const [_id, _dir, id, text, , , , , beforeSend] = args;
    beforeSend?.();
    this.prompts.push(id);
    this.targets.push(_id);
    if (this.unavailable) throw new Error("unavailable");
    this.records.push({ id, type: "user", text, time: { created: Date.now() } });
  }
}
const stores: Store[] = [];
afterEach(() => { stores.splice(0).forEach(s => s.close()); setSystemTime(); });
function setup(slug = "owner", overrides: Partial<ConstructorParameters<typeof Router>[3]> = {}, path = ":memory:") {
  setSystemTime(now);
  let store = new Store(path); stores.push(store);
  const backend = new Backend();
  const logs: string[] = [], alerts: string[] = [];
  const ctx: ChatContext = {
    chat: { key: "dm:+15555550123", slug, kind: "dm", title: slug },
    roleOf: () => ({ role: "admin", name: slug }), typing: () => false, react: async () => {},
  };
  if (slug === "owner") ctx.chat.kind = "owner";
  const makeRouter = () => new Router(store, backend, { read: async () => {}, typing: async () => {}, downloadAttachment: async () => { throw new Error("unexpected file"); } }, {
    owner: "+15555550123", chatGuid: ctx.chat.key, timezone: "Asia/Dubai", skillPath: "/test/imessage/SKILL.md",
    alertSkillPath: "/test/telegram/SKILL.md", alertSocketPath: "/test/telegram.sock", openCodeConfigRoot: "/nonexistent/config", quietMs: 0,
    context: ctx, log: (event, code) => logs.push(`${event} ${code ?? ""}`), notifyFailure: async (_text, key) => { alerts.push(key); return true; }, ...overrides,
  });
  const router = makeRouter();
  const restart = () => {
    stores.splice(stores.indexOf(store), 1); store.close();
    store = new Store(path); stores.push(store);
    return makeRouter();
  };
  const input = (id: string, age = 120_000) => store.acceptInbound(id, { id, text: id, source: "typed", attachments: [], isAudioMessage: false, receivedAt: now - age } satisfies NormalizedInbound);
  const states = () => store.db.query<{ state: string }, []>("SELECT state FROM inbound ORDER BY rowid").all().map(r => r.state);
  return { get store() { return store; }, backend, router, input, states, logs, alerts, ctx, restart, makeRouter };
}

test.each([
  ["timeout", new BoundedTimeout(10_000)], ["http", new ControlError(503, "unavailable")],
  ["transport", new ControlError(0, "ECONNRESET")],
  ["http", Object.assign(new Error("OpenChamber request failed (HTTP 503)"), { status: 503 })],
] as const)("probe %s remains inconclusive and a later accepted check delivers without another POST", async (kind, error) => {
  const h = setup(); h.input("probe"); h.store.updateInbound("probe", "processing");
  const waitMs = 61_000;
  const route = { id: "ses_original", directory: "/Chats/ses_original", generation: 1 };
  h.store.set("route", route);
  h.store.set("failed-delivery:probe", { ...route, inboundId: "probe", messageId: hash("probe"), startedAt: now - 120_000, phase: "unknown" });
  h.backend.promptAccepted = async () => { throw error; };
  const rows = await captureLogs(async () => {
    await h.router.checkInboundLatency();
    expect(h.states()).toEqual(["processing"]);
    expect(h.backend.prompts).toEqual([]);
    h.backend.promptAccepted = async () => true;
    setSystemTime(now + 1000); await h.router.checkInboundLatency();
    expect(h.states()).toEqual(["processing"]);
    setSystemTime(now + waitMs); await h.router.checkInboundLatency();
  });
  expect(h.states()).toEqual(["done"]);
  expect(h.backend.prompts).toEqual([]);
  const catches = rows.filter(row => row.error?.tag === "router.catch1");
  expect(catches).toHaveLength(1);
  expect(catches[0].props).toMatchObject({ causeKind: kind, boundMs: 10_000, attempt: 1, route: "/prompt-acceptance" });
  expect(catches[0].error?.causeKey).toBe("prompt_acceptance_probe");
  const probes = rows.filter(row => row.name === "router.prompt_probes");
  expect(probes).toHaveLength(2);
  expect(probes.reduce((n, row) => n + row.promptProbe!.calls, 0)).toBe(2);
  expect(probes.reduce((n, row) => n + row.promptProbe!.accepted, 0)).toBe(1);
  expect(probes.reduce((n, row) => n + row.promptProbe![kind], 0)).toBe(1);
  expect(probes.flatMap(row => row.promptProbe!.attempts)).toEqual([[2, 1]]);
  expect(probes.flatMap(row => row.promptProbe!.msUntilAccepted)).toEqual([[120_000 + waitMs, 1]]);
});

test.each([
  { label: "root send", age: 120_000, attemptAge: undefined, steerAge: undefined, matches: true, expected: 120_000 },
  { label: "retried root", age: 3_600_000, attemptAge: 120_000, steerAge: undefined, matches: true, expected: 120_000 },
  { label: "earlier request id", age: 3_600_000, attemptAge: 120_000, steerAge: undefined, matches: true, expected: 3_600_000, earlier: true },
  { label: "steered follow-up", age: 3_600_000, attemptAge: 3_600_000, steerAge: 120_000, matches: true, expected: 120_000 },
  { label: "legacy root older than 24h", age: 108_000_000, attemptAge: undefined, steerAge: undefined, matches: true, expected: 108_000_000 },
  { label: "steer for a different route", age: 3_600_000, attemptAge: undefined, steerAge: 120_000, matches: false, expected: 3_600_000 },
])("probe latency uses the matching send timestamp: $label", async fixture => {
  const { age, attemptAge, steerAge, matches, expected } = fixture;
  const earlier = "earlier" in fixture && fixture.earlier;
  const h = setup(); h.input("probe"); h.store.updateInbound("probe", "processing");
  const route = { id: "ses_original", directory: "/Chats/ses_original", generation: 1 };
  h.store.set("route", route);
  h.store.set("failed-delivery:probe", { ...route, inboundId: "probe", messageId: hash("probe"), startedAt: now - age,
    ...(attemptAge === undefined ? {} : { attemptAt: now - attemptAge }), ...(earlier ? { earlier: ["msg_earlier"] } : {}), phase: "unknown" });
  if (steerAge !== undefined) h.store.set("steer-attempt:probe", { ...route, id: matches ? route.id : "ses_other", startedAt: now - steerAge });
  h.backend.promptAccepted = async (_id, _directory, messageId) => !earlier || messageId === "msg_earlier";
  const rows = await captureLogs(() => h.router.checkInboundLatency());
  expect(rows.find(row => row.promptProbe)?.promptProbe).toMatchObject({ calls: earlier ? 2 : 1, accepted: 1, msUntilAccepted: [[expected, 1]] });
  expect(h.states()).toEqual([steerAge !== undefined && matches ? "admitted" : "done"]);
  expect(h.backend.prompts).toEqual([]);
});

function stalledProbe(id = "stalled", age = 120_000, earlier: string[] = []) {
  const h = setup();
  h.input(id, age);
  const route = { id: "ses_original", directory: "/Chats/ses_original", generation: 1 };
  h.store.set("route", route);
  h.store.set(`failed-delivery:${id}`, { ...route, inboundId: id, messageId: hash(id), earlier, startedAt: now - age, phase: "unknown" });
  h.store.updateInbound(id, "processing");
  return h;
}
const probeTimeout = () => Object.assign(new BoundedTimeout(10_000), { message: "PRIVATE +971501234567 /Users/private/file https://private.test/?token=PRIVATE" });

test.each(["leader", "prompt", "budget"] as const)("a %s fence skips probe telemetry and acceptance attempts", async fence => {
  const h = stalledProbe();
  const policy = new ProbeBackoff(h.store);
  const promptKey = `prompt:ses_original:${hash("stalled")}`;
  const key = fence === "prompt" ? promptKey : "stalled";
  policy.reserve(key); policy.failed(key);
  if (fence === "budget") {
    setSystemTime(now + 60_000);
    const budget = new ProbeBudget(h.store);
    for (let i = 0; i < 60; i++) expect(budget.take()).toBe(true);
  }
  let calls = 0;
  h.backend.promptAccepted = async () => { calls++; return true; };
  const skipped = await captureLogs(() => h.router.checkInboundLatency());
  expect(calls).toBe(0);
  expect(skipped.filter(row => row.promptProbe || row.error?.tag === "router.catch1")).toEqual([]);
  expect(h.states()).toEqual(["processing"]);
  setSystemTime(now + 121_000);
  const accepted = await captureLogs(() => h.router.checkInboundLatency());
  expect(calls).toBe(1);
  expect(accepted.find(row => row.promptProbe)?.promptProbe).toMatchObject({ calls: 1, accepted: 1, attempts: [[1, 1]] });
  expect(h.states()).toEqual(["done"]);
});

test("a late failed probe keeps its control error owner without restoring split leases", async () => {
  const h = stalledProbe("wake:leader", 20 * 60_000);
  const policy = new ProbeBackoff(h.store);
  policy.reserve("wake:leader"); policy.failed("wake:leader");
  setSystemTime(now + 60_000);
  const entered = Promise.withResolvers<void>(), response = Promise.withResolvers<Response>();
  const fetcher = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => {
    entered.resolve(); return response.promise;
  }, { preconnect: globalThis.fetch.preconnect }));
  try {
    const client = new ControlClient({ url: "http://127.0.0.1:3773", token: "PRIVATE_TOKEN" });
    h.backend.promptAccepted = async () => { await client.request("GET", "/threads/ses_original/messages"); return false; };
    let result: Awaited<ReturnType<typeof toolLog.rollup>>;
    const rows = await captureLogs(async () => {
      const scan = h.router.checkInboundLatency();
      await entered.promise;
      policy.split("wake:leader", ["wake:leader", "wake:member"]);
      const leader = policy.get("wake:leader"), member = policy.get("wake:member");
      response.resolve(new Response(JSON.stringify({ ok: false }), { status: 503 }));
      await scan;
      expect(policy.get("wake:leader")).toEqual(leader);
      expect(policy.get("wake:member")).toEqual(member);
      toolLog.flush();
      result = await toolLog.rollup(new Date().toISOString().slice(0, 10));
    });
    expect(rows.find(row => row.promptProbe)?.promptProbe).toMatchObject({ calls: 1, http: 1, httpByStatus: { "503": 1 } });
    expect(rows.find(row => row.error?.tag === "router.catch1")).toMatchObject({ alreadyLogged: true,
      props: { causeKind: "http", attempt: 1 }, error: { name: "ControlError", causeKey: "prompt_acceptance_probe", status: 503 } });
    expect(result!).toMatchObject({ failed: 1, dedupedFailures: 1 });
    expect(result!.errorRate).toBe(1 / result!.total);
    expect(result!.topErrorTags).toEqual([expect.objectContaining({ tag: "control.request_failed", count: 1 })]);
    expect(h.backend.prompts).toEqual([]);
    expect(JSON.stringify(rows)).not.toContain("PRIVATE_");
  } finally { fetcher.mockRestore(); }
});

test.each([true, false])("telemetry exceptions leave probe admission unchanged (accepted=%s)", async accepted => {
  const h = stalledProbe();
  const tracker = spyOn(PromptProbeTracker.prototype, "start").mockImplementation(() => { throw new Error("PRIVATE_TELEMETRY"); });
  h.backend.promptAccepted = async () => { if (!accepted) throw new ControlError(503); return true; };
  try {
    await h.router.checkInboundLatency();
    expect(h.states()).toEqual([accepted ? "done" : "processing"]);
    expect(h.backend.prompts).toEqual([]);
    expect(new ProbeBackoff(h.store).cooling("stalled")).toBe(!accepted);
  } finally { tracker.mockRestore(); }
});

test.each(["absent", "503"] as const)("a late %s leader read cannot settle split member history", async outcome => {
  const h = stalledProbe("wake:leader", 20 * 60_000);
  const policy = new ProbeBackoff(h.store);
  policy.reserve("wake:leader"); policy.failed("wake:leader");
  setSystemTime(now + 60_000);
  const entered = Promise.withResolvers<void>(), read = Promise.withResolvers<boolean>();
  h.backend.promptAccepted = async () => { entered.resolve(); return read.promise; };
  const scan = h.router.checkInboundLatency();
  await entered.promise;
  policy.split("wake:leader", ["wake:leader", "wake:member"]);
  const leader = policy.get("wake:leader"), member = policy.get("wake:member");
  if (outcome === "absent") read.resolve(false);
  else read.reject(new ControlError(503, "offline"));
  await scan;
  expect(policy.get("wake:leader")).toEqual(leader);
  expect(policy.get("wake:member")).toEqual(member);
  expect(policy.cooling("wake:member")).toBe(true);
  expect(policy.retry("wake:member")).toBe(true);
  expect(h.backend.prompts).toEqual([]);
});

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
  expect(rows.filter(row => row.name === "router.probe_backoff").map(row => row.props?.waitMs)).toEqual([60_000, 120_000]);
  for (const row of catches) expect(row).toMatchObject({
    ids: { inboundId: `row_${createHash("sha256").update(id).digest("hex").slice(0, 16)}` },
    props: { probeIndex: 0, probeCount: 2, causeKind: "timeout" }, error: { name: "BoundedTimeout", code: "ETIMEDOUT", causeKey: "prompt_acceptance_probe" },
  });
  expect(JSON.stringify(rows)).not.toMatch(/PRIVATE|971501234567|\/Users\/private|https:\/\//);
});

test("a non-timeout probe error cools the leader and all earlier ids", async () => {
  const h = stalledProbe("stalled", 120_000, ["earlier"]);
  const probes: string[] = [];
  h.backend.promptAccepted = async (_session, _dir, id) => { probes.push(id); throw new ControlError(503); };
  await h.router.checkInboundLatency();
  setSystemTime(now + 1_000); await h.router.checkInboundLatency();
  expect(probes).toEqual([hash("stalled")]);
  setSystemTime(now + 60_000); await h.router.checkInboundLatency();
  expect(probes).toEqual([hash("stalled"), hash("stalled")]);
  expect(h.backend.prompts).toEqual([]);
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

test("near-deadline probes respect the full cooldown before an absent row replays", async () => {
  const h = stalledProbe("deadline", FAILED_INBOUND_REPLAY_MAX_AGE_MS - 10 * 60_000 - 30_000);
  let probes = 0;
  let failing = true;
  h.backend.promptAccepted = async () => { probes++; if (failing) throw probeTimeout(); return false; };
  await h.router.checkInboundLatency();
  setSystemTime(now + 29_000); await h.router.checkInboundLatency();
  expect(probes).toBe(1);
  // Crossing into the final ten minutes cannot shorten a failed read cooldown.
  setSystemTime(now + 30_000); await h.router.checkInboundLatency();
  expect(probes).toBe(1);
  failing = false;
  setSystemTime(now + 60_000); await h.router.checkInboundLatency();
  expect(probes).toBe(2);
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
  setSystemTime(now + (blocked === "read-error" ? 60_000 : 1000)); await h.router.checkInboundLatency();
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
  override async request<T>(..._args: Parameters<OpenChamber["request"]>): Promise<T | undefined> { throw new Error('Unexpected backend call'); }
  override async createChat() { this.creates++; return { id: `ses_new_${this.creates}`, directory: '/Chats/new' } as SessionRecord; }
  override async isSessionAutoAccepting() { return false; }
  override async permissions() { return []; }
  override async questions() { return []; }
  override async children() { return []; }
  override async statuses() { return {}; }
  override async getSession(id: string, directory: string) { return { id, directory, title: 'Chat', time: { created: stamp, updated: stamp } } as SessionRecord; }
  override async messages() { return this.records; }
  override async promptAccepted(session: string, _dir: string, id: string) { return this.lookup ? this.lookup(session, id) : this.records.some(r => r.id === id && r.type === 'user'); }
  override async prompt(...args: Parameters<OpenChamber["prompt"]>) {
    const [session, _dir, id, text, , , , , beforeSend] = args;
    beforeSend?.();
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
test('the latency sweep leaves human work queued until its watcher turn ends', async () => {
  const h = setup('tool');
  const steers: string[] = [];
  Object.assign(h.backend, { steer: async (_id: string, _dir: string, id: string) => { steers.push(id); return 'steered' as const; } });
  h.add('wake:active', 0); await h.router.tick();
  h.add('typed-steer', 120_000);
  await h.router.tick();
  await h.router.checkInboundLatency();
  expect(steers).toEqual([]);
  expect(h.states().find(row => row.id === 'typed-steer')?.state).toBe('pending');
  expect(h.backend.prompts.map(row => row.id)).toEqual([hash('wake:active')]);
  h.backend.records.push({ id: 'failure', type: 'idle', outcome: 'failed', time: { created: Date.now() } });
  await h.router.tick();
  await h.router.tick();
  expect(h.backend.prompts.map(row => row.id)).toEqual([hash('wake:active'), hash('typed-steer')]);
  expect(h.store.get<{ inboundId: string }>('activeTurn')?.inboundId).toBe('typed-steer');
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
  if (!first.startsWith("wake:")) h.backend.records.push(
    { id: "typed-answer", type: "assistant", content: [{ type: "text", text: "Answered" }], finish: "stop", time: { created: now + 60_000, completed: now + 60_000 } },
    { id: "typed-finished", type: "idle", outcome: "succeeded", time: { created: now + 60_000 } });
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
  expect(h.states()).toEqual(["done", "admitted"]);
  h.store.outboxState("reply:1:answer", "sent");
  expect(h.states()).toEqual(["done", accepted ? "done" : "admitted"]);
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
    expect(h.states()).toEqual(["done", "pending"]);
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
  expect(h.states()).toEqual(["done", "admitted"]);
  h.backend.records.push(
    { id: "followup-answer", type: "assistant", content: [{ type: "text", text: "Followup answer" }], finish: "stop", time: { created: now + 1_000, completed: now + 1_000 } },
    { id: "followup-idle", type: "idle", outcome: "succeeded", time: { created: now + 1_000 } });
  await h.router.tick(); await h.router.tick();
  expect(h.store.getOperation("reply:1:followup-answer")?.state).toBe("pending");
  h.store.outboxState("reply:1:followup-answer", "sent");
  expect(h.states()).toEqual(["done", "done"]);
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

test.each([
  ["router timeout", () => probeTimeout()], ["HTTP 503", () => new ControlError(503)],
  ["network ControlError", () => new ControlError(0)], ["other HTTP error", () => new ControlError(409)],
  ["generic read failure", () => new Error("failed read")],
] as const)("%s cooldown persists across store reopen, requeue, and timer paths", async (_name, error) => {
  const root = mkdtempSync(join(tmpdir(), "probe-restart-"));
  let h: ReturnType<typeof setup> | undefined;
  try {
    h = setup("owner", {}, join(root, "test.sqlite")); h.input("leader");
    const turn = { id: "ses_original", directory: "/Chats/ses_original", generation: 1,
      inboundId: "leader", messageId: hash("leader"), startedAt: now - 120_000, phase: "unknown" };
    h.store.set("route", turn); h.store.set("failed-delivery:leader", turn); h.store.updateInbound("leader", "processing");
    let probes = 0;
    h.backend.promptAccepted = async () => { probes++; throw error(); };
    await h.router.checkInboundLatency(); const restarted = h.restart();
    for (const at of [1_000, 30_000, 59_000]) {
      setSystemTime(now + at); restarted.requeueHuman("leader", "watchdog_overdue");
      await restarted.checkInboundLatency(); await restarted.checkFailedInbound(); await restarted.tick();
      expect(probes).toBe(1); expect(h.backend.prompts).toEqual([]);
    }
    h.backend.promptAccepted = async () => { probes++; return true; };
    setSystemTime(now + 60_000); await restarted.checkInboundLatency();
    expect(probes).toBe(2); expect(h.states()).toEqual(["admitted"]); expect(h.backend.prompts).toEqual([]);
    expect(h.store.get<{ covered: string[] }>("activeTurn")?.covered).toEqual(["leader"]);
    expect((JSON.parse(h.store.db.query<{ payload: string }, []>("SELECT payload FROM inbound WHERE id = 'leader'").get()!.payload) as NormalizedInbound & { answeredAt?: number }).answeredAt).toBeUndefined();
  } finally {
    if (h) { stores.splice(stores.indexOf(h.store), 1); h.store.close(); }
    rmSync(root, { recursive: true, force: true });
  }
});

test("fourteen fresh failures probe at their deadline despite an exhausted retry budget", async () => {
  const h = setup(); const budget = new ProbeBudget(h.store);
  for (let i = 0; i < 60; i++) expect(budget.take()).toBe(true);
  const route = { id: "ses_original", directory: "/Chats/ses_original", generation: 1 }; h.store.set("route", route);
  const starts: number[] = [];
  for (let i = 0; i < 14; i++) {
    const id = `leader-${i}`; h.input(id);
    h.store.set(`failed-delivery:${id}`, { ...route, inboundId: id, messageId: hash(id), startedAt: now - 120_000, phase: "unknown" });
    h.store.updateInbound(id, "processing");
  }
  h.backend.promptAccepted = async () => { starts.push(Date.now()); throw new ControlError(503); };
  await h.router.checkInboundLatency(); expect(starts).toEqual(Array(14).fill(now));
  for (let second = 1; second < 60; second++) {
    setSystemTime(now + second * 1_000); await h.router.checkInboundLatency(); await h.router.tick();
  }
  expect(starts).toHaveLength(14); expect(h.backend.prompts).toEqual([]);
});

test("fourteen ten-second timeout probes stay within sixty starts per rolling minute", async () => {
  const h = setup(); const starts: number[] = [];
  const route = { id: "ses_original", directory: "/Chats/ses_original", generation: 1 }; h.store.set("route", route);
  for (let i = 0; i < 14; i++) {
    const id = `slow-${i}`; h.input(id);
    h.store.set(`failed-delivery:${id}`, { ...route, inboundId: id, messageId: hash(id), startedAt: now - 120_000, phase: "unknown" });
    h.store.updateInbound(id, "processing");
  }
  h.backend.promptAccepted = async () => { starts.push(Date.now()); setSystemTime(Date.now() + 10_000); throw probeTimeout(); };
  for (let scan = 0; scan < 8; scan++) { setSystemTime(Date.now() + 1_000); await h.router.checkInboundLatency(); }
  expect(starts.length).toBeGreaterThanOrEqual(14);
  for (const at of starts) expect(starts.filter(start => start >= at && start < at + 60_000).length).toBeLessThanOrEqual(60);
  expect(h.backend.prompts).toEqual([]);
});

test("a cooling row and exhausted probe budget do not delay the unanswered alarm", async () => {
  const alerts: number[] = [];
  const h = setup("owner", { notifyUnanswered: async () => { alerts.push(Date.now()); return true; } });
  h.input("alarm", 10 * 60_000 - 1_000);
  const route = { id: "ses_original", directory: "/Chats/ses_original", generation: 1 }; h.store.set("route", route);
  h.store.set("failed-delivery:alarm", { ...route, inboundId: "alarm", messageId: hash("alarm"), startedAt: now - 599_000, phase: "unknown" });
  h.store.updateInbound("alarm", "processing"); h.backend.promptAccepted = async () => { throw new ControlError(503); };
  await h.router.checkInboundLatency(); const budget = new ProbeBudget(h.store);
  while (budget.take()) {}
  await h.router.checkUnanswered(); expect(alerts).toEqual([]);
  setSystemTime(now + 1_000); await h.router.checkUnanswered();
  expect(alerts).toEqual([now + 1_000]); expect(h.backend.prompts).toEqual([]);
});

test("failure on the second prompt preserves the whole leader's exponential cooldown", async () => {
  const h = stalledProbe("multi", 120_000, ["earlier"]);
  const starts: { at: number; id: string }[] = [];
  h.backend.promptAccepted = async (_session, _dir, id) => {
    starts.push({ at: Date.now(), id });
    if (id === "earlier") throw new ControlError(503);
    return false;
  };
  const rows = await captureLogs(async () => {
    for (const at of [0, 60_000, 180_000, 420_000]) {
      setSystemTime(now + at); await h.router.checkInboundLatency();
      const count = starts.length;
      setSystemTime(now + at + 59_000); await h.router.checkInboundLatency();
      expect(starts).toHaveLength(count);
    }
  });
  expect(starts).toEqual([0, 60_000, 180_000, 420_000].flatMap(at => [hash("multi"), "earlier"].map(id => ({ at: now + at, id }))));
  expect(rows.filter(row => row.name === "router.probe_backoff").map(row => row.props?.waitMs)).toEqual([60_000, 120_000, 240_000, 480_000]);
  expect(h.backend.prompts).toEqual([]);
});

test("eighty live first reads bypass the cap while failed retries share sixty per minute across restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "shared-probes-"));
  let budgetStore = new Store(join(root, "budget.sqlite"));
  try {
    const options = { probeBudget: new ProbeBudget(budgetStore) };
    const owner = setup("owner", options), moni = setup("moni", options);
    const starts: number[] = [];
    for (const [chat, h] of [["owner", owner], ["moni", moni]] as const) {
      const route = { id: `ses_${chat}`, directory: `/Chats/${chat}`, generation: 1 }; h.store.set("route", route);
      for (let i = 0; i < 40; i++) {
        const id = `${chat}-${i}`; h.input(id);
        h.store.set(`failed-delivery:${id}`, { ...route, inboundId: id, messageId: hash(id), startedAt: now - 120_000, phase: "unknown" });
        h.store.updateInbound(id, "processing");
      }
      h.backend.promptAccepted = async () => { starts.push(Date.now()); throw new ControlError(503); };
    }
    await Promise.all([owner.router.checkInboundLatency(), moni.router.checkInboundLatency()]);
    expect(starts).toEqual(Array(80).fill(now));
    setSystemTime(now + 60_000);
    await Promise.all([owner.router.checkInboundLatency(), moni.router.checkInboundLatency()]);
    expect(starts).toHaveLength(140);
    budgetStore.close(); budgetStore = new Store(join(root, "budget.sqlite"));
    options.probeBudget = new ProbeBudget(budgetStore);
    const routers = [owner.makeRouter(), moni.makeRouter()];
    for (const at of [61_000, 90_000, 119_999]) {
      setSystemTime(now + at); await Promise.all(routers.map(router => router.checkInboundLatency())); expect(starts).toHaveLength(140);
    }
    setSystemTime(now + 121_000); await Promise.all(routers.map(router => router.checkInboundLatency()));
    expect(starts.length).toBeGreaterThan(140);
    const retries = starts.slice(80);
    for (const at of retries) expect(retries.filter(start => start >= at && start < at + 60_000).length).toBeLessThanOrEqual(60);
    expect(owner.backend.prompts).toEqual([]); expect(moni.backend.prompts).toEqual([]);
  } finally { budgetStore.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a probe failing during wake preparation cannot spend the wake POST attempt", async () => {
  const id = "wake:preparation"; const h = stalledProbe(id, 15 * 60_000);
  const original = h.store.get("failed-delivery:" + id);
  h.store.set("latency-route:" + id, original);
  h.store.set("batch:" + id, { id, text: "update", attachments: [], receivedAt: now - 15 * 60_000, batchIds: [id] });
  h.store.set("batch-phase:" + id, "queued-steer"); h.store.updateInbound(id, "pending");
  h.store.set("stuck-wake-retry:" + id, now);
  const sibling = h.makeRouter(); let failed = false;
  h.backend.promptAccepted = async () => { throw new ControlError(503); };
  h.backend.statuses = async () => {
    if (!failed && h.store.get("batch-phase:" + id) === "preparing") { failed = true; await sibling.checkInboundLatency(); }
    return {};
  };
  await h.router.tick();
  expect(failed).toBe(true); expect(h.backend.prompts).toEqual([]);
  expect(h.store.get("stuck-wake-attempt:" + id)).toBeUndefined();
  setSystemTime(now + 60_000); h.backend.promptAccepted = async () => false;
  await h.router.tick(); expect(h.backend.prompts).toEqual([hash(id)]);
});

test("a probe failing during steer admission prevents its POST after a negative readback", async () => {
  const h = setup(); h.input("first", 0); await h.router.tick();
  const turn = h.store.get<{ id: string; directory: string; generation: number; messageId: string; startedAt: number }>("activeTurn")!;
  h.input("follow", 120_000);
  h.store.set("batch:follow", { id: "follow", text: "follow", attachments: [], receivedAt: now - 120_000, batchIds: ["follow"] });
  h.store.set("batch-phase:follow", "steering"); h.store.updateInbound("follow", "processing");
  h.store.set("steer-attempt:follow", { ...turn, inboundId: "follow" });
  h.store.set("failed-delivery:follow", { ...turn, inboundId: "follow", messageId: hash("follow") });
  const sibling = h.makeRouter(); let admitting = false, failed = false, posts = 0, negatives = 0;
  h.backend.promptAccepted = async () => { negatives++; return false; };
  h.backend.steer = async (_id, _dir, _prompt, _text, _guidance, _files, guard) => {
    admitting = true;
    if (!await guard!.beforeSend()) return "refused";
    posts++; return "steered";
  };
  h.backend.statuses = async () => {
    if (admitting && !failed) {
      failed = true; h.backend.promptAccepted = async () => { throw new ControlError(503); };
      await sibling.checkInboundLatency();
    }
    return {};
  };
  await h.router.tick();
  expect(negatives).toBeGreaterThan(0); expect(failed).toBe(true); expect(posts).toBe(0);
  expect(h.backend.prompts).toEqual([hash("first")]);
});

test("normal steer readback keeps its thirty-second budget for a twenty-five-second read", async () => {
  const h = setup(); h.input("first", 0); await h.router.tick();
  const turn = h.store.get<{ id: string; directory: string; generation: number; messageId: string }>("activeTurn")!;
  h.input("follow", 0);
  h.store.set("batch:follow", { id: "follow", text: "follow", attachments: [], batchIds: ["follow"] });
  h.store.set("batch-phase:follow", "steering"); h.store.updateInbound("follow", "processing");
  h.store.set("steer-attempt:follow", { ...turn, inboundId: "follow" });
  h.backend.promptAccepted = async () => { setSystemTime(now + 25_000); return true; };
  const original = globalThis.setTimeout;
  const budgets: number[] = [];
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(new Proxy(original, {
    apply(target, receiver, args) {
      if (new Error().stack?.includes("probeAccepted")) budgets.push(args[1] ?? 0);
      return Reflect.apply(target, receiver, args);
    },
  }));
  try { await h.router.tick(); } finally { timer.mockRestore(); }
  expect(budgets).toContain(30_000); expect(budgets).not.toContain(10_000);
  expect(h.states()).toEqual(["done", "admitted"]);
  expect(h.store.get<{ covered: string[] }>("activeTurn")?.covered).toEqual(["follow"]);
  expect(h.backend.prompts).toEqual([hash("first")]);
});

test("normal turn and completion polling bypass an exhausted retry budget", async () => {
  const h = setup(); h.input("live", 0); await h.router.tick();
  const budget = new ProbeBudget(h.store); for (let i = 0; i < 60; i++) expect(budget.take()).toBe(true);
  let reads = 0;
  h.backend.messages = async () => { reads++; return h.backend.records; };
  h.backend.records.push({ id: "finished", type: "idle", outcome: "succeeded", time: { created: now } });
  await h.router.checkCompletion(); await h.router.tick();
  expect(reads).toBeGreaterThan(0); expect(h.backend.prompts).toEqual([hash("live")]);
  expect(h.states()).toEqual(["done"]);
});


test("repeated failed reads pause wake preparation attempts until admission can resume", async () => {
  const id = "wake:cooling-preparation"; const h = stalledProbe(id, 15 * 60_000);
  h.store.set(`latency-route:${id}`, h.store.get(`failed-delivery:${id}`));
  h.store.set(`batch:${id}`, { id, text: "update", attachments: [], receivedAt: now - 15 * 60_000, batchIds: [id] });
  h.store.set(`batch-phase:${id}`, "queued-steer"); h.store.updateInbound(id, "pending");
  h.store.set(`stuck-wake-retry:${id}`, now);
  const sibling = h.makeRouter(); let failed = false;
  h.backend.promptAccepted = async () => { throw new ControlError(503); };
  h.backend.statuses = async () => {
    if (!failed && h.store.get(`batch-phase:${id}`) === "preparing") { failed = true; await sibling.checkInboundLatency(); }
    return {};
  };
  await h.router.tick();
  for (const second of [60, 120, 180, 240, 300, 360, 420, 480, 540, 600]) {
    setSystemTime(now + second * 1_000);
    await sibling.checkInboundLatency(); await h.router.tick();
    expect(h.states()).toEqual(["processing"]);
    expect(h.store.get<{ attempts: number }>(`synthetic-retry:${id}`)?.attempts ?? 0).toBe(0);
    expect(h.store.get<{ attempt: number }>("preparingDelivery")?.attempt).toBe(1);
    expect(h.store.get(`stuck-wake-attempt:${id}`)).toBeUndefined();
    expect(h.backend.prompts).toEqual([]);
  }
  setSystemTime(now + 900_000); h.backend.promptAccepted = async () => false;
  await h.router.tick();
  expect(h.backend.prompts).toEqual([hash(id)]);
  expect(h.states()).toEqual(["done"]);
});

test("a confirmed steer clears failure history before a fresh requeued admission read", async () => {
  const h = setup(); h.input("first", 0); await h.router.tick();
  const turn = h.store.get<{ id: string; directory: string; generation: number; messageId: string; startedAt: number }>("activeTurn")!;
  h.input("follow", 120_000);
  h.store.set("batch:follow", { id: "follow", text: "follow", attachments: [], receivedAt: now - 120_000, batchIds: ["follow"] });
  h.store.set("batch-phase:follow", "steering"); h.store.updateInbound("follow", "processing");
  h.store.set("steer-attempt:follow", { ...turn, inboundId: "follow" });
  h.backend.promptAccepted = async () => { throw new ControlError(503); };
  await h.router.tick();
  setSystemTime(now + 60_000); h.backend.promptAccepted = async () => false;
  h.backend.steer = async (_id, _dir, id, text) => {
    h.backend.records.push({ id, type: "user", text, time: { created: Date.now() } });
    return "steered";
  };
  await h.router.tick();
  expect(h.store.get<string>("batch-phase:follow")).toBe("accepted");
  expect(h.store.get("replay-probe-backoff:follow") ?? null).toBeNull();
  h.backend.records.push(
    { id: "answer", type: "assistant", content: [{ type: "text", text: "Answer" }], finish: "stop", time: { created: now + 60_000, completed: now + 60_000 } },
    { id: "idle", type: "idle", outcome: "succeeded", time: { created: now + 60_000 } });
  await h.router.tick();
  h.router.requeueHuman("follow", "watchdog_overdue", true);
  const newPrompt = h.store.get<string>("human-retry-prompt:follow")!;
  const budget = new ProbeBudget(h.store); while (budget.take()) {}
  let freshReads = 0;
  h.backend.promptAccepted = async (_id, _dir, prompt) => { if (prompt === newPrompt) freshReads++; return false; };
  h.backend.unavailable = true;
  await h.router.tick();
  expect(h.backend.prompts).toContain(newPrompt);
  expect(freshReads).toBeGreaterThan(0);
});


test("a failed earlier-prompt alias must fence a rebatched synthetic POST", async () => {
  const h = setup();
  const old = "wake:former-leader", member = "wake:former-member";
  h.input(old, 15 * 60_000); h.input(member, 15 * 60_000);
  const route = { id: "ses_original", directory: "/Chats/ses_original", generation: 1 };
  h.store.set("route", route);
  const prompt = { sessionId: route.id, directory: route.directory, generation: 1, messageId: hash(`${old}:1`), startedAt: now - 150_000 };
  h.store.set(`failed-delivery:${old}`, { ...route, inboundId: old, messageId: prompt.messageId, startedAt: prompt.startedAt, phase: "unknown" });
  h.store.set(`synthetic-retry:${old}`, { attempts: 2, nextAt: now + 30_000, prompts: [prompt] });
  h.store.set(`synthetic-retry:${member}`, { attempts: 1, nextAt: 0, prompts: [prompt] });
  h.backend.promptAccepted = async () => false;
  const sibling = h.makeRouter(); let failures = 0;
  const paused = spyOn(preferences, "imessagePreferences").mockImplementation(async () => {
    h.backend.promptAccepted = async () => { failures++; throw new ControlError(503); };
    await sibling.checkInboundLatency();
    return {};
  });
  try { await h.router.tick(); } finally { paused.mockRestore(); }
  expect(failures).toBe(1);
  expect(h.backend.prompts).toEqual([]);
});


test("full completion evidence clears failure history before a new prompt admission", async () => {
  const h = setup(); h.input("first", 0); await h.router.tick();
  h.backend.steer = async () => "steered";
  h.input("follow", 0); await h.router.tick();
  expect(h.store.get<string>("batch-phase:follow")).toBe("accepted");
  h.backend.promptAccepted = async () => { throw new ControlError(503); };
  await h.router.tick();
  expect(h.store.get(`replay-probe-backoff:first`)).toBeDefined();
  h.backend.records.push(
    { id: hash("follow"), type: "user", text: "follow", time: { created: now } },
    { id: "answer", type: "assistant", content: [{ type: "text", text: "Answer" }], finish: "stop", time: { created: now, completed: now } },
    { id: "idle", type: "idle", outcome: "succeeded", time: { created: now } });
  await h.router.tick();
  expect(h.store.get("activeTurn")).toBeNull();
  expect(h.store.get("replay-probe-backoff:first") ?? null).toBeNull();
  expect(h.store.get(`replay-probe-backoff:prompt:ses_1:${hash("follow")}`) ?? null).toBeNull();
  setSystemTime(now + 61_000);
  h.router.requeueHuman("first", "watchdog_overdue", true);
  const prompt = h.store.get<string>("human-retry-prompt:first")!;
  const budget = new ProbeBudget(h.store); while (budget.take()) {}
  let newReads = 0;
  h.backend.promptAccepted = async (_id, _dir, id) => { if (id === prompt) newReads++; return false; };
  h.backend.unavailable = true;
  await h.router.tick();
  expect(h.backend.prompts).toContain(prompt);
  expect(newReads).toBeGreaterThan(0);
});


test("late failure cannot resurrect history after positive completion", async () => {
  const h = stalledProbe("stale-read");
  const turn = h.store.get("failed-delivery:stale-read");
  h.store.set("activeTurn", turn);
  h.store.set("batch:stale-read", { id: "stale-read", text: "stale-read", attachments: [], batchIds: ["stale-read"], receivedAt: now - 120_000 });
  h.store.set("batch-phase:stale-read", "submitting");
  h.store.set("resendBody", {inboundId:"stale-read", text:"stale-read", system:"", parts:[]});
  const read = Promise.withResolvers<boolean>();
  const entered = Promise.withResolvers<void>();
  h.backend.promptAccepted = async () => { entered.resolve(); return read.promise; };
  const scan = h.router.checkInboundLatency();
  await entered.promise;
  h.backend.records.push(
    { id: hash("stale-read"), type: "user", text: "stale-read", time: { created: now } },
    { id: "idle", type: "idle", outcome: "succeeded", time: { created: now } });
  await h.router.tick();
  expect(h.store.get("activeTurn")).toBeNull();
  expect(h.states()).toEqual(["done"]);
  expect(h.store.get("replay-probe-backoff:stale-read") ?? null).toBeNull();
  read.reject(new ControlError(503));
  await scan;
  expect(h.store.get("replay-probe-backoff:stale-read") ?? null).toBeNull();
  setSystemTime(now + 61_000);
  h.router.requeueHuman("stale-read", "watchdog_overdue", true);
  const fresh = h.store.get<string>("human-retry-prompt:stale-read")!;
  const budget = new ProbeBudget(h.store); while (budget.take()) {}
  let freshReads = 0;
  h.backend.promptAccepted = async (_id, _dir, id) => { if (id === fresh) freshReads++; return false; };
  h.backend.unavailable = true;
  await h.router.tick();
  expect(freshReads).toBeGreaterThan(0);
});


const guardedWakePaths = [
  ["OpenChamber", "submit"], ["Robob", "submit"], ["OpenChamber", "replay"], ["Robob", "replay"],
] as const;

function guardedWake(engine: typeof guardedWakePaths[number][0], path: typeof guardedWakePaths[number][1]) {
  const h = setup();
  const old = "wake:former-leader", member = "wake:former-member";
  h.input(old, 15 * 60_000); h.input(member, 15 * 60_000);
  const route = { id: "ses_original", directory: "/Chats/ses_original", generation: 1 };
  h.store.set("route", route);
  const prompt = { sessionId: route.id, directory: route.directory, generation: 1, messageId: hash(`${old}:1`), startedAt: now - 150_000 };
  h.store.set(`failed-delivery:${old}`, { ...route, inboundId: old, messageId: prompt.messageId, startedAt: prompt.startedAt, phase: "unknown" });
  h.store.set(`synthetic-retry:${old}`, { attempts: 2, nextAt: now + 30_000, prompts: [prompt] });
  h.store.set(`synthetic-retry:${member}`, { attempts: 1, nextAt: 0, prompts: [prompt] });
  if (path === "replay") {
    const turn = { ...route, inboundId: member, messageId: hash(member), earlier: [prompt.messageId], startedAt: now - 60_000, phase: "unknown" };
    h.store.set("activeTurn", turn); h.store.set(`failed-delivery:${member}`, turn);
    h.store.set(`batch:${member}`, { id: member, text: "update", attachments: [], batchIds: [member] });
    h.store.set(`batch-phase:${member}`, "submitting"); h.store.updateInbound(member, "processing");
    h.store.set("resendBody", { inboundId: member, text: "update", system: "guidance", parts: [] });
  }
  h.backend.promptAccepted = async () => false;
  const sibling = h.makeRouter();
  let failed = false;
  let failPreparation = true;
  h.backend.request = async <T>(path: string, options?: {body?: unknown}) => {
    if (failPreparation && path.endsWith("/synthetic")) {
      h.backend.promptAccepted = async () => { failed = true; throw new ControlError(503); };
      await sibling.checkInboundLatency();
    }
    if (path.endsWith("/prompt")) {

      h.backend.prompts.push((options?.body as { id?: string } | undefined)?.id ?? "missing");
    }
    return {} as T;
  };
  h.backend.prompt = OpenChamber.prototype.prompt;
  if (engine === "Robob") {
    const client = new ControlClient({url:"http://127.0.0.1:1", token:"synthetic-test-token"});
    client.byNative = async () => {
      if (failPreparation) {
        h.backend.promptAccepted = async () => { failed = true; throw new ControlError(503); };
        await sibling.checkInboundLatency();
      }
      return { thread: { threadId: "resolved-thread" } } as Awaited<ReturnType<ControlClient["byNative"]>>;
    };
    client.request = async <T>(_method: string, path: string, body?: unknown) => {
      if (path.endsWith("/send")) {

        h.backend.prompts.push((body as { clientRequestId: string }).clientRequestId);
      }
      return {} as T;
    };
    const robob = new RobobBackend({ chatRoot:"/Chats", client });
    h.backend.prompt = robob.prompt.bind(robob);
  }
  return { ...h, old, member, promptKey: `prompt:${route.id}:${prompt.messageId}`, failed: () => failed,
    recover: () => { failPreparation = false; h.backend.promptAccepted = async () => false; } };
}

test.each(guardedWakePaths)("%s %s alias failure during backend preparation must fence the POST", async (engine, path) => {
  const h = guardedWake(engine, path);
  const member = h.member;
  await h.router.tick();
  expect(h.failed()).toBe(true);
  expect(h.backend.prompts).toEqual([]);
  const initialAttempts = h.store.get<{ attempts: number }>(`synthetic-retry:${member}`)?.attempts;
  const budget = new ProbeBudget(h.store);
  for (const at of [1_000, 60_000, 120_000, 240_000]) {
    setSystemTime(now + at);
    if (at === 240_000) while (budget.take()) {}
    await h.router.tick();
    expect(h.backend.prompts).toEqual([]);
    expect(h.store.get<{ attempts: number }>(`synthetic-retry:${member}`)?.attempts).toBe(initialAttempts);
    expect(h.store.get(`stuck-wake-attempt:${member}`)).toBeUndefined();
  }
  h.recover();
  setSystemTime(now + 301_000);
  await h.router.tick();
  expect(h.backend.prompts.length).toBeGreaterThan(0);
});

test.each(guardedWakePaths.flatMap(([engine, path]) => (["cooldown", "cap"] as const).map(wait => ({ engine, path, wait }))))(
  "$engine $path unsent wake yields to a human during $wait without spending an attempt", async ({ engine, path, wait }) => {
  const h = guardedWake(engine, path);
  await h.router.tick();
  expect(h.failed()).toBe(true);
  expect(h.backend.prompts).toEqual([]);
  expect(h.store.get("activeTurn")).toBeNull();
  expect(h.store.get<string>(`batch-phase:${h.member}`)).toBe("deferred-wake");
  const retry = h.store.get<Record<string, unknown>>(`synthetic-retry:${h.member}`);
  const cooldown = h.store.get<Record<string, unknown>>(h.promptKey);
  const budget = new ProbeBudget(h.store);
  h.recover();
  if (wait === "cap") {
    setSystemTime(now + 60_000);
    while (budget.take()) {}
    await h.router.tick();
    expect(h.backend.prompts).toEqual([]);
    expect(budget.take()).toBe(false);
  }
  setSystemTime(now + (wait === "cooldown" ? 1_000 : 61_000));
  h.input("typed", 0);
  await h.router.tick();
  expect(h.backend.prompts).toEqual([hash("typed")]);
  expect(h.store.get<string>(`batch-phase:typed`)).toBe("accepted");
  expect(h.store.get<Record<string, unknown>>(`synthetic-retry:${h.member}`)).toEqual(retry);
  expect(h.store.get(`stuck-wake-attempt:${h.member}`)).toBeUndefined();
  expect(h.store.get<Record<string, unknown>>(h.promptKey)).toEqual(cooldown);
  expect(h.store.get<string>(`batch-phase:${h.member}`)).toBe("deferred-wake");
});
