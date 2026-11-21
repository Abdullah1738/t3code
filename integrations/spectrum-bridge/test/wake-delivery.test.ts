import { afterEach, expect, setSystemTime, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { ControlError } from "../src/control.ts";
import { OpenChamber, type MessageRecord } from "../src/openchamber.ts";
import { Router } from "../src/router.ts";
import { Store } from "../src/store.ts";
import { captureLogs } from "./log-fixture.ts";
import { WakeDelivery, wakeId, wakeStatus, WAKE_AMBIGUITY_MS } from "../src/wake-delivery.ts";
import { createApi } from "../src/api.ts";
import { parseCommand } from "../src/cli.ts";
import { RobobLinkDown } from "../src/robob-link-gate.ts";

const start = Date.parse("2026-11-19T00:00:00Z");
const id = "wake:ambiguous-test";
const promptId = `msg_${createHash("sha256").update(id).digest("hex")}`;
class Backend extends OpenChamber {
  outcome: "landed" | "absent" | "unreadable" = "absent";
  prompts: string[] = [];
  bodies: { session: string; messageId: string; text: string; system: string }[] = [];
  available = true;
  get linkAvailable() { return this.available; }
  beforePrompt?: () => void;
  afterPrompt?: () => void;
  records: MessageRecord[] = [];
  constructor() { super("http://127.0.0.1:1"); }
  override async request<T>(): Promise<T | undefined> { throw new Error("Unexpected backend access"); }
  override async createChat() { return { id: "session", directory: "/test/chat" }; }
  override async isSessionAutoAccepting() { return false; }
  override async permissions() { return []; }
  override async questions() { return []; }
  override async children() { return []; }
  override async statuses() { return {}; }
  override async getSession() { return { id: "session", directory: "/test/chat", title: "Chat", time: { created: start, updated: start } }; }
  override async messages() {
    if (this.outcome === "unreadable") throw new ControlError(0);
    return this.records;
  }
  override async promptAccepted(_session: string, _directory: string, messageId: string) {
    if (this.outcome === "unreadable") throw new ControlError(0);
    return this.records.some(record => record.type === "user" && record.id === messageId);
  }
  override async prompt(_session: string, _directory: string, messageId: string, text: string, _system: string,
    _parts?: Parameters<OpenChamber["prompt"]>[5], _model?: Parameters<OpenChamber["prompt"]>[6],
    _owner?: Parameters<OpenChamber["prompt"]>[7], beforePost?: () => void) {
    if (!this.available) throw new RobobLinkDown(() => false);
    this.beforePrompt?.();
    beforePost?.();
    this.prompts.push(messageId);
    this.bodies.push({ session: _session, messageId, text, system: _system });
    this.afterPrompt?.();
    if (this.outcome === "landed" && !this.records.some(record => record.id === messageId))
      this.records.push({ id: messageId, type: "user", text, time: { created: Date.now() } });
    throw new ControlError(0);
  }
}
const stores: Store[] = [];
afterEach(() => { stores.splice(0).forEach(store => store.close()); setSystemTime(); });
function setup() {
  setSystemTime(start);
  const store = new Store(":memory:"); stores.push(store);
  const backend = new Backend();
  const router = () => new Router(store, backend, { read: async () => {}, typing: async () => {}, downloadAttachment: async () => { throw new Error("Unexpected file"); } }, {
    owner: "+15555550123", chatGuid: "iMessage;-;+15555550123", timezone: "Asia/Dubai", quietMs: 0, droppedBatchMs: 0,
    skillPath: "/test/skill", alertSkillPath: "/test/alert", alertSocketPath: "/test/alert.sock", openCodeConfigRoot: "/nonexistent/config",
  });
  store.acceptInbound(id, { id, text: "[Watcher event from robob-watch test, not typed by the owner.]\nPRIVATE_EVENT", attachments: [], isAudioMessage: false, receivedAt: start });
  const state = () => store.db.query<{ state: string }, []>("SELECT state FROM inbound WHERE id = 'wake:ambiguous-test'").get()?.state;
  const api = createApi({ store, photon: { react: async () => {} }, router: () => undefined,
    enabled: () => true, chatGuid: () => "iMessage;-;+15555550123", health: () => ({}) });
  const get = (wake = id) => api(new Request(`http://bridge/wake/${wake}`));
  return { store, backend, router, state, api, get };
}

test.each([false, true])("a timed-out wake that landed is admitted without another send (restart=%s)", async restart => {
  const h = setup(); h.backend.outcome = "landed";
  await captureLogs(async () => {
    let router = h.router();
    await router.tick();
    if (restart) router = h.router();
    setSystemTime(start + 60_000);
    await router.tick(); await router.checkInboundLatency();
    expect(h.state()).toBe("done");
    expect(h.store.get<number>(`inbound-delivered:${id}`)).toBeDefined();
    expect(h.backend.prompts).toEqual([promptId]);
  });
});

test.each([false, true].flatMap(gateDown => [false, true].map(restart => ({ gateDown, restart }))))
("held wake fails by its receipt deadline despite a stuck holder $gateDown/$restart", async ({ gateDown, restart }) => {
  const h = setup();
  new WakeDelivery(h.store).accept(id, "robob-watch held");
  const holder = { id: "session", directory: "/test/chat", generation: 1, inboundId: "reset:holder",
    messageId: "msg_holder", phase: "running", startedAt: start - 60_000 };
  h.store.set("route", { id: holder.id, directory: holder.directory, generation: holder.generation });
  h.store.set("activeTurn", holder);
  h.backend.available = !gateDown;
  const logs = await captureLogs(async () => {
    let router = h.router();
    setSystemTime(start + 29 * 60_000);
    await router.checkInboundLatency();
    expect(wakeStatus(h.store, id)?.state).toBe("queued");
    if (restart) router = h.router();
    setSystemTime(start + 30 * 60_000);
    await router.checkInboundLatency();
    await router.checkInboundLatency();
    expect(wakeStatus(h.store, id)).toMatchObject({ state: "failed", attempts: 0, failedAt: Date.now() });
    expect(h.state()).toBe("failed");
    expect(h.store.get<typeof holder>("activeTurn")).toEqual(holder);
    expect(h.backend.prompts).toEqual([]);
    expect(h.store.get<{ id: string }[]>("missedSynthetic")?.map(row => row.id)).toEqual([id]);
  });
  expect(logs.filter(line => line.name === "wake.failed")).toHaveLength(1);
  expect(logs.find(line => line.name === "wake.failed")?.props).toMatchObject({ reason: "delivery_deadline", attempt: 0 });
  expect(logs.some(line => line.name === "wake.waiting" && line.props?.holderPhase === "running")).toBe(true);
});

test.each(["main.ts", "sb-main.ts"].flatMap(file => [false, true].flatMap(restart =>
  [false, true].map(initiallyReady => ({ file, restart, initiallyReady })))))
("$file sender expires receipts while transport is unready ($restart/$initiallyReady)", async ({ file, restart, initiallyReady }) => {
  const h = setup(); new WakeDelivery(h.store).accept(id);
  let router = h.router();
  let backendCalls = 0, deliveryTicks = 0;
  h.backend.promptAccepted = async () => { backendCalls++; return false; };
  h.backend.messages = async () => { backendCalls++; return []; };
  const errors: unknown[] = [], checks: Promise<void>[] = [];
  const backendWork = async () => { backendCalls++; };
  const clock = {
    checkInboundLatency: (...args: Parameters<Router["checkInboundLatency"]>) => {
      const check = router.checkInboundLatency(...args); checks.push(check); return check;
    },
    checkCompletion: backendWork, checkFailedInbound: backendWork, tick: backendWork,
  };
  const delivery = { tick: async () => { deliveryTicks++; } };
  const replyGap = { tick: backendWork };
  // Execute the production interval callback with isolated dependencies, without booting either service.
  const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
  const begin = source.indexOf("  const timer = setInterval(() => {");
  const end = source.indexOf("  }, 1_000);", begin);
  expect(begin).toBeGreaterThan(0); expect(end).toBeGreaterThan(begin);
  let fire: (() => void) | undefined;
  const interval = new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(begin, end + "  }, 1_000);".length));
  const install = new Function("setInterval", "ready", "router", "delivery", "replyGap", "chats", "toolError", "log",
    `let routerBusy = true;\n${interval}`);
  let ready = initiallyReady;
  install((callback: () => void, ms: number) => { expect(ms).toBe(1_000); fire = callback; }, () => ready,
    clock, delivery, replyGap, { all: () => [{ parts: { router: clock, delivery, replyGap, busy: true } }] },
    (...args: unknown[]) => errors.push(args), (...args: unknown[]) => errors.push(args));
  fire!(); await Promise.all(checks.splice(0));
  backendCalls = 0; ready = false;
  const logs = await captureLogs(async () => {
    setSystemTime(start + 29 * 60_000);
    fire!(); await Promise.all(checks.splice(0));
    expect(wakeStatus(h.store, id)?.state).toBe("queued");
    if (restart) router = h.router();
    setSystemTime(start + 30 * 60_000);
    fire!(); await Promise.all(checks.splice(0));
    fire!(); await Promise.all(checks.splice(0));
    expect(wakeStatus(h.store, id)).toMatchObject({ state: "failed", attempts: 0 });
    expect(h.state()).toBe("failed");
  });
  expect(logs.filter(line => line.name === "wake.failed")).toHaveLength(1);
  expect(deliveryTicks).toBe(4);
  expect(backendCalls).toBe(0);
  expect(h.backend.prompts).toEqual([]);
  expect(errors).toEqual([]);
});

