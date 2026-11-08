import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  ThreadId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderSessionId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as ExecutionIdentity from "./ExecutionIdentity.ts";

const provider = (
  providerThreadId: string,
  threadId: string,
  driver: string,
  nativeId: string | null,
  updatedAt: string,
  instance = driver === "opencode" ? "opencode" : driver,
  createdAt = updatedAt,
) => ({
  provider_thread_id: providerThreadId,
  thread_id: threadId,
  owner_node_id: null,
  provider: driver,
  provider_session_id: null,
  status: "idle",
  first_run_ordinal: 1,
  last_run_ordinal: 1,
  updated_at: updatedAt,
  driver,
  provider_instance_id: instance,
  payload_json: JSON.stringify({
    id: providerThreadId,
    driver,
    providerInstanceId: instance,
    appThreadId: threadId,
    createdAt,
    nativeThreadRef: nativeId === null ? null : { driver, nativeId, strength: "strong" },
  }),
});

const thread = (
  threadId: string,
  activeProviderThreadId: string | null,
  lineage: {
    parentThreadId: string | null;
    rootThreadId: string;
    relationshipToParent?: string | null;
  },
  model = { instanceId: "opencode", model: "opus/claude-opus-5-5" },
) => ({
  thread_id: threadId,
  project_id: "project",
  title: threadId,
  default_provider: "opencode",
  runtime_mode: "full-access",
  interaction_mode: "default",
  active_provider_thread_id: activeProviderThreadId,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  archived_at: null,
  deleted_at: null,
  provider_instance_id: "opencode",
  payload_json: JSON.stringify({
    lineage: { relationshipToParent: null, ...lineage },
    activeProviderThreadId,
    modelSelection: model,
  }),
});

