import type { Database } from "bun:sqlite";

export const INTERRUPTION_REASONS = ["authority-expired", "disabled", "harness-exit"] as const;
type Reason = typeof INTERRUPTION_REASONS[number];
const counts = () => ({ "authority-expired": 0, disabled: 0, "harness-exit": 0 });
export const RECENT_INTERRUPTION_COUNTS = `SELECT reason,count(*) n FROM interruption_stats
  WHERE at>=? AND at<=? GROUP BY reason`;

export function initStats(db: Database, now: number) {
  db.exec(`CREATE TABLE IF NOT EXISTS interruption_stats(seq INTEGER PRIMARY KEY,
      reason TEXT NOT NULL CHECK(reason IN ('authority-expired','disabled','harness-exit')),
      at INTEGER NOT NULL CHECK(typeof(at)='integer' AND at BETWEEN 0 AND 9007199254740991));
    CREATE TABLE IF NOT EXISTS interruption_totals(reason TEXT PRIMARY KEY,n INTEGER NOT NULL);
    CREATE TRIGGER IF NOT EXISTS interruption_stats_insert AFTER INSERT ON interruption_stats BEGIN
      INSERT INTO interruption_totals(reason,n) VALUES (NEW.reason,1) ON CONFLICT(reason) DO UPDATE SET n=n+1;
    END;
    CREATE INDEX IF NOT EXISTS interruption_stats_at ON interruption_stats(at);
    CREATE INDEX IF NOT EXISTS interruption_stats_at_reason ON interruption_stats(at,reason);
    CREATE INDEX IF NOT EXISTS inbox_state ON inbox(state);`);
  db.transaction(() => {
    if (db.query("SELECT 1 FROM settings WHERE key='stats-history-since'").get()) return;
    // The old table kept only the latest interruption per inbox row; earlier overwritten events are unknown.
    const legacy = db.query(`INSERT INTO interruption_stats(reason,at) SELECT reason,at FROM interruptions
      WHERE reason IN ('authority-expired','disabled','harness-exit') AND typeof(at)='integer'
      AND at BETWEEN 0 AND 9007199254740991 RETURNING reason`).all().length;
    db.exec(`INSERT INTO settings SELECT 'stats-retried',count(*) FROM settings WHERE key GLOB 'authority-retry:*'`);
    db.query("INSERT INTO settings VALUES ('stats-history-since',?)").run(String(now));
    db.query("INSERT INTO settings VALUES ('stats-legacy-retained',?)").run(String(legacy));
  }).immediate();
}

export function recordInterruption(db: Database, reason: Reason, at: number, retried: boolean) {
  db.query("INSERT INTO interruption_stats(reason,at) VALUES (?,?)").run(reason, at);
  if (retried) db.query("UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE key='stats-retried'").run();
}

export function runnerStats(db: Database, now: number) {
  const total = counts(), last24h = counts();
  for (const row of db.query<{ reason: Reason; n: number }, []>("SELECT reason,n FROM interruption_totals").all()) {
    total[row.reason] = row.n;
  }
  for (const row of db.query<{ reason: Reason; n: number }, [number, number]>(RECENT_INTERRUPTION_COUNTS).all(now - 86_400_000, now)) {
    last24h[row.reason] = row.n;
  }
  const last = db.query<{ reason: Reason; at: number }, []>(`SELECT reason,at FROM interruption_stats
    ORDER BY at DESC,seq DESC LIMIT 1`).get();
  const setting = (key: string) => Number(db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key=?").get(key)?.value ?? 0);
  return {
    interruptions: { total, last24h },
    // A retry marker survives later interruptions. Inbox 'done' also covers manual resolution and expiry.
    autoRetry: { retried: setting("stats-retried") },
    lastInterruptionAt: last?.at ?? null, lastInterruptionReason: last?.reason ?? null,
    stuck: db.query<{ n: number }, []>("SELECT count(*) n FROM inbox WHERE state='interrupted'").get()!.n,
    historySince: setting("stats-history-since"), legacyRetained: setting("stats-legacy-retained"),
  };
}
