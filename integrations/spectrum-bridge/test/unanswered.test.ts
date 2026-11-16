import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type InboundRecord, type OutboxOperation } from "../src/store.ts";
import { findOverdue, markAnswered, markReactionAnswered, reconcileLegacyReplies, turnMembers, UNANSWERED_REQUEUE_MS, type AnsweredInput } from "../src/unanswered.ts";
import { captureLogs } from "./log-fixture.ts";
import { legacySteerStart, restoreLegacySteer } from "./fixtures/legacy-steer-upgrade.ts";
import { summarizeLog } from "../src/log-rollup.ts";
import { createApi } from "../src/api.ts";
import { acknowledgePhoton } from "../src/inbound-failure.ts";
import { Delivery } from "../src/delivery.ts";

const at = Date.parse("2026-11-16T11:30:17Z");
const input = (id: string, receivedAt = at): AnsweredInput => ({ id, text: "PRIVATE", source: "typed", receivedAt, attachments: [], isAudioMessage: false });
const row = (id: string, receivedAt = at): InboundRecord => ({ id, payload: input(id, receivedAt), state: "done" });
const stores: Store[] = [];
const dirs: string[] = [];
function store() { const s = new Store(":memory:"); stores.push(s); s.set("unanswered-chat", "owner"); return s; }
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

test("overdue scope includes direct human audio and excludes groups, wakes, resets and stale restart history", () => {
  const rows = [row("human"), row("wake:x"), row("secret:x"), row("reset:x"), row("old", at - 30 * 60_000 - 1),
    { ...row("answered"), payload: { ...input("answered"), answeredAt: at + 1 } },
    { ...row("audio"), payload: { ...input("audio"), source: "composed", isAudioMessage: true } }];
  expect(findOverdue(rows, undefined, at + UNANSWERED_REQUEUE_MS - 1, { startedAt: at, chat: "owner" })).toEqual([]);
  expect(findOverdue(rows, undefined, at + UNANSWERED_REQUEUE_MS, { startedAt: at, chat: "owner" }).map(due => due.row.id)).toEqual(["human", "audio"]);
  for (const chat of ["group-family", "other"]) expect(findOverdue(rows, undefined, at + 600_000, { startedAt: at, chat })).toEqual([]);
  expect(findOverdue([row("boundary", at - 30 * 60_000)], undefined, at, { startedAt: at, chat: "moni" })).toHaveLength(1);
});

test("wake membership never suppresses requeue; human-led membership does", () => {
  for (const leaderKind of ["wake", "background", "human"] as const) {
    const due = findOverdue([row("human")], { members: ["human"], leaderKind }, at + 600_000, { startedAt: at, chat: "owner" })[0]!;
    expect(due.requeue).toBe(leaderKind !== "human"); expect(due.alert).toBe(true);
  }
});

for (const kind of ["text", "card", "file", "poll"] as const) test(`${kind} sent after turn closure answers every persisted member, without covering later arrivals`, () => {
  const s = store();
  for (const id of ["root", "batch", "steered", "question", "later", "wake:x"]) s.acceptInbound(id, input(id));
  s.set("batch:root", { ...input("root"), batchIds: ["root", "batch"] });
  const turn = { id: "ses_1", generation: 1, messageId: "msg_root", inboundId: "root", covered: ["steered", "question", "wake:x"], phase: "running" };
  s.set("activeTurn", turn);
  s.enqueue({ id: "reply", kind: "conversation", text: kind === "text" ? "Done" : "", sessionId: turn.id, generation: 1,
    ...(kind === "card" ? { app: { url: "https://example.com/", caption: "Card" } } : {}),
    ...(kind === "file" ? { attachment: { sha256: "a", name: "x.png", mimeType: "image/png", size: 1 } } : {}),
    ...(kind === "poll" ? { poll: { title: "Which?", options: ["A", "B"] } } : {}) });
  s.updateInbound("steered", "admitted");
  s.set("activeTurn", null); s.outboxState("reply", "sent");
  expect(s.db.query<{ state: string }, []>("SELECT state FROM inbound WHERE id = 'steered'").get()?.state).toBe("done");
  const payload = (id: string) => JSON.parse(s.db.query<{ payload: string }, [string]>("SELECT payload FROM inbound WHERE id = ?").get(id)!.payload) as AnsweredInput;
  for (const id of ["root", "batch", "steered", "question"]) expect(payload(id).answeredAt).toBeNumber();
  for (const id of ["later", "wake:x"]) expect(payload(id).answeredAt).toBeUndefined();
});

