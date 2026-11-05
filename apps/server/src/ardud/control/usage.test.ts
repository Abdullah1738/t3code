import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthSessionId } from "@t3tools/contracts";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as SqlClient from "effect/sql/SqlClient";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProviderSessionManager from "../../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as OrchestrationEventStore from "../../persistence/OrchestrationEventStore.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerRuntimeStartup from "../../serverRuntimeStartup.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { CONTROL_ROUTE_PREFIX, controlRouteLayer } from "./http.ts";
import * as Usage from "./usage.ts";

const since = "2026-11-01T00:00:00.000Z";
const until = "2026-11-02T00:00:00.000Z";
const at = (hour: number) => `2026-11-01T${String(hour).padStart(2, "0")}:00:00.000Z`;

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES ('p', 'Project', '/project', '[]', ${since}, ${since})`;
  for (const thread of [
    { id: "root", root: "root", parent: null, worktree: null },
    { id: "child", root: "root", parent: "root", worktree: "/project/worktree" },
    { id: "other", root: "other", parent: null, worktree: null },
  ]) {
    yield* sql`INSERT INTO orchestration_v2_projection_threads ${sql.insert({
      thread_id: thread.id,
      project_id: "p",
      title: thread.id,
      default_provider: "codex",
      runtime_mode: "full-access",
      interaction_mode: "default",
      active_provider_thread_id: null,
      created_at: since,
      updated_at: since,
      archived_at: null,
      deleted_at: null,
      payload_json: JSON.stringify({
        lineage: { rootThreadId: thread.root, parentThreadId: thread.parent },
        worktreePath: thread.worktree,
      }),
    })}`;
  }
  yield* sql`INSERT INTO ardud_kanban_threads (thread_id, board_id, card_id, json)
    VALUES ('root', 'board-1', 'card-1', '{}')`;

  for (const source of [
    {
      thread: "child",
      driver: "claudeAgent",
      instance: "claudeAgent",
      model: "claude-opus",
      option: "effort",
      value: "max",
    },
    {
      thread: "other",
      driver: "codex",
      instance: "codex-cu",
      model: "gpt-terra",
      option: "reasoningEffort",
      value: "xhigh",
    },
  ]) {
    const providerThread = `pt-${source.thread}`;
    yield* sql`INSERT INTO orchestration_v2_projection_provider_threads ${sql.insert({
      provider_thread_id: providerThread,
      thread_id: source.thread,
      owner_node_id: null,
      provider: source.driver,
      provider_session_id: null,
      status: "active",
      first_run_ordinal: 1,
      last_run_ordinal: 1,
      updated_at: since,
      driver: source.driver,
      provider_instance_id: source.instance,
      payload_json: "{}",
    })}`;
    yield* sql`INSERT INTO orchestration_v2_projection_runs ${sql.insert({
      run_id: `run-${source.thread}`,
      thread_id: source.thread,
      ordinal: 1,
      provider: source.driver,
      provider_thread_id: providerThread,
      provider_instance_id: source.instance,
      status: "completed",
      requested_at: since,
      completed_at: until,
      payload_json: JSON.stringify({
        modelSelection: {
          instanceId: source.instance,
          model: source.model,
          options: [{ id: source.option, value: source.value }],
        },
      }),
    })}`;
    yield* sql`INSERT INTO orchestration_v2_projection_run_attempts ${sql.insert({
      attempt_id: `attempt-${source.thread}`,
      thread_id: source.thread,
      run_id: `run-${source.thread}`,
      attempt_ordinal: 1,
      root_node_id: "node",
      provider: source.driver,
      provider_thread_id: providerThread,
      provider_turn_id: null,
      provider_instance_id: source.instance,
      status: "completed",
      payload_json: "{}",
    })}`;
    yield* sql`INSERT INTO orchestration_events ${sql.insert({
      event_id: `running-${source.thread}`,
      aggregate_kind: "thread",
      stream_id: source.thread,
      stream_version: 1,
      event_type: "run.updated",
      occurred_at: since,
      actor_kind: "system",
      metadata_json: "{}",
      application_event_version: 2,
      payload_json: JSON.stringify({
        id: `run-${source.thread}`,
        activeAttemptId: `attempt-${source.thread}`,
        status: "running",
        modelSelection: {
          instanceId: source.instance,
          model: source.model,
          options: [{ id: source.option, value: source.value }],
        },
      }),
    })}`;
  }
  for (const turn of [
    {
      id: "a",
      thread: "child",
      start: at(0),
      end: at(1),
      status: "completed",
      usage: {
        usageScope: "main_agent",
        usageStatus: "complete",
        inputTokens: 123,
        cachedInputTokens: 40,
        cacheCreationTokens: 10,
        outputTokens: 22,
        reasoningTokens: 5,
        hasSubagents: true,
      },
    },
    { id: "b", thread: "other", start: at(0), end: at(1), status: "completed", usage: undefined },
    { id: "c", thread: "child", start: at(3), end: null, status: "running", usage: undefined },
    {
      id: "before",
      thread: "child",
      start: "2026-10-30T23:00:00.000Z",
      end: "2026-10-31T00:00:00.000Z",
      status: "completed",
      usage: undefined,
    },
    {
      id: "boundary",
      thread: "child",
      start: at(23),
      end: until,
      status: "completed",
      usage: undefined,
    },
    {
      id: "old-running",
      thread: "child",
      start: "2026-10-31T23:00:00.000Z",
      end: null,
      status: "running",
      usage: undefined,
    },
    {
      id: "not-running",
      thread: "child",
      start: at(4),
      end: null,
      status: "pending",
      usage: undefined,
    },
  ]) {
    yield* sql`INSERT INTO orchestration_v2_projection_provider_turns ${sql.insert({
      provider_turn_id: turn.id,
      thread_id: turn.thread,
      provider_thread_id: `pt-${turn.thread}`,
      node_id: `node-${turn.id}`,
      run_attempt_id: `attempt-${turn.thread}`,
      ordinal:
        turn.id === "a"
          ? 1
          : turn.id === "b"
            ? 1
            : turn.id === "c"
              ? 2
              : turn.id === "before"
                ? 3
                : turn.id === "boundary"
                  ? 4
                  : turn.id === "old-running"
                    ? 5
                    : 6,
      status: turn.status,
      started_at: turn.start,
      completed_at: turn.end,
      payload_json: JSON.stringify({ turnTokenUsage: turn.usage }),
    })}`;
  }
});

const run = <A, E>(body: Effect.Effect<A, E, Usage.Usage | SqlClient.SqlClient | Scope.Scope>) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* seed;
      return yield* body;
    }).pipe(Effect.provide(Usage.layer)),
  ).pipe(Effect.provide(Sqlite.layerMemory));

describe("usage feed", () => {
  it.effect("attributes restarted turns to the selection and instance of each attempt", () =>
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const usage = yield* Usage.Usage;
        // The first attempt was Codex. A restart reused the run for Claude.
        yield* sql`UPDATE orchestration_v2_projection_runs SET
        provider = 'claudeAgent', provider_instance_id = 'claudeAgent', provider_thread_id = 'pt-restarted',
        payload_json = ${JSON.stringify({ modelSelection: { instanceId: "claudeAgent", model: "claude-opus", options: [{ id: "effort", value: "max" }] } })}
        WHERE run_id = 'run-other'`;
        yield* sql`INSERT INTO orchestration_v2_projection_provider_threads ${sql.insert({
          provider_thread_id: "pt-restarted",
          thread_id: "other",
          owner_node_id: null,
          provider: "claudeAgent",
          provider_session_id: null,
          status: "active",
          first_run_ordinal: 1,
          last_run_ordinal: 1,
          updated_at: since,
          driver: "claudeAgent",
          provider_instance_id: "claudeAgent",
          payload_json: "{}",
        })}`;
        yield* sql`INSERT INTO orchestration_v2_projection_run_attempts ${sql.insert({
          attempt_id: "attempt-restarted",
          thread_id: "other",
          run_id: "run-other",
          attempt_ordinal: 2,
          root_node_id: "node-restarted",
          provider: "claudeAgent",
          provider_thread_id: "pt-restarted",
          provider_turn_id: null,
          provider_instance_id: "claudeAgent",
          status: "completed",
          payload_json: "{}",
        })}`;
        yield* sql`INSERT INTO orchestration_v2_projection_provider_turns ${sql.insert({
          provider_turn_id: "restarted",
          thread_id: "other",
          provider_thread_id: "pt-restarted",
          node_id: "node-restarted",
          run_attempt_id: "attempt-restarted",
          ordinal: 1,
          status: "completed",
          started_at: at(2),
          completed_at: at(3),
          payload_json: "{}",
        })}`;
        for (const [index, payload] of [
          {
            id: "run-other",
            activeAttemptId: "attempt-other",
            status: "running",
            modelSelection: {
              instanceId: "codex-cu",
              model: "later-steered-model",
              options: [{ id: "reasoningEffort", value: "high" }],
            },
          },
          {
            id: "run-other",
            activeAttemptId: "attempt-restarted",
            status: "starting",
            modelSelection: { instanceId: "claudeAgent", model: "starting-model" },
          },
          {
            id: "run-other",
            activeAttemptId: "attempt-restarted",
            status: "running",
            modelSelection: {
              instanceId: "claudeAgent",
              model: "claude-opus",
              options: [{ id: "effort", value: "max" }],
            },
          },
        ].entries()) {
          yield* sql`INSERT INTO orchestration_events ${sql.insert({
            event_id: `restart-event-${index}`,
            aggregate_kind: "thread",
            stream_id: "other",
            stream_version: index + 2,
            event_type: "run.updated",
            occurred_at: at(2),
            actor_kind: "system",
            metadata_json: "{}",
            application_event_version: 2,
            payload_json: JSON.stringify(payload),
          })}`;
        }
        const page = yield* usage.list({ since, until });
        const turns = page.items.filter((item) => item.threadId === "other");
        assert.deepStrictEqual(
          turns.map(({ providerInstanceId, driver, model, effort }) => ({
            providerInstanceId,
            driver,
            model,
            effort,
          })),
          [
            {
              providerInstanceId: "codex-cu",
              driver: "codex",
              model: "gpt-terra",
              effort: "xhigh",
            },
            {
              providerInstanceId: "claudeAgent",
              driver: "claudeAgent",
              model: "claude-opus",
              effort: "max",
            },
          ],
        );
        // Missing historical evidence must not fall back to the latest Claude projection.
        yield* sql`UPDATE orchestration_events SET payload_json = json_remove(payload_json, '$.modelSelection')
        WHERE event_id = 'running-other'`;
        const missing = (yield* usage.list({ since, until })).items.find(
          (item) => item.threadId === "other",
        );
        assert.strictEqual(missing?.providerInstanceId, "codex-cu");
        assert.isNull(missing?.model);
        assert.isNull(missing?.effort);
        yield* sql`UPDATE orchestration_events SET payload_json = json_set(payload_json, '$.modelSelection',
            json('{"instanceId":"claudeAgent","model":"wrong-provider"}'))
            WHERE event_id = 'running-other'`;
        const mismatch = (yield* usage.list({ since, until })).items.find(
          (item) => item.threadId === "other",
        );
        assert.strictEqual(mismatch?.providerInstanceId, "codex-cu");
        assert.isNull(mismatch?.model);
      }),
    ),
  );
  it.effect(
    "pages equal timestamps, returns unavailable and running turns, and attributes the root board",
    () =>
      run(
        Effect.gen(function* () {
          const usage = yield* Usage.Usage;
          const first = yield* usage.list({ since, until, limit: "1" });
          assert.strictEqual(first.items.length, 1);
          assert.deepStrictEqual(first.items[0], {
            threadId: "child",
            rootThreadId: "root",
            parentThreadId: "root",
            boardId: "board-1",
            cardId: "card-1",
            workspace: "/project/worktree",
            providerInstanceId: "claudeAgent",
            driver: "claudeAgent",
            model: "claude-opus",
            effort: "max",
            startedAt: at(0),
            completedAt: at(1),
            status: "completed",
            usageStatus: "complete",
            inputTokens: 123,
            cachedInputTokens: 40,
            cacheCreationTokens: 10,
            outputTokens: 22,
            reasoningTokens: 5,
            hasSubagents: true,
          });
          assert.isNotNull(first.nextCursor);
          const second = yield* usage.list({ since, until, limit: "1", cursor: first.nextCursor });
          assert.strictEqual(second.items[0]?.threadId, "other");
          assert.strictEqual(second.items[0]?.workspace, "/project");
          assert.strictEqual(second.items[0]?.providerInstanceId, "codex-cu");
          assert.strictEqual(second.items[0]?.driver, "codex");
          assert.strictEqual(second.items[0]?.model, "gpt-terra");
          assert.strictEqual(second.items[0]?.effort, "xhigh");
          assert.strictEqual(second.items[0]?.usageStatus, "unavailable");
          assert.isNull(second.items[0]?.inputTokens);
          const third = yield* usage.list({ since, until, limit: "1", cursor: second.nextCursor });
          assert.strictEqual(third.items[0]?.status, "running");
          assert.isNull(third.items[0]?.completedAt);
          assert.isNull(third.nextCursor);
          const board = yield* usage.list({ since, until, boardId: "board-1" });
          assert.deepStrictEqual(
            board.items.map((row) => row.status),
            ["completed", "running"],
          );
          assert.deepStrictEqual(
            (yield* usage.list({ since, until, boardId: "other-board" })).items,
            [],
          );
        }),
      ),
  );

  it.effect("rejects oversized windows and invalid or mismatched cursors", () =>
    run(
      Effect.gen(function* () {
        const usage = yield* Usage.Usage;
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(usage.list({ since, until: "2026-11-04T00:00:00.001Z" })),
          ),
        );
        assert.isTrue(
          Exit.isSuccess(
            yield* Effect.exit(usage.list({ since, until: "2026-11-04T00:00:00.000Z" })),
          ),
        );
        assert.isTrue(
          Exit.isFailure(yield* Effect.exit(usage.list({ since, until, cursor: "broken" }))),
        );
        const page = yield* usage.list({ since, until, limit: "1" });
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              usage.list({ since, until, cursor: page.nextCursor, boardId: "board-1" }),
            ),
          ),
        );
      }),
    ),
  );

  it.effect("range queries use both indexes", () =>
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const completed = yield* sql<{
          detail: string;
        }>`EXPLAIN QUERY PLAN SELECT provider_turn_id FROM orchestration_v2_projection_provider_turns INDEXED BY ardud_provider_turns_completed_idx WHERE completed_at >= ${since} AND completed_at < ${until}`;
        const running = yield* sql<{
          detail: string;
        }>`EXPLAIN QUERY PLAN SELECT provider_turn_id FROM orchestration_v2_projection_provider_turns INDEXED BY ardud_provider_turns_running_started_idx WHERE completed_at IS NULL AND status = 'running' AND started_at >= ${since} AND started_at < ${until}`;
        assert.isTrue(
          completed.some(
            (row) =>
              row.detail.includes("SEARCH") &&
              row.detail.includes("ardud_provider_turns_completed_idx"),
          ),
        );
        assert.isTrue(
          running.some(
            (row) =>
              row.detail.includes("SEARCH") &&
              row.detail.includes("ardud_provider_turns_running_started_idx"),
          ),
        );
      }),
    ),
  );

  it.effect("uses the projected child selection when a native subagent has no run", () =>
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const usage = yield* Usage.Usage;
        yield* sql`UPDATE orchestration_v2_projection_provider_turns SET run_attempt_id = NULL WHERE provider_turn_id = 'a'`;
        yield* sql`UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.modelSelection', json('{"instanceId":"claudeAgent","model":"child-model","options":[{"id":"effort","value":"max"}]}'))
        WHERE thread_id = 'child'`;
        const page = yield* usage.list({ since, until, boardId: "board-1" });
        assert.strictEqual(page.items[0]?.model, "child-model");
        assert.strictEqual(page.items[0]?.effort, "max");
        assert.strictEqual(page.items[0]?.boardId, "board-1");
      }),
    ),
  );

  it.effect("HTTP route accepts read scope and rejects tokens without it", () =>
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const web = yield* Effect.acquireRelease(
          Effect.sync(() =>
            HttpRouter.toWebHandler(
              controlRouteLayer.pipe(
                Layer.provide(
                  Layer.mergeAll(
                    Layer.mock(EnvironmentAuth.EnvironmentAuth)({
                      authenticateHttpRequest: (request) =>
                        Effect.succeed({
                          sessionId: AuthSessionId.make("test-session"),
                          subject: "test",
                          method: "bearer-access-token" as const,
                          scopes:
                            request.headers.authorization === "Bearer read"
                              ? ["orchestration:read" as const]
                              : ["orchestration:operate" as const],
                        }),
                    }),
                    Layer.mock(ThreadManagementService.ThreadManagementService)({}),
                    Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
                    Layer.mock(Orchestrator.OrchestratorV2)({}),
                    Layer.mock(ProjectService.ProjectService)({}),
                    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                      namedProjectsRoot: "/tmp/named",
                    }),
                    Layer.mock(ProviderRegistry.ProviderRegistry)({}),
                    ServerSettings.layerTest(),
                    Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({
                      enqueueCommand: (effect) => effect,
                    }),
                    Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({}),
                    Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
                    Layer.mock(ServerSecretStore.ServerSecretStore)({}),
                    ServerConfig.layerTest(process.cwd(), { prefix: "t3-control-usage" }),
                    Layer.succeed(SqlClient.SqlClient, sql),
                  ).pipe(Layer.provideMerge(NodeServices.layer)),
                ),
                Layer.provide(
                  HttpPlatform.layer.pipe(
                    Layer.provideMerge(NodeServices.layer),
                    Layer.provideMerge(Etag.layerWeak),
                  ),
                ),
              ),
              { disableLogger: true },
            ),
          ),
          (handler) => Effect.promise(() => handler.dispose()),
        );
        const request = (token: string, query: string) =>
          Effect.promise(async () => {
            const response = await web.handler(
              new Request(`http://env.local${CONTROL_ROUTE_PREFIX}/usage?${query}`, {
                headers: { authorization: `Bearer ${token}` },
              }),
            );
            return {
              status: response.status,
              body: (await response.json()) as { items?: unknown[] },
            };
          });
        const query = new URLSearchParams({ since, until, boardId: "board-1" }).toString();
        const allowed = yield* request("read", query);
        assert.strictEqual(allowed.status, 200);
        assert.strictEqual(allowed.body.items?.length, 2);
        assert.strictEqual((yield* request("operate", query)).status, 403);
        assert.strictEqual((yield* request("read", "since=invalid")).status, 400);
      }),
    ),
  );
});
