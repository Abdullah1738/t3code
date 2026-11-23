import { afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../src/api.ts";
import { Delivery } from "../src/delivery.ts";
import { ControlError } from "../src/control.ts";
import { HUMAN_FAILURE_BACKOFF_MS, MAX_FAILED_ATTEMPTS, requeueHuman } from "../src/inbound-routing.ts";
import { OpenChamber, type FilePart, type MessageRecord, type OwnerWords, type PermissionRequest, type QuestionRequest, type SessionStatus, type SteerDelivery } from "../src/openchamber.ts";
import type { NormalizedInbound, Photon } from "../src/photon.ts";
import { Router } from "../src/router.ts";
import { PENDING_ATTRIBUTION_MAX_AGE_MS, Store } from "../src/store.ts";
import type { AnsweredInput } from "../src/unanswered.ts";
import { captureLogs } from "./log-fixture.ts";

type Assistant = Extract<MessageRecord, { type: "assistant" }>;
type PromptCall = { id: string; directory: string; messageId: string; text: string };
type SteerCall = { id: string; messageId: string; text: string };

const BASE_OPTIONS = {
  owner: "+15555550123",
  chatGuid: "iMessage;-;+15555550123",
  timezone: "Asia/Dubai",
  skillPath: "/private/test/notification-skill/SKILL.md",
  alertSkillPath: "/private/test/telegram-skill/SKILL.md",
  alertSocketPath: "/private/test/telegram.sock",
  openCodeConfigRoot: "/nonexistent/opencode-config",
  quietMs: 0,
  medsFold: false as const,
};

const stores: Store[] = [];
const dirs: string[] = [];

afterEach(() => {
  setSystemTime();
  while (stores.length) stores.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

class MultiSessionBackend extends OpenChamber {
  creates = 0;
  prompts: PromptCall[] = [];
  steers: SteerCall[] = [];
  recordsBySession = new Map<string, MessageRecord[]>();
  states: Record<string, SessionStatus> = {};
  steerBehavior?: (call: SteerCall, options?: { onFailure?: (err: unknown) => void }) => Promise<SteerDelivery>;

  constructor() { super("http://127.0.0.1:1"); }
  override async request<T>(): Promise<T | undefined> { throw new Error("Unexpected HTTP call"); }
  override async health() { return { status: "ok", timestamp: "", openchamberVersion: "test" }; }
  override async isSessionAutoAccepting() { return false; }

  private list(id: string): MessageRecord[] {
    let items = this.recordsBySession.get(id);
    if (!items) { items = []; this.recordsBySession.set(id, items); }
    return items;
  }

  override async createChat() {
    this.creates++;
    const id = `ses_${this.creates}`;
    this.list(id);
    return { id, directory: `/Chats/${id}` };
  }

  override async prompt(id: string, directory: string, messageId: string, text: string, _system?: string, _files: readonly FilePart[] = [], _model?: { providerID: string; modelID: string; variant?: string; instanceId?: string }, _owner?: OwnerWords) {
    this.prompts.push({ id, directory, messageId, text });
    this.list(id).push({ id: messageId, type: "user", text, time: { created: Date.now() } });
  }

  override async promptAccepted(id: string, _directory: string, messageId: string) {
    return this.list(id).some(m => m.id === messageId && m.type === "user");
  }

  async steer(id: string, _directory: string, messageId: string, text: string, _system?: string, _files?: readonly FilePart[], options?: { onFailure?: (err: unknown) => void }): Promise<SteerDelivery> {
    const call = { id, messageId, text };
    this.steers.push(call);
    if (this.steerBehavior) return this.steerBehavior(call, options);
    this.list(id).push({ id: messageId, type: "user", text, time: { created: Date.now() } });
    return "steered";
  }

  override async messages(id: string) { return this.list(id); }
  override async statuses() { return this.states; }
  override async getSession(id: string, directory: string) { return { id, directory, title: "Chat", time: { created: 0, updated: 0 } }; }
  override async children() { return []; }
  override async permissions(): Promise<PermissionRequest[]> { return []; }
  override async questions(): Promise<QuestionRequest[]> { return []; }
  override async abort() { return true; }

  step(sessionId: string, text = "Reply", finish = "stop"): Assistant {
    const list = this.list(sessionId);
    const record: Assistant = {
      id: `msg_assistant_${sessionId}_${list.length}`,
      type: "assistant",
      agent: "build",
      model: { providerID: "test", id: "model" },
      content: [{ type: "text", text }],
      finish,
      time: { created: Date.now(), completed: Date.now() },
    };
    list.push(record);
    return record;
  }

  settle(sessionId: string, outcome: "succeeded" | "failed" | "interrupted" = "succeeded") {
    const list = this.list(sessionId);
    list.push({ id: `msg_idle_${sessionId}_${list.length}`, type: "idle", outcome, time: { created: Date.now() } });
  }

  final(sessionId: string, text = "Final answer") {
    this.step(sessionId, text, "stop");
    this.settle(sessionId, "succeeded");
  }

  failed(sessionId: string, errorMessage = "Session not found") {
    const step = this.step(sessionId, "", "error");
    step.error = { type: "ProviderError", message: errorMessage };
    this.settle(sessionId, "failed");
  }
}

function setup(overrides: Partial<ConstructorParameters<typeof Router>[3]> = {}, dbPath = ":memory:") {
  const store = new Store(dbPath);
  stores.push(store);
  const backend = new MultiSessionBackend();
  const transport: Pick<Photon, "typing" | "read" | "downloadAttachment"> = {
    async typing() {},
    async read() {},
    async downloadAttachment() { return { data: new Uint8Array([1]), mimeType: "image/png", name: "a.png" }; },
  };
  const routerOptions = { ...BASE_OPTIONS, ...overrides };
  const router = new Router(store, backend, transport, routerOptions);
  const input = (id: string, text: string, extra: Partial<NormalizedInbound> = {}) =>
    store.acceptInbound(id, { id, text, attachments: [], isAudioMessage: false, source: "typed", receivedAt: Date.now(), ...extra } satisfies NormalizedInbound);
  const inboundRow = (id: string) => {
    const row = store.db.query<{ id: string; state: string; payload: string }, [string]>("SELECT id, state, payload FROM inbound WHERE id = ?").get(id)!;
    return { id: row.id, state: row.state, payload: JSON.parse(row.payload) as AnsweredInput };
  };
  return { store, backend, transport, router, routerOptions, input, inboundRow };
}

let deliverSeq = 0;
async function deliverAll(store: Store) {
  await new Delivery(store, { sendText: async () => ({ providerId: `sent-${deliverSeq++}` }) }, {
    projectScope: "test",
    chatGuid: () => BASE_OPTIONS.chatGuid,
    enabled: () => true,
  }).tick();
}

test("#111 Attribution A (4E4F2BD7 replay): un-quoted send on already-answered active turn credits pending inbound and retires its turn", async () => {
  const start = Date.parse("2026-11-22T14:57:00Z");
  setSystemTime(start);
  const h = setup({ replyMode: "tool" });
  h.input("M1", "First question");
  await h.router.tick();
  expect(h.backend.prompts).toHaveLength(1);

  const api = createApi({
    store: h.store,
    router: () => h.router,
    photon: { react: async () => {} },
    chatGuid: () => BASE_OPTIONS.chatGuid,
    enabled: () => true,
    health: () => ({}),
  });

  // 1. Agent answers M1 via imessage_send and delivery completes -> M1 has answeredAt.
  const res1 = await api(new Request("http://localhost/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "ses_1", dedupeKey: "reply-1", text: "Answer to M1" }),
  }));
  expect(res1.status).toBe(202);
  await deliverAll(h.store);
  expect(h.inboundRow("M1").payload.answeredAt).toBeNumber();

  // 2. M2 arrives while T is active and cannot steer (stays pending).
  setSystemTime(start + 10_000);
  h.input("4E4F2BD7", "Follow up");
  h.store.set("human-own-turn:4E4F2BD7", true);

  // 3. Agent sends a second un-quoted imessage_send on T -> attributed via pending_inbound to 4E4F2BD7.
  const logs = await captureLogs(async () => {
    const res2 = await api(new Request("http://localhost/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "ses_1", dedupeKey: "reply-2", text: "Answer to M2" }),
    }));
    expect(res2.status).toBe(202);
    await deliverAll(h.store);
  });

  const sentLog = logs.find(l => l.name === "reply.sent" && l.props?.kind === "conversation");
  expect(sentLog?.props?.attribution).toBe("pending_inbound");
  expect(sentLog?.ids?.inboundId).toBe("4E4F2BD7");

  const m2 = h.inboundRow("4E4F2BD7");
  expect(m2.payload.answeredAt).toBeNumber();
  expect(m2.state).toBe("done");
  expect(h.store.get<boolean>("human-own-turn:4E4F2BD7")).toBe(false);

  // 4. Turn T finishes; no redundant turn is ever dispatched for 4E4F2BD7.
  h.backend.final("ses_1", "NO_REPLY");
  await h.router.tick();
  await h.router.tick();
  expect(h.backend.prompts).toHaveLength(1);
});

test("#111 Attribution A guard: does NOT over-credit pending inbound while active turn's own inbound is unanswered", async () => {
  const start = Date.parse("2026-11-22T15:00:00Z");
  setSystemTime(start);
  const h = setup({ replyMode: "tool" });
  h.input("M1", "First question");
  await h.router.tick();

  // M2 is pending while M1 has NOT been answered yet.
  h.input("M2", "Second question");
  h.store.set("human-own-turn:M2", true);

  const api = createApi({
    store: h.store,
    router: () => h.router,
    photon: { react: async () => {} },
    chatGuid: () => BASE_OPTIONS.chatGuid,
    enabled: () => true,
    health: () => ({}),
  });

  const logs = await captureLogs(async () => {
    const res = await api(new Request("http://localhost/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "ses_1", dedupeKey: "reply-m1", text: "Answer to M1" }),
    }));
    expect(res.status).toBe(202);
    await deliverAll(h.store);
  });

  const sentLog = logs.find(l => l.name === "reply.sent" && l.props?.kind === "conversation");
  expect(sentLog?.props?.attribution).toBe("active_turn");
  expect(h.inboundRow("M1").payload.answeredAt).toBeNumber();
  expect(h.inboundRow("M2").payload.answeredAt).toBeUndefined();
  expect(h.inboundRow("M2").state).toBe("pending");
});

