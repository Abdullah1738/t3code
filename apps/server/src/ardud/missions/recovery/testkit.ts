// Shared fixtures for the mission recovery tests: a fake delivery port and
// rows in Robob's projection tables.
import {
  LaneId,
  type MissionError,
  RoleBindingId,
  SubMissionId,
  ThreadId,
  type Lane,
  type MissionProvenance,
  type RoleBinding,
  type SubMission,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as Sqlite from "../../../persistence/Sqlite.ts";
import {
  at,
  binding,
  lane,
  masterThread,
  mission,
  missionId,
  role,
} from "../asks/AsksService.testkit.ts";
import * as MissionService from "../MissionService.ts";
import * as PolicyService from "../policy/PolicyService.ts";
import * as PolicyStore from "../policy/PolicyStore.ts";
import { makePorts } from "../policy/testing.ts";
import { fakeRouterThreads, routerOverFakes } from "../router/MissionRouter.testkit.ts";
import * as MissionStore from "../store/MissionStore.ts";
import type { MissionStoreRecord } from "../store/recordIndex.ts";
import * as RecoveryDelivery from "./RecoveryDelivery.ts";
import * as RecoveryService from "./RecoveryService.ts";
import * as RecoveryStore from "./RecoveryStore.ts";

export const T0 = Date.parse(at);
/** ISO time `seconds` after T0 (08:00:00Z). */
export const plus = (seconds: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(T0 + seconds * 1000));

export const webThread = ThreadId.make("t-web");
export const docsThread = ThreadId.make("t-docs");
export const test: MissionProvenance = { _tag: "system", component: "test" };

export const webLane: Lane = {
  ...lane,
  id: LaneId.make("lane-web"),
  name: "Web",
  status: "idle",
  threadId: webThread,
};
export const docsLane: Lane = {
  ...lane,
  id: LaneId.make("lane-docs"),
  name: "Docs",
  status: "waiting",
  statusReason: "waiting on ask ask-7: Which docs host?",
  threadId: docsThread,
};

export const subMission = (id: string, order: number): SubMission => ({
  id: SubMissionId.make(id),
  missionId,
  title: id,
  intent: "",
  order,
  fillIdleCapacity: false,
  status: "active",
  coordinatorRoleId: null,
  intendedEffort: null,
  actualEffort: null,
  health: "unknown",
  lockedFields: [],
  createdAt: at,
  updatedAt: at,
});

export const handoff = (
  id: string,
  roleId: string,
  threadId: ThreadId,
  over: Partial<RoleBinding>,
): RoleBinding => ({ ...binding(id, roleId, threadId), id: RoleBindingId.make(id), ...over });

export interface Sent {
  readonly threadId: string;
  readonly text: string;
  readonly key: string;
  /** Queued behind a running turn instead of rung. */
  readonly queue: boolean;
}

/**
 * A recovery service over an in-memory database with a fake delivery port;
 * `withPolicy` builds the policy service (pools and holds) next to it.
 */
export const harness = (
  options: {
    readonly withPolicy?: boolean;
    /** A stand-in policy service, e.g. one whose hold expiry fails. */
    readonly policy?: Layer.Layer<PolicyService.PolicyService>;
  } = {},
) => {
  const fake = {
    sent: [] as Array<Sent>,
    busy: new Set<string>(),
    gone: new Set<string>(),
    installer: false,
    /** Threads whose notices the router refuses, with the error it gives. */
    refuse: new Map<string, MissionError>(),
    /** Threads whose notice goes out, then the server stops before the router answers. */
    crash: new Set<string>(),
    /** Times recovery said its boot pass was done. */
    bootPasses: 0,
  };
  const delivery = Layer.succeed(
    RecoveryDelivery.RecoveryDelivery,
    RecoveryDelivery.RecoveryDelivery.of({
      readiness: (threadId) =>
        Effect.sync(() =>
          fake.gone.has(threadId) ? "gone" : fake.busy.has(threadId) ? "busy" : "idle",
        ),
      notify: (input) =>
        Effect.gen(function* () {
          const refusal = fake.refuse.get(input.threadId);
          if (refusal !== undefined) return yield* refusal;
          fake.sent.push(input);
          if (fake.crash.delete(input.threadId)) return yield* Effect.die("server stopped");
          return { _tag: "sent" as const };
        }),
      installerPending: Effect.sync(() => fake.installer),
      bootPassDone: Effect.sync(() => {
        fake.bootPasses += 1;
      }),
      timeZone: "UTC",
    }),
  );
  const policy =
    options.policy ??
    (options.withPolicy
      ? PolicyService.layer.pipe(
          Layer.provideMerge(Layer.mergeAll(PolicyStore.layer, makePorts().layer)),
        )
      : Layer.empty);
  const layer = RecoveryService.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(RecoveryStore.layer, delivery, policy)),
    Layer.provideMerge(MissionService.layer),
    Layer.provideMerge(MissionStore.layer),
    Layer.provideMerge(Sqlite.layerMemory),
  );
  return { fake, layer };
};

