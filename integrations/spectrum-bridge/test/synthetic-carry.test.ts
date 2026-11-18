import { afterEach, expect, setSystemTime, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalizedInbound } from "../src/photon.ts";
import { OpenChamber, type MessageRecord } from "../src/openchamber.ts";
import { Router, syntheticDropped } from "../src/router.ts";
import { Store } from "../src/store.ts";
import { FAILED_INBOUND_REPLAY_MAX_AGE_MS as HORIZON } from "../src/inbound-failure.ts";
import { createToolLog, type LogLine } from "../src/toollog.ts";
import { captureLogs } from "./log-fixture.ts";
import { ProbeBackoff } from "../src/probe-policy.ts";

const start = Date.parse("2026-11-17T12:00:00Z");
const hash = (id: string) => `msg_${createHash("sha256").update(id).digest("hex")}`;
const body = (id: string) => `[Watcher event from robob-watch carry-test, not typed by the owner.]\nUpdate ${id}\nPRIVATE_PAYLOAD`;
type Carry = { id: string; text: string; at: number; uncertain?: true };
type Turn = { carried?: string[]; messageId: string; phase: string };
class Backend extends OpenChamber {
  offline = false;
  records: MessageRecord[] = [];
  prompts: { session: string; id: string; text: string; system?: string }[] = [];
  constructor() { super("http://127.0.0.1:1"); }
  override async request<T>(): Promise<T | undefined> { throw new Error("Unexpected backend access"); }
  override async createChat() {
    if (this.offline) throw new Error("offline");
    return { id: "ses_current", directory: "/Chats/ses_current" };
  }
  override async isSessionAutoAccepting() { return false; }
  override async permissions() { return []; }
  override async questions() { return []; }
  override async children() { return []; }
  override async statuses() { return {}; }
  override async getSession(id: string, directory: string) { return { id, directory, title: "Chat", time: { created: start, updated: start } }; }
  override async messages() { return this.records; }
  override async promptAccepted(_session: string, _dir: string, id: string) { return this.records.some(r => r.id === id && r.type === "user"); }
  override async prompt(session: string, _dir: string, id: string, text: string, system?: string) {
    this.prompts.push({ session, id, text, system });
    if (this.offline) throw new Error("offline");
    this.records.push({ id, type: "user", text, time: { created: Date.now() } });
  }
  finish() { this.records.push({ id: `idle_${this.records.length}`, type: "idle", outcome: "succeeded", time: { created: Date.now() } }); }
}
const stores: Store[] = [];
afterEach(() => { stores.splice(0).forEach(s => s.close()); setSystemTime(); });
function setup() {
  setSystemTime(start);
  const store = new Store(":memory:"); stores.push(store);
  const backend = new Backend(), alerts: string[] = [];
  const transport = { read: async () => {}, typing: async () => {}, downloadAttachment: async () => { throw new Error("unexpected file"); } };
  const options: ConstructorParameters<typeof Router>[3] = {
    owner: "+15555550123", chatGuid: "iMessage;-;+15555550123", timezone: "Asia/Dubai", quietMs: 0,
    skillPath: "/test/imessage/SKILL.md", alertSkillPath: "/test/telegram/SKILL.md", alertSocketPath: "/test/telegram.sock",
    openCodeConfigRoot: "/nonexistent/config", droppedBatchMs: 0,
    notifyFailure: async (_text, key) => { alerts.push(key); return true; },
  };
  const restart = () => new Router(store, backend, transport, options);
  const router = restart();
  const input = (id: string, at = Date.now(), text = body(id)) => store.acceptInbound(id, {
    id, text, source: "typed", attachments: [], isAudioMessage: false, receivedAt: at,
  } satisfies NormalizedInbound);
  const state = (id: string) => store.db.query<{ state: string }, [string]>("SELECT state FROM inbound WHERE id = ?").get(id)?.state;
  const missed = () => store.get<Carry[]>("missedSynthetic") ?? [];
  const controls = () => store.pendingOutbox().filter(op => op.kind === "control");
  return { store, backend, router, input, state, missed, controls, alerts, restart };
}
type Harness = ReturnType<typeof setup>;
async function exhaust(h: Harness, id: string) {
  h.backend.offline = true;
  h.input(id);
  // Creation failures are known unadmitted; use the persisted retry deadlines.
  for (let attempt = 1; attempt <= 3; attempt++) {
    await h.router.tick();
    setSystemTime(Date.now() + 60_000); await h.router.tick();
    setSystemTime(Date.now() + 60_000); await h.router.tick();
    expect(h.store.get<{ attempts: number }>(`synthetic-retry:${id}`)?.attempts).toBe(attempt);
    const next = h.store.get<{ nextAt: number }>(`synthetic-retry:${id}`)!.nextAt;
    if (attempt < 3) setSystemTime(next);
  }
  expect(h.state(id)).toBe("failed");
}
function seed(h: Harness, entries: { id: string; at?: number; uncertain?: true }[]) {
  for (const entry of entries) { h.input(entry.id); h.store.updateInbound(entry.id, "failed"); }
  h.store.set("missedSynthetic", entries.map(entry => ({ ...entry, text: body(entry.id) })));
}
async function submit(h: Harness, id = "human") { h.backend.offline = false; h.input(id, Date.now(), "Please check"); await h.router.tick(); }
function stranded(h: Harness, id: string, opts: { retired?: boolean; attempted?: boolean; age?: number; state?: "pending" | "batched" | "processing"; leaderState?: "pending" | "processing" } = {}) {
  const old = { id: "ses_old", directory: "/Chats/ses_old", generation: 1 };
  h.store.set("route", opts.retired ? { id: "ses_current", directory: "/Chats/ses_current", generation: 2 } : old);
  const at = start - (opts.age ?? 20 * 60_000);
  h.input(id, at);
  const leader = opts.state === "batched" ? "wake:leader" : id;
  if (leader !== id) {
    h.input(leader, at); h.store.updateInbound(leader, opts.leaderState ?? "pending");
    h.store.set(`batch:${leader}`, { id: leader, text: body(id), batchIds: [leader, id], attachments: [], receivedAt: at });
  }
  h.store.updateInbound(id, opts.state ?? "pending");
  h.store.set(`failed-delivery:${leader}`, { ...old, inboundId: leader, messageId: hash(leader), startedAt: at, phase: "unknown" });
  h.store.set(`stuck-wake-retry:${id}`, start - 5 * 60_000);
  if (opts.attempted) h.store.set(`stuck-wake-attempt:${id}`, start - 5 * 60_000);
}