const subagent = (
  subagentId: string,
  threadId: string,
  childThreadId: string,
  providerThreadId: string | null,
  driver: string,
  nativeTaskId: string | null,
  model = { instanceId: "claude", model: "claude-haiku-5-5" },
  options: { origin?: string; instance?: string; updatedAt?: string } = {},
) => ({
  subagent_id: subagentId,
  thread_id: threadId,
  run_id: null,
  parent_node_id: "node",
  provider: driver,
  provider_thread_id: providerThreadId,
  child_thread_id: childThreadId,
  origin: options.origin ?? "provider_native",
  status: "running",
  started_at: "2026-01-01T00:00:00.000Z",
  completed_at: null,
  updated_at: options.updatedAt ?? "2026-01-01T00:00:00.000Z",
  driver,
  provider_instance_id: options.instance ?? driver,
  payload_json: JSON.stringify({
    id: subagentId,
    threadId,
    childThreadId,
    providerThreadId,
    origin: options.origin ?? "provider_native",
    nativeTaskRef:
      nativeTaskId === null ? null : { driver, nativeId: nativeTaskId, strength: "strong" },
    modelSelection: model,
  }),
});

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const insertThread = (row: ReturnType<typeof thread>) =>
    sql`INSERT INTO orchestration_v2_projection_threads ${sql.insert(row)}`;
  const insertProvider = (row: ReturnType<typeof provider>) =>
    sql`INSERT INTO orchestration_v2_projection_provider_threads ${sql.insert(row)}`;
  const insertSubagent = (row: ReturnType<typeof subagent>) =>
    sql`INSERT INTO orchestration_v2_projection_subagents ${sql.insert(row)}`;
  // The child's node carries the parent provider thread the adapter wrote
  // (ClaudeAdapterV2.ts ~5482). The subagent row and its node share one id.
  const insertNode = (subagentId: string, threadId: string, providerThreadId: string | null) =>
    sql`INSERT INTO orchestration_v2_projection_nodes ${sql.insert({
      node_id: subagentId,
      thread_id: threadId,
      run_id: null,
      parent_node_id: null,
      root_node_id: subagentId,
      kind: "subagent",
      status: "running",
      provider_thread_id: providerThreadId,
      provider_turn_id: null,
      runtime_request_id: null,
      checkpoint_scope_id: null,
      started_at: "2026-01-01T00:00:00.000Z",
      completed_at: null,
      payload_json: JSON.stringify({ id: subagentId, kind: "subagent", providerThreadId }),
    })}`;
  const insertImport = (nativeId: string, threadId: string) =>
    sql`INSERT INTO ardud_opencode_import ${sql.insert({
      native_session_id: nativeId,
      thread_id: threadId,
      imported_at: "2026-01-01T00:00:00.000Z",
    })}`;

  // Top-level OpenCode thread.
  yield* insertThread(thread("t-oc", "pt-oc", { parentThreadId: null, rootThreadId: "t-oc" }));
  yield* insertProvider(
    provider("pt-oc", "t-oc", "opencode", "ses_top", "2026-01-01T00:00:00.000Z"),
  );

  // Migrated thread: the old OpenCode row was updated later than the Claude row,
  // so newest-wins would return the stale ses_ id.
  yield* insertThread(
    thread("t-moved", "pt-claude", { parentThreadId: null, rootThreadId: "t-moved" }),
  );
  yield* insertProvider(
    provider("pt-old-oc", "t-moved", "opencode", "ses_old", "2026-01-02T00:00:00.000Z"),
  );
  yield* insertProvider(
    provider(
      "pt-claude",
      "t-moved",
      "claudeAgent",
      "claude-session-uuid",
      "2026-01-01T00:00:00.000Z",
    ),
  );
  yield* insertImport("ses_imported", "t-moved");

  // Claude parent session with a native child found only by agent id.
  yield* insertThread(
    thread("t-claude-parent", "pt-claude-parent", {
      parentThreadId: null,
      rootThreadId: "t-claude-parent",
    }),
  );
  yield* insertProvider(
    provider(
      "pt-claude-parent",
      "t-claude-parent",
      "claudeAgent",
      "parent-uuid",
      "2026-01-01T00:00:00.000Z",
    ),
  );
  yield* insertThread(
    thread("t-claude-child", null, {
      parentThreadId: "t-claude-parent",
      rootThreadId: "t-claude-parent",
      relationshipToParent: "subagent",
    }),
  );
  yield* insertSubagent(
    subagent("s-claude", "t-claude-parent", "t-claude-child", null, "claudeAgent", "agent-abc"),
  );
  yield* insertNode("s-claude", "t-claude-parent", "pt-claude-parent");

  // Codex child owns its own provider thread.
  yield* insertThread(
    thread("t-codex-parent", "pt-codex-parent", {
      parentThreadId: null,
      rootThreadId: "t-codex-parent",
    }),
  );
  yield* insertProvider(
    provider(
      "pt-codex-parent",
      "t-codex-parent",
      "codex",
      "codex-parent",
      "2026-01-01T00:00:00.000Z",
    ),
  );
  yield* insertThread(
    thread("t-codex-child", "pt-codex-child", {
      parentThreadId: "t-codex-parent",
      rootThreadId: "t-codex-parent",
      relationshipToParent: "subagent",
    }),
  );
  yield* insertProvider(
    provider(
      "pt-codex-child",
      "t-codex-child",
      "codex",
      "codex-child-uuid",
      "2026-01-01T00:00:00.000Z",
    ),
  );
  yield* insertSubagent(
    subagent("s-codex", "t-codex-parent", "t-codex-child", "pt-codex-child", "codex", null, {
      instanceId: "codex",
      model: "gpt-6.1-sol",
    }),
  );

  // The same UUID under two drivers, in two different threads.
  yield* insertThread(
    thread("t-dup-a", "pt-dup-a", { parentThreadId: null, rootThreadId: "t-dup-a" }),
  );
  yield* insertProvider(
    provider("pt-dup-a", "t-dup-a", "claudeAgent", "dup-uuid", "2026-01-01T00:00:00.000Z"),
  );
  yield* insertThread(
    thread("t-dup-b", "pt-dup-b", { parentThreadId: null, rootThreadId: "t-dup-b" }),
  );
  yield* insertProvider(
    provider("pt-dup-b", "t-dup-b", "codex", "dup-uuid", "2026-01-01T00:00:00.000Z"),
  );

  // Lineage cycle: a points at b and b at a.
  yield* insertThread(
    thread("t-cyc-a", null, { parentThreadId: "t-cyc-b", rootThreadId: "t-cyc-b" }),
  );
  yield* insertThread(
    thread("t-cyc-b", "pt-cyc-b", { parentThreadId: "t-cyc-a", rootThreadId: "t-cyc-a" }),
  );
  yield* insertProvider(
    provider("pt-cyc-b", "t-cyc-b", "opencode", "ses_cycle", "2026-01-01T00:00:00.000Z"),
  );

  // Deep parent chain: 150 hops to a root with no rootThreadId set.
  for (let index = 0; index <= 150; index++) {
    const parent = index === 150 ? null : `t-deep-${index + 1}`;
    yield* insertThread(
      thread(`t-deep-${index}`, index === 0 ? "pt-deep-0" : null, {
        parentThreadId: parent,
        rootThreadId: `t-deep-${index}`,
      }),
    );
  }
  yield* insertThread(
    thread("t-deep-root", null, { parentThreadId: null, rootThreadId: "t-deep-root" }),
  );
  yield* insertProvider(
    provider("pt-deep-0", "t-deep-0", "opencode", "ses_deep", "2026-01-01T00:00:00.000Z"),
  );

  // A Codex thread created just now whose native id has not arrived yet.
  yield* insertThread(
    thread("t-fresh", "pt-fresh", { parentThreadId: null, rootThreadId: "t-fresh" }),
  );
  const now = DateTime.formatIso(yield* DateTime.now);
  yield* insertProvider(provider("pt-fresh", "t-fresh", "codex", null, now));

  // Review r1 (pending window): an old unnamed Codex thread whose row was
  // written just now. Only createdAt may decide the pending window.
  yield* insertThread(
    thread("t-stale-unnamed", "pt-stale-unnamed", {
      parentThreadId: null,
      rootThreadId: "t-stale-unnamed",
    }),
  );
  yield* insertProvider(
    provider(
      "pt-stale-unnamed",
      "t-stale-unnamed",
      "codex",
      null,
      now,
      "codex",
      "2026-01-01T00:00:00.000Z",
    ),
  );

  // Review r2 (detached binding): a migrated thread whose Claude provider row
  // has lost its native id. The old ses_ must not come back as current.
  yield* insertThread(
    thread("t-detached", "pt-detached-claude", {
      parentThreadId: null,
      rootThreadId: "t-detached",
    }),
  );
  yield* insertProvider(
    provider(
      "pt-detached-old",
      "t-detached",
      "opencode",
      "ses_detached_old",
      "2026-01-02T00:00:00.000Z",
    ),
  );
  yield* insertProvider(
    provider("pt-detached-claude", "t-detached", "claudeAgent", null, "2026-01-01T00:00:00.000Z"),
  );

  // Review r3 (Claude ownership): a second Claude instance under the same
  // parent app thread that reuses agent-abc. Its child must not resolve through
  // the first instance's session, and the instance must match.
  yield* insertProvider(
    provider(
      "pt-claude-parent-2",
      "t-claude-parent",
      "claudeAgent",
      "parent-uuid-2",
      "2026-01-01T00:00:00.000Z",
      "claudeAgent-2",
    ),
  );
  yield* insertThread(
    thread("t-claude-child-2", null, {
      parentThreadId: "t-claude-parent",
      rootThreadId: "t-claude-parent",
      relationshipToParent: "subagent",
    }),
  );
  yield* insertSubagent(
    subagent(
      "s-claude-2",
      "t-claude-parent",
      "t-claude-child-2",
      null,
      "claudeAgent",
      "agent-abc",
      undefined,
      { instance: "claudeAgent-2" },
    ),
  );
  yield* insertNode("s-claude-2", "t-claude-parent", "pt-claude-parent-2");

  // Review r5 (same-instance replacement): the parent app thread's Claude
  // session is replaced by a new session in the SAME instance. The old child
  // (agent-abc, node under pt-claude-parent) must not resolve through the new
  // session. The replacement has its own provider thread and no child node.
  yield* insertProvider(
    provider(
      "pt-claude-replacement",
      "t-claude-parent",
      "claudeAgent",
      "parent-uuid-replacement",
      "2026-01-03T00:00:00.000Z",
    ),
  );

  // Review r4 (app-owned children): an app-owned delegated child whose
  // completion records its provider thread. It is not a provider-native child.
  yield* insertThread(
    thread("t-app-parent", "pt-app-parent", { parentThreadId: null, rootThreadId: "t-app-parent" }),
  );
  yield* insertProvider(
    provider(
      "pt-app-parent",
      "t-app-parent",
      "codex",
      "codex-app-parent",
      "2026-01-01T00:00:00.000Z",
    ),
  );
  yield* insertThread(
    thread(
      "t-app-child",
      "pt-app-child",
      {
        parentThreadId: "t-app-parent",
        rootThreadId: "t-app-parent",
        relationshipToParent: "subagent",
      },
      { instanceId: "codex", model: "gpt-6.1-sol" },
    ),
  );
  yield* insertProvider(
    provider(
      "pt-app-child",
      "t-app-child",
      "codex",
      "codex-app-child-uuid",
      "2026-01-01T00:00:00.000Z",
    ),
  );
  yield* insertSubagent(
    subagent(
      "s-app-child",
      "t-app-parent",
      "t-app-child",
      "pt-app-child",
      "codex",
      null,
      { instanceId: "codex", model: "gpt-6.1-sol" },
      { origin: "app_owned" },
    ),
  );
});

