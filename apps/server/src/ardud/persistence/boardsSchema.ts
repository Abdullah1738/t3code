// These tables keep their legacy names so old builds can still read statev2.sqlite.
export const controlDDL = [
  `CREATE TABLE IF NOT EXISTS ardud_harness_selection_migration (
    id INTEGER PRIMARY KEY AUTOINCREMENT, version INTEGER NOT NULL, scope TEXT NOT NULL,
    ref TEXT NOT NULL, before_json TEXT NOT NULL, after_json TEXT NOT NULL,
    applied_at TEXT, rolled_back_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS ardud_harness_selection_migration_version
    ON ardud_harness_selection_migration (version, scope, ref)`,
  `CREATE TABLE IF NOT EXISTS ardud_mcp_credentials (
    token_hash TEXT PRIMARY KEY, environment_id TEXT NOT NULL, request_namespace TEXT NOT NULL,
    thread_id TEXT NOT NULL, provider_session_id TEXT NOT NULL, provider_instance_id TEXT NOT NULL,
    capabilities TEXT NOT NULL, issued_at INTEGER NOT NULL, last_alive_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ardud_mcp_credentials_thread
    ON ardud_mcp_credentials (environment_id, thread_id)`,
  `CREATE INDEX IF NOT EXISTS ardud_mcp_credentials_provider_session
    ON ardud_mcp_credentials (environment_id, provider_session_id)`,
  `CREATE TABLE IF NOT EXISTS ardud_mission_session_origins (
    session_id TEXT PRIMARY KEY, origin TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ardud_mission_owner_grants (
    credential_hash TEXT PRIMARY KEY, source TEXT NOT NULL, created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ardud_mission_owner_claim (
    id INTEGER PRIMARY KEY CHECK (id = 1), source TEXT NOT NULL, created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ardud_thread_origin (
    thread_id TEXT PRIMARY KEY, origin TEXT NOT NULL, created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ardud_opencode_import (
    native_session_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL UNIQUE, imported_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ardud_opencode_import_state (
    native_session_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL,
    session_updated_ms INTEGER, title TEXT, archived INTEGER, transcript_head TEXT, transcript_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS scheduled_tasks (
    task_id TEXT PRIMARY KEY, title TEXT NOT NULL, prompt TEXT NOT NULL, enabled INTEGER NOT NULL,
    schedule_json TEXT NOT NULL, project_id TEXT NOT NULL, thread_id TEXT,
    workspace_strategy_json TEXT NOT NULL, model_selection_json TEXT NOT NULL,
    runtime_mode TEXT NOT NULL, interaction_mode TEXT NOT NULL,
    created_by TEXT NOT NULL, creation_source TEXT NOT NULL, created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, next_run_at TEXT, last_run_at TEXT, last_run_status TEXT NOT NULL,
    last_run_error TEXT, run_count INTEGER NOT NULL, webhook_token TEXT, webhook_secret TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due ON scheduled_tasks(enabled, next_run_at)
    WHERE enabled = 1 AND next_run_at IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_project ON scheduled_tasks(project_id, updated_at)`,
  `CREATE TABLE IF NOT EXISTS scheduled_task_webhook_deliveries (
    delivery_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, received_at TEXT NOT NULL,
    method TEXT NOT NULL, query TEXT NOT NULL, headers_json TEXT NOT NULL, body TEXT NOT NULL,
    body_bytes INTEGER NOT NULL, body_truncated INTEGER NOT NULL, outcome TEXT NOT NULL,
    signature_verified INTEGER NOT NULL, missing_fields_json TEXT NOT NULL, rendered_prompt TEXT, error TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_scheduled_task_webhook_deliveries_task
    ON scheduled_task_webhook_deliveries(task_id, received_at)`,
  `CREATE TABLE IF NOT EXISTS scheduled_task_webhook_relay_deliveries (
    relay_delivery_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, seen_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_scheduled_task_webhook_relay_deliveries_seen
    ON scheduled_task_webhook_relay_deliveries(seen_at)`,
];

export const controlTables = [
  "ardud_harness_selection_migration",
  "ardud_mcp_credentials",
  "ardud_mission_session_origins",
  "ardud_mission_owner_grants",
  "ardud_mission_owner_claim",
  "ardud_thread_origin",
  "ardud_opencode_import",
  "ardud_opencode_import_state",
  "scheduled_tasks",
  "scheduled_task_webhook_deliveries",
  "scheduled_task_webhook_relay_deliveries",
  "ardud_scheduled_task_follows",
  "ardud_scheduled_task_block_retry",
];
