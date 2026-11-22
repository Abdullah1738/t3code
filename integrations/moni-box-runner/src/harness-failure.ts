import { Database } from "bun:sqlite";
import { join } from "node:path";
import { validId } from "../../spectrum-bridge/src/remote-protocol.ts";

export type HarnessExit = { exitCode: number | null; signal: string | null; stderrBytes: number };
export class HarnessFailure extends Error {
  constructor(readonly detail: HarnessExit) { super("Harness failed"); }
}

export async function stderrTail(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  let tail = new Uint8Array();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return tail;
      const kept = value.subarray(Math.max(0, value.length - 2048));
      const next = new Uint8Array(Math.min(2048, tail.length + kept.length));
      const old = Math.max(0, next.length - kept.length);
      next.set(tail.subarray(tail.length - old)); next.set(kept, old); tail = next;
    }
  } finally { reader.releaseLock(); }
}
/** Counts a possible side effect for a running inbox row before a tool may run; false refuses the tool. */
export function markSideEffect(root: string, id: string): boolean {
  let db: Database | undefined;
  try {
    if (!root?.startsWith("/") || !validId(id)) return false;
    db = new Database(join(root, "agent.sqlite"), { create: false, readwrite: true });
    db.exec("PRAGMA busy_timeout=5000");
    const marked = db.query(`INSERT INTO settings(key,value) SELECT 'side-effects:' || id,'1' FROM inbox WHERE id=? AND state='running'
      ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1`).run(id);
    return marked.changes === 1;
  } catch { return false; }
  finally { db?.close(); }
}
if (import.meta.main) {
  // PreToolUse persists only an attempt count, before any built-in tool can create a side effect.
  // Hook input can include private content; it is deliberately never decoded or retained.
  process.stdin.resume();
  const [mode, root, id] = process.argv.slice(2);
  if (mode !== "--tool" || !markSideEffect(root!, id!)) process.exitCode = 2;
}