function retiredBatch(h: Harness, ages: readonly number[]) {
  const ids = ages.map((_, i) => `wake:sealed-${i}`);
  for (const [i, id] of ids.entries()) {
    stranded(h, id, { retired: true, age: ages[i]! * 60_000 });
    if (i) {
      h.store.updateInbound(id, "batched");
      // A real sealed member's admission evidence lives only under its leader.
      h.store.set(`failed-delivery:${id}`, null);
    }
  }
  h.store.set(`batch:${ids[0]}`, { id: ids[0], text: ids.map(body).join("\n"), batchIds: ids, attachments: [], receivedAt: start - ages[0]! * 60_000 });
  return ids;
}

test.each([
  { ages: [20, 10], restart: false }, { ages: [20, 10], restart: true },
  { ages: [10, 20], restart: false }, { ages: [10, 20], restart: true },
])("a younger sealed sibling survives an older sibling's carry admission ($ages, restart=$restart)", async ({ ages, restart }) => {
  const h = setup(), ids = retiredBatch(h, ages);
  const leader = ids[ages.indexOf(20)]!, member = ids[ages.indexOf(10)]!;
  await h.router.checkInboundLatency();
  expect(h.missed().map(m => m.id)).toEqual([leader]);
  await submit(h);
  expect(h.store.get<Turn>("activeTurn")?.carried).toEqual([leader]);
  expect(h.backend.prompts.at(-1)!.system).not.toContain(body(member));
  if (restart) h.router = h.restart();
  setSystemTime(start + 1000); await h.router.checkInboundLatency();
  expect(h.state(member)).toBe(ids.indexOf(member) === 0 ? "pending" : "batched");
  expect(h.store.get(`inbound-delivered:${member}`)).toBeUndefined();
  setSystemTime(start + 5 * 60_000); await h.router.checkInboundLatency();
  expect(h.missed().map(m => m.id)).toEqual([member]);
  expect(h.store.get(`inbound-delivered:${member}`)).toBeUndefined();
  h.backend.finish(); await h.router.tick();
  await submit(h, "human-2");
  expect(h.store.get<Turn>("activeTurn")?.carried).toEqual([member]);
  expect(h.store.get(`inbound-delivered:${member}`)).toBeNumber();
  expect(h.backend.prompts.every(p => p.session !== "ses_old")).toBe(true);
});

