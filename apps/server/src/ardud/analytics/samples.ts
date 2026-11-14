import type { AnalyticsEvent } from "@t3tools/contracts";

// Keep noisy producers bounded without starving a rare kind out of the default read.
export function sampleMix(limit: number, kind?: string, admittedKinds: readonly string[] = []) {
  type Sample = { event: AnalyticsEvent; order: number };
  const groups = new Map<string, Sample[]>();
  for (const admitted of admittedKinds.slice(0, 128)) groups.set(admitted, []);
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
      rows.push({ event, order: sequence });
      rows.sort(newest);
      if (rows.length > cap) rows.pop();
      groups.set(event.kind, rows);
    },
    entries,
    kinds: () => [...groups.keys()],
    finish: () => entries().map((row) => row.event),
  };
}