test.each([false, true])("held wake deadline runs while a latency probe is still blocked (lateAccepted=%s)", async accepted => {
  const h = setup(); new WakeDelivery(h.store).accept(id);
  const begun = Promise.withResolvers<void>(), result = Promise.withResolvers<boolean>();
  const route = { id: "session", directory: "/test/chat", generation: 1 };
  h.store.set("route", route);
  h.store.set(`failed-delivery:${id}`, { ...route, inboundId: id, messageId: promptId, startedAt: start, phase: "unknown" });
  h.backend.promptAccepted = async () => { begun.resolve(); return result.promise; };
  const logs = await captureLogs(async () => {
    const router = h.router();
    setSystemTime(start + 29 * 60_000);
    const scan = router.checkInboundLatency(); await begun.promise;
    setSystemTime(start + 30 * 60_000);
    const deadline = router.checkInboundLatency();
    const stateAtDeadline = wakeStatus(h.store, id)?.state;
    result.resolve(accepted); await scan; await deadline;
    expect(stateAtDeadline).toBe("failed");
    expect(wakeStatus(h.store, id)?.state).toBe("failed");
    expect(h.backend.prompts).toEqual([]);
    expect(h.store.get("activeTurn")).toBeUndefined();
  });
  expect(logs.filter(line => line.name === "wake.failed")).toHaveLength(1);
});

