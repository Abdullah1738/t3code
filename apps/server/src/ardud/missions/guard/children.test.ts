import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2CreationSource,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import { makeSubagentChildThread } from "@t3tools/provider-core/server/subagentProjection";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "../../../orchestration-v2/EventSink.ts";
import * as EventStore from "../../../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import { masterThread, missionId, seed, strayThread } from "../asks/AsksService.testkit.ts";
import * as MissionRouter from "../router/MissionRouter.ts";
import { RouterThreads } from "../router/ports.ts";
import * as RouterStore from "../router/RouterStore.ts";
import * as MissionStore from "../store/MissionStore.ts";
import { authorityStore } from "./authority.ts";
import { forkCreator } from "./forks.ts";

const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-5.4" };

/** Lineage and creators come from the real projection and authority tables. */
const projectedThreads = Layer.effect(
  RouterThreads,
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const authority = authorityStore(yield* SqlClient.SqlClient);
    return RouterThreads.of({
      facts: (threadId) =>
        projections.getThread(threadId).pipe(
          Effect.map((thread) => ({
            threadId,
            title: thread.title,
            activity: "idle" as const,
            parentThreadId: thread.lineage.parentThreadId,
            rootThreadId: thread.lineage.rootThreadId,
            archived: false,
          })),
          Effect.orElseSucceed(() => null),
        ),
      creator: (threadId) => forkCreator(authority, threadId),
      send: () => Effect.void,
      question: () => Effect.succeed(null),
      approval: () => Effect.succeed(null),
      respondApproval: () => Effect.void,
    });
  }),
);

const layer = Layer.mergeAll(
  EventSink.layer,
  MissionRouter.layer.pipe(Layer.provideMerge(Layer.mergeAll(RouterStore.layer, projectedThreads))),
).pipe(
  Layer.provideMerge(MissionStore.layer),
  Layer.provideMerge(Layer.mergeAll(EventStore.layer, ProjectionStore.layer)),
  Layer.provideMerge(Sqlite.layerMemory),
);

const rootThread = (threadId: ThreadId, now: DateTime.Utc): OrchestrationV2AppThread => ({
  createdBy: "user",
  creationSource: "web",
  id: threadId,
  projectId: ProjectId.make("project:children"),
  title: threadId,
  providerInstanceId,
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
});

/** A child as delegate_task (`mcp`) or a provider's native subagent (`provider`) builds it. */
const childOf = (
  parent: OrchestrationV2AppThread,
  childThreadId: ThreadId,
  creationSource: OrchestrationV2CreationSource,
  now: DateTime.Utc,
) =>
  makeSubagentChildThread({
    parentThread: parent,
    childThreadId,
    parentNodeId: NodeId.make(`node:${childThreadId}`),
    activeProviderThreadId: null,
    providerInstanceId,
    modelSelection,
    title: childThreadId,
    now,
    createdBy: "agent",
    creationSource,
  });

const created = (
  thread: OrchestrationV2AppThread,
  now: DateTime.Utc,
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`event:${thread.id}`),
  type: "thread.created",
  threadId: thread.id,
  providerInstanceId,
  occurredAt: now,
  payload: thread,
});

const write = (...threads: ReadonlyArray<OrchestrationV2AppThread>) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    yield* sink.write({ events: threads.map((thread) => created(thread, now)) });
  });

const toMaster = (from: ThreadId) =>
  Effect.gen(function* () {
    const router = yield* MissionRouter.MissionRouter;
    return yield* router.checkSend({
      path: "thread-send",
      targetThreadId: masterThread,
      from: { _tag: "thread", threadId: from, title: from },
    });
  });

describe("children spawned by a thread (router r3 sponsorship)", () => {
  it.effect("a master's delegated child and native subagent are the master's members", () =>
    Effect.gen(function* () {
      yield* seed;
      const now = yield* DateTime.now;
      const master = rootThread(masterThread, now);
      const delegated = childOf(master, ThreadId.make("t-delegated"), "mcp", now);
      const native = childOf(master, ThreadId.make("t-native"), "provider", now);
      yield* write(master);
      yield* write(delegated, native);

      const store = authorityStore(yield* SqlClient.SqlClient);
      for (const child of [delegated, native]) {
        assert.deepStrictEqual(yield* forkCreator(store, child.id), {
          _tag: "thread",
          threadId: masterThread,
          title: "",
        });
        // A member's send to the master goes through a room: it is a member.
        assert.strictEqual((yield* toMaster(child.id))._tag, "route");
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a child spawned by a thread outside the mission is not a member", () =>
    Effect.gen(function* () {
      yield* seed;
      const now = yield* DateTime.now;
      const stray = rootThread(strayThread, now);
      const child = childOf(stray, ThreadId.make("t-stray-child"), "mcp", now);
      yield* write(rootThread(masterThread, now), stray);
      yield* write(child);

      assert.deepStrictEqual(yield* toMaster(child.id), {
        _tag: "knock",
        missionId,
        reason: "outsider",
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("children from before the guard get their parent as creator at startup", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const store = authorityStore(sql);
      const now = yield* DateTime.now;
      const master = rootThread(masterThread, now);
      const earlier = childOf(master, ThreadId.make("t-earlier"), "provider", now);
      const owned = childOf(master, ThreadId.make("t-owned"), "provider", now);
      yield* write(master);
      yield* write(earlier, owned);
      // As if both were made before creators were recorded, one since claimed by the owner.
      yield* store.bind("fork", earlier.id, null);
      yield* store.bind("fork", owned.id, {
        _tag: "owner",
        provenance: { _tag: "owner-app", surface: "web", sessionId: "s-1" },
      });
      assert.strictEqual((yield* toMaster(earlier.id))._tag, "knock");

      // The next server start builds the event sink again.
      const memoMap = yield* Layer.makeMemoMap;
      yield* Effect.scoped(
        Effect.flatMap(Effect.scope, (scope) =>
          Layer.buildWithMemoMap(EventSink.layer, memoMap, scope),
        ),
      );
      assert.deepStrictEqual(yield* forkCreator(store, earlier.id), {
        _tag: "thread",
        threadId: masterThread,
        title: "",
      });
      assert.strictEqual((yield* toMaster(earlier.id))._tag, "route");
      assert.strictEqual((yield* forkCreator(store, owned.id))?._tag, "owner");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a child is never created without its recorded creator", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const master = rootThread(masterThread, now);
      yield* write(master);
      yield* authorityStore(sql).read("fork", "warm-up");
      yield* sql.unsafe(
        `CREATE TRIGGER fail_authority_insert BEFORE INSERT ON ardud_mission_guard_authority BEGIN SELECT RAISE(ABORT, 'injected authority failure'); END`,
      );

      const child = childOf(master, ThreadId.make("t-delegated"), "mcp", now);
      const failed = yield* write(child).pipe(Effect.flip);
      assert.strictEqual(failed._tag, "EventSinkWriteError");
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const exists = yield* projections.getThread(child.id).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      assert.isFalse(exists);
    }).pipe(Effect.provide(layer)),
  );
});
