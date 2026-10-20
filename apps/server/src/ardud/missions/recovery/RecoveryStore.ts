// Recovery's own tables (boots, incidents, seen cuts, settings, notices, boot chains) plus
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
  // Which missions each incident touched, so a mission's incident list reads
  // its own rows instead of every incident's JSON. Written with the incident.
  `CREATE TABLE IF NOT EXISTS ardud_mission_recovery_incident_missions (
    incident_id TEXT NOT NULL,
    mission_id TEXT NOT NULL,
    detected_at TEXT NOT NULL,
    PRIMARY KEY (incident_id, mission_id)
  )`,
  `CREATE INDEX IF NOT EXISTS ardud_mission_recovery_incident_missions_by_mission
    ON ardud_mission_recovery_incident_missions (mission_id, detected_at)`,
  // Incidents saved before the index existed.
  `INSERT OR IGNORE INTO ardud_mission_recovery_incident_missions (incident_id, mission_id, detected_at)
    SELECT incident.incident_id, touched.value, incident.detected_at
    FROM (
      SELECT incident_id, incident_json, detected_at FROM ardud_mission_recovery_incidents AS saved
      WHERE json_valid(saved.incident_json) AND NOT EXISTS (
        SELECT 1 FROM ardud_mission_recovery_incident_missions AS indexed
        WHERE indexed.incident_id = saved.incident_id
      )
    ) AS incident,
      json_each(incident.incident_json, '$.missionIds') AS touched`,
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
  // One row per notice (incident, mission and thread): claimed before the
  // router is asked, settled with the notice-sent event. A claim left
  // unsettled means the outcome is unknown, so nothing re-sends it on its own.
  // `attempt` counts sends a human asked for after that; each has its own key.
  `CREATE TABLE IF NOT EXISTS ardud_mission_recovery_notices (
    notice_key TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL,
    mission_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    state TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 0,
    outcome_json TEXT,
    updated_at TEXT NOT NULL
  )`,
  // The latest boot cut per thread, how many boots in a row cut that turn, and
  // the boot that counted it (a boot counts once, whichever path saw it first).
  `CREATE TABLE IF NOT EXISTS ardud_mission_recovery_chains (
    thread_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    cuts INTEGER NOT NULL,
    boot_id TEXT NOT NULL,
    incident_id TEXT,
    updated_at TEXT NOT NULL
  )`,
];

const BOOTS_KEPT = 20;
const RECENT_INCIDENTS = 50;
const MISSION_INCIDENTS = 50;
const ITEMS_PER_RUN = 12;
const IN_CHUNK = 400;

const decodeIncident = Schema.decodeUnknownEffect(Schema.fromJsonString(RecoveryIncident));
const encodeIncident = Schema.encodeEffect(Schema.fromJsonString(RecoveryIncident));
const decodeSettings = Schema.decodeUnknownOption(Schema.fromJsonString(MissionRecoverySettings));
const encodeSettings = Schema.encodeSync(Schema.fromJsonString(MissionRecoverySettings));
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
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

/** Where one notice got to. */
export interface NoticeClaim {
  /**
   * `open`: nothing went out, it may be sent. `sending`: the router was asked
   * and no outcome was recorded. `sent`: delivered.
   */
  readonly state: "open" | "sending" | "sent";
  /** Sends a human asked for after an unconfirmed one; 0 for the first send. */
  readonly attempt: number;
}

/** Boots in a row that cut a thread's turn, as of its latest boot cut. */
export interface BootChain {
  readonly threadId: string;
  readonly runId: string;
  readonly ordinal: number;
  readonly cuts: number;
  /** The boot that last counted it. */
  readonly bootId: string;
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
    // --- policy additions ---
    /** Incidents that touched the mission, newest first (the latest MISSION_INCIDENTS). */
    readonly incidentsOf: (missionId: MissionId) => Effect.Effect<ReadonlyArray<RecoveryIncident>>;
    // --- end policy additions ---

