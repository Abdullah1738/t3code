import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthSessionId,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as SqlClient from "effect/sql/SqlClient";
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import { idleThreadProjection, liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
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

const legacy = {
  instanceId: ProviderInstanceId.make("opencode"),
  model: "opus/claude-opus-5-5",
  options: [{ id: "variant", value: "xhigh" }],
} as ModelSelection;
const native = {
  instanceId: "claudeAgent",
  model: "claude-opus-5-5",
  options: [{ id: "effort", value: "xhigh" }],
};
const catalog = [
  {
    instanceId: "claudeAgent",
    driver: "claudeAgent",
    enabled: true,
    installed: true,
    status: "ready",
    models: [
      {
        slug: "claude-opus-5-5",
        name: "Opus",
        capabilities: {
          optionDescriptors: [
            {
              id: "effort",
              label: "Effort",
              type: "select",
              options: ["high", "xhigh", "max"].map((id) => ({ id, label: id })),
            },
            { id: "fastMode", label: "Fast", type: "boolean" },
          ],
        },
      },
    ],
  },
] as unknown as ReadonlyArray<ServerProvider>;

const makeHarness = (mode: "off" | "dryrun" | "apply") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const shell = {
      ...liveThreadShell(ThreadId.make("thread")),
      providerInstanceId: legacy.instanceId,
      modelSelection: legacy,
    };
    const projection = idleThreadProjection(shell);
    const calls = yield* Ref.make<Array<{ kind: string; value: unknown }>>([]);
    const record = (kind: string, value: unknown) =>
      Ref.update(calls, (all) => [...all, { kind, value }]);
    const web = yield* Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          controlRouteLayer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(EnvironmentAuth.EnvironmentAuth)({
                  authenticateHttpRequest: () =>
                    Effect.succeed({
                      sessionId: AuthSessionId.make("test"),
                      subject: "test",
                      method: "bearer-access-token" as const,
                      scopes: ["orchestration:read", "orchestration:operate"],
                    }),
                }),
                Layer.mock(ThreadManagementService.ThreadManagementService)({
                  getThreadShell: () => Effect.succeed(shell),
                  getThreadRecords: () => Effect.succeed(projection),
                  sendToThread: (input) =>
                    record("send", input).pipe(
                      Effect.as({
                        message: { id: input.messageId, attachments: [] },
                        run: { id: "run", status: "queued" },
                        delivery: "queued",
                      } as never),
                    ),
                  dispatch: (command) =>
                    record("dispatch", command).pipe(Effect.as({ sequence: 1 } as never)),
                }),
                Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
                Layer.mock(Orchestrator.OrchestratorV2)({}),
                Layer.mock(ThreadLaunchService.ThreadLaunchService)({
                  launch: (input) =>
                    record("launch", input).pipe(
                      Effect.as({
                        threadId: input.threadId!,
                        projection: {
                          ...projection,
                          thread: { ...projection.thread, modelSelection: input.modelSelection },
                        },
                        resumed: false,
                      }),
                    ),
                }),
                Layer.mock(ProjectService.ProjectService)({
                  getById: () =>
                    Effect.succeed(
                      Option.some({
                        id: shell.projectId,
                        workspaceRoot: "/test",
                        defaultModelSelection: null,
                      } as never),
                    ),
                }),
                Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                  namedProjectsRoot: "/test",
                }),
                Layer.mock(ProviderRegistry.ProviderRegistry)({
                  getProviders: Effect.succeed(catalog),
                }),
                ServerSettings.layerTest({
                  ardudHarnessMigration: { selections: mode },
                  defaultModelSelection: legacy,
                }),
                Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({
                  enqueueCommand: (effect) => effect,
                }),
                Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({}),
                Layer.mock(ServerSecretStore.ServerSecretStore)({}),
                ServerConfig.layerTest(process.cwd(), { prefix: "t3-control-model-routing" }),
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
    const request = (method: string, path: string, body?: unknown) =>
      Effect.promise(async () => {
        const response = await web.handler(
          new Request(`http://env.local${CONTROL_ROUTE_PREFIX}${path}`, {
            method,
            headers: { authorization: "Bearer test", "content-type": "application/json" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        );
        return { status: response.status, body: (await response.json()) as Record<string, any> };
      });
    return { request, calls, shell };
  });

const run = <A, E>(
  mode: "off" | "dryrun" | "apply",
  body: (h: Effect.Success<ReturnType<typeof makeHarness>>) => Effect.Effect<A, E>,
) =>
  Effect.scoped(Effect.flatMap(makeHarness(mode), body)).pipe(Effect.provide(Sqlite.layerMemory));

describe("control resolver routes", () => {
  it.effect.each(["off", "dryrun", "apply"] as const)("create, send and settings use %s", (mode) =>
    run(mode, ({ request, calls, shell }) =>
      Effect.gen(function* () {
        const create = yield* request("POST", "/threads", { projectId: shell.projectId });
        assert.strictEqual(create.status, 201);
        const send = yield* request("POST", "/threads/thread/send", {
          text: "hello",
          mode: "queue",
          model: legacy.model,
        });
        assert.strictEqual(send.status, 200);
        const patch = yield* request("PATCH", "/threads/thread", { model: legacy.model });
        assert.strictEqual(patch.status, 200);
        const recorded = yield* Ref.get(calls);
        assert.strictEqual(recorded.length, 3);
        for (const item of recorded) {
          assert.deepStrictEqual(
            (item.value as { modelSelection: unknown }).modelSelection,
            mode === "apply" ? native : legacy,
          );
        }
      }),
    ),
  );

  it.effect("rejects conflicts and unavailable options before any PATCH mutation", () =>
    run("apply", ({ request, calls }) =>
      Effect.gen(function* () {
        const conflict = yield* request("PATCH", "/threads/thread", {
          runtimeMode: "approval-required",
          model: "opus/claude-opus-5-5#high",
          variant: "max",
        });
        assert.strictEqual(conflict.status, 400);
        const unavailable = yield* request("POST", "/threads/thread/send", {
          text: "hi",
          options: [{ id: "effort", value: "not-offered" }],
        });
        assert.strictEqual(unavailable.status, 400);
        assert.deepStrictEqual(yield* Ref.get(calls), []);
      }),
    ),
  );

  it.effect("passes native options and lists all descriptors", () =>
    run("apply", ({ request, calls }) =>
      Effect.gen(function* () {
        const response = yield* request("POST", "/threads/thread/send", {
          text: "hi",
          providerInstanceId: "claudeAgent",
          model: "claude-opus-5-5",
          options: [
            { id: "effort", value: "max" },
            { id: "fastMode", value: true },
          ],
        });
        assert.strictEqual(response.status, 200);
        const sent = (yield* Ref.get(calls))[0]!.value as { modelSelection: ModelSelection };
        assert.deepStrictEqual(sent.modelSelection.options, [
          { id: "fastMode", value: true },
          { id: "effort", value: "max" },
        ]);
        const listed = yield* request("GET", "/models");
        assert.strictEqual(listed.status, 200);
        assert.deepStrictEqual(
          listed.body.providers[0].models[0].optionDescriptors,
          catalog[0]!.models[0]!.capabilities!.optionDescriptors,
        );
      }),
    ),
  );

  it.effect("handles instance-only updates and explicit clears", () =>
    run("apply", ({ request, calls }) =>
      Effect.gen(function* () {
        assert.strictEqual(
          (yield* request("POST", "/threads/thread/send", {
            text: "hi",
            providerInstanceId: "opencode",
            options: [],
          })).status,
          200,
        );
        const sent = (yield* Ref.get(calls))[0]!.value as { modelSelection: unknown };
        assert.deepStrictEqual(sent.modelSelection, {
          instanceId: "claudeAgent",
          model: "claude-opus-5-5",
        });
        assert.strictEqual(
          (yield* request("PATCH", "/threads/thread", { variant: null })).status,
          200,
        );
        const patch = (yield* Ref.get(calls))[1]!.value as { modelSelection: unknown };
        assert.deepStrictEqual(patch.modelSelection, {
          instanceId: "claudeAgent",
          model: "claude-opus-5-5",
        });
      }),
    ),
  );
});
