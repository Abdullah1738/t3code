// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Native offline SQLite fixtures use a fixed Date to make retention eligibility deterministic outside the Effect clock.
import { assert, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeChildProcess from "node:child_process";

import { main, offlineSplit, OfflineSplitError } from "./ardud-shrink-statev2.ts";

const NOW = new Date("2026-11-05T12:00:00.000Z");

function fixture<A>(run: (source: string, directory: string) => A) {
  const root = NodePath.resolve(".t3");
  NodeFS.mkdirSync(root, { recursive: true });
  const directory = NodeFS.mkdtempSync(NodePath.join(root, "offline-split-fixture-"));
  const source = NodePath.join(directory, "statev2.sqlite");
  const db = new NodeSqlite.DatabaseSync(source);
  db.exec(`
    PRAGMA user_version=55;
    PRAGMA application_id=42;
    CREATE TABLE orchestration_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
      aggregate_kind TEXT NOT NULL, stream_id TEXT NOT NULL, stream_version INTEGER NOT NULL,
      event_type TEXT NOT NULL, payload_json TEXT NOT NULL, application_event_version INTEGER NOT NULL DEFAULT 2);
    CREATE INDEX idx_orch_events_stream_sequence ON orchestration_events(aggregate_kind,stream_id,sequence);
    CREATE INDEX idx_orchestration_events_application_sequence ON orchestration_events(application_event_version,sequence);
    CREATE INDEX orchestration_events_v2_created_threads_idx ON orchestration_events(stream_id,sequence)
      WHERE aggregate_kind='thread' AND application_event_version=2 AND event_type='thread.created';
    CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT PRIMARY KEY, updated_at TEXT NOT NULL, archived_at TEXT);
    CREATE TABLE orchestration_v2_projection_turn_items(turn_item_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, ordinal INTEGER NOT NULL, payload_json TEXT, status TEXT NOT NULL DEFAULT 'completed',type TEXT NOT NULL DEFAULT 'tool_call');
    CREATE INDEX items_thread_idx ON orchestration_v2_projection_turn_items(thread_id,ordinal);
    CREATE TABLE orchestration_v2_turn_item_positions(thread_id TEXT PRIMARY KEY,next_position INTEGER NOT NULL);
    CREATE TABLE ardud_cards(id TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE control_without_rowid(id TEXT PRIMARY KEY,value TEXT) WITHOUT ROWID;
    CREATE TABLE generated_table(id INTEGER PRIMARY KEY,value TEXT,computed TEXT GENERATED ALWAYS AS (value || '!') STORED);
    CREATE TABLE trigger_audit(id INTEGER PRIMARY KEY);
    CREATE TRIGGER card_audit AFTER INSERT ON ardud_cards BEGIN INSERT INTO trigger_audit VALUES(1); END;
    CREATE VIEW card_view AS SELECT * FROM ardud_cards;
    INSERT INTO orchestration_v2_projection_threads VALUES ('hot','2026-11-05T10:00:00Z',NULL),('idle','2026-10-01T10:00:00Z',NULL),('archived','2026-11-05T10:00:00Z','2026-11-05T10:00:00Z');
    INSERT INTO orchestration_v2_turn_item_positions VALUES ('idle',999),('hot',2000);
    INSERT INTO ardud_cards VALUES ('card','control stays');
    INSERT INTO control_without_rowid VALUES ('a','one'),('b','two'),('c','three');
    INSERT INTO generated_table VALUES (7,'hello');
  `);
  const insert = db.prepare(
    "INSERT INTO orchestration_events(sequence,event_id,aggregate_kind,stream_id,stream_version,event_type,payload_json,application_event_version) VALUES(?,?,?,?,?,?,?,?)",
  );
  let sequence = 1;
  for (const thread of ["hot", "idle", "archived"]) {
    for (let i = 1; i <= 4; i++) {
      insert.run(
        sequence,
        `event-${sequence}`,
        "thread",
        thread,
        i,
        i === 1 ? "thread.created" : "thread.message",
        i === 2 ? "x".repeat(64 * 1024) : "{}",
        2,
      );
      sequence++;
    }
    db.prepare(
      "INSERT INTO orchestration_v2_projection_turn_items(rowid,turn_item_id,thread_id,ordinal,payload_json) VALUES(?,?,?,?,?)",
    ).run(sequence * 10, `${thread}-item`, thread, 900, "y".repeat(64 * 1024));
  }
  insert.run(sequence, "project", "project", "project", 1, "project.created", "{}", 2);
  insert.run(sequence + 1, "v1", "thread", "idle", 99, "thread.message", "{}", 1);
  // Preserve AUTOINCREMENT even if the highest surviving sequence is smaller.
  db.prepare("UPDATE sqlite_sequence SET seq=10000 WHERE name='orchestration_events'").run();
  db.close();
  try {
    return run(source, directory);
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
}

const options = (source: string) => ({ source, acknowledgeStopped: true, now: NOW, batchSize: 2 });
const rows = (db: NodeSqlite.DatabaseSync, sql: string) =>
  db
    .prepare(sql)
    .all()
    .map((row) => ({ ...row }));
const expectSplitError = (run: () => unknown, exitCode: 1 | 70) => {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  if (!(caught instanceof OfflineSplitError))
    assert.fail(`Expected OfflineSplitError with exit ${exitCode}, received ${String(caught)}`);
  assert.equal(caught.exitCode, exitCode);
};

it("requires stopped acknowledgement before resolving a path", () => {
  assert.throws(
    () => offlineSplit({ source: "missing", acknowledgeStopped: false }),
    /acknowledge-stopped/,
  );
});

it("dry-run reports exact kept/moved counts and leaves source bytes unchanged", () =>
  fixture((source, directory) => {
    const before = NodeFS.readFileSync(source);
    const result = offlineSplit({ ...options(source), dryRun: true });
    assert.isTrue(result.dryRun);
    assert.deepEqual(result.events, { keep: 9, move: 5 });
    assert.deepEqual(result.turnItems, { keep: 1, move: 2 });
    assert.equal(result.coldThreads, 2);
    assert.isAbove(result.pageCount!, 0);
    assert.deepEqual(NodeFS.readFileSync(source), before);
    assert.isFalse(NodeFS.existsSync(source + ".offline-split.json"));
    assert.isFalse(NodeFS.readdirSync(directory).some((name) => name.includes("pre-shrink")));
  }));

it("copies only kept history, preserves schema/control/positions/rowids and atomically keeps the original", () =>
  fixture((source, directory) => {
    const before = NodeFS.readFileSync(source);
    const ino = NodeFS.statSync(source).ino;
    const progress: string[] = [];
    const result = offlineSplit({ ...options(source), progress: (line) => progress.push(line) });
    const archive = NodePath.join(directory, result.archive!);
    assert.equal(NodeFS.statSync(archive).ino, ino);
    assert.notEqual(NodeFS.statSync(source).ino, ino);
    assert.deepEqual(NodeFS.readFileSync(archive), before);
    assert.isTrue(progress.every((line) => /\+\d+\.\ds/.test(line)));
    assert.equal(
      progress.filter(
        (line) =>
          line.includes("retained-key payload plan") &&
          line.includes("SEARCH source USING INTEGER PRIMARY KEY"),
      ).length,
      2,
    );
    const live = new NodeSqlite.DatabaseSync(source, { readOnly: true });
    const old = new NodeSqlite.DatabaseSync(archive, { readOnly: true });
    try {
      assert.deepEqual(rows(live, "SELECT filename FROM ardud_history_base_archive"), [
        { filename: result.archive! },
      ]);
      assert.equal(live.prepare("SELECT COUNT(*) n FROM orchestration_events").get()?.n, 9);
      assert.deepEqual(
        rows(live, "SELECT sequence FROM orchestration_events ORDER BY sequence").map(
          (row) => row.sequence,
        ),
        [1, 2, 3, 4, 5, 9, 12, 13, 14],
      );
      assert.equal(old.prepare("SELECT COUNT(*) n FROM orchestration_events").get()?.n, 14);
      assert.deepEqual(
        rows(live, "SELECT turn_item_id,rowid FROM orchestration_v2_projection_turn_items"),
        [{ turn_item_id: "hot-item", rowid: 50 }],
      );
      for (const table of [
        "orchestration_v2_projection_threads",
        "orchestration_v2_turn_item_positions",
        "ardud_cards",
        "trigger_audit",
        "control_without_rowid",
        "generated_table",
      ])
        assert.deepEqual(rows(live, `SELECT * FROM ${table}`), rows(old, `SELECT * FROM ${table}`));
      assert.equal(
        live.prepare("SELECT seq FROM sqlite_sequence WHERE name='orchestration_events'").get()
          ?.seq,
        10000,
      );
      assert.equal(live.prepare("PRAGMA user_version").get()?.user_version, 55);
      assert.equal(live.prepare("PRAGMA application_id").get()?.application_id, 42);
      assert.equal(live.prepare("PRAGMA auto_vacuum").get()?.auto_vacuum, 2);
      assert.deepEqual(rows(live, "SELECT * FROM card_view"), [
        { id: "card", value: "control stays" },
      ]);
    } finally {
      live.close();
      old.close();
    }
    assert.isTrue(offlineSplit(options(source)).alreadyDone);
    assert.deepEqual(NodeFS.readFileSync(archive), before);
  }));

it("keeps archived and idle threads hot whenever any runtime or import work is unfinished", () =>
  fixture((source) => {
    const db = new NodeSqlite.DatabaseSync(source);
    db.exec(`
    CREATE TABLE orchestration_v2_projection_runs(thread_id TEXT,status TEXT);
    CREATE TABLE orchestration_v2_projection_runtime_requests(thread_id TEXT,status TEXT);
    CREATE TABLE orchestration_v2_effect_outbox(thread_id TEXT,status TEXT);
    CREATE TABLE orchestration_v2_projection_subagents(thread_id TEXT,status TEXT);
    CREATE TABLE orchestration_v2_legacy_imports(thread_id TEXT,transcript_imported_at TEXT);
    CREATE TABLE orchestration_v2_projection_provider_threads(thread_id TEXT,payload_json TEXT);
  `);
    const protections = [
      ...["queued", "preparing", "starting", "running", "waiting"].map(
        (status) => ["orchestration_v2_projection_runs", status] as const,
      ),
      ...["pending", "waiting"].map(
        (status) => ["orchestration_v2_projection_runtime_requests", status] as const,
      ),
      ...["pending", "running"].map(
        (status) => ["orchestration_v2_effect_outbox", status] as const,
      ),
      ...["pending", "starting", "running", "waiting"].map(
        (status) => ["orchestration_v2_projection_subagents", status] as const,
      ),
      ["orchestration_v2_legacy_imports", null] as const,
      [
        "orchestration_v2_projection_provider_threads",
        JSON.stringify({ pendingBackgroundTasks: ["background-task"] }),
      ] as const,
      ...["pending", "starting", "running", "waiting"].map((status) => ["item", status] as const),
    ];
    let sequence = 100;
    for (const [index, [table, value]] of protections.entries()) {
      const thread = `protected-${index}`;
      // Half are explicitly archived, half are idle; neither may lose payloads.
      db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES(?,?,?)").run(
        thread,
        "2020-01-01",
        index % 2 ? null : "2020-01-02",
      );
      for (const eventType of ["thread.created", "thread.message", "thread.message"])
        db.prepare("INSERT INTO orchestration_events VALUES(?,?,?,?,?,?,?,?)").run(
          ++sequence,
          `protected-event-${sequence}`,
          "thread",
          thread,
          sequence,
          eventType,
          "{}",
          2,
        );
      db.prepare(
        "INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,ordinal,payload_json,status,type) VALUES(?,?,?,?,?,?)",
      ).run(
        `protected-item-${index}`,
        thread,
        index,
        "{}",
        table === "item" ? value! : "completed",
        "nonstandard-item-type",
      );
      if (table !== "item")
        db.prepare(`INSERT INTO ${table} VALUES(?,?)`).run(thread, value ?? null);
    }
    db.close();
    offlineSplit(options(source));
    const live = new NodeSqlite.DatabaseSync(source, { readOnly: true });
    try {
      assert.equal(
        live
          .prepare("SELECT COUNT(*) n FROM orchestration_events WHERE stream_id LIKE 'protected-%'")
          .get()?.n,
        protections.length * 3,
      );
      assert.equal(
        live
          .prepare(
            "SELECT COUNT(*) n FROM orchestration_v2_projection_turn_items WHERE thread_id LIKE 'protected-%'",
          )
          .get()?.n,
        protections.length,
      );
      assert.equal(
        live
          .prepare(
            "SELECT COUNT(*) n FROM orchestration_v2_projection_turn_items WHERE thread_id IN ('idle','archived')",
          )
          .get()?.n,
        0,
      );
    } finally {
      live.close();
    }
  }));

it("resumes an interrupted batch without duplicates or copying cold payloads", () =>
  fixture((source) => {
    let interrupted = false;
    assert.throws(
      () =>
        offlineSplit({
          ...options(source),
          progress: (line) => {
            if (line.includes("orchestration_events: 2 rows") && !interrupted) {
              interrupted = true;
              throw new Error("fixture interruption");
            }
          },
        }),
      /fixture interruption/,
    );
    const result = offlineSplit(options(source));
    assert.isFalse(result.alreadyDone);
    const db = new NodeSqlite.DatabaseSync(source, { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT COUNT(*) n FROM orchestration_events").get()?.n, 9);
    } finally {
      db.close();
    }
  }));

it("leaves the original installed if pre-swap server validation fails", () =>
  fixture((source) => {
    const before = NodeFS.readFileSync(source);
    assert.throws(
      () =>
        offlineSplit({
          ...options(source),
          validate: () => {
            throw new Error("cannot open server");
          },
        }),
      /cannot open server/,
    );
    assert.deepEqual(NodeFS.readFileSync(source), before);
    assert.isFalse(offlineSplit(options(source)).alreadyDone);
  }));

it("restores original atomically if the post-swap validation fails", () =>
  fixture((source) => {
    const before = NodeFS.readFileSync(source);
    let checks = 0;
    expectSplitError(
      () =>
        offlineSplit({
          ...options(source),
          validate: () => {
            if (++checks === 2) throw new Error("post-swap failure");
          },
        }),
      1,
    );
    assert.deepEqual(NodeFS.readFileSync(source), before);
    assert.isFalse(offlineSplit(options(source)).alreadyDone);
  }));

it("refuses runtime PID, ownership lock and source readers", () =>
  fixture((source, directory) => {
    const before = NodeFS.readFileSync(source);
    NodeFS.writeFileSync(
      NodePath.join(directory, "server-runtime.json"),
      JSON.stringify({ pid: process.pid }),
    );
    assert.throws(() => offlineSplit(options(source)), /still alive/);
    NodeFS.unlinkSync(NodePath.join(directory, "server-runtime.json"));
    const owner = new NodeSqlite.DatabaseSync(NodePath.join(directory, "server-owner.sqlite"));
    owner.exec("BEGIN EXCLUSIVE");
    try {
      assert.throws(() => offlineSplit(options(source)), /locked/);
    } finally {
      owner.close();
    }
    const reader = new NodeSqlite.DatabaseSync(source, { readOnly: true });
    reader.exec("BEGIN; SELECT * FROM ardud_cards");
    try {
      assert.throws(() => offlineSplit(options(source)), /locked/);
    } finally {
      reader.close();
    }
    assert.deepEqual(NodeFS.readFileSync(source), before);
  }));

it("checkpoints a crash-left WAL before preserving the original as a self-contained base", () =>
  fixture((source, directory) => {
    const child = NodeChildProcess.spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import * as NodeSqlite from 'node:sqlite';
    const db = new NodeSqlite.DatabaseSync(process.argv[1]);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; UPDATE ardud_cards SET value='committed in WAL' WHERE id='card';");
    process.kill(process.pid, 'SIGKILL');
  `,
        source,
      ],
      { encoding: "utf8" },
    );
    assert.equal(child.signal, "SIGKILL");
    assert.isTrue(NodeFS.existsSync(source + "-wal"));
    const result = offlineSplit(options(source));
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      assert.isFalse(NodeFS.existsSync(source + suffix));
      const saved = NodePath.join(directory, result.archive!) + suffix;
      if (suffix !== "-shm" && NodeFS.existsSync(saved))
        assert.equal(NodeFS.statSync(saved).size, 0);
    }
    const db = new NodeSqlite.DatabaseSync(NodePath.join(directory, result.archive!), {
      readOnly: true,
    });
    try {
      assert.equal(
        db.prepare("SELECT value FROM ardud_cards WHERE id='card'").get()?.value,
        "committed in WAL",
      );
    } finally {
      db.close();
    }
  }));

it("refuses busy WAL readers without changing their committed data", () =>
  fixture((source) => {
    const db = new NodeSqlite.DatabaseSync(source);
    db.exec("PRAGMA journal_mode=WAL; BEGIN; SELECT * FROM ardud_cards;");
    const wal = NodeFS.readFileSync(source + "-wal");
    try {
      assert.throws(() => offlineSplit(options(source)), /locked/);
      assert.deepEqual(NodeFS.readFileSync(source + "-wal"), wal);
      assert.isFalse(NodeFS.existsSync(source + ".offline-split.json"));
    } finally {
      db.close();
    }
  }));

it("resumes after a crash between durable base hardlink and swap", () =>
  fixture((source) => {
    assert.throws(
      () =>
        offlineSplit({
          ...options(source),
          validate: () => {
            throw new Error("before rename");
          },
        }),
      /before rename/,
    );
    const marker = JSON.parse(NodeFS.readFileSync(source + ".offline-split.json", "utf8"));
    assert.equal(marker.phase, "linked");
    assert.equal(NodeFS.statSync(source).ino, NodeFS.statSync(marker.archive).ino);
    // Emulate the process dying after link but before the linked marker write.
    marker.phase = "validated";
    NodeFS.writeFileSync(source + ".offline-split.json", JSON.stringify(marker));
    assert.isFalse(offlineSplit(options(source)).alreadyDone);
  }));

it("validates and completes a crash after rename but before the done marker", () =>
  fixture((source) => {
    offlineSplit(options(source));
    const marker = JSON.parse(NodeFS.readFileSync(source + ".offline-split.json", "utf8"));
    marker.phase = "linked";
    NodeFS.writeFileSync(source + ".offline-split.json", JSON.stringify(marker));
    let checked = false;
    assert.isTrue(
      offlineSplit({
        ...options(source),
        validate: () => {
          checked = true;
        },
      }).alreadyDone,
    );
    assert.isTrue(checked);
    assert.equal(
      JSON.parse(NodeFS.readFileSync(source + ".offline-split.json", "utf8")).phase,
      "done",
    );
  }));

it("refuses changed originals on resume rather than building a mixed snapshot", () =>
  fixture((source) => {
    assert.throws(
      () =>
        offlineSplit({
          ...options(source),
          progress: (line) => {
            if (line.includes("orchestration_events: 2 rows")) throw new Error("pause");
          },
        }),
      /pause/,
    );
    const originalStat = NodeFS.statSync(source);
    const db = new NodeSqlite.DatabaseSync(source);
    db.exec("INSERT INTO control_without_rowid VALUES('changed','after copy started')");
    db.close();
    NodeFS.utimesSync(source, originalStat.atime, originalStat.mtime);
    assert.throws(() => offlineSplit(options(source)), /Original changed/);
  }));

it("returns recovery-required exit 70 if rollback cannot safely restore the original", () =>
  fixture((source) => {
    let checks = 0;
    expectSplitError(
      () =>
        offlineSplit({
          ...options(source),
          validate: () => {
            if (++checks !== 2) return;
            const marker = JSON.parse(NodeFS.readFileSync(source + ".offline-split.json", "utf8"));
            NodeFS.writeFileSync(
              marker.archive + ".restore",
              "do not overwrite this unrelated file",
            );
            throw new Error("post-swap failed");
          },
        }),
      70,
    );
    const marker = JSON.parse(NodeFS.readFileSync(source + ".offline-split.json", "utf8"));
    assert.isTrue(NodeFS.existsSync(source));
    assert.isTrue(NodeFS.existsSync(marker.archive));
  }));

it("refuses temporary source directories", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "offline-split-test-"));
  try {
    const source = NodePath.join(directory, "statev2.sqlite");
    NodeFS.writeFileSync(source, "fixture");
    assert.throws(() => offlineSplit(options(source)), /temporary directory/);
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

it("CLI reports help and input failure through its exit contract", () => {
  assert.equal(main(["--help"]), 0);
  assert.equal(main([]), 1);
  assert.equal(main(["--source", "missing"]), 1);
});

it("CLI validates the installed database through the real read-only history views", () =>
  fixture((source) => {
    const db = new NodeSqlite.DatabaseSync(source);
    db.exec(`
    DROP TABLE orchestration_events;
    DROP TABLE orchestration_v2_projection_turn_items;
    CREATE TABLE orchestration_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
      aggregate_kind TEXT NOT NULL, stream_id TEXT NOT NULL, stream_version INTEGER NOT NULL,
      event_type TEXT NOT NULL, occurred_at TEXT NOT NULL, command_id TEXT, causation_event_id TEXT,
      correlation_id TEXT, actor_kind TEXT NOT NULL, payload_json TEXT NOT NULL, metadata_json TEXT NOT NULL,
      application_event_version INTEGER NOT NULL DEFAULT 2);
    CREATE INDEX idx_orch_events_stream_sequence ON orchestration_events(aggregate_kind,stream_id,sequence);
    CREATE INDEX idx_orchestration_events_application_sequence ON orchestration_events(application_event_version,sequence);
    CREATE INDEX orchestration_events_v2_created_threads_idx ON orchestration_events(stream_id)
      WHERE application_event_version=2 AND aggregate_kind='thread' AND event_type='thread.created';
    CREATE INDEX idx_orch_events_command_id ON orchestration_events(command_id);
    CREATE INDEX idx_orchestration_events_application_high_water ON orchestration_events(sequence)
      WHERE aggregate_kind='project' OR (application_event_version=2 AND aggregate_kind='thread');
    CREATE TABLE orchestration_v2_projection_turn_items(
      turn_item_id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,run_id TEXT,node_id TEXT,
      provider_thread_id TEXT,provider_turn_id TEXT,parent_item_id TEXT,ordinal INTEGER NOT NULL,
      type TEXT NOT NULL,status TEXT NOT NULL,updated_at TEXT NOT NULL,payload_json TEXT NOT NULL);
    CREATE INDEX orchestration_v2_projection_turn_items_thread_ordinal_idx ON orchestration_v2_projection_turn_items(thread_id,ordinal,turn_item_id);
    INSERT INTO orchestration_events VALUES
      (1,'created','thread','archived',1,'thread.created','2020-01-01',NULL,NULL,NULL,'system','{}','{}',2),
      (2,'cold','thread','archived',2,'thread.message','2020-01-01',NULL,NULL,NULL,'system','{}','{}',2),
      (3,'latest','thread','archived',3,'thread.message','2020-01-01',NULL,NULL,NULL,'system','{}','{}',2);
    INSERT INTO orchestration_v2_projection_turn_items VALUES('cold-item','archived',NULL,NULL,NULL,NULL,NULL,1,'tool_call','completed','2020-01-01','{}');
  `);
    db.close();
    assert.equal(main(["--source", source, "--acknowledge-stopped"]), 0);
    assert.equal(main(["--source", source, "--acknowledge-stopped"]), 0);
    const live = new NodeSqlite.DatabaseSync(source, { readOnly: true });
    try {
      assert.equal(live.prepare("SELECT COUNT(*) n FROM orchestration_events").get()?.n, 2);
      assert.equal(
        live.prepare("SELECT COUNT(*) n FROM orchestration_v2_projection_turn_items").get()?.n,
        0,
      );
    } finally {
      live.close();
    }
  }));
