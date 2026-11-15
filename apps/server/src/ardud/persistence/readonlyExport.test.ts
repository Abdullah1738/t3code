// @effect-diagnostics nodeBuiltinImport:off globalDate:off - fixtures exercise native SQLite and explicitly mock the serialized worker's wall clock.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeSqlite from "node:sqlite";
import * as NodeWorkerThreads from "node:worker_threads";
import * as NodeChildProcess from "node:child_process";
import { afterEach, expect, test, vi } from "vite-plus/test";
import {
  createReadonlyReplica,
  type ReadonlyExportDiagnosticEvent,
  type ReadonlyRebuildEvent,
} from "./readonlyExport.ts";
import { resolveHistoryBasePath } from "./historySourceFiles.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup();
});

function fixture(batchSize = 2, setup?: (source: NodeSqlite.DatabaseSync) => void) {
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
    CREATE TABLE ardud_kanban_slot_events (id INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT NOT NULL, pool_key TEXT NOT NULL, thread_id TEXT NOT NULL, card_id TEXT, kind TEXT NOT NULL CHECK (kind IN ('take','release')), at TEXT NOT NULL, why TEXT NOT NULL);
    INSERT INTO orchestration_events VALUES (1,'thread.created','a','{"id":"a"}');
    INSERT INTO orchestration_v2_projection_threads VALUES ('a','{"title":"old"}');
    INSERT INTO orchestration_v2_projection_threads VALUES ('b','{}');
    INSERT INTO orchestration_v2_projection_threads VALUES ('c','{}');
    INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,type,payload_json) VALUES ('tool','command_execution','{"text":"large tool output"}');
    INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,type,payload_json) VALUES ('stop','run_interrupt_request','{}');`);
  cleanups.push(() => {
    if (source.isOpen) source.close();
  });
  setup?.(source);
  const diagnostics: ReadonlyExportDiagnosticEvent[] = [];
  const rebuilds: ReadonlyRebuildEvent[] = [];
  const options = { sourcePath, replicaPath, batchSize };
  const open = () =>
    createReadonlyReplica(NodeSqlite, NodeFS, NodePath, {
      ...options,
      onDiagnosticEvent: (event) => diagnostics.push(event),
      onRebuildEvent: (event) => rebuilds.push(event),
    });
  let exporter = open();
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
    diagnostics,
    rebuilds,
    connect,
    finish,
    get exporter() {
      return exporter;
    },
    restart() {
      exporter.close();
      exporter = open();
    },
  };
}

test.each(["gap", "empty_page"])(
  "an unexplained %s preserves the published generation throughout reset",
  (reason) => {
    let now = Date.parse("2026-11-15T09:47:40Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const f = fixture(1);
    f.finish();
    const out = f.connect();
    const generation = metaValue(out, "generation");
    const watermark = metaValue(out, "updated_at");
    f.rebuilds.length = 0;
    f.source
      .exec(`UPDATE orchestration_v2_projection_threads SET payload_json='{"title":"after"}' WHERE thread_id='a';
    INSERT INTO orchestration_events VALUES (2,'thread.metadata-updated','a','{}'),(3,'thread.metadata-updated','a','{}');
    DELETE FROM orchestration_events WHERE sequence=2`);
    if (reason === "empty_page") {
      f.source.exec(
        "INSERT INTO orchestration_events VALUES (2,'thread.metadata-updated','a','{}')",
      );
      f.exporter.step();
      f.source.exec("DELETE FROM orchestration_events WHERE sequence>1");
    }
    for (let step = 0; ; step++) {
      expect(metaValue(out, "ready")).toBe("1");
      expect(metaValue(out, "generation")).toBe(generation);
      expect(metaValue(out, "updated_at")).toBe(watermark);
      expect(
        out
          .prepare(
            "SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id='a'",
          )
          .get()?.payload_json,
      ).toBe('{"title":"old"}');
      now += 30_000;
      if (!f.exporter.step()) break;
      if (f.rebuilds.length) {
        const sidecar = JSON.parse(
          NodeFS.readFileSync(f.options.replicaPath + ".rebuild.json", "utf8"),
        );
        expect(sidecar.rebuild_started_at).toBe(metaValue(out, "rebuild_started_at"));
        const progress = JSON.parse(sidecar.rebuild_progress);
        expect(progress.kind).toBe("events_reset");
        expect(
          now - Date.parse(sidecar.rebuild_started_at) - progress.elapsedMs,
        ).toBeLessThanOrEqual(30_000);
      }
      if (step > 100) throw new Error("reset did not converge");
    }
    expect(metaValue(out, "ready")).toBe("1");
    expect(Number(metaValue(out, "generation"))).toBe(Number(generation) + 1);
    expect(metaValue(out, "sequence")).toBe(reason === "gap" ? "3" : "1");
    expect(f.rebuilds[0]).toMatchObject({
      event: "start",
      kind: "events_reset",
      reason,
      cursor: 1,
      cycleTarget: 3,
      firstMissingSequence: 2,
      rowsReturned: reason === "gap" ? 1 : 0,
    });
    expect(f.rebuilds.some((event) => event.event === "progress")).toBe(true);
    const sidecar = JSON.parse(
      NodeFS.readFileSync(f.options.replicaPath + ".rebuild.json", "utf8"),
    );
    expect(JSON.parse(sidecar.rebuild_progress)).toMatchObject({
      event: "publish",
      kind: "events_reset",
    });
    const phases = f.exporter.takeMetrics().phaseSteps;
    expect(phases.resetDelete).toBeGreaterThan(0);
    expect(phases.resetScan).toBeGreaterThan(0);
  },
);

test("closing an events reset rolls back every partial page", () => {
  const f = fixture(1);
  f.finish();
  const out = f.connect();
  const generation = metaValue(out, "generation");
  f.source.exec(`INSERT INTO orchestration_events VALUES (3,'thread.metadata-updated','a','{}');
    UPDATE orchestration_v2_projection_threads SET payload_json='{"title":"after"}' WHERE thread_id='a'`);
  for (let i = 0; i < 4; i++) f.exporter.step();
  f.exporter.close();
  expect(metaValue(out, "ready")).toBe("1");
  expect(metaValue(out, "generation")).toBe(generation);
  expect(
    out
      .prepare("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id='a'")
      .get()?.payload_json,
  ).toBe('{"title":"old"}');
  f.restart();
  f.finish();
  expect(metaValue(out, "ready")).toBe("1");
  expect(metaValue(out, "sequence")).toBe("3");
});

test("a journalled prefix cannot hide a later unexplained hole", () => {
  const f = fixture(2, (source) =>
    source.exec(`CREATE TABLE ardud_history_compacted_events (
    revision INTEGER PRIMARY KEY AUTOINCREMENT, sequence INTEGER NOT NULL UNIQUE)`),
  );
  f.finish();
  f.rebuilds.length = 0;
  f.source
    .exec(`INSERT INTO orchestration_events VALUES (4,'thread.metadata-updated','a','{}'),(5,'thread.metadata-updated','a','{}');
    INSERT INTO ardud_history_compacted_events(sequence) VALUES (2)`);
  const out = f.connect();
  for (let i = 0; f.exporter.step(); i++) {
    expect(metaValue(out, "ready")).toBe("1");
    if (i > 100) throw new Error("reset did not converge");
  }
  expect(f.rebuilds[0]).toMatchObject({ reason: "gap", cursor: 1, firstMissingSequence: 3 });
  expect(metaValue(out, "sequence")).toBe("5");
});

test("journalled compaction between target selection and page read needs no reset", () => {
  const f = fixture(2, (source) =>
    source.exec(`CREATE TABLE ardud_history_compacted_events (
    revision INTEGER PRIMARY KEY AUTOINCREMENT, sequence INTEGER NOT NULL UNIQUE)`),
  );
  f.finish();
  const out = f.connect();
  f.rebuilds.length = 0;
  f.source
    .exec(`INSERT INTO orchestration_events VALUES (2,'thread.metadata-updated','a','{}'),(3,'thread.metadata-updated','a','{}');
    UPDATE orchestration_v2_projection_threads SET payload_json='{"title":"after"}' WHERE thread_id='a'`);
  f.exporter.step();
  f.source.exec(`BEGIN; INSERT INTO ardud_history_compacted_events(sequence) VALUES (2);
    DELETE FROM orchestration_events WHERE sequence=2; COMMIT`);
  for (let step = 0; f.exporter.step(); step++) {
    expect(metaValue(out, "ready")).toBe("1");
    if (step > 100) throw new Error("catchup did not converge");
  }
  expect(metaValue(out, "sequence")).toBe("3");
  expect(f.rebuilds).toEqual([]);
  expect(
    out.prepare("SELECT sequence FROM orchestration_events WHERE sequence=2").get(),
  ).toBeUndefined();
  expect(
    out
      .prepare("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id='a'")
      .get()?.payload_json,
  ).toBe('{"title":"after"}');
});

test("compaction journal revisions remove already exported events even in reverse sequence order", () => {
  const f = fixture(2);
  f.source.exec(
    `INSERT INTO orchestration_events VALUES (2,'thread.metadata-updated','a','{}'),(3,'thread.metadata-updated','a','{}')`,
  );
  f.finish();
  const out = f.connect();
  f.source
    .exec(`CREATE TABLE ardud_history_compacted_events (revision INTEGER PRIMARY KEY AUTOINCREMENT, sequence INTEGER NOT NULL UNIQUE);
    INSERT INTO ardud_history_compacted_events(sequence) VALUES (3);
    DELETE FROM orchestration_events WHERE sequence=3`);
  f.finish();
  expect(metaValue(out, "sequence")).toBe("3");
  expect(
    out
      .prepare(
        "SELECT sequence FROM orchestration_events WHERE sequence=3 AND event_type!='readonly.watermark'",
      )
      .get(),
  ).toBeUndefined();
  f.source.exec(`INSERT INTO ardud_history_compacted_events(sequence) VALUES (2);
    DELETE FROM orchestration_events WHERE sequence=2`);
  f.finish();
  expect(
    out.prepare("SELECT sequence FROM orchestration_events WHERE sequence=2").get(),
  ).toBeUndefined();
  expect(f.rebuilds.some((event) => event.kind === "events_reset")).toBe(false);
});

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

function recoveryIndexFixture() {
  return fixture(100, (source) => {
    source.exec(`
      ALTER TABLE orchestration_v2_projection_runs ADD COLUMN status TEXT;
      ALTER TABLE orchestration_v2_projection_runs ADD COLUMN completed_at TEXT;
      ALTER TABLE orchestration_v2_projection_runs ADD COLUMN ordinal INTEGER;
      ALTER TABLE orchestration_v2_projection_runs ADD COLUMN requested_at TEXT;
      ALTER TABLE orchestration_v2_projection_subagents ADD COLUMN run_id TEXT;
      ALTER TABLE orchestration_v2_projection_subagents ADD COLUMN provider_thread_id TEXT;
      ALTER TABLE orchestration_v2_projection_subagents ADD COLUMN started_at TEXT;
      ALTER TABLE orchestration_v2_projection_subagents ADD COLUMN completed_at TEXT;
      ALTER TABLE orchestration_v2_projection_subagents ADD COLUMN status TEXT;
      ALTER TABLE orchestration_v2_projection_subagents ADD COLUMN origin TEXT;
      ALTER TABLE orchestration_v2_projection_turn_items ADD COLUMN run_id TEXT;
      ALTER TABLE orchestration_v2_projection_turn_items ADD COLUMN updated_at TEXT;
      CREATE INDEX turn_items_run_ordinal_idx ON orchestration_v2_projection_turn_items(run_id,ordinal);
      CREATE INDEX runs_thread_ordinal_idx ON orchestration_v2_projection_runs(thread_id,ordinal);
      CREATE INDEX subagents_thread_started_idx ON orchestration_v2_projection_subagents(thread_id,started_at,subagent_id);
    `);
    const run = source.prepare(`INSERT INTO orchestration_v2_projection_runs
      (run_id,thread_id,payload_json,status,completed_at,ordinal,requested_at) VALUES (?,'a','{}',?,?,?,'2026-11-14T00:00:00Z')`);
    const subagent = source.prepare(`INSERT INTO orchestration_v2_projection_subagents
      (subagent_id,thread_id,child_thread_id,payload_json,run_id,status,origin,started_at,completed_at)
      VALUES (?,'a','child','{}',?,?,?,'2026-11-14T00:00:00Z',?)`);
    const item = source.prepare(`INSERT INTO orchestration_v2_projection_turn_items
      (turn_item_id,type,payload_json,run_id,updated_at) VALUES (?,?,'{}',?,'2026-11-15T00:00:00Z')`);
    for (let i = 0; i < 200; i++) {
      const id = `run-${i}`;
      const status = ["completed", "failed", "cancelled", "interrupted"][i % 4]!;
      const completed = i < 196 ? "2026-11-14T00:00:00Z" : "2026-11-15T00:00:00Z";
      run.run(id, status, completed, i);
      subagent.run(
        `node:delegated-task:${i}`,
        id,
        status,
        i % 2 ? "provider_native" : "app_owned",
        completed,
      );
      for (const type of ["user_message", "error", "run_interrupt_request"])
        item.run(`${id}-${type}`, type, id);
    }
  });
}

const recoveryIndexNames = [
  "items_thread",
  "seen_generation",
  "runs_restart_completed",
  "runs_failed_completed",
  "subagents_cancelled_completed",
  "subagents_failed_completed",
  "items_run_interrupt",
  "items_run_user_message",
  "items_run_error",
]
  .map((suffix) => `ardud_readonly_${suffix}`)
  .sort();
const exportIndexNames = (db: NodeSqlite.DatabaseSync) =>
  db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type='index' AND name GLOB 'ardud_readonly_*' ORDER BY name",
    )
    .all()
    .map((row) => row.name);

// SQL copied from integrations/stream-recovery/lib/io.mjs; predicates must match its partial indexes.
const recoveryDiscoveryQueries = [
  {
    name: "failedRunsSince",
    sql: `select run_id, thread_id, ordinal, requested_at, completed_at,
              json_extract(payload_json,'$.activeAttemptId') attempt,
              json_extract(payload_json,'$.userMessageId') user_message_id,
              json_extract(payload_json,'$.startedAt') started_at
         from orchestration_v2_projection_runs
        where status='failed' and completed_at >= ? order by completed_at`,
    indexes: ["runs_failed_completed"],
  },
  {
    name: "failedSubagentsSince",
    sql: `select subagent_id, thread_id, run_id, provider_thread_id, child_thread_id, completed_at,
              json_extract(payload_json,'$.result') result, json_extract(payload_json,'$.title') title
         from orchestration_v2_projection_subagents
        where status='failed' and completed_at >= ? order by completed_at`,
    indexes: ["subagents_failed_completed"],
  },
  {
    name: "cancelledSubagentsSince",
    sql: `select subagent_id, thread_id, run_id, provider_thread_id, child_thread_id, started_at, completed_at,
              json_extract(payload_json,'$.result') result, json_extract(payload_json,'$.title') title,
              json_extract(payload_json,'$.prompt') prompt, json_extract(payload_json,'$.model') model
         from orchestration_v2_projection_subagents s
        where origin='provider_native' and completed_at >= ?
          and status in ('cancelled','interrupted')
          and not exists(select 1 from orchestration_v2_projection_turn_items i
            where i.run_id=s.run_id and i.type='run_interrupt_request')
        order by completed_at`,
    indexes: ["subagents_cancelled_completed", "items_run_interrupt"],
  },
  {
    name: "cancelledDelegatedTasksSince",
    sql: `select s.subagent_id, s.thread_id, s.run_id, s.provider_thread_id, s.child_thread_id, s.started_at, s.completed_at,
            json_extract(s.payload_json,'$.result') result, json_extract(s.payload_json,'$.title') title,
            json_extract(s.payload_json,'$.prompt') prompt, json_extract(s.payload_json,'$.model') model,
            json_extract(s.payload_json,'$.clientRequestId') client_request_id
       from orchestration_v2_projection_subagents s
      where s.origin='app_owned' and s.subagent_id glob 'node:delegated-task:*'
        and s.completed_at >= ? and s.status in ('cancelled','interrupted')
        and coalesce(json_extract(s.payload_json,'$.completionDelivery.state'),'') != 'disposed'
        and not exists(select 1 from orchestration_v2_projection_turn_items i
          where i.run_id=s.run_id and i.type='run_interrupt_request' and i.updated_at >= s.started_at)
      order by s.completed_at`,
    indexes: ["subagents_cancelled_completed", "items_run_interrupt"],
  },
  {
    name: "restartRunsSince",
    sql: `select r.run_id, r.thread_id, r.ordinal, r.status, r.requested_at, r.completed_at,
            json_extract(r.payload_json,'$.modelSelection.instanceId') instance_id,
            json_extract(r.payload_json,'$.startedAt') started_at,
            exists(select 1 from orchestration_v2_projection_turn_items i
              where i.run_id=r.run_id and i.type='user_message') dispatched,
            exists(select 1 from orchestration_v2_projection_turn_items i
              where i.run_id=r.run_id and i.type='run_interrupt_request') stop_requested
       from orchestration_v2_projection_runs r
       join orchestration_v2_projection_threads t on t.thread_id=r.thread_id
      where r.completed_at >= ? and r.status in ('cancelled','failed','interrupted')
        and (r.status='failed' or json_extract(r.payload_json,'$.startedAt') is not null
          or exists(select 1 from orchestration_v2_projection_turn_items i
            where i.run_id=r.run_id and i.type='user_message'))
        and json_extract(t.payload_json,'$.lineage.parentThreadId') is null
        and r.thread_id not like 'thread:provider:%'
      order by r.completed_at`,
    indexes: ["runs_restart_completed", "items_run_user_message", "items_run_interrupt"],
  },
  {
    name: "failedRunsSince error lookup",
    sql: `select json_extract(payload_json,'$.failure.message') m from orchestration_v2_projection_turn_items
      where run_id=? and type='error' limit 1`,
    indexes: ["items_run_error"],
  },
];

test("stream-recovery indexes belong to the replica and reopening stays incremental", () => {
  const f = recoveryIndexFixture();
  f.finish();
  const out = f.connect();
  expect(exportIndexNames(out)).toEqual(recoveryIndexNames);
  expect(exportIndexNames(f.source)).toEqual([]);
  const started = metaValue(out, "rebuild_started_at");
  const marker = NodeFS.readFileSync(f.options.replicaPath + ".rebuild.json", "utf8");
  f.restart();
  f.finish();
  expect(metaValue(out, "ready")).toBe("1");
  expect(metaValue(out, "last_rebuild_reason")).toBeUndefined();
  expect(metaValue(out, "rebuild_started_at")).toBe(started);
  expect(NodeFS.readFileSync(f.options.replicaPath + ".rebuild.json", "utf8")).toBe(marker);
  expect(exportIndexNames(out)).toEqual(recoveryIndexNames);
});

test.each(recoveryDiscoveryQueries)(
  "stream-recovery $name uses the export indexes",
  ({ sql, indexes }) => {
    const f = recoveryIndexFixture();
    f.finish();
    const plan = f
      .connect()
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all("2026-11-15T00:00:00Z")
      .map((row) => String(row.detail))
      .join("\n");
    for (const index of indexes)
      expect(plan).toMatch(new RegExp(`USING (?:COVERING )?INDEX ardud_readonly_${index}\\b`));
    expect(plan).not.toMatch(/SCAN (?:r|s|orchestration_v2_projection_(?:runs|subagents))\b/);
  },
);

test("stream-recovery indexes survive a full rebuild and an auxiliary schema refresh", () => {
  const f = recoveryIndexFixture();
  f.finish();
  const out = f.connect();
  // An ardud_ source index is still restrictive; only ardud_readonly_ is export-owned.
  f.source
    .exec(`CREATE INDEX ardud_caller_active_run_idx ON orchestration_v2_projection_runs(thread_id)
    WHERE status='running'`);
  f.restart();
  f.finish();
  expect(metaValue(out, "last_rebuild_reason")).toBe(
    "source schema changed: orchestration_v2_projection_runs",
  );
  expect(exportIndexNames(out)).toEqual(recoveryIndexNames);
  expect(
    out.prepare("SELECT name FROM sqlite_schema WHERE name='ardud_caller_active_run_idx'").get(),
  ).toBeDefined();
  const started = metaValue(out, "rebuild_started_at");
  f.source.exec("ALTER TABLE scheduled_tasks ADD COLUMN cache_version INTEGER NOT NULL DEFAULT 0");
  f.finish();
  expect(JSON.parse(String(metaValue(out, "last_aux_schema_refresh"))).tables).toEqual([
    "scheduled_tasks",
  ]);
  expect(metaValue(out, "rebuild_started_at")).toBe(started);
  expect(exportIndexNames(out)).toEqual(recoveryIndexNames);
});

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

test("an unexplained event gap retains readiness across reset and worker restart", () => {
  const f = fixture();
  f.finish();
  const out = f.connect();
  const published = metaValue(out, "updated_at");
  const revision = Number(metaValue(out, "lineage_repair_revision"));
  const resetting = metaValue(out, "resetting_events");
  f.source.exec("INSERT INTO orchestration_events VALUES (4,'thread.deleted','a','{}')");
  expect(f.exporter.step()).toBe(true);
  expect(metaValue(out, "ready")).toBe("1");
  expect(metaValue(out, "resetting_events")).toBe(resetting);
  expect(metaValue(out, "updated_at")).toBe(published);
  expect(Number(metaValue(out, "lineage_repair_revision"))).toBe(revision);
  // Restart discards the private pages; the completed generation stays readable.
  f.restart();
  expect(metaValue(out, "ready")).toBe("1");
  let steps = 0;
  while (f.exporter.step()) {
    expect(metaValue(out, "ready")).toBe("1");
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

const auxiliaryTables = [
  { name: "scheduled_tasks", key: "task_id", row: "'task','a'" },
  { name: "ardud_opencode_import", key: "native_session_id", row: "'task','a'" },
  { name: "ardud_kanban_cards", key: "id", row: "'task','a','{}'" },
  { name: "ardud_kanban_threads", key: "thread_id", row: "'task',0" },
];

for (const phase of ["delete", "copy", "prune"] as const) {
  for (const terminal of ["publish", "close"] as const) {
    for (const gap of ["single", "nested"] as const) {
      test.each(auxiliaryTables)(
        `$name auxiliary changes during reset ${phase} preserve the old generation until ${terminal} (${gap})`,
        ({ name, row }) => {
          let now = Date.parse("2026-11-15T09:47:40Z");
          vi.spyOn(Date, "now").mockImplementation(() => now);
          const f = fixture(1);
          const advance = () => {
            now += 1_000;
            return f.exporter.step();
          };
          f.source.exec(`INSERT INTO ${name} VALUES (${row});
          INSERT INTO orchestration_events VALUES
          (2,'thread.metadata-updated','a','{}'),(3,'thread.metadata-updated','a','{}'),
          (4,'thread.metadata-updated','a','{}'),(5,'thread.metadata-updated','a','{}'),
          (6,'thread.metadata-updated','a','{}')`);
          f.finish();
          const out = f.connect();
          let generation = metaValue(out, "generation");
          const watermark = metaValue(out, "updated_at");
          const revision = metaValue(out, "lineage_repair_revision");
          const events = out.prepare("SELECT * FROM orchestration_events ORDER BY sequence").all();
          const schema = out.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(name)?.sql;
          const checkPublished = () => {
            expect(metaValue(out, "ready")).toBe("1");
            expect(metaValue(out, "generation")).toBe(generation);
            expect(metaValue(out, "updated_at")).toBe(watermark);
            expect(metaValue(out, "lineage_repair_revision")).toBe(revision);
            expect(
              out.prepare("SELECT * FROM orchestration_events ORDER BY sequence").all(),
            ).toEqual(events);
            expect(out.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(name)?.sql).toBe(
              schema,
            );
          };
          f.exporter.takeMetrics();
          f.source.exec(
            "INSERT INTO orchestration_events VALUES (8,'thread.metadata-updated','a','{}')",
          );
          let scans = 0;
          for (let step = 0; ; step++) {
            expect(advance()).toBe(true);
            const metrics = f.exporter.takeMetrics();
            scans += metrics.phaseSteps.resetScan ?? 0;
            if (
              (phase === "delete" && metrics.phaseSteps.resetDelete) ||
              (phase === "copy" && scans >= 1) ||
              (phase === "prune" && scans >= 5)
            )
              break;
            if (step > 100) throw new Error("reset phase was not reached");
          }
          checkPublished();
          const started = metaValue(out, "rebuild_started_at");
          f.source.exec(`ALTER TABLE ${name} ADD COLUMN cache_version INTEGER NOT NULL DEFAULT 7`);
          expect(advance()).toBe(true);
          checkPublished();
          expect(
            f.rebuilds.filter((event) => event.kind === "events_reset" && event.event === "start"),
          ).toHaveLength(1);
          if (gap === "nested") {
            f.source.exec(
              "INSERT INTO orchestration_events VALUES (10,'thread.metadata-updated','a','{}')",
            );
            for (let step = 0; ; step++) {
              expect(advance()).toBe(true);
              checkPublished();
              const starts = f.rebuilds.filter(
                (event) => event.kind === "events_reset" && event.event === "start",
              );
              if (starts.length === 2) {
                expect(starts.map((event) => event.firstMissingSequence)).toEqual([7, 9]);
                expect(metaValue(out, "rebuild_started_at")).toBe(started);
                const sidecar = JSON.parse(
                  NodeFS.readFileSync(f.options.replicaPath + ".rebuild.json", "utf8"),
                );
                expect(sidecar.rebuild_started_at).toBe(metaValue(out, "rebuild_started_at"));
                break;
              }
              if (step > 500) throw new Error("nested gap was not reached");
            }
          }
          if (terminal === "close") {
            f.exporter.close();
            checkPublished();
            f.restart();
            generation = metaValue(out, "generation");
          }
          for (let step = 0; advance(); step++) {
            checkPublished();
            if (step > 500) throw new Error("schema refresh reset did not converge");
          }
          expect(metaValue(out, "ready")).toBe("1");
          expect(metaValue(out, "sequence")).toBe(gap === "nested" ? "10" : "8");
          expect(Number(metaValue(out, "lineage_repair_revision"))).toBe(
            Number(revision) + (gap === "nested" && terminal === "publish" ? 2 : 1),
          );
          expect(out.prepare(`SELECT cache_version FROM ${name}`).all()).toEqual([
            { cache_version: 7 },
          ]);
        },
      );
    }
  }
}

for (const mode of ["reopen", "staging", "catchup"] as const) {
  test.each(auxiliaryTables)(
    `$name schema refresh preserves the published replica (${mode})`,
    ({ name, key, row }) => {
      const f = fixture();
      f.source.exec(
        `INSERT INTO ${name} VALUES (${row}); CREATE INDEX aux_lookup ON ${name}(${key})`,
      );
      f.finish();
      const out = f.connect();
      const rows = out.prepare("SELECT * FROM orchestration_v2_projection_threads").all();
      const progress = out
        .prepare(
          "SELECT * FROM ardud_readonly_progress WHERE name NOT LIKE 'reconcile:%' ORDER BY name",
        )
        .all();
      const events = out.prepare("SELECT * FROM orchestration_events ORDER BY sequence").all();
      const auxiliaryRows = out.prepare(`SELECT * FROM ${name}`).all();
      const auxiliarySchema = metaValue(out, `schema:${name}`);
      const lastRefresh = metaValue(out, "last_aux_schema_refresh");
      const revision = metaValue(out, "lineage_repair_revision");
      const rebuild = metaValue(out, "last_rebuild_reason");
      const generation = Number(metaValue(out, "generation"));
      if (mode === "staging") f.exporter.step();
      if (mode === "catchup") {
        // More than one event page keeps the publication transaction open.
        for (let i = 0; i < 40; i++)
          f.source.exec(
            "INSERT INTO orchestration_events(event_type,stream_id,payload_json) VALUES ('thread.metadata-updated','a','{}')",
          );
        for (let i = 0; f.exporter.pollIdentities(); i++) {
          if (i > 500) throw new Error("identity export did not converge");
        }
        for (let i = 0; i < 10; i++) expect(f.exporter.step()).toBe(true);
      }
      const identity = out
        .prepare("SELECT * FROM ardud_readonly_meta WHERE key LIKE 'identity_%' ORDER BY key")
        .all();
      f.source.exec(`ALTER TABLE ${name} ADD COLUMN cache_version INTEGER NOT NULL DEFAULT 0;
      UPDATE ${name} SET cache_version=7;
      CREATE INDEX aux_version ON ${name}(cache_version)`);
      if (mode === "reopen") f.restart();
      else f.exporter.pollIdentities();
      expect(metaValue(out, "ready")).toBe("1");
      // Reopening and completing a cycle each allocate a normal generation.
      const currentGeneration = generation + (mode === "reopen" ? 1 : 0);
      expect(Number(metaValue(out, "generation"))).toBe(currentGeneration);
      expect(metaValue(out, "lineage_repair_revision")).toBe(revision);
      expect(metaValue(out, "last_rebuild_reason")).toBe(rebuild);
      expect(out.prepare("SELECT * FROM orchestration_v2_projection_threads").all()).toEqual(rows);
      expect(
        out
          .prepare(
            "SELECT * FROM ardud_readonly_progress WHERE name NOT LIKE 'reconcile:%' ORDER BY name",
          )
          .all(),
      ).toEqual(progress);
      expect(out.prepare("SELECT * FROM orchestration_events ORDER BY sequence").all()).toEqual(
        events,
      );
      expect(
        out
          .prepare("SELECT * FROM ardud_readonly_meta WHERE key LIKE 'identity_%' ORDER BY key")
          .all(),
      ).toEqual(identity);
      expect(metaValue(out, "last_aux_schema_refresh")).toBe(lastRefresh);
      expect(metaValue(out, `schema:${name}`)).toBe(auxiliarySchema);
      expect(out.prepare(`SELECT * FROM ${name}`).all()).toEqual(auxiliaryRows);
      let steps = 0;
      while (f.exporter.step()) {
        expect(metaValue(out, "ready")).toBe("1");
        expect(Number(metaValue(out, "generation"))).toBe(currentGeneration);
        expect(metaValue(out, "lineage_repair_revision")).toBe(revision);
        expect(out.prepare(`SELECT * FROM ${name}`).all()).toEqual(auxiliaryRows);
        expect(metaValue(out, `schema:${name}`)).toBe(auxiliarySchema);
        expect(metaValue(out, "last_aux_schema_refresh")).toBe(lastRefresh);
        if (++steps > 500) throw new Error("export did not converge");
      }
      expect(JSON.parse(String(metaValue(out, "last_aux_schema_refresh"))).tables).toEqual([name]);
      expect(metaValue(out, `schema:${name}`)).toContain("cache_version");
      expect(out.prepare(`SELECT ${key}, cache_version FROM ${name}`).all()).toEqual([
        { [key]: "task", cache_version: 7 },
      ]);
      expect(
        out
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type='index' AND name IN ('aux_lookup','aux_version') ORDER BY name",
          )
          .all(),
      ).toEqual([{ name: "aux_lookup" }, { name: "aux_version" }]);
      expect(metaValue(out, "ready")).toBe("1");
      expect(Number(metaValue(out, "generation"))).toBe(currentGeneration + 1);
      expect(metaValue(out, "lineage_repair_revision")).toBe(revision);
      expect(metaValue(out, "last_rebuild_reason")).toBe(rebuild);
    },
  );
}

test.each(["bootstrap", "reset"])(
  "auxiliary schema changes publish atomically during %s recovery",
  (mode) => {
    const f = fixture();
    if (mode === "reset") f.finish();
    for (const { name, row } of auxiliaryTables) {
      f.source.exec(`INSERT INTO ${name} VALUES (${row});
        ALTER TABLE ${name} ADD COLUMN cache_version INTEGER NOT NULL DEFAULT 0;
        UPDATE ${name} SET cache_version=7`);
    }
    if (mode === "reset")
      f.source.exec(
        "INSERT INTO orchestration_events VALUES (4,'thread.metadata-updated','a','{}')",
      );
    expect(f.exporter.step()).toBe(true);
    const out = f.connect();
    expect(metaValue(out, "ready")).toBe(mode === "reset" ? "1" : "0");
    // Pending schemas must also survive reopening an incomplete publication.
    f.restart();
    let steps = 0;
    while (f.exporter.step()) {
      expect(metaValue(out, "ready")).toBe(mode === "reset" ? "1" : "0");
      if (++steps > 500) throw new Error("export did not converge");
    }
    expect(metaValue(out, "ready")).toBe("1");
    expect(metaValue(out, "last_rebuild_reason")).toBeUndefined();
    for (const { name } of auxiliaryTables)
      expect(out.prepare(`SELECT cache_version FROM ${name}`).all()).toEqual([
        { cache_version: 7 },
      ]);
  },
);

const reaperProtections = (replicaPath: string) => {
  const reader = NodeChildProcess.spawnSync(
    "/usr/bin/python3",
    [
      "-I",
      "-c",
      `
