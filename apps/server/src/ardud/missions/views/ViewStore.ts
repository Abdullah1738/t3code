import {
  DEFAULT_STARTER_LAYOUT,
  MissionAsset,
  MissionError,
  ViewLayout,
  ViewSection,
  ViewStarterLayout,
  ViewTemplate,
  ViewDataSource,
  type MissionId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Views keep their own tables instead of core's record table: definitions
 * carry full version history, and the starter layout has no mission. Every
 * write runs as the `alongside` of a MissionStore commit, so a view change
 * and its timeline event land together or not at all.
 *
 * `current` holds the latest version of each template, section, mission
 * layout and the starter; `versions` holds every version ever written.
 * Never add these to persistence/Migrations.ts (upstream owns that list).
 */
const DDL = [
  `CREATE TABLE IF NOT EXISTS ardud_mission_views_current (
    scope TEXT NOT NULL,
    id TEXT NOT NULL,
    mission_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    status TEXT NOT NULL,
    value_json TEXT NOT NULL,
    changed_at TEXT NOT NULL,
    PRIMARY KEY (scope, id)
  )`,
  `CREATE INDEX IF NOT EXISTS ardud_mission_views_current_mission
    ON ardud_mission_views_current (mission_id, scope)`,
  `CREATE TABLE IF NOT EXISTS ardud_mission_views_versions (
    scope TEXT NOT NULL,
    id TEXT NOT NULL,
    mission_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    status TEXT NOT NULL,
    value_json TEXT NOT NULL,
    changed_at TEXT NOT NULL,
    counts INTEGER NOT NULL,
    metered_mission TEXT,
    PRIMARY KEY (scope, id, version)
  )`,
  `CREATE INDEX IF NOT EXISTS ardud_mission_views_versions_mission
    ON ardud_mission_views_versions (mission_id, changed_at)`,
  `CREATE INDEX IF NOT EXISTS ardud_mission_views_versions_metered
    ON ardud_mission_views_versions (metered_mission, changed_at)`,
];

export type ViewScope = "template" | "section" | "layout" | "starter" | "asset" | "source";

/** The starter layout's row id and mission. */
export const STARTER_ID = "starter";
export const STARTER_MISSION = "missions-global";

const invalid = (detail: string) => new MissionError({ code: "invalid", detail });

const templateCodec = Schema.fromJsonString(ViewTemplate);
const sectionCodec = Schema.fromJsonString(ViewSection);
const layoutCodec = Schema.fromJsonString(ViewLayout);
const starterCodec = Schema.fromJsonString(ViewStarterLayout);
const decodeTemplate = Schema.decodeUnknownEffect(templateCodec);
const decodeSection = Schema.decodeUnknownEffect(sectionCodec);
const decodeLayout = Schema.decodeUnknownEffect(layoutCodec);
const decodeStarter = Schema.decodeUnknownEffect(starterCodec);
const encodeTemplate = Schema.encodeEffect(templateCodec);
const encodeSection = Schema.encodeEffect(sectionCodec);
const encodeLayout = Schema.encodeEffect(layoutCodec);
const encodeStarter = Schema.encodeEffect(starterCodec);
const assetCodec = Schema.fromJsonString(MissionAsset);
const decodeAsset = Schema.decodeUnknownEffect(assetCodec);
const encodeAsset = Schema.encodeEffect(assetCodec);
const sourceCodec = Schema.fromJsonString(ViewDataSource);
const decodeSource = Schema.decodeUnknownEffect(sourceCodec);
const encodeSource = Schema.encodeEffect(sourceCodec);

export type ViewWrite =
  | { readonly scope: "template"; readonly value: ViewTemplate }
  | { readonly scope: "section"; readonly value: ViewSection }
  | { readonly scope: "layout"; readonly value: ViewLayout }
  | { readonly scope: "starter"; readonly value: ViewStarterLayout }
  | { readonly scope: "asset"; readonly value: MissionAsset }
  | { readonly scope: "source"; readonly value: ViewDataSource };

export interface WriteOptions {
  /**
   * Whether the version counts toward the mission's daily change budget and
   * revision. Seeds (a mission's first layout, the built-in starter) don't.
   */
  readonly counts: boolean;
  /**
   * The mission whose daily change budget this version spends: set for the
   * master's changes (to its mission, starter edits included), null for the
   * owner and for seeds.
   */
  readonly meteredMission: MissionId | null;
}

export class ViewStore extends Context.Service<
  ViewStore,
  {
    readonly templates: (
      missionId: MissionId,
    ) => Effect.Effect<ReadonlyArray<ViewTemplate>, MissionError>;
    readonly sections: (
      missionId: MissionId,
    ) => Effect.Effect<ReadonlyArray<ViewSection>, MissionError>;
    readonly layout: (missionId: MissionId) => Effect.Effect<ViewLayout | null, MissionError>;
    /** Every stored starter version, oldest first (empty until the first edit). */
    readonly starters: Effect.Effect<ReadonlyArray<ViewStarterLayout>, MissionError>;
    readonly templateVersions: (
      id: string,
    ) => Effect.Effect<ReadonlyArray<ViewTemplate>, MissionError>;
    readonly sectionVersions: (
      id: string,
    ) => Effect.Effect<ReadonlyArray<ViewSection>, MissionError>;
    readonly layoutVersions: (
      missionId: MissionId,
    ) => Effect.Effect<ReadonlyArray<ViewLayout>, MissionError>;
    /** Every asset record of the mission, any status. */
    readonly assets: (
      missionId: MissionId,
    ) => Effect.Effect<ReadonlyArray<MissionAsset>, MissionError>;
    /** Every source of the mission, removed ones included. */
    readonly sources: (
      missionId: MissionId,
    ) => Effect.Effect<ReadonlyArray<ViewDataSource>, MissionError>;
    readonly sourceVersions: (
      id: string,
    ) => Effect.Effect<ReadonlyArray<ViewDataSource>, MissionError>;
    /** Writes the current row and appends the version. Fails on a version already written. */
    readonly write: (write: ViewWrite, options: WriteOptions) => Effect.Effect<void, MissionError>;
    /** Versions that spent the mission's change budget since `since` (ISO). */
    readonly changesSince: (missionId: MissionId, since: string) => Effect.Effect<number>;
    /** Counted versions for the mission plus counted starter versions. */
    readonly revision: (missionId: MissionId) => Effect.Effect<number>;
    /**
     * Answered owner requests not yet settled. Router owns the record
     * (`owner-request`, stored in core's record table); views read it by
     * kind string only.
     */
    readonly requestsAnswered: (missionId: MissionId) => Effect.Effect<number>;
  }
>()("t3/ardud/missions/views/ViewStore") {}

interface ValueRow {
  readonly valueJson: string;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* Effect.forEach(DDL, (statement) => sql.unsafe(statement), { discard: true }).pipe(
    Effect.orDie,
  );

  const decodeAll = <A>(
    rows: ReadonlyArray<ValueRow>,
    decode: (json: string) => Effect.Effect<A, Schema.SchemaError>,
    what: string,
  ) =>
    Effect.forEach(rows, (row) =>
      decode(row.valueJson).pipe(
        Effect.mapError(() => invalid(`A stored ${what} does not match the views contract.`)),
      ),
    );

  const currentRows = (scope: ViewScope, missionId: string) =>
    sql<ValueRow>`
      SELECT value_json AS "valueJson" FROM ardud_mission_views_current
      WHERE scope = ${scope} AND mission_id = ${missionId}
      ORDER BY id
    `.pipe(Effect.orDie);

  const versionRows = (scope: ViewScope, id: string) =>
    sql<ValueRow>`
      SELECT value_json AS "valueJson" FROM ardud_mission_views_versions
      WHERE scope = ${scope} AND id = ${id}
      ORDER BY version
    `.pipe(Effect.orDie);

  const templates = (missionId: MissionId) =>
    Effect.flatMap(currentRows("template", missionId), (rows) =>
      decodeAll(rows, decodeTemplate, "card template"),
    );
  const sections = (missionId: MissionId) =>
    Effect.flatMap(currentRows("section", missionId), (rows) =>
      decodeAll(rows, decodeSection, "section"),
    );
  const layout = (missionId: MissionId) =>
    Effect.gen(function* () {
      const rows = yield* sql<ValueRow>`
        SELECT value_json AS "valueJson" FROM ardud_mission_views_current
        WHERE scope = 'layout' AND id = ${missionId}
      `.pipe(Effect.orDie);
      const [layout] = yield* decodeAll(rows, decodeLayout, "mission layout");
      return layout ?? null;
    });
  const starters = Effect.flatMap(versionRows("starter", STARTER_ID), (rows) =>
    decodeAll(rows, decodeStarter, "starter layout"),
  );

  const encodeWrite = (write: ViewWrite) => {
    switch (write.scope) {
      case "template":
        return encodeTemplate(write.value).pipe(
          Effect.map((json) => ({
            id: write.value.id as string,
            missionId: write.value.missionId as string,
            status: write.value.status as string,
            json,
          })),
        );
      case "section":
        return encodeSection(write.value).pipe(
          Effect.map((json) => ({
            id: write.value.id as string,
            missionId: write.value.missionId as string,
            status: write.value.status as string,
            json,
          })),
        );
      case "layout":
        return encodeLayout(write.value).pipe(
          Effect.map((json) => ({
            id: write.value.missionId as string,
            missionId: write.value.missionId as string,
            status: "active",
            json,
          })),
        );
      case "starter":
        return encodeStarter(write.value).pipe(
          Effect.map((json) => ({
            id: STARTER_ID,
            missionId: STARTER_MISSION,
            status: "active",
            json,
          })),
        );
      case "asset":
        return encodeAsset(write.value).pipe(
          Effect.map((json) => ({
            id: write.value.id as string,
            missionId: write.value.missionId as string,
            status: write.value.status as string,
            json,
          })),
        );
      case "source":
        return encodeSource(write.value).pipe(
          Effect.map((json) => ({
            id: write.value.id as string,
            missionId: write.value.missionId as string,
            status: write.value.status as string,
            json,
          })),
        );
    }
  };

  const write = (input: ViewWrite, options: WriteOptions) =>
    Effect.gen(function* () {
      const row = yield* encodeWrite(input).pipe(
        Effect.mapError(() => invalid("A view record does not match the views contract.")),
      );
      const version = input.value.version;
      const changedAt = input.value.changedAt;
      const owner = yield* sql<{ readonly mission_id: string }>`
        SELECT mission_id FROM ardud_mission_views_current
        WHERE scope = ${input.scope} AND id = ${row.id}
      `.pipe(Effect.orDie);
      const ownerMission = owner[0]?.mission_id;
      if (ownerMission !== undefined && ownerMission !== row.missionId) {
        return yield* new MissionError({
          code: "conflict",
          detail: `The id ${row.id} belongs to another mission's view.`,
        });
      }
      const taken = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM ardud_mission_views_versions
        WHERE scope = ${input.scope} AND id = ${row.id} AND version = ${version}
      `.pipe(Effect.orDie);
      if (Number(taken[0]?.n ?? 0) > 0) {
        return yield* new MissionError({
          code: "conflict",
          detail: "Someone else changed this view first.",
        });
      }
      yield* sql`
        INSERT INTO ardud_mission_views_versions ${sql.insert({
          scope: input.scope,
          id: row.id,
          mission_id: row.missionId,
          version,
          status: row.status,
          value_json: row.json,
          changed_at: changedAt,
          counts: options.counts ? 1 : 0,
          metered_mission: options.meteredMission,
        })}
      `.pipe(Effect.orDie);
      yield* sql`
        INSERT INTO ardud_mission_views_current ${sql.insert({
          scope: input.scope,
          id: row.id,
          mission_id: row.missionId,
          version,
          status: row.status,
          value_json: row.json,
          changed_at: changedAt,
        })}
        ON CONFLICT (scope, id) DO UPDATE SET
          version = excluded.version,
          status = excluded.status,
          value_json = excluded.value_json,
          changed_at = excluded.changed_at
      `.pipe(Effect.orDie);
    }).pipe(sql.withTransaction, Effect.catchTags({ SqlError: (cause) => Effect.die(cause) }));

  const count = (rows: ReadonlyArray<{ readonly n: number }>) => Number(rows[0]?.n ?? 0);

  const changesSince = (missionId: MissionId, since: string) =>
    sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM ardud_mission_views_versions
      WHERE metered_mission = ${missionId} AND changed_at >= ${since}
    `.pipe(Effect.map(count), Effect.orDie);

  const revision = (missionId: MissionId) =>
    sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM ardud_mission_views_versions
      WHERE counts = 1 AND (mission_id = ${missionId} OR scope = 'starter')
    `.pipe(Effect.map(count), Effect.orDie);

  const requestsAnswered = (missionId: MissionId) =>
    sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM ardud_mission_records
      WHERE kind = 'owner-request' AND mission_id = ${missionId}
        AND json_extract(record_json, '$.record.unreadForOwner') = 1
        AND json_extract(record_json, '$.record.subject') IS NULL -- ardud missions: router
    `.pipe(Effect.map(count), Effect.orDie);

  return ViewStore.of({
    templates,
    sections,
    layout,
    starters,
    templateVersions: (id) =>
      Effect.flatMap(versionRows("template", id), (rows) =>
        decodeAll(rows, decodeTemplate, "card template"),
      ),
    sectionVersions: (id) =>
      Effect.flatMap(versionRows("section", id), (rows) =>
        decodeAll(rows, decodeSection, "section"),
      ),
    layoutVersions: (missionId) =>
      Effect.flatMap(versionRows("layout", missionId), (rows) =>
        decodeAll(rows, decodeLayout, "mission layout"),
      ),
    assets: (missionId) =>
      Effect.flatMap(currentRows("asset", missionId), (rows) =>
        decodeAll(rows, decodeAsset, "mission asset"),
      ),
    sources: (missionId) =>
      Effect.flatMap(currentRows("source", missionId), (rows) =>
        decodeAll(rows, decodeSource, "view source"),
      ),
    sourceVersions: (id) =>
      Effect.flatMap(versionRows("source", id), (rows) =>
        decodeAll(rows, decodeSource, "view source"),
      ),
    write,
    changesSince,
    revision,
    requestsAnswered,
  });
});

export const layer = Layer.effect(ViewStore, make);

/** The starter in force: the latest stored version, or the built-in recommendation. */
export const currentStarter = (stored: ReadonlyArray<ViewStarterLayout>): ViewStarterLayout =>
  stored.at(-1) ?? DEFAULT_STARTER_LAYOUT;

/** Every starter version, with the built-in v1 first when it was never stored. */
export const starterHistory = (
  stored: ReadonlyArray<ViewStarterLayout>,
): ReadonlyArray<ViewStarterLayout> =>
  stored.some((starter) => starter.version === DEFAULT_STARTER_LAYOUT.version)
    ? stored
    : [DEFAULT_STARTER_LAYOUT, ...stored];

/** The starter a mission created at `createdAt` started from. */
export const starterAt = (
  stored: ReadonlyArray<ViewStarterLayout>,
  createdAt: string,
): ViewStarterLayout => {
  const history = starterHistory(stored);
  const before = history.filter((starter) => starter.changedAt <= createdAt);
  return before.at(-1) ?? history[0] ?? DEFAULT_STARTER_LAYOUT;
};
