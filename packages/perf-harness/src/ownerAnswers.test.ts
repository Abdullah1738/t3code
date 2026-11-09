// @effect-diagnostics nodeBuiltinImport:off - All databases are disposable in-memory synthetic records.
import * as NodeTest from "node:test";
const { test } = NodeTest;
import * as NodeAssert from "node:assert/strict";
const assert: typeof NodeAssert = NodeAssert;
import * as NodeSqlite from "node:sqlite";
import { kanbanDDL } from "../../../apps/server/src/ardud/persistence/kanbanSchema.ts";
import { repairOwnerAnswerHistory, seedOwnerAnswers } from "./ownerAnswerFixture.ts";
import * as Schema from "effect/Schema";
import { OrchestrationV2ExecutionNodeJson } from "@t3tools/contracts";
import { ownerAnswerCases, ownerAnswerRequest, assertOpenOwnerAsk, assertClosedOwnerAsk, mockAnswerDelivery } from "./ownerAnswers.ts";
import type { KanbanCard, KanbanMessage } from "@t3tools/contracts";
const decodeHistoryNode = Schema.decodeUnknownSync(Schema.fromJsonString(OrchestrationV2ExecutionNodeJson));

function seeded() {
  const db = new NodeSqlite.DatabaseSync(":memory:");
  for (const ddl of kanbanDDL) db.exec(ddl);
  const at = "2026-01-01T00:00:00.000Z";
  const model = { instanceId: "synthetic", model: "synthetic" };
  const template = { id: "template", boardId: "synthetic-board-0", number: 1,
    title: "Synthetic", description: "", prompt: "Synthetic", stage: "todo", priority: 2,
    goalId: null, projects: [], model, projectId: null, links: [], blockedBy: [], stalled: null,
    question: null, reviewChain: null, reviewStep: 0, reviewRound: 0, activeThreadId: null,
    activeRole: null, activePool: null, workThreadId: null, reviewThreadId: null,
    discussionId: "template-discussion", wakeNote: null, nudgedAt: null, settledAt: null,
    createdBy: { _tag: "owner" }, createdAt: at, updatedAt: at, movedAt: at };
  db.prepare("INSERT INTO ardud_kanban_boards VALUES (?,?,?)").run(template.boardId, template.boardId,
    JSON.stringify({ id: template.boardId }));
  db.prepare("INSERT INTO ardud_kanban_cards VALUES (?,?,?,?,?,?)").run(template.id, template.boardId, 1, "todo", null, JSON.stringify(template));
  db.prepare("INSERT INTO ardud_kanban_discussions VALUES (?,?,?,?,?)").run("template-discussion", template.boardId, template.id, null,
    JSON.stringify({ id: "template-discussion", boardId: template.boardId, cardId: template.id,
      title: "Synthetic", evaluatorThreadId: null, participants: [], lastSeq: 20, lastMessageAt: at,
      createdBy: { _tag: "owner" }, createdAt: at, archivedAt: null }));
  seedOwnerAnswers(db);
  return db;
}

