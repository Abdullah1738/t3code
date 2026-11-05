// @effect-diagnostics nodeBuiltinImport:off globalDate:off - fixtures exercise native SQLite and explicitly mock the serialized worker's wall clock.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeSqlite from "node:sqlite";
import * as NodeWorkerThreads from "node:worker_threads";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { createReadonlyReplica } from "./readonlyExport.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup();
});

function fixture(batchSize = 2) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "readonly-export-"));
  cleanups.push(() => NodeFS.rmSync(dir, { recursive: true, force: true }));
  const sourcePath = NodePath.join(dir, "source.sqlite");
  const replicaPath = NodePath.join(dir, "readonly/state.sqlite");
  const source = new NodeSqlite.DatabaseSync(sourcePath);
  source.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE orchestration_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT, stream_id TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_runs (run_id TEXT PRIMARY KEY, thread_id TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_run_attempts (attempt_id TEXT PRIMARY KEY, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT PRIMARY KEY, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_provider_turns (provider_turn_id TEXT PRIMARY KEY, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_subagents (subagent_id TEXT PRIMARY KEY, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_messages (message_id TEXT PRIMARY KEY, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_turn_items (turn_item_id TEXT PRIMARY KEY, type TEXT, payload_json TEXT, thread_id TEXT DEFAULT 'a', ordinal INTEGER DEFAULT 0);
    CREATE INDEX items_thread ON orchestration_v2_projection_turn_items(thread_id,ordinal,turn_item_id);
    CREATE TABLE IF NOT EXISTS scheduled_tasks (task_id TEXT PRIMARY KEY, thread_id TEXT);
    CREATE TABLE ardud_opencode_import (native_session_id TEXT PRIMARY KEY, thread_id TEXT);
    CREATE TABLE ardud_kanban_cards (id TEXT PRIMARY KEY, active_thread_id TEXT, json TEXT);
    CREATE TABLE ardud_kanban_threads (thread_id TEXT PRIMARY KEY, ended INTEGER);
    INSERT INTO orchestration_events VALUES (1,'thread.created','a','{"id":"a"}');
    INSERT INTO orchestration_v2_projection_threads VALUES ('a','{"title":"old"}');
    INSERT INTO orchestration_v2_projection_threads VALUES ('b','{}');
    INSERT INTO orchestration_v2_projection_threads VALUES ('c','{}');
    INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,type,payload_json) VALUES ('tool','command_execution','{"text":"large tool output"}');
    INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,type,payload_json) VALUES ('stop','run_interrupt_request','{}');`);
  cleanups.push(() => source.close());
  const options = { sourcePath, replicaPath, batchSize };
  let exporter = createReadonlyReplica(NodeSqlite, NodeFS, NodePath, options);
  cleanups.push(() => exporter.close());
  const connect = () => {
    const db = new NodeSqlite.DatabaseSync(replicaPath, { readOnly: true });
    cleanups.push(() => db.close());
    return db;
  };
  const finish = () => {
    let steps = 0;
    while (exporter.step()) {
      if (++steps > 500) throw new Error("export did not converge");
    }
    return steps;
  };
  return {
    source,
    options,
    connect,
    finish,
    get exporter() {
      return exporter;
    },
    restart() {
      exporter.close();
      exporter = createReadonlyReplica(NodeSqlite, NodeFS, NodePath, options);
    },
  };
}

test("bootstrap is paged, resumable and never blocks the writer", () => {
  const f = fixture();
  const out = f.connect();
  expect(f.exporter.step()).toBe(true);
  expect(
    out.prepare("SELECT count(*) AS n FROM orchestration_v2_projection_threads").get()?.n,
  ).toBe(2);
  expect(out.prepare("SELECT value FROM ardud_readonly_meta WHERE key='ready'").get()?.value).toBe(
    "0",
  );
  f.source.exec("INSERT INTO orchestration_v2_projection_threads VALUES ('d','{}')");
  f.restart();
  f.finish();
  expect(
    out.prepare("SELECT count(*) AS n FROM orchestration_v2_projection_threads").get()?.n,
  ).toBe(4);
  expect(out.prepare("SELECT value FROM ardud_readonly_meta WHERE key='ready'").get()?.value).toBe(
    "1",
  );
  expect(
    out.prepare("SELECT turn_item_id FROM orchestration_v2_projection_turn_items").all(),
  ).toEqual([{ turn_item_id: "stop" }]);
  expect(NodeFS.statSync(f.options.replicaPath).mode & 0o777).toBe(0o600);
});

test("incremental catchup copies current projections, not partial event payloads", () => {
  const f = fixture();
  f.finish();
  f.source
    .exec(`UPDATE orchestration_v2_projection_threads SET payload_json='{"title":"new"}' WHERE thread_id='a';
    INSERT INTO orchestration_events(event_type,stream_id,payload_json) VALUES ('thread.metadata-updated','a','{"id":"a"}');
    INSERT INTO orchestration_v2_projection_runs VALUES ('r','a','{"restartCancelledBackgroundWork":[1]}');
    INSERT INTO orchestration_events(event_type,stream_id,payload_json) VALUES ('run.background-work-cancelled','a','{"runId":"r"}');`);
  f.finish();
  const out = f.connect();
  expect(
    out
      .prepare("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id='a'")
      .get()?.payload_json,
  ).toBe('{"title":"new"}');
  expect(
    out.prepare("SELECT payload_json FROM orchestration_v2_projection_runs").get()?.payload_json,
  ).toContain("restartCancelledBackgroundWork");
  expect(out.prepare("SELECT max(sequence) AS n FROM orchestration_events").get()?.n).toBe(3);
});

test("a Stop committed during a sweep is included before publishing readiness", () => {
  const f = fixture();
  f.finish();
  // Begins a cycle at sequence 1, then pauses during small-table export.
  f.exporter.step();
  f.source
    .exec(`INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,type,payload_json) VALUES ('stop2','run_interrupt_request','{}');
    INSERT INTO orchestration_events(event_type,stream_id,payload_json) VALUES ('turn-item.updated','a','{"id":"stop2"}');`);
  f.finish();
  const out = f.connect();
  expect(
    out
      .prepare("SELECT 1 FROM orchestration_v2_projection_turn_items WHERE turn_item_id='stop2'")
      .get(),
  ).toBeDefined();
  expect(
    out.prepare("SELECT value FROM ardud_readonly_meta WHERE key='sequence'").get()?.value,
  ).toBe("2");
});

test("a published reader snapshot stays fixed while the next generation is unavailable", () => {
  const f = fixture();
  f.finish();
  const reader = f.connect();
  reader.exec("BEGIN");
  expect(
    reader.prepare("SELECT value FROM ardud_readonly_meta WHERE key='ready'").get()?.value,
  ).toBe("1");
  f.source.exec("INSERT INTO scheduled_tasks VALUES ('task','a')");
  f.exporter.step();
  const next = f.connect();
  expect(next.prepare("SELECT value FROM ardud_readonly_meta WHERE key='ready'").get()?.value).toBe(
    "0",
  );
  f.finish();
  expect(reader.prepare("SELECT count(*) AS n FROM scheduled_tasks").get()?.n).toBe(0);
  expect(next.prepare("SELECT count(*) AS n FROM scheduled_tasks").get()?.n).toBe(1);
  reader.exec("ROLLBACK");
});

test("small table deletions and a compacted event gap converge without publishing partial data", () => {
  const f = fixture();
  f.source.exec("INSERT INTO scheduled_tasks VALUES ('gone','a')");
  f.finish();
  f.source.exec(`DELETE FROM scheduled_tasks;
    DELETE FROM orchestration_v2_projection_threads WHERE thread_id='a';
    INSERT INTO orchestration_events VALUES (4,'thread.deleted','a','{}');`);
  f.exporter.step();
  expect(
    f.connect().prepare("SELECT value FROM ardud_readonly_meta WHERE key='ready'").get()?.value,
  ).toBe("0");
  f.finish();
  const out = f.connect();
  expect(out.prepare("SELECT count(*) AS n FROM scheduled_tasks").get()?.n).toBe(0);
  expect(
    out.prepare("SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id='a'").get(),
  ).toBeUndefined();
});

test("physical archival deletes are reconciled without reading full tables", () => {
  const f = fixture();
  f.finish();
  f.source.exec("DELETE FROM orchestration_v2_projection_threads WHERE thread_id='a'");
  // One projection page rotates per cycle. The fixture fits in two pages.
  for (let i = 0; i < 18; i++) f.finish();
  expect(
    f
      .connect()
      .prepare("SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id='a'")
      .get(),
  ).toBeUndefined();
});

test("provider moves and selected turn items follow event-key updates", () => {
  const f = fixture();
  f.finish();
  f.source
    .exec(`UPDATE orchestration_v2_projection_threads SET payload_json='{"active":"pt"}' WHERE thread_id='a';
    INSERT INTO orchestration_v2_projection_provider_threads VALUES ('pt','{"nativeThreadRef":{"nativeId":"ses_new"}}');
    INSERT INTO orchestration_events(event_type,stream_id,payload_json) VALUES ('provider-thread.updated','a','{"id":"pt"}');
    UPDATE orchestration_v2_projection_turn_items SET type='command_execution' WHERE turn_item_id='stop';
    INSERT INTO orchestration_events(event_type,stream_id,payload_json) VALUES ('turn-item.updated','a','{"id":"stop"}');`);
  f.finish();
  const out = f.connect();
  expect(
    out.prepare("SELECT payload_json FROM orchestration_v2_projection_provider_threads").get()
      ?.payload_json,
  ).toContain("ses_new");
  expect(
    out
      .prepare("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id='a'")
      .get()?.payload_json,
  ).toBe('{"active":"pt"}');
  expect(
    out.prepare("SELECT count(*) AS n FROM orchestration_v2_projection_turn_items").get()?.n,
  ).toBe(0);
});

test("turn-item catchup never parses excluded event JSON", () => {
  const f = fixture();
  f.finish();
  // Invalid JSON is stronger than a large valid value: json_extract would fail.
  f.source
    .prepare(
      "INSERT INTO orchestration_events(event_type,stream_id,payload_json) VALUES ('turn-item.updated','a',?)",
    )
    .run("x".repeat(2_000_000));
  f.finish();
  expect(
    f.connect().prepare("SELECT value FROM ardud_readonly_meta WHERE key='ready'").get()?.value,
  ).toBe("1");
});

test("a gap after an abandoned auxiliary sweep uses a new seen generation", () => {
  const f = fixture();
  f.finish();
  f.source.exec("INSERT INTO scheduled_tasks VALUES ('gone','a')");
  f.exporter.step();
  f.source.exec(
    "DELETE FROM scheduled_tasks; INSERT INTO orchestration_events VALUES (4,'thread.deleted','a','{}')",
  );
  f.finish();
  expect(f.connect().prepare("SELECT count(*) AS n FROM scheduled_tasks").get()?.n).toBe(0);
});

test("archive journal removes an old item but cannot erase its later update", () => {
  const f = fixture();
  f.finish();
  f.source.exec(
    "CREATE TABLE ardud_history_archive_deletions(sequence INTEGER PRIMARY KEY,table_name TEXT,row_key TEXT,through_event_sequence INTEGER,archived_at TEXT)",
  );
  f.source.exec(
    "DELETE FROM orchestration_v2_projection_turn_items WHERE turn_item_id='stop'; INSERT INTO ardud_history_archive_deletions VALUES (1,'orchestration_v2_projection_turn_items','stop',1,'now')",
  );
  f.finish();
  expect(
    f
      .connect()
      .prepare("SELECT 1 FROM orchestration_v2_projection_turn_items WHERE turn_item_id='stop'")
      .get(),
  ).toBeUndefined();
  f.source
    .exec(`INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,type,payload_json) VALUES ('stop','run_interrupt_request','{"late":true}');
    INSERT INTO orchestration_events(event_type,stream_id,payload_json) VALUES ('turn-item.updated','a','{"id":"stop"}');
    INSERT INTO ardud_history_archive_deletions VALUES (2,'orchestration_v2_projection_turn_items','stop',1,'now')`);
  f.finish();
  expect(
    f
      .connect()
      .prepare(
        "SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id='stop'",
      )
      .get()?.payload_json,
  ).toContain("late");
  expect(
    f
      .connect()
      .prepare("SELECT value FROM ardud_readonly_meta WHERE key='archive_deletion_sequence'")
      .get()?.value,
  ).toBe("2");
});

test("catchup merges archived events by sequence and keeps newer live duplicates", () => {
  const f = fixture();
  f.finish();
  f.exporter.close();
  const archivePath = NodePath.join(NodePath.dirname(f.options.sourcePath), "archive.sqlite");
  const cold = new NodeSqlite.DatabaseSync(archivePath);
  cleanups.push(() => cold.close());
  cold.exec(`PRAGMA journal_mode=WAL; CREATE TABLE ardud_identity(identity TEXT PRIMARY KEY); INSERT INTO ardud_identity VALUES ('test');
    CREATE TABLE ardud_events(sequence INTEGER PRIMARY KEY,event_type TEXT,stream_id TEXT,payload_json TEXT);
    INSERT INTO ardud_events VALUES (2,'thread.metadata-updated','a','{"id":"a","cold":true}');
    INSERT INTO ardud_events VALUES (3,'thread.metadata-updated','a','{"id":"a","cold":true}');`);
  f.source
    .exec(`CREATE TABLE ardud_history_archive_identity(identity TEXT PRIMARY KEY); INSERT INTO ardud_history_archive_identity VALUES ('test');
    INSERT INTO orchestration_events VALUES (3,'thread.metadata-updated','a','{"id":"a","live":true}');
    UPDATE orchestration_v2_projection_threads SET payload_json='{"title":"new"}' WHERE thread_id='a'`);
  const exporter = createReadonlyReplica(NodeSqlite, NodeFS, NodePath, {
    ...f.options,
    archivePath,
  });
  cleanups.push(() => exporter.close());
  for (let i = 0; exporter.step(); i++) {
    if (i > 500) throw Error("no converge");
  }
  const out = f.connect();
  expect(
    out.prepare("SELECT payload_json FROM orchestration_events WHERE sequence=3").get()
      ?.payload_json,
  ).toContain("live");
  expect(
    out.prepare("SELECT value FROM ardud_readonly_meta WHERE key='sequence'").get()?.value,
  ).toBe("3");
  expect(
    out
      .prepare("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id='a'")
      .get()?.payload_json,
  ).toContain("new");
});

test("dirty item target paging uses its own index without a temporary sort", () => {
  const f = fixture();
  f.finish();
  const plan = f
    .connect()
    .prepare(
      "EXPLAIN QUERY PLAN SELECT rowid,turn_item_id FROM orchestration_v2_projection_turn_items WHERE thread_id=? AND rowid>? ORDER BY rowid LIMIT ?",
    )
    .all("a", 0, 2);
  expect(plan.map((row) => row.detail).join("\n")).toContain("ardud_readonly_items_thread");
  expect(plan.map((row) => row.detail).join("\n")).not.toContain("TEMP");
});

test("incomplete boards export legacy data then reopens at completed split", () => {
  const f = fixture();
  f.exporter.close();
  const boardPath = NodePath.join(NodePath.dirname(f.options.sourcePath), "boards.sqlite");
  const boards = new NodeSqlite.DatabaseSync(boardPath);
  cleanups.push(() => boards.close());
  boards.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE ardud_boards_migration(table_name TEXT PRIMARY KEY,completed INTEGER); INSERT INTO ardud_boards_migration VALUES ('*',0)",
  );
  const exporter = createReadonlyReplica(NodeSqlite, NodeFS, NodePath, { ...f.options, boardPath });
  cleanups.push(() => exporter.close());
  for (let i = 0; exporter.step(); i++) {
    if (i > 500) throw Error("no convergence");
  }
  boards.exec("UPDATE ardud_boards_migration SET completed=1");
  expect(() => exporter.step()).toThrow("Board split completed");
  expect(
    f.connect().prepare("SELECT value FROM ardud_readonly_meta WHERE key='ready'").get()?.value,
  ).toBe("0");
});

test("slow catchup cannot make old auxiliary rows look fresh", () => {
  const f = fixture();
  f.finish();
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const started = now;
  f.source.exec("INSERT INTO scheduled_tasks VALUES ('task','a')");
  f.exporter.step();
  f.source.exec("UPDATE scheduled_tasks SET thread_id='b' WHERE task_id='task'");
  now += 180_000;
  f.source.exec(
    "INSERT INTO orchestration_events(event_type,stream_id,payload_json) VALUES ('thread.metadata-updated','a','{\"id\":\"a\"}')",
  );
  f.finish();
  const out = f.connect();
  expect(
    Date.parse(
      String(
        out.prepare("SELECT value FROM ardud_readonly_meta WHERE key='updated_at'").get()?.value,
      ),
    ),
  ).toBeLessThanOrEqual(started + 1);
});

test("reads split boards when supplied, never stale legacy board tables", () => {
  const f = fixture();
  f.exporter.close();
  const boardPath = NodePath.join(NodePath.dirname(f.options.sourcePath), "boards.sqlite");
  const boards = new NodeSqlite.DatabaseSync(boardPath);
  boards.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE ardud_boards_migration(table_name TEXT PRIMARY KEY,completed INTEGER);
    INSERT INTO ardud_boards_migration VALUES ('*',1);
    CREATE TABLE ardud_kanban_cards(id TEXT PRIMARY KEY, active_thread_id TEXT, json TEXT);
    CREATE TABLE ardud_kanban_threads(thread_id TEXT PRIMARY KEY, ended INTEGER);
    INSERT INTO ardud_kanban_cards VALUES ('split','a','{}');`);
  cleanups.push(() => boards.close());
  const exporter = createReadonlyReplica(NodeSqlite, NodeFS, NodePath, { ...f.options, boardPath });
  cleanups.push(() => exporter.close());
  for (let i = 0; exporter.step(); i++) {
    if (i > 500) throw new Error("export did not converge");
  }
  expect(f.connect().prepare("SELECT id FROM ardud_kanban_cards").all()).toEqual([{ id: "split" }]);
});