test("an unsent wake checks its total deadline at the final POST boundary", async () => {
  const h = setup(); new WakeDelivery(h.store).accept(id);
  h.backend.beforePrompt = () => setSystemTime(start + 30 * 60_000);
  const logs = await captureLogs(async () => {
    setSystemTime(start + 29 * 60_000);
    await h.router().tick();
    expect(wakeStatus(h.store, id)).toMatchObject({ state: "failed", attempts: 0 });
    expect(h.backend.prompts).toEqual([]);
  });
  expect(logs.filter(line => line.name === "wake.failed")).toHaveLength(1);
});

test("waiting diagnostics are periodic across restart and contain no event body", async () => {
  const h = setup(); h.backend.available = false; new WakeDelivery(h.store).accept(id);
  const logs = await captureLogs(async () => {
    await h.router().checkInboundLatency();
    setSystemTime(start + 5 * 60_000 - 1); await h.router().checkInboundLatency();
    setSystemTime(start + 5 * 60_000); await h.router().checkInboundLatency();
  });
  const waiting = logs.filter(line => line.name === "wake.waiting");
  expect(waiting).toHaveLength(2);
  expect(waiting.map(line => line.props)).toEqual([0, 5 * 60_000].map(waitMs => ({
    source: "bridge", reason: "link_down", waitMs, boundMs: 30 * 60_000, remainingMs: 30 * 60_000 - waitMs,
  })));
  expect(JSON.stringify(logs)).not.toContain("PRIVATE_EVENT");
});

test("a failed reply reminder cannot strand its sealed wake past the delivery deadline", async () => {
  const h = setup(), reminder = "wake:reply-nudge:sealed-reminder";
  new WakeDelivery(h.store).accept(id);
  h.store.acceptInbound(reminder, { id: reminder, text: "PRIVATE_REMINDER", attachments: [], receivedAt: start });
  const logs = await captureLogs(async () => {
    const router = h.router(); await router.tick();
    for (const elapsed of [60_000, 120_000]) { setSystemTime(start + elapsed); await router.tick(); }
    expect(wakeStatus(h.store, reminder)?.state).toBe("failed");
    const sent = h.backend.prompts.length;
    setSystemTime(start + 30 * 60_000); await router.checkInboundLatency();
    expect(wakeStatus(h.store, id)?.state).toBe("failed");
    expect(h.state()).toBe("failed");
    expect(h.store.get<{ id: string; uncertain?: boolean }[]>("missedSynthetic"))
      .toEqual([expect.objectContaining({ id, uncertain: true })]);
    await h.router().tick();
    expect(h.backend.prompts).toHaveLength(sent);
  });
  expect(logs.filter(line => line.name === "wake.failed" && line.ids?.inboundId === id)).toHaveLength(1);
});

test.each(["wake:failed-sibling", "wake:reply-nudge:failed-sibling"].flatMap(failedId =>
  [false, true].map(failedLeader => ({ failedId, failedLeader }))))
("a terminal batch member cannot block expiry $failedId/$failedLeader", async ({ failedId, failedLeader }) => {
  const h = setup();
  const tracker = new WakeDelivery(h.store); tracker.accept(id);
  h.store.acceptInbound(failedId, { id: failedId, text: "PRIVATE_FAILED", attachments: [], receivedAt: start });
  tracker.accept(failedId); tracker.failed(failedId, "attempts_exhausted");
  const leader = failedLeader ? failedId : id, member = failedLeader ? id : failedId;
  h.store.set(`batch:${leader}`, { id: leader, text: "PRIVATE_BATCH", attachments: [], batchIds: [leader, member], receivedAt: start });
  h.store.updateInbound(leader, "processing"); h.store.updateInbound(member, "batched");
  h.backend.available = false;
  const logs = await captureLogs(async () => {
    setSystemTime(start + 30 * 60_000); await h.router().checkInboundLatency();
    expect(wakeStatus(h.store, id)).toMatchObject({ state: "failed", attempts: 0 });
    expect(h.state()).toBe("failed");
    expect(h.backend.prompts).toEqual([]);
  });
  expect(logs.filter(line => line.name === "wake.failed" && line.ids?.inboundId === id)).toHaveLength(1);
});

