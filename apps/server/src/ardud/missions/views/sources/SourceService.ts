/**
 * Script-backed view sources. A source runs only while someone is looking
 * (a client subscribed to the mission's views, or a tool reading them) and
 * its rows are older than its refresh interval, or when the owner or master
 * asks for a run. The last good rows stay cached; a failed run only records
 * its error, so sections keep showing what they had.
 */
import {
  type MissionId,
  VIEW_SOURCE_LIMITS,
  type ViewDataSource,
  ViewNode,
  type ViewSection,
  type ViewSectionData,
  type ViewSectionRow,
  type ViewSourceRun,
  type ViewSourceRunResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../../../config.ts";
import { nodeBinds } from "../sectionRows.ts";
import { parseSourceOutput, type SourceRow } from "./rows.ts";
import { type ScriptResult, SourceRunner, sourceDir } from "./runner.ts";

const DDL = [
  `CREATE TABLE IF NOT EXISTS ardud_mission_view_source_cache (
    source_id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    ok_at TEXT,
    rows_json TEXT NOT NULL,
    row_count INTEGER NOT NULL,
    ran_at TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    error TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS ardud_mission_view_source_cache_mission
    ON ardud_mission_view_source_cache (mission_id)`,
  `CREATE TABLE IF NOT EXISTS ardud_mission_view_source_runs (
    source_id TEXT NOT NULL,
    mission_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    trigger TEXT NOT NULL,
    ran_at TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    ok INTEGER NOT NULL,
    row_count INTEGER NOT NULL,
    error TEXT,
    stderr TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ardud_mission_view_source_runs_source
    ON ardud_mission_view_source_runs (source_id, ran_at)`,
];

/** `watched`: stale while someone looked. `manual`: the owner's button or the master's tool. */
export type SourceTrigger = "watched" | "manual";

const ERROR_CHARS = 200;
const STDERR_CHARS = 2_000;
const RUN_LOG_KEEP = 50;
const PREVIEW_ROWS = 20;

interface CacheRow {
  readonly source_id: string;
  readonly version: number;
  readonly ok_at: string | null;
  readonly row_count: number;
  readonly ran_at: string;
  readonly duration_ms: number;
  readonly error: string | null;
}

interface Outcome {
  readonly ok: boolean;
  readonly rows: ReadonlyArray<SourceRow>;
  readonly errors: ReadonlyArray<string>;
  /** The one line a failed section shows. */
  readonly error: string | null;
}

const decodeNode = Schema.decodeUnknownOption(ViewNode);
const RowsJson = Schema.fromJsonString(Schema.Array(Schema.Record(Schema.String, Schema.Unknown)));
const decodeRows = Schema.decodeUnknownOption(RowsJson);
const encodeRows = Schema.encodeSync(RowsJson);

const cap = (text: string, chars = ERROR_CHARS) =>
  text.length > chars ? `${text.slice(0, chars - 1)}…` : text;

const firstLine = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "") ?? null;

const inlineLongText = (text: string) =>
  text.length > VIEW_SOURCE_LIMITS.inlineLongTextChars
    ? text.slice(0, VIEW_SOURCE_LIMITS.inlineLongTextChars)
    : text;

const outcomeOf = (result: ScriptResult, source: ViewDataSource): Outcome => {
  const failed = (problem: string, line: string = problem): Outcome => ({
    ok: false,
    rows: [],
    errors: [cap(problem)],
    error: cap(line),
  });
  if (result.spawnError !== null) {
    return failed(`couldn't start ${source.definition.runtime}: ${result.spawnError}`);
  }
  if (result.timedOut) return failed(`timed out after ${source.definition.timeoutSeconds}s`);
  if (result.overflow) return failed(`stdout passed ${VIEW_SOURCE_LIMITS.outputBytes} bytes`);
  if (result.exitCode !== 0) {
    const problem =
      result.exitCode === null ? "the script was killed" : `exited with code ${result.exitCode}`;
    return failed(problem, firstLine(result.stderr) ?? problem);
  }
  const parsed = parseSourceOutput(result.stdout, source.definition.fields);
  if (!parsed.ok) {
    return { ok: false, rows: [], errors: parsed.errors, error: cap(parsed.errors[0] ?? "") };
  }
  return { ok: true, rows: parsed.rows, errors: [], error: null };
};

const isStale = (source: ViewDataSource, cached: CacheRow | undefined, nowMs: number) =>
  cached === undefined ||
  Number(cached.version) !== source.version ||
  nowMs - Date.parse(cached.ran_at) >= source.definition.refreshMinutes * 60_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** What a stored value compares as: actors by name, links by label. */