// #138: one owner reply on 23 Nov 17:50Z credited 212 stranded rows up to 74 days old.
async function answeredTurnWithQueued(start: number, queued: { id: string; receivedAt?: number; state: "pending" | "batched" }[]) {
  setSystemTime(start);
  const h = setup({ replyMode: "tool" });
  h.input("M1", "First question");
  await h.router.tick();
  const api = createApi({
    store: h.store,
    router: () => h.router,
    photon: { react: async () => {} },
    chatGuid: () => BASE_OPTIONS.chatGuid,
    enabled: () => true,
    health: () => ({}),
  });
  const send = (dedupeKey: string) => api(new Request("http://localhost/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "ses_1", dedupeKey, text: "Answer" }),
  }));
  expect((await send("reply-1")).status).toBe(202);
  await deliverAll(h.store);
  expect(h.inboundRow("M1").payload.answeredAt).toBeNumber();
  for (const row of queued) {
    h.input(row.id, `queued ${row.id}`, { receivedAt: row.receivedAt });
    if (row.state === "batched") h.store.updateInbound(row.id, "batched");
  }
  const logs = await captureLogs(async () => {
    expect((await send("reply-2")).status).toBe(202);
    await deliverAll(h.store);
  });
  return { h, logs };
}

test("#138 pending_inbound credits only queued rows from the last hour", async () => {
  const start = Date.parse("2026-11-23T17:50:00Z");
  const { h, logs } = await answeredTurnWithQueued(start, [
    { id: "STALE_7D", receivedAt: start - 7 * 24 * 60 * 60_000, state: "batched" },
    { id: "STALE_2H", receivedAt: start - 2 * 60 * 60_000, state: "pending" },
    { id: "JUST_OVER", receivedAt: start - PENDING_ATTRIBUTION_MAX_AGE_MS - 1, state: "pending" },
    { id: "UNDATED", receivedAt: undefined, state: "pending" },
    { id: "NAN", receivedAt: Number.NaN, state: "batched" },
    { id: "AT_LIMIT", receivedAt: start - PENDING_ATTRIBUTION_MAX_AGE_MS, state: "batched" },
    { id: "RECENT", receivedAt: start - 30 * 60_000, state: "pending" },
  ]);
  const sent = logs.find(l => l.name === "reply.sent" && l.props?.kind === "conversation");
  expect(sent?.props?.attribution).toBe("pending_inbound");
  expect(sent?.ids?.inboundId).toBe("AT_LIMIT");
  expect(h.inboundRow("AT_LIMIT").payload.answeredAt).toBeNumber();
  expect(h.inboundRow("RECENT").payload.answeredAt).toBeNumber();
  for (const id of ["STALE_7D", "STALE_2H", "JUST_OVER", "UNDATED", "NAN"]) {
    expect(h.inboundRow(id).payload.answeredAt).toBeUndefined();
  }
  expect(logs.filter(l => l.name === "inbound.answered").map(l => l.ids?.inboundId).sort()).toEqual(["AT_LIMIT", "RECENT"]);
});

