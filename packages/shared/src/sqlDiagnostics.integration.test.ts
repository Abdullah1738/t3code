import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Tracer from "effect/Tracer";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import * as Statement from "effect/sql/Statement";
import * as NodeSqliteClient from "./nodeSqliteClient.ts";
import { makeLocalFileTracer, makeTraceSink, type TraceRecord } from "./observability.ts";
import { normalizeSql, sqlFingerprint } from "./sqlDiagnostics.ts";
import { explainSql } from "../../../apps/server/scripts/explain-sql.ts";

it.live(
  "a real slow query records sanitized text, rows, lane, wait, and one offline plan",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "sql-diagnostics-" });
      const filename = directory + "/fixture.sqlite";
      const tracePath = directory + "/trace.ndjson";
      const records: TraceRecord[] = [];
      const delegates: Tracer.Span[] = [];
      const logs: unknown[] = [];
      const logger = Logger.make(({ message }) => {
        logs.push(message);
      });
      const sink = yield* makeTraceSink({
        filePath: tracePath,
        maxBytes: 1_000_000,
        maxFiles: 1,
        batchWindowMs: 10,
        fileFilter: { minDurationMs: 1_000 },
      });
      const tracer = yield* makeLocalFileTracer({
        filePath: tracePath,
        maxBytes: 1_000_000,
        maxFiles: 1,
        batchWindowMs: 10,
        delegate: Tracer.make({
          span: (options) => {
            const span = new Tracer.NativeSpan(options);
            delegates.push(span);
            return span;
          },
        }),
        sink: {
          ...sink,
          capture: () => (record) => {
            records.push(record);
            sink.push(record);
          },
        },
      });
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA journal_mode = WAL`;
        yield* sql`CREATE TABLE entries (value TEXT)`;
        yield* sql`CREATE VIEW ardud_history_entries AS SELECT 1 AS pinned`;
        yield* sql`INSERT INTO entries VALUES (${"bound-user-secret"})`;
        yield* sql.unsafe(
          "CREATE INDEX entries_private_idx ON entries(value) WHERE value = 'source-predicate'",
        );
        yield* sql.unsafe(
          "SELECT " + Array.from({ length: 120 }, (_, index) => `1 AS column_${index}`).join(", "),
        );
        // Deliberate SQLite work, no sleep: enough recursive VM steps to exceed 1 s.
        const query = sql`WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ${30_000_000}) SELECT max(x) AS last, ${"bound-user-secret"} AS marker, 'slow-inline-secret' AS inline_marker /* slow-comment-secret */ FROM c CROSS JOIN ardud_history_entries`;
        yield* query.pipe(NodeSqliteClient.readOnly, NodeSqliteClient.foregroundReads);
        yield* query.pipe(
          NodeSqliteClient.readOnly,
          Effect.provideService(NodeSqliteClient.ReaderLane, "auth"),
        );
        const failed =
          yield* sql`WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ${30_000_000}) SELECT json_extract(json_object('max', max(x)), ${"slow-failed-bound-secret"}) FROM c`.pipe(
            NodeSqliteClient.readOnly,
            NodeSqliteClient.foregroundReads,
            Effect.exit,
          );
        assert.isTrue(Exit.isFailure(failed));
        yield* sql.unsafe("SELECT 'inline-user-secret' AS value /* comment-user-secret */");
        yield* sql.unsafe('\uFEFFPRAGMA user_version = "bom-user-secret"').pipe(Effect.ignore);
        yield* sql
          .unsafe('CREATE VIRTUAL TABLE ft USING fts5(body, content="module-user-secret")')
          .pipe(Effect.ignore);
        yield* sql`SELECT * FROM missing WHERE value = ${"failed-bound-secret"}`.pipe(
          Effect.ignore,
        );
        const failure = { _tag: "FixtureSqlError", cause: "failure-user-secret" };
        const observed = yield* Effect.fail(failure).pipe(
          Effect.withSpan("sqlite", {
            attributes: { "db.query.text": "SELECT 'inline-user-secret' AS value" },
          }),
          Effect.flip,
        );
        assert.strictEqual(observed, failure);
        yield* sql`SELECT ${"disabled-bound-secret"}`.pipe(
          Effect.withTracerEnabled(false),
          Effect.withSpan("sqlite", { attributes: { "test.disabled": "tracer" } }),
        );
        yield* sql`SELECT ${"disabled-bound-secret"}`.pipe(
          Effect.provideService(Statement.SpanPropagationEnabled, false),
          Effect.withSpan("sqlite", { attributes: { "test.disabled": "propagation" } }),
        );
      }).pipe(
        Effect.provide(
          NodeSqliteClient.layer({
            filename,
            readerWorker: true,
            readerInitializationSql: [
              "CREATE TEMP VIEW ardud_history_entries AS SELECT 1 AS pinned",
            ],
            readerSnapshotSql: ["SELECT rootpage FROM main.sqlite_schema LIMIT 1"],
            statementMetrics: false,
            foregroundReaderSlots: 1,
            authReaderProcess: true,
            readerStatementLimit: "30 seconds",
            readerSlowStatement: "1 second",
          }),
        ),
        Effect.withTracer(tracer),
        Effect.provideService(Statement.SpanPropagationEnabled, true),
        Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
      );
      yield* sink.flush;
      const raw = yield* fs.readFileString(tracePath);
      const delegateCauses = delegates.flatMap((span) =>
        span.status._tag === "Ended" && Exit.isFailure(span.status.exit)
          ? [Cause.pretty(span.status.exit.cause)]
          : [],
      );
      for (const secret of [
        "bound-user-secret",
        "inline-user-secret",
        "comment-user-secret",
        "failed-bound-secret",
        "disabled-bound-secret",
        "failure-user-secret",
        "slow-inline-secret",
        "slow-comment-secret",
        "bom-user-secret",
        "module-user-secret",
        "slow-failed-bound-secret",
      ])
        assert.notInclude(
          JSON.stringify(records) + JSON.stringify(logs) + JSON.stringify(delegateCauses) + raw,
          secret,
        );
      const diagnosticText = records
        .flatMap((record) => [
          record.attributes["db.query.text"],
          ...record.events.map((event) => event.attributes["sql.statement"]),
        ])
        .filter((value) => typeof value === "string");
      assert.notInclude(JSON.stringify(diagnosticText), "30000000");
      assert.include(JSON.stringify(logs), "SQLite reader statement is slow");
      const disabledParents = records.filter(
        (record) => record.attributes["test.disabled"] !== undefined,
      );
      assert.lengthOf(disabledParents, 2);
      for (const record of disabledParents) {
        assert.isUndefined(record.attributes["db.rows_returned"]);
        assert.isUndefined(record.attributes["db.statement.execution_ms"]);
      }
      const slow = records.filter(
        (record) => Number(record.attributes["db.statement.execution_ms"]) >= 1_000,
      );
      assert.lengthOf(slow, 3);
      assert.deepStrictEqual(
        slow.map((record) => record.attributes["db.reader.lane"]),
        ["foreground", "auth", "foreground"],
      );
      assert.deepStrictEqual(
        slow.map((record) => record.attributes["db.rows_returned"]),
        [1, 1, 0],
      );
      for (const record of slow) {
        assert.isAtLeast(record.durationMs, 1_000);
        assert.equal(record.attributes["db.connection"], "reader");
        assert.equal(record.attributes["db.stmt_status.available"], false);
        assert.isNumber(record.attributes["db.lock_wait_ms"]);
        assert.equal(
          record.attributes["db.statement.connection_wait_ms"],
          record.attributes["db.lock_wait_ms"],
        );
        assert.isString(record.attributes["sql.fingerprint"]);
      }
      assert.lengthOf(
        slow[2]!.events.filter((event) => event.name === "sql.plan"),
        1,
      );
      const fingerprint = String(slow[0]!.attributes["sql.fingerprint"]);
      const events = records
        .flatMap((record) => record.events)
        .filter((event) => event.attributes["sql.fingerprint"] === fingerprint);
      assert.lengthOf(
        events.filter((event) => event.name === "sql.statement"),
        1,
      );
      assert.lengthOf(
        events.filter((event) => event.name === "sql.plan"),
        1,
      );
      const statement = String(
        events.find((event) => event.name === "sql.statement")!.attributes["sql.statement"],
      );
      const original = yield* fs.readFile(filename);
      const plan = explainSql({ snapshot: filename, statement, fingerprint });
      assert.deepStrictEqual(yield* fs.readFile(filename), original);
      assert.isAbove(plan["sql.plan.rows"].length, 0);
      assert.include(JSON.stringify(plan), "RECURSIVE");
      if (process.env.SQL_DIAGNOSTICS_EVIDENCE_OUTPUT)
        yield* fs.writeFileString(
          process.env.SQL_DIAGNOSTICS_EVIDENCE_OUTPUT,
          JSON.stringify({ slow: slow[0], plan }),
        );
      const longText = records
        .flatMap((record) => record.events)
        .find(
          (event) =>
            event.name === "sql.statement" &&
            String(event.attributes["sql.statement"]).includes("column_119"),
        );
      assert.isAbove(String(longText?.attributes["sql.statement"]).length, 500);
      const quoted = 'SELECT ? AS "has ? space"';
      assert.isAbove(
        explainSql({
          snapshot: filename,
          statement: quoted,
          fingerprint: sqlFingerprint(normalizeSql(quoted)),
        })["sql.plan.rows"].length,
        0,
      );
      const partial = "SELECT * FROM entries INDEXED BY entries_private_idx WHERE value = ?";
      const partialFingerprint = sqlFingerprint(normalizeSql(partial));
      const partialPlan = explainSql({
        snapshot: filename,
        statement: partial,
        fingerprint: partialFingerprint,
        parameters: ["source-predicate"],
      });
      assert.include(JSON.stringify(partialPlan), "entries_private_idx");
      assert.notInclude(JSON.stringify(partialPlan), "source-predicate");
      for (const { expression, parameters } of [
        { expression: "?", parameters: ["plan-private-secret"] },
        { expression: "?", parameters: ["plan-private-secret'quoted"] },
        { expression: "?", parameters: ["plan-private-secret--comment\n;(value)"] },
        { expression: "?", parameters: ["plan-private-secret\0nul"] },
        { expression: "?", parameters: [7396251804] },
        { expression: "?", parameters: [7396251804n] },
        {
          expression: "?",
          parameters: [new TextEncoder().encode("plan-private-secret")],
        },
        { expression: "upper(?)", parameters: ["plan-private-secret"] },
        {
          expression: "? || ?",
          parameters: ["plan-private-secret", "joined-private-secret"],
        },
        { expression: "CAST(? AS TEXT)", parameters: ["plan-private-secret"] },
      ]) {
        const sql = `WITH c AS MATERIALIZED (SELECT ${expression} FROM entries) SELECT * FROM c a NATURAL JOIN c b`;
        const namedPlan = explainSql({
          snapshot: filename,
          statement: sql,
          fingerprint: sqlFingerprint(normalizeSql(sql)),
          parameters,
        });
        const details = JSON.stringify(namedPlan["sql.plan.rows"]);
        assert.include(details, "AUTOMATIC");
        assert.notInclude(details, "private-secret");
        assert.notInclude(details, "7396251804");
        for (const value of parameters) {
          const bytes =
            typeof value === "string"
              ? new TextEncoder().encode(value)
              : value instanceof Uint8Array
                ? value
                : undefined;
          if (bytes)
            assert.notInclude(
              details,
              Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""),
            );
        }
      }
      const attachedSql = "SELECT * FROM auxiliary.entries";
      const attachedPlan = explainSql({
        snapshot: filename,
        statement: attachedSql,
        fingerprint: sqlFingerprint(normalizeSql(attachedSql)),
        attachments: [{ name: "auxiliary", snapshot: filename }],
      });
      assert.isAbove(attachedPlan["sql.plan.rows"].length, 0);
      assert.throws(
        () => explainSql({ snapshot: filename, statement: partial, fingerprint: "wrong" }),
        "fingerprint mismatch",
      );
      // The fast, first text record survives the sink's slow-span filter too.
      assert.include(raw, "CREATE TABLE entries");
      for (const record of records.filter(
        (record) => record.attributes["db.query.text"] !== undefined,
      ))
        assert.isString(record.attributes["sql.fingerprint"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { timeout: 60_000 },
);

it.live.each(
  (["foreground", "background", "auth", "identity"] as const).flatMap((lane) =>
    [false, true].map((transaction) => ({ lane, transaction })),
  ),
)(
  "watchdog diagnostics distinguish running and queued work: $lane transaction=$transaction",
  ({ lane, transaction }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "sql-watchdog-" });
      const filePath = directory + "/trace.ndjson";
      const records: TraceRecord[] = [];
      const tracer = yield* makeLocalFileTracer({
        filePath,
        maxBytes: 1_000_000,
        maxFiles: 1,
        batchWindowMs: 10,
        sink: {
          filePath,
          push: (record) => records.push(record),
          flush: Effect.void,
          close: () => Effect.void,
        },
      });
      const route = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        lane === "auth"
          ? effect.pipe(NodeSqliteClient.authReadOnly)
          : lane === "identity"
            ? effect.pipe(NodeSqliteClient.identityReadOnly)
            : effect.pipe(
                NodeSqliteClient.readOnly,
                lane === "foreground"
                  ? NodeSqliteClient.foregroundReads
                  : NodeSqliteClient.backgroundReads,
              );
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA journal_mode = WAL`;
        const slow = sql`WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ${80_000_000}) SELECT max(x), ${"watchdog-private-secret"} AS marker FROM c`;
        const queued = sql`SELECT ${"queued-private-secret"} AS queued_marker`;
        if (transaction)
          assert.isTrue(
            Exit.isFailure(
              yield* route(
                sql.withTransaction(Effect.all([slow, queued], { concurrency: "unbounded" })),
              ).pipe(Effect.exit),
            ),
          );
        else {
          assert.isTrue(Exit.isFailure(yield* route(slow).pipe(Effect.exit)));
          yield* route(queued).pipe(Effect.exit);
        }
      }).pipe(
        Effect.provide(
          NodeSqliteClient.layer({
            filename: directory + "/fixture.sqlite",
            readerWorker: true,
            authReaderProcess: true,
            identityReaderProcess: true,
            foregroundReaderSlots: 1,
            readerStatementLimit: "1500 millis",
            readerWedgeLimit: "3 seconds",
            statementMetrics: false,
          }),
        ),
        Effect.withTracer(tracer),
        Effect.provideService(Statement.SpanPropagationEnabled, true),
      );
      const slow = records.filter((record) =>
        String(record.attributes["db.query.text"]).includes("RECURSIVE"),
      );
      assert.lengthOf(slow, 1);
      const attributes = slow[0]!.attributes;
      assert.isAtLeast(Number(attributes["db.statement.execution_ms"]), 1_000);
      assert.equal(attributes["db.statement.execution_is_lower_bound"], true);
      assert.equal(attributes["db.rows_returned"], 0);
      assert.equal(attributes["db.stmt_status.available"], false);
      assert.equal(attributes["db.reader.lane"], lane);
      assert.isNumber(attributes["db.statement.connection_wait_ms"]);
      assert.lengthOf(
        slow[0]!.events.filter((event) => event.name === "sql.plan"),
        1,
      );
      const queued = records.filter((record) =>
        String(record.attributes["db.query.text"]).includes("queued_marker"),
      );
      assert.lengthOf(queued, 1);
      assert.isUndefined(queued[0]!.attributes["db.statement.execution_is_lower_bound"]);
      assert.isUndefined(queued[0]!.attributes["db.rows_returned"]);
      assert.lengthOf(
        queued[0]!.events.filter((event) => event.name === "sql.plan"),
        0,
      );
      assert.notInclude(JSON.stringify(records), "watchdog-private-secret");
      assert.notInclude(JSON.stringify(records), "queued-private-secret");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { timeout: 30_000 },
);