test.each([{ restart: false }, { restart: true }])("a retired eight-member batch receipts only the five ids carried until the next prompt (restart=$restart)", async ({ restart }) => {
  const h = setup(), ids = retiredBatch(h, Array(8).fill(20));
  await h.router.checkInboundLatency();
  expect(h.missed().map(m => m.id)).toEqual(ids);
  await submit(h);
  expect(h.store.get<Turn>("activeTurn")?.carried).toEqual(ids.slice(0, 5));
  if (restart) h.router = h.restart();
  setSystemTime(start + 1000); await h.router.checkInboundLatency();
  expect(h.missed().map(m => m.id)).toEqual(ids.slice(5));
  for (const id of ids.slice(5)) expect(h.store.get(`inbound-delivered:${id}`)).toBeUndefined();
  h.backend.finish(); await h.router.tick();
  await submit(h, "human-2");
  expect(h.store.get<Turn>("activeTurn")?.carried).toEqual(ids.slice(5));
  expect(h.missed()).toEqual([]);
  for (const id of ids) expect(h.store.get(`inbound-delivered:${id}`)).toBeNumber();
  expect(h.backend.prompts.every(p => p.session !== "ses_old")).toBe(true);
});

test.each([{ cooling: false }, { cooling: true }])("splitting stranded members retains their original probe timeout and cooldown (cooling=$cooling)", async ({ cooling }) => {
  const h = setup(), ids = retiredBatch(h, Array(8).fill(20));
  const reads: [string, string][] = [];
  h.backend.promptAccepted = async (session, _directory, id) => {
    reads.push([session, id]);
    throw Object.assign(new Error("read timed out"), { code: "timeout" });
  };
  if (cooling) {
    h.store.updateInbound(ids[0]!, "processing");
    await h.router.checkInboundLatency();
    expect(h.missed()).toEqual([]);
    expect(reads).toHaveLength(1);
    h.store.updateInbound(ids[0]!, "pending");
    setSystemTime(start + 1000);
  }
  await h.router.checkInboundLatency();
  expect(h.missed().map(m => m.id)).toEqual(ids);
  expect(reads).toEqual([["ses_old", hash(ids[0]!)]]);
  expect(h.backend.prompts).toEqual([]);
});

test.each([false, true])("a split younger member retains failed-read cooldown and retry step after carrying its leader (restart=%s)", async restart => {
  const h = setup(), ids = retiredBatch(h, [20, 14.5]);
  const leader = ids[0]!, member = ids[1]!;
  h.store.set(`stuck-wake-retry:${member}`, start);
  const reads: string[] = [];
  h.backend.promptAccepted = async (_session, _directory, id) => { reads.push(id); throw Object.assign(new Error("offline"), { status: 503 }); };
  await h.router.checkInboundLatency();
  expect(h.missed().map(m => m.id)).toEqual([leader]);
  expect(reads).toEqual([hash(leader)]);
  if (restart) h.router = h.restart();
  // A later receipt for the carried leader must not clear its younger sibling's uncertainty.
  await submit(h);
  const policy = new ProbeBackoff(h.store);
  setSystemTime(start + 59_999);
  await h.router.checkInboundLatency();
  expect(reads).toEqual([hash(leader)]);
  expect(policy.cooling(member)).toBe(true);
  expect(policy.retry(member)).toBe(true);
  setSystemTime(start + 61_000);
  await h.router.checkInboundLatency();
  expect(reads).toEqual([hash(leader), hash(leader)]);
  expect(policy.get(member)?.delay).toBe(120_000);
  expect(h.store.get(`inbound-delivered:${member}`)).toBeUndefined();
});