test("#138 only stale or undated queued rows: un-quoted send credits none of them", async () => {
  const start = Date.parse("2026-11-23T17:50:00Z");
  const { h, logs } = await answeredTurnWithQueued(start, [
    { id: "STALE_74D", receivedAt: start - 74 * 24 * 60 * 60_000, state: "batched" },
    { id: "STALE_2H", receivedAt: start - 2 * 60 * 60_000, state: "pending" },
    { id: "UNDATED", receivedAt: undefined, state: "batched" },
  ]);
  const sent = logs.find(l => l.name === "reply.sent" && l.props?.kind === "conversation");
  expect(sent?.props?.attribution).not.toBe("pending_inbound");
  for (const id of ["STALE_74D", "STALE_2H", "UNDATED"]) {
    const row = h.inboundRow(id);
    expect(row.payload.answeredAt).toBeUndefined();
    expect(row.state).not.toBe("done");
  }
  expect(logs.filter(l => l.name === "inbound.answered")).toHaveLength(0);
});

test("#138 the first unanswered sweep settles stranded rows even in a group chat", async () => {
  const start = Date.parse("2026-11-24T08:00:00Z");
  setSystemTime(start);
  const h = setup();
  h.input("OCT21", "stranded", { receivedAt: Date.parse("2026-10-21T10:00:00Z") });
  h.store.updateInbound("OCT21", "batched");
  h.store.set("unanswered-chat", "other");
  await h.router.checkUnanswered();
  expect(h.inboundRow("OCT21").state).toBe("done");
  expect(h.inboundRow("OCT21").payload.settledReason).toBe("stale_stranded");
  expect(h.inboundRow("OCT21").payload.answeredAt).toBeUndefined();
});

