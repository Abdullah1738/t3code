// @effect-diagnostics nodeBuiltinImport:off - Only disposable in-memory synthetic boards are used.
import * as NodeTest from "node:test";
const { test } = NodeTest;
import * as NodeAssert from "node:assert/strict";
const assert: typeof NodeAssert = NodeAssert;
import type { KanbanCard, KanbanMessage } from "@t3tools/contracts";
import { KanbanDiscussionId } from "@t3tools/contracts";
import { ownerWriteTestFixture } from "./ownerWriteTestFixture.ts";
import { migrateOwnerWriteBoards } from "./ownerAnswerFixture.ts";
import { mockAnswerDelivery, ownerAnswerCases } from "./ownerAnswers.ts";
import { assertOpenOwnerPost, assertPersistedOwnerPost, assertClosedOwnerPost, ownerMessagePostCases, ownerMessagePostInput } from "./ownerMessagePosts.ts";

test("forty owner posts use fresh asks, distinct sequences and separate reply markers", () => {
  const db = ownerWriteTestFixture();
  try {
    const samples = ownerMessagePostCases();
    assert.equal(samples.length, 40);
    assert.equal(new Set([...samples, ...ownerAnswerCases()].map((sample) => sample.discussionId)).size, 80);
    for (const route of ["worker", "evaluator", "fallback", "launch"])
      assert.equal(samples.filter((sample) => sample.route === route).length, 10);
    for (const sample of samples) {
      const card = JSON.parse(String(db.prepare("SELECT json FROM ardud_kanban_cards WHERE id=?").get(sample.cardId)!.json)) as KanbanCard;
      const question = JSON.parse(String(db.prepare("SELECT json FROM ardud_kanban_messages WHERE discussion_id=? AND seq=?").get(sample.discussionId, sample.seq)!.json)) as KanbanMessage;
      assertOpenOwnerPost(sample, card, question);
      assert.equal(JSON.stringify({ card, question }).includes(sample.marker), false);
      assert.throws(() => assertOpenOwnerPost(sample, card, { ...question, seq: sample.postedSeq }));
      assert.throws(() => assertOpenOwnerPost(sample, card, { ...question, author: { _tag: "owner" } }), /fresh open ask/);
      const posted: KanbanMessage = { ...question, seq: sample.postedSeq, author: { _tag: "owner" }, authorName: "Owner",
        blocks: ownerMessagePostInput(sample).blocks };
      assertPersistedOwnerPost(sample, posted);
      assert.throws(() => assertPersistedOwnerPost(sample, question), /persisted sequence/);
      assert.throws(() => assertPersistedOwnerPost(sample, { ...posted, seq: sample.seq }), /persisted sequence/);
      assert.throws(() => assertPersistedOwnerPost(sample, { ...posted, discussionId: KanbanDiscussionId.make(question.discussionId + "wrong") }), /persisted sequence/);
      assert.throws(() => assertPersistedOwnerPost(sample, { ...posted, blocks: [{ _tag: "md", text: "wrong" }] }), /persisted sequence/);
      const closed = { ...card, asks: card.asks.map((ask) => ({ ...ask, closedAt: "2026-02-01T00:00:00.000Z" })) };
      assertClosedOwnerPost(sample, closed);
      assert.throws(() => assertClosedOwnerPost(sample, card), /did not close/);
      assert.throws(() => assertOpenOwnerPost(sample, closed, question), /fresh open ask/);
    }
  } finally { db.close(); }
});

test("seeded questions and answer delivery cannot certify posted reply delivery", () => {
  const samples = ownerMessagePostCases();
  const prompt = (text: string) => JSON.stringify({ method: "session/prompt", params: { prompt: [{ type: "text", text }] } }) + "\n";
  assert.equal(mockAnswerDelivery(samples.map((sample) => prompt(sample.question)).join(""), samples).observed, 0);
  assert.equal(mockAnswerDelivery(ownerAnswerCases().map((sample) => prompt(sample.marker)).join(""), samples).observed, 0);
  assert.equal(mockAnswerDelivery(samples.map((sample) => prompt(ownerMessagePostInput(sample).blocks[0]!.text)).join(""), samples).observed, 40);
  assert.equal(mockAnswerDelivery(prompt(samples[0]!.marker).repeat(40), samples).observed, 1);
});

test("v2 migration adds only post fixtures and rejects consumed answer fixtures", () => {
  const db = ownerWriteTestFixture("answers");
  try {
    const before = db.prepare("SELECT json FROM ardud_kanban_cards ORDER BY id").all();
    migrateOwnerWriteBoards(db, "owner-answers-v2");
    for (const sample of ownerAnswerCases()) {
      const original = before.find((row) => JSON.parse(String(row.json)).id === sample.cardId);
      assert.equal(db.prepare("SELECT json FROM ardud_kanban_cards WHERE id=?").get(sample.cardId)!.json, original!.json);
    }
    assert.equal(db.prepare("SELECT count(*) AS n FROM ardud_kanban_cards WHERE id LIKE 'synthetic-owner-post-%'").get()!.n, 40);
    assert.throws(() => migrateOwnerWriteBoards(db, "owner-answers-v1"), /Unsupported/);
  } finally { db.close(); }
  const consumed = ownerWriteTestFixture("answers");
  try {
    const id = ownerAnswerCases()[0]!.cardId;
    consumed.prepare("UPDATE ardud_kanban_cards SET json=json_set(json,'$.asks[0].closedAt','2026-02-01T00:00:00.000Z') WHERE id=?").run(id);
    assert.throws(() => migrateOwnerWriteBoards(consumed, "owner-answers-v2"), /fresh open ask/);
    assert.equal(consumed.prepare("SELECT count(*) AS n FROM ardud_kanban_cards WHERE id LIKE 'synthetic-owner-post-%'").get()!.n, 0);
  } finally { consumed.close(); }
});
