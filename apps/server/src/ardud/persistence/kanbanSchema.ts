export const kanbanDDL = [
  `CREATE TABLE IF NOT EXISTS ardud_kanban_boards (
    id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ardud_kanban_cards (
    id TEXT PRIMARY KEY, board_id TEXT NOT NULL, number INTEGER NOT NULL,
    stage TEXT NOT NULL, active_thread_id TEXT, json TEXT NOT NULL, UNIQUE (board_id, number)
  )`,
  `CREATE INDEX IF NOT EXISTS ardud_kanban_cards_board ON ardud_kanban_cards (board_id, stage)`,
  `CREATE INDEX IF NOT EXISTS ardud_kanban_cards_thread ON ardud_kanban_cards (active_thread_id)`,
  `CREATE TABLE IF NOT EXISTS ardud_kanban_card_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT NOT NULL, json TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ardud_kanban_card_events_card ON ardud_kanban_card_events (card_id, id)`,
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
];
