import type { AnalyticsEvent } from "@t3tools/contracts";

// Keep noisy producers bounded without starving a rare kind out of the default read.
export function sampleMix(limit: number, kind?: string, admittedKinds: readonly string[] = []) {
  type Sample = { event: AnalyticsEvent; order: number };
  const groups = new Map<string, Sample[]>();
  for (const admitted of admittedKinds.slice(0, 128)) groups.set(admitted, []);
  const cap = kind === undefined ? Math.min(50, limit) : limit;
  let order = 0;
  // AnalyticsEvent validates fixed-width UTC timestamps, so lexical order is chronological.
  const newest = (a: Sample, b: Sample) =>
    a.event.ts > b.event.ts ? -1 : a.event.ts < b.event.ts ? 1 : b.order - a.order;
  const priority = (kind: string) =>
    kind.startsWith("kanban.") || kind.startsWith("ask.")
      ? 0
      : kind === "performance.long-task"
        ? 2
        : 1;
  const entries = () => {
    const result: Sample[] = [];
    for (const rank of [0, 1, 2]) {
      for (let index = 0; index < cap && result.length < limit; index++) {
        const round = [...groups].flatMap(([kind, rows]) =>
          priority(kind) === rank && rows[index] ? [rows[index]!] : [],
        );
        round.sort(newest);
        for (const row of round) if (result.length < limit) result.push(row);
      }
    }
    return result;
  };
  return {
    add(event: AnalyticsEvent, sequence = order) {
      if (!groups.has(event.kind) && groups.size >= 128) return;
      order = Math.max(order, sequence + 1);
      const rows = groups.get(event.kind) ?? [];
      const row = { event, order: sequence };
      let low = 0;
      let high = rows.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (newest(row, rows[middle]!) < 0) high = middle;
        else low = middle + 1;
      }
      if (low < cap) {
        rows.splice(low, 0, row);
        if (rows.length > cap) rows.pop();
      }
      groups.set(event.kind, rows);
    },
    entries,
    kinds: () => [...groups.keys()],
    finish: () => entries().map((row) => row.event),
  };
}
