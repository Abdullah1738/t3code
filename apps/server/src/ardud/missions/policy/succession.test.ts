import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import {
  RoleId,
  ScheduledTaskUpsertInput,
  ThreadId,
  type MissionProvenance,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadLaunchService from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../../../scheduling/Scheduler.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import { authorityStore } from "../guard/authority.ts";
import {
  added,
  free,
  lane,
  makeDelivered,
  master,
  membershipGuard,
  outsider,
  recordingThreads,
} from "../guard/guard.testkit.ts";
import type { GuardPrincipal } from "../guard/principal.ts";
import * as MissionService from "../MissionService.ts";
import { OPUS_XHIGH } from "./models.ts";
import * as PolicyService from "./PolicyService.ts";
import { PolicySuccession, successionLayer, type SuccessionScope } from "./ports.ts";
import { CRPKO, JUNO, OWNER, agent, makePorts, testLayer } from "./testing.ts";

const decodeUpsert = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);

const owner: GuardPrincipal = {
  _tag: "owner",
  provenance: { _tag: "owner-app", surface: "web", sessionId: "session-owner" },
};
const asThread = (threadId: ThreadId): GuardPrincipal => ({
  _tag: "thread",
  threadId,
  title: threadId,
});

const taskOn = (id: string, threadId: ThreadId) =>
  decodeUpsert({
    id,
    title: id,
    prompt: "Check in on the release.",
    enabled: true,
    schedule: { type: "interval", everyMs: 3_600_000 },
    projectId: "project:guard",
    threadId,
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: "codex", model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdBy: "agent",
    creationSource: "mcp",
  });

/** The real succession port over a real scheduler, with the membership guard. */
const harness = Effect.gen(function* () {
  const delivered = yield* makeDelivered;
  const seen = yield* membershipGuard;
  const context = yield* Layer.build(
    Layer.provideMerge(
      ScheduledTaskService.layer,
      Layer.mergeAll(
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
        recordingThreads(delivered),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.succeed(
          ScheduledTaskService.ScheduledTaskWebhookOrigin,
          Effect.succeed({ relayHookBaseUrl: "https://relay.example.com/v1/hooks/abc" }),
        ),
        NodeCrypto.layer,
        Scheduler.layer,
      ),
    ),
  );
  const schedules = yield* ScheduledTaskService.ScheduledTaskService.pipe(Effect.provide(context));
  const sql = yield* SqlClient.SqlClient;
  const succession = yield* PolicySuccession.pipe(
    Effect.provide(
      Layer.provide(
        successionLayer,
        Layer.mergeAll(
          Layer.succeed(ScheduledTaskService.ScheduledTaskService, schedules),
          Layer.succeed(SqlClient.SqlClient, sql),
        ),
      ),
    ),
  );
  const store = authorityStore(sql);
  /** A schedule on `threadId` whose recorded authority is `setBy`. */
  const schedule = (id: string, threadId: ThreadId, setBy: GuardPrincipal | null) =>
    Effect.gen(function* () {
      yield* schedules.upsert(yield* taskOn(id, threadId));
      yield* store.bind("scheduled-task", id, setBy);
    });
  const threadOf = (id: string) =>
    schedules
      .list()
      .pipe(Effect.map(({ tasks }) => tasks.find((task) => task.id === id)?.threadId ?? null));
  return { succession, schedule, threadOf, store, seen };
});

const run = <A, E>(body: (h: Effect.Success<typeof harness>) => Effect.Effect<A, E, Scope.Scope>) =>
  Effect.scoped(Effect.flatMap(harness, body)).pipe(Effect.provide(Sqlite.layerMemory));

/** The guard testkit's mission: the master and the lane lead are members. */
const scope = (overrides: Partial<SuccessionScope> = {}): SuccessionScope => ({
  decider: asThread(master),
  shared: null,
  members: new Set([master, lane]),
  ...overrides,
});