test.each(["pending", "sent"])("expiry gets its own durable notice after a %s exhaustion notice", async state => {
  const h = setup(), id = "wake:expiry-after-notice";
  await exhaust(h, id);
  const initial = h.controls()[0]!;
  expect(initial.text).toBe(syntheticDropped(id, body(id), "undelivered"));
  if (state === "sent") h.store.outboxState(initial.id, "sent");
  h.router = h.restart();
  setSystemTime(Date.now() + HORIZON + 1);
  const logs = await captureLogs(async () => { await submit(h); await h.router.tick(); await h.router.tick(); });
  expect(h.missed()).toEqual([]);
  expect(logs.filter(l => l.name === "synthetic.carry_evicted")).toHaveLength(1);
  const expired = h.controls().filter(op => op.text === syntheticDropped(id, body(id), "expired"));
  expect(expired).toHaveLength(1);
  expect(expired[0]!.id).not.toBe(initial.id);
  expect(h.store.getOperation(initial.id)?.text).toBe(initial.text);
});

test("eight exhausted wakes survive and land FIFO in prompts of five then three", async () => {
  const h = setup(), ids = Array.from({ length: 8 }, (_, i) => `wake:exhausted-${i}`);
  for (const id of ids) await exhaust(h, id);
  expect(h.missed().map(m => m.id)).toEqual(ids);
  // Keep the submitted prompt unadmitted to inspect the durable carried fence.
  h.backend.createChat = async () => ({ id: "ses_current", directory: "/Chats/ses_current" });
  h.backend.offline = true; h.input("human", Date.now(), "Please check");
  await h.router.tick();
  expect(h.store.get<Turn>("activeTurn")?.carried).toEqual(ids.slice(0, 5));
  expect(h.missed()).toHaveLength(8);
  const first = h.backend.prompts.at(-1)!;
  const lines = first.system!.split("Handle them alongside this message:\n")[1]!.split("\n");
  expect(lines).toEqual(ids.slice(0, 5).map(id => JSON.stringify(body(id))));
  h.backend.records.push({ id: first.id, type: "user", text: first.text, time: { created: Date.now() } });
  h.backend.offline = false;
  await h.router.tick();
  expect(h.missed().map(m => m.id)).toEqual(ids.slice(5));
  for (const id of ids.slice(0, 5)) expect(h.store.get(`inbound-delivered:${id}`)).toBeNumber();
  h.backend.finish(); await h.router.tick();
  await submit(h, "human-2");
  expect(h.store.get<Turn>("activeTurn")?.carried).toEqual(ids.slice(5));
  const second = h.backend.prompts.at(-1)!.system!;
  expect(second.split("Handle them alongside this message:\n")[1]!.split("\n")).toEqual(ids.slice(5).map(id => JSON.stringify(body(id))));
  expect(h.missed()).toEqual([]);
  for (const id of ids) expect(h.store.get(`inbound-delivered:${id}`)).toBeNumber();
});

test("prompt build expires a six-hour carry once with a bodyless log and owner notice", async () => {
  const h = setup(), id = "wake:expired";
  seed(h, [{ id, at: start - HORIZON - 1 }]);
  const logs = await captureLogs(async () => { await submit(h); await h.router.tick(); });
  expect(h.missed()).toEqual([]);
  expect(h.backend.prompts.at(-1)?.system).not.toContain(body(id));
  expect(h.store.get<Turn>("activeTurn")?.carried).toBeUndefined();
  expect(logs.filter(l => l.name === "synthetic.carry_evicted")).toMatchObject([{
    ids: { inboundId: id, chat: "owner" }, props: { reason: "expired", ageMs: HORIZON + 1 },
  }]);
  expect(JSON.stringify(logs)).not.toContain("PRIVATE_PAYLOAD");
  expect(h.controls().map(n => n.text)).toEqual([syntheticDropped(id, body(id), "expired")]);
});