test.each([30 * 60_000, 24 * 60 * 60_000, 24 * 60 * 60_000 + 1])("legacy wake migration expires age=%s once, with no stale notice after 24 hours", async age => {
  const h = setup();
  setSystemTime(start + age);
  await captureLogs(async () => {
    const router = h.router();
    await router.tick(); await router.tick();
    expect(h.state()).toBe("failed");
    expect(wakeStatus(h.store, id)?.state).toBe("failed");
    expect(h.backend.prompts).toEqual([]);
    expect(h.store.pendingOutbox().filter(op => op.kind === "control")).toHaveLength(age <= 24 * 60 * 60_000 ? 1 : 0);
    expect(h.store.get<{ id: string }[]>("missedSynthetic")?.some(row => row.id === id) ?? false).toBe(age <= 6 * 60 * 60_000);
  });
});

test("an ambiguous wake expires on the local clock even while the link gate stays down, across restart", async () => {
  const h = setup(); h.backend.outcome = "unreadable";
  await captureLogs(async () => {
    await h.router().tick();
    h.backend.available = false;
    setSystemTime(start + WAKE_AMBIGUITY_MS - 1);
    let router = h.router(); await router.tick();
    expect(h.state()).not.toBe("failed");
    setSystemTime(start + WAKE_AMBIGUITY_MS);
    router = h.router(); await router.tick();
    expect(h.state()).toBe("failed");
    expect(wakeStatus(h.store, id)?.state).toBe("failed");
    expect(h.backend.prompts).toEqual([promptId]);
    h.backend.available = true; await router.tick();
    expect(h.store.pendingOutbox().filter(op => op.kind === "control")).toHaveLength(1);
  });
});

test("a wake held before any POST expires without inventing a send attempt", async () => {
  const h = setup(); h.backend.available = false;
  await captureLogs(async () => {
    new WakeDelivery(h.store).accept(id);
    const router = h.router(); await router.tick();
    setSystemTime(start + WAKE_AMBIGUITY_MS + 60_000);
    await router.tick();
    expect(h.state()).toBe("failed");
    expect(wakeStatus(h.store, id)).toMatchObject({ state: "failed", attempts: 0 });
    expect(wakeStatus(h.store, id)?.firstSendAt).toBeUndefined();
    h.backend.available = true; h.backend.outcome = "landed";
    await router.tick();
    expect(wakeStatus(h.store, id)?.state).toBe("failed");
    expect(h.backend.prompts).toEqual([]);
  });
});

test("a POST failure that closes the gate is ambiguous, while a typed pre-send refusal is unsent", async () => {
  const h = setup();
  const logs = await captureLogs(async () => {
    h.backend.afterPrompt = () => { h.backend.available = false; };
    await h.router().tick();
    expect(wakeStatus(h.store, id)).toMatchObject({ state: "ambiguous", attempts: 1, firstSendAt: start });
    const tracker = new WakeDelivery(h.store);
    tracker.sending(id, "session"); tracker.unsent(id);
    expect(wakeStatus(h.store, id)).toMatchObject({ state: "ambiguous", attempts: 1, firstSendAt: start });
  });
  expect(logs.filter(line => line.name === "wake.send_ambiguous")).toHaveLength(1);
});

test("unadmitted retries preserve the exact sealed body and members when another wake arrives", async () => {
  const h = setup();
  await captureLogs(async () => {
    let router = h.router(); await router.tick();
    for (const elapsed of [60_000, 120_000]) { setSystemTime(start + elapsed); await router.tick(); }
    const second = "wake:later";
    h.store.acceptInbound(second, { id: second, text: "LATER_PRIVATE_EVENT", attachments: [], isAudioMessage: false, receivedAt: Date.now() });
    for (const elapsed of [150_000, 180_000, 240_000, 300_000, 360_000]) {
      setSystemTime(start + elapsed); router = h.router(); await router.tick();
    }
    const attempts = h.backend.bodies.filter(body => body.messageId === promptId);
    expect(attempts.length).toBeGreaterThan(1);
    expect(attempts.every(body => JSON.stringify(body) === JSON.stringify(attempts[0]))).toBe(true);
    expect(attempts[0]!.text).not.toContain("LATER_PRIVATE_EVENT");
  });
});

test("wake-status hashes exactly the POST key, is session-free and rejects extra input forms", () => {
  for (const key of ["watch:1", "  watch:1  ", "watch/ü:2", "k".repeat(200)])
    expect(parseCommand(["wake-status", "--key", key])).toEqual({ method: "GET", path: `/wake/${wakeId(key)}` });
  for (const args of [[], ["--key", ""], ["--key", "k".repeat(201)], ["--key", "k", "--session", "x"], ["--key", "k", "--text", "PRIVATE"]])
    expect(() => parseCommand(["wake-status", ...args])).toThrow();
});

