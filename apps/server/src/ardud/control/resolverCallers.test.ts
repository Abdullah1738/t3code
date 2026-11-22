import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthSessionId,
  ControlErrorBody,
  NodeId,
  RuntimeRequestId,
  RunId,
  TurnItemId,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as SqlClient from "effect/sql/SqlClient";
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { createPendingAttachmentId } from "../../attachmentStore.ts";
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
const decodeError = Schema.decodeUnknownSync(ControlErrorBody);
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

const makeHarness = (
  mode: "off" | "dryrun" | "apply" | "absent",
  base: ModelSelection = legacy,
  cutoverComplete = false,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const infrastructure = yield* Layer.build(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-control-model-routing" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    const config = Context.get(infrastructure, ServerConfig.ServerConfig);
    const fileSystem = Context.get(infrastructure, FileSystem.FileSystem);
    const path = Context.get(infrastructure, Path.Path);
    const attachmentIoFailure = yield* Ref.make<"stat" | "copy" | undefined>(undefined);
    const claimFileSystem: FileSystem.FileSystem = {
      ...fileSystem,
      stat: (file) =>
        Ref.get(attachmentIoFailure).pipe(
          Effect.flatMap((failure) =>
            fileSystem.stat(failure === "stat" ? `${file}.missing` : file),
          ),
        ),
      copyFile: (from, to) =>
        Ref.get(attachmentIoFailure).pipe(
          Effect.flatMap((failure) =>
            fileSystem.copyFile(failure === "copy" ? `${from}.missing` : from, to),
          ),
        ),
    };
    const stageAttachment = Effect.gen(function* () {
      const id = createPendingAttachmentId();
      yield* fileSystem.writeFile(
        path.join(config.attachmentsDir, `${id}.png`),
        new Uint8Array([1, 2, 3]),
      );
      return {
        attachmentId: id,
        type: "image" as const,
        name: "image.png",
        mimeType: "image/png",
        sizeBytes: 3,
      };
    });
    const shell = {
      ...liveThreadShell(ThreadId.make("thread")),
      providerInstanceId: base.instanceId,
      modelSelection: base,
    };
    const projection = idleThreadProjection(shell);
    const sendFailure = yield* Ref.make<ThreadManagementService.ThreadManagementError | undefined>(
      undefined,
    );
    const startupFailure = yield* Ref.make(false);
    const missingThread = yield* Ref.make(false);
    const requests = yield* Ref.make<ReadonlyArray<OrchestrationV2RuntimeRequest>>([]);
    const turnItems = yield* Ref.make<ReadonlyArray<OrchestrationV2TurnItem>>([]);
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
                  getThreadShell: () =>
                    Ref.get(missingThread).pipe(Effect.map((missing) => (missing ? null : shell))),
                  getThreadRecords: () =>
                    Effect.gen(function* () {
                      return {
                        ...projection,
                        runtimeRequests: yield* Ref.get(requests),
                        turnItems: yield* Ref.get(turnItems),
                      };
                    }),
                  sendToThread: (input) =>
                    Effect.gen(function* () {
                      const failure = yield* Ref.get(sendFailure);
                      if (failure !== undefined) return yield* failure;
                      yield* record("send", input);
                      return {
                        message: { id: input.messageId, attachments: [] },
                        run: { id: "run", status: "queued" },
                        delivery: "queued",
                      } as never;
                    }),
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
                  ...(mode === "absent"
                    ? {}
                    : { ardudHarnessMigration: { selections: mode, cutoverComplete } }),
                  defaultModelSelection: base,
                }),
                Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({
                  enqueueCommand: (effect) =>
                    Effect.gen(function* () {
                      if (yield* Ref.get(startupFailure))
                        return yield* new ServerRuntimeStartup.ServerRuntimeStartupError({
                          mode: "desktop",
                          host: null,
                          port: 3773,
                          cause: new Error("not ready"),
                        });
                      return yield* effect;
                    }),
                }),
                Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({}),
                Layer.mock(ServerSecretStore.ServerSecretStore)({}),
                Layer.succeed(ServerConfig.ServerConfig, config),
                Layer.succeed(FileSystem.FileSystem, claimFileSystem),
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
    return {
      request,
      calls,
      shell,
      sendFailure,
      startupFailure,
      missingThread,
      requests,
      turnItems,
      attachmentIoFailure,
      stageAttachment,
    };
  });

const run = <A, E>(
  mode: "off" | "dryrun" | "apply",
  body: (h: Effect.Success<ReturnType<typeof makeHarness>>) => Effect.Effect<A, E>,
  cutoverComplete = false,
) =>
  Effect.scoped(Effect.flatMap(makeHarness(mode, legacy, cutoverComplete), body)).pipe(
    Effect.provide(Sqlite.layerMemory),
  );