test("the 51st exhausted carry evicts only the oldest with overflow evidence and replaces its queued notice", async () => {
  const h = setup(), ids = Array.from({ length: 50 }, (_, i) => `wake:stored-${i}`);
  seed(h, ids.map((id, i) => ({ id, at: start - 1000 + i })));
  h.store.set("droppedNotices", [{ id: ids[0], label: "watcher: oldest", reason: "undelivered", text: "I'll pick it up next turn", at: start }]);
  const logs = await captureLogs(async () => { await exhaust(h, "wake:51st"); });
  expect(h.missed().map(m => m.id)).toEqual([...ids.slice(1), "wake:51st"]);
  expect(logs.filter(l => l.name === "synthetic.carry_evicted")).toMatchObject([{
    ids: { inboundId: ids[0] }, props: { reason: "overflow" },
  }]);
  const text = h.controls().map(n => n.text).join("\n");
  expect(text).toContain("too old to pick up after it couldn't reach me, skipped");
  expect(text.match(/Update wake:stored-0/g)).toHaveLength(1);
});

test("legacy carries get one durable migration timestamp and are selected oldest first", async () => {
  const h = setup();
  seed(h, [{ id: "wake:legacy" }, { id: "wake:older", at: start - 1 }]);
  h.backend.offline = true;
  h.backend.createChat = async () => ({ id: "ses_current", directory: "/Chats/ses_current" });
  h.input("human", start, "Please check"); await h.router.tick();
  expect(h.missed()).toEqual([{ id: "wake:older", text: body("wake:older"), at: start - 1 }, { id: "wake:legacy", text: body("wake:legacy"), at: start }]);
  expect(h.store.get<Turn>("activeTurn")?.carried).toEqual(["wake:older", "wake:legacy"]);
  setSystemTime(start + HORIZON + 1);
  // Restore after an outage: another build must not renew the migrated timestamp.
  h.store.set("activeTurn", null); h.store.updateInbound("human", "failed");
  await submit(h, "later"); await h.router.tick();
  expect(h.controls().map(op => op.text).join("\n")).toContain("too old to pick up");
});

test.each([
  { retired: true, attempted: false }, { retired: true, attempted: true }, { retired: false, attempted: true },
])("stranded wake moves once without POSTing to its old route ($retired/$attempted)", async opts => {
  const h = setup(), id = "wake:stranded";
  stranded(h, id, opts);
  const logs = await captureLogs(async () => { await h.router.checkInboundLatency(); });
  expect(h.state(id)).toBe("failed");
  expect(h.backend.prompts).toEqual([]);
  expect(h.missed()).toEqual([{ id, text: body(id), at: start - 20 * 60_000, ...(opts.attempted ? { uncertain: true } : {}) }]);
  expect(logs.filter(l => l.name === "synthetic.carried_from_stranded")).toMatchObject([{
    ids: { inboundId: id, chat: "owner" }, props: { cause: opts.retired ? "route_retired" : "stuck_attempt_used" },
  }]);
  expect(JSON.stringify(logs)).not.toContain("PRIVATE_PAYLOAD");
  expect(h.controls()).toEqual([]);
  setSystemTime(start + 1000); await h.router.checkInboundLatency();
  expect(h.alerts).toEqual([`imessage-stuck-wake:${id}`]);
  await submit(h);
  const system = h.backend.prompts.at(-1)!.system!;
  expect(system).toContain(JSON.stringify(body(id)));
  expect(system.includes("(may already have reached you before the outage; check before acting on it again) ")).toBe(opts.attempted);
  expect(h.store.get(`inbound-delivered:${id}`)).toBeNumber();
});

test("a retired wake older than six hours expires immediately instead of getting a fresh horizon", async () => {
  const h = setup(), id = "wake:outage-old";
  stranded(h, id, { retired: true, age: HORIZON + 1 });
  const logs = await captureLogs(async () => { await h.router.checkInboundLatency(); });
  expect(h.state(id)).toBe("failed"); expect(h.missed()).toEqual([]);
  expect(h.backend.prompts).toEqual([]);
  expect(logs.find(l => l.name === "synthetic.carry_evicted")?.props).toEqual({ reason: "expired", ageMs: HORIZON + 1 });
  expect(h.store.get<{ reason: string }[]>("droppedNotices")?.map(n => n.reason)).toEqual(["expired"]);
});