test.each(["queued", "sending", "ambiguous", "admitted", "failed"] as const)("GET and repeated POST expose %s without body or source data", async state => {
  const h = setup(); const key = "api:status"; const apiId = wakeId(key);
  const body = { source: "robob-watch status", text: "PRIVATE_EVENT", dedupeKey: key };
  const post = () => h.api(new Request("http://bridge/wake", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  await captureLogs(async () => {
    expect((await post()).status).toBe(202);
    const tracker = new WakeDelivery(h.store);
    if (state !== "queued") tracker.sending(apiId, "session");
    if (state === "ambiguous") tracker.ambiguous(apiId, new ControlError(0), 60_000);
    if (state === "admitted") tracker.admitted(apiId);
    if (state === "failed") tracker.failed(apiId, "ambiguity_deadline");
    const before = JSON.stringify(h.store.get(`wake-delivery:${apiId}`));
    const result = await h.get(apiId);
    expect(result.status).toBe(200);
    const status = await result.json();
    expect(status).toMatchObject({ id: apiId, state, acceptedAt: start, attempts: state === "queued" ? 0 : 1 });
    expect(JSON.stringify(status)).not.toMatch(/PRIVATE_EVENT|robob-watch|source|beforeSend|text/);
    expect(JSON.stringify(h.store.get(`wake-delivery:${apiId}`))).toBe(before);
    expect(await (await post()).json()).toEqual({ id: apiId, created: false, state });
  });
});

test("wake status returns 404 for unknown ids and remains available without pairing or a router", async () => {
  const h = setup();
  expect((await h.get("wake:unknown")).status).toBe(404);
  expect((await h.get("not-a-wake")).status).toBe(404);
  const api = createApi({ store: h.store, photon: { react: async () => {} }, router: () => undefined,
    enabled: () => false, chatGuid: () => undefined, health: () => ({}) });
  expect((await api(new Request(`http://bridge/wake/${id}`))).status).toBe(200);
});

test("legacy migration retains its cutoff when the first sweep precedes the deadline", async () => {
  const h = setup(); h.backend.available = false;
  await captureLogs(async () => {
    setSystemTime(start + WAKE_AMBIGUITY_MS - 1);
    await h.router().tick();
    expect(h.state()).toBe("pending");
    setSystemTime(start + WAKE_AMBIGUITY_MS);
    await h.router().tick();
    expect(h.state()).toBe("failed");
    expect(wakeStatus(h.store, id)?.state).toBe("failed");
    expect(h.backend.prompts).toEqual([]);
  });
});

test("migration also retires stranded legacy bus batch members without an owner notice", async () => {
  const h = setup();
  h.store.updateInbound(id, "done");
  const bus = "wake:agent-bus:stale";
  h.store.acceptInbound(bus, { id: bus, text: "PRIVATE_BUS", attachments: [], isAudioMessage: false, receivedAt: start - 25 * 60 * 60_000 });
  h.store.updateInbound(bus, "batched");
  await captureLogs(async () => { await h.router().tick(); });
  expect(h.store.db.query<{ state: string }, [string]>("SELECT state FROM inbound WHERE id=?").get(bus)?.state).toBe("failed");
  expect(wakeStatus(h.store, bus)?.state).toBe("failed");
  expect(h.store.pendingOutbox()).toEqual([]);
  expect(h.store.get("missedSynthetic")).toBeUndefined();
});

test("a late first send landing between absence read and retry is deduplicated under the original key", async () => {
  const h = setup();
  const logs = await captureLogs(async () => {
    const router = h.router(); await router.tick();
    // The first HTTP operation can still commit after the fresh absence read.
    h.backend.beforePrompt = () => {
      h.backend.records.push({ id: promptId, type: "user", text: "PRIVATE_EVENT", time: { created: start } });
      h.backend.outcome = "landed";
    };
    setSystemTime(start + 60_000); await router.tick();
    expect(h.backend.prompts).toEqual([promptId, promptId]);
    expect(h.backend.records.filter(record => record.id === promptId)).toHaveLength(1);
    expect(wakeStatus(h.store, id)?.state).toBe("admitted");
    expect(h.state()).toBe("done");
    expect(h.store.pendingOutbox()).toEqual([]);
  });
  expect(logs.filter(line => line.name === "wake.admitted")).toHaveLength(1);
});

test("a batch with permanently unreadable receipts retires every member once at its deadline", async () => {
  const h = setup(); const second = "wake:batch-member";
  h.backend.outcome = "unreadable";
  h.store.acceptInbound(second, { id: second, text: "PRIVATE_SECOND", attachments: [], isAudioMessage: false, receivedAt: start });
  const logs = await captureLogs(async () => {
    let router = h.router(); await router.tick();
    setSystemTime(start + WAKE_AMBIGUITY_MS); router = h.router(); await router.tick(); await router.tick();
    for (const member of [id, second]) expect(wakeStatus(h.store, member)?.state).toBe("failed");
    expect(h.store.pendingInbound()).toEqual([]);
    expect(h.store.get<{ id: string }[]>("missedSynthetic")?.map(row => row.id)).toEqual([id, second]);
    expect(h.store.pendingOutbox().filter(op => op.kind === "control")).toHaveLength(1);
    expect(h.backend.prompts).toEqual([promptId]);
  });
  expect(logs.filter(line => line.name === "wake.failed")).toHaveLength(2);
});

test("/new finishes every cancelled ambiguous wake member without replaying its original operation", async () => {
  const h = setup(), second = "wake:cancelled-member";
  h.store.acceptInbound(second, { id: second, text: "PRIVATE_SECOND", attachments: [], receivedAt: start });
  const logs = await captureLogs(async () => {
    let router = h.router(); await router.tick();
    h.backend.abort = async () => true;
    h.store.acceptInbound("owner-reset", { id: "owner-reset", text: "/new", source: "typed", attachments: [], receivedAt: start + 1_000 });
    setSystemTime(start + 1_000); await router.tick();
    router = h.router(); setSystemTime(start + 31 * 60_000); await router.tick();
    for (const member of [id, second]) expect(wakeStatus(h.store, member)?.state).toBe("failed");
    expect(h.store.get<{ id: string }[]>("missedSynthetic")?.map(row => row.id)).toEqual([id, second]);
    expect(h.backend.prompts).toEqual([promptId]);
  });
  expect(logs.filter(line => line.name === "wake.failed")).toHaveLength(2);
});

test.each(["absent", "accepted", "unreadable", "before_post"] as const)("ambiguity expiry fences a retry when %s crosses the deadline", async boundary => {
  const h = setup();
  await captureLogs(async () => {
    const router = h.router(); await router.tick();
    for (const elapsed of [60_000, 120_000]) { setSystemTime(start + elapsed); await router.tick(); }
    const sends = h.backend.prompts.length;
    const begun = Promise.withResolvers<void>(), result = Promise.withResolvers<boolean>();
    if (boundary !== "before_post") h.backend.promptAccepted = async () => { begun.resolve(); return result.promise; };
    else h.backend.beforePrompt = () => setSystemTime(start + WAKE_AMBIGUITY_MS + 1);
    setSystemTime(start + WAKE_AMBIGUITY_MS - 1);
    const retry = router.tick();
    if (boundary !== "before_post") {
      await begun.promise; setSystemTime(start + WAKE_AMBIGUITY_MS + 1);
      if (boundary === "unreadable") result.reject(new ControlError(0));
      else result.resolve(boundary === "accepted");
    }
    await retry;
    expect(h.backend.prompts).toHaveLength(sends);
    expect(wakeStatus(h.store, id)?.state).toBe("failed");
    expect(h.state()).toBe("failed");
    expect(h.store.pendingInbound()).toEqual([]);
  });
});

test("gate closure at exhaustion commits terminal inbound state for the whole wake batch", async () => {
  const h = setup(), second = "wake:exhausted-member";
  h.store.acceptInbound(second, { id: second, text: "PRIVATE_SECOND", attachments: [], receivedAt: start });
  await captureLogs(async () => {
    let router = h.router(); await router.tick();
    for (const elapsed of [60_000, 120_000, 150_000, 240_000, 300_000]) { setSystemTime(start + elapsed); await router.tick(); }
    h.backend.promptAccepted = async () => { h.backend.available = false; return false; };
    setSystemTime(start + 360_000); await router.tick();
    for (const member of [id, second]) {
      expect(wakeStatus(h.store, member)?.state).toBe("failed");
      expect(h.store.db.query<{ state: string }, [string]>("SELECT state FROM inbound WHERE id=?").get(member)?.state).toBe("failed");
    }
    const sends = h.backend.prompts.length;
    h.backend.available = true; h.backend.promptAccepted = async () => false;
    router = h.router(); await router.tick();
    setSystemTime(start + 31 * 60_000); await router.tick();
    expect(h.store.pendingInbound()).toEqual([]);
    expect(h.backend.prompts).toHaveLength(sends);
    expect(h.store.pendingOutbox().filter(op => op.kind === "control")).toHaveLength(1);
  });
});

test("retiring the sealed retry destination fails every member with notice and carry", async () => {
  const h = setup(), second = "wake:retired-member";
  h.store.acceptInbound(second, { id: second, text: "PRIVATE_SECOND", attachments: [], receivedAt: start });
  await captureLogs(async () => {
    const router = h.router(); await router.tick();
    for (const elapsed of [60_000, 120_000]) { setSystemTime(start + elapsed); await router.tick(); }
    h.store.set("route", { id: "replacement", directory: "/replacement", generation: 2 });
    setSystemTime(start + 150_000); await router.tick();
    for (const member of [id, second]) expect(wakeStatus(h.store, member)?.state).toBe("failed");
    expect(h.store.get<{ id: string }[]>("missedSynthetic")?.map(row => row.id)).toEqual([id, second]);
    expect(h.store.pendingInbound()).toEqual([]);
    expect(h.backend.bodies.every(body => body.session === "session")).toBe(true);
  });
});

test.each([false, true].flatMap(modern => [-1, 0, 1].map(offset => ({ modern, offset }))))
("preparation rechecks the receipt cutoff $modern/$offset", async ({ modern, offset }) => {
  const h = setup();
  if (modern) new WakeDelivery(h.store).accept(id);
  await captureLogs(async () => {
    const begun = Promise.withResolvers<void>(), created = Promise.withResolvers<void>();
    h.backend.createChat = async () => { begun.resolve(); await created.promise; return { id: "session", directory: "/test/chat" }; };
    setSystemTime(start + WAKE_AMBIGUITY_MS - 2);
    const tick = h.router().tick(); await begun.promise;
    setSystemTime(start + WAKE_AMBIGUITY_MS + offset); created.resolve(); await tick;
    const expired = offset >= 0;
    expect(h.backend.prompts).toHaveLength(expired ? 0 : 1);
    expect(wakeStatus(h.store, id)?.state).toBe(expired ? "failed" : "ambiguous");
    expect(h.state()).toBe(expired ? "failed" : "processing");
  });
});

test.each([false, true])("an unadmitted execution retry exhausts without erasing prior admission (gateCloses=%s)", async gateCloses => {
  const h = setup(), second = "wake:execution-member";
  h.store.acceptInbound(second, { id: second, text: "PRIVATE_SECOND", attachments: [], receivedAt: start });
  h.backend.outcome = "landed";
  const logs = await captureLogs(async () => {
    let router = h.router(); await router.tick();
    const receipt = wakeStatus(h.store, id);
    h.backend.records.push({ id: "provider-error", type: "idle", outcome: "failed", time: { created: start + 1_000 } });
    setSystemTime(start + 1_000); await router.tick();
    h.backend.outcome = "absent";
    const read = h.backend.promptAccepted.bind(h.backend);
    h.backend.promptAccepted = async (...args) => {
      const accepted = await read(...args);
      const turn = h.store.get<{ attempt: number; attemptAt: number; startedAt: number; phase: string }>("activeTurn");
      if (gateCloses && !accepted && (h.store.get<{ attempts: number }>(`synthetic-retry:${id}`)?.attempts ?? 0) >= 2
        && turn && turn.phase !== "failed" && Date.now() - turn.attemptAt >= 60_000
        && (turn.attempt >= 2 || Date.now() - turn.startedAt >= 120_000))
        h.backend.available = false;
      return accepted;
    };
    router = h.router();
    for (let elapsed = 121_000; elapsed <= 10 * 60_000; elapsed += 30_000) { setSystemTime(start + elapsed); await router.tick(); }
    for (const member of [id, second]) {
      expect(wakeStatus(h.store, member)?.state).toBe("admitted");
      expect(h.store.db.query<{ state: string }, [string]>("SELECT state FROM inbound WHERE id=?").get(member)?.state).toBe("failed");
    }
    expect(h.backend.available).toBe(!gateCloses);
    expect(wakeStatus(h.store, id)).toEqual(receipt);
    h.backend.available = true; const sends = h.backend.prompts.length;
    router = h.router(); await router.tick(); await router.tick();
    expect(h.backend.prompts).toHaveLength(sends);
    expect(h.store.pendingInbound()).toEqual([]);
    expect(h.store.pendingOutbox().filter(op => op.kind === "control")).toHaveLength(1);
  });
  expect(logs.filter(line => line.name === "wake.admitted")).toHaveLength(2);
  expect(logs.filter(line => line.name === "wake.failed")).toHaveLength(0);
});

test.each([false, true].flatMap(expiredLeader => (expiredLeader ? [false, true] : [false]).flatMap(reminder =>
  [false, true].flatMap(gateDown => [false, true].map(restart => ({ expiredLeader, reminder, gateDown, restart }))))))
("migration expires the entire sealed batch $expiredLeader/$reminder/$gateDown/$restart", async ({ expiredLeader, reminder, gateDown, restart }) => {
  const h = setup(), second = reminder ? "wake:reply-nudge:mixed-age-sibling" : "wake:mixed-age-sibling";
  if (!expiredLeader) new WakeDelivery(h.store).accept(id);
  setSystemTime(start + 29 * 60_000);
  h.store.acceptInbound(second, { id: second, text: "PRIVATE_SECOND", attachments: [], receivedAt: expiredLeader ? Date.now() : start });
  if (expiredLeader) new WakeDelivery(h.store).accept(second);
  const logs = await captureLogs(async () => {
    h.backend.createChat = async () => { throw new ControlError(0); };
    let router = h.router(); await router.tick();
    expect(h.state()).toBe("processing");
    expect(h.store.db.query<{ state: string }, [string]>("SELECT state FROM inbound WHERE id=?").get(second)?.state).toBe("batched");
    expect(h.backend.prompts).toEqual([]);
    if (restart) router = h.router();
    h.backend.available = !gateDown;
    setSystemTime(start + WAKE_AMBIGUITY_MS); await router.tick();
    for (const member of [id, second]) {
      expect(wakeStatus(h.store, member)).toMatchObject({ state: "failed", attempts: 0 });
      expect(h.store.db.query<{ state: string }, [string]>("SELECT state FROM inbound WHERE id=?").get(member)?.state).toBe("failed");
    }
    h.backend.available = true; h.backend.outcome = "landed";
    h.backend.createChat = async () => ({ id: "session", directory: "/test/chat" });
    router = h.router();
    setSystemTime(start + 61 * 60_000); await router.tick(); await router.checkInboundLatency(); await router.tick();
    expect(h.backend.prompts).toEqual([]);
    expect(h.store.pendingInbound()).toEqual([]);
    expect(h.store.pendingOutbox().filter(op => op.kind === "control")).toHaveLength(1);
    expect(h.store.get<{ id: string }[]>("missedSynthetic")?.map(row => row.id)).toEqual(reminder ? [id] : [id, second]);
  });
  for (const member of [id, second]) expect(logs.filter(line => line.name === "wake.failed" && line.ids?.inboundId === member)).toHaveLength(1);
});

test.each([false, true])("migration keeps attempted mixed-age members fenced together (expiredLeader=%s)", async expiredLeader => {
  const h = setup(), second = "wake:attempted-mixed-age-sibling";
  if (!expiredLeader) new WakeDelivery(h.store).accept(id);
  setSystemTime(start + 29 * 60_000);
  h.store.acceptInbound(second, { id: second, text: "PRIVATE_SECOND", attachments: [], receivedAt: expiredLeader ? Date.now() : start });
  if (expiredLeader) new WakeDelivery(h.store).accept(second);
  await captureLogs(async () => {
    await h.router().tick();
    expect(h.backend.prompts).toEqual([promptId]);
    expect(h.backend.bodies[0]?.text).toContain("PRIVATE_SECOND");
    h.backend.available = false;
    let router = h.router();
    setSystemTime(start + WAKE_AMBIGUITY_MS); await router.tick();
    for (const member of [id, second]) {
      expect(wakeStatus(h.store, member)).toMatchObject({ state: "failed", attempts: 1 });
      expect(h.store.db.query<{ state: string }, [string]>("SELECT state FROM inbound WHERE id=?").get(member)?.state).toBe("failed");
    }
    h.backend.available = true; h.backend.outcome = "landed"; router = h.router();
    setSystemTime(start + 61 * 60_000); await router.tick(); await router.checkInboundLatency(); await router.tick();
    expect(h.backend.prompts).toEqual([promptId]);
    expect(h.store.pendingInbound()).toEqual([]);
    expect(h.store.get<{ id: string; uncertain?: boolean }[]>("missedSynthetic")).toEqual([
      expect.objectContaining({ id, uncertain: true }), expect.objectContaining({ id: second, uncertain: true }),
    ]);
    expect(h.store.pendingOutbox().filter(op => op.kind === "control")).toHaveLength(1);
  });
});

test("lifecycle logs retain source, waiting run, retry timing and final outcomes without event text", async () => {
  const h = setup(); const source = "robob-watch reauth failing";
  h.store.set(`api:wake:${id}`, { spec: JSON.stringify({ source, text: "PRIVATE_EVENT" }) });
  const logs = await captureLogs(async () => {
    const tracker = new WakeDelivery(h.store);
    tracker.accept(id, source); tracker.waiting(id, "prior-run");
    setSystemTime(start + 60_000);
    const router = h.router(); await router.tick();
    for (const elapsed of [60_000, 120_000, 150_000, 180_000, 240_000, 300_000, 360_000]) {
      setSystemTime(start + 60_000 + elapsed); await router.tick();
    }
    expect(wakeStatus(h.store, id)?.state).toBe("failed");
    const next = "wake:admitted-log";
    h.store.acceptInbound(next, { id: next, text: "PRIVATE_NEXT", attachments: [], isAudioMessage: false, receivedAt: Date.now() });
    h.backend.outcome = "landed"; await router.tick();
    expect(wakeStatus(h.store, next)?.state).toBe("admitted");
  });
  const lifecycle = logs.filter(line => line.name.startsWith("wake."));
  expect(new Set(lifecycle.map(line => line.name))).toEqual(new Set([
    "wake.accepted", "wake.waiting", "wake.turn_start", "wake.send_ambiguous", "wake.retry_scheduled", "wake.failed", "wake.admitted",
  ]));
  const started = lifecycle.find(line => line.name === "wake.turn_start" && line.ids?.inboundId === id)!;
  expect(started.props).toMatchObject({ source, holderRunId: "prior-run", waitMs: 60_000, batchSize: 1 });
  expect(lifecycle.find(line => line.name === "wake.send_ambiguous")?.props).toMatchObject({ route: "/threads/:id/send" });
  expect(lifecycle.filter(line => line.ids?.inboundId === id).every(line => line.props?.source === source)).toBe(true);
  expect(JSON.stringify(lifecycle)).not.toMatch(/PRIVATE_EVENT|PRIVATE_NEXT/);
});

test.each(["absent", "unreadable"] as const)("a timed-out wake whose probe is %s reaches failure with notice and carry by 30 minutes", async outcome => {
  const h = setup(); h.backend.outcome = outcome;
  await captureLogs(async () => {
    let router = h.router();
    await router.tick();
    for (let elapsed = 30_000; elapsed <= 30 * 60_000; elapsed += 30_000) {
      setSystemTime(start + elapsed);
      if (elapsed === 60_000) router = h.router();
      await router.tick(); await router.checkInboundLatency();
    }
    expect(h.state()).toBe("failed");
    expect(h.store.get<{ id: string }[]>("missedSynthetic")?.map(row => row.id)).toContain(id);
    expect(h.store.pendingOutbox().filter(op => op.kind === "control")).toHaveLength(1);
    expect(h.store.get<{ attempts: number }>(`synthetic-retry:${id}`)?.attempts).toBeGreaterThan(0);
    expect(new Set(h.backend.prompts)).toEqual(new Set([promptId]));
    if (outcome === "unreadable") expect(h.backend.prompts).toEqual([promptId]);
  });
});
