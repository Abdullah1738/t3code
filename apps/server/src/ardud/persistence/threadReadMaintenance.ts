import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import { Analytics } from "../analytics/Analytics.ts";
import { threadReadIndexes } from "./threadReadIndexes.ts";

// SQLite cannot resume a partial CREATE INDEX. Each attempt owns the writer
// permit only while idle; a normal writer borrower stops its isolated process
// and waits for exit (rollback) before taking that permit. The production writer
// and checkpoint code runs unchanged in that process, including WAL admission.
export const maintainThreadReadIndexes = Effect.fn("maintainThreadReadIndexes")(function* (
  options = { idleMs: 60_000, retryMs: 60_000 },
) {
  const sql = yield* SqlClient.SqlClient;
  const analytics = yield* Effect.serviceOption(Analytics);
  for (const [schema, table] of [
    ["main", "orchestration_v2_projection_turn_items"],
    ["ardud_archive", "ardud_turn_items"],
  ] as const) {
    for (const statement of threadReadIndexes(schema, table)) {
      const name = statement.split(/\s+/)[5]!.split(".")[1]!;
      let attempts = 0;
      while (true) {
        // IF NOT EXISTS is also the presence check. A separate catalogue read
        // could fall back to the writer and keep resetting the quiet window.
        let startedAt = 0;
        const record = Effect.fn("maintainThreadReadIndexes.record")(function* (
          phase: "start" | "ok" | "interrupted" | "error",
        ) {
          const now = yield* Clock.currentTimeMillis;
          if (phase === "start") startedAt = now;
          yield* Effect.logInfo("Thread read index maintenance", {
            phase,
            table: `${schema}.${table}`,
            index: name,
            startedAt,
            endedAt: phase === "start" ? undefined : now,
            durationMs: now - startedAt,
          });
          if (Option.isSome(analytics))
            yield* analytics.value.record({
              kind: "db.maintenance.index",
              surface: "server",
              route: `${schema}.${table}`,
              tool: name,
              ts: DateTime.formatIso(DateTime.makeUnsafe(now)),
              startedAt: DateTime.formatIso(DateTime.makeUnsafe(startedAt)),
              durationMs: now - startedAt,
              ...(phase === "start" ? {} : { outcome: phase }),
            });
        });
        const result = yield* NodeSqliteClient.idleIndexBuild(sql, statement, options.idleMs, () =>
          record("start"),
        ).pipe(
          Effect.tap((result) =>
            Option.isSome(result) ? record(result.value ? "ok" : "interrupted") : Effect.void,
          ),
          Effect.onInterrupt(() => (startedAt > 0 ? record("interrupted") : Effect.void)),
          Effect.catch((cause) =>
            Effect.logWarning("Index maintenance attempt failed", { cause }).pipe(
              Effect.andThen(record("error")),
              Effect.as(Option.none<boolean>()),
            ),
          ),
        );
        if (Option.isSome(result) && result.value) break;
        yield* Effect.sleep(
          Math.min(options.retryMs * 2 ** Math.min(attempts++, 4), options.retryMs * 16),
        );
      }
    }
  }
});
