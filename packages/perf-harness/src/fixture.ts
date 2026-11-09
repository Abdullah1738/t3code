// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off globalDate:off globalConsole:off preferSchemaOverJson:off - Harness process boundaries intentionally measure native I/O and wall time outside the application runtime.
import { assertRuntime } from "./runtime.ts";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, writeFileSync, statfsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EventId, ThreadId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import * as Sqlite from "../../../apps/server/src/persistence/Sqlite.ts";
import * as Projection from "../../../apps/server/src/orchestration-v2/ProjectionStore.ts";
import { kanbanDDL } from "../../../apps/server/src/ardud/persistence/kanbanSchema.ts";
import { hash, fileHash } from "./metrics.ts";
import { repairOwnerAnswerHistory, seedOwnerAnswers } from "./ownerAnswerFixture.ts";
import { ownerAnswerWorkload } from "./ownerAnswers.ts";

export const scales = {
  correctness: { threads: 24, nodes: 240, agents: 0, boards: 2 },
  "1x": { threads: 20000, nodes: 1260000, agents: 32, boards: 8 },
  "5x": { threads: 100000, nodes: 6300000, agents: 128, boards: 40 },
  "10x": { threads: 200000, nodes: 12600000, agents: 512, boards: 80 },
} as const;
export function random(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const at = "2026-01-01T00:00:00.000Z";
const model = { instanceId: "synthetic", model: "synthetic" };
export async function fixture(directory: string, scale: keyof typeof scales, seed = 42) {
  assertRuntime();
  const dir = resolve(directory);
  // A new home is mandatory; there is deliberately no copy/import mode.
  if (existsSync(dir)) throw new Error("Fixture directory must not exist");
  mkdirSync(resolve(dir, "userdata"), { recursive: true });
  const mainPath = resolve(dir, "userdata/statev2.sqlite");
  const config = scales[scale],
    rng = random(seed);
  const space = statfsSync(dir);
  if (space.bavail * space.bsize < config.nodes * 4400 + config.threads * 8000)
    throw new Error("Insufficient disk for fixture plus one isolated repeat");
  const layer = Projection.layer.pipe(Layer.provideMerge(Sqlite.layerFromPath(mainPath)));
  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* Projection.ProjectionStoreV2;
      const now = DateTime.makeUnsafe(at),
        tid = ThreadId.make("synthetic-thread-0");
      yield* store.apply({
        id: EventId.make("synthetic-created-0"),
        type: "thread.created",
        threadId: tid,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: tid,
          projectId: ProjectId.make("synthetic-project"),
          title: "Synthetic 0",
          providerInstanceId: ProviderInstanceId.make("synthetic"),
          modelSelection: { instanceId: ProviderInstanceId.make("synthetic"), model: "synthetic" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: tid },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
    }).pipe(Effect.provide(Layer.provideMerge(layer, NodeServices.layer))),
  );
  const db = new DatabaseSync(mainPath);
  // Only this newly generated synthetic database uses relaxed import settings.
  db.exec("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-524288");
  const migrations = db
    .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='effect_sql_migrations'")
    .get();
  if (migrations) db.prepare("UPDATE effect_sql_migrations SET created_at=?").run(at);
  const template = db.prepare("SELECT * FROM orchestration_v2_projection_threads LIMIT 1").get()!;
  const columns = Object.keys(template);
  const insert = db.prepare(
    `INSERT OR REPLACE INTO orchestration_v2_projection_threads (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
  );
  db.exec("BEGIN");
  for (let i = 0; i < config.threads; i++) {
    const id = `synthetic-thread-${i}`,
      payload = JSON.parse(String(template.payload_json));
    payload.id = id;
    payload.title = `Synthetic ${i}`;
    payload.lineage.rootThreadId = id;
    const archived = i % 10 === 9 ? at : null;
    payload.archivedAt = archived;
    payload.autoSettleDisabledAt = at;
    const row: Record<string, import("node:sqlite").SQLInputValue> = {
      ...template,
      thread_id: id,
      title: payload.title,
      archived_at: archived,
      payload_json: JSON.stringify(payload),
    };
    insert.run(...columns.map((c) => row[c]!));
  }
  const node = db.prepare(
    `INSERT INTO orchestration_v2_projection_nodes (node_id,thread_id,root_node_id,kind,status,payload_json) VALUES (?,?,?,'tool','completed',?)`,
  );
  const item = db.prepare(
    `INSERT INTO orchestration_v2_projection_turn_items (turn_item_id,thread_id,ordinal,type,status,updated_at,payload_json) VALUES (?,?,?,'command_execution','completed',?,?)`,
  );
  const event = db.prepare(
    `INSERT INTO orchestration_v2_events (event_id,thread_id,node_id,event_type,occurred_at,payload_json) VALUES (?,?,?,'synthetic.activity',?,?)`,
  );
  for (let i = 0; i < config.nodes; i++) {
    const id = `synthetic-node-${i}`,
      tid = `synthetic-thread-${i % config.threads}`;
    const body = JSON.stringify({ synthetic: true, text: "x".repeat(rng() < 0.01 ? 8192 : 64) });
    const ordinal = Math.floor(i / config.threads);
    item.run(
      `synthetic-item-${i}`,
      tid,
      ordinal,
      at,
      JSON.stringify({
        id: `synthetic-item-${i}`,
        threadId: tid,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal,
        status: "completed",
        title: null,
        startedAt: at,
        completedAt: at,
        updatedAt: at,
        type: "command_execution",
        input: "synthetic",
        output: JSON.parse(body).text,
        exitCode: 0,
      }),
    );
    node.run(id, tid, id, body);
    event.run(`synthetic-event-${i}`, tid, id, at, body);
    if (i % 10000 === 9999) db.exec("COMMIT; BEGIN");
  }
  db.exec(
    "COMMIT; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA wal_checkpoint(TRUNCATE)",
  );
  repairOwnerAnswerHistory(db);
  db.close();
  const boards = new DatabaseSync(resolve(dir, "userdata/boards.sqlite"));
  for (const ddl of kanbanDDL) boards.exec(ddl);
  boards.exec("BEGIN");
  for (let b = 0; b < config.boards; b++) {
    const boardId = `synthetic-board-${b}`;
    const board = {
      id: boardId,
      slug: boardId,
      name: `Synthetic ${b}`,
      defaultProjectId: null,
      managerModel: model,
      evaluatorModel: model,
      defaultCardModel: model,
      reviewChains: [],
      defaultReviewChain: null,
      instructions: { modelRouting: "", reviewerRouting: "", escalation: "" },
      pause: null,
      createdAt: at,
      archivedAt: null,
    };
    boards
      .prepare("INSERT INTO ardud_kanban_boards VALUES (?,?,?)")
      .run(boardId, boardId, JSON.stringify(board));
    const count = scale === "correctness" ? 8 : b === 0 ? 500 : 100;
    for (let c = 0; c < count; c++) {
      const id = `${boardId}-card-${c}`,
        discussionId = `${id}-discussion`;
      const card = {
        id,
        boardId,
        number: c + 1,
        title: `Synthetic card ${c}`,
        description: "",
        prompt: "Synthetic task",
        stage: "todo",
        priority: 2,
        goalId: null,
        projects: [],
        model,
        projectId: null,
        links: [],
        blockedBy: [],
        stalled: null,
        question: null,
        reviewChain: null,
        reviewStep: 0,
        reviewRound: 0,
        activeThreadId: c > 3 && c < 36 ? `synthetic-thread-${c % config.threads}` : null,
        activeRole: null,
        activePool: null,
        workThreadId: null,
        reviewThreadId: null,
        discussionId,
        wakeNote: null,
        nudgedAt: null,
        settledAt: null,
        createdBy: { _tag: "owner" },
        createdAt: at,
        updatedAt: at,
        movedAt: at,
      };
      boards
        .prepare("INSERT INTO ardud_kanban_cards VALUES (?,?,?,?,?,?)")
        .run(id, boardId, c + 1, "todo", card.activeThreadId, JSON.stringify(card));
      const discussion = {
        id: discussionId,
        boardId,
        cardId: c < 4 ? null : id,
        title: card.title,
        evaluatorThreadId: null,
        participants: [],
        lastSeq: 20,
        lastMessageAt: at,
        createdBy: { _tag: "owner" },
        createdAt: at,
        archivedAt: null,
      };
      boards
        .prepare("INSERT INTO ardud_kanban_discussions VALUES (?,?,?,?,?)")
        .run(discussionId, boardId, id, null, JSON.stringify(discussion));
      for (let seq = 1; seq <= 20; seq++)
        boards.prepare("INSERT INTO ardud_kanban_messages VALUES (?,?,?)").run(
          discussionId,
          seq,
          JSON.stringify({
            discussionId,
            seq,
            author: { _tag: "owner" },
            authorName: "Synthetic",
            blocks: [{ _tag: "md", text: `Synthetic ${seq}` }],
            answers: [],
            createdAt: at,
          }),
        );
    }
  }
  boards.exec("COMMIT");
  seedOwnerAnswers(boards);
  boards.close();
  const manifest = {
    version: 2,
    ownerAnswers: ownerAnswerWorkload,
    synthetic: true,
    seed,
    scale,
    ...config,
    eventCount: config.nodes,
    bodyProfile: "1pct-8KiB-otherwise-64B",
    sqlite: process.versions.sqlite,
    node: process.version,
  };
  const files = {
    main: await fileHash(mainPath),
    boards: await fileHash(resolve(dir, "userdata/boards.sqlite")),
  };
  const result = { ...manifest, files, fixtureHash: hash({ manifest, files }) };
  writeFileSync(resolve(dir, "fixture.json"), JSON.stringify(result, null, 2));
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dir, scale = "correctness", seed = "42"] = process.argv.slice(2);
  if (!(scale in scales) || !dir)
    throw new Error("fixture.ts NEW_DIRECTORY correctness|1x|5x|10x [SEED]");
  console.log(await fixture(dir, scale as keyof typeof scales, Number(seed)));
}