const scalar = (value: unknown): string | number | null => {
  if (typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "boolean") return String(value);
  if (isRecord(value)) {
    if (typeof value.name === "string") return value.name;
    if (typeof value.label === "string") return value.label;
  }
  return null;
};

type SourceShape = Extract<ViewSection["definition"]["source"], { readonly _tag: "source" }>;

const matches = (row: Readonly<Record<string, unknown>>, where: SourceShape["where"]) =>
  Object.entries(where ?? {}).every(([field, want]) => {
    const have = scalar(row[field]);
    if (have === null) return false;
    if (Array.isArray(want)) return want.includes(String(have));
    return typeof want === "number" ? have === want : String(have) === want;
  });

const ordered = (
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
  sort: SourceShape["sort"],
) => {
  if (sort === undefined) return rows;
  const sign = sort.dir === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    const x = scalar(a[sort.field]);
    const y = scalar(b[sort.field]);
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
    if (typeof x === "number" && typeof y === "number") return sign * (x - y);
    const left = String(x);
    const right = String(y);
    return sign * (left < right ? -1 : left > right ? 1 : 0);
  });
};

/** The row paths a section body reads, so clients get only what they show. */
const boundPaths = (body: ReadonlyArray<unknown>) => {
  const paths = new Set<string>(["id"]);
  for (const raw of body) {
    const node = decodeNode(raw);
    if (Option.isNone(node)) continue;
    for (const bind of nodeBinds(node.value)) {
      if (bind.startsWith("row.")) paths.add(bind.slice(4));
    }
  }
  return paths;
};

export class SourceService extends Context.Service<
  SourceService,
  {
    /** Runs a source now (or joins the run already going) and waits for it. */
    readonly run: (
      source: ViewDataSource,
      trigger: SourceTrigger,
    ) => Effect.Effect<ViewSourceRunResult>;
    /** Someone is looking: starts runs for stale enabled sources without waiting. */
    readonly touch: (
      missionId: MissionId,
      sources: ReadonlyArray<ViewDataSource>,
    ) => Effect.Effect<void>;
    /** Like `touch`, but waits for the runs it started. */
    readonly refreshStale: (
      missionId: MissionId,
      sources: ReadonlyArray<ViewDataSource>,
    ) => Effect.Effect<void>;
    readonly runs: (
      missionId: MissionId,
      sources: ReadonlyArray<ViewDataSource>,
    ) => Effect.Effect<ReadonlyArray<ViewSourceRun>>;
    /**
     * Cached rows for the active sections bound to active, enabled sources.
     * With `deferLongText` a non-blank longtext stays off and is listed in the
     * row's `deferred`, for `longText` to load when its block opens. Without
     * it the value rides inline, cut to `inlineLongTextChars`.
     */
    readonly sectionData: (
      sections: ReadonlyArray<ViewSection>,
      sources: ReadonlyArray<ViewDataSource>,
      deferLongText: boolean,
    ) => Effect.Effect<ReadonlyArray<ViewSectionData>>;
    /** One row's longtext value from the last good run; null when the row or value is gone. */
    readonly longText: (
      sourceId: string,
      rowId: string,
      path: string,
    ) => Effect.Effect<string | null>;
    /** Mission ids, published when one of their runs starts or finishes. */
    readonly changes: Effect.Effect<PubSub.Subscription<MissionId>, never, Scope.Scope>;
  }
