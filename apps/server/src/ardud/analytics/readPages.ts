// @effect-diagnostics-next-line nodeBuiltinImport:off -- Opaque cursor ids are allocated synchronously by the in-memory pager.
import * as NodeCrypto from "node:crypto";
import type {
  AnalyticsEvent,
  AnalyticsReadInput,
  AnalyticsReadResult,
  AnalyticsRollup,
} from "@t3tools/contracts";
import { COMPACT_READ_CHARS } from "../compactRead.ts";
import { finishRollup, makeAccumulator } from "./rollup.ts";

type Row = NonNullable<AnalyticsReadResult["rows"]>[number];
const size = (value: unknown) => JSON.stringify(value).length;
const query = (input: AnalyticsReadInput) =>
  JSON.stringify(
    Object.entries(input)
      .filter(([key]) => !["cursor", "section", "limit"].includes(key))
      .sort(([a], [b]) => a.localeCompare(b)),
  );

// Paths keep nested lists (notably boards and usage) pageable without cutting their parent row.
function rowsOf(value: Row["value"], path: Row["path"] = []): Row[] {
  if (Array.isArray(value))
    return value.length === 0
      ? [{ path, value }]
      : value.flatMap((row, index) => rowsOf(row, [...path, index]));
  if (
    value !== null &&
    typeof value === "object" &&
    size(value) > 8_000 &&
    Object.values(value).some(hasArray)
  )
    return Object.entries(value).flatMap(([key, row]) => rowsOf(row, [...path, key]));
  return [{ path, value }];
}
function hasArray(value: Row["value"]): boolean {
  return (
    Array.isArray(value) ||
    (value !== null && typeof value === "object" && Object.values(value).some(hasArray))
  );
}

function preview<T>(value: T, width: number, key = ""): T {
  if (Array.isArray(value)) {
    const ranked = key.startsWith("topCardsBy")
      ? value
      : value.toSorted(
          (a, b) =>
            (b?.maxMs ?? b?.ageMs ?? b?.wallMs ?? b?.rounds ?? 0) -
            (a?.maxMs ?? a?.ageMs ?? a?.wallMs ?? a?.rounds ?? 0),
        );
    return ranked.slice(0, width).map((row) => preview(row, width)) as T;
  }
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, row]) => [key, preview(row, width, key)]),
    ) as T;
  return value;
}

function minimal(rollup: AnalyticsRollup): AnalyticsRollup {
  const empty = finishRollup(makeAccumulator(), rollup.day, rollup.generatedAt);
  return {
    ...empty,
    total: rollup.total,
    invalidLines: rollup.invalidLines,
    usage: { ...empty.usage, totals: rollup.usage.totals },
  };
}

// Only the exceptional over-budget leaf loses detail, explicitly marked in both the row and reply.
function trim(value: Row["value"], width: number): Row["value"] {
  if (typeof value === "string") return value.slice(0, width);
  if (Array.isArray(value)) return value.slice(0, width).map((row) => trim(row, width));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, width)
        .map(([key, row]) => [key.slice(0, width), trim(row, width)]),
    );
  return value;
}

