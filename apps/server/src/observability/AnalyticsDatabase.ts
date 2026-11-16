import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Config from "effect/Config";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Analytics from "../ardud/analytics/Analytics.ts";
import { recordServerAnalytics, safeAnalyticsLabel } from "./RpcInstrumentation.ts";
import { diskReadDelta, sampleProcessDiskRead, type DiskReadSample } from "./processDiskRead.ts";

const slowStatements = Layer.effect(
  NodeSqliteClient.StatementObserver,
  Effect.gen(function* () {
    const analytics = yield* Analytics.Analytics;
    return {
      slowThresholdMs: 100,
      // SQL already owns its span. Observation never carries SQL, bindings or database paths.
      record: Effect.fnUntraced(function* (
        observation: NodeSqliteClient.SqliteStatementObservation,
      ) {
        const now = yield* DateTime.now;
        yield* recordServerAnalytics(analytics, {
          ts: DateTime.formatIso(now),
          kind: "db.slow",
          surface: "server",
          route: "database",
          durationMs: observation.durationMs,
          props: {
            ...(observation.waitMs === undefined ? {} : { waitMs: observation.waitMs }),
            ...(observation.outcome === "interrupt" ? { cause: "unknown" as const } : {}),
            phase: observation.operation,
            key: observation.connection,
            reason: observation.outcome,
            span: safeAnalyticsLabel(observation.span ?? "database", "database"),
            ...(observation.outcome === "failure" ? { errorTag: "SqlError" } : {}),
          },
        });
      }),
    };
  }),
);

class StatementCollector extends Context.Service<
  StatementCollector,
  ReturnType<typeof NodeSqliteClient.makeStatementStats> & {
    readonly diagnostic: boolean;
    readonly initialDiskRead: DiskReadSample | undefined;
    readonly startedAt: number;
    readonly sample: () => Promise<DiskReadSample | undefined>;
    readonly monotonicMs: () => number;
  }
>()("t3/observability/AnalyticsDatabase/StatementCollector") {}

const collector = Layer.effect(
  StatementCollector,
  Effect.gen(function* () {
    const diagnostic = yield* Config.Boolean("ROBOB_SQL_READ_PROFILE").pipe(
      Config.withDefault(false),
      Effect.orDie,
    );
    const platform = yield* HostProcess.Platform;
    const sample = () => sampleProcessDiskRead(platform);
    const clock = yield* Clock.Clock;
    const monotonicMs = () => Number(clock.monotonicTimeNanosUnsafe()) / 1e6;
    const initialDiskRead = yield* Effect.promise(sample);
    // The hook and byte baseline share an interval, including persistence startup.
    return {
      ...NodeSqliteClient.makeStatementStats(diagnostic),
      diagnostic,
      initialDiskRead,
      startedAt: monotonicMs(),
      sample,
      monotonicMs,
    };
  }),
);

// Analytics itself needs persistence. Install the in-memory hook before that
// dependency opens the shared database; the flushing fiber can start afterward.
export const layerStatementStats = Layer.effect(
  NodeSqliteClient.StatementStats,
  Effect.map(StatementCollector, (stats) => stats.record),
).pipe(Layer.provideMerge(collector));

const statementStats = Layer.effectDiscard(
  Effect.gen(function* () {
    const analytics = yield* Analytics.Analytics;
    const stats = yield* StatementCollector;
    let previous = stats.initialDiskRead;
    let previousAt = stats.startedAt;
    const flush = Effect.gen(function* () {
      const current = yield* Effect.promise(stats.sample);
      const now = stats.monotonicMs();
      const summaries = stats.drain();
      const sampleMs = Math.max(0, now - previousAt);
      const bytes = diskReadDelta(previous, current);
      previous = current;
      previousAt = now;
      const ts = DateTime.formatIso(yield* DateTime.now);
      yield* recordServerAnalytics(analytics, {
        ts,
        kind: "db.process.disk_read",
        surface: "server",
        route: "database",
        props: {
          sampleMs,
          reason: bytes === undefined ? "unavailable" : "pid-with-workers-excludes-children",
          ...(bytes === undefined ? {} : { readBytes: bytes }),
        },
      });
      for (const summary of summaries) {
        yield* recordServerAnalytics(analytics, {
          ts,
          kind: "db.statement.summary",
          surface: "server",
          route: "database",
          props: {
            database: safeAnalyticsLabel(summary.database, "sqlite"),
            connection: summary.connection,
            lane: summary.lane,
            sqlFingerprint: summary.fingerprint,
            key: safeAnalyticsLabel(summary.family, "SQL"),
            count: summary.calls,
            resultCount: summary.rows,
            failures: summary.failures,
            totalMs: summary.executionMs,
            maxMs: summary.maxMs,
            sampleMs,
          },
        });
        if (stats.diagnostic) yield* Effect.logInfo("sqlite.read-profile", summary);
      }
    });
    // The hot path mutates bounded maps only. SQL text is logged solely by the
    // opt-in profiler; returned rows are not a claim about pages visited.
    yield* Effect.sleep("1 minute").pipe(Effect.andThen(flush), Effect.forever, Effect.forkScoped);
  }),
);

export const layer = Layer.mergeAll(slowStatements, statementStats);
