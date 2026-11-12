// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off globalDate:off globalConsole:off preferSchemaOverJson:off - Harness process boundaries intentionally measure native I/O and wall time outside the application runtime.
export interface PlanRow {
  detail: string;
}
export interface Query {
  route: string;
  sql: string;
  queryHash?: string;
}
export interface Exception {
  route: string;
  pattern: string;
  reason: string;
  queryHash?: string;
}
export const largeTables =
  /orchestration_v2_(?:projection_(?:threads|runs|nodes|turn_items|provider_threads|provider_sessions)|events)|orchestration_events|ardud_kanban_(?:cards|messages|discussions|threads)/i;
export function violations(query: Query, rows: readonly PlanRow[]) {
  const findings: string[] = [];
  const aliases = new Set<string>();
  for (const match of query.sql.matchAll(
    /\b(?:FROM|JOIN)\s+(?:main\.)?([a-zA-Z_][\w]*)\s+(?:AS\s+)?([a-zA-Z_][\w]*)/gi,
  )) {
    if (
      largeTables.test(match[1]!) &&
      !/^(?:WHERE|ON|USING|ORDER|GROUP|LIMIT|JOIN|CROSS|LEFT|INNER|INDEXED)$/i.test(match[2]!)
    )
      aliases.add(match[2]!);
  }
  for (const { detail } of rows) {
    if (
      /\bSCAN\b/i.test(detail) &&
      (largeTables.test(detail) ||
        [...aliases].some((alias) => new RegExp(`\\bSCAN ${alias}\\b`, "i").test(detail)) ||
        /\b(?:t|r|n|cold|base|shell_runs|shell_threads)\b/.test(detail))
    )
      findings.push(detail);
    if (
      /CO-ROUTINE.*(?:history|archive)|(?:SCAN|SEARCH).*\b(?:cold|base|ardud_archive|ardud_base)\b/i.test(
        detail,
      )
    )
      findings.push(detail);
    if (/USE TEMP B-TREE FOR (?:ORDER BY|GROUP BY|DISTINCT)/.test(detail)) findings.push(detail);
  }
  if (/\bardud_history_|\bardud_archive\.|\bardud_base\./i.test(query.sql))
    findings.push("Interactive query references history/archive");
  return [...new Set(findings)];
}
export function unreviewed(query: Query, findings: string[], exceptions: readonly Exception[]) {
  return findings.filter(
    (f) =>
      !exceptions.some(
        (e) =>
          e.route === query.route &&
          (e.queryHash === undefined || e.queryHash === query.queryHash) &&
          new RegExp(e.pattern).test(f),
      ),
  );
}
