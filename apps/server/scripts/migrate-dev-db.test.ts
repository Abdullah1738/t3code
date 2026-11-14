import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../src/persistence/Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Sqlite from "../src/persistence/Sqlite.ts";
import { initializeHistoryArchive } from "../src/ardud/persistence/HistoryArchive.ts";
import {
  archiveFilename,
  HISTORY_TABLES,
  liveColumns,
} from "../src/ardud/persistence/historyArchiveSql.ts";
import { runMigrateDevDb } from "./migrate-dev-db.ts";

const withDatabase = <A, E>(
  databasePath: string,
  effect: Effect.Effect<A, E, SqlClient.SqlClient>,
) => effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: databasePath })));

const createFixtureSource = Effect.fn("createMigrateDevDbFixtureSource")(function* (
  baseDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stateDir = path.join(baseDir, "userdata");
  const databasePath = path.join(stateDir, "statev2.sqlite");
  yield* fs.makeDirectory(stateDir, { recursive: true });
  yield* withDatabase(
    databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();

      yield* sql`INSERT INTO projection_projects
        (project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at)
        VALUES
        ('project-kept', 'Kept', '/tmp/kept', '[]', '2026-08-01', '2026-08-01', NULL),
        ('project-deleted', 'Deleted', '/tmp/deleted', '[]', '2026-08-01', '2026-08-02', '2026-08-02')`;

      const forkPayload =
        '{"lineage":{"parentThreadId":"stopped-thread","relationshipToParent":"fork","rootThreadId":"stopped-thread"}}';
      const subagentPayload =
        '{"lineage":{"parentThreadId":"subagent-parent","relationshipToParent":"subagent","rootThreadId":"subagent-parent"},"forkedFrom":{"type":"node","nodeId":"node-1"}}';
      const threads = [
        ["stopped-thread", "project-kept", "completed", "{}", "2026-08-01"],
        ["fork-thread", "project-kept", "completed", forkPayload, "2026-08-02"],
        ["running-thread", "project-kept", "running", "{}", "2026-08-05"],
        ["settled-thread", "project-kept", "completed", '{"settledAt":"2026-08-01"}', "2026-08-05"],
        [
          "limit-thread",
          "project-kept",
          "completed",
          '{"limitRecovery":{"autoResume":true}}',
          "2026-08-05",
        ],
        ["subagent-parent", "project-kept", "completed", "{}", "2026-08-05"],
        ["subagent-child", "project-kept", "completed", subagentPayload, "2026-08-05"],
        ["deleted-project-thread", "project-deleted", "completed", "{}", "2026-08-05"],
      ] as const;
      for (const [threadId, projectId, runStatus, payload, updatedAt] of threads) {
        yield* sql`INSERT INTO orchestration_v2_projection_threads
          (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
          VALUES (${threadId}, ${projectId}, ${threadId}, 'codex', 'full-access', 'default', '2026-08-01', ${updatedAt}, ${payload})`;
        yield* sql`INSERT INTO orchestration_v2_projection_runs
          (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
          VALUES (${`run-${threadId}`}, ${threadId}, 1, 'codex', ${runStatus}, '2026-08-01', '{}')`;
        yield* sql`INSERT INTO orchestration_events
          (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json)
          VALUES (${`event-${threadId}`}, 'thread', ${threadId}, 0, 'thread.created', '2026-08-01', 'user', '{}', '{}')`;
      }
      yield* sql`INSERT INTO orchestration_v2_projection_provider_sessions
        (provider_session_id, thread_id, provider, status, updated_at, payload_json)
        VALUES ('session-shared', 'running-thread', 'codex', 'stopped', '2026-08-01', '{}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_provider_session_bindings
        (provider_session_id, thread_id)
        VALUES ('session-shared', 'running-thread'), ('session-shared', 'stopped-thread')`;
      yield* sql`INSERT INTO orchestration_v2_projection_context_transfers
        (context_transfer_id, source_thread_id, target_thread_id, type, status, updated_at, payload_json)
        VALUES ('transfer-1', 'settled-thread', 'stopped-thread', 'provider_handoff', 'completed', '2026-08-01', '{}')`;
      yield* sql`INSERT INTO scheduled_tasks
        (task_id, title, prompt, enabled, schedule_json, project_id, workspace_strategy_json,
          model_selection_json, runtime_mode, interaction_mode, created_by, creation_source,
          created_at, updated_at, last_run_status, run_count)
        VALUES ('task-1', 'Nightly', 'Run it', 1, '{}', 'project-kept', '{}', '{}',
          'full-access', 'default', 'user', 'user', '2026-08-01', '2026-08-01', 'never', 0)`;
      yield* sql`INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at)
        VALUES ('session-1', 'user', '[]', 'pairing', '2026-08-01', '2027-08-01')`;
    }),
  );
  return databasePath;
});

