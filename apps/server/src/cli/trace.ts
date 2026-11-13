import { isSpanSummaryRecord } from "@t3tools/shared/observability";
import { PositiveInt } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";

import * as ServerConfig from "../config.ts";
import { streamTraceFileLines, toRotatedTracePaths } from "../diagnostics/TraceDiagnostics.ts";
import { resolveBaseDir } from "../os-jank.ts";
import { baseDirFlag, DurationFromString, traceFileConfig, traceMaxFilesConfig } from "./config.ts";

const decodeTraceSpanLine = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      name: Schema.String,
      durationMs: Schema.Finite,
      endTimeUnixNano: Schema.FiniteFromString,
      exit: Schema.optional(Schema.Struct({ _tag: Schema.String })),
      // Effect's OTLP tracer writes code "2" for errors. It marks interrupts
      // with an `effect.fiber.interrupted` attribute; clients before Effect
      // 4.0.2 wrote code "1" with message "Interrupted" instead.
      status: Schema.optional(
        Schema.Struct({
          code: Schema.optional(Schema.String),
          message: Schema.optional(Schema.String),
        }),
      ),
      attributes: Schema.optional(
        Schema.Struct({ "effect.fiber.interrupted": Schema.optional(Schema.Unknown) }),
      ),
    }),
  ),
);

export function makeTraceSpanSummary(sinceMs = -Infinity) {
  const byName = new Map<
    string,
    {
      durations: number[];
      interrupted: number;
      failures: number;
      omitted: number;
      maxOmittedMs: number;
    }
  >();
  let summarisedSpanCount = 0;
  let spanCount = 0;
  let skippedLineCount = 0;
  let firstEndMs = Infinity;
  let lastEndMs = -Infinity;

  const addLine = (line: string) => {
    if (line.trim().length === 0) return;
    if (line.includes('"span-summary"')) {
      try {
        const summary: unknown = JSON.parse(line);
        if (isSpanSummaryRecord(summary)) {
          if (summary.windowEnd < sinceMs) return;
          for (const [name, stats] of Object.entries(summary.spans)) {
            if (stats.count < 1 || stats.maxMs < 0 || stats.totalMs < 0) continue;
            const current = byName.get(name) ?? {
              durations: [],
              interrupted: 0,
              failures: 0,
              omitted: 0,
              maxOmittedMs: 0,
            };
            current.omitted += stats.count;
            current.maxOmittedMs = Math.max(current.maxOmittedMs, stats.maxMs);
            byName.set(name, current);
            spanCount += stats.count;
            summarisedSpanCount += stats.count;
          }
          firstEndMs = Math.min(firstEndMs, summary.windowStart);
          lastEndMs = Math.max(lastEndMs, summary.windowEnd);
          return;
        }
      } catch {
        /* Malformed records are counted below. */
      }
    }
    const span = Option.getOrUndefined(decodeTraceSpanLine(line));
    if (span === undefined) {
      skippedLineCount += 1;
      return;
    }
    const endMs = span.endTimeUnixNano / 1_000_000;
    // The report prints end times as dates, so skip ones outside the Date range.
    if (Option.isNone(DateTime.make(endMs))) {
      skippedLineCount += 1;
      return;
    }
    if (endMs < sinceMs) return;

    spanCount += 1;
    firstEndMs = Math.min(firstEndMs, endMs);
    lastEndMs = Math.max(lastEndMs, endMs);
    const stats = byName.get(span.name) ?? {
      durations: [],
      interrupted: 0,
      failures: 0,
      omitted: 0,
      maxOmittedMs: 0,
    };
    stats.durations.push(span.durationMs);
    if (
      span.exit?._tag === "Interrupted" ||
      span.attributes?.["effect.fiber.interrupted"] === true ||
      span.status?.message === "Interrupted"
    ) {
      stats.interrupted += 1;
    }
    if (span.exit?._tag === "Failure" || span.status?.code === "2") stats.failures += 1;
    byName.set(span.name, stats);
  };

  const finish = () => {
    const minutes = (lastEndMs - firstEndMs) / 60_000;
    const spans = [...byName]
      .map(([name, { durations, interrupted, failures, omitted, maxOmittedMs }]) => {
        const sorted = durations.toSorted((left, right) => left - right);
        const percentile = (p: number) =>
          sorted.length > 0 ? sorted[Math.ceil(p * sorted.length) - 1]! : NaN;
        return {
          name,
          count: sorted.length + omitted,
          perMinute: minutes > 0 ? (sorted.length + omitted) / minutes : undefined,
          p50Ms: percentile(0.5),
          p90Ms: percentile(0.9),
          maxMs: Math.max(sorted[sorted.length - 1] ?? 0, maxOmittedMs),
          interrupted,
          failures,
        };
      })
      .toSorted((left, right) => right.count - left.count || left.name.localeCompare(right.name));

    return {
      spanCount,
      summarisedSpanCount,
      skippedLineCount,
      firstEndMs,
      lastEndMs,
      minutes,
      spans,
    };
  };

  return { addLine, finish };
}