describe("succession port (Sol Q7)", () => {
  it.effect(
    "moves the role's schedules as the master, and leaves outsiders' and others' alone",
    () =>
      run(({ succession, schedule, threadOf, store }) =>
        Effect.gen(function* () {
          yield* schedule("lane-own", lane, asThread(lane));
          yield* schedule("owner-set", lane, owner);
          yield* schedule("outsider-set", lane, asThread(outsider));
          yield* schedule("master-own", master, asThread(master));
          const moves = yield* succession.move(lane, free, scope());
          const schedules = moves.find((move) => move.what === "schedules")!;
          assert.strictEqual(schedules.moved, 2);
          assert.strictEqual(schedules.kept, 1);
          assert.strictEqual(yield* threadOf("lane-own"), free);
          assert.strictEqual(yield* threadOf("owner-set"), free);
          assert.strictEqual(yield* threadOf("outsider-set"), lane);
          assert.strictEqual(yield* threadOf("master-own"), master);
          // The lane's own schedule now speaks as its successor, not as the master
          // who decided the handoff; the owner's stays the owner's.
          const moved = yield* store.read("scheduled-task", "lane-own");
          assert.deepStrictEqual(
            [moved?._tag, moved?._tag === "thread" ? moved.threadId : null],
            ["thread", free],
          );
          assert.deepStrictEqual(yield* store.read("scheduled-task", "owner-set"), owner);
        }),
      ),
  );

  it.effect("keeps every schedule on a thread that serves something else", () =>
    run(({ succession, schedule, threadOf }) =>
      Effect.gen(function* () {
        yield* schedule("lane-own", lane, asThread(lane));
        const moves = yield* succession.move(
          lane,
          free,
          scope({
            shared: "Schedules on t-lane stay there because it also works in mission Juno.",
          }),
        );
        const schedules = moves.find((move) => move.what === "schedules")!;
        assert.strictEqual(schedules.moved, 0);
        assert.strictEqual(schedules.kept, 1);
        assert.include(schedules.detail ?? "", "mission Juno");
        assert.strictEqual(yield* threadOf("lane-own"), lane);
      }),
    ),
  );

  it.effect(
    "keeps them when the decider may not edit the old thread's schedules, posting nothing",
    () =>
      run(({ succession, schedule, threadOf, seen }) =>
        Effect.gen(function* () {
          yield* schedule("lane-own", lane, asThread(lane));
          const before = seen.length;
          // A member that is not the master would be routed to the master.
          const moves = yield* succession.move(lane, free, scope({ decider: asThread(added) }));
          const schedules = moves.find((move) => move.what === "schedules")!;
          assert.strictEqual(schedules.moved, 0);
          assert.strictEqual(schedules.kept, 1);
          assert.include(schedules.detail ?? "", "may not edit schedules on t-lane");
          assert.strictEqual(yield* threadOf("lane-own"), lane);
          assert.strictEqual(seen.length, before);
        }),
      ),
  );
});

const ports = makePorts();
const SYSTEM_POLICY: MissionProvenance = { _tag: "system", component: "mission-policy" };

const setup = Effect.gen(function* () {
  const missions = yield* MissionService.MissionService;
  const policy = yield* PolicyService.PolicyService;
  yield* missions.createMission(OWNER, { missionId: CRPKO, slug: "crpko", title: "Crpko" });
  yield* missions.createMission(OWNER, { missionId: JUNO, slug: "juno", title: "Juno" });
  for (const id of ["thread-master", "thread-a", "thread-b", "thread-c", "thread-d"]) {
    ports.threads.set(id, { exists: true, idle: true, modelSelection: OPUS_XHIGH });
  }
  yield* policy.bindRole(OWNER, {
    roleId: RoleId.make(`${CRPKO}:master`),
    threadId: ThreadId.make("thread-master"),
  });
  return policy;
});

it.layer(testLayer(ports.layer))("succession scope", (it) => {
  it.effect("names the decider and refuses to call a shared thread's schedules the role's", () =>
    Effect.gen(function* () {
      const policy = yield* setup;
      yield* policy.bindRole(OWNER, {
        roleId: RoleId.make(`${CRPKO}:editor`),
        threadId: ThreadId.make("thread-a"),
      });
      yield* policy.bindRole(OWNER, {
        roleId: RoleId.make(`${JUNO}:editor`),
        threadId: ThreadId.make("thread-a"),
      });
      yield* policy.bindRole(OWNER, {
        roleId: RoleId.make(`${CRPKO}:scribe`),
        threadId: ThreadId.make("thread-c"),
      });

      yield* policy.succeedRole(agent("thread-master"), {
        roleId: RoleId.make(`${CRPKO}:editor`),
        threadId: ThreadId.make("thread-b"),
        handoffNote: "x",
      });
      const shared = ports.successions.at(-1)!;
      assert.strictEqual(shared.from, "thread-a");
      assert.deepStrictEqual(shared.scope.decider, asThread(ThreadId.make("thread-master")));
      assert.include(shared.scope.shared ?? "", "it also works in mission Juno");

      yield* policy.succeedRole(OWNER, {
        roleId: RoleId.make(`${CRPKO}:scribe`),
        threadId: ThreadId.make("thread-d"),
        handoffNote: "x",
      });
      const alone = ports.successions.at(-1)!;
      assert.strictEqual(alone.scope.shared, null);
      assert.deepStrictEqual(alone.scope.decider, { _tag: "owner", provenance: OWNER });
      assert.isTrue(alone.scope.members.has(ThreadId.make("thread-master")));

      yield* policy.succeedRole(SYSTEM_POLICY, {
        roleId: RoleId.make(`${CRPKO}:scribe`),
        threadId: ThreadId.make("thread-c"),
        handoffNote: "back",
      });
      assert.strictEqual(ports.successions.at(-1)!.scope.decider, undefined);
    }),
  );
});
