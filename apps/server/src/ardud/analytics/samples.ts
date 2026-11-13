import type { AnalyticsEvent } from "@t3tools/contracts";

// Keep noisy producers bounded without starving a rare kind out of the default read.
export function sampleMix(limit: number, kind?: string) {
  type Sample = { event: AnalyticsEvent; order: number };
  const groups = new Map<string, Sample[]>();
  const cap = kind === undefined ? Math.min(50, limit) : limit;
  let order = 0;
  const newest = (a: Sample, b: Sample) =>
    b.event.ts.localeCompare(a.event.ts) || b.order - a.order;
  const priority = (kind: string) =>
    kind.startsWith("kanban.") || kind.startsWith("ask.")
      ? 0
      : kind === "performance.long-task"
        ? 2
        : 1;
  return {
    add(event: AnalyticsEvent) {
      if (!groups.has(event.kind) && groups.size >= 128) return;
      const rows = groups.get(event.kind) ?? [];
      rows.push({ event, order: order++ });
      rows.sort(newest);
      if (rows.length > cap) rows.pop();
      groups.set(event.kind, rows);
    },
    finish() {
      const result: AnalyticsEvent[] = [];
      for (const rank of [0, 1, 2]) {
        for (let index = 0; index < cap && result.length < limit; index++) {
          const round = [...groups].flatMap(([kind, rows]) =>
            priority(kind) === rank && rows[index] ? [rows[index]!] : [],
          );
          round.sort(newest);
          for (const row of round) if (result.length < limit) result.push(row.event);
        }
      }
      return result;
    },
  };
}
