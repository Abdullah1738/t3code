import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const DEFAULT_DB = join(homedir(), '.local/share/coord/data/coord.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS actors (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, thread_id TEXT, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY, purpose TEXT, owner TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER, archived_at INTEGER, archive_note TEXT);
CREATE TABLE IF NOT EXISTS members (
  channel_id TEXT, actor_id TEXT, wake INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (channel_id, actor_id));
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT NOT NULL UNIQUE, body_hash TEXT NOT NULL,
  channel_id TEXT NOT NULL, kind TEXT NOT NULL, sender TEXT NOT NULL, work_id TEXT, environment TEXT,
  expected_revision TEXT, authority_ref TEXT, summary TEXT NOT NULL, body_json TEXT, reply_to INTEGER,
  created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS deliveries (
  event_seq INTEGER, recipient TEXT, status TEXT NOT NULL, client_request_id TEXT NOT NULL,
  thread_id TEXT, message_id TEXT, run_id TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER,
  last_error TEXT, sent_at INTEGER, acked_at INTEGER, reminded INTEGER NOT NULL DEFAULT 0,
  gen INTEGER NOT NULL DEFAULT 0,             -- bumped by every reservation and retarget; result writes must match it
  PRIMARY KEY (event_seq, recipient));
CREATE INDEX IF NOT EXISTS deliveries_status ON deliveries (status, next_attempt_at);
-- Doorbell: the last wake or reminder rung per Robob thread (one outstanding ring per thread).
CREATE TABLE IF NOT EXISTS wakes (
  thread_id TEXT PRIMARY KEY, kind TEXT, client_request_id TEXT, covered TEXT, message_id TEXT, run_id TEXT,
  delivery TEXT, rung_at INTEGER, lease_until INTEGER,
  inflight TEXT);                              -- JSON {id, rows} of a ring not yet settled; replayed on retry
CREATE TABLE IF NOT EXISTS fences (resource TEXT PRIMARY KEY, fence INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS claims (
  resource TEXT PRIMARY KEY, owner TEXT NOT NULL, fence INTEGER NOT NULL, state TEXT NOT NULL,
  env TEXT,                                    -- environment a mutation claim acts on (NULL for non-mutation claims)
  lease_until INTEGER NOT NULL, purpose TEXT, op_ref TEXT, claimed_at INTEGER, renewed_at INTEGER,
  released_at INTEGER, note TEXT, reconcile_by TEXT, reconcile_outcome TEXT, reconcile_evidence TEXT);
-- Ended claims (released or reconciled) kept when the resource is claimed again.
CREATE TABLE IF NOT EXISTS claim_history (
  resource TEXT NOT NULL, fence INTEGER NOT NULL, owner TEXT NOT NULL, state TEXT NOT NULL, op_ref TEXT,
  reconcile_by TEXT, reconcile_outcome TEXT, reconcile_evidence TEXT, ended_at INTEGER, PRIMARY KEY (resource, fence));
CREATE TABLE IF NOT EXISTS deps (
  id INTEGER PRIMARY KEY, work_id TEXT NOT NULL, need TEXT NOT NULL, ref TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'waiting', why TEXT, evidence TEXT, checked_at INTEGER,
  version INTEGER NOT NULL DEFAULT 0, UNIQUE (work_id, need, ref));
CREATE TABLE IF NOT EXISTS releases (
  id INTEGER PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, requester TEXT NOT NULL, kind TEXT NOT NULL,
  environment TEXT NOT NULL, repo TEXT, binary TEXT, git_sha TEXT, runtime_sha TEXT, content_prs TEXT,
  tag TEXT, image_digest TEXT, plan_id TEXT, footprint TEXT NOT NULL, risk TEXT NOT NULL DEFAULT 'ordinary',
  batch_id TEXT, state TEXT NOT NULL, admitted_by TEXT, admitted_at INTEGER, fence INTEGER,
  claim_fences TEXT,                                 -- JSON {resource: {owner, fence}} of claims relied on at admission
  release_run TEXT, deploy_run TEXT, tf_run TEXT, readback TEXT, outcome TEXT, failure TEXT,
  gate_evidence TEXT, redispatch_of INTEGER,
  env_exclusive INTEGER NOT NULL DEFAULT 0,          -- 1: conflicts with every other mutation in its environment
  tf_root TEXT, planned_at INTEGER,                  -- tf_apply: root, start time of the saved plan's run attempt
  version INTEGER NOT NULL DEFAULT 0,                -- bumped on every write; async checks compare-and-set against it
  observed_at INTEGER, observe_note TEXT,
  release_attempt INTEGER, deploy_attempt INTEGER,  -- run attempts bound at first observation; any change is unknown
  created_at INTEGER, updated_at INTEGER);
CREATE INDEX IF NOT EXISTS releases_state ON releases (state, environment);
CREATE TABLE IF NOT EXISTS arch_requests (
  id INTEGER PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, requester TEXT NOT NULL, kind TEXT NOT NULL,
  repos TEXT, pins TEXT, packet_path TEXT, summary TEXT, state TEXT NOT NULL, taken_by TEXT, fence INTEGER,
  result_commits TEXT, result_note TEXT, created_at INTEGER, updated_at INTEGER);
-- Per Terraform root: count and time of the last mutation start or end; older saved plans are stale.
CREATE TABLE IF NOT EXISTS tf_roots (root TEXT PRIMARY KEY, gen INTEGER NOT NULL, bumped_at INTEGER);
CREATE TABLE IF NOT EXISTS control (k TEXT PRIMARY KEY, v TEXT, set_by TEXT, set_at INTEGER, reason TEXT);
CREATE TABLE IF NOT EXISTS run_inputs (run_id TEXT PRIMARY KEY, inputs TEXT, at INTEGER);
`;

// Columns added after the first release go here as [table, column, type].
const ADDED = [];

export class CoordError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

let cur = null;
let depth = 0;
let onOpen = null;
// Runs once per opened database, after the schema exists (coord.mjs registers its read-only state check).
export const setOnOpen = fn => { onOpen = fn; };

export function open(path = process.env.COORD_DB || DEFAULT_DB) {
  if (cur?.path === path) return cur.db;
  close();
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000;');
  db.exec(SCHEMA);
  for (const [t, c, type] of ADDED)
    if (!db.prepare(`PRAGMA table_info(${t})`).all().some(x => x.name === c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${type}`);
  cur = { path, db };
  if (onOpen) {
    try { onOpen(); } catch (e) { close(); throw e; }
  }
  return db;
}

export function close() {
  cur?.db.close();
  cur = null;
  depth = 0;
}

export const db = () => cur?.db ?? open();
export const get = (sql, ...a) => db().prepare(sql).get(...a);
export const all = (sql, ...a) => db().prepare(sql).all(...a);
export const run = (sql, ...a) => db().prepare(sql).run(...a);

// BEGIN IMMEDIATE around fn. Returning an Error commits the work done so far and then throws it,
// so a refusal can still record a state change (lease expiry -> reconcile_required). Throwing rolls back.
export function tx(fn) {
  if (depth) return fn(); // nested: the outer tx commits, and throws a returned Error
  const d = db();
  d.exec('BEGIN IMMEDIATE');
  depth++;
  let r;
  try { r = fn(); d.exec('COMMIT'); } catch (e) { d.exec('ROLLBACK'); throw e; } finally { depth--; }
  if (r instanceof Error) throw r;
  return r;
}