test("explicit reaction answers covered rows; arrival receipt does not", async () => {
  const s = store(); s.acceptInbound("root", input("root")); s.acceptInbound("followup", input("followup"));
  s.set("activeTurn", { id: "ses_1", generation: 1, messageId: "msg", inboundId: "root", covered: ["followup"], phase: "running" });
  await acknowledgePhoton(s, { react: async () => {} }, "iMessage;-;+15555550123", input("root"));
  expect(findOverdue([row("root")], undefined, at + 300_000, { startedAt: at, chat: "owner" })).toHaveLength(1);
  const api = createApi({ store: s, router: () => undefined, photon: { react: async () => {} }, chatGuid: () => "iMessage;-;+15555550123", enabled: () => true, health: () => ({}) });
  const res = await api(new Request("http://localhost/react", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target: "root", kind: "like" }) }));
  expect(res.status).toBe(200);
  for (const id of ["root", "followup"]) expect(JSON.parse(s.db.query<{ payload: string }, [string]>("SELECT payload FROM inbound WHERE id = ?").get(id)!.payload).answeredAt).toBeNumber();
});

test("answeredAt survives store reopen and stale payload updates, and late-answer logs feed rollup", async () => {
  const d = mkdtempSync(join(tmpdir(), "unanswered-")); dirs.push(d);
  let s = new Store(join(d, "test.sqlite"));
  s.set("unanswered-chat", "owner"); s.acceptInbound("late", { ...input("late"), unanswered: { overdueAt: at + 300_000 } });
  const logs = await captureLogs(async () => {
    markAnswered(s, ["late"], at + 360_000); markAnswered(s, ["late"], at + 420_000);
    s.updateInbound("late", "done", input("late"));
  });
  s.close(); s = new Store(join(d, "test.sqlite")); stores.push(s);
  const saved = JSON.parse(s.db.query<{ payload: string }, []>("SELECT payload FROM inbound").get()!.payload) as AnsweredInput;
  expect(saved.answeredAt).toBe(at + 360_000);
  const summary = await summarizeLog((async function* () { yield* logs; })());
  expect(summary.answered_late).toBe(1); expect(summary.first_reply_latency_ms).toMatchObject({ p50: 360_000, p95: 360_000 });
});

test("queued, failed and uncertain outbox operations do not count as answered", () => {
  const s = store(); s.acceptInbound("root", input("root"));
  s.enqueue({ id: "reply", kind: "conversation", text: "Done", replyTo: "root" });
  for (const state of ["pending", "sending", "uncertain", "failed"]) {
    s.outboxState("reply", state);
    const saved = JSON.parse(s.db.query<{ payload: string }, []>("SELECT payload FROM inbound").get()!.payload) as AnsweredInput;
    expect(saved.answeredAt).toBeUndefined();
  }
});

test("unanswered rollup counts unique alarms across Telegram retries and records independent requeues", async () => {
  const { toolLog } = await import("../src/toollog.ts");
  const logs = await captureLogs(async () => {
    toolLog.write({ component: "router", kind: "event", name: "inbound.overdue", ids: { inboundId: "row", chat: "owner" }, props: { action: "in_turn" } });
    toolLog.write({ component: "router", kind: "event", name: "inbound.watchdog_requeued", ids: { inboundId: "row", chat: "owner" } });
    for (const telegram of ["failed", "failed", "sent"]) toolLog.write({ component: "router", kind: "error", name: "inbound.unanswered_alert", ids: { inboundId: "row", chat: "owner" }, props: { telegram } });
  });
  const summary = await summarizeLog((async function* () { yield* logs; })());
  expect(summary).toMatchObject({ overdue: 1, requeued_by_watchdog: 1, unanswered_alerts: 1 });
});