// The test clock starts at epoch 0, so the resolver's "now" must be set
// explicitly. Fixtures are written relative to this instant.
const CLOCK_NOW = "2026-11-01T00:00:00.000Z";

const run = <A, E>(body: Effect.Effect<A, E, ExecutionIdentity.ExecutionIdentity>) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(CLOCK_NOW));
      yield* seed;
      return yield* body;
    }).pipe(Effect.provide(ExecutionIdentity.layer)),
  ).pipe(Effect.provide(Sqlite.layerMemory));

// Only the old unnamed codex thread: nothing else can make a codex lookup pending.
const seedStaleOnly = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = DateTime.formatIso(yield* DateTime.now);
  yield* sql`INSERT INTO orchestration_v2_projection_threads ${sql.insert(
    thread("t-only-stale", "pt-only-stale", { parentThreadId: null, rootThreadId: "t-only-stale" }),
  )}`;
  yield* sql`INSERT INTO orchestration_v2_projection_provider_threads ${sql.insert(
    provider(
      "pt-only-stale",
      "t-only-stale",
      "codex",
      null,
      now,
      "codex",
      "2026-01-01T00:00:00.000Z",
    ),
  )}`;
});

const runStaleOnly = <A, E>(body: Effect.Effect<A, E, ExecutionIdentity.ExecutionIdentity>) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(CLOCK_NOW));
      yield* seedStaleOnly;
      return yield* body;
    }).pipe(Effect.provide(ExecutionIdentity.layer)),
  ).pipe(Effect.provide(Sqlite.layerMemory));