test("#111 own-turn NO_REPLY settles cleanly (23 Nov BB27B14C replay): no requeue loop, answeredAt stays unset, #59 alarm stays silent", async () => {
  const start = Date.parse("2026-11-23T02:27:00Z");
  setSystemTime(start);
  const alerts: string[][] = [];
  const h = setup({ replyMode: "tool", notifyUnanswered: async (...args) => { alerts.push(args); return true; } });

  // Simulate BB27B14C queued with human-own-turn=true (e.g. after steer-skip or refusal).
  h.input("BB27B14C", "All good thanks");
  h.store.set("human-own-turn:BB27B14C", true);
  await h.router.tick();
  expect(h.backend.prompts).toHaveLength(1);
  // landed() cleared human-own-turn and tracked BB27B14C on the own turn.
  expect(h.store.get<boolean>("human-own-turn:BB27B14C")).toBe(false);

  // Agent finishes own turn with NO_REPLY: retries up to MAX_NO_REPLY_REQUEUES (2),
  // and if the retries also return NO_REPLY it settles cleanly without looping.
  h.backend.final("ses_1", "NO_REPLY");
  const logs = await captureLogs(async () => {
    await h.router.tick();
    await h.router.tick();
    expect(h.backend.prompts).toHaveLength(2);
    h.backend.final("ses_1", "NO_REPLY");
    await h.router.tick();
    await h.router.tick();
    expect(h.backend.prompts).toHaveLength(3);
    h.backend.final("ses_1", "NO_REPLY");
    await h.router.tick();
    await h.router.tick();
  });

  expect(logs.some(l => l.name === "inbound.settled" && l.ids?.inboundId === "BB27B14C" && l.props?.reason === "agent_no_reply")).toBe(true);
  expect(logs.filter(l => l.name === "inbound.requeued")).toHaveLength(2);
  expect(logs.filter(l => l.name === "inbound.requeue_capped")).toHaveLength(1);
  expect(logs.filter(l => l.name === "inbound.unanswered")).toHaveLength(0);
  expect(h.backend.prompts).toHaveLength(3);

  const row = h.inboundRow("BB27B14C");
  expect(row.state).toBe("done");
  expect(row.payload.settledAt).toBeNumber();
  expect(row.payload.settledReason).toBe("agent_no_reply");
  expect(row.payload.answeredAt).toBeUndefined();

  // #59 unanswered watchdog stays silent even 15 minutes later.
  setSystemTime(start + 15 * 60_000);
  const overdueLogs = await captureLogs(async () => { await h.router.checkUnanswered(); });
  expect(overdueLogs.filter(l => l.name === "inbound.overdue")).toHaveLength(0);
  expect(alerts).toEqual([]);
});

