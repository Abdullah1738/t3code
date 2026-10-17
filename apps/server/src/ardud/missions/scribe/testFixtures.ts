/** Shared fixtures for the scribe tests: a mission, one lane and its transcript rows. */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { MissionId, type Lane, type Mission, type RoleBinding } from "@t3tools/contracts";

import { MissionStore } from "../store/MissionStore.ts";
import type { MissionStoreRecord } from "../store/recordIndex.ts";
import { toJson } from "./ScribeStore.ts";

export const MISSION_ID = "mission-crpko";
export const LANE_THREAD = "thread-lane-money";
export const MASTER_THREAD = "thread-master";

export const mission = {
  id: MISSION_ID,
  slug: "crpko",
  title: "Crpko launch",
  goal: "Ship the exchange",
  status: "active",
  tier: "P0",
  weight: 1,
  guaranteedShare: 0.5,
  borrowCeiling: 0.8,
  projectId: null,
  masterRoleId: "role-master",
  focusSubMissionId: null,
  health: "green",
  lockedFields: [],
  createdAt: "2026-10-17T00:00:00.000Z",
  updatedAt: "2026-10-17T00:00:00.000Z",
} as unknown as Mission;

export const lane = {
  id: "lane-money",
  missionId: MISSION_ID,
  subMissionId: null,
  name: "Money",
  purpose: "Rewards and balances",
  status: "working",
  statusReason: null,
  leadRoleId: null,
  threadId: LANE_THREAD,
  currentItemId: null,
  lastEvidence: null,
  context: null,
  lastActiveAt: null,
  createdAt: "2026-10-17T01:00:00.000Z",
  updatedAt: "2026-10-17T01:00:00.000Z",
} as unknown as Lane;

export const masterBinding = {
  id: "binding-master",
  roleId: "role-master",
  threadId: MASTER_THREAD,
  reason: "initial",
  handoffNote: null,
  observedModel: null,
  boundAt: "2026-10-17T00:00:00.000Z",
  endedAt: null,
} as unknown as RoleBinding;

/** Writes one record into core's store under a plain system event. */
export const putRecord = (record: MissionStoreRecord, at = "2026-10-17T00:00:00.000Z") =>
  Effect.gen(function* () {
    const store = yield* MissionStore;
    return yield* store.upsert(record, {
      missionId: MissionId.make(MISSION_ID),
      kind: "import.applied",
      actor: { _tag: "system", component: "test" },
      provenance: { _tag: "system", component: "test" },
      summary: `seed ${record._tag}`,
      subject: null,
      at,
    });
  });

/** Seeds the mission, lane and master binding into the record store. */
export const seedMission = Effect.gen(function* () {
  yield* putRecord({ _tag: "mission", record: mission });
  yield* putRecord({ _tag: "lane", record: lane });
  yield* putRecord({ _tag: "role-binding", record: masterBinding });
});

const filled = (
  columns: ReadonlyArray<{ readonly name: string; readonly notnull: number }>,
  values: Record<string, unknown>,
) => {
  const out = { ...values };
  for (const column of columns) {
    if (column.notnull === 1 && !(column.name in out)) out[column.name] = "x";
  }
  return out;
};

export interface FixtureItem {
  readonly ordinal: number;
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

/** Writes one run of turn items (plus the thread row) into Robob's projection tables. */
export const seedTranscript = (input: {
  readonly threadId: string;
  readonly run: number;
  readonly requestedAt: string;
  readonly items: ReadonlyArray<FixtureItem>;
  readonly threadPayload?: Record<string, unknown>;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const info = (table: string) =>
      sql<{ readonly name: string; readonly notnull: number }>`
        SELECT name, "notnull" FROM pragma_table_info(${table})
      `;
    const runColumns = yield* info("orchestration_v2_projection_runs");
    const itemColumns = yield* info("orchestration_v2_projection_turn_items");
    const threadColumns = yield* info("orchestration_v2_projection_threads");
    const runId = `${input.threadId}-run-${input.run}`;
    yield* sql`
      INSERT INTO orchestration_v2_projection_threads ${sql.insert(
        filled(threadColumns, {
          thread_id: input.threadId,
          created_at: input.requestedAt,
          updated_at: input.requestedAt,
          payload_json: toJson(input.threadPayload ?? {}),
        }),
      )}
      ON CONFLICT (thread_id) DO UPDATE SET payload_json = excluded.payload_json
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs ${sql.insert(
        filled(runColumns, {
          run_id: runId,
          thread_id: input.threadId,
          ordinal: input.run,
          status: "completed",
          requested_at: input.requestedAt,
          payload_json: "{}",
        }),
      )}
    `;
    for (const item of input.items) {
      yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items ${sql.insert(
          filled(itemColumns, {
            turn_item_id: `${runId}-${item.ordinal}`,
            thread_id: input.threadId,
            run_id: runId,
            ordinal: item.ordinal,
            type: item.type,
            status: "completed",
            updated_at: input.requestedAt,
            payload_json: toJson({ ...item.payload, completedAt: input.requestedAt }),
          }),
        )}
      `;
    }
  });