/** The recovery service over its live delivery: the router, over fake threads. */
export const routedHarness = () => {
  const threads = fakeRouterThreads();
  const layer = RecoveryService.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        RecoveryStore.layer,
        RecoveryDelivery.layerWith({ installerPending: Effect.succeed(false), timeZone: "UTC" }),
      ),
    ),
    Layer.provideMerge(routerOverFakes(threads)),
    Layer.provideMerge(MissionService.layer),
    Layer.provideMerge(MissionStore.layer),
    Layer.provideMerge(Sqlite.layerMemory),
  );
  return { threads, layer };
};

const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** Inserts one row, filling NOT NULL columns the test does not care about. */
export const insert = (table: string, values: Record<string, unknown>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
      SELECT name, "notnull" FROM pragma_table_info(${table})
    `;
    const row: Record<string, unknown> = { ...values };
    for (const column of columns) {
      if (column.notnull === 1 && !(column.name in row)) row[column.name] = "x";
    }
    yield* sql`INSERT INTO ${sql(table)} ${sql.insert(row)}`;
  }).pipe(Effect.orDie);

export const threadRow = (threadId: string, title: string) =>
  insert("orchestration_v2_projection_threads", {
    thread_id: threadId,
    title,
    created_at: at,
    updated_at: at,
    payload_json: "{}",
  });

export const runRow = (input: {
  readonly threadId: string;
  readonly ordinal: number;
  readonly status: string;
  readonly completedAt: string | null;
  readonly started?: boolean;
  readonly continuationOf?: string;
}) =>
  insert("orchestration_v2_projection_runs", {
    run_id: `${input.threadId}-run-${input.ordinal}`,
    thread_id: input.threadId,
    ordinal: input.ordinal,
    status: input.status,
    requested_at: at,
    completed_at: input.completedAt,
    payload_json: toJson({
      ...(input.started === false ? {} : { startedAt: at }),
      ...(input.continuationOf === undefined
        ? {}
        : { restartContinuationOfRunId: input.continuationOf }),
    }),
  });

export const itemRow = (
  runId: string,
  threadId: string,
  ordinal: number,
  type: string,
  status: string,
  payload: Record<string, unknown>,
) =>
  insert("orchestration_v2_projection_turn_items", {
    turn_item_id: `${runId}-${ordinal}`,
    thread_id: threadId,
    run_id: runId,
    ordinal,
    type,
    status,
    updated_at: at,
    payload_json: toJson(payload),
  });

export const childRow = (input: {
  readonly id: string;
  readonly threadId: string;
  readonly runId: string;
  readonly status: string;
  readonly title: string;
  readonly completedAt: string | null;
  readonly session?: string;
  readonly delegated?: boolean;
}) =>
  insert("orchestration_v2_projection_subagents", {
    subagent_id: input.id,
    thread_id: input.threadId,
    run_id: input.runId,
    parent_node_id: "node-root",
    provider: "opencode",
    provider_thread_id:
      input.session === undefined ? null : `opencode:native-thread:${input.session}`,
    child_thread_id: input.delegated === true ? `child-${input.id}` : null,
    origin: input.delegated === true ? "app_owned" : "provider_native",
    status: input.status,
    started_at: at,
    completed_at: input.completedAt,
    updated_at: input.completedAt ?? at,
    payload_json: toJson({ title: input.title, prompt: `${input.title}, please.` }),
  });

/** The previous server's boot row, as if it last beat at `lastBeatAt`. */
export const previousBoot = (lastBeatAt: string) =>
  insert("ardud_mission_recovery_boots", {
    boot_id: "boot-previous",
    pid: 1,
    started_at: plus(-3600),
    last_beat_at: lastBeatAt,
  });

export const seed = (records: ReadonlyArray<MissionStoreRecord>) =>
  Effect.gen(function* () {
    const store = yield* MissionStore.MissionStore;
    yield* store.commit({
      event: {
        missionId,
        kind: "mission.created",
        actor: { _tag: "system", component: "test" },
        provenance: test,
        summary: "seed",
        subject: null,
      },
      upserts: records,
    });
  });

/** Mission m-1 with a master and the given lanes, plus thread rows for all of them. */
export const world = (
  input: {
    readonly mission?: typeof mission;
    readonly lanes?: ReadonlyArray<Lane>;
    readonly extra?: ReadonlyArray<MissionStoreRecord>;
  } = {},
) =>
  Effect.gen(function* () {
    const lanes = input.lanes ?? [lane, webLane, docsLane];
    yield* seed([
      { _tag: "mission", record: input.mission ?? mission },
      { _tag: "role", record: role("role-master", "master") },
      { _tag: "role-binding", record: binding("b-master", "role-master", masterThread) },
      ...lanes.map((entry): MissionStoreRecord => ({ _tag: "lane", record: entry })),
      ...(input.extra ?? []),
    ]);
    yield* threadRow(masterThread, "Master");
    for (const entry of lanes) {
      if (entry.threadId !== null) yield* threadRow(entry.threadId, `Lane ${entry.name}`);
    }
    // The recovery reader feeds the overview, as the production layer does.
    const missions = yield* MissionService.MissionService;
    const recovery = yield* RecoveryService.RecoveryService;
    yield* missions.registerRecovery({ state: recovery.state });
  });

/** Boots this server at the current test time and runs boot detection 45s later. */
export const boot = Effect.gen(function* () {
  const recovery = yield* RecoveryService.RecoveryService;
  yield* recovery.beat;
  yield* TestClock.adjust("45 seconds");
  return yield* recovery.detectBoot;
});