test("retired sealed members carry individually only after their leader stops processing", async () => {
  const h = setup(), id = "wake:member";
  stranded(h, id, { retired: true, state: "batched", leaderState: "processing" });
  await h.router.checkInboundLatency();
  expect(h.missed()).toEqual([]); expect(h.state(id)).toBe("batched");
  h.store.updateInbound("wake:leader", "pending");
  setSystemTime(start + 1000); await h.router.checkInboundLatency();
  expect(h.state(id)).toBe("failed"); expect(h.state("wake:leader")).toBe("pending");
  expect(h.missed().map(m => m.id)).toEqual([id]); expect(h.backend.prompts).toEqual([]);
});

test("delivery markers and processing rows prevent carry, while agent-bus/reset/reply-nudge retain their exclusions", async () => {
  const h = setup();
  for (const id of ["wake:delivered", "wake:processing", "wake:agent-bus:request", "reset:test", "wake:reply-nudge:test"]) {
    stranded(h, id, { retired: true, attempted: true, state: id === "wake:processing" ? "processing" : "pending" });
  }
  h.store.set("inbound-delivered:wake:delivered", start);
  stranded(h, "wake:eligible", { retired: true });
  await h.router.checkInboundLatency();
  expect(h.missed().map(m => m.id)).toEqual(["wake:eligible"]);
  for (const id of ["wake:delivered", "wake:agent-bus:request", "reset:test", "wake:reply-nudge:test"]) expect(h.state(id)).toBe("pending");
  expect(h.state("wake:processing")).toBe("processing");
  expect(h.controls()).toEqual([]); expect(h.backend.prompts).toEqual([]);
});

test.each([false, true])("a retired batch carries every member after its leader is failed (expired=$0)", async expired => {
  const h = setup(), ids = ["wake:first", "wake:second", "wake:third"];
  const at = start - (expired ? HORIZON + 1 : 20 * 60_000);
  for (const id of ids) stranded(h, id, { retired: true, age: start - at });
  h.store.set(`batch:${ids[0]}`, { id: ids[0], text: ids.map(body).join("\n"), batchIds: ids, attachments: [], receivedAt: at });
  for (const id of ids.slice(1)) h.store.updateInbound(id, "batched");
  const logs = await captureLogs(async () => { await h.router.checkInboundLatency(); });
  expect(ids.map(h.state)).toEqual(["failed", "failed", "failed"]);
  expect(h.missed().map(m => m.id)).toEqual(expired ? [] : ids);
  expect(logs.filter(l => l.name === "synthetic.carried_from_stranded").map(l => l.ids?.inboundId)).toEqual(ids);
  expect(logs.filter(l => l.name === "synthetic.carry_evicted").map(l => l.ids?.inboundId)).toEqual(expired ? ids : []);
  expect(h.backend.prompts).toEqual([]);
});

test("carry eviction and stranded diagnostics retain reduced fields after the day log cap", () => {
  const root = mkdtempSync(join(tmpdir(), "synthetic-carry-log-"));
  try {
    const log = createToolLog({ root, now: () => start, capBytes: 0 });
    for (const reason of ["expired", "overflow"]) log.write({ component: "router", kind: "event", name: "synthetic.carry_evicted", ids: { inboundId: "wake:test", chat: "owner" }, props: { reason, ageMs: HORIZON, text: "PRIVATE_PAYLOAD" } });
    for (const cause of ["route_retired", "stuck_attempt_used"]) log.write({ component: "router", kind: "event", name: "synthetic.carried_from_stranded", ids: { inboundId: "wake:test", chat: "owner" }, props: { cause, text: "PRIVATE_PAYLOAD" } });
    const raw = readFileSync(join(root, "2026-11-17.ndjson"), "utf8");
    const logs = raw.trim().split("\n").map(s => JSON.parse(s) as LogLine);
    expect(logs.filter(l => l.name === "synthetic.carry_evicted").map(l => l.props)).toEqual(["expired", "overflow"].map(reason => ({ reason, ageMs: HORIZON })));
    expect(logs.filter(l => l.name === "synthetic.carried_from_stranded").map(l => l.props)).toEqual(["route_retired", "stuck_attempt_used"].map(cause => ({ cause })));
    expect(raw).not.toContain("PRIVATE_PAYLOAD");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