describe("ExecutionIdentity", () => {
  it.live("resolves a started app-managed Codex child while the SQLite writer is held", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-identity-startup-" });
      yield* Effect.gen(function* () {
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const identity = yield* ExecutionIdentity.ExecutionIdentity;
        const now = yield* DateTime.now;
        const parentId = ThreadId.make("thread:parent-startup");
        const childId = ThreadId.make("thread:delegated-task:startup");
        const instance = ProviderInstanceId.make("codex");
        const driver = ProviderDriverKind.make("codex");
        const providerId = ProviderThreadId.make("provider-thread:startup");
        const nativeId = "11111111-2222-7333-8444-555555555555";
        // delegate_task creates a child and a provider placeholder. Its app-owned
        // roster entry has no providerThreadId until completion; resolution must
        // already work through the child's own startup mapping.
        yield* store.apply({
          id: EventId.make("event:child-created"),
          type: "thread.created",
          threadId: childId,
          occurredAt: now,
          payload: {
            id: childId,
            createdBy: "agent",
            creationSource: "mcp",
            projectId: ProjectId.make("project"),
            title: "Delegated startup",
            providerInstanceId: instance,
            modelSelection: { instanceId: instance, model: "gpt-6.1-sol" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: {
              parentThreadId: parentId,
              rootThreadId: parentId,
              relationshipToParent: "subagent",
            },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        });
        const placeholder = {
          id: providerId,
          driver,
          providerInstanceId: instance,
          providerSessionId: ProviderSessionId.make("provider-session:startup"),
          appThreadId: childId,
          ownerNodeId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "not_loaded" as const,
          firstRunOrdinal: 1,
          lastRunOrdinal: 1,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        };
        yield* store.apply({
          id: EventId.make("event:placeholder"),
          type: "provider-thread.updated",
          threadId: childId,
          occurredAt: now,
          payload: placeholder,
        });
        assert.strictEqual((yield* identity.resolve({ nativeId, driver })).resolution, "pending");
        // ProviderTurnStartService writes this before session.startTurn, in the
        // same transaction as run.updated and run-attempt.updated. No model
        // output or terminal/completion event is needed to publish the native id.
        yield* store.apply({
          id: EventId.make("event:startup-mapping"),
          type: "provider-thread.updated",
          threadId: childId,
          driver,
          providerInstanceId: instance,
          occurredAt: now,
          payload: {
            ...placeholder,
            status: "active",
            nativeThreadRef: { driver, nativeId, strength: "strong" },
          },
        });
        const sql = yield* SqlClient.SqlClient;
        const writerHeld = yield* Deferred.make<void>();
        const releaseWriter = yield* Deferred.make<void>();
        const writer = yield* Effect.forkChild(
          sql.withTransaction(
            Deferred.succeed(writerHeld, undefined).pipe(
              Effect.andThen(Deferred.await(releaseWriter)),
            ),
          ),
        );
        yield* Deferred.await(writerHeld);
        const result = yield* identity
          .resolve({ nativeId, driver })
          .pipe(
            Effect.timeout("2 seconds"),
            Effect.ensuring(Deferred.succeed(releaseWriter, undefined)),
          );
        yield* Fiber.join(writer);
        assert.strictEqual(result.resolution, "resolved");
        assert.strictEqual(result.robobThreadId, childId);
        assert.strictEqual(result.executionKind, "app-managed-child");
        assert.strictEqual(result.parentThreadId, parentId);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(ExecutionIdentity.layer, ProjectionStore.layer).pipe(
            Layer.provideMerge(Sqlite.layerFromPath(path.join(directory, "state.sqlite"))),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "indexes native-id and pending-provider queries on an existing database idempotently",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO orchestration_v2_projection_threads ${sql.insert(
            thread("t-index", "pt-index", { parentThreadId: null, rootThreadId: "t-index" }),
          )}`;
          yield* sql`INSERT INTO orchestration_v2_projection_provider_threads ${sql.insert(
            provider("pt-index", "t-index", "codex", "native-index", CLOCK_NOW),
          )}`;

          const nativePlan = sql<{ readonly detail: string }>`
          EXPLAIN QUERY PLAN
          SELECT pt.provider_thread_id, pt.thread_id,
            COALESCE(pt.driver, json_extract(pt.payload_json, '$.driver')) AS driver,
            COALESCE(pt.provider_instance_id, json_extract(pt.payload_json, '$.providerInstanceId')) AS provider_instance_id,
            json_extract(pt.payload_json, '$.nativeThreadRef.nativeId') AS native_id,
            pt.updated_at,
            CASE WHEN t.active_provider_thread_id = pt.provider_thread_id THEN 1 ELSE 0 END AS active
          FROM orchestration_v2_projection_provider_threads pt
          LEFT JOIN orchestration_v2_projection_threads t ON t.thread_id = pt.thread_id
          WHERE json_extract(pt.payload_json, '$.nativeThreadRef.nativeId') = ${"native-index"}
        `;
          const pendingPlan = sql<{ readonly detail: string }>`
          EXPLAIN QUERY PLAN
          SELECT COALESCE(driver, json_extract(payload_json, '$.driver')) AS driver,
            COALESCE(provider_instance_id, json_extract(payload_json, '$.providerInstanceId')) AS provider_instance_id,
            json_extract(payload_json, '$.nativeThreadRef.nativeId') AS native_id
          FROM orchestration_v2_projection_provider_threads
          WHERE json_extract(payload_json, '$.createdAt') >= ${CLOCK_NOW}
        `;

          assert.include(
            (yield* nativePlan).map((row) => row.detail),
            "SCAN pt",
          );
          assert.include(
            (yield* pendingPlan).map((row) => row.detail),
            "SCAN orchestration_v2_projection_provider_threads",
          );

          yield* Layer.build(Layer.fresh(ExecutionIdentity.layer));
          yield* Layer.build(Layer.fresh(ExecutionIdentity.layer));

          const nativeDetails = (yield* nativePlan).map((row) => row.detail).join("\n");
          const pendingDetails = (yield* pendingPlan).map((row) => row.detail).join("\n");
          assert.include(nativeDetails, "USING INDEX ardud_idx_provider_threads_native_id");
          assert.notMatch(
            nativeDetails,
            /SCAN (?:pt|orchestration_v2_projection_provider_threads)\b/,
          );
          assert.include(pendingDetails, "USING INDEX ardud_idx_provider_threads_created_at");
          assert.notMatch(pendingDetails, /SCAN orchestration_v2_projection_provider_threads\b/);
        }),
      ).pipe(Effect.provide(Sqlite.layerMemory)),
  );

  it.effect.each(["ardud_idx_provider_threads_native_id", "ardud_idx_provider_threads_created_at"])(
    "warns and keeps resolving when creating %s fails",
    (index) => {
      const warnings: Array<unknown> = [];
      const logger = Logger.make(({ logLevel, message }) => {
        if (logLevel === "Warn") warnings.push(message);
      });
      return Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          // A conflicting schema name makes CREATE INDEX fail without breaking identity reads.
          yield* sql`CREATE TABLE ${sql(index)} (id TEXT)`;
          yield* Effect.gen(function* () {
            yield* seed;
            const identity = yield* ExecutionIdentity.ExecutionIdentity;
            assert.strictEqual(
              (yield* identity.resolve({ nativeId: "ses_top" })).resolution,
              "resolved",
            );
          }).pipe(Effect.provide(ExecutionIdentity.layer));
          assert.lengthOf(warnings, 1);
          const indexes = yield* sql<{ readonly name: string }>`
            SELECT name FROM sqlite_schema WHERE type = 'index' AND name IN (
              'ardud_idx_provider_threads_native_id', 'ardud_idx_provider_threads_created_at'
            )
          `;
          assert.lengthOf(indexes, 1);
          assert.notStrictEqual(indexes[0]?.name, index);
        }),
      ).pipe(
        Effect.provide(
          Layer.merge(Sqlite.layerMemory, Logger.layer([logger], { mergeWithExisting: false })),
        ),
      );
    },
  );

  it.effect("builds without the projection table", () =>
    Effect.scoped(Layer.build(ExecutionIdentity.layer)).pipe(
      Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
    ),
  );

  it.effect("resolves a top-level OpenCode session to its thread", () =>
    run(
      Effect.gen(function* () {
        const identity = yield* ExecutionIdentity.ExecutionIdentity;
        const result = yield* identity.resolve({ nativeId: "ses_top" });
        assert.strictEqual(result.resolution, "resolved");
        assert.strictEqual(result.robobThreadId, "t-oc");
        assert.strictEqual(result.executionKind, "top-level");
        assert.strictEqual(result.driver, "opencode");
        assert.strictEqual(result.acceptsMessages, true);
        assert.strictEqual(result.model?.model, "opus/claude-opus-5-5");
      }),
    ),
  );

  it.effect("returns the migrated Claude id as current and keeps the OpenCode alias", () =>
    run(
      Effect.gen(function* () {
        const identity = yield* ExecutionIdentity.ExecutionIdentity;
        const current = yield* identity.currentNative(["t-moved"]);
        assert.deepStrictEqual(current.get("t-moved"), {
          driver: "claudeAgent",
          providerInstanceId: "claudeAgent",
          nativeId: "claude-session-uuid",
        });
        const aliases = yield* identity.aliases("t-moved");
        const ids = aliases.map((alias) => alias.nativeId).toSorted();
        assert.deepStrictEqual(ids, ["claude-session-uuid", "ses_imported", "ses_old"]);
      }),
    ),
  );

  it.effect("resolves a Claude child by parent session and agent id, not by session alone", () =>
    run(
      Effect.gen(function* () {
        const identity = yield* ExecutionIdentity.ExecutionIdentity;
        const child = yield* identity.resolve({
          nativeId: "parent-uuid",
          driver: "claudeAgent",
          agentId: "agent-abc",
        });
        assert.strictEqual(child.resolution, "resolved");
        assert.strictEqual(child.robobThreadId, "t-claude-child");
        assert.strictEqual(child.parentThreadId, "t-claude-parent");
        assert.strictEqual(child.executionKind, "provider-native-child");
        assert.strictEqual(child.acceptsMessages, false);
        assert.strictEqual(child.nativeAgentId, "agent-abc");
        assert.strictEqual(child.model?.model, "claude-haiku-5-5");

        const parent = yield* identity.resolve({ nativeId: "parent-uuid", driver: "claudeAgent" });
        assert.strictEqual(parent.robobThreadId, "t-claude-parent");
        assert.strictEqual(parent.executionKind, "top-level");
      }),
    ),
  );

  it.effect("resolves a Codex child through its own provider thread", () =>
    run(
      Effect.gen(function* () {
        const identity = yield* ExecutionIdentity.ExecutionIdentity;
        const result = yield* identity.resolve({ nativeId: "codex-child-uuid", driver: "codex" });
        assert.strictEqual(result.resolution, "resolved");
        assert.strictEqual(result.robobThreadId, "t-codex-child");
        assert.strictEqual(result.parentThreadId, "t-codex-parent");
        assert.strictEqual(result.executionKind, "provider-native-child");
        assert.strictEqual(result.acceptsMessages, true);
        assert.strictEqual(result.model?.model, "gpt-6.1-sol");
      }),
    ),
  );

  it.effect("refuses a UUID shared by two drivers without a driver, and resolves with one", () =>
    run(
      Effect.gen(function* () {
        const identity = yield* ExecutionIdentity.ExecutionIdentity;
        const ambiguous = yield* identity.resolve({ nativeId: "dup-uuid" });
        assert.strictEqual(ambiguous.resolution, "ambiguous");
        assert.deepStrictEqual([...ambiguous.candidates].toSorted(), ["t-dup-a", "t-dup-b"]);
        assert.strictEqual(ambiguous.robobThreadId, null);

        const claude = yield* identity.resolve({ nativeId: "dup-uuid", driver: "claudeAgent" });
        assert.strictEqual(claude.resolution, "resolved");
        assert.strictEqual(claude.robobThreadId, "t-dup-a");
        const codex = yield* identity.resolve({ nativeId: "dup-uuid", driver: "codex" });
        assert.strictEqual(codex.robobThreadId, "t-dup-b");
      }),
    ),
  );

  it.effect("terminates on a lineage cycle", () =>
    run(
      Effect.gen(function* () {
        const identity = yield* ExecutionIdentity.ExecutionIdentity;
        const result = yield* identity.resolve({ nativeId: "ses_cycle" });
        assert.strictEqual(result.resolution, "resolved");
        assert.strictEqual(result.robobThreadId, "t-cyc-b");
        assert.ok(result.rootThreadId === "t-cyc-a" || result.rootThreadId === "t-cyc-b");
      }),
    ),
  );

  it.effect("finds the real root of a 150-deep parent chain", () =>
    run(
      Effect.gen(function* () {
        const identity = yield* ExecutionIdentity.ExecutionIdentity;
        const result = yield* identity.resolve({ nativeId: "ses_deep" });
        assert.strictEqual(result.robobThreadId, "t-deep-0");
        assert.strictEqual(result.rootThreadId, "t-deep-0");
      }),
    ),
  );

  it.effect("does not report a detached Claude binding's old ses_ as current", () =>
    run(
      Effect.gen(function* () {
        const identity = yield* ExecutionIdentity.ExecutionIdentity;
        const current = yield* identity.currentNative(["t-detached"]);
        assert.isFalse(current.has("t-detached"));
        const aliases = (yield* identity.aliases("t-detached")).map((alias) => alias.nativeId);
        assert.include(aliases, "ses_detached_old");
        const byOld = yield* identity.resolve({ nativeId: "ses_detached_old" });
        assert.strictEqual(byOld.robobThreadId, "t-detached");
      }),
    ),
  );

  it.effect("resolves a second Claude instance's child only through that instance", () =>
    run(
      Effect.gen(function* () {
        const identity = yield* ExecutionIdentity.ExecutionIdentity;
        const second = yield* identity.resolve({
          nativeId: "parent-uuid-2",
          driver: "claudeAgent",
          providerInstanceId: "claudeAgent-2",
          agentId: "agent-abc",
        });
        assert.strictEqual(second.resolution, "resolved");
        assert.strictEqual(second.robobThreadId, "t-claude-child-2");
        assert.strictEqual(second.providerInstanceId, "claudeAgent-2");

        // The first instance's session with the same agent id is its own child.
        const first = yield* identity.resolve({
          nativeId: "parent-uuid",
          driver: "claudeAgent",
          providerInstanceId: "claudeAgent",
          agentId: "agent-abc",
        });
        assert.strictEqual(first.robobThreadId, "t-claude-child");
        assert.strictEqual(first.providerInstanceId, "claudeAgent");
      }),
    ),
  );

  it.effect("does not resolve an old child through a same-instance replacement session", () =>
    run(
      Effect.gen(function* () {
        const identity = yield* ExecutionIdentity.ExecutionIdentity;
        // The replacement is in the same instance as the old child, but its
        // provider thread never created agent-abc's node.
        const replacement = yield* identity.resolve({
          nativeId: "parent-uuid-replacement",
          driver: "claudeAgent",
          providerInstanceId: "claudeAgent",
          agentId: "agent-abc",
        });
        assert.notStrictEqual(replacement.robobThreadId, "t-claude-child");
        assert.notStrictEqual(replacement.resolution, "resolved");
        // The old session still resolves its own child: the node proves ownership.
        const original = yield* identity.resolve({
          nativeId: "parent-uuid",
          driver: "claudeAgent",
          providerInstanceId: "claudeAgent",
          agentId: "agent-abc",
        });
        assert.strictEqual(original.robobThreadId, "t-claude-child");
      }),
    ),
  );

  it.effect("refuses a Claude child under an instance that owns no such child", () =>
    run(
      Effect.gen(function* () {
        const identity = yield* ExecutionIdentity.ExecutionIdentity;
        const none = yield* identity.resolve({
          nativeId: "parent-uuid-2",
          driver: "claudeAgent",
          providerInstanceId: "claudeAgent",
          agentId: "agent-abc",
        });
        assert.notStrictEqual(none.robobThreadId, "t-claude-child-2");
        assert.notStrictEqual(none.resolution, "resolved");
      }),
    ),
  );

  it.effect("classifies an app-owned child as app-managed, not provider-native", () =>
    run(
      Effect.gen(function* () {
        const identity = yield* ExecutionIdentity.ExecutionIdentity;
        const result = yield* identity.resolve({
          nativeId: "codex-app-child-uuid",
          driver: "codex",
        });
        assert.strictEqual(result.robobThreadId, "t-app-child");
        assert.notStrictEqual(result.executionKind, "provider-native-child");
        assert.strictEqual(result.executionKind, "app-managed-child");
        assert.strictEqual(result.model?.model, "gpt-6.1-sol");
      }),
    ),
  );

  it.effect("reports an old unnamed provider thread as unavailable even if recently written", () =>
    runStaleOnly(
      Effect.gen(function* () {
        const identity = yield* ExecutionIdentity.ExecutionIdentity;
        // The only codex row was created in January; its updated_at is now.
        // Newest-updated must not decide the window: this is unavailable.
        const stale = yield* identity.resolve({
          nativeId: "22222222-3333-4444-5555-666666666666",
          driver: "codex",
        });
        assert.strictEqual(stale.resolution, "unavailable");
      }),
    ),
  );

  it.effect("reports a UUID with a fresh unnamed provider thread as pending", () =>
    run(
      Effect.gen(function* () {
        const identity = yield* ExecutionIdentity.ExecutionIdentity;
        const pending = yield* identity.resolve({
          nativeId: "11111111-2222-3333-4444-555555555555",
          driver: "codex",
        });
        assert.strictEqual(pending.resolution, "pending");
        assert.strictEqual(pending.robobThreadId, null);
      }),
    ),
  );

  it.effect("reports an unknown UUID with no fresh provider thread as unavailable", () =>
    run(
      Effect.gen(function* () {
        const identity = yield* ExecutionIdentity.ExecutionIdentity;
        const unknown = yield* identity.resolve({
          nativeId: "11111111-2222-3333-4444-555555555555",
          driver: "claudeAgent",
        });
        assert.strictEqual(unknown.resolution, "unavailable");
        // Not a UUID: never pending, whatever is fresh.
        const old = yield* identity.resolve({ nativeId: "ses_never_seen" });
        assert.strictEqual(old.resolution, "unavailable");
      }),
    ),
  );
});
