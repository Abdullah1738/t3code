import { toolError } from "./toollog.ts";
import type { ChatBackend } from "./openchamber.ts";
import type { Store } from "./store.ts";

const ID = /^[^\p{Cc}]{1,4096}$/u;
const ORIGIN_MARKED = "origin-marked:";

/**
 * Every OpenCode session this bridge owns: the current route, sessions the
 * route rotated away from (their continuity seed), and every session that sent
 * or was asked something over iMessage. Historical `notification` rows are left
 * out: they could name any session.
 */
export function ownedSessions(store: Store): Array<{ id: string; directory?: string }> {
  const sessions = new Map<string, string | undefined>();
  const add = (id: unknown, directory?: unknown) => {
    if (typeof id !== "string" || !ID.test(id)) return;
    const known = sessions.get(id);
    sessions.set(id, known ?? (typeof directory === "string" && directory.startsWith("/") ? directory : undefined));
  };
  const route = store.get<{ id?: unknown; directory?: unknown } | null>("route");
  add(route?.id, route?.directory);
  for (const row of store.db.query<{ key: string }, []>("SELECT key FROM kv WHERE key LIKE 'seed:%'").all()) {
    add(row.key.slice("seed:".length));
  }
  for (const row of store.db.query<{ sessionId: unknown }, []>(`SELECT DISTINCT json_extract(payload, '$.sessionId') AS sessionId
    FROM outbox WHERE json_extract(payload, '$.kind') IN ('conversation', 'control')`).all()) {
    add(row.sessionId);
  }
  return [...sessions].map(([id, directory]) => (directory ? { id, directory } : { id }));
}

/** Sessions one pass looks at; the rest wait for the next pass. */
export const BACKFILL_BATCH = 10;

/**
 * Marks owned sessions that are not yet known to carry the iMessage origin, at
 * most `limit` per pass. Idempotent: a session is recorded once a read showed
 * the marker (or OpenCode reported it not found) and is never asked again. A
 * session written in this pass is read back by the next one before it counts
 * as done. A failed session is left for the next pass; a backend that is down
 * (no response or a server error) ends this pass early. `pending` counts every
 * session still waiting, including those beyond this pass's limit.
 */
export async function backfillOrigins(
  store: Store,
  backend: Pick<ChatBackend, "markImessageOrigin">,
  limit = BACKFILL_BATCH,
  prefix = ORIGIN_MARKED,
): Promise<{ marked: number; already: number; missing: number; pending: number }> {
  const result = { marked: 0, already: 0, missing: 0, pending: 0 };
  const doneKey = (id: string) => `${prefix}${id}`;
  const waiting = ownedSessions(store).filter(session => store.get<boolean>(doneKey(session.id)) !== true);
  const todo = waiting.slice(0, limit);
  result.pending = waiting.length - todo.length;
  for (const [index, session] of todo.entries()) {
    try {
      const outcome = await backend.markImessageOrigin(session.id, session.directory);
      result[outcome]++;
      if (outcome !== "marked") store.set(doneKey(session.id), true);
    } catch (error) { toolError("origin-backfill", "origin-backfill.catch1");
      const status = (error as { status?: unknown }).status;
      if (typeof status !== "number" || status === 0 || status >= 500) {
        result.pending += todo.length - index;
        break;
      }
      result.pending++;
    }
  }
  return result;
}

type BackfillResult = Awaited<ReturnType<typeof backfillOrigins>>;

/**
 * Runs the backfill beside the router, never inside its tick: `kick()` starts
 * at most one pass when one is due and returns at once. A pass that marked
 * something or left sessions waiting schedules the next soon (a fresh write
 * is read back before it counts as done); a failed one backs off, doubling up
 * to 30 minutes. Once every owned session is confirmed it stops. Failures are
 * only logged.
 */
export class OriginBackfill {
  private running?: Promise<void>;
  private dueAt = 0;
  private backoff: number;

  constructor(
    private readonly run: () => Promise<BackfillResult>,
    private readonly log: (event: string, code?: string) => void,
    private readonly options: { now?: () => number; nextPassMs?: number; initialBackoffMs?: number; maxBackoffMs?: number } = {},
  ) {
    this.backoff = options.initialBackoffMs ?? 30_000;
  }

  get done(): boolean { return this.dueAt === Infinity; }

  kick(): Promise<void> | undefined {
    const now = this.options.now ?? Date.now;
    if (this.running || now() < this.dueAt) return this.running;
    this.running = this.run().then(result => {
      if (result.marked) this.log("origin-backfill-marked", String(result.marked));
      if (result.pending && result.marked + result.already + result.missing === 0) throw new Error("no progress");
      this.backoff = this.options.initialBackoffMs ?? 30_000;
      this.dueAt = result.marked || result.pending ? now() + (this.options.nextPassMs ?? 60_000) : Infinity;
    }).catch(() => { toolError("origin-backfill", "origin-backfill.catch2");
      this.log("origin-backfill-failed");
      this.dueAt = now() + this.backoff;
      this.backoff = Math.min(this.options.maxBackoffMs ?? 30 * 60_000, this.backoff * 2);
    }).finally(() => { this.running = undefined; });
    return this.running;
  }
}
