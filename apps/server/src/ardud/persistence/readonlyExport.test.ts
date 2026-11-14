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
    CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT PRIMARY KEY, payload_json TEXT, thread_id TEXT);
    CREATE TABLE orchestration_v2_projection_provider_turns (provider_turn_id TEXT PRIMARY KEY, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_subagents (subagent_id TEXT PRIMARY KEY, payload_json TEXT, thread_id TEXT, child_thread_id TEXT);
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
  cleanups.push(() => {
    if (source.isOpen) source.close();
  });
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

test("a published reader snapshot stays fixed while the next generation is in flight", () => {
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
  // A routine cycle is invisible until it completes: still the old generation.
  expect(next.prepare("SELECT value FROM ardud_readonly_meta WHERE key='ready'").get()?.value).toBe(
    "1",
  );
  expect(next.prepare("SELECT count(*) AS n FROM scheduled_tasks").get()?.n).toBe(0);
  f.finish();
  expect(reader.prepare("SELECT count(*) AS n FROM scheduled_tasks").get()?.n).toBe(0);
  expect(next.prepare("SELECT count(*) AS n FROM scheduled_tasks").get()?.n).toBe(1);
  reader.exec("ROLLBACK");
});

const metaValue = (db: NodeSqlite.DatabaseSync, key: string) =>
  db.prepare("SELECT value FROM ardud_readonly_meta WHERE key=?").get(key)?.value;

test("first bootstrap stays unready until every projection is exported", () => {
  const f = fixture();
  const out = f.connect();
  expect(metaValue(out, "ready")).toBe("0");
  expect(metaValue(out, "updated_at")).toBeUndefined();
  expect(metaValue(out, "lineage_repair_watermark")).toBeUndefined();
  let steps = 0;
  while (f.exporter.step()) {
    expect(metaValue(out, "ready")).toBe("0");
    expect(metaValue(out, "updated_at")).toBeUndefined();
    if (++steps > 500) throw new Error("export did not converge");
  }
  expect(steps).toBeGreaterThan(1);
  expect(metaValue(out, "ready")).toBe("1");
  expect(metaValue(out, "updated_at")).toBeDefined();
  expect(metaValue(out, "lineage_repair_revision")).toBe("0");
  expect(metaValue(out, "lineage_repair_watermark")).toBe(metaValue(out, "updated_at"));
});

test("routine refresh cycles keep ready=1 and only advance updated_at at cycle end", () => {
  const f = fixture();
  let now = Date.parse("2026-11-06T10:00:00.000Z");
  vi.spyOn(Date, "now").mockImplementation(() => now);
  f.finish();
  const out = f.connect();
  const published = metaValue(out, "updated_at");
  expect(published).toBe("2026-11-06T10:00:00.000Z");
  const generation = Number(metaValue(out, "generation"));
  now += 15_000;
  f.source.exec(`INSERT INTO scheduled_tasks VALUES ('task','a');
    UPDATE orchestration_v2_projection_threads SET payload_json='{"title":"new"}' WHERE thread_id='a';
    INSERT INTO orchestration_events(event_type,stream_id,payload_json) VALUES ('thread.metadata-updated','a','{"id":"a"}');`);
  let steps = 0;
  while (f.exporter.step()) {
    steps++;
    // Every mid-cycle read sees the previous, complete generation.
    expect(metaValue(out, "ready")).toBe("1");
    expect(metaValue(out, "updated_at")).toBe(published);
    expect(metaValue(out, "sequence")).toBe("1");
    expect(out.prepare("SELECT count(*) AS n FROM scheduled_tasks").get()?.n).toBe(0);
    expect(
      out
        .prepare("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id='a'")
        .get()?.payload_json,
    ).toBe('{"title":"old"}');
    if (steps > 500) throw new Error("export did not converge");
  }
  expect(steps).toBeGreaterThan(1);
  expect(metaValue(out, "ready")).toBe("1");
  expect(metaValue(out, "updated_at")).toBe("2026-11-06T10:00:15.000Z");
  expect(metaValue(out, "sequence")).toBe("2");
  expect(Number(metaValue(out, "generation"))).toBeGreaterThan(generation);
  expect(out.prepare("SELECT count(*) AS n FROM scheduled_tasks").get()?.n).toBe(1);
  // An idle cycle still publishes a newer generation stamp.
  now += 15_000;
  f.finish();
  expect(metaValue(out, "updated_at")).toBe("2026-11-06T10:00:30.000Z");
});

test("a compacted event gap clears readiness until the reset and rebuild finish", () => {
  const f = fixture();
  f.finish();
  const out = f.connect();
  const published = metaValue(out, "updated_at");
  const revision = Number(metaValue(out, "lineage_repair_revision"));
  f.source.exec("INSERT INTO orchestration_events VALUES (4,'thread.deleted','a','{}')");
  expect(f.exporter.step()).toBe(true);
  expect(metaValue(out, "ready")).toBe("0");
  expect(metaValue(out, "resetting_events")).toBe("1");
  expect(metaValue(out, "updated_at")).toBe(published);
  expect(Number(metaValue(out, "lineage_repair_revision"))).toBe(revision + 1);
  // A worker restart in the middle of the reset must not republish it.
  f.restart();
  expect(metaValue(out, "ready")).toBe("0");
  let steps = 0;
  while (f.exporter.step()) {
    expect(metaValue(out, "ready")).toBe("0");
    if (++steps > 500) throw new Error("export did not converge");
  }
  expect(metaValue(out, "ready")).toBe("1");
  expect(metaValue(out, "resetting_events")).toBe("0");
  expect(metaValue(out, "sequence")).toBe("4");
  expect(Number(metaValue(out, "lineage_repair_revision"))).toBe(revision + 1);
  expect(metaValue(out, "lineage_repair_watermark")).toBe(metaValue(out, "updated_at"));
});

test("reopening a published replica keeps it ready; an abandoned cycle is discarded", () => {
  const f = fixture();
  let now = Date.parse("2026-11-06T10:00:00.000Z");
  vi.spyOn(Date, "now").mockImplementation(() => now);
  f.finish();
  const out = f.connect();
  f.restart();
  expect(metaValue(out, "ready")).toBe("1");
  expect(metaValue(out, "updated_at")).toBe("2026-11-06T10:00:00.000Z");
  now += 15_000;
  f.source.exec("INSERT INTO scheduled_tasks VALUES ('task','a')");
  expect(f.exporter.step()).toBe(true);
  // Worker dies mid-cycle: readers keep the last generation, which only ages.
  f.restart();
  expect(metaValue(out, "ready")).toBe("1");
  expect(metaValue(out, "updated_at")).toBe("2026-11-06T10:00:00.000Z");
  expect(out.prepare("SELECT count(*) AS n FROM scheduled_tasks").get()?.n).toBe(0);
  now += 15_000;
  f.finish();
  expect(metaValue(out, "ready")).toBe("1");
  expect(metaValue(out, "updated_at")).toBe("2026-11-06T10:00:30.000Z");
  expect(out.prepare("SELECT count(*) AS n FROM scheduled_tasks").get()?.n).toBe(1);
});

test("a source schema change mid-cycle discards the cycle, then the reopen rebuilds", () => {
  const f = fixture();
  f.finish();
  const out = f.connect();
  f.source.exec("INSERT INTO scheduled_tasks VALUES ('task','a')");
  expect(f.exporter.step()).toBe(true);
  f.source.exec("ALTER TABLE scheduled_tasks ADD COLUMN extra TEXT");
  expect(() => f.exporter.step()).toThrow("schema changed");
  expect(metaValue(out, "ready")).toBe("0");
  expect(metaValue(out, "last_error")).toContain("schema changed");
  expect(out.prepare("SELECT count(*) AS n FROM scheduled_tasks").get()?.n).toBe(0);
  expect(() => f.exporter.step()).toThrow("schema changed");
  // Before 2026-11-10 every reopen threw here until someone deleted the file.
  f.restart();
  expect(metaValue(out, "last_rebuild_reason")).toBe("source schema changed: scheduled_tasks");
  expect(metaValue(out, "ready")).toBe("0");
  f.finish();
  expect(metaValue(out, "ready")).toBe("1");
  expect(f.connect().prepare("SELECT task_id, extra FROM scheduled_tasks").all()).toEqual([
    { task_id: "task", extra: null },
  ]);
  expect(
    f.connect().prepare("SELECT count(*) AS n FROM orchestration_v2_projection_threads").get()?.n,
  ).toBe(3);
});

test("a remounted volume (new st_dev, same inode) keeps exporting without a rebuild", () => {
  const f = fixture();
  let now = Date.parse("2026-11-08T23:16:59.000Z");
  vi.spyOn(Date, "now").mockImplementation(() => now);
  f.finish();
  f.exporter.close();
  // A replica published before the fix stored `${realpath}:${dev}:${ino}`.
  const real = NodeFS.realpathSync(f.options.sourcePath);
  const stat = NodeFS.statSync(f.options.sourcePath);
  const writable = new NodeSqlite.DatabaseSync(f.options.replicaPath);
  writable
    .prepare("UPDATE ardud_readonly_meta SET value=? WHERE key='source'")
    .run(`${real}:${stat.dev}:${stat.ino}`);
  writable.close();
  // The SSD comes back with a new device number; the file and inode are unchanged.
  const remounted = new Proxy(NodeFS, {
    get(target, key, receiver) {
      if (key !== "statSync") return Reflect.get(target, key, receiver);
      return (file: NodeFS.PathLike, ...rest: never[]) => {
        const result = target.statSync(file, ...rest) as NodeFS.Stats;
        return Object.assign(Object.create(Object.getPrototypeOf(result)), result, {
          dev: result.dev + 1,
        });
      };
    },
  });
  now = Date.parse("2026-11-10T09:00:00.000Z");
  f.source
    .exec(`UPDATE orchestration_v2_projection_threads SET payload_json='{"title":"after remount"}' WHERE thread_id='a';
    INSERT INTO orchestration_events(event_type,stream_id,payload_json) VALUES ('thread.metadata-updated','a','{"id":"a"}');`);
  const exporter = createReadonlyReplica(NodeSqlite, remounted, NodePath, f.options);
  cleanups.push(() => exporter.close());
  for (let i = 0; exporter.step(); i++) {
    if (i > 500) throw new Error("export did not converge");
  }
  const out = f.connect();
  expect(metaValue(out, "last_rebuild_reason")).toBeUndefined();
  expect(metaValue(out, "source")).toBe(`${real}#${stat.ino}`);
  expect(metaValue(out, "ready")).toBe("1");
  expect(metaValue(out, "updated_at")).toBe("2026-11-10T09:00:00.000Z");
  expect(
    out
      .prepare("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id='a'")
      .get()?.payload_json,
  ).toBe('{"title":"after remount"}');
});

test("a regressed event history rebuilds instead of failing every open", () => {
  const f = fixture();
  f.finish();
  f.exporter.close();
  f.source.exec(`DELETE FROM orchestration_events;
    INSERT INTO orchestration_v2_projection_threads VALUES ('restored','{}');`);
  const exporter = createReadonlyReplica(NodeSqlite, NodeFS, NodePath, f.options);
  cleanups.push(() => exporter.close());
  for (let i = 0; exporter.step(); i++) {
    if (i > 500) throw new Error("export did not converge");
  }
  const out = f.connect();
  expect(metaValue(out, "last_rebuild_reason")).toBe("source event sequence regressed");
  expect(metaValue(out, "ready")).toBe("1");
  expect(
    out.prepare("SELECT count(*) AS n FROM orchestration_v2_projection_threads").get()?.n,
  ).toBe(4);
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
    INSERT INTO orchestration_v2_projection_provider_threads(provider_thread_id,payload_json) VALUES ('pt','{"nativeThreadRef":{"nativeId":"ses_new"}}');
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

test("catchup merges main then delta then immutable original-table base in bounded pages", () => {
  const f = fixture(1);
  f.finish();
  f.exporter.close();
  const dir = NodePath.dirname(f.options.sourcePath);
  const baseName = "statev2.pre-shrink-fixture.sqlite";
  const base = new NodeSqlite.DatabaseSync(NodePath.join(dir, baseName));
  cleanups.push(() => base.close());
  base.exec(`CREATE TABLE orchestration_events(sequence INTEGER PRIMARY KEY,event_type TEXT,stream_id TEXT,payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_turn_items(turn_item_id TEXT PRIMARY KEY,type TEXT,payload_json TEXT);
    INSERT INTO orchestration_events VALUES (2,'thread.metadata-updated','a','{"base":2}');
    INSERT INTO orchestration_events VALUES (3,'thread.metadata-updated','a','{"base":3}');
    INSERT INTO orchestration_events VALUES (4,'thread.metadata-updated','a','{"base":4}');
    INSERT INTO orchestration_events VALUES (5,'thread.metadata-updated','a','{"base":5}');
    INSERT INTO orchestration_v2_projection_turn_items VALUES ('cold-only','user_message','{"cold":true}');`);
  const archivePath = NodePath.join(dir, "archive.sqlite");
  const delta = new NodeSqlite.DatabaseSync(archivePath);
  cleanups.push(() => delta.close());
  delta.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE ardud_identity(identity TEXT PRIMARY KEY); INSERT INTO ardud_identity VALUES ('test');
    CREATE TABLE ardud_events(sequence INTEGER PRIMARY KEY,event_type TEXT,stream_id TEXT,payload_json TEXT);
    INSERT INTO ardud_events VALUES (3,'thread.metadata-updated','a','{"delta":3}');
    INSERT INTO ardud_events VALUES (4,'thread.metadata-updated','a','{"delta":4}');`);
  f.source.exec(`CREATE TABLE ardud_history_base_archive(filename TEXT);
    INSERT INTO ardud_history_base_archive VALUES ('${baseName}');
    CREATE TABLE ardud_history_archive_identity(identity TEXT PRIMARY KEY);
    INSERT INTO ardud_history_archive_identity VALUES ('test');
    INSERT INTO orchestration_events VALUES (4,'thread.metadata-updated','a','{"main":4}');`);
  const exporter = createReadonlyReplica(NodeSqlite, NodeFS, NodePath, {
    ...f.options,
    archivePath,
  });
  cleanups.push(() => exporter.close());
  for (let i = 0; exporter.step(); i++) {
    if (i > 500) throw Error("base catchup did not converge");
  }
  const out = f.connect();
  expect(
    out
      .prepare(
        "SELECT sequence,payload_json FROM orchestration_events WHERE sequence BETWEEN 2 AND 5 ORDER BY sequence",
      )
      .all(),
  ).toEqual([
    { sequence: 2, payload_json: '{"base":2}' },
    { sequence: 3, payload_json: '{"delta":3}' },
    { sequence: 4, payload_json: '{"main":4}' },
    { sequence: 5, payload_json: '{"base":5}' },
  ]);
  expect(
    out
      .prepare(
        "SELECT 1 FROM orchestration_v2_projection_turn_items WHERE turn_item_id='cold-only'",
      )
      .get(),
  ).toBeUndefined();
});

test("immutable base is optional, but a missing or unsafe referenced base fails closed", () => {
  const f = fixture();
  f.finish();
  f.exporter.close();
  f.source.exec(
    "CREATE TABLE ardud_history_base_archive(filename TEXT); INSERT INTO ardud_history_base_archive VALUES ('statev2.pre-shrink-missing.sqlite')",
  );
  expect(() => createReadonlyReplica(NodeSqlite, NodeFS, NodePath, f.options)).toThrow(
    "base unavailable",
  );
  f.source.exec(
    "UPDATE ardud_history_base_archive SET filename='../statev2.pre-shrink-outside.sqlite'",
  );
  expect(() => createReadonlyReplica(NodeSqlite, NodeFS, NodePath, f.options)).toThrow(
    "base filename",
  );
});

test("base appearance invalidates an in-flight export rather than omitting its events", () => {
  const f = fixture();
  f.finish();
  f.source.exec(
    "CREATE TABLE ardud_history_base_archive(filename TEXT); INSERT INTO ardud_history_base_archive VALUES ('statev2.pre-shrink-new.sqlite')",
  );
  expect(() => f.exporter.step()).toThrow("History base changed");
  expect(
    f.connect().prepare("SELECT value FROM ardud_readonly_meta WHERE key='ready'").get()?.value,
  ).toBe("0");
});

test("first bootstrap uses live projections and skips replaying immutable base history", () => {
  const f = fixture();
  f.exporter.close();
  NodeFS.rmSync(f.options.replicaPath);
  const baseName = "statev2.pre-shrink-bootstrap.sqlite";
  const base = new NodeSqlite.DatabaseSync(
    NodePath.join(NodePath.dirname(f.options.sourcePath), baseName),
  );
  base.exec(`CREATE TABLE orchestration_events(sequence INTEGER PRIMARY KEY,event_type TEXT,stream_id TEXT,payload_json TEXT);
    INSERT INTO orchestration_events VALUES (50,'thread.metadata-updated','a','{"base":true}');
    CREATE TABLE orchestration_v2_projection_turn_items(turn_item_id TEXT PRIMARY KEY,type TEXT,payload_json TEXT);
    INSERT INTO orchestration_v2_projection_turn_items VALUES ('cold-only','user_message','{}');`);
  base.close();
  f.source.exec(`CREATE TABLE ardud_history_base_archive(filename TEXT);
    INSERT INTO ardud_history_base_archive VALUES ('${baseName}');`);
  const exporter = createReadonlyReplica(NodeSqlite, NodeFS, NodePath, f.options);
  cleanups.push(() => exporter.close());
  for (let i = 0; exporter.step(); i++) {
    if (i > 500) throw Error("base bootstrap did not converge");
  }
  const out = f.connect();
  expect(
    out.prepare("SELECT value FROM ardud_readonly_meta WHERE key='sequence'").get()?.value,
  ).toBe("50");
  expect(
    out.prepare("SELECT event_type FROM orchestration_events WHERE sequence=50").get()?.event_type,
  ).toBe("readonly.watermark");
  expect(
    out.prepare("SELECT turn_item_id FROM orchestration_v2_projection_turn_items").all(),
  ).toEqual([{ turn_item_id: "stop" }]);
});

test.each(["base", "delta"])(
  "a newer %s event fences live items against an older deletion journal",
  (location) => {
    const f = fixture();
    f.exporter.close();
    NodeFS.rmSync(f.options.replicaPath);
    f.source.exec(`DELETE FROM orchestration_events;
    CREATE TABLE ardud_history_archive_deletions(sequence INTEGER PRIMARY KEY,table_name TEXT,row_key TEXT,through_event_sequence INTEGER,archived_at TEXT);
    INSERT INTO ardud_history_archive_deletions VALUES (1,'orchestration_v2_projection_turn_items','stop',1,'now');`);
    const dir = NodePath.dirname(f.options.sourcePath);
    let archivePath: string | undefined;
    if (location === "base") {
      const filename = "statev2.pre-shrink-fence.sqlite";
      const base = new NodeSqlite.DatabaseSync(NodePath.join(dir, filename));
      base.exec(`CREATE TABLE orchestration_events(sequence INTEGER PRIMARY KEY,event_type TEXT,stream_id TEXT,payload_json TEXT,application_event_version INTEGER,aggregate_kind TEXT);
      CREATE INDEX thread_events ON orchestration_events(stream_id,sequence);
      INSERT INTO orchestration_events VALUES (2,'turn-item.updated','a','{}',2,'thread');`);
      base.close();
      f.source.exec(
        `CREATE TABLE ardud_history_base_archive(filename TEXT); INSERT INTO ardud_history_base_archive VALUES ('${filename}')`,
      );
    } else {
      archivePath = NodePath.join(dir, "archive.sqlite");
      const delta = new NodeSqlite.DatabaseSync(archivePath);
      delta.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE ardud_identity(identity TEXT PRIMARY KEY); INSERT INTO ardud_identity VALUES ('test');
      CREATE TABLE ardud_events(sequence INTEGER PRIMARY KEY,event_type TEXT,stream_id TEXT,payload_json TEXT,application_event_version INTEGER,aggregate_kind TEXT);
      CREATE INDEX thread_events ON ardud_events(stream_id,sequence);
      INSERT INTO ardud_events VALUES (2,'turn-item.updated','a','{}',2,'thread');`);
      delta.close();
      f.source.exec(
        "CREATE TABLE ardud_history_archive_identity(identity TEXT PRIMARY KEY); INSERT INTO ardud_history_archive_identity VALUES ('test')",
      );
    }
    const exporter = createReadonlyReplica(NodeSqlite, NodeFS, NodePath, {
      ...f.options,
      ...(archivePath ? { archivePath } : {}),
    });
    cleanups.push(() => exporter.close());
    for (let i = 0; exporter.step(); i++) {
      if (i > 500) throw Error("archived item fence did not converge");
    }
    const out = f.connect();
    expect(
      out.prepare("SELECT turn_item_id FROM orchestration_v2_projection_turn_items").all(),
    ).toEqual([{ turn_item_id: "stop" }]);
    expect(
      out.prepare("SELECT sequence FROM ardud_readonly_item_fences WHERE item_id='stop'").get()
        ?.sequence,
    ).toBe(2);
    expect(
      out
        .prepare("SELECT value FROM ardud_readonly_meta WHERE key='archive_deletion_sequence'")
        .get()?.value,
    ).toBe("1");
  },
);

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

test("replacing main rebuilds the replica from the new file", () => {
  const f = fixture();
  f.finish();
  f.exporter.close();
  const oldPath = NodePath.join(NodePath.dirname(f.options.sourcePath), "old-main.sqlite");
  f.source.close();
  // Keep the original inode allocated so this models the preserved offline base.
  NodeFS.renameSync(f.options.sourcePath, oldPath);
  NodeFS.copyFileSync(oldPath, f.options.sourcePath);
  const replacement = new NodeSqlite.DatabaseSync(f.options.sourcePath);
  cleanups.push(() => replacement.close());
  replacement.exec(`PRAGMA journal_mode=WAL;
    DELETE FROM orchestration_v2_projection_threads WHERE thread_id='c';
    INSERT INTO orchestration_v2_projection_threads VALUES ('new','{}');`);
  const exporter = createReadonlyReplica(NodeSqlite, NodeFS, NodePath, f.options);
  cleanups.push(() => exporter.close());
  const out = f.connect();
  expect(metaValue(out, "last_rebuild_reason")).toBe("source database was replaced");
  expect(metaValue(out, "ready")).toBe("0");
  for (let i = 0; exporter.step(); i++) {
    if (i > 500) throw new Error("export did not converge");
  }
  expect(metaValue(out, "ready")).toBe("1");
  expect(
    out
      .prepare("SELECT thread_id FROM orchestration_v2_projection_threads ORDER BY thread_id")
      .all(),
  ).toEqual([{ thread_id: "a" }, { thread_id: "b" }, { thread_id: "new" }]);
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

const HOUR = 60 * 60 * 1000;

/** Stored sequence 5; then the source loses events 3..5 (e.g. restored from a backup). */
function regressedFixture() {
  const f = fixture();
  f.source.exec(`INSERT INTO orchestration_events(event_type,stream_id,payload_json) VALUES
    ('thread.metadata-updated','a','{}'),('thread.metadata-updated','a','{}'),
    ('thread.metadata-updated','a','{}'),('thread.metadata-updated','a','{}')`);
  f.finish();
  f.exporter.close();
  return f;
}
const openExporter = (f: ReturnType<typeof fixture>) => {
  const exporter = createReadonlyReplica(NodeSqlite, NodeFS, NodePath, f.options);
  cleanups.push(() => exporter.close());
  return exporter;
};
const drive = (exporter: ReturnType<typeof createReadonlyReplica>) => {
  for (let i = 0; exporter.step(); i++) {
    if (i > 500) throw new Error("export did not converge");
  }
};

test("a regression that persists after a rebuild does not rebuild again inside the window", () => {
  let now = Date.parse("2026-11-10T10:00:00.000Z");
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const f = regressedFixture();
  f.source.exec("DELETE FROM orchestration_events WHERE sequence>=3");
  drive(openExporter(f));
  const out = f.connect();
  expect(metaValue(out, "last_rebuild_reason")).toBe("source event sequence regressed");
  expect(metaValue(out, "last_rebuild_at")).toBe("2026-11-10T10:00:00.000Z");
  expect(metaValue(out, "ready")).toBe("1");
  // It happens again an hour later: no second 4.5 GB re-bootstrap.
  now += HOUR;
  f.source.exec("DELETE FROM orchestration_events WHERE sequence>=2");
  let held: (Error & { code?: string; notify?: boolean }) | undefined;
  try {
    openExporter(f);
  } catch (error) {
    held = error as typeof held;
  }
  expect(held?.code).toBe("READONLY_REBUILD_HELD");
  expect(held?.notify).toBe(true);
  expect(held?.message).toContain("source event sequence regressed");
  expect(metaValue(out, "ready")).toBe("0");
  expect(metaValue(out, "last_error")).toContain("Automatic rebuild held back");
  expect(metaValue(out, "rebuild_held_until")).toBe("2026-11-10T16:00:00.000Z");
  expect(metaValue(out, "last_rebuild_at")).toBe("2026-11-10T10:00:00.000Z");
  // Nothing was dropped: the old rows are still there, just not published.
  expect(
    out.prepare("SELECT count(*) AS n FROM orchestration_v2_projection_threads").get()?.n,
  ).toBe(3);
  // The window is in meta, so a worker or server restart does not reset it,
  // and the repeat inside the notice interval is quiet.
  now += 15_000;
  expect(() => openExporter(f)).toThrow(
    expect.objectContaining({ code: "READONLY_REBUILD_HELD", notify: false }),
  );
  now += HOUR;
  expect(() => openExporter(f)).toThrow(
    expect.objectContaining({ code: "READONLY_REBUILD_HELD", notify: true }),
  );
  expect(metaValue(out, "last_rebuild_at")).toBe("2026-11-10T10:00:00.000Z");
});

test("after the backoff window the same reason may rebuild once more", () => {
  let now = Date.parse("2026-11-10T10:00:00.000Z");
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const f = regressedFixture();
  f.source.exec("DELETE FROM orchestration_events WHERE sequence>=3");
  drive(openExporter(f));
  now += HOUR;
  f.source.exec("DELETE FROM orchestration_events WHERE sequence>=2");
  expect(() => openExporter(f)).toThrow("Automatic rebuild held back");
  now = Date.parse("2026-11-10T16:00:00.001Z");
  const exporter = openExporter(f);
  const out = f.connect();
  expect(metaValue(out, "last_rebuild_at")).toBe("2026-11-10T16:00:00.001Z");
  expect(metaValue(out, "rebuild_held_until")).toBeUndefined();
  drive(exporter);
  expect(metaValue(out, "ready")).toBe("1");
  expect(metaValue(out, "sequence")).toBe("1");
  // ...and that rebuild starts a new window.
  exporter.close();
  now += HOUR;
  f.source.exec("DELETE FROM orchestration_events");
  expect(() => openExporter(f)).toThrow("Automatic rebuild held back");
});

test("a different rebuild reason is not held back by the window", () => {
  let now = Date.parse("2026-11-10T10:00:00.000Z");
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const f = regressedFixture();
  f.source.exec("DELETE FROM orchestration_events WHERE sequence>=3");
  drive(openExporter(f));
  now += HOUR;
  f.source.exec("ALTER TABLE scheduled_tasks ADD COLUMN extra TEXT");
  drive(openExporter(f));
  const out = f.connect();
  expect(metaValue(out, "last_rebuild_reason")).toBe("source schema changed: scheduled_tasks");
  expect(metaValue(out, "ready")).toBe("1");
});

test("a rebuild pages the source exactly like a first bootstrap", () => {
  const f = fixture();
  for (let i = 0; i < 9; i++)
    f.source
      .prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?,'{}')")
      .run(`t${i}`);
  f.finish();
  const before = f.connect();
  const epoch = metaValue(before, "last_rebuild_at");
  const watermark = metaValue(before, "updated_at");
  f.exporter.close();
  f.source.exec("DELETE FROM orchestration_events");
  const exporter = openExporter(f);
  const out = f.connect();
  expect(metaValue(out, "ready")).toBe("0");
  expect(metaValue(out, "last_rebuild_at")).not.toBe(epoch);
  expect(metaValue(out, "lineage_repair_watermark")).toBe(watermark);
  const count = () =>
    Number(out.prepare("SELECT count(*) AS n FROM orchestration_v2_projection_threads").get()?.n);
  expect(count()).toBe(0);
  let steps = 0;
  let previous = 0;
  while (exporter.step()) {
    // One bounded page per step (batch size 2 here, 100 in production),
    // committed on its own: the same page size and the same worker yield
    // between steps as the normal catchup.
    expect(count() - previous).toBeLessThanOrEqual(2);
    previous = count();
    if (++steps > 500) throw new Error("export did not converge");
  }
  expect(count()).toBe(12);
  expect(steps).toBeGreaterThanOrEqual(6);
  expect(metaValue(out, "lineage_repair_watermark")).toBe(metaValue(out, "updated_at"));
});

test("a busy source cannot hold a cycle open; updated_at tracks what was confirmed", () => {
  // Slow-step fixture: every step takes 3 s and the source commits a new event
  // before every step, as on 8 Nov (~34 events/s against 10 ms step gaps).
  // Before 2026-11-10 the publish step went back for another lap whenever the
  // source had moved, so this cycle never published (readers: "stale").
  const f = fixture();
  for (let i = 0; i < 12; i++)
    f.source.prepare("INSERT INTO scheduled_tasks VALUES (?,'a')").run(`task${i}`);
  let now = Date.parse("2026-11-08T22:00:00.000Z");
  vi.spyOn(Date, "now").mockImplementation(() => now);
  f.finish();
  const out = f.connect();
  const bump = f.source.prepare(
    "INSERT INTO orchestration_events(event_type,stream_id,payload_json) VALUES ('thread.metadata-updated','a','{\"id\":\"a\"}')",
  );
  let n = 0;
  let maxAge = 0;
  let longestCycle = 0;
  let oldestPublish = 0;
  for (let cycle = 0; cycle < 4; cycle++) {
    now += 15_000; // the worker's idle gap between cycles
    const cycleStart = now;
    let steps = 0;
    let auxStartedBy = Infinity;
    for (;;) {
      maxAge = Math.max(maxAge, now - Date.parse(String(metaValue(out, "updated_at"))));
      expect(metaValue(out, "ready")).toBe("1");
      f.source
        .prepare(
          "UPDATE orchestration_v2_projection_threads SET payload_json=? WHERE thread_id='a'",
        )
        .run(JSON.stringify({ n: ++n }));
      bump.run();
      now += 3_000;
      if (steps === 0) auxStartedBy = now;
      if (!f.exporter.step()) break;
      if (++steps > 100) throw new Error("a busy source held the cycle open");
    }
    const updated = Date.parse(String(metaValue(out, "updated_at")));
    longestCycle = Math.max(longestCycle, now - cycleStart);
    oldestPublish = Math.max(oldestPublish, now - updated);
    // Honest: no later than the publish snapshot, and no earlier than the start
    // of the small-table copy (not the start of the cycle, as before).
    expect(updated).toBeLessThanOrEqual(now);
    expect(updated).toBeGreaterThanOrEqual(auxStartedBy);
    // Everything committed before the publish snapshot is in this generation.
    expect(metaValue(out, "sequence")).toBe(
      String(f.source.prepare("SELECT max(sequence) AS n FROM orchestration_events").get()?.n),
    );
    expect(
      out
        .prepare("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id='a'")
        .get()?.payload_json,
    ).toBe(JSON.stringify({ n }));
  }
  // Bounded by the cycle itself, never by how busy the source is: the worst
  // age a reader saw is one publish's own age + the idle gap + one cycle.
  expect(longestCycle).toBeLessThan(100 * 3_000);
  expect(maxAge).toBeLessThanOrEqual(oldestPublish + 15_000 + longestCycle);
});

test("a publish backlog beyond the drain budget keeps its pages and converges", () => {
  const f = fixture();
  f.finish();
  const out = f.connect();
  const published = metaValue(out, "updated_at");
  // Fix this cycle's target, then let the source run far ahead of it.
  expect(f.exporter.step()).toBe(true);
  const add = f.source.prepare(
    "INSERT INTO orchestration_events(event_type,stream_id,payload_json) VALUES ('thread.metadata-updated','a','{}')",
  );
  for (let i = 0; i < 200; i++) add.run(); // 100 pages at batch size 2 > 20-page budget
  let steps = 0;
  while (f.exporter.step()) {
    expect(metaValue(out, "ready")).toBe("1");
    expect(metaValue(out, "updated_at")).toBe(published);
    if (++steps > 500) throw new Error("export did not converge");
  }
  expect(metaValue(out, "sequence")).toBe("201");
  expect(out.prepare("SELECT max(sequence) AS n FROM orchestration_events").get()?.n).toBe(201);
});

test("identical rows are not rewritten into the replica", () => {
  const f = fixture();
  f.source.exec("INSERT INTO ardud_kanban_cards VALUES ('card','a','{\"big\":true}')");
  f.finish();
  // Test-only probe on the replica copy: count real row updates.
  const probe = new NodeSqlite.DatabaseSync(f.options.replicaPath);
  cleanups.push(() => probe.close());
  probe.exec(`CREATE TABLE probe_updates (id TEXT);
    CREATE TRIGGER probe_card_update AFTER UPDATE ON ardud_kanban_cards
    BEGIN INSERT INTO probe_updates VALUES (new.id); END;`);
  const updates = () => Number(probe.prepare("SELECT count(*) AS n FROM probe_updates").get()?.n);
  f.finish(); // a full cycle re-reads every small table
  expect(updates()).toBe(0);
  f.source.exec("UPDATE ardud_kanban_cards SET json='{\"big\":false}'");
  f.finish();
  expect(updates()).toBe(1);
  expect(f.connect().prepare("SELECT json FROM ardud_kanban_cards").get()?.json).toBe(
    '{"big":false}',
  );
});

test("incomplete redaction prevents startup and refresh until maintenance completes", () => {
  const f = fixture();
  f.source.exec(
    "CREATE TABLE ardud_thread_redaction_recovery(thread_id TEXT PRIMARY KEY,item_id TEXT,pending INTEGER); INSERT INTO ardud_thread_redaction_recovery VALUES('a','tool',1)",
  );
  expect(() => f.exporter.step()).toThrow("incomplete redaction maintenance");
  expect(() => f.restart()).toThrow("incomplete redaction maintenance");
  f.source.exec("UPDATE ardud_thread_redaction_recovery SET pending=0");
  f.restart();
  f.finish();
});

test.each(["primary", "replica"] as const)("annotates actual corrupt %s export handles", (role) => {
  const f = fixture();
  f.exporter.close();
  const file =
    role === "primary"
      ? NodePath.join(NodePath.dirname(f.options.sourcePath), "bad-source.sqlite")
      : NodePath.join(NodePath.dirname(f.options.sourcePath), "bad-replica.sqlite");
  NodeFS.writeFileSync(file, "bad database".repeat(1024));
  try {
    createReadonlyReplica(NodeSqlite, NodeFS, NodePath, {
      ...f.options,
      ...(role === "primary" ? { sourcePath: file } : { replicaPath: file }),
    });
    throw new Error("expected corruption");
  } catch (error) {
    expect(error).toMatchObject({ errcode: 26, sqliteFile: file, sqliteRole: role });
  }
});

test("lineage repair revision changes only for eventless reconciliation", () => {
  const f = fixture(100);
  f.source.exec(
    "INSERT INTO orchestration_v2_projection_provider_threads(provider_thread_id,payload_json) VALUES ('pt','{}')",
  );
  f.finish();
  const out = f.connect();
  const original = Number(metaValue(out, "lineage_repair_revision"));
  expect(metaValue(out, "lineage_repair_watermark")).toBe(metaValue(out, "updated_at"));
  f.source
    .exec(`UPDATE orchestration_v2_projection_threads SET payload_json='{"title":"event"}' WHERE thread_id='a';
    INSERT INTO orchestration_events VALUES(2,'thread.updated','a','{}');`);
  for (let i = 0; i < 18; i++) f.finish();
  expect(Number(metaValue(out, "lineage_repair_revision"))).toBe(original);

  // Neither repair advances orchestration sequence; both must fence readers.
  f.source
    .exec(`UPDATE orchestration_v2_projection_threads SET payload_json='{"lineage":{"parentThreadId":"a"}}' WHERE thread_id='b';
    UPDATE orchestration_v2_projection_provider_threads SET payload_json='{"nativeThreadRef":{"nativeId":"repaired"}}' WHERE provider_thread_id='pt';`);
  for (let i = 0; i < 18; i++) f.finish();
  const repaired = Number(metaValue(out, "lineage_repair_revision"));
  expect(repaired).toBe(original + 2);
  expect(metaValue(out, "lineage_repair_watermark")).toBe(metaValue(out, "updated_at"));
  for (let i = 0; i < 18; i++) f.finish();
  expect(Number(metaValue(out, "lineage_repair_revision"))).toBe(repaired);
  f.source.exec("DELETE FROM orchestration_v2_projection_threads WHERE thread_id='b'");
  for (let i = 0; i < 18; i++) f.finish();
  expect(Number(metaValue(out, "lineage_repair_revision"))).toBe(repaired + 1);
});

test.each([
  {
    name: "direct parent",
    table: "orchestration_v2_projection_threads",
    key: "thread_id",
    id: "b",
    eventPayload: { lineage: { parentThreadId: "c" } },
    payload: { lineage: { parentThreadId: "a" } },
    event: "thread.updated",
  },
  {
    name: "root hint",
    table: "orchestration_v2_projection_threads",
    key: "thread_id",
    id: "b",
    eventPayload: { lineage: { rootThreadId: "c" } },
    payload: { lineage: { rootThreadId: "a" } },
    event: "thread.updated",
  },
  {
    name: "provider native binding",
    table: "orchestration_v2_projection_provider_threads",
    key: "provider_thread_id",
    id: "pt",
    eventPayload: { nativeThreadRef: { nativeId: "event-native" } },
    payload: { nativeThreadRef: { nativeId: "repaired" } },
    event: "provider-thread.updated",
  },
])(
  "$name repairs fence readers, event catchup does not",
  ({ table, key, id, payload, eventPayload, event }) => {
    const f = fixture(100);
    f.source.exec(
      "INSERT INTO orchestration_v2_projection_provider_threads(provider_thread_id,payload_json) VALUES ('pt','{}')",
    );
    f.finish();
    const out = f.connect();
    const revision = Number(metaValue(out, "lineage_repair_revision"));
    const update = f.source.prepare(`UPDATE ${table} SET payload_json=? WHERE ${key}=?`);
    const read = out.prepare(`SELECT payload_json FROM ${table} WHERE ${key}=?`);
    const caughtUpPayload = JSON.stringify(eventPayload);
    update.run(caughtUpPayload, id);
    f.source
      .prepare("INSERT INTO orchestration_events VALUES (2,?,?,?)")
      .run(event, id, JSON.stringify({ id }));
    for (let i = 0; i < 18; i++) f.finish();
    expect(read.get(id)?.payload_json).toBe(caughtUpPayload);
    expect(Number(metaValue(out, "lineage_repair_revision"))).toBe(revision);

    const repairedPayload = JSON.stringify(payload);
    update.run(repairedPayload, id);
    for (let i = 0; i < 18; i++) f.finish();
    expect(read.get(id)?.payload_json).toBe(repairedPayload);
    expect(Number(metaValue(out, "lineage_repair_revision"))).toBe(revision + 1);
    expect(metaValue(out, "lineage_repair_watermark")).toBe(metaValue(out, "updated_at"));
    for (let i = 0; i < 18; i++) f.finish();
    expect(Number(metaValue(out, "lineage_repair_revision"))).toBe(revision + 1);

    f.source.prepare(`DELETE FROM ${table} WHERE ${key}=?`).run(id);
    for (let i = 0; i < 18; i++) f.finish();
    expect(read.get(id)).toBeUndefined();
    expect(Number(metaValue(out, "lineage_repair_revision"))).toBe(revision + 2);
  },
);

test.each(["reconcile", "identity"] as const)(
  "%s copies timestamp/title/status repairs without invalidating lineage",
  (path) => {
    const f = fixture(100);
    let now = Date.parse("2026-11-13T12:00:00Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    f.source.exec(`INSERT INTO orchestration_v2_projection_provider_threads VALUES ('pt','{}','a');
      INSERT INTO orchestration_v2_projection_subagents(subagent_id,payload_json) VALUES ('sa','{}');`);
    f.finish();
    const out = f.connect();
    const revision = metaValue(out, "lineage_repair_revision");
    for (const [table, key, id, event] of [
      ["threads", "thread_id", "b", "thread.created"],
      ["provider_threads", "provider_thread_id", "pt", "provider-thread.updated"],
      ["subagents", "subagent_id", "sa", "subagent.updated"],
    ]) {
      for (const payload of [
        { updatedAt: "2026-11-13T12:00:01Z" },
        { title: "renamed" },
        { status: "running" },
        {
          lineage: { parentThreadId: null, rootThreadId: null },
          nativeThreadRef: { nativeId: null },
          nativeTaskRef: { nativeId: null },
        },
      ]) {
        const json = JSON.stringify(payload);
        f.source
          .prepare(`UPDATE orchestration_v2_projection_${table} SET payload_json=? WHERE ${key}=?`)
          .run(json, id!);
        if (path === "identity") {
          f.source
            .prepare(
              "INSERT INTO orchestration_events(event_type,stream_id,payload_json) VALUES (?,?,?)",
            )
            .run(event!, id!, JSON.stringify({ id }));
          now += 1_000;
          f.exporter.pollIdentities();
        } else {
          for (let i = 0; i < 18; i++) f.finish();
        }
        expect(
          out
            .prepare(`SELECT payload_json FROM orchestration_v2_projection_${table} WHERE ${key}=?`)
            .get(id!)?.payload_json,
        ).toBe(json);
        expect(metaValue(out, "lineage_repair_revision")).toBe(revision);
        expect(metaValue(out, "lineage_repair_watermark")).toBe(metaValue(out, "updated_at"));
      }
    }
  },
);

const lineageRepairs = [
  {
    name: "parent added",
    table: "threads",
    key: "thread_id",
    id: "b",
    set: `payload_json='{"lineage":{"parentThreadId":"a"}}'`,
  },
  {
    name: "parent changed",
    table: "threads",
    key: "thread_id",
    id: "b",
    set: `payload_json='{"lineage":{"parentThreadId":"c"}}'`,
  },
  { name: "parent removed", table: "threads", key: "thread_id", id: "b", set: `payload_json='{}'` },
  {
    name: "root added",
    table: "threads",
    key: "thread_id",
    id: "b",
    set: `payload_json='{"lineage":{"rootThreadId":"a"}}'`,
  },
  {
    name: "root changed",
    table: "threads",
    key: "thread_id",
    id: "b",
    set: `payload_json='{"lineage":{"rootThreadId":"c"}}'`,
  },
  {
    name: "root removed",
    table: "threads",
    key: "thread_id",
    id: "b",
    set: `payload_json='{"lineage":{"rootThreadId":null}}'`,
  },
  {
    name: "provider owner added",
    table: "provider_threads",
    key: "provider_thread_id",
    id: "pt",
    set: "thread_id='a'",
  },
  {
    name: "provider owner changed",
    table: "provider_threads",
    key: "provider_thread_id",
    id: "pt",
    set: "thread_id='b'",
  },
  {
    name: "provider owner removed",
    table: "provider_threads",
    key: "provider_thread_id",
    id: "pt",
    set: "thread_id=NULL",
  },
  {
    name: "native id added",
    table: "provider_threads",
    key: "provider_thread_id",
    id: "pt",
    set: `payload_json='{"nativeThreadRef":{"nativeId":"native"}}'`,
  },
  {
    name: "native id changed",
    table: "provider_threads",
    key: "provider_thread_id",
    id: "pt",
    set: `payload_json='{"nativeThreadRef":{"nativeId":"other"}}'`,
  },
  {
    name: "native id removed",
    table: "provider_threads",
    key: "provider_thread_id",
    id: "pt",
    set: `payload_json='{}'`,
  },
];

test.each(lineageRepairs)(
  "$name repairs on reconcile and touches on fast-lane publication",
  ({ name, table, key, id, set }) => {
    for (const path of ["reconcile", "identity"]) {
      const f = fixture(100);
      let now = Date.parse("2026-11-13T12:00:00Z");
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const initial = name.endsWith("added")
        ? "{}"
        : table === "threads"
          ? JSON.stringify({
              lineage: name.startsWith("parent") ? { parentThreadId: "a" } : { rootThreadId: "a" },
            })
          : JSON.stringify({ nativeThreadRef: { nativeId: "native" } });
      f.source
        .prepare(
          "UPDATE orchestration_v2_projection_threads SET payload_json=? WHERE thread_id='b'",
        )
        .run(initial);
      f.source
        .prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES ('pt',?,?)")
        .run(initial, name.endsWith("added") ? null : "a");
      f.finish();
      f.exporter.pollIdentities();
      const out = f.connect();
      const revision = Number(metaValue(out, "lineage_repair_revision"));
      const touch = Number(metaValue(out, "lineage_touch_revision"));
      f.source.exec(`UPDATE orchestration_v2_projection_${table} SET ${set} WHERE ${key}='${id}'`);
      if (path === "identity") {
        f.source
          .prepare(
            "INSERT INTO orchestration_events(event_type,stream_id,payload_json) VALUES (?,?,?)",
          )
          .run(
            table === "threads" ? "thread.created" : "provider-thread.updated",
            id,
            JSON.stringify({ id }),
          );
        now += 1_000;
        f.exporter.pollIdentities();
      } else {
        for (let i = 0; i < 18; i++) f.finish();
      }
      expect(Number(metaValue(out, "lineage_repair_revision"))).toBe(
        revision + Number(path === "reconcile"),
      );
      expect(metaValue(out, "lineage_repair_watermark")).toBe(metaValue(out, "updated_at"));
      expect(Number(metaValue(out, "lineage_touch_revision"))).toBe(
        touch + Number(path === "identity"),
      );
      if (path === "identity")
        expect(
          out
            .prepare("SELECT kind FROM ardud_readonly_lineage_touches WHERE revision=?")
            .get(touch + 1)?.kind,
        ).toBe("update");
      for (let i = 0; i < 18; i++) f.finish();
      expect(Number(metaValue(out, "lineage_repair_revision"))).toBe(
        revision + Number(path === "reconcile"),
      );
    }
  },
);

test.each([
  { table: "threads", key: "thread_id" },
  { table: "provider_threads", key: "provider_thread_id" },
  { table: "subagents", key: "subagent_id" },
])(
  "$table inserts touch lineage; key replacement and deletion repair existing rows",
  ({ table, key }) => {
    const f = fixture(100);
    let now = Date.parse("2026-11-13T12:00:00Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    f.finish();
    const out = f.connect();
    let revision = Number(metaValue(out, "lineage_repair_revision"));
    f.source.exec(
      `INSERT INTO orchestration_v2_projection_${table}(${key},payload_json) VALUES ('new','{}')`,
    );
    now += 1_000;
    f.exporter.pollIdentities();
    expect(Number(metaValue(out, "lineage_repair_revision"))).toBe(revision);
    for (let i = 0; i < 18; i++) f.finish();
    expect(Number(metaValue(out, "lineage_repair_revision"))).toBe(revision);
    f.source.exec(
      `UPDATE orchestration_v2_projection_${table} SET ${key}='replacement' WHERE ${key}='new'`,
    );
    // The reused source rowid needs its creation/binding event to reach the fast lane.
    f.source
      .prepare("INSERT INTO orchestration_events(event_type,stream_id,payload_json) VALUES (?,?,?)")
      .run(
        table === "threads"
          ? "thread.created"
          : table === "subagents"
            ? "subagent.updated"
            : "provider-thread.updated",
        "replacement",
        '{"id":"replacement"}',
      );
    now += 1_000;
    f.exporter.pollIdentities();
    expect(Number(metaValue(out, "lineage_repair_revision"))).toBe(revision);
    for (let i = 0; i < 18; i++) f.finish();
    expect(
      out.prepare(`SELECT 1 FROM orchestration_v2_projection_${table} WHERE ${key}='new'`).get(),
    ).toBeUndefined();
    expect(Number(metaValue(out, "lineage_repair_revision"))).toBe(++revision);
    f.source.exec(`DELETE FROM orchestration_v2_projection_${table} WHERE ${key}='replacement'`);
    for (let i = 0; i < 18; i++) f.finish();
    expect(Number(metaValue(out, "lineage_repair_revision"))).toBe(++revision);
    expect(metaValue(out, "lineage_repair_watermark")).toBe(metaValue(out, "updated_at"));
  },
);

const subagentRepairs = [
  { name: "parent added", before: "thread_id=NULL", after: "thread_id='c'" },
  { name: "parent changed", before: "thread_id='a'", after: "thread_id='c'" },
  { name: "parent removed", before: "thread_id='a'", after: "thread_id=NULL" },
  { name: "child added", before: "child_thread_id=NULL", after: "child_thread_id='c'" },
  { name: "child changed", before: "child_thread_id='b'", after: "child_thread_id='c'" },
  { name: "child removed", before: "child_thread_id='b'", after: "child_thread_id=NULL" },
  {
    name: "native task added",
    before: `payload_json='{}'`,
    after: `payload_json='{"nativeTaskRef":{"nativeId":"new-task"}}'`,
  },
  {
    name: "native task changed",
    before: `payload_json='{"nativeTaskRef":{"nativeId":"old-task"}}'`,
    after: `payload_json='{"nativeTaskRef":{"nativeId":"new-task"}}'`,
  },
  {
    name: "native task removed",
    before: `payload_json='{"nativeTaskRef":{"nativeId":"old-task"}}'`,
    after: `payload_json='{"nativeTaskRef":{"nativeId":null}}'`,
  },
];

test.each(subagentRepairs)(
  "subagent $name repairs on reconcile and touches on fast-lane publication",
  ({ before, after }) => {
    for (const path of ["reconcile", "identity"]) {
      const f = fixture(100);
      let now = Date.parse("2026-11-13T12:00:00Z");
      vi.spyOn(Date, "now").mockImplementation(() => now);
      f.source.exec(`INSERT INTO orchestration_v2_projection_subagents VALUES ('sa','{}','a','b');
      UPDATE orchestration_v2_projection_subagents SET ${before} WHERE subagent_id='sa'`);
      f.finish();
      f.exporter.pollIdentities();
      const out = f.connect();
      const revision = Number(metaValue(out, "lineage_repair_revision"));
      const touch = Number(metaValue(out, "lineage_touch_revision"));
      const sequence = metaValue(out, "sequence");
      f.source.exec(
        `UPDATE orchestration_v2_projection_subagents SET ${after} WHERE subagent_id='sa'`,
      );
      if (path === "identity") {
        f.source.exec(
          `INSERT INTO orchestration_events(event_type,stream_id,payload_json) VALUES ('subagent.updated','a','{"id":"sa"}')`,
        );
        now += 1_000;
        f.exporter.pollIdentities();
        expect(metaValue(out, "sequence")).toBe(sequence);
      } else {
        for (let i = 0; i < 18; i++) f.finish();
      }
      expect(
        out
          .prepare(
            "SELECT subagent_id,thread_id,child_thread_id,payload_json FROM orchestration_v2_projection_subagents WHERE subagent_id='sa'",
          )
          .get(),
      ).toEqual(
        f.source
          .prepare(
            "SELECT subagent_id,thread_id,child_thread_id,payload_json FROM orchestration_v2_projection_subagents WHERE subagent_id='sa'",
          )
          .get(),
      );
      expect(Number(metaValue(out, "lineage_repair_revision"))).toBe(
        revision + Number(path === "reconcile"),
      );
      expect(metaValue(out, "lineage_repair_watermark")).toBe(metaValue(out, "updated_at"));
      expect(Number(metaValue(out, "lineage_touch_revision"))).toBe(
        touch + Number(path === "identity"),
      );
      if (path === "identity")
        expect(
          out
            .prepare("SELECT kind FROM ardud_readonly_lineage_touches WHERE revision=?")
            .get(touch + 1)?.kind,
        ).toBe("update");
      for (let i = 0; i < 18; i++) f.finish();
      expect(Number(metaValue(out, "lineage_repair_revision"))).toBe(
        revision + Number(path === "reconcile"),
      );
    }
  },
);

test("a subagent publication between traversal and verification advances the touch cursor", () => {
  const f = fixture(100);
  let now = Date.parse("2026-11-13T12:00:00Z");
  vi.spyOn(Date, "now").mockImplementation(() => now);
  f.source.exec(
    `INSERT INTO orchestration_v2_projection_subagents VALUES ('sa','{"nativeTaskRef":{"nativeId":"old-task"}}','a','b')`,
  );
  f.finish();
  const traversal = f.connect();
  const verification = f.connect();
  const task = (db: NodeSqlite.DatabaseSync) =>
    db
      .prepare(
        "SELECT json_extract(payload_json,'$.nativeTaskRef.nativeId') AS task FROM orchestration_v2_projection_subagents WHERE thread_id='a'",
      )
      .get()?.task;
  traversal.exec("BEGIN");
  const revision = Number(metaValue(traversal, "lineage_repair_revision"));
  const touch = Number(metaValue(traversal, "lineage_touch_revision"));
  const sequence = metaValue(traversal, "sequence");
  const watermark = metaValue(traversal, "updated_at");
  expect(task(traversal)).toBe("old-task");
  f.source
    .exec(`UPDATE orchestration_v2_projection_subagents SET payload_json='{"nativeTaskRef":{"nativeId":"new-task"}}' WHERE subagent_id='sa';
    INSERT INTO orchestration_events(event_type,stream_id,payload_json) VALUES ('subagent.updated','a','{"id":"sa","threadId":"a","childThreadId":"b","nativeTaskRef":{"nativeId":"new-task"}}')`);
  now += 1_000;
  f.exporter.pollIdentities();
  // Final verification uses a fresh snapshot, while traversal still sees old aliases.
  expect(task(traversal)).toBe("old-task");
  expect(task(verification)).toBe("new-task");
  expect(metaValue(verification, "sequence")).toBe(sequence);
  expect(metaValue(verification, "updated_at")).toBe(watermark);
  expect(Number(metaValue(verification, "lineage_repair_revision"))).toBe(revision);
  expect(metaValue(verification, "lineage_repair_watermark")).toBe(watermark);
  expect(Number(metaValue(verification, "lineage_touch_revision"))).toBe(touch + 1);
  traversal.exec("ROLLBACK");
  expect(task(traversal)).toBe("new-task");

  // Copying a status update with the same identity must not invalidate the retry.
  f.source
    .exec(`UPDATE orchestration_v2_projection_subagents SET payload_json='{"nativeTaskRef":{"nativeId":"new-task"},"status":"completed","updatedAt":"2026-11-13T12:00:02Z"}' WHERE subagent_id='sa';
    INSERT INTO orchestration_events(event_type,stream_id,payload_json) VALUES ('subagent.updated','a','{"id":"sa"}')`);
  now += 1_000;
  f.exporter.pollIdentities();
  expect(Number(metaValue(verification, "lineage_repair_revision"))).toBe(revision);
  expect(Number(metaValue(verification, "lineage_touch_revision"))).toBe(touch + 1);
  expect(task(verification)).toBe("new-task");
  expect(metaValue(verification, "sequence")).toBe(sequence);
});

test("identity hydration touches changed thread lineage but ignores thread and subagent status", () => {
  const f = fixture(100);
  let now = Date.parse("2026-11-13T12:00:00Z");
  vi.spyOn(Date, "now").mockImplementation(() => now);
  f.source.exec("INSERT INTO orchestration_v2_projection_subagents VALUES ('sa','{}','a','b')");
  f.restart();
  f.finish();
  const out = f.connect();
  const revision = Number(metaValue(out, "lineage_repair_revision"));
  const touch = Number(metaValue(out, "lineage_touch_revision"));
  for (const [index, payload] of [
    '{"status":"running"}',
    '{"lineage":{"parentThreadId":"a"}}',
  ].entries()) {
    f.source
      .prepare("UPDATE orchestration_v2_projection_threads SET payload_json=? WHERE thread_id='b'")
      .run(payload);
    f.source
      .prepare(
        "UPDATE orchestration_v2_projection_subagents SET payload_json=? WHERE subagent_id='sa'",
      )
      .run(JSON.stringify({ status: index }));
    f.source.exec(
      `INSERT INTO orchestration_events(event_type,stream_id,payload_json) VALUES ('subagent.updated','a','{"id":"sa"}')`,
    );
    now += 1_000;
    f.exporter.pollIdentities();
    expect(
      out
        .prepare("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id='b'")
        .get()?.payload_json,
    ).toBe(payload);
    expect(Number(metaValue(out, "lineage_repair_revision"))).toBe(revision);
    expect(Number(metaValue(out, "lineage_touch_revision"))).toBe(touch + index);
    expect(metaValue(out, "lineage_repair_watermark")).toBe(metaValue(out, "updated_at"));
  }
  expect(f.exporter.takeMetrics().identityRows).toBeGreaterThanOrEqual(4);
});

test("identity publishes within one second during a long auxiliary sweep without publishing its generation", () => {
  const f = fixture();
  let now = Date.parse("2026-11-13T12:00:00Z");
  vi.spyOn(Date, "now").mockImplementation(() => now);
  f.finish();
  const out = f.connect();
  const stamp = metaValue(out, "updated_at");
  const sequence = metaValue(out, "sequence");
  for (let i = 0; i < 200; i++)
    f.source.prepare("INSERT INTO scheduled_tasks VALUES (?,'a')").run(`task${i}`);
  f.exporter.step();
  f.source.exec(`INSERT INTO orchestration_v2_projection_threads VALUES ('child','{}');
    INSERT INTO orchestration_v2_projection_provider_threads(provider_thread_id,payload_json) VALUES ('binding','{}');
    INSERT INTO orchestration_v2_projection_subagents(subagent_id,payload_json) VALUES ('delegate','{}');`);
  now += 1_000;
  expect(f.exporter.step()).toBe(true);
  for (const [table, key, id] of [
    ["threads", "thread_id", "child"],
    ["provider_threads", "provider_thread_id", "binding"],
    ["subagents", "subagent_id", "delegate"],
  ])
    expect(
      out
        .prepare(`SELECT 1 AS found FROM orchestration_v2_projection_${table} WHERE ${key}=?`)
        .get(id!),
    ).toEqual({ found: 1 });
  expect(metaValue(out, "ready")).toBe("1");
  expect(metaValue(out, "updated_at")).toBe(stamp);
  expect(metaValue(out, "sequence")).toBe(sequence);
  expect(out.prepare("SELECT count(*) AS n FROM scheduled_tasks").get()?.n).toBe(0);
  expect(f.exporter.takeMetrics().identityRows).toBe(3);
  f.finish();
  expect(out.prepare("SELECT count(*) AS n FROM scheduled_tasks").get()?.n).toBe(200);
});

test("identity arrival interrupts event catchup without exposing partial run or Stop state", () => {
  const f = fixture(1);
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  f.finish();
  const out = f.connect();
  const stamp = metaValue(out, "updated_at");
  f.source.exec(`INSERT INTO orchestration_v2_projection_runs VALUES ('new-run','a','{}');
    INSERT INTO orchestration_events VALUES (2,'run.created','a','{"id":"new-run"}');
    INSERT INTO orchestration_events VALUES (3,'turn-item.updated','a','{}');`);
  f.exporter.takeMetrics();
  for (let i = 0; i < 20; i++) {
    f.exporter.step();
    if (f.exporter.takeMetrics().phaseSteps.eventCatchup) break;
    if (i === 19) throw new Error("catchup never started");
  }
  f.source.exec("INSERT INTO orchestration_v2_projection_threads VALUES ('child','{}')");
  now += 1_000;
  expect(f.exporter.step()).toBe(true);
  expect(
    out.prepare("SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id='child'").get(),
  ).toBeDefined();
  expect(
    out.prepare("SELECT 1 FROM orchestration_v2_projection_runs WHERE run_id='new-run'").get(),
  ).toBeUndefined();
  expect(metaValue(out, "updated_at")).toBe(stamp);
  f.finish();
  expect(
    out.prepare("SELECT 1 FROM orchestration_v2_projection_runs WHERE run_id='new-run'").get(),
  ).toBeDefined();
});

test("identity cursors survive a worker restart and a later native binding update", () => {
  const f = fixture();
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  f.finish();
  f.exporter.pollIdentities();
  f.source.exec(`INSERT INTO orchestration_v2_projection_threads VALUES ('child','{}');
    INSERT INTO orchestration_v2_projection_provider_threads(provider_thread_id,payload_json) VALUES ('binding','{}');`);
  f.restart();
  const out = f.connect();
  expect(f.exporter.pollIdentities()).toBe(true);
  expect(
    out.prepare("SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id='child'").get(),
  ).toBeDefined();
  f.source
    .exec(`UPDATE orchestration_v2_projection_provider_threads SET payload_json='{"nativeThreadRef":{"nativeId":"fresh"}}' WHERE provider_thread_id='binding';
    INSERT INTO orchestration_events VALUES (2,'provider-thread.updated','child','{"id":"binding"}');`);
  now += 1_000;
  expect(f.exporter.pollIdentities()).toBe(true);
  expect(
    out
      .prepare(
        "SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id='binding'",
      )
      .get()?.payload_json,
  ).toContain('"fresh"');
});

test("redaction blocks both idle identity publication and an active auxiliary sweep", () => {
  const f = fixture();
  f.finish();
  const out = f.connect();
  f.exporter.step();
  f.source.exec(`CREATE TABLE ardud_thread_redaction_recovery (pending INTEGER);
    INSERT INTO ardud_thread_redaction_recovery VALUES (1);
    INSERT INTO orchestration_v2_projection_threads VALUES ('secret','{}');`);
  expect(() => f.exporter.pollIdentities()).toThrow("incomplete redaction");
  expect(() => f.exporter.step()).toThrow("incomplete redaction");
  expect(
    out.prepare("SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id='secret'").get(),
  ).toBeUndefined();
});

test("identity high-water and event-page queries use indexed bounded ranges", () => {
  const f = fixture();
  for (const name of ["threads", "provider_threads", "subagents"]) {
    const plan = f.source
      .prepare(
        `EXPLAIN QUERY PLAN SELECT rowid,* FROM orchestration_v2_projection_${name} WHERE rowid>? ORDER BY rowid LIMIT ?`,
      )
      .all(0, 100);
    expect(JSON.stringify(plan)).toContain("SEARCH");
    expect(JSON.stringify(plan)).toContain("INTEGER PRIMARY KEY");
    expect(JSON.stringify(plan)).not.toContain("TEMP B-TREE");
  }
  const plan = f.source
    .prepare(
      "EXPLAIN QUERY PLAN SELECT sequence,event_type FROM orchestration_events WHERE sequence>? AND sequence<=? ORDER BY sequence LIMIT ?",
    )
    .all(0, 100, 100);
  expect(JSON.stringify(plan)).toContain("INTEGER PRIMARY KEY");
});

test("identity publication p95 is at most 1 s across a slow 50 s auxiliary cycle", () => {
  const f = fixture();
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  f.finish();
  const out = f.connect();
  for (let i = 0; i < 400; i++)
    f.source.prepare("INSERT INTO scheduled_tasks VALUES (?,'a')").run(`task${i}`);
  const pending = new Map<string, number>();
  const lags: number[] = [];
  let inserted = 0;
  for (let step = 0; step < 120; step++) {
    if (step % 5 === 1 && inserted < 20) {
      const id = `child${inserted++}`;
      f.source.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?,'{}')").run(id);
      pending.set(id, now);
    }
    now += 250;
    expect(f.exporter.step()).toBe(true);
    for (const [id, created] of pending) {
      if (
        out.prepare("SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id=?").get(id)
      ) {
        lags.push(now - created);
        pending.delete(id);
      }
    }
  }
  expect(pending.size).toBe(0);
  expect(lags).toHaveLength(20);
  lags.sort((a, b) => a - b);
  expect(lags[Math.ceil(lags.length * 0.95) - 1]).toBeLessThanOrEqual(1_000);
  expect(out.prepare("SELECT count(*) AS n FROM scheduled_tasks").get()?.n).toBe(0);
});

test("a binding page resolves child lineage by primary key ahead of a full thread page", () => {
  const f = fixture(1);
  let now = Date.parse("2026-11-13T12:00:00Z");
  vi.spyOn(Date, "now").mockImplementation(() => now);
  f.source.exec("ALTER TABLE orchestration_v2_projection_threads ADD COLUMN created_at TEXT");
  f.restart();
  f.finish();
  f.exporter.pollIdentities();
  const insert = f.source.prepare(
    "INSERT INTO orchestration_v2_projection_threads VALUES (?,'{}',?)",
  );
  for (const id of ["ahead1", "ahead2", "child"]) insert.run(id, new Date(now).toISOString());
  f.source
    .exec(`INSERT INTO orchestration_v2_projection_provider_threads VALUES ('binding','{}','child');
    INSERT INTO orchestration_v2_projection_subagents VALUES ('delegate','{}','a','child');`);
  now += 1_000;
  expect(f.exporter.pollIdentities()).toBe(true);
  const out = f.connect();
  expect(
    out
      .prepare("SELECT thread_id FROM orchestration_v2_projection_threads WHERE thread_id='child'")
      .get(),
  ).toEqual({ thread_id: "child" });
  expect(
    out
      .prepare(
        "SELECT child_thread_id FROM orchestration_v2_projection_subagents WHERE subagent_id='delegate'",
      )
      .get(),
  ).toEqual({ child_thread_id: "child" });
  expect(f.exporter.takeMetrics().identityLagMaxMs).toBe(1_000);
});

test("thread creation events cover a reused source rowid after the highest row is deleted", () => {
  const f = fixture();
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  f.finish();
  f.exporter.pollIdentities();
  const oldRowid = f.source
    .prepare("SELECT rowid FROM orchestration_v2_projection_threads WHERE thread_id='c'")
    .get()?.rowid;
  f.source.exec(`DELETE FROM orchestration_v2_projection_threads WHERE thread_id='c';
    INSERT INTO orchestration_v2_projection_threads VALUES ('reused','{}');
    INSERT INTO orchestration_events VALUES (2,'thread.created','reused','{"id":"reused"}');`);
  expect(
    f.source
      .prepare("SELECT rowid FROM orchestration_v2_projection_threads WHERE thread_id='reused'")
      .get()?.rowid,
  ).toBe(oldRowid);
  now += 1_000;
  expect(f.exporter.pollIdentities()).toBe(true);
  expect(
    f
      .connect()
      .prepare("SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id='reused'")
      .get(),
  ).toBeDefined();
});

test("binding updates behind non-identity event pages publish during a long catchup", () => {
  const f = fixture(2);
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  f.source.exec(
    "INSERT INTO orchestration_v2_projection_provider_threads(provider_thread_id,payload_json) VALUES ('binding','{}')",
  );
  f.finish();
  f.exporter.pollIdentities();
  f.exporter.takeMetrics();
  const add = f.source.prepare(
    "INSERT INTO orchestration_events(event_type,stream_id,payload_json) VALUES ('thread.metadata-updated','a','{}')",
  );
  for (let i = 0; i < 200; i++) add.run();
  // Start a long projection transaction before changing the binding.
  for (let i = 0; i < 10; i++) {
    f.exporter.step();
    if (f.exporter.takeMetrics().phaseSteps.eventCatchup) break;
  }
  f.source
    .exec(`UPDATE orchestration_v2_projection_provider_threads SET payload_json='{"nativeThreadRef":{"nativeId":"fresh"}}' WHERE provider_thread_id='binding';
    INSERT INTO orchestration_events(event_type,stream_id,payload_json) VALUES ('provider-thread.updated','a','{"id":"binding"}');`);
  now += 1_000;
  // Directly drive the fast-lane pages while the big cycle remains open.
  for (let i = 0; i < 102; i++) f.exporter.pollIdentities();
  const out = f.connect();
  expect(
    out
      .prepare(
        "SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id='binding'",
      )
      .get()?.payload_json,
  ).toContain('"fresh"');
  expect(metaValue(out, "sequence")).toBe("1");
  f.finish();
  expect(metaValue(out, "sequence")).toBe("202");
});

test("repeated identity commits preserve full-cycle catchup progress and its atomic markers", () => {
  const f = fixture(1);
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  f.finish();
  const out = f.connect();
  const stamp = metaValue(out, "updated_at");
  const add = f.source.prepare(
    "INSERT INTO orchestration_events(event_type,stream_id,payload_json) VALUES ('thread.metadata-updated','a','{}')",
  );
  for (let i = 0; i < 100; i++) add.run();
  let completed = false;
  let inserted = 0;
  for (let step = 0; step < 150; step++) {
    now += 1_000;
    if (step % 3 === 0) {
      const id = `child${inserted++}`;
      f.source.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?,'{}')").run(id);
    }
    if (!f.exporter.step()) {
      completed = true;
      break;
    }
    expect(metaValue(out, "updated_at")).toBe(stamp);
    expect(metaValue(out, "sequence")).toBe("1");
    expect(metaValue(out, "ready")).toBe("1");
  }
  expect(inserted).toBeGreaterThan(5);
  expect(completed).toBe(true);
  expect(metaValue(out, "sequence")).toBe("101");
  expect(Date.parse(String(metaValue(out, "updated_at")))).toBeGreaterThan(
    Date.parse(String(stamp)),
  );
});

test("resuming a cycle preserves the newer identity instead of replaying its older pending value", () => {
  const f = fixture(1);
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  f.source.exec(
    "INSERT INTO orchestration_v2_projection_provider_threads(provider_thread_id,payload_json) VALUES ('binding','{}')",
  );
  f.finish();
  while (f.exporter.pollIdentities()) {
    // Drain the initial identity page before constructing the pending change.
  }
  const out = f.connect();
  f.source
    .exec(`UPDATE orchestration_v2_projection_provider_threads SET payload_json='{"nativeThreadRef":{"nativeId":"pending"}}' WHERE provider_thread_id='binding';
    INSERT INTO orchestration_events VALUES (2,'provider-thread.updated','a','{"id":"binding"}');
    INSERT INTO orchestration_events VALUES (3,'thread.metadata-updated','a','{}');`);
  f.exporter.takeMetrics();
  for (let i = 0; i < 10; i++) {
    f.exporter.step();
    if (f.exporter.takeMetrics().phaseSteps.eventCatchup) break;
  }
  expect(
    out
      .prepare(
        "SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id='binding'",
      )
      .get()?.payload_json,
  ).toBe("{}");
  f.source
    .exec(`UPDATE orchestration_v2_projection_provider_threads SET payload_json='{"nativeThreadRef":{"nativeId":"fresh"}}' WHERE provider_thread_id='binding';
    INSERT INTO orchestration_events VALUES (4,'provider-thread.updated','a','{"id":"binding"}');`);
  now += 1_000;
  expect(f.exporter.pollIdentities()).toBe(true);
  expect(
    out
      .prepare(
        "SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id='binding'",
      )
      .get()?.payload_json,
  ).toContain('"fresh"');
  expect(metaValue(out, "sequence")).toBe("1");
  f.finish();
  expect(
    out
      .prepare(
        "SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id='binding'",
      )
      .get()?.payload_json,
  ).toContain('"fresh"');
  expect(metaValue(out, "sequence")).toBe("4");
});

test("upgrading a published replica catches identities committed before the new worker opens", () => {
  const f = fixture();
  f.finish();
  const writer = new NodeSqlite.DatabaseSync(f.options.replicaPath);
  writer.exec("DELETE FROM ardud_readonly_meta WHERE key LIKE 'identity_%'");
  writer.close();
  f.source.exec(`INSERT INTO orchestration_v2_projection_threads VALUES ('child','{}');
    INSERT INTO orchestration_v2_projection_provider_threads(provider_thread_id,payload_json) VALUES ('binding','{}');
    INSERT INTO orchestration_v2_projection_subagents(subagent_id,payload_json) VALUES ('delegate','{}');
    INSERT INTO orchestration_events VALUES (2,'thread.created','child','{"id":"child"}');
    INSERT INTO orchestration_events VALUES (3,'provider-thread.updated','child','{"id":"binding"}');
    INSERT INTO orchestration_events VALUES (4,'subagent.updated','a','{"id":"delegate"}');`);
  f.restart();
  while (f.exporter.pollIdentities()) {
    // Upgrade starts its bounded event scan at the last published generation.
  }
  const out = f.connect();
  expect(
    out.prepare("SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id='child'").get(),
  ).toBeDefined();
  expect(
    out
      .prepare(
        "SELECT 1 FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id='binding'",
      )
      .get(),
  ).toBeDefined();
  expect(
    out
      .prepare("SELECT 1 FROM orchestration_v2_projection_subagents WHERE subagent_id='delegate'")
      .get(),
  ).toBeDefined();
  expect(metaValue(out, "sequence")).toBe("1");
});

test.each([
  { table: "threads", key: "thread_id", event: "thread.created" },
  { table: "provider_threads", key: "provider_thread_id", event: "provider-thread.updated" },
  { table: "subagents", key: "subagent_id", event: "subagent.updated" },
])(
  "fast-lane $table inserts are visible with one touch, and unchanged replay adds none",
  ({ table, key, event }) => {
    const f = fixture(100);
    let now = Date.parse("2026-11-13T12:00:00Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    f.finish();
    const out = f.connect();
    const repair = metaValue(out, "lineage_repair_revision");
    const watermark = metaValue(out, "lineage_repair_watermark");
    const touch = Number(metaValue(out, "lineage_touch_revision"));
    f.exporter.takeMetrics();
    f.source.exec(
      `INSERT INTO orchestration_v2_projection_${table}(${key},payload_json) VALUES ('new','{}')`,
    );
    f.source
      .prepare("INSERT INTO orchestration_events(event_type,stream_id,payload_json) VALUES (?,?,?)")
      .run(event, "new", '{"id":"new"}');
    now += 1000;
    f.exporter.pollIdentities();
    expect(
      out
        .prepare(`SELECT ${key} FROM orchestration_v2_projection_${table} WHERE ${key}='new'`)
        .get(),
    ).toBeDefined();
    expect(metaValue(out, "lineage_repair_revision")).toBe(repair);
    expect(metaValue(out, "lineage_repair_watermark")).toBe(watermark);
    expect(Number(metaValue(out, "lineage_touch_revision"))).toBe(touch + 1);
    expect(
      out
        .prepare(
          "SELECT table_name,id,kind,at FROM ardud_readonly_lineage_touches WHERE revision>?",
        )
        .all(touch),
    ).toEqual([
      {
        table_name: `orchestration_v2_projection_${table}`,
        id: "new",
        kind: "insert",
        at: new Date(now).toISOString(),
      },
    ]);
    f.source
      .prepare("INSERT INTO orchestration_events(event_type,stream_id,payload_json) VALUES (?,?,?)")
      .run(event, "new", '{"id":"new"}');
    now += 1000;
    f.exporter.pollIdentities();
    expect(Number(metaValue(out, "lineage_touch_revision"))).toBe(touch + 1);
    expect(f.exporter.takeMetrics().lineageRepairs).toEqual([]);
  },
);

test("touch revisions survive restart, native-id completion overlays once, and retention is bounded", () => {
  const f = fixture(100);
  let now = Date.parse("2026-11-13T12:00:00Z");
  vi.spyOn(Date, "now").mockImplementation(() => now);
  f.source.exec("INSERT INTO orchestration_v2_projection_provider_threads VALUES ('pt','{}','a')");
  f.finish();
  const out = f.connect();
  const repair = metaValue(out, "lineage_repair_revision");
  const writer = new NodeSqlite.DatabaseSync(f.options.replicaPath);
  writer.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<20000)
    INSERT INTO ardud_readonly_lineage_touches SELECT x,'orchestration_v2_projection_threads','a','insert','old' FROM n;
    UPDATE ardud_readonly_meta SET value='20000' WHERE key='lineage_touch_revision';
    UPDATE ardud_readonly_meta SET value='1' WHERE key='lineage_touch_min_revision';`);
  writer.close();
  f.restart();
  f.source
    .exec(`UPDATE orchestration_v2_projection_provider_threads SET payload_json='{"nativeThreadRef":{"nativeId":"native"}}' WHERE provider_thread_id='pt';
    INSERT INTO orchestration_events(event_type,stream_id,payload_json) VALUES ('provider-thread.updated','a','{"id":"pt"}')`);
  now += 1000;
  f.exporter.pollIdentities();
  expect(metaValue(out, "lineage_repair_revision")).toBe(repair);
  expect(metaValue(out, "lineage_touch_revision")).toBe("20001");
  expect(metaValue(out, "lineage_touch_min_revision")).toBe("2");
  expect(
    out
      .prepare(
        "SELECT count(*) AS n,min(revision) AS lo,max(revision) AS hi FROM ardud_readonly_lineage_touches",
      )
      .get(),
  ).toEqual({ n: 20000, lo: 2, hi: 20001 });
  expect(
    out
      .prepare("SELECT table_name,id,kind FROM ardud_readonly_lineage_touches WHERE revision=20001")
      .get(),
  ).toEqual({
    table_name: "orchestration_v2_projection_provider_threads",
    id: "pt",
    kind: "update",
  });
  now += 1000;
  f.exporter.pollIdentities();
  expect(metaValue(out, "lineage_touch_revision")).toBe("20001");
});

test("repair diagnostics count only committed reconcile changes/deletions and reset", () => {
  const f = fixture(100);
  f.finish();
  f.exporter.takeMetrics();
  f.source.exec(
    `UPDATE orchestration_v2_projection_threads SET payload_json='{"lineage":{"parentThreadId":"a"}}' WHERE thread_id='b'`,
  );
  for (let i = 0; i < 18; i++) f.finish();
  const changed = f.exporter.takeMetrics();
  expect(changed.lineageRepairCounts).toMatchObject({
    reconcile_change: 1,
    reconcile_delete: 0,
    fast_lane_insert: 0,
    fast_lane_update: 0,
    reset: 0,
  });
  expect(changed.lineageRepairs).toEqual([
    {
      revision: 1,
      cause: "reconcile_change",
      table: "orchestration_v2_projection_threads",
      ids: 1,
    },
  ]);
  f.source.exec("DELETE FROM orchestration_v2_projection_threads WHERE thread_id='b'");
  for (let i = 0; i < 18; i++) f.finish();
  expect(f.exporter.takeMetrics().lineageRepairs).toEqual([
    {
      revision: 2,
      cause: "reconcile_delete",
      table: "orchestration_v2_projection_threads",
      ids: 1,
    },
  ]);
  f.source.exec(`INSERT INTO orchestration_events VALUES (3,'thread.created','c','{}')`);
  f.finish();
  expect(f.exporter.takeMetrics().lineageRepairs).toEqual([
    { revision: 3, cause: "reset", table: "orchestration_events", ids: 0 },
  ]);
});
