import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthSessionId,
  CommandId,
  MessageId,
  NodeId,
  type OrchestrationV2Run,
  ProviderInstanceId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as SqlClient from "effect/sql/SqlClient";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import { idleThreadProjection, liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import { OrchestratorDispatchError } from "../../orchestration-v2/Orchestrator.ts";
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

const threadId = ThreadId.make("thread-interrupt");
const shell = liveThreadShell(threadId, { activeRunId: RunId.make("run-new") });
const date = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
const run = (
  id: string,
  ordinal: number,
  status: OrchestrationV2Run["status"],
): OrchestrationV2Run => ({
  id: RunId.make(id),
  threadId,
  ordinal,
  providerInstanceId: ProviderInstanceId.make("codex"),
  modelSelection: shell.modelSelection,
  providerThreadId: null,
  userMessageId: MessageId.make(`message-${id}`),
  rootNodeId: NodeId.make(`node-${id}`),
  activeAttemptId: RunAttemptId.make(id === "run-new" ? "att-2" : "att-1"),
  status,
  queuePosition: null,
  requestedAt: date,
  startedAt: date,
  completedAt: status === "completed" ? date : null,
  checkpointId: null,
  contextHandoffId: null,
});

type InterruptInput = Parameters<
  ThreadManagementService.ThreadManagementServiceShape["interruptThread"]
>[0];

const makeHarness = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const runs = yield* Ref.make<ReadonlyArray<OrchestrationV2Run>>([
    run("run-old", 1, "running"),
    run("run-new", 2, "running"),
    run("run-done", 0, "completed"),
  ]);
  const calls = yield* Ref.make<ReadonlyArray<InterruptInput>>([]);
  const dispatched = yield* Ref.make<ReadonlyArray<string>>([]);
  const reads = yield* Ref.make(0);
  const readFails = yield* Ref.make(false);
  const threads = Layer.mock(ThreadManagementService.ThreadManagementService)({
    getThreadShell: (id) => Effect.succeed(id === threadId ? shell : null),
    getThreadRecords: () =>
      Effect.gen(function* () {
        yield* Ref.update(reads, (count) => count + 1);
        if (yield* Ref.get(readFails)) {
          return yield* new OrchestratorDispatchError({
            commandId: CommandId.make("command-read"),
            commandType: "run.interrupt",
            cause: new Error("read failed"),
          });
        }
        return { ...idleThreadProjection(shell), runs: yield* Ref.get(runs) };
      }),
    interruptThread: (input) =>
      Effect.gen(function* () {
        yield* Ref.update(calls, (all) => [...all, input]);
        const current = yield* Ref.get(runs);
        const explicit = current.find((candidate) => candidate.id === input.runId);
        if (input.runId !== undefined && explicit === undefined) {
          return yield* new ThreadManagementService.ThreadManagementRunNotFoundError({
            threadId,
            runId: input.runId,
          });
        }
        if (explicit?.status === "completed") {
          return {
            type: "already_terminal" as const,
            run: { ...explicit, status: "completed" as const },
          };
        }
        const active = ThreadManagementService.latestActiveRun({ runs: current });
        if (active === undefined && input.runId === undefined)
          return { type: "no_active_run" as const };
        if (active === undefined || (input.runId !== undefined && active.id !== input.runId)) {
          return yield* new ThreadManagementService.ThreadManagementThreadNotInterruptibleError({
            threadId,
            runId: input.runId!,
          });
        }
        yield* Ref.update(dispatched, (all) => [...all, active.id]);
        return {
          type: "interrupt_requested" as const,
          run: active,
          dispatch: { sequence: 1, storedEvents: [] },
        };
      }),
  });
  const web = yield* Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        controlRouteLayer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(EnvironmentAuth.EnvironmentAuth)({
                authenticateHttpRequest: () =>
                  Effect.succeed({
                    sessionId: AuthSessionId.make("session-cli"),
                    subject: "cli-issued-session",
                    method: "bearer-access-token" as const,
                    scopes: ["orchestration:read", "orchestration:operate"],
                  }),
              }),
              threads,
              Layer.mock(ProjectService.ProjectService)({}),
              Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                namedProjectsRoot: "/tmp/named",
              }),
              Layer.mock(ProviderRegistry.ProviderRegistry)({}),
              ServerSettings.layerTest(),
              Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({
                enqueueCommand: <A, E>(effect: Effect.Effect<A, E>) => effect,
              }),
              Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({}),
              Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
              Layer.mock(ServerSecretStore.ServerSecretStore)({}),
              ServerConfig.layerTest(process.cwd(), { prefix: "t3-control-interrupt" }),
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
  const post = (body: object = {}) =>
    Effect.promise(async () => {
      const response = await web.handler(
        new Request(`http://env.local${CONTROL_ROUTE_PREFIX}/threads/${threadId}/interrupt`, {
          method: "POST",
          headers: { authorization: "Bearer shared", "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      return { status: response.status, body: (await response.json()) as Record<string, any> };
    });
  return { post, runs, calls, dispatched, reads, readFails };
});

const withHarness = <A, E>(body: (h: Effect.Success<typeof makeHarness>) => Effect.Effect<A, E>) =>
  Effect.scoped(Effect.flatMap(makeHarness, body)).pipe(Effect.provide(Sqlite.layerMemory));

describe("control interrupt", () => {
  it.effect("keeps the unguarded behavior", () =>
    withHarness(({ post, calls, dispatched, reads }) =>
      Effect.gen(function* () {
        const response = yield* post({ reason: "stalled" });
        assert.deepStrictEqual(response.body, {
          ok: true,
          threadId,
          interrupted: true,
          result: "interrupt_requested",
          runId: "run-new",
        });
        assert.strictEqual(response.status, 200);
        assert.strictEqual((yield* Ref.get(calls))[0]?.runId, undefined);
        assert.strictEqual((yield* Ref.get(calls))[0]?.reason, "stalled");
        assert.deepStrictEqual(yield* Ref.get(dispatched), ["run-new"]);
        assert.strictEqual(yield* Ref.get(reads), 0);
      }),
    ),
  );

  it.effect("refuses an old nonterminal run without dispatching the new one", () =>
    withHarness(({ post, calls, dispatched }) =>
      Effect.gen(function* () {
        const response = yield* post({ expectedRunId: "run-old" });
        assert.strictEqual(response.status, 409);
        assert.strictEqual(response.body.error.code, "conflict");
        assert.strictEqual((yield* Ref.get(calls))[0]?.runId, "run-old");
        assert.deepStrictEqual(yield* Ref.get(dispatched), []);
      }),
    ),
  );

  it.effect("interrupts the expected active run and matching attempt", () =>
    withHarness(({ post, calls, dispatched }) =>
      Effect.gen(function* () {
        const first = yield* post({ expectedRunId: "run-new" });
        const second = yield* post({ expectedRunId: "run-new", expectedAttemptId: "att-2" });
        assert.strictEqual(first.status, 200);
        assert.strictEqual(second.status, 200);
        assert.strictEqual(first.body.interrupted, true);
        assert.strictEqual(second.body.interrupted, true);
        assert.deepStrictEqual(
          (yield* Ref.get(calls)).map((input) => input.runId),
          [RunId.make("run-new"), RunId.make("run-new")],
        );
        assert.deepStrictEqual(
          (yield* Ref.get(calls)).map((input) => input.attemptId),
          [undefined, RunAttemptId.make("att-2")],
        );
        assert.deepStrictEqual(yield* Ref.get(dispatched), ["run-new", "run-new"]);
      }),
    ),
  );

  it.effect("rejects a mismatched attempt before calling interruptThread", () =>
    withHarness(({ post, calls, dispatched }) =>
      Effect.gen(function* () {
        const response = yield* post({ expectedRunId: "run-new", expectedAttemptId: "att-1" });
        assert.strictEqual(response.status, 409);
        assert.deepStrictEqual(response.body.error, {
          code: "conflict",
          message: "Run run-new is on attempt att-2, not att-1.",
        });
        assert.deepStrictEqual(yield* Ref.get(calls), []);
        assert.deepStrictEqual(yield* Ref.get(dispatched), []);
      }),
    ),
  );

  it.effect("rejects an attempt without a run and empty run IDs", () =>
    withHarness(({ post, calls, reads }) =>
      Effect.gen(function* () {
        const alone = yield* post({ expectedAttemptId: "att-1" });
        assert.strictEqual(alone.status, 400);
        assert.deepStrictEqual(alone.body.error, {
          code: "invalid_request",
          message: "expectedAttemptId needs expectedRunId",
        });
        const blank = yield* post({ expectedRunId: "  " });
        assert.strictEqual(blank.status, 400);
        assert.strictEqual(blank.body.error.code, "invalid_request");
        assert.deepStrictEqual(yield* Ref.get(calls), []);
        assert.strictEqual(yield* Ref.get(reads), 0);
      }),
    ),
  );

  it.effect("preserves terminal and missing run behavior", () =>
    withHarness(({ post, calls, dispatched }) =>
      Effect.gen(function* () {
        const terminal = yield* post({ expectedRunId: "run-done", expectedAttemptId: "different" });
        assert.deepStrictEqual(terminal.body, {
          ok: true,
          threadId,
          interrupted: false,
          result: "already_terminal",
          runId: "run-done",
        });
        assert.strictEqual(terminal.status, 200);
        const missing = yield* post({ expectedRunId: "run-missing", expectedAttemptId: "att-1" });
        assert.strictEqual(missing.status, 409);
        assert.strictEqual(missing.body.error.code, "conflict");
        assert.deepStrictEqual(
          (yield* Ref.get(calls)).map((input) => input.runId),
          [RunId.make("run-done"), RunId.make("run-missing")],
        );
        assert.deepStrictEqual(yield* Ref.get(dispatched), []);
      }),
    ),
  );

  it.effect("does not interrupt if the guard read fails", () =>
    withHarness(({ post, calls, readFails }) =>
      Effect.gen(function* () {
        yield* Ref.set(readFails, true);
        const response = yield* post({ expectedRunId: "run-new" });
        assert.strictEqual(response.status, 500);
        assert.strictEqual(response.body.error.code, "internal");
        assert.deepStrictEqual(yield* Ref.get(calls), []);
      }),
    ),
  );
});
