// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

const CountSeed = Schema.Struct({
  baseFilename: Schema.String,
  sequence: Schema.Number,
  identity: Schema.String,
  counts: Schema.Array(
    Schema.Struct({
      thread_id: Schema.String,
      run_id: Schema.NullOr(Schema.String),
      item_count: Schema.Number,
    }),
  ),
});

export const shellItemCountSchema = [
  `CREATE TABLE IF NOT EXISTS ardud_shell_item_counts (
    thread_id TEXT NOT NULL, run_key TEXT NOT NULL, item_count INTEGER NOT NULL,
    PRIMARY KEY(thread_id, run_key)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS ardud_shell_item_count_state (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1), ready INTEGER NOT NULL,
    base TEXT NOT NULL DEFAULT '')`,
];

// A move to archive is two commits. Count the winning identity, not physical
// copies, so both the overlap and the later main deletion leave counts unchanged.
export const shellItemCountTriggers = (includeMutableBase = false) => {
  const tables = [
    "main.orchestration_v2_projection_turn_items",
    "ardud_archive.ardud_turn_items",
    "ardud_base.orchestration_v2_projection_turn_items",
  ];
  const group = (row: string) => `${row}.thread_id, COALESCE(${row}.run_id, '')`;
  const adjust = (select: string, amount: number) => `
    INSERT INTO ardud_shell_item_counts(thread_id, run_key, item_count)
    SELECT thread_id, COALESCE(run_id, ''), ${amount} FROM (${select}) WHERE 1
    ON CONFLICT(thread_id, run_key) DO UPDATE SET item_count = item_count + excluded.item_count;`;
  return tables.flatMap((table, priority) => {
    if (priority === 2 && !includeMutableBase) return [];
    const higher = (row: string) =>
      tables
        .slice(0, priority)
        .map(
          (source) =>
            `NOT EXISTS(SELECT 1 FROM ${source} WHERE turn_item_id = ${row}.turn_item_id)`,
        )
        .join(" AND ") || "1";
    const lower = (row: string) =>
      tables
        .slice(priority + 1)
        .map(
          (source, index) =>
            `SELECT thread_id, run_id FROM ${source} WHERE turn_item_id = ${row}.turn_item_id${tables
              .slice(priority + 1, priority + 1 + index)
              .map(
                (earlier) =>
                  ` AND NOT EXISTS(SELECT 1 FROM ${earlier} WHERE turn_item_id = ${row}.turn_item_id)`,
              )
              .join("")}`,
        )
        .join(" UNION ALL ");
    const own = (row: string) => `SELECT ${row}.thread_id AS thread_id, ${row}.run_id AS run_id`;
    const name = `ardud_shell_counts_${priority}`;
    return [
      `CREATE TEMP TRIGGER IF NOT EXISTS ${name}_insert AFTER INSERT ON ${table}
       WHEN ${higher("NEW")} BEGIN
       ${lower("NEW") ? adjust(lower("NEW"), -1) : ""}
       ${adjust(own("NEW"), 1)} END`,
      `CREATE TEMP TRIGGER IF NOT EXISTS ${name}_delete AFTER DELETE ON ${table}
       WHEN ${higher("OLD")} BEGIN
       ${adjust(own("OLD"), -1)}
       ${lower("OLD") ? adjust(lower("OLD"), 1) : ""} END`,
      `CREATE TEMP TRIGGER IF NOT EXISTS ${name}_update AFTER UPDATE OF thread_id, run_id ON ${table}
       WHEN (${group("OLD")}) IS NOT (${group("NEW")}) AND ${higher("NEW")} BEGIN
       ${adjust(own("OLD"), -1)} ${adjust(own("NEW"), 1)} END`,
    ];
  });
};