function legacyReply(s: Store, op: OutboxOperation, state: string) {
  s.db.query("INSERT INTO outbox (id, payload, state) VALUES (?, ?, ?)").run(op.id, JSON.stringify(op), state);
}

test.each(["quote", "source", "quoted-member"])("upgrade reconciles sent replies with persisted %s attribution and their sealed batch", attribution => {
  const s = store();
  for (const id of ["root", "member", "unrelated"]) s.acceptInbound(id, input(id));
  s.set("batch:root", { ...input("root"), batchIds: ["root", "member"] });
  const op = { id: "legacy", kind: "conversation" as const, text: "Done", sessionId: "old-session", generation: 1,
    ...(attribution === "source" ? {} : { replyTo: attribution === "quote" ? "root" : "member" }) };
  legacyReply(s, op, "sent");
  if (attribution === "source") s.set("log-inbound-id:legacy", "root");
  s.set("sent-at:legacy", at + 60_000);
  // A later reply inserted first must not replace the first successful reply's time.
  legacyReply(s, { ...op, id: "earlier" }, "sent");
  if (attribution === "source") s.set("log-inbound-id:earlier", "root");
  s.set("sent-at:earlier", at + 30_000);
  reconcileLegacyReplies(s, at - 30 * 60_000, at + 360_000);
  const saved = (id: string) => JSON.parse(s.db.query<{ payload: string }, [string]>("SELECT payload FROM inbound WHERE id = ?").get(id)!.payload) as AnsweredInput;
  for (const id of ["root", "member"]) expect(saved(id).answeredAt).toBe(at + 30_000);
  expect(saved("unrelated").answeredAt).toBeUndefined();
});

test.each(["pending", "sending", "uncertain", "failed", "session-only", "explicit-empty", "before-inbound"])("upgrade does not infer a delivered reply from %s", kind => {
  const s = store(); s.acceptInbound("root", input("root"));
  legacyReply(s, { id: "legacy", kind: "conversation", text: "Done", sessionId: "ses_1", generation: 1,
    ...(kind === "session-only" ? {} : { replyTo: "root" }) }, ["pending", "sending", "uncertain", "failed"].includes(kind) ? kind : "sent");
  s.set("activeTurn", { id: "ses_1", generation: 1, messageId: "msg", inboundId: "root", phase: "running" });
  s.set("sent-at:legacy", kind === "before-inbound" ? at - 1 : at + 60_000);
  if (kind === "explicit-empty") s.set("reply-covered:legacy", []);
  reconcileLegacyReplies(s, at - 30 * 60_000, at + 360_000);
  expect(JSON.parse(s.db.query<{ payload: string }, []>("SELECT payload FROM inbound").get()!.payload).answeredAt).toBeUndefined();
});

test("upgrade accepts proven delivery without a timestamp without inventing a latency sample", async () => {
  const s = store(); s.acceptInbound("root", input("root"));
  legacyReply(s, { id: "legacy", kind: "conversation", text: "Done", replyTo: "root" }, "sent");
  const logs = await captureLogs(async () => { reconcileLegacyReplies(s, at - 30 * 60_000, at + 360_000); });
  expect(JSON.parse(s.db.query<{ payload: string }, []>("SELECT payload FROM inbound").get()!.payload).answeredAt).toBe(at + 360_000);
  expect(logs.filter(line => line.name === "inbound.answered")).toEqual([]);
});

