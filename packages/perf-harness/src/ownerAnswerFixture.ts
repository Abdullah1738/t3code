// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off preferSchemaOverJson:off - Only newly generated synthetic fixtures are opened here.
import * as NodeSqlite from "node:sqlite";
import * as NodeFS from "node:fs";
const { cpSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } = NodeFS;
import * as NodePath from "node:path";
const { resolve } = NodePath;
import * as NodeURL from "node:url";
const { pathToFileURL } = NodeURL;
import * as Schema from "effect/Schema";
import {
  KanbanCard,
  KanbanDiscussion,
  KanbanMessage,
  OrchestrationV2ExecutionNodeJson,
} from "@t3tools/contracts";
import { assertRuntime } from "./runtime.ts";
import { fileHash, hash } from "./metrics.ts";
import {
  assertOpenOwnerAsk,
  ownerAnswerCases,
  ownerAnswerSamples,
  ownerAnswerWorkload,
  type OwnerAnswerCase,
} from "./ownerAnswers.ts";
import { ownerMessagePostCases } from "./ownerMessagePosts.ts";

const at = "2026-01-01T00:00:00.000Z";
const model = { instanceId: "synthetic", model: "default" };
const decodeHistoryNode = Schema.decodeUnknownSync(OrchestrationV2ExecutionNodeJson);
const encodeHistoryNode = Schema.encodeSync(OrchestrationV2ExecutionNodeJson);
const decodeCard = Schema.decodeUnknownSync(KanbanCard);
const decodeDiscussion = Schema.decodeUnknownSync(KanbanDiscussion);
const decodeMessage = Schema.decodeUnknownSync(KanbanMessage);

export function repairOwnerAnswerHistory(main: NodeSqlite.DatabaseSync) {
  // The bulk fixture uses opaque node payloads for storage load. Real sends
  // decode the recipients' history, so retain those rows with valid payloads.
  for (const threadId of ["synthetic-thread-20", "synthetic-thread-21"]) {
    const nodes = main
      .prepare(
        "SELECT node_id, payload_json FROM orchestration_v2_projection_nodes WHERE thread_id=?",
      )
      .all(threadId);
    for (const row of nodes) {
      const node = decodeHistoryNode({
        id: row.node_id,
        threadId,
        runId: null,
        rootNodeId: row.node_id,
        parentNodeId: null,
        kind: "tool_call",
        status: "completed",
        countsForRun: false,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: at,
        completedAt: at,
      });
      const encoded = encodeHistoryNode(node);
      main
        .prepare(
          "UPDATE orchestration_v2_projection_nodes SET kind='tool_call',payload_json=? WHERE node_id=?",
        )
        .run(JSON.stringify({ ...JSON.parse(String(row.payload_json)), ...encoded }), row.node_id!);
    }
  }
}

