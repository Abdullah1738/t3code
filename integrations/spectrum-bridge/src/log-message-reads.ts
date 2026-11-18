import type { LogLine } from "./toollog.ts";

export function createMessageReadAggregation() {
  const groups = new Map<string, LogLine>();
  function flush(before = Infinity): LogLine[] {
    const output: LogLine[] = [];
    for (const [key, line] of groups) if (Date.parse(line.ts) < before) {
      output.push(line);
      groups.delete(key);
    }
    return output;
  }
  function accept(line: LogLine): LogLine[] {
    const minute = Math.floor(Date.parse(line.ts) / 60_000) * 60_000;
    const output = flush(minute);
    if (line.component !== "robob" || line.name !== "robob.messages_read" || !line.ids?.threadId) return [...output, line];
    const key = `${minute}\0${line.ids.threadId}`;
    let group = groups.get(key);
    if (!group) {
      group = { ts: new Date(minute).toISOString(), tool: "imessage", component: "robob", kind: "perf", name: "robob.message_reads",
        ids: { threadId: line.ids.threadId }, props: { fullReads: 0, incrementalReads: 0, cachedSkipReads: 0, sharedReads: 0, rowsReturned: 0, bytesReturned: 0 } };
      groups.set(key, group);
    }
    const props = group.props!;
    const mode = { full: "fullReads", incremental: "incrementalReads", "cached-skip": "cachedSkipReads", shared: "sharedReads" }[String(line.props?.readMode)];
    if (mode) props[mode] = Number(props[mode] ?? 0) + 1;
    for (const field of ["rowsReturned", "bytesReturned"]) props[field] = Number(props[field] ?? 0) + Number(line.props?.[field] ?? 0);
    for (const field of ["markerPolls", "crossThreadReads", "crossThreadPages", "markerSkips", "fallbacks", "detailReads", "evidenceReads", "discoveryReads", "markerChecks", "crossThreadChecks"]) {
      if (line.props?.[field] !== undefined) props[field] = Number(props[field] ?? 0) + Number(line.props[field]);
    }
    const reason = { "first-read": "firstReads", "route-change": "routeChanges", "missing-until": "missingUntils", resync: "resyncs", "merge-conflict": "mergeConflicts", "clock-skew": "clockSkews" }[String(line.props?.fullReason)];
    if (reason) props[reason] = Number(props[reason] ?? 0) + 1;
    if (line.ids.tickId) output.push(line); // Preserve per-tick attribution as well as minute totals.
    return output;
  }
  return { accept, flush };
}
