import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Robob's control API gives the bridge an assistant message's text, not how
 * the model's step ended. OpenCode keeps that as the message's `finish`:
 * "tool-calls" when the model went on to call tools (narration between steps),
 * "stop" when it said something and stopped. A "stop" message that isn't the
 * run's last is an answer it gave before a steered text arrived, so the router
 * has to send it too.
 */
const NATIVE = /^message:provider:opencode:native-item:(.+)$/;

/** OpenCode's message id inside a Robob control message id, e.g. `msg_X` from `...native-item:msg_X%3Atext%3A0`. */
export function nativeMessageId(id: string): string | undefined {
  const match = NATIVE.exec(id);
  if (!match) return undefined;
  try {
    return /^msg_[A-Za-z0-9]+$/.exec(decodeURIComponent(match[1]!).split(":")[0]!)?.[0];
  } catch {
    return undefined;
  }
}

/** Native `finish` per control message id; ids it can't resolve are simply absent. */
export type StepFinishes = (ids: readonly string[]) => Map<string, string>;

export const OPENCODE_DB = join(homedir(), ".local/share/opencode/opencode.db");

/**
 * Reads finishes from OpenCode's database, read-only. Any failure (no file,
 * locked, schema change) leaves every id unknown, which keeps the router's
 * old rule: only a run's last word goes out.
 */
/**
 * Whether a native OpenCode run called any tool, read from its session's step rows. A run is
 * `ran` when any step finished `tool-calls`, `none` only when every step finished `stop` (and
 * there was at least one step), and `unknown` for anything else, including a read failure.
 * Only bounded reads: one session, rows from `sinceMs` on, at most `limit` rows.
 */
export type RunToolEvidence = "ran" | "none" | "unknown";
export type RunEvidence = (sessionId: string, sinceMs: number) => RunToolEvidence;

export function opencodeRunEvidence(path = OPENCODE_DB, limit = 200): RunEvidence {
  let db: Database | undefined;
  let inode: number | undefined;
  const close = () => {
    try { db?.close(); } catch { /* already gone */ }
    db = undefined;
  };
  return (sessionId, sinceMs) => {
    if (!/^ses_[A-Za-z0-9]+$/.test(sessionId) || !Number.isFinite(sinceMs)) return "unknown";
    try {
      const current = statSync(path).ino;
      if (db && current !== inode) close();
      if (!db) {
        db = new Database(path, { readonly: true });
        inode = current;
      }
      const rows = db.query<{ finish: unknown }, [string, number, number]>(
        "SELECT json_extract(data, '$.finish') AS finish FROM session_message WHERE session_id = ? AND type = 'assistant' AND time_created >= ? ORDER BY seq LIMIT ?",
      ).all(sessionId, sinceMs, limit);
      if (rows.length === 0) return "unknown";
      if (rows.some(row => row.finish === "tool-calls")) return "ran";
      if (rows.every(row => row.finish === "stop")) return "none";
      return "unknown";
    } catch {
      close();
      return "unknown";
    }
  };
}

export function opencodeFinishes(path = OPENCODE_DB): StepFinishes {
  let db: Database | undefined;
  let inode: number | undefined;
  const close = () => {
    try { db?.close(); } catch { /* already gone */ }
    db = undefined;
  };
  return ids => {
    const found = new Map<string, string>();
    // One OpenCode message can show up as several control records (`msg_X:text:0`, `msg_X:text:1`).
    const wanted = new Map<string, string[]>();
    for (const id of ids) {
      const native = nativeMessageId(id);
      if (native) wanted.set(native, [...wanted.get(native) ?? [], id]);
    }
    if (!wanted.size) return found;
    try {
      // A compaction swaps the file underneath; an open handle would keep reading the old one.
      const current = statSync(path).ino;
      if (db && current !== inode) close();
      if (!db) {
        db = new Database(path, { readonly: true });
        inode = current;
      }
      const rows = db.query<{ id: string; finish: unknown }, [string]>(
        "SELECT id, json_extract(data, '$.finish') AS finish FROM session_message WHERE id IN (SELECT value FROM json_each(?))",
      ).all(JSON.stringify([...wanted.keys()]));
      for (const row of rows) {
        if (typeof row.finish !== "string") continue;
        for (const id of wanted.get(row.id) ?? []) found.set(id, row.finish);
      }
    } catch {
      close();
      found.clear();
    }
    return found;
  };
}