export function seedOwnerAnswers(
  boards: NodeSqlite.DatabaseSync,
  family: "all" | "answers" | "messagePosts" = "all",
) {
  const template = JSON.parse(
    String(boards.prepare("SELECT json FROM ardud_kanban_cards LIMIT 1").get()!.json),
  );
  const discussionTemplate = JSON.parse(
    String(boards.prepare("SELECT json FROM ardud_kanban_discussions LIMIT 1").get()!.json),
  );
  const boardId = "synthetic-board-0";
  boards.exec("BEGIN");
  try {
    // Only answer recipients can run; no work pool is added to the fixture.
    const board = JSON.parse(
      String(boards.prepare("SELECT json FROM ardud_kanban_boards WHERE id=?").get(boardId)!.json),
    );
    boards
      .prepare("UPDATE ardud_kanban_boards SET json=? WHERE id=?")
      .run(
        JSON.stringify({ ...board, defaultProjectId: "synthetic-project", evaluatorModel: model }),
        boardId,
      );
    const answers =
      family === "messagePosts"
        ? []
        : ownerAnswerCases().map((sample) => ({
            ...sample,
            title: sample.marker,
            question: `${sample.marker} May this change proceed?`,
            number: 501 + sample.sample,
          }));
    const posts =
      family === "answers"
        ? []
        : ownerMessagePostCases().map((sample) => ({
            ...sample,
            title: sample.question,
            number: 501 + ownerAnswerSamples + sample.sample,
          }));
    for (const sample of [...answers, ...posts]) {
      const by = {
        _tag: sample.route === "worker" || sample.route === "fallback" ? "thread" : "evaluator",
        threadId: sample.askerThreadId,
      };
      const ask = {
        id: sample.askId,
        text: sample.question,
        by,
        blocking: sample.route !== "worker",
        seq: sample.seq,
        at,
        closedAt: null,
      };
      const companion = {
        ...ask,
        id: "q1",
        text: "Keep this separate question open.",
        blocking: false,
        seq: 21,
      };
      const card = decodeCard({
        ...template,
        id: sample.cardId,
        boardId,
        number: sample.number,
        title: sample.title,
        discussionId: sample.discussionId,
        stage: ask.blocking ? "needs_owner" : "working",
        model,
        projectId: "synthetic-project",
        activeThreadId: sample.route === "worker" ? sample.askerThreadId : null,
        activeRole: sample.route === "worker" ? "work" : null,
        activePool: null,
        workThreadId: sample.route === "worker" ? sample.askerThreadId : null,
        reviewThreadId: null,
        question: ask.blocking ? ask.text : null,
        asks: sample.kind === "pick" ? [companion, ask] : [ask],
      });
      const discussion = decodeDiscussion({
        ...discussionTemplate,
        id: sample.discussionId,
        boardId,
        cardId: sample.cardId,
        title: sample.title,
        evaluatorThreadId:
          sample.route === "launch" || sample.route === "worker" ? null : "synthetic-thread-21",
        participants: [],
        lastSeq: sample.seq,
        lastMessageAt: at,
      });
      boards
        .prepare("INSERT INTO ardud_kanban_cards VALUES (?,?,?,?,?,?)")
        .run(card.id, boardId, card.number, card.stage, card.activeThreadId, JSON.stringify(card));
      boards
        .prepare("INSERT INTO ardud_kanban_discussions VALUES (?,?,?,?,?)")
        .run(
          discussion.id,
          boardId,
          card.id,
          discussion.evaluatorThreadId,
          JSON.stringify(discussion),
        );
      for (const entry of card.asks) {
        const message = decodeMessage({
          discussionId: discussion.id,
          seq: entry.seq,
          author: entry.by,
          authorName: entry.by._tag === "thread" ? "Worker" : "Evaluator",
          blocks:
            sample.kind !== "post" && entry.id === sample.askId
              ? [
                  {
                    _tag: "choice",
                    id: entry.id,
                    style: "pick",
                    question: entry.text,
                    options: [
                      { id: "o1", label: "Hold" },
                      { id: "o2", label: "Proceed" },
                    ],
                    multi: false,
                  },
                ]
              : [{ _tag: "md", text: entry.text }],
          answers: [],
          createdAt: at,
        });
        boards
          .prepare("INSERT INTO ardud_kanban_messages VALUES (?,?,?)")
          .run(discussion.id, entry.seq!, JSON.stringify(message));
      }
    }
    boards.exec("COMMIT");
  } catch (error) {
    boards.exec("ROLLBACK");
    throw error;
  }
}

// Rebase the disposable clone's workspace and mock command paths at run time;
// pristine fixtures contain no machine-specific paths or credentials.
export function configureOwnerAnswerMock(home: string, mockScript: string) {
  const workspace = resolve(home, "workspace");
  mkdirSync(workspace, { recursive: true });
  const db = new NodeSqlite.DatabaseSync(resolve(home, "userdata/statev2.sqlite"));
  try {
    db.prepare(`INSERT INTO projection_projects
      (project_id,title,workspace_root,scripts_json,created_at,updated_at)
      VALUES ('synthetic-project','Synthetic',?,'[]',?,?)
      ON CONFLICT(project_id) DO UPDATE SET workspace_root=excluded.workspace_root`).run(
      workspace,
      at,
      at,
    );
    for (const id of ["synthetic-thread-20", "synthetic-thread-21"]) {
      const row = db
        .prepare("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?")
        .get(id);
      if (!row) throw new Error(`Missing synthetic answer recipient ${id}`);
      const payload = JSON.parse(String(row.payload_json));
      payload.modelSelection = model;
      db.prepare(
        "UPDATE orchestration_v2_projection_threads SET payload_json=? WHERE thread_id=?",
      ).run(JSON.stringify(payload), id);
    }
  } finally {
    db.close();
  }
  writeFileSync(
    resolve(home, "userdata/settings.json"),
    JSON.stringify({
      providerInstances: {
        synthetic: {
          driver: "acpRegistry",
          enabled: true,
          displayName: "Synthetic mock",
          config: {
            source: "local",
            commandPath: process.execPath,
            commandArgs: [mockScript],
            customModels: ["default"],
          },
          environment: [
            {
              name: "T3_ACP_REQUEST_LOG_PATH",
              value: resolve(home, "perf/mock-requests.ndjson"),
              sensitive: false,
            },
            {
              name: "T3_ACP_PROMPT_RESPONSE_TEXT",
              value: "Synthetic acknowledgement.",
              sensitive: false,
            },
          ],
        },
      },
    }),
  );
}

