// @effect-diagnostics nodeBuiltinImport:off - Disposable in-memory board fixture.
import * as NodeSqlite from "node:sqlite";
import { kanbanDDL } from "../../../apps/server/src/ardud/persistence/kanbanSchema.ts";
import { seedOwnerAnswers } from "./ownerAnswerFixture.ts";

export function ownerWriteTestFixture(family: "all" | "answers" | "messagePosts" = "all") {
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
  seedOwnerAnswers(db, family);
  return db;
}