>()("t3/ardud/missions/views/sources/SourceService") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const runner = yield* SourceRunner;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const scope = yield* Effect.scope;
  yield* Effect.forEach(DDL, (statement) => sql.unsafe(statement), { discard: true }).pipe(
    Effect.orDie,
  );
  const permits = yield* Semaphore.make(VIEW_SOURCE_LIMITS.concurrentRuns);
  const changed = yield* PubSub.unbounded<MissionId>();
  const inflight = new Map<string, Deferred.Deferred<ViewSourceRunResult>>();
  const parsed = new Map<
    string,
    { readonly okAt: string; readonly rows: ReadonlyArray<Readonly<Record<string, unknown>>> }
  >();

  const cacheRows = (missionId: MissionId) =>
    sql<CacheRow>`
      SELECT source_id, version, ok_at, row_count, ran_at, duration_ms, error
      FROM ardud_mission_view_source_cache
      WHERE mission_id = ${missionId}
    `.pipe(Effect.orDie);

  const save = Effect.fn("SourceService.save")(
    function* (
      source: ViewDataSource,
      trigger: SourceTrigger,
      ranAt: string,
      durationMs: number,
      outcome: Outcome,
      stderr: string,
    ) {
      const row = {
        source_id: source.id,
        mission_id: source.missionId,
        version: source.version,
        ran_at: ranAt,
        duration_ms: durationMs,
      };
      if (outcome.ok) {
        yield* sql`
          INSERT INTO ardud_mission_view_source_cache ${sql.insert({
            ...row,
            ok_at: ranAt,
            rows_json: encodeRows(outcome.rows),
            row_count: outcome.rows.length,
            error: null,
          })}
          ON CONFLICT (source_id) DO UPDATE SET
            version = excluded.version,
            ok_at = excluded.ok_at,
            rows_json = excluded.rows_json,
            row_count = excluded.row_count,
            ran_at = excluded.ran_at,
            duration_ms = excluded.duration_ms,
            error = NULL
        `;
      } else {
        yield* sql`
          INSERT INTO ardud_mission_view_source_cache ${sql.insert({
            ...row,
            ok_at: null,
            rows_json: "[]",
            row_count: 0,
            error: outcome.error,
          })}
          ON CONFLICT (source_id) DO UPDATE SET
            version = excluded.version,
            ran_at = excluded.ran_at,
            duration_ms = excluded.duration_ms,
            error = excluded.error
        `;
      }
      yield* sql`
        INSERT INTO ardud_mission_view_source_runs ${sql.insert({
          ...row,
          trigger,
          ok: outcome.ok ? 1 : 0,
          row_count: outcome.rows.length,
          error: outcome.error,
          stderr,
        })}
      `;
      yield* sql`
        DELETE FROM ardud_mission_view_source_runs
        WHERE source_id = ${source.id} AND rowid NOT IN (
          SELECT rowid FROM ardud_mission_view_source_runs
          WHERE source_id = ${source.id}
          ORDER BY ran_at DESC
          LIMIT ${RUN_LOG_KEEP}
        )
      `;
    },
    sql.withTransaction,
    Effect.orDie,
  );

  const execute = Effect.fn("SourceService.execute")(function* (
    source: ViewDataSource,
    trigger: SourceTrigger,
  ) {
    const result = yield* runner.run({
      runtime: source.definition.runtime,
      code: source.definition.code,
      dir: sourceDir(stateDir, source.missionId, source.id),
      timeoutMs: source.definition.timeoutSeconds * 1000,
    });
    const ranAt = DateTime.formatIso(yield* DateTime.now);
    const durationMs = Math.max(0, Math.round(result.durationMs));
    const outcome = outcomeOf(result, source);
    const stderr = result.stderr.slice(-STDERR_CHARS);
    yield* save(source, trigger, ranAt, durationMs, outcome, stderr);
    if (outcome.ok) parsed.delete(source.id);
    else {
      yield* Effect.logWarning("missions: view source run failed", {
        missionId: source.missionId,
        sourceId: source.id,
        trigger,
        error: outcome.error,
      });
    }
    const runResult: ViewSourceRunResult = {
      sourceId: source.id,
      ok: outcome.ok,
      ranAt,
      durationMs,
      total: outcome.rows.length,
      rows: outcome.rows.slice(0, PREVIEW_ROWS),
      errors: outcome.errors.slice(0, PREVIEW_ROWS),
      stderr,
    };
    return runResult;
  });

  // Runs live in the service's scope so a caller that stops waiting (a closed
  // feed, a cancelled tool call) doesn't kill a run others may be joining.
  const start = Effect.fn("SourceService.start")(function* (
    source: ViewDataSource,
    trigger: SourceTrigger,
  ) {
    const going = inflight.get(source.id);
    if (going !== undefined) return going;
    const done = Deferred.makeUnsafe<ViewSourceRunResult>();
    inflight.set(source.id, done);
    yield* PubSub.publish(changed, source.missionId);
    yield* permits.withPermit(execute(source, trigger)).pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          inflight.delete(source.id);
          yield* Deferred.done(done, exit);
          yield* PubSub.publish(changed, source.missionId);
        }),
      ),
      Effect.forkIn(scope),
    );
    return done;
  });

  const due = Effect.fn("SourceService.due")(function* (
    missionId: MissionId,
    sources: ReadonlyArray<ViewDataSource>,
  ) {
    const candidates = sources.filter(
      (source) =>
        source.missionId === missionId &&
        source.status === "active" &&
        source.definition.enabled &&
        !inflight.has(source.id),
    );
    if (candidates.length === 0) return [];
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const cached = new Map((yield* cacheRows(missionId)).map((row) => [row.source_id, row]));
    return candidates.filter((source) => isStale(source, cached.get(source.id), nowMs));
  });

  const touch = (missionId: MissionId, sources: ReadonlyArray<ViewDataSource>) =>
    Effect.flatMap(due(missionId, sources), (stale) =>
      Effect.forEach(stale, (source) => start(source, "watched"), { discard: true }),
    );

  const refreshStale = Effect.fn("SourceService.refreshStale")(function* (
    missionId: MissionId,
    sources: ReadonlyArray<ViewDataSource>,
  ) {
    const stale = yield* due(missionId, sources);
    const started = yield* Effect.forEach(stale, (source) => start(source, "watched"));
    yield* Effect.forEach(started, (done) => Effect.ignore(Deferred.await(done)), {
      discard: true,
    });
  });

  const runs = (missionId: MissionId, sources: ReadonlyArray<ViewDataSource>) =>
    Effect.map(cacheRows(missionId), (rows) => {
      const cached = new Map(rows.map((row) => [row.source_id, row]));
      return sources.map((source): ViewSourceRun => {
        const row = cached.get(source.id);
        return {
          sourceId: source.id,
          okAt: row?.ok_at ?? null,
          rows: Number(row?.row_count ?? 0),
          ranAt: row?.ran_at ?? null,
          durationMs: row === undefined ? null : Number(row.duration_ms),
          error: row?.error ?? null,
          running: inflight.has(source.id),
        };
      });
    });

  const cachedRows = Effect.fn("SourceService.cachedRows")(function* (sourceId: string) {
    const head = yield* sql<{ readonly ok_at: string | null }>`
        SELECT ok_at FROM ardud_mission_view_source_cache WHERE source_id = ${sourceId}
      `.pipe(Effect.orDie);
    const okAt = head[0]?.ok_at ?? null;
    if (okAt === null) return [];
    const memo = parsed.get(sourceId);
    if (memo?.okAt === okAt) return memo.rows;
    const body = yield* sql<{ readonly rows_json: string }>`
        SELECT rows_json FROM ardud_mission_view_source_cache WHERE source_id = ${sourceId}
      `.pipe(Effect.orDie);
    const rows = Option.getOrElse(decodeRows(body[0]?.rows_json ?? "[]"), () => []);
    parsed.set(sourceId, { okAt, rows });
    return rows;
  });

  const sectionData = Effect.fn("SourceService.sectionData")(function* (
    sections: ReadonlyArray<ViewSection>,
    sources: ReadonlyArray<ViewDataSource>,
    deferLongText: boolean,
  ) {
    const live = new Map<string, ViewDataSource>();
    for (const source of sources) {
      if (source.status === "active" && source.definition.enabled) live.set(source.id, source);
    }
    const data: Array<ViewSectionData> = [];
    for (const section of sections) {
      const shape = section.definition.source;
      if (section.status !== "active" || shape._tag !== "source") continue;
      const source = live.get(shape.sourceId);
      if (source === undefined) continue;
      const fields = source.definition.fields;
      const paths = boundPaths(section.definition.body);
      const rows = ordered(
        (yield* cachedRows(source.id)).filter((row) => matches(row, shape.where)),
        shape.sort,
      );
      data.push({
        sectionId: section.id,
        rows: rows.slice(0, shape.limit).map((row): ViewSectionRow => {
          const value: Record<string, unknown> = {};
          const deferred: Array<string> = [];
          for (const path of paths) {
            if (!Object.hasOwn(row, path)) continue;
            const raw = row[path];
            const long = Object.hasOwn(fields, path) && fields[path] === "longtext";
            if (!long || typeof raw !== "string") value[path] = raw;
            else if (!deferLongText) value[path] = inlineLongText(raw);
            else if (raw.trim() === "") value[path] = null;
            else deferred.push(path);
          }
          const ref = { kind: "source-row", id: String(row.id) } as const;
          return deferred.length === 0 ? { ref, value } : { ref, value, deferred };
        }),
        total: rows.length,
      });
    }
    return data;
  });

  const longText = Effect.fn("SourceService.longText")(function* (
    sourceId: string,
    rowId: string,
    path: string,
  ) {
    const row = (yield* cachedRows(sourceId)).find((candidate) => String(candidate.id) === rowId);
    const value = row !== undefined && Object.hasOwn(row, path) ? row[path] : undefined;
    return typeof value === "string" ? value : null;
  });

  return SourceService.of({
    run: (source, trigger) => Effect.flatMap(start(source, trigger), Deferred.await),
    touch,
    refreshStale,
    runs,
    sectionData,
    longText,
    changes: PubSub.subscribe(changed),
  });
});

export const layer = Layer.effect(SourceService, make);