test("refuses a non-WAL source and source/target aliases", () => {
  const f = fixture();
  const alias = NodePath.join(NodePath.dirname(f.options.sourcePath), "alias.sqlite");
  NodeFS.linkSync(f.options.sourcePath, alias);
  expect(() =>
    createReadonlyReplica(NodeSqlite, NodeFS, NodePath, { ...f.options, replicaPath: alias }),
  ).toThrow("Replica cannot");
  const plain = NodePath.join(NodePath.dirname(f.options.sourcePath), "plain.sqlite");
  new NodeSqlite.DatabaseSync(plain).close();
  expect(() =>
    createReadonlyReplica(NodeSqlite, NodeFS, NodePath, { ...f.options, sourcePath: plain }),
  ).toThrow("WAL");
});

test("the packaged worker function has no external runtime dependencies", async () => {
  const f = fixture();
  f.exporter.close();
  const worker = new NodeWorkerThreads.Worker(
    `
    const {parentPort,workerData}=require('node:worker_threads');
    const exporter=(${createReadonlyReplica.toString()})(require('node:sqlite'),require('node:fs'),require('node:path'),workerData);
    exporter.step(); exporter.close(); parentPort.postMessage('ok');
  `,
    { eval: true, execArgv: [], workerData: f.options },
  );
  await expect(
    new Promise((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
    }),
  ).resolves.toBe("ok");
  await worker.terminate();
});