export function makeReadPager() {
  type Snapshot = {
    query: string;
    section: NonNullable<AnalyticsReadInput["section"]>;
    rows: Row[];
    base: AnalyticsReadResult;
  };
  // Immutable section snapshots survive appends, advancing ask ages, retries and changed page limits.
  // FIFO bounds resident memory; expired cursors must restart the section.
  const snapshots = new Map<string, Snapshot>();
  function page(
    snapshot: Snapshot,
    id: string,
    offset: number,
    limit: number,
  ): AnalyticsReadResult {
    const rows: Row[] = [];
    const continuation = "Repeat this section with the same filters and cursor; limit may change.";
    const omitted =
      "An oversized row was trimmed and marked truncated; omitted leaf detail is unavailable in this read.";
    const reply = (end: number): AnalyticsReadResult => {
      const hasMore = end < snapshot.rows.length;
      const truncated = rows.some((row) => row.truncated);
      return {
        ...snapshot.base,
        section: snapshot.section,
        rows,
        hasMore,
        ...(hasMore ? { cursor: `${id}:${end}` } : {}),
        ...(truncated ? { truncated: true } : {}),
        ...(truncated || hasMore
          ? {
              next: [truncated ? omitted : "", hasMore ? continuation : ""]
                .filter(Boolean)
                .join(" "),
            }
          : {}),
      };
    };
    let end = offset;
    // Reserve the complete wrapper, including the longest cursor and truncation notice.
    const wrapper = size({
      ...reply(snapshot.rows.length),
      hasMore: true,
      cursor: `${id}:${Number.MAX_SAFE_INTEGER}`,
      truncated: true,
      next: `${omitted} ${continuation}`,
    });
    let chars = wrapper;
    for (; end < snapshot.rows.length && rows.length < limit; end++) {
      let row = snapshot.rows[end]!;
      if (size(row) + wrapper + 1 > COMPACT_READ_CHARS) {
        let width = 64;
        do {
          row = { path: row.path, value: trim(snapshot.rows[end]!.value, width), truncated: true };
          width = Math.floor(width / 2);
        } while (size(row) + wrapper + 1 > COMPACT_READ_CHARS);
      }
      const cost = size(row) + 1;
      if (chars + cost > COMPACT_READ_CHARS) break;
      rows.push(row);
      chars += cost;
    }
    return reply(end);
  }
  return {
    resume(input: AnalyticsReadInput): AnalyticsReadResult | undefined {
      const match = /^([a-f0-9-]{36}):(\d{1,16})$/.exec(input.cursor ?? "");
      const snapshot = match ? snapshots.get(match[1]!) : undefined;
      const offset = Number(match?.[2]);
      if (
        !snapshot ||
        snapshot.query !== query(input) ||
        snapshot.section !== input.section ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset > snapshot.rows.length
      )
        return undefined;
      return page(snapshot, match![1]!, offset, input.limit ?? 100);
    },
    read(
      input: AnalyticsReadInput,
      rollup: AnalyticsRollup,
      samples: readonly AnalyticsEvent[],
    ): AnalyticsReadResult {
      const summary = {
        events: rollup.total,
        errors: Object.values(rollup.errorCounts).reduce((sum, count) => sum + count, 0),
        mcpCalls: rollup.mcpCalls.reduce((sum, row) => sum + row.count, 0),
        mcpFailures: rollup.mcpCalls.reduce((sum, row) => sum + row.failures, 0),
        boardMoves: rollup.boards.reduce(
          (sum, board) => sum + board.moves.reduce((n, row) => n + row.count, 0),
          0,
        ),
        reviewRounds: rollup.boards.reduce(
          (sum, board) => sum + board.reviewRounds.reduce((n, row) => n + row.rounds, 0),
          0,
        ),
        stalls: rollup.boards.reduce(
          (sum, board) => sum + board.stalls.reduce((n, row) => n + row.sets, 0),
          0,
        ),
        openAsks: rollup.boards.reduce((sum, board) => sum + board.openAsks.length, 0),
        runs: rollup.usage.totals.runs,
      };
      const values = { ...rollup, samples };
      const sections = Object.entries(values).flatMap(([name, value]) =>
        value === undefined
          ? []
          : [
              {
                name: name as AnalyticsReadResult["sections"][number]["name"],
                rows: rowsOf(value).length,
                chars: size(value),
              },
            ],
      );
      if (input.section !== undefined) {
        const id = NodeCrypto.randomUUID();
        const value = values[input.section];
        const snapshot: Snapshot = structuredClone({
          query: query(input),
          section: input.section,
          rows: value === undefined ? [] : rowsOf(value),
          base: { rollup: minimal(rollup), samples: [], summary, sections, hasMore: false },
        });
        const result = page(snapshot, id, 0, input.limit ?? 100);
        if (result.hasMore) {
          if (snapshots.size >= 16) snapshots.delete(snapshots.keys().next().value!);
          snapshots.set(id, snapshot);
        }
        return result;
      }
      const full = {
        rollup,
        samples: samples.slice(0, input.limit ?? 100),
        summary,
        sections,
        hasMore: false,
        next: "Fetch section by name from sections; follow cursor while hasMore with the same filters.",
      };
      if (size(full) <= COMPACT_READ_CHARS) return full;
      const next =
        "Summary only: fetch section by name from sections; follow cursor while hasMore with the same filters. Samples cover the retained mixed sample view (at most 500).";
      for (const width of [5, 1, 0]) {
        const result = {
          rollup: preview(rollup, width),
          samples: samples.slice(0, Math.min(width, input.limit ?? 100)),
          summary,
          sections,
          hasMore: false,
          truncated: true,
          next,
        };
        if (size(result) <= COMPACT_READ_CHARS) return result;
      }
      return {
        rollup: minimal(rollup),
        samples: [],
        summary,
        sections,
        hasMore: false,
        truncated: true,
        next,
      };
    },
  };
}