test.each(["pending", "sending", "uncertain", "failed"])("pre-upgrade %s text recovered after store reopen marks its original human batch", async state => {
  const d = mkdtempSync(join(tmpdir(), "unanswered-upgrade-")); dirs.push(d);
  const path = join(d, "test.sqlite");
  let s = new Store(path);
  for (const id of ["root", "member"]) s.acceptInbound(id, input(id));
  s.set("batch:root", { ...input("root"), batchIds: ["root", "member"] });
  legacyReply(s, { id: "legacy", kind: "conversation", text: "Done", replyTo: "root" }, state);
  s.set("firstAttempt:legacy", Date.now());
  s.close(); s = new Store(path); stores.push(s); s.set("unanswered-chat", "owner");
  reconcileLegacyReplies(s, at - 30 * 60_000, Date.now());
  let sends = 0;
  const delivery = new Delivery(s, { sendText: async () => { sends++; return { providerId: "delivered" }; } }, {
    projectScope: "test", chatGuid: () => "iMessage;-;+15555550123", enabled: () => true, sleep: async () => {},
  });
  delivery.recover(); await delivery.tick();
  expect(sends).toBe(1); expect(s.getOperation("legacy")?.state).toBe("sent");
  expect(s.db.query<{ payload: string }, []>("SELECT payload FROM inbound").all().every(row => (JSON.parse(row.payload) as AnsweredInput).answeredAt !== undefined)).toBe(true);
});

test.each(["session", "generation", "startedAt", "outbox", "missing-fence", "before-admission", "early-reply", "missing-queued-at", "unaccepted", "uncertain", "explicit-empty"])(
  "legacy steer coverage requires proof from the same original turn: %s", kind => {
    const s = store(); restoreLegacySteer(s, "completed");
    const key = "failed-delivery:legacy-followup";
    const turn = s.get<import("../src/unanswered.ts").ReplyTurn>(key)!;
    const op = s.pendingOutbox()[0] ?? s.getOperation("reply:1:msg_assistant_2")!;
    if (kind === "session") turn.id = "different-session";
    if (kind === "generation") turn.generation++;
    if (kind === "startedAt") turn.startedAt!++;
    if (kind === "outbox") turn.outbox!++;
    if (kind === "missing-fence") delete turn.outbox;
    if (kind === "early-reply") turn.earlyOutbox = op.id;
    s.set(key, turn);
    if (kind === "before-admission") s.set(`log-queued:${op.id}`, legacySteerStart);
    if (kind === "missing-queued-at") s.db.query("DELETE FROM kv WHERE key = ?").run(`log-queued:${op.id}`);
    if (kind === "unaccepted") s.set("batch-phase:legacy-followup", "queued-steer");
    if (kind === "uncertain") s.db.query("DELETE FROM kv WHERE key = 'inbound-delivered:legacy-followup'").run();
    if (kind === "explicit-empty") s.set(`reply-covered:${op.id}`, []);
    reconcileLegacyReplies(s, legacySteerStart - 30 * 60_000, legacySteerStart + 420_000);
    const inputs = s.db.query<{ id: string; payload: string }, []>("SELECT id, payload FROM inbound").all();
    for (const row of inputs.filter(row => row.id !== "legacy-root")) expect((JSON.parse(row.payload) as AnsweredInput).answeredAt).toBeUndefined();
    expect((JSON.parse(inputs[0]!.payload) as AnsweredInput).answeredAt).toBe(kind === "explicit-empty" ? undefined : legacySteerStart + 2_000);
  },
);