const formatMs = (ms: number) =>
  !Number.isFinite(ms) ? "-" : ms < 1_000 ? `${Math.round(ms)}ms` : `${(ms / 1_000).toFixed(1)}s`;

function formatTraceSummary(
  summary: ReturnType<ReturnType<typeof makeTraceSpanSummary>["finish"]>,
  limit: number,
) {
  const header = ["span", "count", "/min", "p50", "p90", "max", "interrupted", "failed"];
  const rows = summary.spans
    .slice(0, limit)
    .map((span) => [
      span.name,
      String(span.count),
      span.perMinute === undefined
        ? "-"
        : span.perMinute < 0.1
          ? "<0.1"
          : span.perMinute.toFixed(1),
      formatMs(span.p50Ms),
      formatMs(span.p90Ms),
      formatMs(span.maxMs),
      String(span.interrupted),
      String(span.failures),
    ]);
  const table = [header, ...rows];
  const widths = header.map((_, column) => Math.max(...table.map((row) => row[column]!.length)));
  const formatIso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
  return [
    `${summary.spanCount} spans ended from ${formatIso(summary.firstEndMs)} to ${formatIso(summary.lastEndMs)} (${summary.minutes.toFixed(1)} min).`,
    ...(summary.skippedLineCount > 0
      ? [`Skipped ${summary.skippedLineCount} lines that are not spans.`]
      : []),
    ...(summary.summarisedSpanCount > 0
      ? [
          `${summary.summarisedSpanCount} fast successful spans counted from minute summaries; p50/p90 cover full records only. Summary time filtering has one-minute precision.`,
        ]
      : []),
    "",
    ...table.map((row) =>
      row
        .map((cell, column) =>
          column === 0 ? cell.padEnd(widths[column]!) : cell.padStart(widths[column]!),
        )
        .join("  "),
    ),
    ...(summary.spans.length > limit
      ? ["", `${summary.spans.length - limit} more span names. Use --limit to show more.`]
      : []),
  ].join("\n");
}

const traceSummaryCommand = Command.make("summary", {
  baseDir: baseDirFlag,
  since: Flag.String("since").pipe(
    Flag.withSchema(DurationFromString),
    Flag.withDescription("Only count spans that ended in this window, for example 30m or 2h."),
    Flag.optional,
  ),
  limit: Flag.Int("limit").pipe(
    Flag.withSchema(PositiveInt),
    Flag.withDescription("Number of span names to show, busiest first."),
    Flag.withDefault(25),
  ),
}).pipe(
  Command.withDescription("Summarize the local server trace file: counts, rates, and latency."),
  Command.withHandler(
    Effect.fn("cli.trace.summary")(function* (flags) {
      const fs = yield* FileSystem.FileSystem;
      const envHome = yield* Config.String("T3CODE_HOME").pipe(Config.option);
      const baseDir = yield* resolveBaseDir(
        Option.getOrUndefined(Option.orElse(flags.baseDir, () => envHome)),
      );
      const traceFilePath =
        (yield* traceFileConfig) ??
        (yield* ServerConfig.deriveServerPaths(baseDir, undefined)).serverTracePath;
      const sinceMs = Option.isSome(flags.since)
        ? (yield* Clock.currentTimeMillis) - Duration.toMillis(flags.since.value)
        : undefined;
      const summarizer = makeTraceSpanSummary(sinceMs);
      yield* Effect.forEach(
        toRotatedTracePaths(traceFilePath, yield* traceMaxFilesConfig),
        (path) => streamTraceFileLines(fs, path, summarizer.addLine),
        { discard: true },
      );
      const summary = summarizer.finish();

      yield* Console.log(
        summary.spanCount === 0
          ? `No spans found in ${traceFilePath} or its rotated files${sinceMs === undefined ? "" : " in that window"}.${summary.skippedLineCount > 0 ? ` Skipped ${summary.skippedLineCount} lines that are not spans.` : ""}`
          : formatTraceSummary(summary, flags.limit),
      );
    }),
  ),
);

export const traceCommand = Command.make("trace").pipe(
  Command.withDescription("Inspect the local server trace file."),
  Command.withSubcommands([traceSummaryCommand]),
);