test("#111 repeated background_no_reply requeues hit hard cap at 2 (574D3BAD shape)", async () => {
  const start = Date.parse("2026-11-22T15:00:00Z");
  setSystemTime(start);
  const h = setup();
  h.input("574D3BAD", "Check this");
  h.store.updateInbound("574D3BAD", "admitted");

  const logs = await captureLogs(async () => {
    expect(requeueHuman(h.store, "574D3BAD", "background_no_reply", { completed: true })).toBe("requeued");
    h.store.set("human-own-turn:574D3BAD", false);
    h.store.updateInbound("574D3BAD", "admitted");
    expect(requeueHuman(h.store, "574D3BAD", "background_no_reply", { completed: true })).toBe("requeued");
    // Simulate turn running and ending NO_REPLY again without being answered:
    h.store.set("human-own-turn:574D3BAD", false);
    h.store.updateInbound("574D3BAD", "admitted");
    expect(requeueHuman(h.store, "574D3BAD", "background_no_reply", { completed: true })).toBe("capped");
  });

  expect(logs.filter(l => l.name === "inbound.requeued")).toHaveLength(2);
  expect(logs.find(l => l.name === "inbound.requeued")?.props).toMatchObject({ reason: "background_no_reply", attempt: 1 });
  expect(logs.find(l => l.name === "inbound.requeue_capped")).toMatchObject({
    ids: { inboundId: "574D3BAD" },
    props: { reason: "background_no_reply", count: 2 },
  });
  const row = h.inboundRow("574D3BAD");
  expect(row.state).toBe("done");
  expect(row.payload.settledReason).toBe("agent_no_reply");
  expect(row.payload.answeredAt).toBeUndefined();
});

test("#130 backoff releases chat hold so a wake or newer message can run while failed inbound backs off", async () => {
  let now = Date.parse("2026-11-23T05:51:00Z");
  setSystemTime(now);
  const h = setup({ failureNoticeMs: 1_000 });

  h.input("FAIL_BACKOFF", "First");
  h.store.set("human-own-turn:FAIL_BACKOFF", true);
  await h.router.tick();
  expect(h.backend.prompts).toHaveLength(1);

  now += 300; setSystemTime(now);
  h.backend.failed("ses_1", "Session not found");
  await h.router.tick();
  // Attempt 1 retries immediately (0ms backoff); attempt 2 enters 5s backoff.
  await h.router.tick();
  expect(h.backend.prompts).toHaveLength(2);
  now += 300; setSystemTime(now);
  h.backend.failed("ses_1", "Session not found");
  await h.router.tick();

  // During 5s backoff: FAIL_BACKOFF is held, NOT starving a watcher wake.
  now += 1_500; setSystemTime(now);
  h.input("wake:between", "Watcher ping", { source: "composed" });
  await h.router.tick();
  expect(h.backend.prompts).toHaveLength(3);
  expect(h.backend.prompts[2]!.text).toContain("Watcher ping");
});