test("forty real persisted asks cover all routes and map choices to the correct message", () => {
  const db = seeded();
  try {
    const samples = ownerAnswerCases();
    assert.equal(samples.length, 40);
    assert.equal(samples.filter((sample) => sample.kind === "text").length, 20);
    assert.equal(samples.filter((sample) => sample.kind === "pick").length, 20);
    assert.equal(new Set(samples.map((s) => s.cardId)).size, 40);
    for (const route of ["worker", "evaluator", "fallback", "launch"])
      assert.equal(samples.filter((s) => s.route === route).length, 10);
    for (const sample of samples) {
      const card = JSON.parse(String(db.prepare("SELECT json FROM ardud_kanban_cards WHERE id=?").get(sample.cardId)!.json)) as KanbanCard;
      const message = JSON.parse(String(db.prepare("SELECT json FROM ardud_kanban_messages WHERE discussion_id=? AND seq=?").get(sample.discussionId, sample.seq)!.json)) as KanbanMessage;
      assertOpenOwnerAsk(sample, card, message);
      const input = ownerAnswerRequest(sample);
      assert.equal(input.path, `/api/ardud/kanban/discussions/${sample.discussionId}/answer`);
      assert.equal(input.body.seq, sample.seq);
      assert.equal(input.body.blockId, sample.askId);
      assert.deepEqual(input.body.choice, sample.kind === "text" ? [] : ["o2"]);
      assert.equal(input.body.text, sample.kind === "text" ? `${sample.marker} Continue with the scoped change.` : null);
      assert.equal(card.asks.length, sample.kind === "pick" ? 2 : 1);
      if (sample.kind === "pick") {
        assert.equal(card.asks[0]!.seq, 21);
        assert.equal(card.asks[1]!.seq, 22);
        const input = ownerAnswerRequest(sample).body;
        assert.ok("seq" in input);
        assert.equal(input.seq, 22);
        assert.throws(() => assertOpenOwnerAsk(sample, card, { ...message, seq: 21 }));
      }
      const closed = { ...card, asks: card.asks.map((ask) => ask.id === sample.askId ? { ...ask, closedAt: "2026-02-01T00:00:00.000Z" } : ask) };
      const answered = { ...message, answers: [{ blockId: sample.askId, by: { _tag: "owner" as const },
        choice: input.body.choice, text: input.body.text, at: "2026-02-01T00:00:00.000Z" }] };
      assertClosedOwnerAsk(sample, closed, answered);
      assert.throws(() => assertOpenOwnerAsk(sample, closed, answered), /fresh open ask/);
      assert.throws(() => assertClosedOwnerAsk(sample, card, answered), /did not close/);
      assert.throws(() => assertClosedOwnerAsk(sample, closed, { ...answered, answers: [] }), /wrong ask/);
      assert.throws(() => assertClosedOwnerAsk(sample, closed, { ...answered, answers: [{ ...answered.answers[0]!, text: "wrong text" }] }), /wrong ask/);
      if (sample.kind === "pick") {
        assert.throws(() => assertClosedOwnerAsk(sample, { ...closed, asks: closed.asks.map((ask) => ({ ...ask, closedAt: "2026-02-01T00:00:00.000Z" })) }, answered), /wrong ask/);
      }
    }
  } finally { db.close(); }
});

test("mock delivery requires prompts containing every unique answer marker", () => {
  assert.equal(mockAnswerDelivery("").observed, 0);
  const samples = ownerAnswerCases();
  const line = (method: string, text: string) => JSON.stringify({ method, params: { prompt: [{ type: "text", text }] } }) + "\n";
  const other = line("initialize", samples.map((s) => s.marker).join(" "));
  assert.equal(mockAnswerDelivery(other).observed, 0);
  const all = samples.map((sample) => line("session/prompt", sample.marker)).join("");
  assert.deepEqual(mockAnswerDelivery(all), { observed: 40, missing: [] });
  assert.equal(mockAnswerDelivery(line("session/prompt", samples[0]!.marker).repeat(40)).observed, 1);
  assert.equal(mockAnswerDelivery(all + '{"method":"session/prompt"').observed, 40);
});

test("answer recipients retain decodable history rows and the bulk synthetic body", () => {
  const db = new NodeSqlite.DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE orchestration_v2_projection_nodes (node_id TEXT,thread_id TEXT,kind TEXT,payload_json TEXT)");
    for (const i of [19, 20, 21]) db.prepare("INSERT INTO orchestration_v2_projection_nodes VALUES (?,?,?,?)").run(
      `node-${i}`, `synthetic-thread-${i}`, "tool", JSON.stringify({ synthetic: true, text: "x".repeat(8192) }),
    );
    repairOwnerAnswerHistory(db);
    const rows = db.prepare("SELECT * FROM orchestration_v2_projection_nodes").all();
    assert.equal(rows.length, 3);
    for (const row of rows.slice(1)) {
      const decoded = decodeHistoryNode(row.payload_json);
      assert.equal(decoded.threadId, row.thread_id);
      assert.equal(decoded.kind, "tool_call");
      assert.equal(JSON.parse(String(row.payload_json)).text.length, 8192);
    }
    assert.equal(JSON.parse(String(rows[0]!.payload_json)).id, undefined);
  } finally { db.close(); }
});