describe("control resolver routes", () => {
  it.effect(
    "resume-launch requires the existing correlated thread and reuses the create input",
    () =>
      run("off", ({ request, calls, shell, missingThread }) =>
        Effect.gen(function* () {
          const clientRequestId = "mac-guard-partial";
          const threadId = `ardud-control:thread:${encodeURIComponent(clientRequestId)}`;
          const route = `/threads/${encodeURIComponent(threadId)}/resume-launch`;
          const body = {
            projectId: shell.projectId,
            clientRequestId,
            prompt: " full safety prompt\n",
          };
          for (const invalid of [undefined, "other", null, false, 12, []]) {
            assert.equal(
              (yield* request("POST", route, { ...body, clientRequestId: invalid })).status,
              400,
            );
          }
          assert.isEmpty(yield* Ref.get(calls));
          yield* Ref.set(missingThread, true);
          assert.equal((yield* request("POST", route, body)).status, 404);
          assert.isEmpty(yield* Ref.get(calls));
          yield* Ref.set(missingThread, false);
          assert.equal((yield* request("POST", "/threads", body)).status, 201);
          assert.equal((yield* request("POST", route, body)).status, 201);
          const recorded = yield* Ref.get(calls);
          assert.equal(recorded.length, 2);
          assert.equal(recorded[0]?.kind, "launch");
          assert.deepEqual(recorded[0], recorded[1]);
          assert.equal(
            (recorded[1]?.value as { initialMessage: { text: string } }).initialMessage.text,
            "full safety prompt",
          );
        }),
      ),
  );

  it.effect(
    "create, send and settings infer OpenCode from a provider/model with a Claude default and no migration flag",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { request, calls, shell } = yield* makeHarness("absent", {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-opus-5-5",
          });
          for (const providerInstanceId of [undefined, "claudeAgent"]) {
            const model = {
              model: legacy.model,
              variant: "high",
              ...(providerInstanceId ? { providerInstanceId } : {}),
            };
            assert.strictEqual(
              (yield* request("POST", "/threads", { projectId: shell.projectId, ...model })).status,
              201,
            );
            assert.strictEqual(
              (yield* request("POST", "/threads/thread/send", { text: "hello", ...model })).status,
              200,
            );
            assert.strictEqual((yield* request("PATCH", "/threads/thread", model)).status, 200);
          }
          const recorded = yield* Ref.get(calls);
          assert.strictEqual(recorded.length, 6);
          recorded.forEach((item, index) =>
            assert.deepStrictEqual((item.value as { modelSelection: unknown }).modelSelection, {
              instanceId: index < 3 ? "opencode" : "claudeAgent",
              model: legacy.model,
              options: [{ id: "variant", value: "high" }],
            }),
          );
        }),
      ).pipe(Effect.provide(Sqlite.layerMemory)),
  );

  it.effect("refuses explicit OpenCode models after cutover before create, send or PATCH", () =>
    run(
      "off",
      ({ request, calls, shell }) =>
        Effect.gen(function* () {
          for (const [method, path, body] of [
            ["POST", "/threads", { projectId: shell.projectId, model: legacy.model }],
            ["POST", "/threads/thread/send", { text: "hi", model: legacy.model }],
            ["PATCH", "/threads/thread", { model: legacy.model }],
          ] as const) {
            const response = yield* request(method, path, body);
            assert.strictEqual(response.status, 400);
            assert.include(JSON.stringify(response.body), "claudeAgent/claude-opus-5-5");
          }
          assert.deepStrictEqual(yield* Ref.get(calls), []);
        }),
      true,
    ),
  );

  it.effect("maps inherited legacy defaults and sends after cutover without an apply flag", () =>
    run(
      "off",
      ({ request, calls, shell }) =>
        Effect.gen(function* () {
          assert.strictEqual(
            (yield* request("POST", "/threads", { projectId: shell.projectId })).status,
            201,
          );
          assert.strictEqual(
            (yield* request("POST", "/threads/thread/send", { text: "hi" })).status,
            200,
          );
          const recorded = yield* Ref.get(calls);
          assert.strictEqual(recorded.length, 2);
          for (const item of recorded) {
            assert.deepStrictEqual(
              (item.value as { modelSelection: unknown }).modelSelection,
              native,
            );
          }
        }),
      true,
    ),
  );

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