import json, sys
sys.path.insert(0, sys.argv[1])
import backend, robob_readonly
with robob_readonly.state_ro(sys.argv[2]) as con:
    robob_readonly.ready_generation(con)
    print(json.dumps({
        "scheduled": sorted(backend.scheduled_task_session_ids(con)),
        "kanban": sorted(backend.kanban_session_ids(con)),
    }))
`,
      NodePath.resolve(import.meta.dirname, "../../../../../integrations/memory-system/src"),
      replicaPath,
    ],
    { encoding: "utf8", timeout: 5000 },
  );
  if (reader.error) throw reader.error;
  if (reader.status !== 0) throw new Error(reader.stderr);
  return JSON.parse(reader.stdout);
};

test.each(["reopen", "midrun", "restart", "failed_publish"])(
  "real reaper readers retain task/card/thread/import protections during schema refresh (%s)",
  (mode) => {
    const f = fixture(2, (source) =>
      source.exec(`
      ALTER TABLE orchestration_v2_projection_messages ADD COLUMN role TEXT;
      ALTER TABLE orchestration_v2_projection_messages ADD COLUMN created_at TEXT;
      ALTER TABLE orchestration_v2_projection_messages ADD COLUMN thread_id TEXT;
      INSERT INTO scheduled_tasks VALUES ('task','a');
      INSERT INTO ardud_opencode_import VALUES ('ses_import','a');
      INSERT INTO ardud_kanban_cards VALUES ('card','b','{"workThreadId":"b","settledAt":null}');
      INSERT INTO ardud_kanban_threads VALUES ('c',0);
      INSERT INTO orchestration_v2_projection_provider_threads VALUES ('p-b','{"nativeThreadRef":{"nativeId":"ses_card"}}','b');
      INSERT INTO orchestration_v2_projection_provider_threads VALUES ('p-c','{"nativeThreadRef":{"nativeId":"ses_link"}}','c');
    `),
    );
    f.finish();
    const out = f.connect();
    const expected = { scheduled: ["ses_import"], kanban: ["ses_card", "ses_link"] };
    const checkReader = () => {
      expect(metaValue(out, "ready")).toBe("1");
      expect(reaperProtections(f.options.replicaPath)).toEqual(expected);
    };
    checkReader();
    // A reader holding a WAL snapshot keeps its complete old schema and rows.
    const snapshot = f.connect();
    snapshot.exec("BEGIN");
    const oldTasks = snapshot.prepare("SELECT * FROM scheduled_tasks").all();
    for (const { name } of auxiliaryTables)
      f.source.exec(`ALTER TABLE ${name} ADD COLUMN cache_version INTEGER NOT NULL DEFAULT 0;
        UPDATE ${name} SET cache_version=7`);
    if (mode === "reopen") f.restart();
    else f.exporter.pollIdentities();
    checkReader();
    if (mode === "restart") {
      f.exporter.step();
      f.restart();
      checkReader();
    }
    if (mode === "failed_publish") {
      const writable = new NodeSqlite.DatabaseSync(f.options.replicaPath);
      cleanups.push(() => writable.close());
      writable.exec(`CREATE TRIGGER reject_publication BEFORE INSERT ON orchestration_events
        BEGIN SELECT RAISE(ABORT, 'blocked publication'); END`);
      expect(() => f.finish()).toThrow("blocked publication");
      checkReader();
      expect(metaValue(out, "last_aux_schema_refresh")).toBeUndefined();
      expect(
        out
          .prepare("PRAGMA table_info(scheduled_tasks)")
          .all()
          .map((row) => row.name),
      ).not.toContain("cache_version");
      writable.exec("DROP TRIGGER reject_publication");
      f.restart();
      checkReader();
    }
    let steps = 0;
    while (f.exporter.step()) {
      checkReader();
      if (++steps > 500) throw new Error("export did not converge");
    }
    checkReader();
    for (const { name } of auxiliaryTables)
      expect(out.prepare(`SELECT cache_version FROM ${name}`).all()).toEqual([
        { cache_version: 7 },
      ]);
    expect(snapshot.prepare("SELECT * FROM scheduled_tasks").all()).toEqual(oldTasks);
    expect(
      snapshot
        .prepare("PRAGMA table_info(scheduled_tasks)")
        .all()
        .map((row) => row.name),
    ).not.toContain("cache_version");
    snapshot.exec("ROLLBACK");
    expect(snapshot.prepare("SELECT cache_version FROM scheduled_tasks").get()?.cache_version).toBe(
      7,
    );
  },
);

test("auxiliary schemas in the split boards database refresh without a main schema change", () => {
  const f = fixture();
  f.exporter.close();
  const boardPath = NodePath.join(NodePath.dirname(f.options.sourcePath), "boards.sqlite");
  const boards = new NodeSqlite.DatabaseSync(boardPath);
  cleanups.push(() => boards.close());
  boards.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE ardud_boards_migration(table_name TEXT PRIMARY KEY, completed INTEGER);
    INSERT INTO ardud_boards_migration VALUES ('*',1);
    CREATE TABLE ardud_kanban_cards (id TEXT PRIMARY KEY, active_thread_id TEXT, json TEXT);
    CREATE TABLE ardud_kanban_threads (thread_id TEXT PRIMARY KEY, ended INTEGER);
    INSERT INTO ardud_kanban_cards VALUES ('card','a','{}');
    INSERT INTO ardud_kanban_threads VALUES ('a',0)`);
  const exporter = createReadonlyReplica(NodeSqlite, NodeFS, NodePath, { ...f.options, boardPath });
  cleanups.push(() => exporter.close());
  drive(exporter);
  const out = f.connect();
  const generation = metaValue(out, "generation");
  const revision = metaValue(out, "lineage_repair_revision");
  const mainVersion = f.source.prepare("PRAGMA schema_version").get();
  exporter.step();
  boards.exec(`ALTER TABLE ardud_kanban_cards ADD COLUMN cache_version INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE ardud_kanban_threads ADD COLUMN cache_version INTEGER NOT NULL DEFAULT 0;
    UPDATE ardud_kanban_cards SET cache_version=3;
    UPDATE ardud_kanban_threads SET cache_version=4`);
  exporter.pollIdentities();
  expect(metaValue(out, "ready")).toBe("1");
  expect(metaValue(out, "generation")).toBe(generation);
  expect(metaValue(out, "lineage_repair_revision")).toBe(revision);
  expect(f.source.prepare("PRAGMA schema_version").get()).toEqual(mainVersion);
  expect(metaValue(out, "last_aux_schema_refresh")).toBeUndefined();
  expect(out.prepare("SELECT * FROM ardud_kanban_cards").all()).toEqual([
    { id: "card", active_thread_id: "a", json: "{}" },
  ]);
  drive(exporter);
  expect(JSON.parse(String(metaValue(out, "last_aux_schema_refresh"))).tables).toEqual([
    "ardud_kanban_cards",
    "ardud_kanban_threads",
  ]);
  expect(out.prepare("SELECT id,cache_version FROM ardud_kanban_cards").all()).toEqual([
    { id: "card", cache_version: 3 },
  ]);
  expect(out.prepare("SELECT thread_id,cache_version FROM ardud_kanban_threads").all()).toEqual([
    { thread_id: "a", cache_version: 4 },
  ]);
  expect(metaValue(out, "ready")).toBe("1");
  expect(metaValue(out, "last_rebuild_reason")).toBeUndefined();
});