export function ownerAnswerRoutingEvidence(
  boards: NodeSqlite.DatabaseSync,
  main: NodeSqlite.DatabaseSync,
  samples: ReadonlyArray<
    Pick<OwnerAnswerCase, "discussionId" | "recipientThreadId" | "route" | "marker">
  > = ownerAnswerCases(),
) {
  let routedAsks = 0,
    launchedEvaluators = 0;
  for (const sample of samples) {
    const row = boards
      .prepare("SELECT json FROM ardud_kanban_discussions WHERE id=?")
      .get(sample.discussionId);
    const discussion = row ? JSON.parse(String(row.json)) : null;
    const recipient = sample.recipientThreadId ?? discussion?.evaluatorThreadId;
    if (typeof recipient !== "string") continue;
    if (sample.route === "launch") {
      const link = boards
        .prepare("SELECT json FROM ardud_kanban_threads WHERE thread_id=?")
        .get(recipient);
      const value = link ? JSON.parse(String(link.json)) : null;
      if (value?.role !== "evaluator" || value?.purpose !== `discussion:${sample.discussionId}`)
        continue;
      launchedEvaluators++;
    }
    const messages = main
      .prepare("SELECT payload_json FROM orchestration_v2_projection_messages WHERE thread_id=?")
      .all(recipient);
    if (
      messages.some((row) => {
        const message = JSON.parse(String(row.payload_json));
        return (
          message.role === "user" &&
          typeof message.text === "string" &&
          message.text.includes(sample.marker)
        );
      })
    )
      routedAsks++;
  }
  return { routedAsks, launchedEvaluators };
}

export function migrateOwnerWriteBoards(
  boards: NodeSqlite.DatabaseSync,
  previousWorkload?: string,
) {
  if (previousWorkload === undefined) return seedOwnerAnswers(boards);
  if (previousWorkload !== "owner-answers-v2")
    throw new Error("Unsupported owner-write fixture version");
  // A consumed fixture must never turn answered asks back into fresh samples.
  for (const sample of ownerAnswerCases()) {
    const card = boards
      .prepare("SELECT json FROM ardud_kanban_cards WHERE id=?")
      .get(sample.cardId);
    const message = boards
      .prepare("SELECT json FROM ardud_kanban_messages WHERE discussion_id=? AND seq=?")
      .get(sample.discussionId, sample.seq);
    if (!card || !message) throw new Error("Incomplete owner-answer fixture");
    assertOpenOwnerAsk(
      sample,
      decodeCard(JSON.parse(String(card.json))),
      decodeMessage(JSON.parse(String(message.json))),
    );
  }
  seedOwnerAnswers(boards, "messagePosts");
}

// Upgrade retained synthetic scale fixtures without rebuilding millions of rows.
// The source is immutable and only the new, credential-free destination opens RW.
export async function ownerAnswerFixture(source: string, destination: string) {
  assertRuntime();
  const meta = JSON.parse(readFileSync(resolve(source, "fixture.json"), "utf8"));
  if (
    meta.synthetic !== true ||
    meta.ownerWrites !== undefined ||
    (meta.ownerAnswers !== undefined && meta.ownerAnswers !== "owner-answers-v2")
  )
    throw new Error(
      "A pristine synthetic fixture or unconsumed owner-answers-v2 fixture is required",
    );
  if (existsSync(destination)) throw new Error("Fixture destination must not exist");
  mkdirSync(resolve(destination, "userdata"), { recursive: true });
  for (const name of ["statev2.sqlite", "boards.sqlite", "archive.sqlite"]) {
    const path = resolve(source, "userdata", name);
    if (name === "archive.sqlite" && !existsSync(path)) continue;
    if (existsSync(path + "-wal"))
      throw new Error("Close and checkpoint the synthetic source before upgrading it");
    cpSync(path, resolve(destination, "userdata", name), { mode: constants.COPYFILE_FICLONE });
  }
  const main = new NodeSqlite.DatabaseSync(resolve(destination, "userdata/statev2.sqlite"));
  try {
    repairOwnerAnswerHistory(main);
  } finally {
    main.close();
  }
  const db = new NodeSqlite.DatabaseSync(resolve(destination, "userdata/boards.sqlite"));
  try {
    migrateOwnerWriteBoards(db, meta.ownerAnswers);
  } finally {
    db.close();
  }
  const { fixtureHash: _oldHash, ownerAnswers: _oldWorkload, ...previous } = meta;
  const manifest = {
    ...previous,
    version: 3,
    ownerWrites: ownerAnswerWorkload,
    files: {
      ...meta.files,
      main: await fileHash(resolve(destination, "userdata/statev2.sqlite")),
      boards: await fileHash(resolve(destination, "userdata/boards.sqlite")),
    },
  };
  const result = { ...manifest, fixtureHash: hash(manifest) };
  writeFileSync(resolve(destination, "fixture.json"), JSON.stringify(result, null, 2));
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [source, destination] = process.argv.slice(2);
  if (!source || !destination)
    throw new Error("ownerAnswerFixture.ts SYNTHETIC_SOURCE NEW_DESTINATION");
  console.log(await ownerAnswerFixture(resolve(source), resolve(destination)));
}