export const initializeShellItemCounts = Effect.fn("HistoryArchive.initializeShellItemCounts")(
  function* (baseFilename: string | undefined) {
    const sql = yield* SqlClient.SqlClient;
    for (const statement of shellItemCountSchema) yield* sql.unsafe(statement);
    // Counts describe the logical union, which an offline split preserves.
    // The seed is needed only for databases created before this summary existed.
    const base = baseFilename === undefined ? "" : NodePath.basename(baseFilename);
    const ready = yield* sql`SELECT 1 FROM ardud_shell_item_count_state WHERE ready = 1`;
    if (ready.length === 0) {
      const seed = baseFilename === undefined ? undefined : yield* loadShellItemCountSeed();
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM ardud_shell_item_counts`;
          if (seed === undefined) {
            yield* sql`INSERT INTO ardud_shell_item_counts
              SELECT thread_id, COALESCE(run_id, ''), COUNT(*) FROM ardud_history_turn_items
              GROUP BY thread_id, COALESCE(run_id, '')`;
          } else {
            for (let offset = 0; offset < seed.counts.length; offset += 500) {
              yield* sql`INSERT INTO ardud_shell_item_counts ${sql.insert(
                seed.counts.slice(offset, offset + 500).map((row) => ({
                  thread_id: row.thread_id,
                  run_key: row.run_id ?? "",
                  item_count: row.item_count,
                })),
              )}`;
            }
            const changed = yield* sql<{ item_id: string }>`
              SELECT DISTINCT json_extract(payload_json, '$.id') AS item_id
              FROM main.orchestration_events NOT INDEXED WHERE sequence > ${seed.sequence}
                AND event_type = 'turn-item.updated'
              UNION SELECT DISTINCT json_extract(payload_json, '$.id') AS item_id
              FROM ardud_archive.ardud_events INDEXED BY ardud_events_sequence_idx
              WHERE sequence > ${seed.sequence} AND event_type = 'turn-item.updated'`;
            const delta = yield* sql<{
              item_id: string;
            }>`SELECT turn_item_id AS item_id FROM ardud_archive.ardud_turn_items`;
            for (const id of new Set([...changed, ...delta].map((row) => row.item_id))) {
              yield* sql`UPDATE ardud_shell_item_counts SET item_count = item_count - 1
                WHERE (thread_id, run_key) IN (SELECT thread_id, COALESCE(run_id, '')
                  FROM ardud_base.orchestration_v2_projection_turn_items WHERE turn_item_id = ${id})`;
              yield* sql`INSERT INTO ardud_shell_item_counts(thread_id, run_key, item_count)
                SELECT thread_id, COALESCE(run_id, ''), 1 FROM (
                  SELECT thread_id, run_id FROM main.orchestration_v2_projection_turn_items WHERE turn_item_id = ${id}
                  UNION ALL SELECT thread_id, run_id FROM ardud_archive.ardud_turn_items WHERE turn_item_id = ${id}
                  UNION ALL SELECT thread_id, run_id FROM ardud_base.orchestration_v2_projection_turn_items WHERE turn_item_id = ${id}
                  LIMIT 1
                ) WHERE 1 ON CONFLICT(thread_id, run_key) DO UPDATE SET item_count = item_count + 1`;
            }
          }
          yield* sql`INSERT OR REPLACE INTO ardud_shell_item_count_state(singleton, ready, base)
            VALUES (1, 1, ${base})`;
        }),
      );
    }
    for (const statement of shellItemCountTriggers(baseFilename === undefined)) {
      yield* sql.unsafe(statement);
    }
  },
);

const decodeCountSeed = Schema.decodeUnknownEffect(Schema.fromJsonString(CountSeed));
const loadShellItemCountSeed = Effect.fn("HistoryArchive.loadShellItemCountSeed")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fsOption = yield* Effect.serviceOption(FileSystem.FileSystem);
  const pathOption = yield* Effect.serviceOption(Path.Path);
  if (Option.isNone(fsOption) || Option.isNone(pathOption)) {
    return yield* Effect.die(new Error("Shell item count seed requires filesystem services."));
  }
  const fs = fsOption.value;
  const path = pathOption.value;
  const databases = yield* sql<{ name: string; file: string }>`PRAGMA database_list`;
  const filename = databases.find((row) => row.name === "main")!.file;
  const base = databases.find((row) => row.name === "ardud_base")!.file;
  const seed = yield* fs
    .readFileString(path.join(path.dirname(filename), "shell-item-count-seed.json"))
    .pipe(Effect.flatMap(decodeCountSeed), Effect.catchTags({ SchemaError: Effect.die }));
  const identities = yield* sql<{
    identity: string;
  }>`SELECT identity FROM ardud_history_archive_identity`;
  const sequences = yield* sql<{ base_sequence: number; main_sequence: number }>`SELECT
    (SELECT COALESCE(MAX(sequence), 0) FROM ardud_base.orchestration_events) AS base_sequence,
    (SELECT COALESCE(MAX(sequence), 0) FROM main.orchestration_events) AS main_sequence`;
  if (
    seed.baseFilename !== path.basename(base) ||
    seed.identity !== identities[0]?.identity ||
    seed.sequence !== sequences[0]?.base_sequence ||
    seed.sequence > sequences[0]!.main_sequence ||
    seed.counts.some((row) => !Number.isSafeInteger(row.item_count) || row.item_count < 0)
  ) {
    return yield* Effect.die(
      new Error("Shell item count seed does not match this history archive."),
    );
  }
  return seed;
});