describe("control conflict responses", () => {
  it.effect.each(["send", "create"] as const)(
    "%s separates attachment validation from I/O failures",
    (route) =>
      run("off", ({ request, calls, shell, stageAttachment, attachmentIoFailure }) =>
        Effect.gen(function* () {
          const attachment = yield* stageAttachment;
          const file = {
            attachmentId: "file",
            type: "file" as const,
            name: "file.txt",
            mimeType: "text/plain",
            sizeBytes: 1,
          };
          const cases = [
            { name: "duplicate ids", attachments: [attachment, attachment], message: "Duplicate" },
            {
              name: "file count",
              attachments: Array.from({ length: 101 }, (_, i) => ({
                ...file,
                attachmentId: `file-${i}`,
              })),
              message: "100 files",
            },
            {
              name: "total image size",
              attachments: Array.from({ length: 9 }, (_, i) => ({
                ...attachment,
                attachmentId: `image-${i}`,
                sizeBytes: 10 * 1024 * 1024,
              })),
              message: "80 MiB",
            },
            {
              name: "expired upload",
              attachments: [{ ...attachment, attachmentId: createPendingAttachmentId() }],
              message: "removed or expired",
            },
            {
              name: "stored size",
              attachments: [{ ...attachment, sizeBytes: 4 }],
              message: "stored size",
            },
            {
              name: "upload type",
              attachments: [{ ...attachment, mimeType: "image/jpeg" }],
              message: "type does not match",
            },
          ];
          for (const test of cases) {
            const response = yield* request(
              "POST",
              route === "send" ? "/threads/thread/send" : "/threads",
              {
                projectId: shell.projectId,
                text: "keep",
                prompt: "keep",
                attachments: test.attachments,
                clientRequestId: `${route}-${test.name}`,
              },
            );
            assert.equal(response.status, 400, test.name);
            assert.equal(response.body.error.code, "invalid_request", test.name);
            assert.include(response.body.error.message, test.message, test.name);
          }
          for (const failure of ["stat", "copy"] as const) {
            yield* Ref.set(attachmentIoFailure, failure);
            const response = yield* request(
              "POST",
              route === "send" ? "/threads/thread/send" : "/threads",
              {
                projectId: shell.projectId,
                text: "keep",
                prompt: "keep",
                attachments: [attachment],
                clientRequestId: `${route}-${failure}`,
              },
            );
            assert.equal(response.status, 500, failure);
            assert.equal(response.body.error.code, "internal", failure);
            assert.isUndefined(response.body.error.retrySafe, failure);
          }
          assert.isEmpty(yield* Ref.get(calls));
        }),
      ),
  );

  it.effect.each(["resolved", "expired", "cancelled"] as const)(
    "a %s request reports a terminal refusal without dispatching",
    (status) =>
      run("off", ({ request, calls, requests, turnItems, shell }) =>
        Effect.gen(function* () {
          const requestId = RuntimeRequestId.make("old-question");
          const now = DateTime.makeUnsafe("2026-11-16T11:49:00Z");
          yield* Ref.set(requests, [
            {
              id: requestId,
              nodeId: NodeId.make("old-node"),
              providerTurnId: null,
              nativeRequestRef: null,
              kind: "user_input",
              status,
              responseCapability: { type: "message" },
              createdAt: now,
              resolvedAt: now,
            },
          ]);
          const runId = RunId.make("request-run");
          yield* Ref.set(turnItems, [
            {
              id: TurnItemId.make("request-item"),
              type: "user_input_request",
              requestId,
              questions: [],
              threadId: shell.id,
              runId,
              nodeId: NodeId.make("old-node"),
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 0,
              status: "completed",
              title: null,
              startedAt: now,
              completedAt: now,
              updatedAt: now,
            },
          ]);
          const response = yield* request("POST", `/threads/thread/requests/${requestId}/respond`, {
            answers: { question: "yes" },
            clientRequestId: "respond-id",
          });
          assert.equal(response.status, 409);
          const error = decodeError(response.body.error);
          assert.deepInclude(error, {
            reason: "request_resolved",
            retrySafe: false,
            holder: { threadId: shell.id, runId, status, requestId },
          });
          assert.isEmpty(yield* Ref.get(calls));
        }),
      ),
  );

  it.effect.each(["starting", "failed", "completed"])(
    "steer reports the observed %s holder without saving input",
    (status) =>
      run("off", ({ request, calls, sendFailure, shell }) =>
        Effect.gen(function* () {
          const holder = { threadId: shell.id, runId: "observed", status };
          yield* Ref.set(
            sendFailure,
            new ThreadManagementService.ThreadManagementNoSteerableRunError({
              threadId: shell.id,
              mode: "steer",
              holder,
            }),
          );
          const response = yield* request("POST", "/threads/thread/send", {
            text: "keep this",
            mode: "steer",
            clientRequestId: "same-id",
          });
          assert.equal(response.status, 409);
          const error = decodeError(response.body.error);
          assert.deepInclude(error, {
            code: "conflict",
            reason: "no_steerable_turn",
            retrySafe: true,
            holder,
          });
          assert.isEmpty(yield* Ref.get(calls));
        }),
      ),
  );

  it.effect("startup and storage failures do not masquerade as conflicts", () =>
    run("off", ({ request, calls, startupFailure, sendFailure, shell }) =>
      Effect.gen(function* () {
        yield* Ref.set(startupFailure, true);
        const startup = yield* request("POST", "/threads/thread/send", {
          text: "keep",
          clientRequestId: "startup",
        });
        assert.equal(startup.status, 503);
        assert.equal(startup.body.error.reason, "startup_unavailable");
        assert.equal(startup.body.error.retrySafe, true);
        yield* Ref.set(startupFailure, false);
        yield* Ref.set(
          sendFailure,
          new ThreadManagementService.ThreadManagementProjectionLoadError({
            projectId: shell.projectId,
            threadId: shell.id,
            cause: new Error("storage"),
          }),
        );
        const storage = yield* request("POST", "/threads/thread/send", {
          text: "keep",
          clientRequestId: "storage",
        });
        assert.equal(storage.status, 500);
        assert.isUndefined(storage.body.error.retrySafe);
        assert.isEmpty(yield* Ref.get(calls));
      }),
    ),
  );
});
