// Recovery's own tables (boots, incidents, seen cuts, settings) plus
// read-only reads of Robob's orchestration projections. Fork tables are
// created idempotently at layer start, never in persistence/Migrations.ts.
import {
  MissionRecoverySettings,
  PoolHold,
  RecoveryIncident,
  type MissionId,
  type ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { ChildFacts, CutItem, CutRun } from "./model.ts";

const DDL = [
  `CREATE TABLE IF NOT EXISTS ardud_mission_recovery_boots (
    boot_id TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    last_beat_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ardud_mission_recovery_incidents (
    incident_id TEXT PRIMARY KEY,
    cause TEXT NOT NULL,
    detected_at TEXT NOT NULL,
    cleared_at TEXT,
    incident_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ardud_mission_recovery_incidents_by_time
    ON ardud_mission_recovery_incidents (detected_at)`,
  `CREATE TABLE IF NOT EXISTS ardud_mission_recovery_seen (
    seen_key TEXT PRIMARY KEY,
    incident_id TEXT,
    thread_id TEXT NOT NULL,
    seen_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ardud_mission_recovery_settings (
    mission_id TEXT PRIMARY KEY,
    settings_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
];

const BOOTS_KEPT = 20;
const RECENT_INCIDENTS = 50;
const ITEMS_PER_RUN = 12;
const IN_CHUNK = 400;

const decodeIncident = Schema.decodeUnknownEffect(Schema.fromJsonString(RecoveryIncident));
const encodeIncident = Schema.encodeEffect(Schema.fromJsonString(RecoveryIncident));
const decodeSettings = Schema.decodeUnknownOption(Schema.fromJsonString(MissionRecoverySettings));
const encodeSettings = Schema.encodeSync(Schema.fromJsonString(MissionRecoverySettings));
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const decodeHold = Schema.decodeUnknownOption(Schema.fromJsonString(PoolHold));

/** Turn items that say nothing about what the run was doing. */
const QUIET_ITEMS = [
  "run_interrupt_request",
  "run_interrupt_result",
  "system_notice",
  "error",
  "checkpoint",
  "compaction",
  "handoff",
  "thread_created",
  "todo_list",
];

export interface BootInfo {
  readonly bootId: string;
  readonly startedAt: string;
  /** The previous boot's last heartbeat; null on the first boot ever. */
  readonly previousBeatAt: string | null;
  readonly previousStartedAt: string | null;
}

/** A cut member run, plus what the projections say about how it ended. */
export interface CutRunRow extends CutRun {
  readonly errorMessage: string | null;
  /** Robob's own restart continuation already started a turn for this run. */
  readonly serverContinued: boolean;
}

export interface ThreadRow {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly gone: boolean;
}

interface RunRow {
  readonly run_id: string;
  readonly thread_id: string;
  readonly ordinal: number;
  readonly status: string;
  readonly completed_at: string | null;
  readonly interrupt_message: string | null;
  readonly error_message: string | null;
  readonly continued: number;
  readonly server_continued: number;
}

interface ItemRow {
  readonly run_id: string;
  readonly type: string;
  readonly status: string;
  readonly payload_json: string;
}

const textOfItem = (type: string, payloadJson: string): string | null => {
  const decoded = decodeJson(payloadJson);
  if (Option.isNone(decoded) || typeof decoded.value !== "object" || decoded.value === null) {
    return null;
  }
  const payload = decoded.value as Record<string, unknown>;
  const str = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);
  switch (type) {
    case "command_execution":
      return str(payload.input);
    case "dynamic_tool": {
      const name = str(payload.toolName);
      const input = payload.input === undefined ? "" : JSON.stringify(payload.input).slice(0, 200);
      return name === null ? null : `${name} ${input}`.trim();
    }
    case "subagent":
      return str(payload.title) ?? str(payload.prompt);
    default:
      return str(payload.title);
  }
};

const chunks = <A>(values: ReadonlyArray<A>) => {
  const out: Array<ReadonlyArray<A>> = [];
  for (let index = 0; index < values.length; index += IN_CHUNK) {
    out.push(values.slice(index, index + IN_CHUNK));
  }
  return out;
};

export class RecoveryStore extends Context.Service<
  RecoveryStore,
  {
    /** Records this boot and returns what the previous one left behind. */
    readonly recordBoot: (input: {
      readonly bootId: string;
      readonly pid: number;
      readonly at: string;
    }) => Effect.Effect<BootInfo>;
    readonly beat: (bootId: string, at: string) => Effect.Effect<void>;

    readonly seenKeys: (keys: ReadonlyArray<string>) => Effect.Effect<ReadonlySet<string>>;
    /** Run inside a mission commit's `alongside`. */
    readonly markSeen: (
      entries: ReadonlyArray<{ readonly key: string; readonly threadId: string }>,
      incidentId: string | null,
      at: string,
    ) => Effect.Effect<void>;

    readonly saveIncident: (incident: RecoveryIncident, at: string) => Effect.Effect<void>;
    readonly incident: (id: string) => Effect.Effect<RecoveryIncident | null>;
    readonly openIncidents: Effect.Effect<ReadonlyArray<RecoveryIncident>>;
    /** Newest first. */
    readonly recentIncidents: Effect.Effect<ReadonlyArray<RecoveryIncident>>;

    readonly settings: (missionId: MissionId) => Effect.Effect<MissionRecoverySettings | null>;
    readonly saveSettings: (settings: MissionRecoverySettings, at: string) => Effect.Effect<void>;

    // Read-only projection reads.
    readonly cutRuns: (input: {
      readonly threadIds: ReadonlyArray<string>;
      readonly from: string;
      readonly to: string;
    }) => Effect.Effect<ReadonlyArray<CutRunRow>>;
    readonly cutRunsById: (
      runIds: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<CutRunRow>>;
    readonly children: (input: {
      readonly threadIds: ReadonlyArray<string>;
      readonly since: string;
    }) => Effect.Effect<ReadonlyArray<ChildFacts>>;
    readonly threads: (threadIds: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<ThreadRow>>;
    /** Open holds from the policy track's own table, when it exists. */
    readonly policyHolds: (
      missionIds: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<PoolHold>>;
    /** Incident ids that already claimed these seen keys. */
    readonly seenIncidents: (keys: ReadonlyArray<string>) => Effect.Effect<ReadonlySet<string>>;
    /** Cancelled, failed or interrupted runs per thread since a time. */
    readonly interruptCounts: (input: {
      readonly threadIds: ReadonlyArray<string>;
      readonly since: string;
    }) => Effect.Effect<ReadonlyMap<string, number>>;
  }
>()("t3/ardud/missions/recovery/RecoveryStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* Effect.forEach(DDL, (statement) => sql.unsafe(statement), { discard: true }).pipe(
    Effect.orDie,
  );

  const read = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(NodeSqliteClient.readOnly, Effect.orDie);

  const recordBoot = (input: {
    readonly bootId: string;
    readonly pid: number;
    readonly at: string;
  }) =>
    Effect.gen(function* () {
      const previous = yield* sql<{ readonly started_at: string; readonly last_beat_at: string }>`
        SELECT started_at, last_beat_at FROM ardud_mission_recovery_boots
        WHERE boot_id <> ${input.bootId}
        ORDER BY last_beat_at DESC LIMIT 1
      `;
      yield* sql`
        INSERT INTO ardud_mission_recovery_boots ${sql.insert({
          boot_id: input.bootId,
          pid: input.pid,
          started_at: input.at,
          last_beat_at: input.at,
        })}
        ON CONFLICT (boot_id) DO UPDATE SET last_beat_at = excluded.last_beat_at
      `;
      yield* sql`
        DELETE FROM ardud_mission_recovery_boots WHERE boot_id NOT IN (
          SELECT boot_id FROM ardud_mission_recovery_boots ORDER BY last_beat_at DESC LIMIT ${BOOTS_KEPT}
        )
      `;
      return {
        bootId: input.bootId,
        startedAt: input.at,
        previousBeatAt: previous[0]?.last_beat_at ?? null,
        previousStartedAt: previous[0]?.started_at ?? null,
      } satisfies BootInfo;
    }).pipe(Effect.orDie);

  const beat = (bootId: string, at: string) =>
    sql`UPDATE ardud_mission_recovery_boots SET last_beat_at = ${at} WHERE boot_id = ${bootId}`.pipe(
      Effect.asVoid,
      Effect.orDie,
    );

  const seenKeys = (keys: ReadonlyArray<string>) =>
    Effect.forEach(chunks(keys), (chunk) =>
      read(
        sql<{ readonly seen_key: string }>`
          SELECT seen_key FROM ardud_mission_recovery_seen WHERE seen_key IN ${sql.in(chunk)}
        `,
      ),
    ).pipe(Effect.map((rows) => new Set(rows.flat().map((row) => row.seen_key))));

  const markSeen = (
    entries: ReadonlyArray<{ readonly key: string; readonly threadId: string }>,
    incidentId: string | null,
    at: string,
  ) =>
    Effect.forEach(
      entries,
      (entry) => sql`
        INSERT INTO ardud_mission_recovery_seen ${sql.insert({
          seen_key: entry.key,
          incident_id: incidentId,
          thread_id: entry.threadId,
          seen_at: at,
        })}
        ON CONFLICT (seen_key) DO NOTHING
      `,
      { discard: true },
    ).pipe(Effect.orDie);

  const saveIncident = (incident: RecoveryIncident, at: string) =>
    Effect.gen(function* () {
      const json = yield* encodeIncident(incident);
      yield* sql`
        INSERT INTO ardud_mission_recovery_incidents ${sql.insert({
          incident_id: incident.id,
          cause: incident.cause,
          detected_at: incident.detectedAt,
          cleared_at: incident.clearedAt,
          incident_json: json,
          updated_at: at,
        })}
        ON CONFLICT (incident_id) DO UPDATE SET
          cause = excluded.cause,
          cleared_at = excluded.cleared_at,
          incident_json = excluded.incident_json,
          updated_at = excluded.updated_at
      `;
    }).pipe(Effect.orDie);

  const decodeRows = (rows: ReadonlyArray<{ readonly incident_json: string }>) =>
    Effect.forEach(rows, (row) => decodeIncident(row.incident_json).pipe(Effect.option)).pipe(
      Effect.map((decoded) =>
        decoded.flatMap((entry) => (Option.isSome(entry) ? [entry.value] : [])),
      ),
    );

  const incident = (id: string) =>
    read(
      sql<{ readonly incident_json: string }>`
        SELECT incident_json FROM ardud_mission_recovery_incidents WHERE incident_id = ${id}
      `,
    ).pipe(
      Effect.flatMap(decodeRows),
      Effect.map((rows) => rows[0] ?? null),
    );

  const openIncidents = read(
    sql<{ readonly incident_json: string }>`
      SELECT incident_json FROM ardud_mission_recovery_incidents
      WHERE cleared_at IS NULL ORDER BY detected_at
    `,
  ).pipe(Effect.flatMap(decodeRows));

  const recentIncidents = read(
    sql<{ readonly incident_json: string }>`
      SELECT incident_json FROM ardud_mission_recovery_incidents
      ORDER BY detected_at DESC LIMIT ${RECENT_INCIDENTS}
    `,
  ).pipe(Effect.flatMap(decodeRows));

  const settings = (missionId: MissionId) =>
    read(
      sql<{ readonly settings_json: string }>`
        SELECT settings_json FROM ardud_mission_recovery_settings WHERE mission_id = ${missionId}
      `,
    ).pipe(
      Effect.map((rows) => {
        const row = rows[0];
        if (row === undefined) return null;
        return Option.getOrNull(decodeSettings(row.settings_json));
      }),
    );

  const saveSettings = (next: MissionRecoverySettings, at: string) =>
    sql`
      INSERT INTO ardud_mission_recovery_settings ${sql.insert({
        mission_id: next.missionId,
        settings_json: encodeSettings(next),
        updated_at: at,
      })}
      ON CONFLICT (mission_id) DO UPDATE SET
        settings_json = excluded.settings_json,
        updated_at = excluded.updated_at
    `.pipe(Effect.asVoid, Effect.orDie);

  const itemsFor = (runIds: ReadonlyArray<string>) =>
    Effect.forEach(runIds, (runId) =>
      read(
        sql<ItemRow>`
          SELECT run_id, type, status, payload_json
          FROM orchestration_v2_projection_turn_items
          WHERE run_id = ${runId} AND type NOT IN ${sql.in(QUIET_ITEMS)}
          ORDER BY ordinal DESC LIMIT ${ITEMS_PER_RUN}
        `,
      ),
    ).pipe(
      Effect.map((perRun) => {
        const byRun = new Map<string, Array<CutItem>>();
        for (const rows of perRun) {
          for (const row of rows.toReversed()) {
            const list = byRun.get(row.run_id) ?? [];
            list.push({
              type: row.type,
              status: row.status,
              text: textOfItem(row.type, row.payload_json),
            });
            byRun.set(row.run_id, list);
          }
        }
        return byRun;
      }),
    );

  const toCutRuns = (rows: ReadonlyArray<RunRow>) =>
    itemsFor(rows.map((row) => row.run_id)).pipe(
      Effect.map((items) =>
        rows.map((row): CutRunRow => ({
          runId: row.run_id,
          threadId: row.thread_id as ThreadId,
          ordinal: row.ordinal,
          status: row.status,
          completedAt: row.completed_at,
          interruptMessage: row.interrupt_message,
          errorMessage: row.error_message,
          continued: row.continued === 1,
          serverContinued: row.server_continued === 1,
          items: items.get(row.run_id) ?? [],
        })),
      ),
    );

  const runColumns = sql`
    r.run_id, r.thread_id, r.ordinal, r.status, r.completed_at,
    (SELECT json_extract(i.payload_json, '$.message') FROM orchestration_v2_projection_turn_items i
      WHERE i.run_id = r.run_id AND i.type = 'run_interrupt_request'
      ORDER BY i.ordinal DESC LIMIT 1) AS interrupt_message,
    (SELECT json_extract(i.payload_json, '$.failure.message') FROM orchestration_v2_projection_turn_items i
      WHERE i.run_id = r.run_id AND i.type = 'error'
      ORDER BY i.ordinal DESC LIMIT 1) AS error_message,
    EXISTS (SELECT 1 FROM orchestration_v2_projection_runs l
      WHERE l.thread_id = r.thread_id AND l.ordinal > r.ordinal
        AND json_extract(l.payload_json, '$.startedAt') IS NOT NULL) AS continued,
    EXISTS (SELECT 1 FROM orchestration_v2_projection_runs l
      WHERE l.thread_id = r.thread_id
        AND json_extract(l.payload_json, '$.restartContinuationOfRunId') = r.run_id) AS server_continued
  `;

  const cutRuns = (input: {
    readonly threadIds: ReadonlyArray<string>;
    readonly from: string;
    readonly to: string;
  }) =>
    Effect.forEach(chunks(input.threadIds), (chunk) =>
      read(
        sql<RunRow>`
          SELECT ${runColumns}
          FROM orchestration_v2_projection_runs r
          WHERE r.thread_id IN ${sql.in(chunk)}
            AND r.status IN ('cancelled', 'failed', 'interrupted')
            AND r.completed_at >= ${input.from} AND r.completed_at <= ${input.to}
            AND (r.status = 'failed' OR json_extract(r.payload_json, '$.startedAt') IS NOT NULL)
          ORDER BY r.completed_at
        `,
      ),
    ).pipe(Effect.flatMap((rows) => toCutRuns(rows.flat())));

  const cutRunsById = (runIds: ReadonlyArray<string>) =>
    Effect.forEach(chunks(runIds), (chunk) =>
      read(
        sql<RunRow>`
          SELECT ${runColumns}
          FROM orchestration_v2_projection_runs r
          WHERE r.run_id IN ${sql.in(chunk)}
            AND r.status IN ('cancelled', 'failed', 'interrupted')
        `,
      ),
    ).pipe(Effect.flatMap((rows) => toCutRuns(rows.flat())));

  const children = (input: { readonly threadIds: ReadonlyArray<string>; readonly since: string }) =>
    Effect.forEach(chunks(input.threadIds), (chunk) =>
      read(
        sql<{
          readonly subagent_id: string;
          readonly thread_id: string;
          readonly run_id: string | null;
          readonly origin: string;
          readonly status: string;
          readonly provider_thread_id: string | null;
          readonly child_thread_id: string | null;
          readonly completed_at: string | null;
          readonly title: string | null;
          readonly prompt: string | null;
          readonly progress: string | null;
        }>`
          SELECT subagent_id, thread_id, run_id, origin, status, provider_thread_id,
            child_thread_id, completed_at,
            json_extract(payload_json, '$.title') AS title,
            substr(json_extract(payload_json, '$.prompt'), 1, 400) AS prompt,
            substr(json_extract(payload_json, '$.progress'), 1, 400) AS progress
          FROM orchestration_v2_projection_subagents
          WHERE thread_id IN ${sql.in(chunk)}
            AND (status IN ('pending', 'running', 'waiting') OR completed_at >= ${input.since})
          ORDER BY started_at, subagent_id
        `,
      ),
    ).pipe(
      Effect.map((rows) =>
        rows.flat().map((row): ChildFacts => ({
          id: row.subagent_id,
          threadId: row.thread_id as ThreadId,
          runId: row.run_id,
          origin: row.origin,
          status: row.status,
          title: row.title,
          prompt: row.prompt,
          progress: row.progress,
          providerThreadId: row.provider_thread_id,
          childThreadId: row.child_thread_id,
          completedAt: row.completed_at,
        })),
      ),
    );

  const threads = (threadIds: ReadonlyArray<string>) =>
    Effect.forEach(chunks(threadIds), (chunk) =>
      read(
        sql<{
          readonly thread_id: string;
          readonly title: string;
          readonly archived_at: string | null;
          readonly deleted_at: string | null;
        }>`
          SELECT thread_id, title, archived_at, deleted_at
          FROM orchestration_v2_projection_threads
          WHERE thread_id IN ${sql.in(chunk)}
        `,
      ),
    ).pipe(
      Effect.map((rows) =>
        rows.flat().map((row): ThreadRow => ({
          threadId: row.thread_id as ThreadId,
          title: row.title,
          gone: row.archived_at !== null || row.deleted_at !== null,
        })),
      ),
    );

  const interruptCounts = (input: {
    readonly threadIds: ReadonlyArray<string>;
    readonly since: string;
  }) =>
    Effect.forEach(chunks(input.threadIds), (chunk) =>
      read(
        sql<{ readonly thread_id: string; readonly n: number }>`
          SELECT thread_id, COUNT(*) AS n FROM orchestration_v2_projection_runs
          WHERE thread_id IN ${sql.in(chunk)}
            AND status IN ('cancelled', 'failed', 'interrupted')
            AND completed_at >= ${input.since}
          GROUP BY thread_id
        `,
      ),
    ).pipe(Effect.map((rows) => new Map(rows.flat().map((row) => [row.thread_id, row.n]))));

  const policyHolds = (missionIds: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      if (missionIds.length === 0) return [];
      const table = yield* read(
        sql<{ readonly name: string }>`
          SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ardud_mission_pool_holds'
        `,
      );
      if (table.length === 0) return [];
      const rows = yield* read(
        sql<{ readonly hold_json: string }>`
          SELECT hold_json FROM ardud_mission_pool_holds
          WHERE mission_id IN ${sql.in(missionIds)}
            AND status IN ('queued', 'active', 'reconcile-required')
        `,
      );
      return rows.flatMap((row) => {
        const decoded = decodeHold(row.hold_json);
        return Option.isSome(decoded) ? [decoded.value] : [];
      });
    });

  const seenIncidents = (keys: ReadonlyArray<string>) =>
    Effect.forEach(chunks(keys), (chunk) =>
      read(
        sql<{ readonly incident_id: string | null }>`
          SELECT DISTINCT incident_id FROM ardud_mission_recovery_seen
          WHERE seen_key IN ${sql.in(chunk)} AND incident_id IS NOT NULL
        `,
      ),
    ).pipe(
      Effect.map(
        (rows) =>
          new Set(
            rows.flat().flatMap((row) => (row.incident_id === null ? [] : [row.incident_id])),
          ),
      ),
    );

  return RecoveryStore.of({
    policyHolds,
    seenIncidents,
    recordBoot,
    beat,
    seenKeys,
    markSeen,
    saveIncident,
    incident,
    openIncidents,
    recentIncidents,
    settings,
    saveSettings,
    cutRuns,
    cutRunsById,
    children,
    threads,
    interruptCounts,
  });
});

export const layer = Layer.effect(RecoveryStore, make);