for (const mode of ["reopen", "midrun"] as const) {
  test.each([
    [
      "added unique",
      "",
      "UPDATE scheduled_tasks SET thread_id=task_id; CREATE UNIQUE INDEX aux_constraint ON scheduled_tasks(thread_id)",
    ],
    [
      "removed unique",
      "CREATE UNIQUE INDEX aux_constraint ON scheduled_tasks(thread_id)",
      "DROP INDEX aux_constraint; UPDATE scheduled_tasks SET thread_id='duplicate'",
    ],
    [
      "downgraded unique",
      "CREATE UNIQUE INDEX aux_constraint ON scheduled_tasks(thread_id)",
      "DROP INDEX aux_constraint; CREATE INDEX aux_constraint ON scheduled_tasks(thread_id); UPDATE scheduled_tasks SET thread_id='duplicate'",
    ],
    [
      "removed expression",
      "CREATE INDEX aux_constraint ON scheduled_tasks(json_extract(thread_id,'$.v'))",
      "DROP INDEX aux_constraint; UPDATE scheduled_tasks SET thread_id='duplicate'",
    ],
    [
      "removed partial",
      "CREATE INDEX aux_constraint ON scheduled_tasks(task_id) WHERE json_extract(thread_id,'$.v')>0",
      "DROP INDEX aux_constraint; UPDATE scheduled_tasks SET thread_id='duplicate'",
    ],
  ])(`an auxiliary %s index uses localized publication (${mode})`, (kind, previous, mutation) => {
    const f = fixture(1, (source) =>
      source.exec(
        `INSERT INTO scheduled_tasks VALUES ('one','{"v":1}'),('two','{"v":2}'); ${previous}`,
      ),
    );
    f.finish();
    const out = f.connect();
    const generation = Number(metaValue(out, "generation")) + (mode === "reopen" ? 1 : 0);
    const previousRows = out.prepare("SELECT * FROM scheduled_tasks ORDER BY task_id").all();
    const progress = out
      .prepare(
        "SELECT * FROM ardud_readonly_progress WHERE name NOT LIKE 'reconcile:%' ORDER BY name",
      )
      .all();
    const schema = metaValue(out, "schema:scheduled_tasks");
    if (mode === "midrun") f.exporter.step();
    f.source.exec(mutation);
    expect(
      f.source.prepare("SELECT sql FROM sqlite_schema WHERE name='scheduled_tasks'").get()?.sql,
    ).toBe(schema);
    if (mode === "reopen") f.restart();
    else f.exporter.pollIdentities();
    let steps = 0;
    do {
      expect(metaValue(out, "ready")).toBe("1");
      expect(Number(metaValue(out, "generation"))).toBe(generation);
      expect(metaValue(out, "last_aux_schema_refresh")).toBeUndefined();
      expect(out.prepare("SELECT * FROM scheduled_tasks ORDER BY task_id").all()).toEqual(
        previousRows,
      );
      if (++steps > 500) throw new Error("export did not converge");
    } while (f.exporter.step());
    expect(metaValue(out, "last_rebuild_reason")).toBeUndefined();
    expect(JSON.parse(String(metaValue(out, "last_aux_schema_refresh"))).tables).toEqual([
      "scheduled_tasks",
    ]);
    expect(Number(metaValue(out, "generation"))).toBe(generation + 1);
    expect(out.prepare("SELECT thread_id FROM scheduled_tasks ORDER BY task_id").all()).toEqual(
      kind === "added unique"
        ? [{ thread_id: "one" }, { thread_id: "two" }]
        : [{ thread_id: "duplicate" }, { thread_id: "duplicate" }],
    );
    expect(
      out
        .prepare(
          "SELECT * FROM ardud_readonly_progress WHERE name NOT LIKE 'reconcile:%' ORDER BY name",
        )
        .all(),
    ).toEqual(progress);
  });
}

test("a projection change alongside an auxiliary change still fully rebuilds", () => {
  const f = fixture();
  f.finish();
  f.source.exec(`ALTER TABLE scheduled_tasks ADD COLUMN extra TEXT;
    ALTER TABLE orchestration_v2_projection_turn_items ADD COLUMN extra TEXT CHECK(extra IS NULL)`);
  f.restart();
  const out = f.connect();
  expect(metaValue(out, "ready")).toBe("1");
  expect(metaValue(out, "last_rebuild_reason")).toBe(
    "source schema changed: orchestration_v2_projection_turn_items",
  );
  expect(metaValue(out, "last_aux_schema_refresh")).toBeUndefined();
  f.finish();
  expect(metaValue(out, "ready")).toBe("1");
});

test("successive auxiliary changes replace the current schema without a rebuild", () => {
  const f = fixture();
  f.source.exec("INSERT INTO scheduled_tasks VALUES ('task','a')");
  f.finish();
  const out = f.connect();
  f.source.exec("ALTER TABLE scheduled_tasks ADD COLUMN extra TEXT DEFAULT 'new'");
  f.finish();
  expect(out.prepare("SELECT extra FROM scheduled_tasks").get()?.extra).toBe("new");
  const generation = metaValue(out, "generation");
  f.source.exec("ALTER TABLE scheduled_tasks DROP COLUMN extra");
  f.exporter.pollIdentities();
  expect(metaValue(out, "generation")).toBe(generation);
  expect(metaValue(out, "ready")).toBe("1");
  f.finish();
  expect(
    out
      .prepare("PRAGMA table_info(scheduled_tasks)")
      .all()
      .map((row) => row.name),
  ).toEqual(["task_id", "thread_id"]);
  expect(out.prepare("SELECT task_id FROM scheduled_tasks").all()).toEqual([{ task_id: "task" }]);
  expect(metaValue(out, "last_rebuild_reason")).toBeUndefined();
});

test("an auxiliary change does not hide a regressed event sequence", () => {
  const f = fixture();
  f.finish();
  f.source.exec(`ALTER TABLE scheduled_tasks ADD COLUMN extra TEXT;
    DELETE FROM orchestration_events`);
  f.restart();
  const out = f.connect();
  expect(metaValue(out, "ready")).toBe("1");
  expect(metaValue(out, "last_rebuild_reason")).toBe("source event sequence regressed");
  f.finish();
  expect(metaValue(out, "ready")).toBe("1");
});

