// Read-only access to lane transcripts in Robob's state DB.
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { toEvent } from './transcript.mjs';

const HOME = process.env.HOME || homedir();
export const DB_PATH = process.env.SCRIBE_DB || join(HOME, '.robob/userdata/statev2.sqlite');

export const openDb = (path = DB_PATH) => new DatabaseSync(path, { readOnly: true });

const SETTLED_ITEMS = new Set(['completed', 'failed', 'interrupted', 'cancelled']);
const LIVE_RUNS = new Set(['running', 'queued']);

/**
 * Settled events after `afterEvent`, in order, up to `limit`. Reading stops at
 * the first item that is still running or belongs to a running run, so the
 * cursor never moves past something that can still change. Reasoning items are
 * skipped (the server's quotable text has no reasoning either).
 */
export function eventsAfter(db, threadId, afterEvent, limit = 400) {
  const rows = db
    .prepare(
      `select i.ordinal, i.type, i.status, i.payload_json, r.status as run_status
         from orchestration_v2_projection_turn_items i
         left join orchestration_v2_projection_runs r on r.run_id = i.run_id
        where i.thread_id = ? and i.ordinal > ?
        order by i.ordinal
        limit ?`,
    )
    .all(threadId, afterEvent, limit);
  const events = [];
  let complete = rows.length < limit;
  // Last ordinal that is settled, reasoning included, so a cursor can skip it.
  let lastSeen = afterEvent;
  for (const row of rows) {
    if (!SETTLED_ITEMS.has(row.status) || LIVE_RUNS.has(row.run_status)) {
      complete = false;
      break;
    }
    lastSeen = Number(row.ordinal);
    if (row.type === 'reasoning') continue;
    events.push(toEvent(row));
  }
  return { events, complete, lastSeen };
}

/** First event at or after an ISO time; used to start a lane that has no cursor. */
export function firstEventSince(db, threadId, sinceIso) {
  const row = db
    .prepare(
      `select min(i.ordinal) as ordinal
         from orchestration_v2_projection_turn_items i
         join orchestration_v2_projection_runs r on r.run_id = i.run_id
        where i.thread_id = ? and r.requested_at >= ?`,
    )
    .get(threadId, sinceIso);
  return row?.ordinal == null ? null : Number(row.ordinal);
}

/** Thread title and linked pull requests (with snapshots), from the projection. */
export function threadInfo(db, threadId) {
  const row = db
    .prepare(`select title, payload_json from orchestration_v2_projection_threads where thread_id = ?`)
    .get(threadId);
  if (!row) return null;
  let payload = {};
  try {
    payload = JSON.parse(row.payload_json ?? '{}');
  } catch {}
  return { threadId, title: row.title ?? payload.title ?? threadId, pullRequests: payload.pullRequests ?? [] };
}
