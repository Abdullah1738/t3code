import { afterEach, expect, spyOn, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRobobLinkAggregation, createRobobLinkState } from "../src/log-robob-link.ts";
import { createToolLog, toolLog, type LogLine } from "../src/toollog.ts";
import { Store } from "../src/store.ts";
import { deliveredReplyCoverage, findOverdue, reconcileLegacyReplies, type AnsweredInput } from "../src/unanswered.ts";
import { captureLogs } from "./log-fixture.ts";
import { Delivery } from "../src/delivery.ts";

const start = Date.parse("2026-11-17T12:00:00Z");
const roots: string[] = [];
const stores: Store[] = [];
afterEach(() => { stores.splice(0).forEach(s => s.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
const temp = () => { const root = mkdtempSync(join(tmpdir(), "outage-telemetry-")); roots.push(root); return root; };
const input = (id: string): AnsweredInput => ({ id, text: "PRIVATE_MESSAGE", source: "typed", receivedAt: start, attachments: [], isAudioMessage: false });
function store(chat: string, path = ":memory:") { const s = new Store(path); stores.push(s); s.set("unanswered-chat", chat === "group-trip" ? "other" : chat); s.set("log-chat", chat); return s; }
const saved = (s: Store, id: string): AnsweredInput => JSON.parse(s.db.query<{ payload: string }, [string]>("SELECT payload FROM inbound WHERE id=?").get(id)!.payload);

test.each(["owner", "moni", "group-trip"])("outage telemetry: %s control ack preserves unanswered human batch and later conversation answers it", async chat => {
  const s = store(chat);
  for (const id of ["root", "member", "steered", "wake:x"]) s.acceptInbound(id, input(id));
  s.set("batch:root", { ...input("root"), batchIds: ["root", "member"] });
  s.set("activeTurn", { id: "ses_1", generation: 1, messageId: "prompt", inboundId: "root", covered: ["steered", "wake:x"], phase: "running" });
  s.enqueue({ id: "outage:notice", kind: "control", text: "Technical problem", replyTo: "root", sessionId: "ses_1", generation: 1 });
  expect(s.get<string[]>("reply-covered:outage:notice")).toEqual([]);
  expect(s.get<string[]>("reply-acked:outage:notice")?.sort()).toEqual(["member", "root", "steered"]);
  s.set("activeTurn", null);
  const rows = await captureLogs(async () => { s.outboxState("outage:notice", "sent"); s.outboxState("outage:notice", "sent"); });
  expect(rows.filter(row => row.name === "inbound.acked").map(row => [row.ids?.chat, row.ids?.inboundId, row.ids?.operationId, row.props?.kind]).sort())
    .toEqual(["member", "root", "steered"].map(id => [chat, id, "outage:notice", "outage"]));
  for (const id of ["root", "member", "steered"]) {
    expect(saved(s, id).answeredAt).toBeUndefined();
    const overdue = findOverdue([{ id, payload: saved(s, id), state: "done" }], undefined, start + 600_000, { startedAt: start, chat });
    if (chat === "group-trip") expect(overdue).toEqual([]);
    else expect(overdue[0]?.alert).toBe(true);
  }
  s.enqueue({ id: "reply", kind: "conversation", text: "Actual answer", replyTo: "root" }); s.outboxState("reply", "sent");
  for (const id of ["root", "member"]) expect(saved(s, id).answeredAt).toBeNumber();
});

test.each(["missing-snapshot", "old-covered-snapshot"])("outage telemetry: legacy control %s cannot regain answer coverage", kind => {
  const s = store("owner"); s.acceptInbound("root", input("root"));
  const op = { id: "outage:legacy", kind: "control" as const, text: "Technical problem", replyTo: "root" };
  s.db.query("INSERT INTO outbox(id,payload,state) VALUES(?,?,'pending')").run(op.id, JSON.stringify(op));
  if (kind === "old-covered-snapshot") s.set(`reply-covered:${op.id}`, ["root"]);
  s.outboxState(op.id, "sent");
  expect(deliveredReplyCoverage(s, op)).toEqual([]);
  reconcileLegacyReplies(s, start - 1_000, start + 600_000);
  expect(saved(s, "root").answeredAt).toBeUndefined();
  expect(s.get<string[]>(`reply-acked:${op.id}`)).toEqual(["root"]);
});

function fixture(root = temp(), initial = start) {
  let at = initial;
  const state = createRobobLinkState({ root, now: () => at });
  const rows: LogLine[] = [];
  const emit = (name: string, rest: Partial<LogLine> = {}) => {
    const line: LogLine = { ts: new Date(at).toISOString(), tool: "imessage", component: "robob", kind: "event", name, ...rest };
    const result = state.accept(line); rows.push(...result.events, line); return result.events;
  };
  const call = (ok: boolean, runId = "11111111-1111-4111-8111-111111111111") => emit("turn.robob_call", { ok, ids: { runId }, props: { route: "/threads/:id/messages", ...(ok ? {} : { linkCause: "ECONNREFUSED" }) } });
  const receive = (id: string) => emit("msg.received", { ids: { chat: "group-trip", messageId: id }, props: { backend: "robob", text: "PRIVATE_MESSAGE" } });
  const reply = (id: string, kind = "conversation") => emit("reply.sent", { ok: true, ids: { chat: "group-trip", inboundId: id }, props: { kind } });
  return { root, rows, call, receive, reply, emit, advance: (ms: number) => { at += ms; }, stop: () => emit("bridge.stop") };
}

test.each([false, true])("outage telemetry: restarted bridge first call success=%s keeps outage identity, ack counts and both replies", succeeds => {
  const a = fixture(); for (let n = 0; n < 3; n++) a.call(false);
  a.receive("one"); a.receive("two");
  a.emit("inbound.acked", { ids: { chat: "group-trip", inboundId: "one" } }); a.reply("one", "control");
  a.stop();
  const outageId = a.rows.find(row => row.name === "robob.link_down")!.link!.outageId;
  const b = fixture(a.root, start + 5_000);
  const events = b.call(succeeds, "22222222-2222-4222-8222-222222222222");
  expect(events).toHaveLength(1);
  expect(events[0]?.name).toBe(succeeds ? "robob.link_up" : "robob.link_state");
  expect(events[0]?.link).toMatchObject({ outageId, failedCalls: succeeds ? 3 : 4, inboundReceivedDuringOutage: 2, inboundAckedDuringOutage: 1, inboundAnsweredDuringOutage: 0 });
  if (!succeeds) {
    expect(events[0]?.props?.resumedByRun).toBe("22222222-2222-4222-8222-222222222222");
    b.advance(1_000); b.call(true);
  }
  b.reply("two", "control"); b.reply("one"); b.reply("two"); b.reply("two"); b.stop();
  expect(b.rows.filter(row => row.name === "robob.link_reply")).toHaveLength(2);
  expect(b.rows.filter(row => row.name === "robob.link_reply").at(-1)?.link).toMatchObject({ outageId, inboundAnsweredAfter: 2, inboundAnsweredDuringOutage: 0 });
  const aggregate = createRobobLinkAggregation(); for (const row of [...a.rows, ...b.rows]) aggregate.accept(row);
  expect(aggregate.summary().outages).toHaveLength(1);
  expect(aggregate.summary().outages[0]).toMatchObject({ outageId, downMs: succeeds ? 5_000 : 6_000, inboundAckedDuringOutage: 1, inboundAnsweredAfter: 2 });
  expect(aggregate.summary().messagesWaiting).toBe(0);
});

test("outage telemetry: recovered waiting identities survive another restart and stop removes completed entries", () => {
  const a = fixture(); for (let n = 0; n < 3; n++) a.call(false);
  a.receive("one"); a.receive("two"); a.call(true); a.reply("one"); a.stop();
  const b = fixture(a.root, start + 5_000); b.reply("two"); b.stop();
  expect(b.rows.find(row => row.name === "robob.link_reply")?.link?.inboundAnsweredAfter).toBe(2);
  expect(JSON.parse(readFileSync(join(a.root, "robob-link-state.json"), "utf8"))).toMatchObject({ active: null, recovered: [] });
});

test("outage telemetry: state writes are atomic, private, throttled and flushed at stop without message text", () => {
  const f = fixture(); f.call(false);
  const path = join(f.root, "robob-link-state.json"); const first = statSync(path);
  f.receive("one"); f.call(false); f.call(false);
  expect(statSync(path).ino).toBe(first.ino);
  f.advance(1_000); f.call(false);
  expect(statSync(path).ino).not.toBe(first.ino);
  f.receive("two"); f.stop();
  const text = readFileSync(path, "utf8");
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(text).not.toContain("PRIVATE_MESSAGE");
  expect(JSON.parse(text).active).toMatchObject({ link: { failedCalls: 4, inboundReceivedDuringOutage: 2 }, waiting: ["group-trip\u0000one", "group-trip\u0000two"] });
  expect(readdirSync(f.root)).toEqual(["robob-link-state.json"]);
});

test("outage telemetry: expired persisted active and recovered outages are dropped", () => {
  const a = fixture(); for (let n = 0; n < 3; n++) a.call(false); a.receive("one"); a.call(true);
  for (let n = 0; n < 3; n++) a.call(false); a.receive("two"); a.stop();
  const b = fixture(a.root, start + 31 * 86400_000); expect(b.call(true)).toEqual([]); b.reply("one"); b.stop();
  expect(b.rows.filter(row => row.name.startsWith("robob.link_"))).toEqual([]);
  expect(JSON.parse(readFileSync(join(a.root, "robob-link-state.json"), "utf8"))).toMatchObject({ active: null, recovered: [] });
});

test("outage telemetry: capped logger retains lifecycle milestones and control kind, excluding repeated batching", async () => {
  const root = temp(); const log = createToolLog({ root, capBytes: 1, now: () => start });
  const names = ["msg.received", "reply.sent", "inbound.answered", "inbound.acked", "inbound.delivered", "recovery.notice_sent"];
  log.write({ component: "process", kind: "event", name: "bridge.start" });
  for (const name of [...names, "msg.batched"]) log.write({ component: "router", kind: "event", name, ok: true, props: { kind: "control" } });
  log.write({ component: "process", kind: "event", name: "bridge.stop" }); await log.settled();
  const rows: LogLine[] = readFileSync(join(root, "2026-11-17.ndjson"), "utf8").trim().split("\n").map(row => JSON.parse(row));
  for (const name of names) expect(rows.find(row => row.name === name)?.props?.kind).toBe("control");
  expect(rows.some(row => row.name === "msg.batched")).toBe(false);
});

test("outage telemetry: delivery logs control kind and preserves group ack attribution", async () => {
  const s = store("group-trip"); s.acceptInbound("root", input("root"));
  s.enqueue({ id: "outage:notice", kind: "control", text: "Technical problem", replyTo: "root" });
  const delivery = new Delivery(s, { sendText: async () => ({ providerId: "delivered" }) }, {
    projectScope: "test", chatGuid: () => "iMessage;-;+15555550123", enabled: () => true, sleep: async () => {},
  });
  const rows = await captureLogs(async () => { await delivery.tick(); });
  expect(rows.find(row => row.name === "reply.sent")?.props?.kind).toBe("control");
  expect(rows.find(row => row.name === "inbound.acked")?.ids?.chat).toBe("group-trip");
  expect(saved(s, "root").answeredAt).toBeUndefined();
});

const groupBatchReplies = [false, true].flatMap(defer => ["down", "recovered", "restarted"].map(phase => ({ defer, phase })));
test.each(groupBatchReplies)("outage telemetry: group-batch reply while $phase with defer=$defer answers every covered row across restart", async ({ defer, phase }) => {
  const root = temp(); let at = start;
  let log = createToolLog({ root, defer, capBytes: 1, now: () => at });
  const writer = spyOn(toolLog, "write").mockImplementation(entry => log.write(entry));
  const path = join(root, "group.sqlite");
  let s = store("group-trip", path);
  let sends = 0;
  const makeDelivery = () => new Delivery(s, { sendText: async () => ({ providerId: `delivery-${++sends}` }) }, {
    projectScope: "test", chat: "group-trip", chatGuid: () => "iMessage;+;group-trip", enabled: () => true, sleep: async () => {},
  });
  let delivery = makeDelivery();
  const call = (ok: boolean) => log.write({ component: "robob", kind: "perf", name: "turn.robob_call", ok, durationMs: 10,
    props: { route: "/threads/:id/messages", method: "GET", ...(ok ? {} : { linkCause: "ECONNREFUSED" }) } });
  const stop = async () => { log.write({ component: "process", kind: "event", name: "bridge.stop" }); await log.settled(); };
  const restart = async () => {
    await stop(); at += 1_000;
    stores.splice(stores.indexOf(s), 1); s.close();
    s = store("group-trip", path); delivery = makeDelivery();
    log = createToolLog({ root, defer, capBytes: 1, now: () => at }); call(true);
  };
  try {
    for (let n = 0; n < 3; n++) call(false);
    for (const id of ["root", "member"]) {
      s.acceptInbound(id, input(id));
      log.write({ component: "ingress", kind: "event", name: "msg.received", ids: { chat: "group-trip", messageId: id }, props: { backend: "robob" } });
    }
    s.set("batch:root", { ...input("root"), batchIds: ["root", "member"] });
    s.enqueue({ id: "outage:batch-notice", kind: "control", text: "Technical problem", replyTo: "root" });
    await delivery.tick(); await log.settled();
    for (const id of ["root", "member"]) expect(saved(s, id).answeredAt).toBeUndefined();
    expect((await log.rollup("2026-11-17"))?.robob_link).toMatchObject({ messagesWaiting: 2,
      outages: [expect.objectContaining({ inboundAckedDuringOutage: 2, inboundAnsweredDuringOutage: 0, inboundAnsweredAfter: 0 })] });
    at += 100;
    if (phase !== "down") call(true);
    if (phase === "restarted") await restart();
    s.enqueue({ id: "batch-reply", kind: "conversation", text: "Actual answer", replyTo: "root" });
    await delivery.tick(); await log.settled();
    expect(sends).toBe(2);
    for (const id of ["root", "member"]) expect(saved(s, id).answeredAt).toBeNumber();
    if (phase === "down") { at += 100; call(true); }
    await stop();
    const expected = { inboundReceivedDuringOutage: 2, inboundAckedDuringOutage: 2,
      inboundAnsweredDuringOutage: phase === "down" ? 2 : 0, inboundAnsweredAfter: phase === "down" ? 0 : 2, open: false };
    expect((await log.rollup("2026-11-17"))?.robob_link).toMatchObject({ messagesWaiting: 0, outages: [expect.objectContaining(expected)] });
    expect(JSON.parse(readFileSync(join(root, "robob-link-state.json"), "utf8"))).toMatchObject({ active: null, recovered: [] });
    const rows: LogLine[] = readFileSync(join(root, "2026-11-17.ndjson"), "utf8").trim().split("\n").map(row => JSON.parse(row));
    expect(rows.filter(row => row.name === "inbound.answered").map(row => row.ids?.inboundId).sort()).toEqual(["member", "root"]);
    expect(rows.filter(row => row.name === "inbound.answered").every(row => row.ids?.chat === "group-trip")).toBe(true);
    await restart(); await stop();
    for (const id of ["root", "member"]) expect(saved(s, id).answeredAt).toBeNumber();
    expect((await log.rollup("2026-11-17"))?.robob_link).toMatchObject({ messagesWaiting: 0, outages: [expect.objectContaining(expected)] });
    expect(JSON.parse(readFileSync(join(root, "robob-link-state.json"), "utf8"))).toMatchObject({ active: null, recovered: [] });
  } finally { try { await stop(); } finally { writer.mockRestore(); } }
});

test.each(["outage", "control", "synthetic-dropped", "turn", "nudge", "request"])("outage telemetry: %s notices ack a live turn without answering it", prefix => {
  const s = store("owner"); s.acceptInbound("root", input("root"));
  s.set("activeTurn", { id: "ses_1", generation: 1, messageId: "prompt", inboundId: "root", phase: "running" });
  const id = `${prefix}:notice`;
  s.enqueue({ id, kind: "control", text: "Technical notice", sessionId: "ses_1", generation: 1 });
  s.outboxState(id, "sent");
  expect(saved(s, "root").answeredAt).toBeUndefined();
  expect(s.get<string[]>(`reply-acked:${id}`)).toEqual(["root"]);
  expect(s.get<string[]>(`reply-covered:${id}`)).toEqual([]);
});

test("outage telemetry: logger rehydrates capped outage snapshots and later lifecycle replies close the same outage", async () => {
  const root = temp(); let at = start;
  const a = createToolLog({ root, capBytes: 1, now: () => at });
  const call = (log: typeof a, ok: boolean) => log.write({ component: "robob", kind: "perf", name: "turn.robob_call", ok,
    props: { route: "/threads/:id/messages", ...(ok ? {} : { linkCause: "ECONNRESET" }) } });
  for (let n = 0; n < 3; n++) call(a, false);
  a.write({ component: "ingress", kind: "event", name: "msg.received", ids: { chat: "group-trip", messageId: "root" }, props: { backend: "robob" } });
  a.write({ component: "router", kind: "event", name: "inbound.acked", ids: { chat: "group-trip", inboundId: "root" }, props: { kind: "outage" } });
  a.write({ component: "delivery", kind: "perf", name: "reply.sent", ok: true, ids: { chat: "group-trip", inboundId: "root" }, props: { kind: "control" } });
  a.write({ component: "process", kind: "event", name: "bridge.stop" }); await a.settled();
  const before = await a.rollup("2026-11-17");
  expect(before?.robob_link.outages[0]).toMatchObject({ inboundAckedDuringOutage: 1, inboundAnsweredDuringOutage: 0 });
  expect(before?.robob_link.messagesWaiting).toBe(1);
  at += 10_000;
  const b = createToolLog({ root, capBytes: 1, now: () => at }); call(b, false); at += 1_000; call(b, true);
  b.write({ component: "delivery", kind: "perf", name: "reply.sent", ok: true, ids: { chat: "group-trip", inboundId: "root" }, props: { kind: "conversation" } });
  b.write({ component: "process", kind: "event", name: "bridge.stop" }); await b.settled();
  const result = await b.rollup("2026-11-17");
  expect(result?.robob_link.outages).toHaveLength(1);
  expect(result?.robob_link.outages[0]).toMatchObject({ outageId: before!.robob_link.outages[0]!.outageId,
    downMs: 11_000, inboundAckedDuringOutage: 1, inboundAnsweredDuringOutage: 0, inboundAnsweredAfter: 1, open: false });
  expect(result?.robob_link.messagesWaiting).toBe(0);
  const rows: LogLine[] = readFileSync(join(root, "2026-11-17.ndjson"), "utf8").trim().split("\n").map(row => JSON.parse(row));
  expect(rows.find(row => row.name === "robob.link_state" && row.props?.resumedByRun)?.props?.resumedByRun).toBeString();
});

const crashStates = [false, true].flatMap(defer => ["still-down", "recovered", "replied"].map(phase => ({ defer, phase })));
test.each(crashStates)("outage telemetry: abrupt $phase crash with defer=$defer replays newer durable milestones", async ({ defer, phase }) => {
  const root = temp(); let at = start;
  const a = createToolLog({ root, defer, now: () => at });
  const call = (log: typeof a, ok: boolean) => log.write({ component: "robob", kind: "perf", name: "turn.robob_call", ok, durationMs: 10,
    props: { route: "/threads/:id/messages", method: "GET", ...(ok ? {} : { linkCause: "ECONNREFUSED" }) } });
  call(a, false); await a.settled();
  at += 10;
  a.write({ component: "ingress", kind: "event", name: "msg.received", ids: { chat: "group-trip", messageId: "root" }, props: { backend: "robob" } });
  for (let n = 0; n < 4; n++) call(a, false);
  a.write({ component: "router", kind: "event", name: "inbound.acked", ids: { chat: "group-trip", inboundId: "root" }, props: { kind: "outage" } });
  if (phase !== "still-down") { at = start + 200; call(a, true); }
  const reply = (log: typeof a) => log.write({ component: "delivery", kind: "perf", name: "reply.sent", ok: true,
    ids: { chat: "group-trip", inboundId: "root" }, props: { kind: "conversation" } });
  if (phase === "replied") { at += 50; reply(a); }
  await a.settled();
  const stale = JSON.parse(readFileSync(join(root, "robob-link-state.json"), "utf8"));
  expect(stale.active.link.failedCalls).toBe(1);
  const outageId = stale.active.link.outageId;
  // A separate root models a new process without allowing the old instance's timer to repair the snapshot.
  const restarted = temp();
  for (const file of ["robob-link-state.json", "2026-11-17.ndjson"]) copyFileSync(join(root, file), join(restarted, file));
  at = start + 5_000;
  const b = createToolLog({ root: restarted, defer, now: () => at });
  call(b, false); await b.settled();
  if (phase === "still-down") call(b, true);
  reply(b);
  b.write({ component: "process", kind: "event", name: "bridge.stop" }); await b.settled();
  const result = await b.rollup("2026-11-17");
  const outage = result?.robob_link.outages.find(row => row.outageId === outageId);
  expect(outage).toMatchObject({ failedCalls: phase === "still-down" ? 6 : 5, downMs: phase === "still-down" ? 5_000 : 200,
    inboundReceivedDuringOutage: 1, inboundAckedDuringOutage: 1, inboundAnsweredDuringOutage: 0, inboundAnsweredAfter: 1, open: false });
  const rows: LogLine[] = readFileSync(join(restarted, "2026-11-17.ndjson"), "utf8").trim().split("\n").map(row => JSON.parse(row));
  expect(rows.filter(row => row.name === "robob.link_up" && row.link?.outageId === outageId)).toHaveLength(1);
  if (phase !== "still-down") expect(rows.some(row => row.name === "robob.link_state" && row.props?.resumedByRun && row.link?.outageId === outageId)).toBe(false);
  a.write({ component: "process", kind: "event", name: "bridge.stop" }); await a.settled();
});

const resetBoundaries = [false, true].flatMap(defer => ["fast-success", "slow-success", "non-link-failure"].map(boundary => ({ defer, boundary })));
test.each(resetBoundaries)("outage telemetry: abrupt distinct sequences after $boundary with defer=$defer keep only the current outage", async ({ defer, boundary }) => {
  const root = temp(); let at = start;
  const a = createToolLog({ root, defer, now: () => at });
  const call = (log: typeof a, ok: boolean, linkFailure = !ok, durationMs = 10) => log.write({ component: "robob", kind: "perf", name: "turn.robob_call", ok, durationMs,
    props: { route: "/threads/:id/messages", method: "GET", ...(linkFailure ? { linkCause: "ECONNREFUSED" } : {}) } });
  const receive = (id: string) => a.write({ component: "ingress", kind: "event", name: "msg.received", ids: { chat: "group-trip", messageId: id }, props: { backend: "robob" } });
  call(a, false); await a.settled();
  const stale = JSON.parse(readFileSync(join(root, "robob-link-state.json"), "utf8"));
  at += 10; receive("old");
  call(a, boundary !== "non-link-failure", false, boundary === "slow-success" ? 6_000 : 10);
  at = start + 100; call(a, false); call(a, false); receive("current"); await a.settled();
  const source: LogLine[] = readFileSync(join(root, "2026-11-17.ndjson"), "utf8").trim().split("\n").map(row => JSON.parse(row));
  const currentId = source.filter(row => row.name === "turn.robob_call" && row.ok === false && row.props?.linkCause).at(-1)!.ids!.outageId!;
  expect(currentId).not.toBe(stale.active.link.outageId);
  expect(JSON.parse(readFileSync(join(root, "robob-link-state.json"), "utf8")).active.link.outageId).toBe(stale.active.link.outageId);
  const restarted = temp();
  for (const file of ["robob-link-state.json", "2026-11-17.ndjson"]) copyFileSync(join(root, file), join(restarted, file));
  at = start + 500;
  const b = createToolLog({ root: restarted, defer, now: () => at }); call(b, false); await b.settled();
  const resumed = JSON.parse(readFileSync(join(restarted, "robob-link-state.json"), "utf8"));
  expect(resumed.active.link).toMatchObject({ outageId: currentId, firstFailureAt: new Date(start + 100).toISOString(), failedCalls: 3, inboundReceivedDuringOutage: 1 });
  expect(resumed.active.waiting).toEqual(["group-trip\u0000current"]);
  call(b, true);
  b.write({ component: "delivery", kind: "perf", name: "reply.sent", ok: true, ids: { chat: "group-trip", inboundId: "current" }, props: { kind: "conversation" } });
  b.write({ component: "process", kind: "event", name: "bridge.stop" }); await b.settled();
  const result = await b.rollup("2026-11-17");
  expect(result?.robob_link.outages).toHaveLength(1);
  expect(result?.robob_link.outages[0]).toMatchObject({ outageId: currentId, failedCalls: 3, downMs: 400, inboundReceivedDuringOutage: 1, inboundAnsweredAfter: 1, open: false });
  a.write({ component: "process", kind: "event", name: "bridge.stop" }); await a.settled();
});

const terminalBoundaries = resetBoundaries.flatMap(row => [false, true].map(capped => ({ ...row, capped })));
test.each(terminalBoundaries)("outage telemetry: abrupt terminal $boundary with defer=$defer capped=$capped cannot revive a cleared sequence", async ({ defer, boundary, capped }) => {
  const root = temp(); let at = start;
  const a = createToolLog({ root, defer, capBytes: capped ? 1 : undefined, now: () => at });
  const call = (log: typeof a, ok: boolean, linkFailure = !ok, durationMs = 10) => log.write({ component: "robob", kind: "perf", name: "turn.robob_call", ok, durationMs,
    props: { route: "/threads/:id/messages", method: "GET", ...(linkFailure ? { linkCause: "ECONNREFUSED" } : {}) } });
  call(a, false); await a.settled();
  const stale = JSON.parse(readFileSync(join(root, "robob-link-state.json"), "utf8"));
  at += 10;
  a.write({ component: "ingress", kind: "event", name: "msg.received", ids: { chat: "group-trip", messageId: "old" }, props: { backend: "robob" } });
  call(a, boundary !== "non-link-failure", false, boundary === "slow-success" ? 6_000 : 10); await a.settled();
  expect(JSON.parse(readFileSync(join(root, "robob-link-state.json"), "utf8")).active.link.outageId).toBe(stale.active.link.outageId);
  const source: LogLine[] = readFileSync(join(root, "2026-11-17.ndjson"), "utf8").trim().split("\n").map(row => JSON.parse(row));
  expect(source.filter(row => row.name === "robob.link_reset").map(row => row.ids?.outageId)).toEqual([stale.active.link.outageId]);
  const restarted = temp();
  for (const file of ["robob-link-state.json", "2026-11-17.ndjson"]) copyFileSync(join(root, file), join(restarted, file));
  at = start + 5_000;
  const b = createToolLog({ root: restarted, defer, capBytes: capped ? 1 : undefined, now: () => at }); call(b, false); await b.settled();
  const resumed = JSON.parse(readFileSync(join(restarted, "robob-link-state.json"), "utf8"));
  expect(resumed.active.link.outageId).not.toBe(stale.active.link.outageId);
  expect(resumed.active.link).toMatchObject({ firstFailureAt: new Date(at).toISOString(), failedCalls: 1, inboundReceivedDuringOutage: 0 });
  expect(resumed.active.waiting).toEqual([]);
  call(b, true); b.write({ component: "process", kind: "event", name: "bridge.stop" }); await b.settled();
  const result = await b.rollup("2026-11-17");
  expect(result?.robob_link.outages).toEqual([]);
  expect(result?.robob_link.messagesWaiting).toBe(0);
  a.write({ component: "process", kind: "event", name: "bridge.stop" }); await a.settled();
});