test("#130 23 Nov 1CEA8B33 replay: exponential backoff, 3 consecutive failures rotate thread, Thread 2 succeeds", async () => {
  let now = Date.parse("2026-11-23T05:51:00Z");
  setSystemTime(now);
  const h = setup({ failureNoticeMs: 1_000 });
  h.input("1CEA8B33", "What happened?");
  h.store.set("human-own-turn:1CEA8B33", true);

  const logs = await captureLogs(async () => {
    const expectedBackoffs = [HUMAN_FAILURE_BACKOFF_MS[0], HUMAN_FAILURE_BACKOFF_MS[1], HUMAN_FAILURE_BACKOFF_MS[2]];
    for (let attempt = 1; attempt <= 3; attempt++) {
      await h.router.tick();
      expect(h.backend.prompts).toHaveLength(attempt);
      expect(h.backend.prompts.at(-1)!.id).toBe("ses_1");
      now += 400; setSystemTime(now);
      h.backend.failed("ses_1", "Session not found");
      await h.router.tick();

      // Still backing off 1s before expiry (when backoff > 0): tick() must NOT dispatch early.
      const backoff = expectedBackoffs[attempt - 1]!;
      if (backoff > 0) {
        now += backoff - 1_000; setSystemTime(now);
        await h.router.tick();
        expect(h.backend.prompts).toHaveLength(attempt);
        now += 1_000; setSystemTime(now);
      }
    }

    // Attempt 4 rotates ses_1 -> ses_2 and succeeds!
    await h.router.tick();
    expect(h.backend.prompts).toHaveLength(4);
    expect(h.backend.prompts.at(-1)!.id).toBe("ses_2");

    now += 500; setSystemTime(now);
    h.backend.final("ses_2", "Recovered on fresh thread");
    await h.router.tick();
    await deliverAll(h.store);
  });

  const requeues = logs.filter(l => l.name === "inbound.requeued" && l.ids?.inboundId === "1CEA8B33");
  expect(requeues.map(l => ({ attempt: l.props?.attempt, backoffMs: l.props?.backoffMs, reason: l.props?.reason }))).toEqual([
    { attempt: 1, backoffMs: 0, reason: "turn_failed" },
    { attempt: 2, backoffMs: 5_000, reason: "turn_failed" },
    { attempt: 3, backoffMs: 15_000, reason: "turn_failed" },
  ]);

  const rotated = logs.find(l => l.name === "context.rotated");
  expect(rotated?.props?.reason).toBe("providerFailureStreak");
  expect(rotated?.props?.streakCount).toBe(3);
  expect(rotated?.ids).toMatchObject({ fromThreadId: "ses_1", toThreadId: "ses_2" });

  // Zero premature failure notices during retries.
  expect(h.store.db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM outbox WHERE json_extract(payload, '$.kind') = 'control'").get()!.c).toBe(0);
  expect(h.inboundRow("1CEA8B33").payload.answeredAt).toBeNumber();
  expect(h.store.get("routeFailureStreak")).toBeNull();
});

test("#130 hard stop at attempt 5 across routes + restart persistence + single OUTAGE_TEXT notice + never silently settled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spectrum-retry-exhausted-"));
  dirs.push(dir);
  const dbPath = join(dir, "state.sqlite");
  let now = Date.parse("2026-11-23T06:00:00Z");
  setSystemTime(now);

  const h = setup({ failureNoticeMs: 1_000 }, dbPath);
  h.input("EXHAUST1", "Need help");
  h.store.set("human-own-turn:EXHAUST1", true);

  const logs = await captureLogs(async () => {
    // Attempts 1..3 fail on ses_1.
    for (let attempt = 1; attempt <= 3; attempt++) {
      await h.router.tick();
      now += 300; setSystemTime(now);
      h.backend.failed("ses_1", "Session not found");
      await h.router.tick();
      now += HUMAN_FAILURE_BACKOFF_MS[attempt - 1]!; setSystemTime(now);
    }

    // Simulate bridge process restart before attempt 4: persisted attempt count must survive.
    const backend = h.backend;
    const transport = h.transport;
    const routerOptions = h.routerOptions;
    h.store.close();
    const reopened = new Store(dbPath);
    stores.push(reopened);
    const restartedRouter = new Router(reopened, backend, transport, routerOptions);

    // Attempt 4 rotates to ses_2 and fails (backoff 120s).
    await restartedRouter.tick();
    expect(backend.prompts.at(-1)!.id).toBe("ses_2");
    now += 300; setSystemTime(now);
    backend.failed("ses_2", "Session not found");
    await restartedRouter.tick();
    expect(reopened.get<number>("human-failed-attempts:EXHAUST1")).toBe(4);

    // Advance 120s -> Attempt 5 runs on ses_2 and fails -> HARD STOP!
    now += HUMAN_FAILURE_BACKOFF_MS[3]!; setSystemTime(now);
    await restartedRouter.tick();
    expect(backend.prompts).toHaveLength(MAX_FAILED_ATTEMPTS);
    now += 300; setSystemTime(now);
    backend.failed("ses_2", "Session not found");
    await restartedRouter.tick();

    // Advance 15 min: tick(), checkUnanswered(), checkFailedInbound() must NOT dispatch again.
    now += 15 * 60_000; setSystemTime(now);
    await restartedRouter.tick();
    await restartedRouter.checkUnanswered();
    await restartedRouter.checkFailedInbound();
    await restartedRouter.tick();
    expect(backend.prompts).toHaveLength(MAX_FAILED_ATTEMPTS);

    const row = reopened.db.query<{ state: string; payload: string }, [string]>("SELECT state, payload FROM inbound WHERE id = ?").get("EXHAUST1")!;
    const payload = JSON.parse(row.payload) as AnsweredInput;
    expect(row.state).toBe("failed");
    expect(payload.answeredAt).toBeUndefined();
    expect(payload.settledAt).toBeUndefined();

    // #129: the exhausted notice is operational, so it goes to Telegram once and never to the chat.
    expect(reopened.pendingOutbox().filter(op => op.kind === "control")).toHaveLength(0);
    const notices = reopened.operationalNotices();
    expect(notices.map(n => [n.id, n.kind, n.chat])).toEqual([["imessage:failed:owner:EXHAUST1:exhausted", "failed", "owner"]]);
    expect(notices[0]!.text).toStartWith("Owner chat: ");
    expect(notices[0]!.text).not.toContain("technical problem");
  });

  const exhausted = logs.find(l => l.name === "inbound.retry_exhausted");
  expect(exhausted).toMatchObject({
    ok: false,
    ids: { inboundId: "EXHAUST1", threadId: "ses_2" },
    props: { attempt: 5, reason: "turn_failed" },
  });
});