test("an additive schema change mid-cycle discards the cycle, then backfills without unpublishing", () => {
  const f = fixture();
  f.finish();
  const out = f.connect();
  f.source.exec("INSERT INTO scheduled_tasks VALUES ('task','a')");
  expect(f.exporter.step()).toBe(true);
  f.source.exec("ALTER TABLE orchestration_v2_projection_turn_items ADD COLUMN extra TEXT");
  expect(() => f.exporter.step()).toThrow("schema changed");
  expect(metaValue(out, "ready")).toBe("1");
  expect(metaValue(out, "last_error")).toContain("schema changed");
  expect(out.prepare("SELECT count(*) AS n FROM scheduled_tasks").get()?.n).toBe(0);
  expect(() => f.exporter.step()).toThrow("schema changed");
  // Before 2026-11-10 every reopen threw here until someone deleted the file.
  f.restart();
  expect(metaValue(out, "last_rebuild_reason")).toBeUndefined();
  expect(metaValue(out, "ready")).toBe("1");
  f.finish(); // The column-only pass leaves newly inserted rows unpublished.
  expect(out.prepare("SELECT count(*) AS n FROM scheduled_tasks").get()?.n).toBe(0);
  f.finish();
  expect(metaValue(out, "ready")).toBe("1");
  expect(
    f
      .connect()
      .prepare("SELECT turn_item_id, extra FROM orchestration_v2_projection_turn_items")
      .all(),
  ).toEqual([{ turn_item_id: "stop", extra: null }]);
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

test("a midrun event regression retains the completed generation until its rebuild publishes", () => {
  const f = fixture(1);
  f.finish();
  const out = f.connect();
  const generation = metaValue(out, "generation");
  const watermark = metaValue(out, "updated_at");
  f.source.exec("DELETE FROM orchestration_events");
  expect(() => f.exporter.step()).toThrow("event sequence regressed");
  expect(metaValue(out, "ready")).toBe("1");
  expect(metaValue(out, "generation")).toBe(generation);
  expect(metaValue(out, "updated_at")).toBe(watermark);
  f.restart();
  do {
    expect(metaValue(out, "ready")).toBe("1");
    expect(metaValue(out, "generation")).toBe(generation);
    expect(metaValue(out, "updated_at")).toBe(watermark);
  } while (f.exporter.step());
  expect(Number(metaValue(out, "generation"))).toBe(Number(generation) + 1);
  expect(metaValue(out, "sequence")).toBe("0");
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
  ).toBe("1");
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

test("archive movement after target selection keeps the contiguous prefix and live duplicates", () => {
  const f = fixture();
  f.finish();
  f.exporter.close();
  const archivePath = NodePath.join(NodePath.dirname(f.options.sourcePath), "archive.sqlite");
  const cold = new NodeSqlite.DatabaseSync(archivePath);
  cleanups.push(() => cold.close());
  cold.exec(`PRAGMA journal_mode=WAL; CREATE TABLE ardud_identity(identity TEXT PRIMARY KEY); INSERT INTO ardud_identity VALUES ('test');
    CREATE TABLE ardud_events(sequence INTEGER PRIMARY KEY,event_type TEXT,stream_id TEXT,payload_json TEXT);
    INSERT INTO ardud_events VALUES (3,'thread.metadata-updated','a','{"id":"a","cold":true}');`);
  f.source
    .exec(`CREATE TABLE ardud_history_archive_identity(identity TEXT PRIMARY KEY); INSERT INTO ardud_history_archive_identity VALUES ('test');
    INSERT INTO orchestration_events VALUES (2,'thread.metadata-updated','a','{"id":"a","cold":true}'),(3,'thread.metadata-updated','a','{"id":"a","live":true}');
    UPDATE orchestration_v2_projection_threads SET payload_json='{"title":"new"}' WHERE thread_id='a'`);
  f.rebuilds.length = 0;
  const exporter = createReadonlyReplica(NodeSqlite, NodeFS, NodePath, {
    ...f.options,
    archivePath,
    onRebuildEvent: (event) => f.rebuilds.push(event),
  });
  cleanups.push(() => exporter.close());
  exporter.step();
  cold.exec(
    "INSERT INTO ardud_events VALUES (2,'thread.metadata-updated','a','{\"id\":\"a\",\"cold\":true}')",
  );
  f.source.exec("DELETE FROM orchestration_events WHERE sequence=2");
  const out = f.connect();
  for (let i = 0; exporter.step(); i++) {
    expect(metaValue(out, "ready")).toBe("1");
    if (i > 500) throw Error("no converge");
  }
  expect(f.rebuilds).toEqual([]);
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
    ALTER TABLE scheduled_tasks ADD COLUMN extra TEXT;
    DELETE FROM orchestration_v2_projection_threads WHERE thread_id='c';
    INSERT INTO orchestration_v2_projection_threads VALUES ('new','{}');`);
  const exporter = createReadonlyReplica(NodeSqlite, NodeFS, NodePath, f.options);
  cleanups.push(() => exporter.close());
  const out = f.connect();
  expect(metaValue(out, "last_rebuild_reason")).toBe("source database was replaced");
  expect(metaValue(out, "ready")).toBe("1");
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
    const exporter=(${createReadonlyReplica.toString()})(require('node:sqlite'),require('node:fs'),require('node:path'),workerData,(${resolveHistoryBasePath.toString()}));
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
  expect(metaValue(out, "ready")).toBe("1");
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

test("projection schema rebuilds retain the six-hour backoff", () => {
  const f = fixture();
  f.finish();
  f.source.exec(
    "ALTER TABLE orchestration_v2_projection_turn_items ADD COLUMN extra TEXT CHECK(extra IS NULL)",
  );
  f.restart();
  const out = f.connect();
  expect(metaValue(out, "ready")).toBe("1");
  expect(
    out.prepare("SELECT count(*) AS n FROM orchestration_v2_projection_threads").get()?.n,
  ).toBe(3);
  f.finish();
  const rebuiltAt = metaValue(out, "last_rebuild_at");
  f.source.exec(
    "ALTER TABLE orchestration_v2_projection_turn_items ADD COLUMN second TEXT CHECK(second IS NULL)",
  );
  expect(() => f.restart()).toThrow(expect.objectContaining({ code: "READONLY_REBUILD_HELD" }));
  expect(metaValue(out, "ready")).toBe("1");
  expect(metaValue(out, "last_rebuild_at")).toBe(rebuiltAt);
});

test("a different rebuild reason is not held back by the window", () => {
  let now = Date.parse("2026-11-10T10:00:00.000Z");
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const f = regressedFixture();
  f.source.exec("DELETE FROM orchestration_events WHERE sequence>=3");
  drive(openExporter(f));
  now += HOUR;
  f.source.exec(
    "ALTER TABLE orchestration_v2_projection_turn_items ADD COLUMN extra TEXT CHECK(extra IS NULL)",
  );
  drive(openExporter(f));
  const out = f.connect();
  expect(metaValue(out, "last_rebuild_reason")).toBe(
    "source schema changed: orchestration_v2_projection_turn_items",
  );
  expect(metaValue(out, "ready")).toBe("1");
});

test("a full rebuild pages privately while old and new readers retain the completed generation", () => {
  const f = fixture();
  f.finish();
  const old = f.connect();
  old.exec("BEGIN");
  const generation = metaValue(old, "generation");
  f.exporter.close();
  f.source.exec(
    "ALTER TABLE orchestration_v2_projection_run_attempts RENAME COLUMN payload_json TO owner_payload_json; INSERT INTO orchestration_v2_projection_run_attempts VALUES ('new','a')",
  );
  const exporter = openExporter(f);
  let steps = 0;
  while (exporter.step()) {
    expect(metaValue(old, "ready")).toBe("1");
    expect(metaValue(old, "generation")).toBe(generation);
    const fresh = f.connect();
    expect(metaValue(fresh, "ready")).toBe("1");
    expect(
      fresh.prepare("SELECT count(*) AS n FROM orchestration_v2_projection_run_attempts").get()?.n,
    ).toBe(0);
    if (++steps > 500) throw new Error("export did not converge");
  }
  expect(steps).toBeGreaterThan(3);
  expect(
    old.prepare("SELECT count(*) AS n FROM orchestration_v2_projection_run_attempts").get()?.n,
  ).toBe(0);
  const fresh = f.connect();
  expect(metaValue(fresh, "ready")).toBe("1");
  expect(Number(metaValue(fresh, "generation"))).toBe(Number(generation) + 1);
  expect(
    fresh.prepare("SELECT owner_payload_json FROM orchestration_v2_projection_run_attempts").get()
      ?.owner_payload_json,
  ).toBe("a");
  expect(metaValue(fresh, "rebuild_finished_at")).toBeTruthy();
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

test("exports slot ledger appends across generations and exporter restarts", () => {
  const f = fixture();
  f.source.exec(
    "INSERT INTO ardud_kanban_slot_events VALUES (1,'b','p','t','c','take','2026-11-13T01:00:00.000Z','start')",
  );
  f.finish();
  const out = f.connect();
  expect(out.prepare("SELECT kind FROM ardud_kanban_slot_events ORDER BY id").all()).toEqual([
    { kind: "take" },
  ]);
  f.source.exec(
    "INSERT INTO ardud_kanban_slot_events VALUES (2,'b','p','t',NULL,'release','2026-11-13T02:00:00.000Z','hold_end')",
  );
  f.restart();
  f.finish();
  expect(out.prepare("SELECT kind FROM ardud_kanban_slot_events ORDER BY id").all()).toEqual([
    { kind: "take" },
    { kind: "release" },
  ]);
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

test.each([60_000, 60_001])(
  "a completed %i-event prefix survives restart without delaying the next binding",
  (events) => {
    const f = fixture(100);
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    f.source.exec(
      "INSERT INTO orchestration_v2_projection_provider_threads VALUES ('binding','{}','a')",
    );
    f.finish();
    const out = f.connect();
    f.source.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<${events})
      INSERT INTO orchestration_events(event_type,stream_id,payload_json)
      SELECT 'thread.metadata-updated','a','{}' FROM n;`);
    let completed = false;
    for (let step = 0; step < 1_000; step++) {
      now += 10;
      if (!f.exporter.step()) {
        completed = true;
        break;
      }
    }
    expect(completed).toBe(true);
    expect(metaValue(out, "sequence")).toBe(String(events + 1));
    expect(metaValue(out, "identity_sequence")).toBe(String(events + 1));
    // Empty idle polls must not lose the completed scan high-water either.
    now += 1_000;
    expect(f.exporter.pollIdentities()).toBe(false);
    const rebuildProgress = metaValue(out, "rebuild_progress");
    f.diagnostics.length = 0;
    f.restart();
    expect(f.diagnostics).toEqual([
      {
        event: "open",
        sequence: events + 1,
        identitySequence: events + 1,
        sourceSequence: events + 1,
      },
    ]);
    expect(metaValue(out, "rebuild_progress")).toBe(rebuildProgress);
    f.source
      .exec(`UPDATE orchestration_v2_projection_provider_threads SET payload_json='{"nativeThreadRef":{"nativeId":"after-restart"}}' WHERE provider_thread_id='binding';
      INSERT INTO orchestration_events(event_type,stream_id,payload_json) VALUES ('provider-thread.updated','a','{"id":"binding"}');`);
    expect(f.exporter.pollIdentities()).toBe(true);
    expect(
      out
        .prepare(
          "SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id='binding'",
        )
        .get()?.payload_json,
    ).toContain('"after-restart"');
    expect(metaValue(out, "sequence")).toBe(String(events + 1));
    expect(metaValue(out, "identity_sequence")).toBe(String(events + 2));
    expect(f.diagnostics).toContainEqual({ event: "replay", replayEvents: 1, replayMs: 0 });
    now += 1_000;
    f.exporter.pollIdentities();
    expect(f.diagnostics.filter(({ event }) => event === "replay")).toHaveLength(1);
  },
);

test("an idle restart reports an empty replay once without changing rebuild diagnostics", () => {
  const f = fixture();
  f.finish();
  const out = f.connect();
  const rebuildProgress = metaValue(out, "rebuild_progress");
  f.diagnostics.length = 0;
  f.restart();
  expect(f.exporter.pollIdentities()).toBe(false);
  expect(f.exporter.pollIdentities()).toBe(false);
  expect(f.diagnostics).toEqual([
    { event: "open", sequence: 1, identitySequence: 1, sourceSequence: 1 },
    { event: "replay", replayEvents: 0, replayMs: expect.any(Number) },
  ]);
  expect(metaValue(out, "rebuild_progress")).toBe(rebuildProgress);
});

test("an abandoned cycle retains the committed identity cursor and replays a pending binding on restart", () => {
  const f = fixture(2);
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  f.source.exec(
    "INSERT INTO orchestration_v2_projection_provider_threads VALUES ('binding','{}','a')",
  );
  f.finish();
  const out = f.connect();
  // Drain bootstrap identity pages so subsequent polls start behind the new prefix.
  while (f.exporter.pollIdentities()) {}
  const cursor = metaValue(out, "identity_sequence");
  f.source.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<40)
    INSERT INTO orchestration_events(event_type,stream_id,payload_json)
    SELECT 'thread.metadata-updated','a','{}' FROM n;
    UPDATE orchestration_v2_projection_provider_threads SET payload_json='{"nativeThreadRef":{"nativeId":"pending"}}' WHERE provider_thread_id='binding';
    INSERT INTO orchestration_events(event_type,stream_id,payload_json) VALUES ('provider-thread.updated','a','{"id":"binding"}');`);
  f.exporter.takeMetrics();
  for (let step = 0; step < 20; step++) {
    expect(f.exporter.step()).toBe(true);
    if (f.exporter.takeMetrics().phaseSteps.eventCatchup) break;
    if (step === 19) throw new Error("event catchup did not start");
  }
  now += 1_000;
  f.exporter.pollIdentities();
  expect(metaValue(out, "identity_sequence")).toBe(cursor);
  expect(metaValue(out, "sequence")).toBe("1");
  f.diagnostics.length = 0;
  f.restart();
  expect(f.diagnostics).toEqual([
    { event: "open", sequence: 1, identitySequence: Number(cursor), sourceSequence: 42 },
  ]);
  for (let page = 0; page < 22; page++) {
    now += 10;
    f.exporter.pollIdentities();
    if (page < 20) expect(f.diagnostics).toHaveLength(1);
  }
  expect(f.diagnostics).toContainEqual({ event: "replay", replayEvents: 41, replayMs: 210 });
  expect(f.diagnostics.filter(({ event }) => event === "replay")).toHaveLength(1);
  expect(
    out
      .prepare(
        "SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id='binding'",
      )
      .get()?.payload_json,
  ).toContain('"pending"');
  expect(metaValue(out, "identity_sequence")).toBe("42");
  expect(metaValue(out, "sequence")).toBe("1");
  f.finish();
  expect(metaValue(out, "identity_sequence")).toBe("42");
  expect(metaValue(out, "sequence")).toBe("42");
});

test.each([
  "extra TEXT",
  "extra TEXT DEFAULT 'default, value'",
  "extra TEXT NOT NULL DEFAULT 'value'",
])(
  "additive column %s only backfills its table and keeps the published generation",
  (definition) => {
    const f = fixture(1);
    f.source.exec(
      "INSERT INTO orchestration_v2_projection_run_attempts VALUES ('one','a'),('two','a'); INSERT INTO orchestration_v2_projection_messages VALUES ('message','{\"old\":true}')",
    );
    f.finish();
    const out = f.connect();
    const generation = metaValue(out, "generation");
    f.exporter.close();
    f.source.exec(
      `ALTER TABLE orchestration_v2_projection_run_attempts ADD COLUMN ${definition}; UPDATE orchestration_v2_projection_run_attempts SET extra='backfilled'`,
    );
    // This unrelated, eventless update must not be swept by the column backfill.
    f.source.exec("UPDATE orchestration_v2_projection_messages SET payload_json='{}'");
    const events: Array<{ kind: string; event: string; rows: number }> = [];
    const exporter = createReadonlyReplica(NodeSqlite, NodeFS, NodePath, {
      ...f.options,
      onRebuildEvent: (event) => events.push(event),
    });
    cleanups.push(() => exporter.close());
    do {
      expect(metaValue(out, "ready")).toBe("1");
      expect(metaValue(out, "generation")).toBe(generation);
    } while (exporter.step());
    expect(
      out
        .prepare("SELECT extra FROM orchestration_v2_projection_run_attempts ORDER BY attempt_id")
        .all(),
    ).toEqual([{ extra: "backfilled" }, { extra: "backfilled" }]);
    expect(
      out.prepare("SELECT payload_json FROM orchestration_v2_projection_messages").get()
        ?.payload_json,
    ).toBe('{"old":true}');
    expect(metaValue(out, "schema:orchestration_v2_projection_run_attempts")).toContain(definition);
    expect(metaValue(out, "last_rebuild_reason")).toBeUndefined();
    expect(events.map((event) => [event.kind, event.event])).toEqual([
      ["additive", "start"],
      ["additive", "publish"],
    ]);
    expect(events.at(-1)?.rows).toBe(2);
  },
);

test("an unready schema rebuild gets one immediate retry, then the persisted loop guard holds", () => {
  const f = fixture();
  f.finish();
  f.exporter.close();
  const db = new NodeSqlite.DatabaseSync(f.options.replicaPath);
  cleanups.push(() => db.close());
  const reason = "source schema changed: orchestration_v2_projection_run_attempts";
  db.prepare("INSERT OR REPLACE INTO ardud_readonly_meta VALUES (?,?)").run(
    "last_rebuild_reason",
    reason,
  );
  db.prepare("INSERT OR REPLACE INTO ardud_readonly_meta VALUES (?,?)").run(
    "last_rebuild_at",
    new Date().toISOString(),
  );
  db.prepare("UPDATE ardud_readonly_meta SET value='0' WHERE key='ready'").run();
  f.source.exec(
    "ALTER TABLE orchestration_v2_projection_run_attempts RENAME COLUMN payload_json TO owner_payload_json",
  );
  const retry = openExporter(f);
  expect(() => retry.step()).not.toThrow();
  retry.close();
  expect(() => openExporter(f)).toThrow("Automatic rebuild held back");
});

test("rebuild logs bounded page progress and aborts, without publishing a scan epoch", () => {
  let now = Date.parse("2026-11-14T12:00:00Z");
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const f = fixture(1);
  f.finish();
  f.exporter.close();
  f.source.exec(
    "ALTER TABLE orchestration_v2_projection_run_attempts RENAME COLUMN payload_json TO owner_payload_json",
  );
  const events: Array<{ event: string; pages: number; elapsedMs: number }> = [];
  const exporter = createReadonlyReplica(NodeSqlite, NodeFS, NodePath, {
    ...f.options,
    onRebuildEvent: (event) => events.push(event),
  });
  const out = f.connect();
  const generation = metaValue(out, "generation");
  now += 31_000;
  exporter.step();
  expect(events.map((event) => event.event)).toEqual(["start", "progress"]);
  expect(events[1]).toMatchObject({ pages: 1, elapsedMs: 31_000 });
  expect(metaValue(out, "generation")).toBe(generation);
  exporter.close();
  expect(events.at(-1)?.event).toBe("abort");
  expect(metaValue(out, "ready")).toBe("1");
});

test.each(["publish", "abort"])(
  "full rebuild diagnostics reach a separate Python reader before %s",
  (terminal) => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const f = fixture(1);
    f.finish();
    f.exporter.close();
    const writer = new NodeSqlite.DatabaseSync(f.options.replicaPath);
    writer.exec("UPDATE ardud_readonly_meta SET value='0' WHERE key='ready'");
    writer.close();
    f.source.exec(
      "ALTER TABLE orchestration_v2_projection_run_attempts RENAME COLUMN payload_json TO owner_payload_json",
    );
    const exporter = openExporter(f);
    const out = f.connect();
    const generation = metaValue(out, "generation");
    out.exec("BEGIN");
    expect(JSON.parse(String(metaValue(out, "rebuild_progress")))).toMatchObject({
      event: "start",
      table: "",
      rows: 0,
    });
    now += 31_000;
    exporter.step();
    expect(metaValue(out, "ready")).toBe("0");
    expect(metaValue(out, "generation")).toBe(generation);
    expect(JSON.parse(String(metaValue(out, "rebuild_progress")))).toMatchObject({
      event: "start",
    });
    const diagnosticsPath = f.options.replicaPath + ".rebuild.json";
    const diagnostics = () => JSON.parse(NodeFS.readFileSync(diagnosticsPath, "utf8"));
    expect(JSON.parse(diagnostics().rebuild_progress)).toMatchObject({
      event: "progress",
      table: "orchestration_v2_projection_threads",
      rows: 1,
      pages: 1,
      elapsedMs: 31_000,
    });
    expect(NodeFS.statSync(diagnosticsPath).mode & 0o777).toBe(0o600);
    const reader = NodeChildProcess.spawnSync(
      "/usr/bin/python3",
      [
        "-I",
        "-c",
        `
import sys
sys.path.insert(0, sys.argv[1])
import robob_readonly as ro
try:
    ro.state_ro(sys.argv[2])
except ro.ReplicaNotReady as exc:
    print(exc)
else:
    raise AssertionError("unready replica was accepted")
`,
        NodePath.resolve(import.meta.dirname, "../../../../../integrations/memory-system/src"),
        f.options.replicaPath,
      ],
      { encoding: "utf8", timeout: 5000 },
    );
    expect(reader.error).toBeUndefined();
    expect(reader.status, reader.stderr).toBe(0);
    expect(reader.stdout).toContain("table orchestration_v2_projection_threads, 1 rows");
    if (terminal === "publish") drive(exporter);
    else exporter.close();
    expect(JSON.parse(diagnostics().rebuild_progress).event).toBe(terminal);
    expect(Boolean(diagnostics().rebuild_finished_at)).toBe(terminal === "publish");
    out.exec("ROLLBACK");
  },
);

test.each([
  ["dropped column", "attempt_id TEXT PRIMARY KEY"],
  ["renamed column", "attempt_id TEXT PRIMARY KEY, owner_payload_json TEXT"],
  ["changed type", "attempt_id TEXT PRIMARY KEY, payload_json INTEGER"],
  ["new primary key", "attempt_id TEXT, payload_json TEXT PRIMARY KEY"],
  [
    "new constraint",
    "attempt_id TEXT PRIMARY KEY, payload_json TEXT CHECK(length(payload_json)>0)",
  ],
])("a %s takes the full publication path", (_kind, definition) => {
  const f = fixture();
  f.finish();
  f.exporter.close();
  const out = f.connect();
  const generation = Number(metaValue(out, "generation"));
  f.source.exec(
    `DROP TABLE orchestration_v2_projection_run_attempts; CREATE TABLE orchestration_v2_projection_run_attempts (${definition})`,
  );
  f.source.exec(
    "INSERT INTO orchestration_events(event_type,stream_id,payload_json) VALUES ('thread.metadata-updated','a','{}')",
  );
  f.diagnostics.length = 0;
  const events: ReadonlyRebuildEvent[] = [];
  const exporter = createReadonlyReplica(NodeSqlite, NodeFS, NodePath, {
    ...f.options,
    onDiagnosticEvent: (event) => f.diagnostics.push(event),
    onRebuildEvent: (event) => {
      events.push(event);
      if (event.event === "publish") {
        expect(event.sequence).toBe(Number(metaValue(out, "sequence")));
        expect(event.identitySequence).toBe(Number(metaValue(out, "identity_sequence")));
      }
    },
  });
  cleanups.push(() => exporter.close());
  expect(f.diagnostics).toEqual([
    { event: "open", sequence: 1, identitySequence: 1, sourceSequence: 2 },
  ]);
  drive(exporter);
  expect(events.map(({ kind, event }) => [kind, event])).toEqual([
    ["full", "start"],
    ["full", "publish"],
  ]);
  expect(metaValue(out, "ready")).toBe("1");
  expect(Number(metaValue(out, "generation"))).toBe(generation + 1);
  expect(events.at(-1)).toMatchObject({ sequence: 2, identitySequence: 2 });
});

test("a column backfill resumes after a worker restart without changing generation", () => {
  const f = fixture(1);
  f.source.exec(
    "INSERT INTO orchestration_v2_projection_run_attempts VALUES ('one','a'),('two','b')",
  );
  f.finish();
  const out = f.connect();
  const generation = metaValue(out, "generation");
  f.source.exec(
    "ALTER TABLE orchestration_v2_projection_run_attempts ADD COLUMN extra TEXT; UPDATE orchestration_v2_projection_run_attempts SET extra=payload_json",
  );
  f.restart();
  expect(f.exporter.step()).toBe(true);
  f.restart();
  f.finish();
  expect(metaValue(out, "ready")).toBe("1");
  expect(metaValue(out, "generation")).toBe(generation);
  expect(
    out
      .prepare("SELECT extra FROM orchestration_v2_projection_run_attempts ORDER BY attempt_id")
      .all(),
  ).toEqual([{ extra: "a" }, { extra: "b" }]);
});

test("repeated gaps during a full schema rebuild cannot publish a partial reset", () => {
  const f = fixture(1);
  f.finish();
  f.exporter.close();
  const out = f.connect();
  f.source.exec(
    "ALTER TABLE orchestration_v2_projection_run_attempts RENAME COLUMN payload_json TO owner_payload_json",
  );
  const exporter = openExporter(f);
  exporter.step();
  f.source.exec("INSERT INTO orchestration_events VALUES (3,'thread.metadata-updated','a','{}')");
  let gaps = 0;
  const stepMetrics = exporter.takeMetrics.bind(exporter);
  for (let i = 0; exporter.step(); i++) {
    expect(metaValue(out, "ready")).toBe("1");
    if (stepMetrics().phaseSteps.resetDelete && gaps++ === 0)
      f.source.exec(
        "INSERT INTO orchestration_events VALUES (5,'thread.metadata-updated','a','{}')",
      );
    if (i > 500) throw new Error("export did not converge");
  }
  expect(metaValue(out, "ready")).toBe("1");
  expect(metaValue(out, "sequence")).toBe("5");
});

test.each(["published", "full", "bootstrap"])(
  "nested gaps during %s report the original published readiness",
  (mode) => {
    const f = fixture(1);
    if (mode !== "bootstrap") f.finish();
    let exporter = f.exporter;
    if (mode === "full") {
      f.exporter.close();
      f.source.exec(
        "ALTER TABLE orchestration_v2_projection_run_attempts RENAME COLUMN payload_json TO owner_payload_json",
      );
      exporter = createReadonlyReplica(NodeSqlite, NodeFS, NodePath, {
        ...f.options,
        onRebuildEvent: (event) => f.rebuilds.push(event),
      });
      cleanups.push(() => exporter.close());
    }
    f.rebuilds.length = 0;
    exporter.step();
    f.source.exec("INSERT INTO orchestration_events VALUES (3,'thread.metadata-updated','a','{}')");
    let addedGap = false;
    const out = f.connect();
    for (let step = 0; exporter.step(); step++) {
      expect(metaValue(out, "ready")).toBe(mode === "bootstrap" ? "0" : "1");
      if (!addedGap && f.rebuilds.some((event) => event.kind === "events_reset")) {
        f.source.exec(
          "INSERT INTO orchestration_events VALUES (5,'thread.metadata-updated','a','{}')",
        );
        addedGap = true;
      }
      if (step > 500) throw new Error("nested resets did not converge");
    }
    const starts = f.rebuilds.filter(
      (event) => event.kind === "events_reset" && event.event === "start",
    );
    expect(starts).toHaveLength(2);
    expect(starts.map((event) => event.firstMissingSequence)).toEqual([2, 4]);
    expect(starts.map((event) => event.publishedReady)).toEqual(
      mode === "bootstrap" ? ["0", "0"] : ["1", "1"],
    );
    expect(metaValue(out, "ready")).toBe("1");
  },
);

test("column backfill cannot publish a run transition without its matching Stop item", () => {
  const f = fixture(1);
  f.source.exec(
    `INSERT INTO orchestration_v2_projection_runs VALUES ('run','a','{"status":"running"}')`,
  );
  f.finish();
  const out = f.connect();
  const generation = metaValue(out, "generation");
  const watermark = metaValue(out, "updated_at");
  f.source.exec(`ALTER TABLE orchestration_v2_projection_runs ADD COLUMN extra TEXT;
    UPDATE orchestration_v2_projection_runs SET extra='backfilled',payload_json='{"status":"interrupted"}';
    INSERT INTO orchestration_v2_projection_runs VALUES ('new-run','a','{"status":"interrupted"}','new');
    INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,type,payload_json) VALUES ('new-stop','run_interrupt_request','{}');
    INSERT INTO orchestration_events(event_type,stream_id,payload_json) VALUES
      ('run.updated','a','{"id":"run"}'),('run.created','a','{"id":"new-run"}'),('turn-item.updated','a','{"id":"new-stop"}');`);
  f.restart();
  do {
    expect(metaValue(out, "generation")).toBe(generation);
    expect(metaValue(out, "sequence")).toBe("1");
    expect(metaValue(out, "updated_at")).toBe(watermark);
    expect(metaValue(out, "ready")).toBe("1");
    expect(
      out
        .prepare("SELECT payload_json FROM orchestration_v2_projection_runs WHERE run_id='run'")
        .get()?.payload_json,
    ).toBe('{"status":"running"}');
    expect(
      out.prepare("SELECT 1 FROM orchestration_v2_projection_runs WHERE run_id='new-run'").get(),
    ).toBeUndefined();
    expect(
      out
        .prepare(
          "SELECT 1 FROM orchestration_v2_projection_turn_items WHERE turn_item_id='new-stop'",
        )
        .get(),
    ).toBeUndefined();
  } while (f.exporter.step());
  expect(
    out.prepare("SELECT extra FROM orchestration_v2_projection_runs WHERE run_id='run'").get()
      ?.extra,
  ).toBe("backfilled");
  f.finish();
  expect(
    out
      .prepare("SELECT payload_json FROM orchestration_v2_projection_runs WHERE run_id='run'")
      .get()?.payload_json,
  ).toBe('{"status":"interrupted"}');
  expect(
    out.prepare("SELECT 1 FROM orchestration_v2_projection_runs WHERE run_id='new-run'").get(),
  ).toBeDefined();
  expect(
    out
      .prepare("SELECT 1 FROM orchestration_v2_projection_turn_items WHERE turn_item_id='new-stop'")
      .get(),
  ).toBeDefined();
});

test("identity polling cannot publish old fields or new rows during a projection column backfill", () => {
  const f = fixture(1);
  f.finish();
  const out = f.connect();
  const generation = metaValue(out, "generation");
  const watermark = metaValue(out, "updated_at");
  f.source.exec(`ALTER TABLE orchestration_v2_projection_threads ADD COLUMN extra TEXT;
    UPDATE orchestration_v2_projection_threads SET extra='backfilled';
    UPDATE orchestration_v2_projection_threads SET payload_json='{"title":"new"}' WHERE thread_id='a';
    INSERT INTO orchestration_v2_projection_threads VALUES ('new','{}','new-row');
    INSERT INTO orchestration_events(event_type,stream_id,payload_json) VALUES
      ('thread.metadata-updated','a','{}'),('thread.created','new','{}')`);
  f.restart();
  do {
    expect(f.exporter.pollIdentities()).toBe(false);
    expect(metaValue(out, "ready")).toBe("1");
    expect(metaValue(out, "generation")).toBe(generation);
    expect(metaValue(out, "updated_at")).toBe(watermark);
    expect(metaValue(out, "sequence")).toBe("1");
    expect(
      out
        .prepare("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id='a'")
        .get()?.payload_json,
    ).toBe('{"title":"old"}');
    expect(
      out.prepare("SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id='new'").get(),
    ).toBeUndefined();
  } while (f.exporter.step());
  expect(
    out.prepare("SELECT extra FROM orchestration_v2_projection_threads WHERE thread_id='a'").get()
      ?.extra,
  ).toBe("backfilled");
  f.finish();
  expect(
    out
      .prepare("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id='a'")
      .get()?.payload_json,
  ).toBe('{"title":"new"}');
  expect(
    out.prepare("SELECT extra FROM orchestration_v2_projection_threads WHERE thread_id='new'").get()
      ?.extra,
  ).toBe("new-row");
});

test.each([
  ["inline UNIQUE", "extra TEXT UNIQUE", ""],
  ["named inline UNIQUE", "extra TEXT CONSTRAINT extra_unique UNIQUE", ""],
  [
    "unique index",
    "extra TEXT NOT NULL DEFAULT 'pending'",
    "CREATE UNIQUE INDEX extra_unique ON orchestration_v2_projection_run_attempts(extra)",
  ],
  [
    "unique expression index",
    "extra TEXT NOT NULL DEFAULT 'pending'",
    "CREATE UNIQUE INDEX extra_unique ON orchestration_v2_projection_run_attempts(lower(extra))",
  ],
  [
    "partial unique index",
    "extra TEXT NOT NULL DEFAULT 'pending'",
    "CREATE UNIQUE INDEX extra_unique ON orchestration_v2_projection_run_attempts(extra) WHERE extra IS NOT NULL",
  ],
  ["dependent CHECK", "extra TEXT CHECK(extra=payload_json)", ""],
])("%s added with a column uses a full rebuild", (_kind, definition, index) => {
  const f = fixture(1);
  f.source.exec(
    "INSERT INTO orchestration_v2_projection_run_attempts VALUES ('one','one'),('two','two')",
  );
  f.finish();
  f.exporter.close();
  const out = f.connect();
  f.source.exec(`DROP TABLE orchestration_v2_projection_run_attempts;
    CREATE TABLE orchestration_v2_projection_run_attempts (attempt_id TEXT PRIMARY KEY, payload_json TEXT, ${definition});
    INSERT INTO orchestration_v2_projection_run_attempts VALUES ('one','one','one'),('two','two','two'); ${index}`);
  const events: Array<{ kind: string; event: string }> = [];
  const exporter = createReadonlyReplica(NodeSqlite, NodeFS, NodePath, {
    ...f.options,
    onRebuildEvent: (event) => events.push(event),
  });
  cleanups.push(() => exporter.close());
  drive(exporter);
  expect(events[0]?.kind).toBe("full");
  expect(events.at(-1)?.event).toBe("publish");
  expect(metaValue(out, "ready")).toBe("1");
  expect(
    out
      .prepare("SELECT extra FROM orchestration_v2_projection_run_attempts ORDER BY attempt_id")
      .all(),
  ).toEqual([{ extra: "one" }, { extra: "two" }]);
});

test("a reused index name cannot hide a new uniqueness constraint", () => {
  const f = fixture(2, (source) =>
    source.exec(
      "INSERT INTO orchestration_v2_projection_run_attempts VALUES ('one','one'),('two','two'); CREATE INDEX extra_unique ON orchestration_v2_projection_run_attempts(payload_json)",
    ),
  );
  f.finish();
  f.exporter.close();
  f.source
    .exec(`DROP TABLE orchestration_v2_projection_run_attempts; CREATE TABLE orchestration_v2_projection_run_attempts (attempt_id TEXT PRIMARY KEY, payload_json TEXT, extra TEXT NOT NULL DEFAULT 'pending');
    INSERT INTO orchestration_v2_projection_run_attempts VALUES ('one','one','one'),('two','two','two'); CREATE UNIQUE INDEX extra_unique ON orchestration_v2_projection_run_attempts(extra)`);
  drive(openExporter(f));
  const out = f.connect();
  expect(metaValue(out, "last_rebuild_reason")).toBe(
    "source schema changed: orchestration_v2_projection_run_attempts",
  );
  expect(
    out.prepare("SELECT sql FROM sqlite_schema WHERE name='extra_unique'").get()?.sql,
  ).toContain("UNIQUE");
});

test("new expression indexes use a complete generation instead of temporary defaults", () => {
  const f = fixture(1);
  f.source.exec(
    "INSERT INTO orchestration_v2_projection_run_attempts VALUES ('one','a'),('two','a')",
  );
  f.finish();
  f.source
    .exec(`ALTER TABLE orchestration_v2_projection_run_attempts ADD COLUMN extra TEXT DEFAULT 'pending'; UPDATE orchestration_v2_projection_run_attempts SET extra='{"valid":true}';
    CREATE INDEX extra_expression ON orchestration_v2_projection_run_attempts(json_extract(extra,'$.valid'))`);
  f.restart();
  f.finish();
  const out = f.connect();
  expect(metaValue(out, "last_rebuild_reason")).toBe(
    "source schema changed: orchestration_v2_projection_run_attempts",
  );
  expect(
    out.prepare("SELECT 1 FROM sqlite_schema WHERE name='extra_expression'").get(),
  ).toBeDefined();
});

test("another additive migration retains unfinished column backfills", () => {
  const f = fixture(1);
  f.source.exec(
    "INSERT INTO orchestration_v2_projection_run_attempts VALUES ('one','a'),('two','b')",
  );
  f.finish();
  const out = f.connect();
  const generation = metaValue(out, "generation");
  f.source.exec(
    "ALTER TABLE orchestration_v2_projection_run_attempts ADD COLUMN first TEXT; UPDATE orchestration_v2_projection_run_attempts SET first=payload_json",
  );
  f.restart();
  f.exporter.step();
  f.source.exec(
    "ALTER TABLE orchestration_v2_projection_run_attempts ADD COLUMN second TEXT; UPDATE orchestration_v2_projection_run_attempts SET second=payload_json",
  );
  f.restart();
  f.finish();
  expect(metaValue(out, "generation")).toBe(generation);
  expect(
    out
      .prepare(
        "SELECT first,second FROM orchestration_v2_projection_run_attempts ORDER BY attempt_id",
      )
      .all(),
  ).toEqual([
    { first: "a", second: "a" },
    { first: "b", second: "b" },
  ]);
});

test.each(["CURRENT_TIMESTAMP", "CURRENT_DATE", "CURRENT_TIME", "(1 + 2)"])(
  "a nonconstant default %s uses full rebuild without getting stuck on reopen",
  (expression) => {
    const f = fixture();
    f.source.exec("INSERT INTO orchestration_v2_projection_run_attempts VALUES ('one','a')");
    f.finish();
    f.exporter.close();
    const out = f.connect();
    f.source
      .exec(`DROP TABLE orchestration_v2_projection_run_attempts; CREATE TABLE orchestration_v2_projection_run_attempts (attempt_id TEXT PRIMARY KEY, payload_json TEXT, extra TEXT DEFAULT ${expression});
    INSERT INTO orchestration_v2_projection_run_attempts(attempt_id,payload_json) VALUES ('one','a')`);
    const expected = f.source
      .prepare("SELECT extra FROM orchestration_v2_projection_run_attempts")
      .get()?.extra;
    const exporter = openExporter(f);
    drive(exporter);
    expect(metaValue(out, "ready")).toBe("1");
    expect(
      out.prepare("SELECT extra FROM orchestration_v2_projection_run_attempts").get()?.extra,
    ).toBe(expected);
    expect(metaValue(out, "last_rebuild_reason")).toBe(
      "source schema changed: orchestration_v2_projection_run_attempts",
    );
    exporter.close();
    expect(() => openExporter(f)).not.toThrow();
  },
);

test.each([
  "CREATE INDEX extra_expression ON orchestration_v2_projection_run_attempts(json_extract(extra,'$.valid'))",
  "CREATE INDEX extra_partial ON orchestration_v2_projection_run_attempts(extra) WHERE json_extract(extra,'$.valid')=1",
])("a deleted row's temporary default cannot poison %s", (index) => {
  const f = fixture();
  f.source.exec(
    "INSERT INTO orchestration_v2_projection_run_attempts VALUES ('one','a'),('deleted','a')",
  );
  f.finish();
  f.exporter.close();
  const out = f.connect();
  f.source
    .exec(`ALTER TABLE orchestration_v2_projection_run_attempts ADD COLUMN extra TEXT DEFAULT 'pending';
    UPDATE orchestration_v2_projection_run_attempts SET extra='{"valid":true}'; DELETE FROM orchestration_v2_projection_run_attempts WHERE attempt_id='deleted'; ${index}`);
  const exporter = openExporter(f);
  drive(exporter);
  expect(metaValue(out, "ready")).toBe("1");
  expect(
    out.prepare("SELECT attempt_id,extra FROM orchestration_v2_projection_run_attempts").all(),
  ).toEqual([{ attempt_id: "one", extra: '{"valid":true}' }]);
  exporter.close();
  expect(() => openExporter(f)).not.toThrow();
});

test("a plain nonunique index preserves the additive path, including rows awaiting deletion", () => {
  const f = fixture();
  f.source.exec(
    "INSERT INTO orchestration_v2_projection_run_attempts VALUES ('one','a'),('deleted','a')",
  );
  f.finish();
  const out = f.connect();
  const generation = metaValue(out, "generation");
  f.source
    .exec(`ALTER TABLE orchestration_v2_projection_run_attempts ADD COLUMN extra TEXT DEFAULT 'pending'; UPDATE orchestration_v2_projection_run_attempts SET extra='backfilled';
    DELETE FROM orchestration_v2_projection_run_attempts WHERE attempt_id='deleted'; CREATE INDEX extra_plain ON orchestration_v2_projection_run_attempts(extra)`);
  f.restart();
  f.finish();
  expect(metaValue(out, "generation")).toBe(generation);
  expect(metaValue(out, "last_rebuild_reason")).toBeUndefined();
  expect(out.prepare("SELECT 1 FROM sqlite_schema WHERE name='extra_plain'").get()).toBeDefined();
  for (let cycle = 0; cycle < 3; cycle++) f.finish();
  expect(
    out.prepare("SELECT attempt_id FROM orchestration_v2_projection_run_attempts").all(),
  ).toEqual([{ attempt_id: "one" }]);
});

test.each([
  [
    "removed unique",
    "CREATE UNIQUE INDEX old_constraint ON orchestration_v2_projection_run_attempts(payload_json)",
    "",
  ],
  [
    "downgraded unique",
    "CREATE UNIQUE INDEX old_constraint ON orchestration_v2_projection_run_attempts(payload_json)",
    "CREATE INDEX old_constraint ON orchestration_v2_projection_run_attempts(payload_json)",
  ],
  [
    "removed expression",
    "CREATE INDEX old_constraint ON orchestration_v2_projection_run_attempts(json_extract(payload_json,'$.v'))",
    "",
  ],
  [
    "removed partial",
    "CREATE INDEX old_constraint ON orchestration_v2_projection_run_attempts(attempt_id) WHERE json_extract(payload_json,'$.v')>0",
    "",
  ],
])("a %s index cannot strand subsequent publications", (_kind, previous, current) => {
  const f = fixture(2, (source) =>
    source.exec(
      `INSERT INTO orchestration_v2_projection_run_attempts VALUES ('one','{"v":1}'),('two','{"v":2}'); ${previous}`,
    ),
  );
  f.finish();
  f.exporter.close();
  const out = f.connect();
  expect(
    out.prepare("SELECT 1 FROM sqlite_schema WHERE name='old_constraint'").get(),
  ).toBeDefined();
  f.source
    .exec(`ALTER TABLE orchestration_v2_projection_run_attempts ADD COLUMN extra TEXT; DROP INDEX old_constraint;
    UPDATE orchestration_v2_projection_run_attempts SET payload_json='duplicate non-json'; ${current}`);
  const exporter = openExporter(f);
  drive(exporter);
  expect(metaValue(out, "last_rebuild_reason")).toBe(
    "source schema changed: orchestration_v2_projection_run_attempts",
  );
  expect(
    out.prepare("SELECT payload_json FROM orchestration_v2_projection_run_attempts").all(),
  ).toEqual([{ payload_json: "duplicate non-json" }, { payload_json: "duplicate non-json" }]);
  drive(exporter);
  exporter.close();
  const reopened = openExporter(f);
  drive(reopened);
  expect(metaValue(out, "ready")).toBe("1");
});

test.each(["earlier parent", "later parent", "cyclic parents"])(
  "new foreign keys with %s publish as a complete generation",
  (kind) => {
    const f = fixture();
    f.source.exec(
      "INSERT INTO orchestration_v2_projection_messages VALUES ('message','{}'); INSERT INTO orchestration_v2_projection_runs VALUES ('run','a','{}')",
    );
    f.finish();
    f.exporter.close();
    const out = f.connect();
    if (kind === "later parent") {
      f.source
        .exec(`ALTER TABLE orchestration_v2_projection_messages ADD COLUMN owner_item TEXT REFERENCES orchestration_v2_projection_turn_items(turn_item_id);
      INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,type,payload_json) VALUES ('new-parent','user_message','{}');
      UPDATE orchestration_v2_projection_messages SET owner_item='new-parent'`);
    } else {
      f.source
        .exec(`ALTER TABLE orchestration_v2_projection_messages ADD COLUMN owner_run TEXT REFERENCES orchestration_v2_projection_runs(run_id);
      INSERT INTO orchestration_v2_projection_runs VALUES ('new-parent','a','{}');
      UPDATE orchestration_v2_projection_messages SET owner_run='new-parent'`);
      if (kind === "cyclic parents")
        f.source
          .exec(`ALTER TABLE orchestration_v2_projection_runs ADD COLUMN owner_message TEXT REFERENCES orchestration_v2_projection_messages(message_id);
      UPDATE orchestration_v2_projection_runs SET owner_message='message'`);
    }
    const exporter = openExporter(f);
    drive(exporter);
    expect(metaValue(out, "ready")).toBe("1");
    expect(metaValue(out, "last_rebuild_reason")).toContain("source schema changed:");
    expect(out.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    drive(exporter);
    exporter.close();
    drive(openExporter(f));
    expect(metaValue(out, "ready")).toBe("1");
  },
);

test("auxiliary foreign keys use main constraints and publish parents and children together", () => {
  const f = fixture();
  f.source.exec("INSERT INTO scheduled_tasks VALUES ('task','a')");
  f.finish();
  const out = f.connect();
  f.source
    .exec(`ALTER TABLE scheduled_tasks ADD COLUMN owner_import TEXT REFERENCES ardud_opencode_import(native_session_id);
    INSERT INTO ardud_opencode_import VALUES ('parent','a'); UPDATE scheduled_tasks SET owner_import='parent'`);
  f.restart();
  f.finish();
  expect(metaValue(out, "ready")).toBe("1");
  expect(out.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  f.source.exec(`INSERT INTO ardud_opencode_import VALUES ('next-parent','a');
    UPDATE scheduled_tasks SET owner_import='next-parent'; DELETE FROM ardud_opencode_import WHERE native_session_id='parent'`);
  f.finish();
  expect(out.prepare("SELECT owner_import FROM scheduled_tasks").get()?.owner_import).toBe(
    "next-parent",
  );
  expect(out.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  f.restart();
  f.finish();
  expect(metaValue(out, "ready")).toBe("1");
});

test.each([
  [
    "unique",
    "CREATE UNIQUE INDEX resumed_index ON orchestration_v2_projection_run_attempts(extra)",
  ],
  [
    "expression",
    "CREATE INDEX resumed_index ON orchestration_v2_projection_run_attempts(json_extract(extra,'$.valid'))",
  ],
  [
    "partial",
    "CREATE INDEX resumed_index ON orchestration_v2_projection_run_attempts(extra) WHERE json_extract(extra,'$.valid')=1",
  ],
])("a new %s index during a paused column backfill selects full rebuild", (kind, index) => {
  const f = fixture(1);
  f.source.exec(
    "INSERT INTO orchestration_v2_projection_run_attempts VALUES ('keep','a'),('deleted1','a'),('deleted2','a')",
  );
  f.finish();
  f.source
    .exec(`ALTER TABLE orchestration_v2_projection_run_attempts ADD COLUMN extra TEXT DEFAULT 'pending';
    UPDATE orchestration_v2_projection_run_attempts SET extra=${kind === "unique" ? "attempt_id" : "'{\"valid\":true}'"}`);
  f.restart();
  f.exporter.step();
  f.exporter.close();
  f.source.exec(
    `DELETE FROM orchestration_v2_projection_run_attempts WHERE attempt_id<>'keep'; ${index}`,
  );
  const exporter = openExporter(f);
  drive(exporter);
  const out = f.connect();
  expect(metaValue(out, "last_rebuild_reason")).toBe(
    "source schema changed: orchestration_v2_projection_run_attempts",
  );
  expect(
    out.prepare("SELECT attempt_id FROM orchestration_v2_projection_run_attempts").all(),
  ).toEqual([{ attempt_id: "keep" }]);
  exporter.close();
  drive(openExporter(f));
  expect(metaValue(out, "ready")).toBe("1");
});

test.each([
  [
    "added unique",
    "",
    "UPDATE orchestration_v2_projection_run_attempts SET payload_json=attempt_id; CREATE UNIQUE INDEX index_only ON orchestration_v2_projection_run_attempts(payload_json)",
  ],
  [
    "removed unique",
    "CREATE UNIQUE INDEX index_only ON orchestration_v2_projection_run_attempts(payload_json)",
    "DROP INDEX index_only; UPDATE orchestration_v2_projection_run_attempts SET payload_json='duplicate'",
  ],
  [
    "downgraded unique",
    "CREATE UNIQUE INDEX index_only ON orchestration_v2_projection_run_attempts(payload_json)",
    "DROP INDEX index_only; CREATE INDEX index_only ON orchestration_v2_projection_run_attempts(payload_json); UPDATE orchestration_v2_projection_run_attempts SET payload_json='duplicate'",
  ],
  [
    "removed expression",
    "CREATE INDEX index_only ON orchestration_v2_projection_run_attempts(json_extract(payload_json,'$.v'))",
    "DROP INDEX index_only; UPDATE orchestration_v2_projection_run_attempts SET payload_json='duplicate'",
  ],
  [
    "removed partial",
    "CREATE INDEX index_only ON orchestration_v2_projection_run_attempts(attempt_id) WHERE json_extract(payload_json,'$.v')>0",
    "DROP INDEX index_only; UPDATE orchestration_v2_projection_run_attempts SET payload_json='duplicate'",
  ],
])("%s without any table SQL change cannot strand the export", (kind, previous, mutation) => {
  const f = fixture(2, (source) =>
    source.exec(
      `INSERT INTO orchestration_v2_projection_run_attempts VALUES ('one','{"v":1}'),('two','{"v":${kind === "added unique" ? 1 : 2}}'); ${previous}`,
    ),
  );
  f.finish();
  f.exporter.close();
  const schema = f.source
    .prepare("SELECT sql FROM sqlite_schema WHERE name='orchestration_v2_projection_run_attempts'")
    .get()?.sql;
  f.source.exec(mutation);
  expect(
    f.source
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE name='orchestration_v2_projection_run_attempts'",
      )
      .get()?.sql,
  ).toBe(schema);
  const exporter = openExporter(f);
  drive(exporter);
  const out = f.connect();
  expect(metaValue(out, "last_rebuild_reason")).toBe(
    "source schema changed: orchestration_v2_projection_run_attempts",
  );
  expect(
    out
      .prepare(
        "SELECT payload_json FROM orchestration_v2_projection_run_attempts ORDER BY attempt_id",
      )
      .all(),
  ).toEqual(
    kind === "added unique"
      ? [{ payload_json: "one" }, { payload_json: "two" }]
      : [{ payload_json: "duplicate" }, { payload_json: "duplicate" }],
  );
  exporter.close();
  drive(openExporter(f));
  expect(metaValue(out, "ready")).toBe("1");
});

const identityVersionTables = [
  ["orchestration_v2_projection_threads", "thread_id", "threads"],
  ["orchestration_v2_projection_provider_threads", "provider_thread_id", "providers"],
  ["orchestration_v2_projection_provider_turns", "provider_turn_id", "turns"],
  ["orchestration_v2_projection_subagents", "subagent_id", "subagents"],
  ["ardud_opencode_import", "native_session_id", "imports"],
] as const;

function identityVersionFixture(batchSize = 100) {
  return fixture(batchSize, (source) => {
    for (const [name, primary] of identityVersionTables) {
      if (name === "ardud_opencode_import")
        source.exec(`DROP TABLE ${name}; CREATE TABLE ${name} (
          native_session_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL UNIQUE,
          imported_at TEXT NOT NULL, payload_json TEXT DEFAULT '{}'
        )`);
      source.exec(`ALTER TABLE ${name} ADD COLUMN identity_scalar TEXT DEFAULT 'before';
        ALTER TABLE ${name} ADD COLUMN updated_at TEXT DEFAULT '2026-11-14T00:00:00Z';
        ALTER TABLE ${name} ADD COLUMN deleted_at TEXT`);
      if (name.endsWith("_provider_turns"))
        source.exec(`ALTER TABLE ${name} ADD COLUMN thread_id TEXT;
          ALTER TABLE ${name} ADD COLUMN node_id TEXT`);
      for (const id of ["version-main", "version-peer"]) {
        if (name === "ardud_opencode_import")
          source
            .prepare(
              `INSERT INTO ${name}(native_session_id,thread_id,imported_at) VALUES (?,?,'2026-11-14T00:00:00Z')`,
            )
            .run(id, `${id}-owner`);
        else source.prepare(`INSERT INTO ${name}(${primary},payload_json) VALUES (?,'{}')`).run(id);
      }
    }
  });
}

const identityCensus = (db: NodeSqlite.DatabaseSync) =>
  db
    .prepare(
      "SELECT table_name,row_id,version FROM ardud_readonly_identity_versions ORDER BY table_name,row_id",
    )
    .all();
const identityVersion = (db: NodeSqlite.DatabaseSync, name: string, id = "version-main") =>
  Number(
    db
      .prepare(
        "SELECT version FROM ardud_readonly_identity_versions WHERE table_name=? AND row_id=?",
      )
      .get(name, id)?.version,
  );
const identitySequenceValue = (db: NodeSqlite.DatabaseSync) =>
  Number(
    db
      .prepare("SELECT seq FROM sqlite_sequence WHERE name='ardud_readonly_identity_versions'")
      .get()?.seq ?? 0,
  );
function expectIdentityCoverage(db: NodeSqlite.DatabaseSync) {
  expect(metaValue(db, "identity_versions_schema")).toBe("1");
  expect(
    db
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='ardud_readonly_identity_versions'",
      )
      .get(),
  ).toBeDefined();
  expect(
    db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='trigger' AND name GLOB 'ardud_identity_*' ORDER BY name",
      )
      .all()
      .map((r) => r.name),
  ).toEqual(
    identityVersionTables
      .flatMap(([, , suffix]) =>
        ["insert", "update", "delete"].map((action) => `ardud_identity_${suffix}_${action}`),
      )
      .sort(),
  );
  expect(identityCensus(db).map(({ table_name, row_id }) => ({ table_name, row_id }))).toEqual(
    identityVersionTables
      .flatMap(([name, primary]) =>
        db
          .prepare(
            `SELECT '${name}' AS table_name,${primary} AS row_id FROM ${name} ORDER BY ${primary}`,
          )
          .all(),
      )
      .sort(
        (a, b) =>
          String(a.table_name).localeCompare(String(b.table_name)) ||
          String(a.row_id).localeCompare(String(b.row_id)),
      ),
  );
}
function emitIdentityEvent(source: NodeSqlite.DatabaseSync, suffix: string, id = "version-main") {
  const event =
    suffix === "threads"
      ? "thread.metadata-updated"
      : suffix === "providers"
        ? "provider-thread.updated"
        : suffix === "turns"
          ? "provider-turn.updated"
          : "subagent.updated";
  source
    .prepare("INSERT INTO orchestration_events(event_type,stream_id,payload_json) VALUES (?,?,?)")
    .run(event, id, JSON.stringify({ id }));
}
function writeReplica(f: ReturnType<typeof fixture>, body: (db: NodeSqlite.DatabaseSync) => void) {
  const db = new NodeSqlite.DatabaseSync(f.options.replicaPath);
  try {
    body(db);
  } finally {
    db.close();
  }
}

test("identity versions: fresh publication covers all five tables, including deleted and unbound rows", () => {
  const f = identityVersionFixture();
  f.source.exec(
    "UPDATE orchestration_v2_projection_threads SET deleted_at='deleted' WHERE thread_id='version-main'",
  );
  f.finish();
  const out = f.connect();
  expectIdentityCoverage(out);
  expect(identityCensus(out)).toHaveLength(13);
  expect(
    f.source
      .prepare(
        "SELECT name FROM sqlite_schema WHERE name LIKE 'ardud_identity_%' OR name='ardud_readonly_identity_versions'",
      )
      .all(),
  ).toEqual([]);
});

test("identity versions: upgrade backfills existing rows without changing payloads or lineage metadata", () => {
  const f = identityVersionFixture();
  f.finish();
  f.exporter.close();
  const out = f.connect();
  const payloads = identityVersionTables.map(([name]) =>
    out.prepare(`SELECT * FROM ${name}`).all(),
  );
  const lineage = out
    .prepare("SELECT * FROM ardud_readonly_meta WHERE key LIKE 'lineage_%' ORDER BY key")
    .all();
  writeReplica(f, (db) => {
    for (const [, , suffix] of identityVersionTables)
      for (const action of ["insert", "update", "delete"])
        db.exec(`DROP TRIGGER ardud_identity_${suffix}_${action}`);
    db.exec(
      "DROP TABLE ardud_readonly_identity_versions; DELETE FROM ardud_readonly_meta WHERE key='identity_versions_schema'",
    );
  });
  f.restart();
  expectIdentityCoverage(out);
  expect(identityVersionTables.map(([name]) => out.prepare(`SELECT * FROM ${name}`).all())).toEqual(
    payloads,
  );
  expect(
    out.prepare("SELECT * FROM ardud_readonly_meta WHERE key LIKE 'lineage_%' ORDER BY key").all(),
  ).toEqual(lineage);
});

for (const [name, primary, suffix] of identityVersionTables) {
  test.each(["identity_scalar", "payload_json"])(
    `identity versions: same-timestamp ${suffix} %s edit changes only its row`,
    (column) => {
      const f = identityVersionFixture();
      f.finish();
      const out = f.connect();
      const before = identityCensus(out);
      const version = identityVersion(out, name);
      f.source
        .prepare(`UPDATE ${name} SET ${column}=? WHERE ${primary}='version-main'`)
        .run(column === "payload_json" ? '{"edited":true}' : "after");
      if (suffix !== "imports") emitIdentityEvent(f.source, suffix);
      f.finish();
      expect(identityVersion(out, name)).toBeGreaterThan(version);
      expect(
        identityCensus(out).filter(
          (row) => row.table_name !== name || row.row_id !== "version-main",
        ),
      ).toEqual(before.filter((row) => row.table_name !== name || row.row_id !== "version-main"));
      expect(
        out.prepare(`SELECT updated_at FROM ${name} WHERE ${primary}='version-main'`).get()
          ?.updated_at,
      ).toBe("2026-11-14T00:00:00Z");
      expectIdentityCoverage(out);
    },
  );
}

test("identity versions: mutable provider turn owner and node upsert gets a fresh version", () => {
  const f = identityVersionFixture();
  f.finish();
  const out = f.connect();
  const name = identityVersionTables[2][0];
  const before = identityVersion(out, name);
  f.source.exec(
    `INSERT INTO ${name}(provider_turn_id,thread_id,node_id,payload_json) VALUES ('version-main','new-owner','new-node','{}') ON CONFLICT(provider_turn_id) DO UPDATE SET thread_id=excluded.thread_id,node_id=excluded.node_id`,
  );
  emitIdentityEvent(f.source, "turns");
  f.finish();
  expect(identityVersion(out, name)).toBeGreaterThan(before);
  expect(
    out
      .prepare(`SELECT thread_id,node_id FROM ${name} WHERE provider_turn_id='version-main'`)
      .get(),
  ).toEqual({ thread_id: "new-owner", node_id: "new-node" });
});

test("identity versions: soft deletes advance and hard deletes reconcile away", () => {
  const f = identityVersionFixture();
  f.finish();
  const out = f.connect();
  const before = identityVersionTables.map(([name]) => identityVersion(out, name));
  for (const [name, primary, suffix] of identityVersionTables) {
    f.source.exec(`UPDATE ${name} SET deleted_at='deleted' WHERE ${primary}='version-main'`);
    if (suffix !== "imports") emitIdentityEvent(f.source, suffix);
  }
  f.finish();
  identityVersionTables.forEach(([name], i) =>
    expect(identityVersion(out, name)).toBeGreaterThan(before[i]!),
  );
  for (const [name, primary] of identityVersionTables)
    f.source.exec(`DELETE FROM ${name} WHERE ${primary}='version-main'`);
  for (let i = 0; i < 8; i++) f.finish();
  expectIdentityCoverage(out);
  expect(identityCensus(out).some((row) => row.row_id === "version-main")).toBe(false);
});

test("identity versions: delete/reinsert and source rowid reuse keep the exact key set", () => {
  const f = identityVersionFixture();
  f.finish();
  const out = f.connect();
  const name = identityVersionTables[0][0];
  const before = identityVersion(out, name);
  const rowid = f.source
    .prepare(`SELECT rowid FROM ${name} WHERE thread_id='version-main'`)
    .get()?.rowid;
  f.source.exec(`DELETE FROM ${name} WHERE thread_id='version-main'`);
  emitIdentityEvent(f.source, "threads");
  f.finish();
  expect(Number.isNaN(identityVersion(out, name))).toBe(true);
  f.source
    .prepare(`INSERT INTO ${name}(rowid,thread_id,payload_json) VALUES (?,'version-main','{}')`)
    .run(rowid!);
  emitIdentityEvent(f.source, "threads");
  f.finish();
  expect(identityVersion(out, name)).toBeGreaterThan(before);
  f.source.exec(`DELETE FROM ${name} WHERE thread_id='version-main'`);
  f.source
    .prepare(`INSERT INTO ${name}(rowid,thread_id,payload_json) VALUES (?,'reused','{}')`)
    .run(rowid!);
  emitIdentityEvent(f.source, "threads");
  emitIdentityEvent(f.source, "threads", "reused");
  f.finish();
  expect(Number.isNaN(identityVersion(out, name))).toBe(true);
  expect(identityVersion(out, name, "reused")).toBeGreaterThan(before);
  expectIdentityCoverage(out);
});

test.each(identityVersionTables)(
  "identity versions: %s primary key updates remove OLD and NEW stale keys",
  (name, primary) => {
    const f = identityVersionFixture();
    f.finish();
    const out = f.connect();
    const before = identityVersion(out, name);
    writeReplica(f, (db) => {
      db.prepare(
        "INSERT INTO ardud_readonly_identity_versions(table_name,row_id) VALUES (?,'renamed')",
      ).run(name);
      db.exec(`UPDATE ${name} SET ${primary}='renamed' WHERE ${primary}='version-main'`);
    });
    expect(Number.isNaN(identityVersion(out, name))).toBe(true);
    expect(identityVersion(out, name, "renamed")).toBeGreaterThan(before);
    expectIdentityCoverage(out);
  },
);

test("identity versions: auxiliary replacement updates and deletes converge", () => {
  const f = identityVersionFixture();
  f.finish();
  const out = f.connect();
  const name = identityVersionTables[4][0];
  const before = identityVersion(out, name);
  f.source.exec(
    `UPDATE ${name} SET payload_json='{"new":true}' WHERE native_session_id='version-main'; DELETE FROM ${name} WHERE native_session_id='version-peer'`,
  );
  f.finish();
  expect(identityVersion(out, name)).toBeGreaterThan(before);
  expect(Number.isNaN(identityVersion(out, name, "version-peer"))).toBe(true);
  const updated = identityVersion(out, name);
  f.source.exec(
    `INSERT OR REPLACE INTO ${name}(native_session_id,thread_id,imported_at) VALUES ('version-main','replacement-owner','2026-11-14T00:00:00Z')`,
  );
  f.finish();
  expect(identityVersion(out, name)).toBeGreaterThan(updated);
  expectIdentityCoverage(out);
});

const importReplacements = [
  {
    kind: "new session takes an existing owner",
    mutation:
      "INSERT OR REPLACE INTO ardud_opencode_import(native_session_id,thread_id,imported_at) VALUES ('replacement','version-main-owner','2026-11-14T00:00:00Z')",
    expected: [
      ["replacement", "version-main-owner"],
      ["version-peer", "version-peer-owner"],
    ],
    changed: ["replacement"],
    removed: ["version-main"],
  },
  {
    kind: "existing session takes another session's owner",
    mutation:
      "INSERT OR REPLACE INTO ardud_opencode_import(native_session_id,thread_id,imported_at) VALUES ('version-main','version-peer-owner','2026-11-14T00:00:00Z')",
    expected: [["version-main", "version-peer-owner"]],
    changed: ["version-main"],
    removed: ["version-peer"],
  },
  {
    kind: "existing session changes to an unused owner",
    mutation:
      "INSERT OR REPLACE INTO ardud_opencode_import(native_session_id,thread_id,imported_at) VALUES ('version-main','unused-owner','2026-11-14T00:00:00Z')",
    expected: [
      ["version-main", "unused-owner"],
      ["version-peer", "version-peer-owner"],
    ],
    changed: ["version-main"],
    removed: [],
  },
  {
    kind: "existing session keeps its owner and changes payload",
    mutation: `INSERT OR REPLACE INTO ardud_opencode_import(native_session_id,thread_id,imported_at,payload_json) VALUES ('version-main','version-main-owner','2026-11-14T00:00:00Z','{"replacement":true}')`,
    expected: [
      ["version-main", "version-main-owner"],
      ["version-peer", "version-peer-owner"],
    ],
    changed: ["version-main"],
    removed: [],
  },
  {
    kind: "surviving sessions swap owners",
    mutation:
      "INSERT OR REPLACE INTO ardud_opencode_import(native_session_id,thread_id,imported_at) VALUES ('version-main','version-peer-owner','2026-11-14T00:00:00Z'); INSERT OR REPLACE INTO ardud_opencode_import(native_session_id,thread_id,imported_at) VALUES ('version-peer','version-main-owner','2026-11-14T00:00:00Z')",
    expected: [
      ["version-main", "version-peer-owner"],
      ["version-peer", "version-main-owner"],
    ],
    changed: ["version-main", "version-peer"],
    removed: [],
  },
  {
    kind: "new session takes an owner released by a surviving session",
    mutation:
      "UPDATE ardud_opencode_import SET thread_id='unused-owner' WHERE native_session_id='version-main'; INSERT INTO ardud_opencode_import(native_session_id,thread_id,imported_at) VALUES ('replacement','version-main-owner','2026-11-14T00:00:00Z')",
    expected: [
      ["replacement", "version-main-owner"],
      ["version-main", "unused-owner"],
      ["version-peer", "version-peer-owner"],
    ],
    changed: ["replacement", "version-main"],
    removed: [],
  },
];

test.each(importReplacements)(
  "identity versions: import replacement when $kind is atomic",
  ({ mutation, expected, changed, removed }) => {
    const f = identityVersionFixture(1);
    const name = identityVersionTables[4][0];
    f.source.exec(
      "INSERT INTO ardud_opencode_import(native_session_id,thread_id,imported_at) VALUES ('stable','stable-owner','2026-11-14T00:00:00Z')",
    );
    f.finish();
    const out = f.connect();
    const pinned = f.connect();
    pinned.exec("BEGIN");
    const before = identityCensus(pinned);
    const sequence = identitySequenceValue(pinned);
    f.source.exec(mutation);
    let steps = 0;
    while (f.exporter.step()) {
      expectIdentityCoverage(out);
      expect(identityCensus(out)).toEqual(before);
      if (++steps > 500) throw new Error("import replacement did not converge");
    }
    expect(steps).toBeGreaterThan(1);
    expect(identityCensus(pinned)).toEqual(before);
    pinned.exec("ROLLBACK");
    expect(
      out
        .prepare(
          "SELECT native_session_id,thread_id FROM ardud_opencode_import ORDER BY native_session_id",
        )
        .all(),
    ).toEqual(
      [...expected, ["stable", "stable-owner"]]
        .sort(([a], [b]) => a!.localeCompare(b!))
        .map(([native_session_id, thread_id]) => ({ native_session_id, thread_id })),
    );
    expectIdentityCoverage(out);
    for (const id of changed) expect(identityVersion(out, name, id)).toBeGreaterThan(sequence);
    for (const id of removed) expect(Number.isNaN(identityVersion(out, name, id))).toBe(true);
    expect(
      identityCensus(out).filter(
        (r) =>
          r.table_name !== name ||
          (!changed.includes(String(r.row_id)) && !removed.includes(String(r.row_id))),
      ),
    ).toEqual(
      before.filter(
        (r) =>
          r.table_name !== name ||
          (!changed.includes(String(r.row_id)) && !removed.includes(String(r.row_id))),
      ),
    );
    const committed = identityCensus(out);
    f.restart();
    f.finish();
    expect(identityCensus(out)).toEqual(committed);
  },
);

test("identity versions: a throwing exporter publication rolls back row versions and sequence together", () => {
  const f = identityVersionFixture();
  f.finish();
  const out = f.connect();
  const before = identityCensus(out);
  const sequence = identitySequenceValue(out);
  const imports = out
    .prepare("SELECT * FROM ardud_opencode_import ORDER BY native_session_id")
    .all();
  writeReplica(f, (db) =>
    db.exec(
      "CREATE TRIGGER fail_import BEFORE INSERT ON ardud_opencode_import WHEN NEW.native_session_id='version-main' BEGIN SELECT RAISE(ABORT,'injected publication failure'); END",
    ),
  );
  f.source.exec(
    `UPDATE orchestration_v2_projection_threads SET payload_json='{"pending":true}' WHERE thread_id='version-main'; UPDATE ardud_opencode_import SET thread_id='fail' WHERE native_session_id='version-main'`,
  );
  emitIdentityEvent(f.source, "threads");
  expect(() => f.finish()).toThrow("injected publication failure");
  expect(identityCensus(out)).toEqual(before);
  expect(identitySequenceValue(out)).toBe(sequence);
  expect(
    out.prepare("SELECT * FROM ardud_opencode_import ORDER BY native_session_id").all(),
  ).toEqual(imports);
  expectIdentityCoverage(out);
  writeReplica(f, (db) => db.exec("DROP TRIGGER fail_import"));
  f.restart();
  f.finish();
  expect(identityVersion(out, identityVersionTables[0][0])).toBeGreaterThan(
    Number(
      before.find(
        (r) => r.table_name === identityVersionTables[0][0] && r.row_id === "version-main",
      )?.version,
    ),
  );
});

test("identity versions: fast-lane companion copies and suspended cycle replay retain fresh exact versions", () => {
  const f = identityVersionFixture(1);
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  f.finish();
  const out = f.connect();
  const before = identityVersion(out, identityVersionTables[2][0]);
  f.source.exec(
    `UPDATE orchestration_v2_projection_provider_turns SET thread_id='pending' WHERE provider_turn_id='version-main'`,
  );
  emitIdentityEvent(f.source, "turns");
  f.exporter.takeMetrics();
  let caughtUp = false;
  for (let i = 0; i < 40; i++) {
    f.exporter.step();
    if (f.exporter.takeMetrics().phaseSteps.eventCatchup) {
      caughtUp = true;
      break;
    }
  }
  expect(caughtUp).toBe(true);
  const stamp = metaValue(out, "updated_at");
  for (const id of ["ahead1", "ahead2", "child"])
    f.source
      .prepare(
        "INSERT INTO orchestration_v2_projection_threads(thread_id,payload_json) VALUES (?,'{}')",
      )
      .run(id);
  f.source.exec(
    "INSERT INTO orchestration_v2_projection_provider_threads(provider_thread_id,payload_json,thread_id) VALUES ('companion','{}','child')",
  );
  now += 1_000;
  expect(f.exporter.pollIdentities()).toBe(true);
  expect(identityVersion(out, identityVersionTables[0][0], "child")).toBeGreaterThan(0);
  expect(identityVersion(out, identityVersionTables[1][0], "companion")).toBeGreaterThan(0);
  const companionVersion = identityVersion(out, identityVersionTables[1][0], "companion");
  expect(metaValue(out, "updated_at")).toBe(stamp);
  f.finish();
  expect(identityVersion(out, identityVersionTables[2][0])).toBeGreaterThan(before);
  expect(identityVersion(out, identityVersionTables[1][0], "companion")).toBe(companionVersion);
  expectIdentityCoverage(out);
});

test.each(["full", "additive"])(
  "identity versions: %s rebuild publishes complete coverage and retains sequence history",
  (kind) => {
    const f = identityVersionFixture();
    f.finish();
    const out = f.connect();
    const before = identityCensus(out);
    const sequence = identitySequenceValue(out);
    out.exec("BEGIN");
    expectIdentityCoverage(out);
    f.source.exec(
      `ALTER TABLE orchestration_v2_projection_threads ADD COLUMN extra TEXT ${kind === "full" ? "CHECK(extra IS NULL)" : "DEFAULT 'backfill'"}`,
    );
    f.restart();
    let steps = 0;
    while (f.exporter.step()) {
      expectIdentityCoverage(out);
      expect(identityCensus(out)).toEqual(before);
      if (++steps > 500) throw new Error("identity rebuild did not converge");
    }
    expect(identityCensus(out)).toEqual(before);
    out.exec("ROLLBACK");
    expect(metaValue(out, "ready")).toBe("1");
    expectIdentityCoverage(out);
    expect(identitySequenceValue(out)).toBeGreaterThanOrEqual(sequence);
    if (kind === "full")
      expect(identityVersion(out, identityVersionTables[0][0])).toBeGreaterThan(sequence);
    else {
      expect(identityVersion(out, identityVersionTables[1][0])).toBe(
        identityVersionFrom(before, identityVersionTables[1][0]),
      );
      const version = identityVersion(out, identityVersionTables[0][0]);
      f.source.exec(
        "UPDATE orchestration_v2_projection_threads SET extra='edited' WHERE thread_id='version-main'",
      );
      emitIdentityEvent(f.source, "threads");
      f.finish();
      expect(identityVersion(out, identityVersionTables[0][0])).toBeGreaterThan(version);
    }
  },
);
const identityVersionFrom = (census: ReturnType<typeof identityCensus>, name: string) =>
  Number(census.find((r) => r.table_name === name && r.row_id === "version-main")?.version);

test.each(["reopen", "midrun"])(
  "identity versions: covered auxiliary table recreation on %s replaces its census atomically",
  (mode) => {
    const f = identityVersionFixture();
    f.finish();
    const out = f.connect();
    const before = identityCensus(out);
    const sequence = identitySequenceValue(out);
    f.source.exec(
      "ALTER TABLE ardud_opencode_import ADD COLUMN extra TEXT; DELETE FROM ardud_opencode_import WHERE native_session_id='version-main'",
    );
    if (mode === "reopen") f.restart();
    let steps = 0;
    while (f.exporter.step()) {
      expectIdentityCoverage(out);
      expect(identityCensus(out)).toEqual(before);
      if (++steps > 500) throw new Error("identity auxiliary refresh did not converge");
    }
    expectIdentityCoverage(out);
    expect(identityVersion(out, identityVersionTables[4][0], "version-peer")).toBeGreaterThan(
      sequence,
    );
    expect(Number.isNaN(identityVersion(out, identityVersionTables[4][0]))).toBe(true);
    expect(identityVersion(out, identityVersionTables[0][0])).toBe(
      identityVersionFrom(before, identityVersionTables[0][0]),
    );
  },
);

test("identity versions: reopen and no-op refresh keep versions and the sequence unchanged", () => {
  const f = identityVersionFixture();
  f.finish();
  const out = f.connect();
  const before = identityCensus(out);
  const sequence = identitySequenceValue(out);
  for (let i = 0; i < 3; i++) {
    f.restart();
    expect(identityCensus(out)).toEqual(before);
    f.finish();
    expectIdentityCoverage(out);
    expect(identityCensus(out)).toEqual(before);
    expect(identitySequenceValue(out)).toBe(sequence);
  }
});

test("identity versions: reopen repairs a lost trigger and stale census without certifying partial coverage", () => {
  const f = identityVersionFixture();
  f.finish();
  f.exporter.close();
  const out = f.connect();
  const before = identityCensus(out);
  writeReplica(f, (db) =>
    db.exec(
      "DROP TRIGGER ardud_identity_threads_delete; DELETE FROM orchestration_v2_projection_threads WHERE thread_id='version-main'",
    ),
  );
  out.exec("BEGIN");
  expect(
    out.prepare("SELECT name FROM sqlite_schema WHERE name='ardud_identity_threads_delete'").get(),
  ).toBeUndefined();
  f.restart();
  expect(
    out.prepare("SELECT name FROM sqlite_schema WHERE name='ardud_identity_threads_delete'").get(),
  ).toBeUndefined();
  out.exec("ROLLBACK");
  expectIdentityCoverage(out);
  expect(Number.isNaN(identityVersion(out, identityVersionTables[0][0]))).toBe(true);
  expect(identityVersion(out, identityVersionTables[1][0])).toBe(
    identityVersionFrom(before, identityVersionTables[1][0]),
  );
});

test("identity versions: scalar census over thousands of rows uses the covering unique index", () => {
  const f = identityVersionFixture(500);
  f.source.exec(
    "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<4000) INSERT INTO orchestration_v2_projection_threads(thread_id,payload_json) SELECT 'bulk-'||x,json_object('body',printf('%2000s','payload')) FROM n",
  );
  f.finish();
  const out = f.connect();
  expectIdentityCoverage(out);
  const plan = out
    .prepare(
      "EXPLAIN QUERY PLAN SELECT row_id,version FROM ardud_readonly_identity_versions WHERE table_name=? ORDER BY row_id",
    )
    .all(identityVersionTables[0][0])
    .map((row) => String(row.detail))
    .join(" ");
  expect(plan).toContain("USING COVERING INDEX");
  expect(plan).not.toMatch(/SCAN |TEMP B-TREE/);
  expect(
    out
      .prepare(
        "SELECT row_id,version FROM ardud_readonly_identity_versions WHERE table_name=? ORDER BY row_id",
      )
      .all(identityVersionTables[0][0]),
  ).toHaveLength(4005);
});

test("identity versions: reset sweep pruning removes versions for vanished source keys", () => {
  const f = identityVersionFixture(1);
  f.finish();
  const out = f.connect();
  const sequence = identitySequenceValue(out);
  for (const [name, primary] of identityVersionTables)
    f.source.exec(`DELETE FROM ${name} WHERE ${primary}='version-main'`);
  f.source.exec("INSERT INTO orchestration_events VALUES (4,'thread.deleted','version-main','{}')");
  f.finish();
  expectIdentityCoverage(out);
  expect(identityCensus(out).some((row) => row.row_id === "version-main")).toBe(false);
  expect(identitySequenceValue(out)).toBeGreaterThanOrEqual(sequence);
});

test("identity versions: table loss reinstalls a complete census with a new schema epoch", () => {
  const f = identityVersionFixture();
  f.finish();
  f.exporter.close();
  const out = f.connect();
  const epoch = out.prepare("PRAGMA schema_version").get()?.schema_version;
  writeReplica(f, (db) => db.exec("DROP TABLE ardud_readonly_identity_versions"));
  f.restart();
  expectIdentityCoverage(out);
  expect(out.prepare("PRAGMA schema_version").get()?.schema_version).not.toBe(epoch);
});