it.live.each(["db.statement.execution_ms", "db.statement.connection_wait_ms"])(
  "a failing %s exporter preserves SQL results",
  (attribute) =>
    Effect.gen(function* () {
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          const set = span.attribute.bind(span);
          span.attribute = (key, value) => {
            if (key === attribute) throw new Error("exporter failure");
            set(key, value);
          };
          return span;
        },
      });
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        assert.deepStrictEqual(yield* sql`SELECT ${"kept"} AS value`, [{ value: "kept" }]);
      }).pipe(
        Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
        Effect.withTracer(tracer),
        Effect.provideService(Statement.SpanPropagationEnabled, true),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live.each([
  "direct",
  "transaction",
  "service",
  "wrapped",
  "reason",
  "error",
  "nested",
  "cycle",
  "defect",
  "aggregate",
  "effect_cause",
  "defect_cause",
] as const)("SQL-originated failures stay private through %s spans", (form) =>
  Effect.gen(function* () {
    const records: TraceRecord[] = [];
    const delegates: Tracer.Span[] = [];
    const tracer = yield* makeLocalFileTracer({
      filePath: "unused",
      maxBytes: 1024,
      maxFiles: 1,
      batchWindowMs: 10,
      delegate: Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          delegates.push(span);
          return span;
        },
      }),
      sink: {
        filePath: "unused",
        push: (record) => {
          records.push(record);
        },
        flush: Effect.void,
        close: () => Effect.void,
      },
    });
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      let originalFailure: SqlError.SqlError | undefined;
      let query: Effect.Effect<
        unknown,
        | SqlError.SqlError
        | { _tag: string; cause?: unknown; reason?: unknown; error?: unknown }
        | AggregateError
      > = sql`SELECT json_extract('{}', ${"invalid-parent-secret-path"})`.pipe(
        Effect.tapError((error) =>
          Effect.sync(() => {
            originalFailure = error;
          }),
        ),
      );
      if (form === "transaction") query = sql.withTransaction(query);
      if (form === "service") query = query.pipe(Effect.withSpan("Fixture.service"));
      if (form === "wrapped")
        query = query.pipe(Effect.mapError((cause) => ({ _tag: "FixtureWrappedError", cause })));
      if (form === "reason")
        query = query.pipe(Effect.mapError((reason) => ({ _tag: "FixtureWrapper", reason })));
      if (form === "error")
        query = query.pipe(Effect.mapError((error) => ({ _tag: "FixtureWrapper", error })));
      if (form === "nested")
        query = query.pipe(
          Effect.mapError((error) => ({ _tag: "FixtureWrapper", cause: { reason: { error } } })),
        );
      if (form === "cycle")
        query = query.pipe(
          Effect.mapError((cause) => {
            const wrapper: { _tag: string; cause: unknown; error?: unknown } = {
              _tag: "FixtureWrapper",
              cause,
            };
            wrapper.error = wrapper;
            return wrapper;
          }),
        );
      if (form === "defect") query = query.pipe(Effect.orDie);
      if (form === "aggregate")
        query = query.pipe(
          Effect.mapError((cause) => new AggregateError([cause], "aggregate-private-message")),
        );
      if (form === "effect_cause" || form === "defect_cause") {
        if (form === "defect_cause") query = query.pipe(Effect.orDie);
        query = query.pipe(
          Effect.catchCause((cause) => Effect.fail({ _tag: "FixtureWrapper", cause })),
        );
      }
      const exit = yield* query.pipe(Effect.withSpan("Fixture.outer"), Effect.exit);
      assert.isTrue(Exit.isFailure(exit));
      if (originalFailure === undefined) throw new Error("Expected a SQL failure.");
      assert.include(Cause.pretty(Cause.fail(originalFailure)), "invalid-parent-secret-path");
    }).pipe(
      Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
      Effect.withTracer(tracer),
      Effect.provideService(Statement.SpanPropagationEnabled, true),
    );
    const causes = delegates.flatMap((span) =>
      span.status._tag === "Ended" && Exit.isFailure(span.status.exit)
        ? [Cause.pretty(span.status.exit.cause)]
        : [],
    );
    assert.notInclude(
      JSON.stringify(records) + JSON.stringify(causes),
      "invalid-parent-secret-path",
    );
    assert.notInclude(
      JSON.stringify(records) + JSON.stringify(causes),
      "aggregate-private-message",
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