const addColdHistory = Effect.fn("addMigrateDevDbColdHistory")(function* (
  source: string,
  mode: "archive" | "base" | "archive-and-base",
) {
  const path = yield* Path.Path;
  const basePath = path.join(path.dirname(source), "statev2.pre-shrink-fixture.sqlite");
  yield* withDatabase(
    source,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* initializeHistoryArchive();
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items
      (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json)
      VALUES ('hot-item', 'stopped-thread', 1, 'assistant_message', 'completed', '2026-08-01', '{"source":"hot"}'),
        ('shadowed-item', 'settled-thread', 2, 'assistant_message', 'completed', '2026-08-01', '{"source":"hot"}')`;
      yield* sql`INSERT INTO orchestration_events
      (sequence, event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json)
      VALUES (100, 'hot-event', 'thread', 'stopped-thread', 1, 'thread.metadata-updated', '2026-08-01', 'server', '{"source":"hot"}', '{}'),
        (400, 'shadowed-event', 'thread', 'settled-thread', 1, 'thread.metadata-updated', '2026-08-01', 'server', '{"source":"hot"}', '{}')`;
      if (mode !== "archive") {
        yield* sql`ATTACH DATABASE ${basePath} AS fixture_base`;
        for (const table of HISTORY_TABLES) {
          yield* sql.unsafe(
            `CREATE TABLE fixture_base.${table.live} AS SELECT ${liveColumns(table.live)} FROM main.${table.live} WHERE 0`,
          );
        }
        yield* sql`CREATE TABLE ardud_history_base_archive (filename TEXT NOT NULL)`;
        yield* sql`INSERT INTO ardud_history_base_archive VALUES ('statev2.pre-shrink-fixture.sqlite')`;
      }
      for (const [store, offset] of [
        ["archive", 600],
        ["base", 900],
      ] as const) {
        if (mode !== store && mode !== "archive-and-base") continue;
        const schema = store === "archive" ? "ardud_archive" : "fixture_base";
        const events = store === "archive" ? "ardud_events" : "orchestration_events";
        const items =
          store === "archive" ? "ardud_turn_items" : "orchestration_v2_projection_turn_items";
        const eventColumns = liveColumns("orchestration_events");
        const itemColumns = liveColumns("orchestration_v2_projection_turn_items");
        yield* sql.unsafe(
          `INSERT INTO ${schema}.${events} (${eventColumns}) SELECT ${eventColumns} FROM main.orchestration_events WHERE sequence IN (100, 400)`,
        );
        yield* sql.unsafe(
          `UPDATE ${schema}.${events} SET stream_id = 'stopped-thread' WHERE sequence = 400`,
        );
        yield* sql.unsafe(
          `UPDATE ${schema}.${events} SET payload_json = '{"source":"stale"}' WHERE sequence = 100`,
        );
        yield* sql.unsafe(
          `INSERT INTO ${schema}.${items} (${itemColumns}) SELECT ${itemColumns} FROM main.orchestration_v2_projection_turn_items`,
        );
        yield* sql.unsafe(
          `UPDATE ${schema}.${items} SET payload_json = '{"source":"stale"}', thread_id = 'stopped-thread'`,
        );
        for (const [suffix, thread] of [
          ["kept", "stopped-thread"],
          ["dropped", "settled-thread"],
          ["running", "running-thread"],
        ] as const) {
          const sequence = offset + (suffix === "kept" ? 0 : suffix === "dropped" ? 1 : 2);
          yield* sql`INSERT INTO ${sql(`${schema}.${events}`)}
          (sequence, event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json, application_event_version)
          VALUES (${sequence}, ${`${store}-${suffix}`}, 'thread', ${thread}, ${offset}, 'thread.metadata-updated', '2026-08-01', 'server', ${JSON.stringify({ source: store })}, '{}', 2)`;
          yield* sql`INSERT INTO ${sql(`${schema}.${items}`)}
          (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json)
          VALUES (${`${store}-${suffix}`}, ${thread}, ${offset}, 'assistant_message', 'completed', '2026-08-01', ${JSON.stringify({ source: store })})`;
        }
        yield* sql`INSERT INTO ${sql(`${schema}.${events}`)}
        (sequence, event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json, application_event_version)
        VALUES (${offset + 3}, ${`${store}-global`}, 'system', 'global', ${offset}, 'server.updated', '2026-08-01', 'server', ${JSON.stringify({ source: store })}, '{}', 2)`;
      }
      if (mode === "archive-and-base") {
        yield* sql.unsafe(
          `INSERT INTO fixture_base.orchestration_events SELECT ${liveColumns("orchestration_events")} FROM ardud_archive.ardud_events WHERE sequence = 600`,
        );
        yield* sql`UPDATE fixture_base.orchestration_events SET payload_json = '{"source":"stale"}' WHERE sequence = 600`;
        yield* sql.unsafe(
          `INSERT INTO fixture_base.orchestration_v2_projection_turn_items SELECT ${liveColumns("orchestration_v2_projection_turn_items")} FROM ardud_archive.ardud_turn_items WHERE turn_item_id = 'archive-kept'`,
        );
        yield* sql`UPDATE fixture_base.orchestration_v2_projection_turn_items SET payload_json = '{"source":"stale"}' WHERE turn_item_id = 'archive-kept'`;
      }
      yield* sql`INSERT INTO ardud_history_archive_state VALUES (1, 1)`;
      yield* sql`INSERT INTO ardud_history_archive_cursor VALUES (1, 'stopped-thread')`;
      yield* sql`INSERT INTO ardud_history_archive_progress (thread_id) VALUES ('stopped-thread')`;
      yield* sql`INSERT INTO ardud_history_archive_deletions (table_name, row_key, through_event_sequence, archived_at)
      VALUES ('orchestration_v2_projection_turn_items', 'old', 100, '2026-08-01')`;
      yield* sql`UPDATE ardud_shell_item_count_state SET base = 'old-base.sqlite'`;
      yield* sql`UPDATE ardud_shell_item_counts SET item_count = 999`;
    }),
  );
});

it.layer(NodeServices.layer)("migrate-dev-db", (it) => {
  it.effect("reseeds a hot-only destination without retaining its old turn items", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sourceDir = yield* fs.makeTempDirectoryScoped({
        prefix: "migrate-dev-db-hot-reseed-src-",
      });
      const destDir = yield* fs.makeTempDirectoryScoped({
        prefix: "migrate-dev-db-hot-reseed-dest-",
      });
      const source = yield* createFixtureSource(sourceDir);
      const destination = yield* createFixtureSource(destDir);
      yield* withDatabase(
        destination,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO orchestration_v2_projection_turn_items
          (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json)
          VALUES ('previous-item', 'stopped-thread', 1, 'assistant_message', 'completed', '2026-08-01', '{}')`;
        }),
      );
      const result = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 1 },
        { sharedHome: sourceDir },
      );
      assert.equal(result.databasePath, destination);
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        assert.deepStrictEqual(yield* sql`SELECT turn_item_id FROM ardud_history_turn_items`, []);
      }).pipe(Effect.provide(Sqlite.layerFromPath(destination)));
    }),
  );

  it.effect.each(["paired", "orphaned"] as const)(
    "rejects reseeding with a %s destination archive and preserves its cold history",
    (kind) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const sourceDir = yield* fs.makeTempDirectoryScoped({
          prefix: "migrate-dev-db-reseed-src-",
        });
        const destDir = yield* fs.makeTempDirectoryScoped({
          prefix: "migrate-dev-db-reseed-dest-",
        });
        const source = yield* createFixtureSource(sourceDir);
        const destination = yield* createFixtureSource(destDir);
        yield* addColdHistory(destination, "archive");
        const archivePath = archiveFilename(destination);
        const sourceBefore = yield* fs.readFile(source);
        const destinationBefore = yield* fs.readFile(destination);
        const archiveBefore = yield* fs.readFile(archivePath);
        if (kind === "orphaned") yield* fs.remove(destination);

        const error = yield* runMigrateDevDb(
          { baseDir: destDir, source, projects: 5, threadsPerProject: 1 },
          { sharedHome: sourceDir },
        ).pipe(Effect.flip);
        assert.equal(error._tag, "MigrateDevDbDestinationArchiveError");
        if (error._tag === "MigrateDevDbDestinationArchiveError") {
          assert.equal(error.databasePath, destination);
          assert.equal(error.archivePath, archivePath);
          assert.include(error.message, "new --base-dir");
        }
        assert.deepStrictEqual(yield* fs.readFile(source), sourceBefore);
        assert.deepStrictEqual(yield* fs.readFile(archivePath), archiveBefore);
        assert.isFalse(yield* fs.exists(`${destination}.migrate-dev-db-tmp`));
        if (kind === "orphaned") {
          assert.isFalse(yield* fs.exists(destination));
        } else {
          assert.deepStrictEqual(yield* fs.readFile(destination), destinationBefore);
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const items = yield* sql<{
              turn_item_id: string;
            }>`SELECT turn_item_id FROM ardud_history_turn_items ORDER BY turn_item_id`;
            assert.deepStrictEqual(
              items.map((row) => row.turn_item_id),
              ["archive-dropped", "archive-kept", "archive-running", "hot-item", "shadowed-item"],
            );
          }).pipe(Effect.provide(Sqlite.layerFromPath(destination)));
        }
      }),
  );

  it.effect.each([
    { suffix: "-wal", duringCopy: false },
    { suffix: "-shm", duringCopy: false },
    { suffix: "", duringCopy: true },
    { suffix: "-wal", duringCopy: true },
    { suffix: "-shm", duringCopy: true },
  ])(
    "rejects destination history file %j before replacing its database",
    ({ suffix, duringCopy }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const sourceDir = yield* fs.makeTempDirectoryScoped({
          prefix: "migrate-dev-db-sidecar-src-",
        });
        const destDir = yield* fs.makeTempDirectoryScoped({
          prefix: "migrate-dev-db-sidecar-dest-",
        });
        const source = yield* createFixtureSource(sourceDir);
        const destination = yield* createFixtureSource(destDir);
        const archivePath = archiveFilename(destination);
        const historyPath = `${archivePath}${suffix}`;
        const destinationBefore = yield* fs.readFile(destination);
        if (!duringCopy) yield* fs.writeFileString(historyPath, "previous archive sidecar");
        let checkedArchive = false;
        const files = FileSystem.FileSystem.of({
          ...fs,
          exists: Effect.fn("lateDestinationArchive.exists")(function* (filename: string) {
            if (duringCopy && filename === archivePath) {
              if (checkedArchive) yield* fs.writeFileString(historyPath, "late archive file");
              checkedArchive = true;
            }
            return yield* fs.exists(filename);
          }),
        });
        const error = yield* runMigrateDevDb(
          { baseDir: destDir, source, projects: 5, threadsPerProject: 1 },
          { sharedHome: sourceDir },
        ).pipe(Effect.provideService(FileSystem.FileSystem, files), Effect.flip);
        assert.equal(error._tag, "MigrateDevDbDestinationArchiveError");
        if (error._tag === "MigrateDevDbDestinationArchiveError")
          assert.equal(error.archivePath, historyPath);
        assert.deepStrictEqual(yield* fs.readFile(destination), destinationBefore);
        assert.equal(
          yield* fs.readFileString(historyPath),
          duringCopy ? "late archive file" : "previous archive sidecar",
        );
        assert.isFalse(yield* fs.exists(`${destination}.migrate-dev-db-tmp`));
      }),
  );

  it.effect.each(["archive", "base", "archive-and-base"] as const)(
    "materializes %s history and opens through the server SQLite layer",
    (mode) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-history-" });
        const destDir = yield* fs.makeTempDirectoryScoped({
          prefix: "migrate-dev-db-history-dest-",
        });
        const source = yield* createFixtureSource(sourceDir);
        yield* addColdHistory(source, mode);
        const before = yield* fs.readFile(source);
        const result = yield* runMigrateDevDb(
          { baseDir: destDir, source, projects: 5, threadsPerProject: 1 },
          { sharedHome: sourceDir },
        );
        assert.deepStrictEqual(yield* fs.readFile(source), before);
        assert.isFalse(yield* fs.exists(archiveFilename(result.databasePath)));
        yield* withDatabase(
          result.databasePath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            for (const name of [
              "ardud_history_archive_identity",
              "ardud_history_archive_state",
              "ardud_history_base_archive",
              "ardud_history_archive_cursor",
              "ardud_history_archive_progress",
              "ardud_history_archive_deletions",
              "ardud_shell_item_count_state",
              "ardud_shell_item_counts",
            ]) {
              const exists = yield* sql`SELECT 1 FROM sqlite_master WHERE name = ${name}`;
              if (exists.length > 0)
                assert.deepStrictEqual(yield* sql`SELECT * FROM ${sql(name)}`, []);
            }
          }),
        );
        const stores = mode === "archive-and-base" ? ["archive", "base"] : [mode];
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          assert.deepStrictEqual(
            yield* sql`SELECT payload_json FROM ardud_history_events WHERE sequence = 100`,
            [{ payload_json: '{"source":"hot"}' }],
          );
          const items = yield* sql<{
            turn_item_id: string;
            payload_json: string;
          }>`SELECT turn_item_id, payload_json FROM ardud_history_turn_items ORDER BY turn_item_id`;
          assert.deepStrictEqual(items, [
            ...stores.map((store) => ({
              turn_item_id: `${store}-kept`,
              payload_json: JSON.stringify({ source: store }),
            })),
            { turn_item_id: "hot-item", payload_json: '{"source":"hot"}' },
          ]);
          const events = yield* sql<{
            event_id: string;
            payload_json: string;
          }>`SELECT event_id, payload_json FROM ardud_history_events WHERE sequence > 100 ORDER BY sequence`;
          assert.deepStrictEqual(
            events,
            stores.flatMap((store) => [
              { event_id: `${store}-kept`, payload_json: JSON.stringify({ source: store }) },
              { event_id: `${store}-global`, payload_json: JSON.stringify({ source: store }) },
            ]),
          );
          const [sequence] = yield* sql<{
            seq: number;
            max: number;
          }>`SELECT seq, (SELECT MAX(sequence) FROM orchestration_events) AS max FROM sqlite_sequence WHERE name = 'orchestration_events'`;
          assert.isAtLeast(sequence!.seq, sequence!.max);
          const [appended] = yield* sql<{ sequence: number }>`INSERT INTO orchestration_events
          (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json)
          VALUES ('appended', 'thread', 'stopped-thread', 999, 'thread.metadata-updated', '2026-08-01', 'server', '{}', '{}') RETURNING sequence`;
          assert.isAbove(appended!.sequence, sequence!.max);
          assert.isAbove(appended!.sequence, 400);
          assert.deepStrictEqual(
            yield* sql`SELECT item_count FROM ardud_shell_item_counts WHERE thread_id = 'stopped-thread'`,
            [{ item_count: stores.length + 1 }],
          );
        }).pipe(Effect.provide(Sqlite.layerFromPath(result.databasePath)));
      }),
  );

  it.effect.each(["missing", "identity-mismatch", "missing-base", "unsafe-base"] as const)(
    "rejects %s history without publishing a destination",
    (kind) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sourceDir = yield* fs.makeTempDirectoryScoped({
          prefix: "migrate-dev-db-broken-history-",
        });
        const destDir = yield* fs.makeTempDirectoryScoped({
          prefix: "migrate-dev-db-broken-history-dest-",
        });
        const source = yield* createFixtureSource(sourceDir);
        const archivePath = archiveFilename(source);
        let expectedPath = archivePath;
        if (kind === "identity-mismatch") {
          yield* addColdHistory(source, "archive");
          yield* withDatabase(
            archivePath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* sql`UPDATE ardud_identity SET identity = 'different'`;
            }),
          );
        } else {
          yield* withDatabase(
            source,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              if (kind === "missing") {
                yield* sql`CREATE TABLE ardud_history_archive_state (singleton INTEGER PRIMARY KEY, has_cold_rows INTEGER)`;
                yield* sql`INSERT INTO ardud_history_archive_state VALUES (1, 1)`;
              } else {
                yield* sql`CREATE TABLE ardud_history_base_archive (filename TEXT)`;
                yield* sql`INSERT INTO ardud_history_base_archive VALUES (${kind === "unsafe-base" ? "../statev2.pre-shrink-outside.sqlite" : "statev2.pre-shrink-missing.sqlite"})`;
              }
            }),
          );
          if (kind === "missing-base")
            expectedPath = path.join(path.dirname(source), "statev2.pre-shrink-missing.sqlite");
          if (kind === "unsafe-base") expectedPath = source;
        }
        const error = yield* runMigrateDevDb(
          { baseDir: destDir, source, projects: 5, threadsPerProject: 1 },
          { sharedHome: sourceDir },
        ).pipe(Effect.flip);
        assert.equal(error._tag, "MigrateDevDbHistoryArchiveError");
        if (error._tag === "MigrateDevDbHistoryArchiveError") {
          assert.equal(error.archivePath, expectedPath);
          assert.include(error.message, expectedPath);
        }
        const destination = path.join(destDir, "userdata", "statev2.sqlite");
        assert.isFalse(yield* fs.exists(destination));
        assert.isFalse(yield* fs.exists(`${destination}.migrate-dev-db-tmp`));
      }),
  );

  it.effect.each(["zero-byte", "no tables"] as const)(
    "rejects a %s source without replacing the destination",
    (kind) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-empty-" });
        const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-empty-dest-" });
        const source = path.join(sourceDir, "statev2.sqlite");
        if (kind === "zero-byte") {
          yield* fs.writeFileString(source, "");
        } else {
          yield* withDatabase(
            source,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* sql`PRAGMA user_version = 1`;
            }),
          );
          assert.isAbove(Number((yield* fs.stat(source)).size), 0);
        }
        const databasePath = yield* createFixtureSource(destDir);
        const destinationBefore = yield* fs.readFile(databasePath);

        const error = yield* runMigrateDevDb(
          { baseDir: destDir, source, projects: 5, threadsPerProject: 10 },
          { sharedHome: sourceDir },
        ).pipe(Effect.flip);

        assert.equal(error._tag, "MigrateDevDbSourceEmptyError");
        if (error._tag === "MigrateDevDbSourceEmptyError") {
          assert.equal(error.sourcePath, source);
          assert.equal(
            error.message,
            `Source database '${source}' is empty (no tables). Pass --source <path to a real statev2.sqlite>, or skip migrate-dev-db and let the dev server create a fresh database in the worktree .t3.`,
          );
        }
        assert.deepStrictEqual(yield* fs.readFile(databasePath), destinationBefore);
      }),
  );

  it.effect("copies a source without AUTOINCREMENT tables", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-no-seq-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-no-seq-dest-" });
      const source = path.join(sourceDir, "statev2.sqlite");
      yield* withDatabase(
        source,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TABLE example (id INTEGER PRIMARY KEY, value TEXT NOT NULL)`;
          yield* sql`INSERT INTO example VALUES (1, 'copied')`;
          const sequenceTables = yield* sql`
            SELECT name FROM sqlite_master WHERE name = 'sqlite_sequence'`;
          assert.equal(sequenceTables.length, 0);
        }),
      );

      const result = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 10 },
        { sharedHome: sourceDir },
      );

      const copied = yield* withDatabase(
        result.databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{ id: number; value: string }>`SELECT id, value FROM example`;
        }),
      );
      assert.deepStrictEqual(copied, [{ id: 1, value: "copied" }]);
    }),
  );

  it.effect("keeps stopped thread families from live projects and clears pending work", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-src-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-dest-" });
      const source = yield* createFixtureSource(sourceDir);

      const result = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 1 },
        { sharedHome: sourceDir },
      );

      assert.equal(result.databasePath, path.join(destDir, "userdata", "statev2.sqlite"));
      const kept = yield* withDatabase(
        result.databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const threads = yield* sql<{ thread_id: string }>`
            SELECT thread_id FROM orchestration_v2_projection_threads ORDER BY thread_id`;
          const events = yield* sql<{ stream_id: string }>`
            SELECT stream_id FROM orchestration_events ORDER BY stream_id`;
          const sessions = yield* sql<{ provider_session_id: string }>`
            SELECT provider_session_id FROM orchestration_v2_projection_provider_sessions`;
          const [leftovers] = yield* sql<{ auth: number; tasks: number; transfers: number }>`
            SELECT
              (SELECT COUNT(*) FROM auth_sessions) AS auth,
              (SELECT COUNT(*) FROM scheduled_tasks) AS tasks,
              (SELECT COUNT(*) FROM orchestration_v2_projection_context_transfers) AS transfers`;
          return { threads, events, sessions, leftovers };
        }),
      );
      assert.deepStrictEqual(
        kept.threads.map((row) => row.thread_id),
        ["fork-thread", "stopped-thread"],
      );
      assert.deepStrictEqual(
        kept.events.map((row) => row.stream_id),
        ["fork-thread", "stopped-thread"],
      );
      assert.deepStrictEqual(
        kept.sessions.map((row) => row.provider_session_id),
        ["session-shared"],
      );
      assert.deepStrictEqual(kept.leftovers, { auth: 0, tasks: 0, transfers: 0 });
    }),
  );

  it.effect("never copies a settled thread's rows, and new events append after the source's", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-slice-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-slice-dest-" });
      const source = yield* createFixtureSource(sourceDir);
      const [sourceSequence] = yield* withDatabase(
        source,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{ seq: number }>`
            SELECT seq FROM sqlite_sequence WHERE name = 'orchestration_events'`;
        }),
      );

      const result = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 100 },
        { sharedHome: sourceDir },
      );

      const copied = yield* withDatabase(
        result.databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const [settledRows] = yield* sql<{ count: number }>`
            SELECT
              (SELECT COUNT(*) FROM orchestration_v2_projection_runs WHERE thread_id = 'settled-thread')
              + (SELECT COUNT(*) FROM orchestration_events WHERE stream_id = 'settled-thread')
              AS count`;
          const [sequence] = yield* sql<{ seq: number }>`
            SELECT seq FROM sqlite_sequence WHERE name = 'orchestration_events'`;
          return { settledRows: settledRows?.count, sequence: sequence?.seq };
        }),
      );
      assert.equal(copied.settledRows, 0);
      assert.equal(copied.sequence, sourceSequence?.seq);
    }),
  );

  it.effect("upgrades a source from before the V2 thread tables", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-v1-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-v1-dest-" });
      const stateDir = path.join(sourceDir, "userdata");
      const source = path.join(stateDir, "statev2.sqlite");
      yield* fs.makeDirectory(stateDir, { recursive: true });
      yield* withDatabase(source, runMigrations({ toMigrationInclusive: 54 }));

      const result = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 10 },
        { sharedHome: sourceDir },
      );
      assert.include(result.executedMigrations, "55_OrchestrationV2");
    }),
  );

  it.effect("fails loudly on a migration slot collision", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-slot-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-slot-dest-" });
      const source = yield* createFixtureSource(sourceDir);
      yield* withDatabase(
        source,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE effect_sql_migrations
            SET name = 'SomebodyElsesMigration' WHERE migration_id = 1`;
        }),
      );

      const error = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 10 },
        { sharedHome: sourceDir },
      ).pipe(Effect.flip);
      assert.equal(error._tag, "MigrateDevDbSlotCollisionError");
      if (error._tag === "MigrateDevDbSlotCollisionError") {
        assert.equal(error.slot, 1);
        assert.equal(error.appliedName, "SomebodyElsesMigration");
      }
    }),
  );

  it.effect("refuses while a dev server holds the destination", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-busy-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-busy-dest-" });
      const source = yield* createFixtureSource(sourceDir);
      const stateDir = path.join(destDir, "userdata");
      yield* fs.makeDirectory(stateDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(stateDir, "server-runtime.json"),
        `{"version":1,"pid":${process.pid}}`,
      );

      const error = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 10 },
        { sharedHome: sourceDir },
      ).pipe(Effect.flip);
      assert.equal(error._tag, "MigrateDevDbServerRunningError");
      if (error._tag === "MigrateDevDbServerRunningError") {
        assert.equal(error.pid, process.pid);
      }
    }),
  );

  it.effect("refuses a source that resolves to a destination path", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sharedDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-overlap-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-overlap-dest-" });
      const leftoverSnapshot = path.join(destDir, "userdata", "statev2.sqlite.migrate-dev-db-tmp");
      yield* fs.makeDirectory(path.dirname(leftoverSnapshot), { recursive: true });
      yield* fs.writeFileString(leftoverSnapshot, "not a real db");

      const error = yield* runMigrateDevDb(
        { baseDir: destDir, source: leftoverSnapshot, projects: 5, threadsPerProject: 10 },
        { sharedHome: sharedDir },
      ).pipe(Effect.flip);
      assert.equal(error._tag, "MigrateDevDbSourceIsDestinationError");
      assert.equal(yield* fs.exists(leftoverSnapshot), true);
    }),
  );

  it.effect("refuses to rebuild the shared home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-shared-" });
      const source = yield* createFixtureSource(sourceDir);

      const error = yield* runMigrateDevDb(
        { baseDir: sourceDir, source, projects: 5, threadsPerProject: 10 },
        { sharedHome: sourceDir },
      ).pipe(Effect.flip);
      assert.equal(error._tag, "MigrateDevDbSharedHomeError");
    }),
  );
});
