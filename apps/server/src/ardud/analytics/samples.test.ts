import { assert, describe, it } from "@effect/vitest";
import type { AnalyticsEvent } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { sampleMix } from "./samples.ts";

// The previous implementation is the ordering and admission oracle.
function referenceSampleMix(limit: number, kind?: string, admittedKinds: readonly string[] = []) {
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

const event = (kind: string, index: number, time = index): AnalyticsEvent => ({
  ts: DateTime.formatIso(
    DateTime.add(DateTime.makeUnsafe("2026-11-13T12:00:00.000Z"), { milliseconds: time }),
  ),
  kind,
  surface: "server",
  route: "test",
  cardId: `card-${index}`,
});

const stream = () => {
  let state = 0x1583;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  const kinds = [
    "kanban.hot",
    "ask.hot",
    "client.hot",
    "performance.long-task",
    ...Array.from({ length: 146 }, (_, index) => `kind.${index}`),
  ];
  return Array.from({ length: 6000 }, (_, index) => {
    const kind =
      index < kinds.length ? kinds[index]! : kinds[random() % (index % 3 ? 4 : kinds.length)]!;
    return {
      event: event(kind, index, random() % 64),
      // Also cover explicit, non-monotonic orders and exact comparator ties.
      sequence: index % 5 === 0 ? random() % 32 : undefined,
    };
  });
};

const events = stream();
const cases = [1, 50, 500].flatMap((limit) =>
  [undefined, "kanban.hot", "client.hot"].flatMap((kind) =>
    [false, true].map((seeded) => ({ limit, kind, seeded })),
  ),
);
describe("sampleMix equivalence", () => {
  it.each(cases)(
    "matches the old mix after every batch: limit=$limit, kind=$kind, seeded=$seeded",
    ({ limit, kind, seeded }) => {
      const admitted = seeded
        ? [
            "kanban.hot",
            "ask.hot",
            "client.hot",
            "performance.long-task",
            ...Array.from({ length: 130 }, (_, index) => `seed.${index}`),
          ]
        : [];
      const reference = referenceSampleMix(limit, kind, admitted);
      const actual = sampleMix(limit, kind, admitted);
      const selected = events.filter(({ event }) => kind === undefined || event.kind === kind);
      for (let start = 0; start < selected.length; start += 37) {
        for (const { event, sequence } of selected.slice(start, start + 37)) {
          reference.add(event, sequence);
          actual.add(event, sequence);
        }
        assert.deepEqual(actual.entries(), reference.entries());
        assert.deepEqual(actual.kinds(), reference.kinds());
      }
      assert.isAtMost(actual.kinds().length, 128);
      assert.isAtMost(actual.entries().length, limit);
    },
  );

  it.each(cases.filter(({ seeded }) => !seeded))(
    "preserves the old drain's samples across batches: limit=$limit, kind=$kind",
    ({ limit, kind }) => {
      const actual = sampleMix(limit, kind);
      let previous: ReturnType<ReturnType<typeof referenceSampleMix>["entries"]> = [];
      let kinds: string[] = [];
      const selected = events.filter(({ event }) => kind === undefined || event.kind === kind);
      for (let start = 0; start < selected.length; start += 37) {
        const rebuilt = referenceSampleMix(limit, kind, kinds);
        for (const sample of previous) rebuilt.add(sample.event, sample.order);
        for (const { event } of selected.slice(start, start + 37)) {
          rebuilt.add(event);
          actual.add(event);
        }
        previous = rebuilt.entries();
        kinds = rebuilt.kinds();
        assert.deepEqual(
          actual.finish(),
          previous.map((row) => row.event),
        );
        assert.deepEqual(actual.kinds(), kinds);
      }
    },
  );

  it("keeps stable arrival order for identical timestamp and sequence pairs at capacity", () => {
    const actual = sampleMix(1);
    const reference = referenceSampleMix(1);
    for (let index = 0; index < 5; index++) {
      const row = event("client.hot", index, 0);
      actual.add(row, 7);
      reference.add(row, 7);
      assert.deepEqual(actual.entries(), reference.entries());
    }
    assert.equal(actual.entries()[0]!.event.cardId, "card-0");
  });
});
