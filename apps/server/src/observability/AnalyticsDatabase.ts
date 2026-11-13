import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Analytics from "../ardud/analytics/Analytics.ts";
import { recordServerAnalytics, safeAnalyticsLabel } from "./RpcInstrumentation.ts";

export const layer = Layer.effect(
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