test.each(["pending", "sending", "uncertain", "failed"])("legacy %s send recovered after restart answers the original turn's steered batch", async state => {
  const d = mkdtempSync(join(tmpdir(), "unanswered-steer-upgrade-")); dirs.push(d);
  const path = join(d, "test.sqlite"); let s = new Store(path);
  restoreLegacySteer(s, "completed");
  s.db.query("UPDATE outbox SET state = ?").run(state);
  s.set("firstAttempt:reply:1:msg_assistant_2", Date.now());
  s.close(); s = new Store(path); stores.push(s);
  reconcileLegacyReplies(s, legacySteerStart - 30 * 60_000, Date.now());
  let sends = 0;
  const delivery = new Delivery(s, { sendText: async () => { sends++; return { providerId: "delivered" }; } }, {
    projectScope: "test", chatGuid: () => "iMessage;-;+15555550123", enabled: () => true, sleep: async () => {},
  });
  delivery.recover(); await delivery.tick();
  expect(sends).toBe(1);
  expect(s.get<string[]>("reply-covered:reply:1:msg_assistant_2")?.sort()).toEqual(["legacy-followup", "legacy-member", "legacy-root"]);
  expect(s.db.query<{ payload: string }, []>("SELECT payload FROM inbound").all().every(row => (JSON.parse(row.payload) as AnsweredInput).answeredAt !== undefined)).toBe(true);
});

test.each(["accepted", "uncertain", "session", "generation", "startedAt", "outbox", "unlisted-prompt", "explicit-empty"])(
  "legacy running membership restores only listed steers of that turn: %s", kind => {
    const s = store(); restoreLegacySteer(s, "running");
    const turn = s.get<import("../src/unanswered.ts").ReplyTurn>("activeTurn")!;
    if (kind === "session") turn.id = "different-session";
    if (kind === "generation") turn.generation++;
    if (kind === "startedAt") turn.startedAt!++;
    if (kind === "outbox") turn.outbox!++;
    if (kind === "unlisted-prompt") turn.steered = ["unrelated-prompt"];
    if (kind === "explicit-empty") turn.covered = [];
    if (kind === "uncertain") {
      s.set("batch-phase:legacy-followup", "steering");
      s.db.query("DELETE FROM kv WHERE key = 'inbound-delivered:legacy-followup'").run();
    }
    expect(turnMembers(s, turn)).toEqual(["accepted", "uncertain"].includes(kind)
      ? ["legacy-root", "legacy-followup", "legacy-member"] : ["legacy-root"]);
  },
);

test.each(["source-only", "quote-member"])("legacy steer reply attribution also follows %s", kind => {
  const s = store(); restoreLegacySteer(s, "completed");
  const op = s.getOperation("reply:1:msg_assistant_2")!;
  if (kind === "source-only") delete op.replyTo;
  if (kind === "quote-member") {
    op.replyTo = "legacy-member";
    s.db.query("DELETE FROM kv WHERE key = ?").run(`log-inbound-id:${op.id}`);
  }
  s.db.query("UPDATE outbox SET payload = ? WHERE id = ?").run(JSON.stringify(op), op.id);
  reconcileLegacyReplies(s, legacySteerStart - 30 * 60_000, legacySteerStart + 420_000);
  expect(s.db.query<{ payload: string }, []>("SELECT payload FROM inbound").all().map(row => (JSON.parse(row.payload) as AnsweredInput).answeredAt))
    .toEqual([kind === "source-only" ? legacySteerStart + 2_000 : undefined, legacySteerStart + 2_000, legacySteerStart + 2_000]);
});

test.each(["processing", "partial", "no-watchdog"])("late coverage does not retire a retry outside a fully covered pending watchdog batch: %s", kind => {
  const s = store();
  for (const id of ["root", "member"]) s.acceptInbound(id, { ...input(id), ...(kind === "no-watchdog" ? {} : { unanswered: { requeuedAt: at + 300_000 } }) });
  s.set("batch:root", { ...input("root"), batchIds: ["root", "member"] });
  s.set("human-own-turn:root", true);
  s.updateInbound("root", kind === "processing" ? "processing" : "pending"); s.updateInbound("member", "batched");
  markAnswered(s, kind === "partial" ? ["member"] : ["root", "member"], at + 360_000);
  expect(s.db.query<{ state: string }, []>("SELECT state FROM inbound ORDER BY rowid").all().map(row => row.state))
    .toEqual([kind === "processing" ? "processing" : "pending", "batched"]);
});