test("steer refusal fix: retrySafe no_steerable_turn retries steer after STEER_RETRY_MS instead of setting human-own-turn, caps at 2, and preserves retrySafe=false", async () => {
  let now = Date.parse("2026-11-23T07:00:00Z");
  setSystemTime(now);
  const h = setup();

  // Start an active human turn T1.
  h.input("T1", "Working on something");
  await h.router.tick();
  expect(h.backend.prompts).toHaveLength(1);

  // Subcase 1: 1st steer returns retrySafe=true no_steerable_turn, 2nd steer after 3s succeeds!
  let steerCalls = 0;
  h.backend.steerBehavior = async (call, opts) => {
    steerCalls++;
    if (steerCalls === 1) {
      opts?.onFailure?.(new ControlError(409, "conflict", { reason: "no_steerable_turn", retrySafe: true }));
      return "refused";
    }
    h.backend.recordsBySession.get(call.id)!.push({ id: call.messageId, type: "user", text: call.text, time: { created: Date.now() } });
    return "steered";
  };

  h.input("S1", "Wait add this too");
  await h.router.tick();
  expect(steerCalls).toBe(1);
  // Must NOT lock to human-own-turn on transient retrySafe=true refusal!
  expect(h.store.get("human-own-turn:S1")).toBeFalsy();
  expect(h.inboundRow("S1").state).toBe("pending");
  expect(h.store.get<string>("batch-phase:S1")).toBe("queued-steer");

  // During 3s STEER_RETRY_MS backoff: no steer retry yet.
  now += 1_500; setSystemTime(now);
  await h.router.tick();
  expect(steerCalls).toBe(1);

  // After 3s STEER_RETRY_MS: retries steer and succeeds!
  now += 2_000; setSystemTime(now);
  await h.router.tick();
  expect(steerCalls).toBe(2);
  expect(h.inboundRow("S1").state).toBe("admitted");

  // Subcase 2: 3 consecutive retrySafe=true refusals on same turn fall back to human-own-turn=true.
  h.backend.steerBehavior = async (_call, opts) => {
    opts?.onFailure?.(new ControlError(409, "conflict", { reason: "no_steerable_turn", retrySafe: true }));
    return "refused";
  };
  h.input("S2", "Another follow-up");
  await h.router.tick();
  expect(h.store.get("human-own-turn:S2")).toBeFalsy();
  now += 3_500; setSystemTime(now);
  await h.router.tick();
  expect(h.store.get("human-own-turn:S2")).toBeFalsy();
  now += 3_500; setSystemTime(now);
  await h.router.tick();
  expect(h.store.get<boolean>("human-own-turn:S2")).toBe(true);

  // Subcase 3: retrySafe=false immediately sets human-own-turn=true (existing contract).
  h.backend.steerBehavior = async (_call, opts) => {
    opts?.onFailure?.(new ControlError(409, "conflict", { reason: "no_steerable_turn", retrySafe: false }));
    return "refused";
  };
  now += 3_500; setSystemTime(now);
  h.input("S3", "Definite refusal");
  await h.router.tick();
  expect(h.store.get<boolean>("human-own-turn:S3")).toBe(true);
});
