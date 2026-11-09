// Pure SQL construction also runs before the Effect layer exists; no filesystem I/O.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

// Connection-local views keep writes in main while old transcripts stay cold.
export const HISTORY_TABLES = [
  {
    live: "orchestration_events",
    archive: "ardud_events",
    view: "ardud_history_events",
    key: "sequence",
  },
  {
    live: "orchestration_v2_projection_turn_items",
    archive: "ardud_turn_items",
    view: "ardud_history_turn_items",
    key: "turn_item_id",
  },
] as const;

export const historyViewSql = ({ live, archive, view, key }: (typeof HISTORY_TABLES)[number]) =>
  `CREATE TEMP VIEW IF NOT EXISTS ${view} AS
   SELECT rowid AS rowid, * FROM main.${live}
   UNION ALL
   SELECT ardud_locator AS rowid, ${liveColumns(live)
     .split(", ")
     .map((column) => `cold.${column}`)
     .join(", ")} FROM ardud_archive.${archive} AS cold
   WHERE NOT EXISTS (SELECT 1 FROM main.${live} AS hot WHERE hot.${key} = cold.${key})
   UNION ALL
   SELECT CAST(-base.rowid AS INTEGER) AS rowid, ${liveColumns(live)
     .split(", ")
     .map((column) => `base.${column}`)
     .join(", ")}
   FROM ardud_base.${live} AS base
   WHERE NOT EXISTS (SELECT 1 FROM main.${live} AS hot WHERE hot.${key} = base.${key})
     AND NOT EXISTS (SELECT 1 FROM ardud_archive.${archive} AS delta WHERE delta.${key} = base.${key})`;

// Explicit columns keep the archive's synthetic negative rowid out of SELECT *.
export const liveColumns = (table: (typeof HISTORY_TABLES)[number]["live"]) =>
  table === "orchestration_events"
    ? "sequence, event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json, application_event_version"
    : "turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id, parent_item_id, ordinal, type, status, updated_at, payload_json";

// Keep the hot-store planner hints at the union branches. A reconnect range must
// not turn a command lookup into a walk through every event since that cursor.
export const eventHistoryLookupViews = [
  ["ardud_command_history_events", "idx_orch_events_command_id", "ardud_events_command_idx"],
  [
    "ardud_application_history_events",
    "idx_orchestration_events_application_high_water",
    "ardud_events_sequence_idx",
  ],
  // The delta writer admits only V2 thread events; hot/base also contain V1 history.
  [
    "ardud_thread_history_events",
    "idx_orchestration_events_agent_stream_sequence",
    "ardud_events_stream_idx",
    "application_event_version = 2 AND aggregate_kind = 'thread'",
  ],
].map(
  ([view, hotIndex, coldIndex, predicate]) => `CREATE TEMP VIEW IF NOT EXISTS ${view} AS
  SELECT rowid AS rowid, * FROM main.orchestration_events INDEXED BY ${hotIndex}
  ${predicate === undefined ? "" : `WHERE ${predicate}`}
  UNION ALL
  SELECT ardud_locator AS rowid, ${liveColumns("orchestration_events")
    .split(", ")
    .map((column) => `cold.${column}`)
    .join(", ")}
  FROM ardud_archive.ardud_events AS cold INDEXED BY ${coldIndex}
   WHERE ${predicate === undefined ? "" : `${predicate} AND `}NOT EXISTS (SELECT 1 FROM main.orchestration_events AS hot WHERE hot.sequence = cold.sequence)
  UNION ALL
  SELECT CAST(-base.rowid AS INTEGER) AS rowid, ${liveColumns("orchestration_events")
    .split(", ")
    .map((column) => `base.${column}`)
    .join(", ")}
  FROM ardud_base.orchestration_events AS base INDEXED BY ${hotIndex}
   WHERE ${predicate === undefined ? "" : `${predicate} AND `}NOT EXISTS (SELECT 1 FROM main.orchestration_events AS hot WHERE hot.sequence = base.sequence)
    AND NOT EXISTS (SELECT 1 FROM ardud_archive.ardud_events AS delta WHERE delta.sequence = base.sequence)`,
);

export const archiveFilename = (filename: string) =>
  NodePath.join(NodePath.dirname(filename), "archive.sqlite");
export const baseArchiveFilename = (filename: string, basename: string) =>
  NodePath.resolve(NodePath.dirname(filename), basename);

export const historyReaderSql = (filename: string, baseFilename?: string) => [
  `ATTACH DATABASE '${`${NodeURL.pathToFileURL(archiveFilename(filename)).href}?mode=ro`.replaceAll("'", "''")}' AS ardud_archive`,
  baseFilename === undefined
    ? "ATTACH DATABASE 'file::memory:?mode=memory&cache=private' AS ardud_base"
    : `ATTACH DATABASE '${`${NodeURL.pathToFileURL(baseFilename).href}?mode=ro`.replaceAll("'", "''")}' AS ardud_base`,
  ...(baseFilename === undefined ? emptyBaseSchemaSql : []),
  ...HISTORY_TABLES.map(historyViewSql),
  ...eventHistoryLookupViews,
];

