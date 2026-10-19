import { MissionId, type RecoveryIncident } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as RecoveryStore from "./RecoveryStore.ts";
import { plus } from "./testkit.ts";

const crpko = MissionId.make("m-crpko");
const juno = MissionId.make("m-juno");

const incidentAt = (
  id: string,
  seconds: number,
  missionIds: ReadonlyArray<MissionId>,
): RecoveryIncident => ({
  id,
  cause: "server-restart",
  source: "missions-recovery",
  detectedAt: plus(seconds),
  windowStart: plus(seconds - 60),
  windowEnd: plus(seconds),
  downSeconds: 60,
  missionIds,
  threads: [],
  clearedAt: null,
});

const ids = (incidents: ReadonlyArray<RecoveryIncident>) =>
  incidents.map((incident) => incident.id);

/** A fresh store over the database, as a server start makes one. */
const withStore = <A, E, R>(
  body: (store: RecoveryStore.RecoveryStore["Service"]) => Effect.Effect<A, E, R>,
) => Effect.flatMap(RecoveryStore.RecoveryStore, body).pipe(Effect.provide(RecoveryStore.layer));

it.effect("a mission's incidents come from its own rows, not a scan of every incident", () =>
  withStore((store) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* store.saveIncident(incidentAt("rcv-1", 10, [crpko]), plus(10));
      yield* store.saveIncident(incidentAt("rcv-2", 20, [juno]), plus(20));
      yield* store.saveIncident(incidentAt("rcv-3", 30, [crpko, juno]), plus(30));
      // A row nobody can parse, for another mission. Reading through every
      // incident's JSON would trip on it.
      yield* sql`
        INSERT INTO ardud_mission_recovery_incidents
          (incident_id, cause, detected_at, cleared_at, incident_json, updated_at)
        VALUES ('rcv-broken', 'server-restart', ${plus(40)}, NULL, '{not json', ${plus(40)})
      `;

      assert.deepStrictEqual(ids(yield* store.incidentsOf(crpko)), ["rcv-3", "rcv-1"]);
      assert.deepStrictEqual(ids(yield* store.incidentsOf(juno)), ["rcv-3", "rcv-2"]);

      // Re-saving an incident moves it to the missions it touches now.
      yield* store.saveIncident(incidentAt("rcv-3", 30, [juno]), plus(50));
      assert.deepStrictEqual(ids(yield* store.incidentsOf(crpko)), ["rcv-1"]);
    }),
  ).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("incidents saved before the index existed are indexed at start", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // The table as an earlier build left it: incidents, no index rows.
    yield* sql`
      CREATE TABLE ardud_mission_recovery_incidents (
        incident_id TEXT PRIMARY KEY,
        cause TEXT NOT NULL,
        detected_at TEXT NOT NULL,
        cleared_at TEXT,
        incident_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `;
    for (const incident of [
      incidentAt("rcv-old-1", 10, [crpko]),
      incidentAt("rcv-old-2", 20, [crpko, juno]),
    ]) {
      yield* sql`
        INSERT INTO ardud_mission_recovery_incidents
          (incident_id, cause, detected_at, cleared_at, incident_json, updated_at)
        VALUES (${incident.id}, ${incident.cause}, ${incident.detectedAt}, NULL,
          ${JSON.stringify(incident)}, ${incident.detectedAt})
      `;
    }
    yield* sql`
      INSERT INTO ardud_mission_recovery_incidents
        (incident_id, cause, detected_at, cleared_at, incident_json, updated_at)
      VALUES ('rcv-broken', 'server-restart', ${plus(5)}, NULL, '{not json', ${plus(5)})
    `;

    yield* withStore((store) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(ids(yield* store.incidentsOf(crpko)), ["rcv-old-2", "rcv-old-1"]);
        assert.deepStrictEqual(ids(yield* store.incidentsOf(juno)), ["rcv-old-2"]);
      }),
    );
    // A second start adds nothing twice.
    yield* withStore((store) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(ids(yield* store.incidentsOf(crpko)), ["rcv-old-2", "rcv-old-1"]);
      }),
    );
  }).pipe(Effect.provide(Layer.fresh(Sqlite.layerMemory))),
);
