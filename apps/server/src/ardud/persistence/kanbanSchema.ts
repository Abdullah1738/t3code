import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

// Legacy board copies can lack the older ask/open indexes too. Fetch their
// payload pages before CREATE INDEX takes the writer, without parsing JSON.
export const initializeKanbanSchema = Effect.fn("initializeKanbanSchema")(function* (
  sql: SqlClient.SqlClient,
) {
  const objects = yield* sql<{ name: string }>`SELECT name FROM sqlite_schema`;
  const names = new Set(objects.map(({ name }) => name));
  for (const table of [
    "ardud_kanban_cards",
    "ardud_kanban_card_events",
    "ardud_kanban_discussions",
  ]) {
    const missingIndex = kanbanDDL.some((ddl) => {
      const match = /^CREATE INDEX IF NOT EXISTS (\w+)\s+ON (\w+)/.exec(ddl);
      return match?.[2] === table && !names.has(match[1]!);
    });
    if (names.has(table) && missingIndex) {
      yield* sql.unsafe(`SELECT sum(length(json || '')) FROM ${table} NOT INDEXED`);
    }
  }
  yield* Effect.forEach(kanbanDDL, (ddl) => sql.unsafe(ddl), { discard: true });
});

export const kanbanDDL = [
  // Survives the content transaction until orchestration accepts every thread deletion.
  `CREATE TABLE IF NOT EXISTS ardud_kanban_board_purges (
    board_id TEXT NOT NULL, thread_id TEXT NOT NULL, PRIMARY KEY (board_id, thread_id)
  )`,
  `CREATE TABLE IF NOT EXISTS ardud_kanban_evaluator_spawns (
    launch_key TEXT PRIMARY KEY, board_id TEXT NOT NULL, card_id TEXT, at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ardud_kanban_evaluator_spawns_window
    ON ardud_kanban_evaluator_spawns (board_id, at)`,
  `CREATE TABLE IF NOT EXISTS ardud_kanban_evaluator_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT, job_key TEXT NOT NULL UNIQUE,
    board_id TEXT NOT NULL, card_id TEXT, json TEXT NOT NULL,
    created_at TEXT NOT NULL, started_at TEXT, thread_id TEXT, done_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS ardud_kanban_evaluator_queue_started
    ON ardud_kanban_evaluator_queue (board_id, started_at)`,
  `CREATE INDEX IF NOT EXISTS ardud_kanban_evaluator_queue_pending
    ON ardud_kanban_evaluator_queue (board_id, id) WHERE done_at IS NULL`,

  `CREATE TABLE IF NOT EXISTS ardud_kanban_boards (
    id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ardud_kanban_instruction_applications (
    id TEXT PRIMARY KEY, board_id TEXT NOT NULL, card_id TEXT NOT NULL,
    field TEXT NOT NULL, ask_id TEXT NOT NULL, json TEXT NOT NULL, audit_event_id INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS ardud_kanban_instruction_applications_pending
    ON ardud_kanban_instruction_applications (card_id, board_id, field, ask_id)
    WHERE audit_event_id IS NULL`,
  `CREATE TABLE IF NOT EXISTS ardud_kanban_cards (
    id TEXT PRIMARY KEY, board_id TEXT NOT NULL, number INTEGER NOT NULL,
    stage TEXT NOT NULL, active_thread_id TEXT, json TEXT NOT NULL, UNIQUE (board_id, number)
  )`,
  `CREATE INDEX IF NOT EXISTS ardud_kanban_cards_board ON ardud_kanban_cards (board_id, stage)`,
  // Keep these literal predicates identical to the ask feed's indexed candidates.
  `CREATE INDEX IF NOT EXISTS ardud_kanban_cards_open_asks
    ON ardud_kanban_cards (board_id, number) WHERE instr(json, '"closedAt":null') > 0`,
  `CREATE INDEX IF NOT EXISTS ardud_kanban_cards_closed_asks
    ON ardud_kanban_cards (board_id, number) WHERE instr(json, '"closedAt":"') > 0`,
  `CREATE INDEX IF NOT EXISTS ardud_kanban_cards_open ON ardud_kanban_cards(board_id, number)
    WHERE json_extract(json, '$.settledAt') IS NULL`,
  `CREATE INDEX IF NOT EXISTS ardud_kanban_cards_dispatch ON ardud_kanban_cards(board_id, number)
    WHERE stage IN ('todo', 'working', 'needs_review', 'in_review')
      OR active_thread_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS ardud_kanban_cards_thread ON ardud_kanban_cards (active_thread_id)`,
  `CREATE TABLE IF NOT EXISTS ardud_kanban_card_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT NOT NULL, json TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ardud_kanban_card_events_card ON ardud_kanban_card_events (card_id, id)`,
  // Board activity reads a time window of events (board_get since, board_activity).
  `CREATE INDEX IF NOT EXISTS ardud_kanban_card_events_at
    ON ardud_kanban_card_events (json_extract(json, '$.at'))`,
  `CREATE TABLE IF NOT EXISTS ardud_kanban_goals (
    id TEXT PRIMARY KEY, board_id TEXT NOT NULL, json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ardud_kanban_pools (
    board_id TEXT NOT NULL, key TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (board_id, key)
  )`,
  `CREATE TABLE IF NOT EXISTS ardud_kanban_groups (board_id TEXT PRIMARY KEY, json TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ardud_kanban_discussions (
    id TEXT PRIMARY KEY, board_id TEXT NOT NULL, card_id TEXT, evaluator_thread_id TEXT, json TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ardud_kanban_discussions_board ON ardud_kanban_discussions (board_id)`,
  `CREATE INDEX IF NOT EXISTS ardud_kanban_discussions_open ON ardud_kanban_discussions (board_id)
    WHERE json_extract(json, '$.settledAt') IS NULL
      AND json_extract(json, '$.archivedAt') IS NULL`,
  `CREATE INDEX IF NOT EXISTS ardud_kanban_discussions_system_channel
    ON ardud_kanban_discussions (board_id, json_extract(json, '$.createdBy.component'))
    WHERE card_id IS NULL AND json_extract(json, '$.archivedAt') IS NULL
      AND json_extract(json, '$.createdBy._tag') = 'system'`,
  `CREATE TABLE IF NOT EXISTS ardud_kanban_messages (
    discussion_id TEXT NOT NULL, seq INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (discussion_id, seq)
  )`,
  `CREATE TABLE IF NOT EXISTS ardud_kanban_scripts (
    id TEXT PRIMARY KEY, board_id TEXT NOT NULL, json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ardud_kanban_script_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, script_id TEXT NOT NULL, json TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ardud_kanban_script_runs_script ON ardud_kanban_script_runs (script_id, id)`,
  `CREATE TABLE IF NOT EXISTS ardud_kanban_automations (
    id TEXT PRIMARY KEY, board_id TEXT NOT NULL, json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ardud_kanban_wiki (
    board_id TEXT NOT NULL, slug TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (board_id, slug)
  )`,
  `CREATE TABLE IF NOT EXISTS ardud_kanban_threads (
    thread_id TEXT PRIMARY KEY, board_id TEXT NOT NULL, card_id TEXT,
    ended INTEGER NOT NULL DEFAULT 0, json TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ardud_kanban_threads_card ON ardud_kanban_threads (card_id)`,
  `CREATE TABLE IF NOT EXISTS ardud_kanban_thread_cards (
    thread_id TEXT NOT NULL, card_id TEXT NOT NULL, joined_at TEXT NOT NULL, PRIMARY KEY (thread_id, card_id)
  )`,
  `CREATE INDEX IF NOT EXISTS ardud_kanban_thread_cards_card ON ardud_kanban_thread_cards (card_id)`,
  // Owner answers and posts commit with their routing obligation; delivery runs
  // after the reply and replays from here after a restart. `launched` lists
  // evaluator threads whose first message already carried the owner's text.
  `CREATE TABLE IF NOT EXISTS ardud_kanban_owner_routes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, route_key TEXT NOT NULL UNIQUE, board_id TEXT NOT NULL,
    discussion_id TEXT NOT NULL, json TEXT NOT NULL, created_at TEXT NOT NULL,
    launched TEXT NOT NULL DEFAULT '[]', noticed INTEGER NOT NULL DEFAULT 0, done_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS ardud_kanban_owner_routes_pending
    ON ardud_kanban_owner_routes (discussion_id, id) WHERE done_at IS NULL`,
];