    readonly settings: (missionId: MissionId) => Effect.Effect<MissionRecoverySettings | null>;
    readonly saveSettings: (settings: MissionRecoverySettings, at: string) => Effect.Effect<void>;

    readonly noticeClaim: (key: string) => Effect.Effect<NoticeClaim | null>;
    /** Records that the notice is about to go out (before the router is asked). */
    readonly claimNotice: (input: {
      readonly key: string;
      readonly incidentId: string;
      readonly missionId: string;
      readonly threadId: string;
      readonly at: string;
    }) => Effect.Effect<void>;
    /** Marks it delivered, as soon as the router says so. */
    readonly settleNotice: (key: string, outcome: unknown, at: string) => Effect.Effect<void>;
    /** The router refused it: nothing went out, a later round may send it. */
    readonly unclaimNotice: (key: string, at: string) => Effect.Effect<void>;
    /** A human sends again after an unknown outcome: the next attempt gets its own key. */
    readonly reopenNotices: (keys: ReadonlyArray<string>, at: string) => Effect.Effect<void>;
    /** Runs recovery's own writes as one transaction. */
    readonly atomic: <A>(effect: Effect.Effect<A>) => Effect.Effect<A>;

    readonly chains: (
      threadIds: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyMap<string, BootChain>>;
    /** Run inside the incident's first commit (or with its seen keys). */
    readonly saveChains: (
      chains: ReadonlyArray<BootChain>,
      incidentId: string | null,
      at: string,
    ) => Effect.Effect<void>;
    /** The highest ordinal of a run of the thread that completed, below `before`. */
    readonly lastCompleted: (threadId: string, before: number) => Effect.Effect<number | null>;

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
      yield* sql`
        DELETE FROM ardud_mission_recovery_incident_missions WHERE incident_id = ${incident.id}
      `;
      yield* Effect.forEach(
        [...new Set(incident.missionIds)],
        (missionId) => sql`
          INSERT INTO ardud_mission_recovery_incident_missions ${sql.insert({
            incident_id: incident.id,
            mission_id: missionId,
            detected_at: incident.detectedAt,
          })}
        `,
        { discard: true },
      );
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

  const incidentsOf = (missionId: MissionId) =>
    read(
      sql<{ readonly incident_json: string }>`
        SELECT incident.incident_json FROM ardud_mission_recovery_incident_missions AS touched
        JOIN ardud_mission_recovery_incidents AS incident
          ON incident.incident_id = touched.incident_id
        WHERE touched.mission_id = ${missionId}
        ORDER BY touched.detected_at DESC LIMIT ${MISSION_INCIDENTS}
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

  const noticeClaim = (key: string) =>
    read(
      sql<{ readonly state: string; readonly attempt: number }>`
        SELECT state, attempt FROM ardud_mission_recovery_notices
        WHERE notice_key = ${key}
      `,
    ).pipe(
      Effect.map((rows): NoticeClaim | null => {
        const row = rows[0];
        if (row === undefined) return null;
        const state = row.state === "sent" || row.state === "open" ? row.state : "sending";
        return { state, attempt: Number(row.attempt) };
      }),
    );

  const claimNotice = (input: {
    readonly key: string;
    readonly incidentId: string;
    readonly missionId: string;
    readonly threadId: string;
    readonly at: string;
  }) =>
    sql`
      INSERT INTO ardud_mission_recovery_notices ${sql.insert({
        notice_key: input.key,
        incident_id: input.incidentId,
        mission_id: input.missionId,
        thread_id: input.threadId,
        state: "sending",
        outcome_json: null,
        updated_at: input.at,
      })}
      ON CONFLICT (notice_key) DO UPDATE SET
        state = 'sending', updated_at = excluded.updated_at
      WHERE ardud_mission_recovery_notices.state = 'open'
    `.pipe(Effect.asVoid, Effect.orDie);

  const settleNotice = (key: string, outcome: unknown, at: string) =>
    sql`
      UPDATE ardud_mission_recovery_notices
      SET state = 'sent', outcome_json = ${Option.getOrNull(encodeJson(outcome))}, updated_at = ${at}
      WHERE notice_key = ${key}
    `.pipe(Effect.asVoid, Effect.orDie);

  const unclaimNotice = (key: string, at: string) =>
    sql`
      UPDATE ardud_mission_recovery_notices SET state = 'open', updated_at = ${at}
      WHERE notice_key = ${key} AND state = 'sending'
    `.pipe(Effect.asVoid, Effect.orDie);

  const reopenNotices = (keys: ReadonlyArray<string>, at: string) =>
    Effect.forEach(
      chunks(keys),
      (chunk) => sql`
        UPDATE ardud_mission_recovery_notices
        SET state = 'open', attempt = attempt + 1, updated_at = ${at}
        WHERE notice_key IN ${sql.in(chunk)} AND state = 'sending'
      `,
      { discard: true },
    ).pipe(Effect.orDie);

  const atomic = <A>(effect: Effect.Effect<A>) => sql.withTransaction(effect).pipe(Effect.orDie);

  const chains = (threadIds: ReadonlyArray<string>) =>
    Effect.forEach(chunks(threadIds), (chunk) =>
      read(
        sql<{
          readonly thread_id: string;
          readonly run_id: string;
          readonly ordinal: number;
          readonly cuts: number;
          readonly boot_id: string;
        }>`
          SELECT thread_id, run_id, ordinal, cuts, boot_id FROM ardud_mission_recovery_chains
          WHERE thread_id IN ${sql.in(chunk)}
        `,
      ),
    ).pipe(
      Effect.map(
        (rows) =>
          new Map(
            rows.flat().map((row): [string, BootChain] => [
              row.thread_id,
              {
                threadId: row.thread_id,
                runId: row.run_id,
                ordinal: Number(row.ordinal),
                cuts: Number(row.cuts),
                bootId: row.boot_id,
              },
            ]),
          ),
      ),
    );

  const saveChains = (entries: ReadonlyArray<BootChain>, incidentId: string | null, at: string) =>
    Effect.forEach(
      entries,
      (entry) =>
        entry.cuts === 0
          ? sql`DELETE FROM ardud_mission_recovery_chains WHERE thread_id = ${entry.threadId}`
          : sql`
              INSERT INTO ardud_mission_recovery_chains ${sql.insert({
                thread_id: entry.threadId,
                run_id: entry.runId,
                ordinal: entry.ordinal,
                cuts: entry.cuts,
                boot_id: entry.bootId,
                incident_id: incidentId,
                updated_at: at,
              })}
              ON CONFLICT (thread_id) DO UPDATE SET
                run_id = excluded.run_id,
                ordinal = excluded.ordinal,
                cuts = excluded.cuts,
                boot_id = excluded.boot_id,
                incident_id = excluded.incident_id,
                updated_at = excluded.updated_at
            `,
      { discard: true },
    ).pipe(Effect.orDie);

  const lastCompleted = (threadId: string, before: number) =>
    read(
      sql<{ readonly ordinal: number | null }>`
        SELECT MAX(ordinal) AS ordinal FROM orchestration_v2_projection_runs
        WHERE thread_id = ${threadId} AND status = 'completed' AND ordinal < ${before}
      `,
    ).pipe(Effect.map((rows) => rows[0]?.ordinal ?? null));

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
    incidentsOf,
    settings,
    saveSettings,
    noticeClaim,
    claimNotice,
    settleNotice,
    unclaimNotice,
    reopenNotices,
    atomic,
    chains,
    saveChains,
    lastCompleted,
    cutRuns,
    cutRunsById,
    children,
    threads,
    interruptCounts,
  });
});

export const layer = Layer.effect(RecoveryStore, make);
