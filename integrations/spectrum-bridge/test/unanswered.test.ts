import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type InboundRecord } from "../src/store.ts";
import { findOverdue, markAnswered, markReactionAnswered, UNANSWERED_REQUEUE_MS, type AnsweredInput } from "../src/unanswered.ts";
import { captureLogs } from "./log-fixture.ts";
import { summarizeLog } from "../src/log-rollup.ts";
import { createApi } from "../src/api.ts";
import { acknowledgePhoton } from "../src/inbound-failure.ts";

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
