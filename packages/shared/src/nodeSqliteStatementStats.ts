import * as Context from "effect/Context";
import { normalizeSql, sqlFingerprint } from "./sqlDiagnostics.ts";

export interface StatementCompletion {
  readonly database: string;
  readonly connection: "writer" | "reader" | "reserved" | "export";
  readonly lane: string;
  readonly sql: string;
  readonly executionMs: number;
  readonly rows: number;
  readonly failed: boolean;
  readonly calls?: number;
  readonly failures?: number;
  readonly maxMs?: number;
  /** Approximate decoded bytes, measured in the worker before cloning. */
  readonly resultBytes?: number;
}

/** Synchronous, in-memory observation, including statements with tracing disabled. */
export const StatementStats = Context.Reference<
  ((completion: StatementCompletion) => void) | undefined
>("@t3tools/shared/nodeSqliteClient/StatementStats", { defaultValue: () => undefined });

export const recordStatementCompletion = (
  observer: ((completion: StatementCompletion) => void) | undefined,
  completion: StatementCompletion,
) => {
  try {
    observer?.(completion);
  } catch {
    // An observer cannot alter a completed read or commit.
  }
};

export function makeStatementStats(diagnostic = false, capacity = 512) {
  const identities = new Map<string, { fingerprint: string; family: string; sql?: string }>();
  const summaries = new Map<
    string,
    {
      database: string;
      connection: string;
      lane: string;
      fingerprint: string;
      family: string;
      calls: number;
      executionMs: number;
      maxMs: number;
      rows: number;
      failures: number;
      maxResultBytes: number;
      maxResultRows: number;
      sql?: string;
    }
  >();
  const record = (completion: StatementCompletion) => {
    const text = completion.sql;
    let identity = identities.get(text);
    if (identity === undefined) {
      if (text.length > 32768) identity = { fingerprint: "oversized", family: "oversized" };
      else {
        const normalized = normalizeSql(text);
        const fingerprint = sqlFingerprint(normalized);
        const table = /\b(?:FROM|INTO|UPDATE)\s+([\w.]+)/i.exec(normalized)?.[1] ?? "control";
        identity = {
          fingerprint,
          family: `${normalized.split(" ", 1)[0] ?? "SQL"}:${table}`.slice(0, 100),
          ...(diagnostic ? { sql: normalized.slice(0, 16000) } : {}),
        };
      }
      if (identities.size >= capacity) identities.delete(identities.keys().next().value!);
      identities.set(text.length > 32768 ? "oversized" : text, identity);
    }
    // File names and values never leave this collector through analytics.
    const database = completion.database.split(/[\\/]/).at(-1) ?? "sqlite";
    const key = `${database}/${completion.connection}/${completion.lane}/${identity.fingerprint}`;
    const bucket = summaries.has(key) || summaries.size < capacity ? key : "overflow";
    let summary = summaries.get(bucket);
    if (summary === undefined) {
      summary =
        bucket === "overflow"
          ? {
              database: "all",
              connection: "all",
              lane: "all",
              fingerprint: "overflow",
              family: "overflow",
              calls: 0,
              executionMs: 0,
              maxMs: 0,
              rows: 0,
              failures: 0,
              maxResultBytes: 0,
              maxResultRows: 0,
            }
          : {
              database,
              connection: completion.connection,
              lane: completion.lane,
              ...identity,
              calls: 0,
              executionMs: 0,
              maxMs: 0,
              rows: 0,
              failures: 0,
              maxResultBytes: 0,
              maxResultRows: 0,
            };
      summaries.set(bucket, summary);
    }
    const elapsed = Number.isFinite(completion.executionMs)
      ? Math.max(0, completion.executionMs)
      : 0;
    summary.calls += completion.calls ?? 1;
    summary.executionMs += elapsed;
    summary.maxMs = Math.max(summary.maxMs, completion.maxMs ?? elapsed);
    summary.rows += completion.rows;
    summary.failures += completion.failures ?? Number(completion.failed);
    if (completion.resultBytes !== undefined && completion.resultBytes > summary.maxResultBytes) {
      summary.maxResultBytes = completion.resultBytes;
      summary.maxResultRows = completion.rows;
    }
  };
  return {
    record,
    drain() {
      const result = Array.from(summaries.values());
      summaries.clear();
      const largest = result.reduce<(typeof result)[number] | undefined>(
        (largest, entry) =>
          entry.maxResultBytes > (largest?.maxResultBytes ?? 0) ? entry : largest,
        undefined,
      );
      if (largest !== undefined) {
        try {
          // @effect-diagnostics-next-line globalConsole:off -- One local log per existing minute drain; no result payload is traversed.
          console.info("sqlite.worker-result", {
            database: largest.database,
            lane: largest.lane,
            fingerprint: largest.fingerprint,
            family: largest.family,
            maxResultBytes: largest.maxResultBytes,
            rows: largest.maxResultRows,
          });
        } catch {
          /* Logging cannot discard the interval's counters. */
        }
      }
      return result;
    },
  };
}