// Empty base connections let fresh databases use the same indexed read paths.
export const emptyBaseSchemaSql = [
  `CREATE TABLE ardud_base.orchestration_events (${liveColumns("orchestration_events")
    .split(", ")
    .map(
      (name) =>
        `${name} ${name === "sequence" ? "INTEGER PRIMARY KEY" : ["stream_version", "application_event_version"].includes(name) ? "INTEGER" : "TEXT"}`,
    )
    .join(", ")})`,
  `CREATE TABLE ardud_base.orchestration_v2_projection_turn_items (${liveColumns(
    "orchestration_v2_projection_turn_items",
  )
    .split(", ")
    .map(
      (name) =>
        `${name} ${name === "ordinal" ? "INTEGER" : "TEXT"}${name === "turn_item_id" ? " PRIMARY KEY" : ""}`,
    )
    .join(", ")})`,
  "CREATE INDEX ardud_base.idx_orch_events_command_id ON orchestration_events(command_id)",
  "CREATE INDEX ardud_base.idx_orchestration_events_application_high_water ON orchestration_events(sequence)",
  "CREATE INDEX ardud_base.idx_orchestration_events_agent_stream_sequence ON orchestration_events(stream_id,sequence) WHERE application_event_version = 2 AND aggregate_kind = 'thread'",
  "CREATE INDEX ardud_base.orchestration_v2_projection_turn_items_run_ordinal_idx ON orchestration_v2_projection_turn_items(run_id,ordinal)",
  "CREATE INDEX ardud_base.orchestration_v2_projection_turn_items_thread_ordinal_idx ON orchestration_v2_projection_turn_items(thread_id,ordinal,turn_item_id)",
  "CREATE INDEX ardud_base.orchestration_v2_projection_turn_items_thread_run_idx ON orchestration_v2_projection_turn_items(thread_id,run_id)",
  "CREATE INDEX ardud_base.orchestration_v2_projection_turn_items_user_message_idx ON orchestration_v2_projection_turn_items(thread_id,ordinal,turn_item_id) WHERE type='user_message'",
  "CREATE INDEX ardud_base.orchestration_v2_projection_turn_items_failed_error_idx ON orchestration_v2_projection_turn_items(thread_id,run_id,node_id,updated_at DESC,ordinal DESC,turn_item_id DESC) WHERE type='error' AND status='failed'",
];

/**
 * The modelSelection of an attempt's first running `run.updated` event, read
 * from each store through its stream index. A correlated subquery on
 * ardud_thread_history_events/ardud_history_events cannot push the outer
 * `stream_id` into the union branches, so SQLite walked every V2 event in the
 * base archive per row. Hot rows hide archive and base copies, as in the views.
 * `attempt` names the outer run_attempts alias; it is SQL text, never input.
 */
export const firstRunningSelectionSql = (attempt: string) => {
  const where = (store: string) => `${store}.application_event_version = 2
        AND ${store}.aggregate_kind = 'thread'
        AND ${store}.stream_id = ${attempt}.thread_id
        AND ${store}.event_type = 'run.updated'
        AND json_extract(${store}.payload_json, '$.id') = ${attempt}.run_id
        AND json_extract(${store}.payload_json, '$.activeAttemptId') = ${attempt}.attempt_id
        AND json_extract(${store}.payload_json, '$.status') = 'running'`;
  return `(SELECT json_extract(event.payload_json, '$.modelSelection') FROM (
      SELECT * FROM (SELECT hot.sequence, hot.payload_json FROM main.orchestration_events AS hot
        INDEXED BY idx_orchestration_events_agent_stream_sequence
        WHERE ${where("hot")} ORDER BY hot.sequence LIMIT 1)
      UNION ALL
      SELECT * FROM (SELECT cold.sequence, cold.payload_json FROM ardud_archive.ardud_events AS cold
        INDEXED BY ardud_events_stream_idx
        WHERE ${where("cold")}
          AND NOT EXISTS (SELECT 1 FROM main.orchestration_events AS hidden WHERE hidden.sequence = cold.sequence)
        ORDER BY cold.sequence LIMIT 1)
      UNION ALL
      SELECT * FROM (SELECT base.sequence, base.payload_json FROM ardud_base.orchestration_events AS base
        INDEXED BY idx_orchestration_events_agent_stream_sequence
        WHERE ${where("base")}
          AND NOT EXISTS (SELECT 1 FROM main.orchestration_events AS hidden WHERE hidden.sequence = base.sequence)
          AND NOT EXISTS (SELECT 1 FROM ardud_archive.ardud_events AS delta WHERE delta.sequence = base.sequence)
        ORDER BY base.sequence LIMIT 1)
    ) AS event ORDER BY event.sequence LIMIT 1)`;
};
