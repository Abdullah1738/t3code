import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AnalyticsEvent,
  AuthSessionId,
  CommandId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as SqlClient from "effect/sql/SqlClient";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import { liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import * as CommandPolicy from "../../orchestration-v2/CommandPolicy.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProviderSessionManager from "../../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import { userFacingDispatchErrorMessage } from "../../orchestration-v2/UserFacingErrors.ts";
import * as OrchestrationEventStore from "../../persistence/OrchestrationEventStore.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerRuntimeStartup from "../../serverRuntimeStartup.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as Analytics from "../analytics/Analytics.ts";
import { CONTROL_REQUEST_ID_HEADER } from "./ControlRequestAnalytics.ts";
import { CONTROL_ROUTE_PREFIX, controlRouteLayer } from "./http.ts";

const threadId = ThreadId.make("thread:control-send-logging");
const commandId = CommandId.make("command:control-send-logging");
const shell = liveThreadShell(threadId);
const clientRequestId = "send-logging-request";
const privateText = "PRIVATE_MESSAGE_DO_NOT_LOG";
const privateGuidance = "PRIVATE_GUIDANCE_DO_NOT_LOG";
const privateAttachment = "PRIVATE_ATTACHMENT_DO_NOT_LOG";
const credential = "PRIVATE_CREDENTIAL_DO_NOT_LOG";
const route = `${CONTROL_ROUTE_PREFIX}/threads/:threadId/send`;
const decodeAnalyticsEvent = Schema.decodeUnknownSync(AnalyticsEvent, {
  onExcessProperty: "error",
});

type SendEffect = ReturnType<ThreadManagementService.ThreadManagementServiceShape["sendToThread"]>;

const withHarness = <A, E>(
  options: {
    readonly send?: SendEffect;
    readonly unauthorized?: boolean;
    readonly analytics?: boolean;
  },
  test: (h: {
    readonly post: (body: string, path?: string, signal?: AbortSignal) => Effect.Effect<Response>;
    readonly logs: unknown[];
    readonly samples: AnalyticsEvent[];
    readonly sent: () => number;
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const logs: unknown[] = [];
    const samples: AnalyticsEvent[] = [];
    let sent = 0;
    const logger = Logger.layer([Logger.make(({ message }) => logs.push(message))], {
      mergeWithExisting: false,
    });
    const dependencies = Layer.mergeAll(
      Layer.mock(EnvironmentAuth.EnvironmentAuth)({
        authenticateHttpRequest: () =>
          options.unauthorized
            ? Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError({}))
            : Effect.succeed({
                sessionId: AuthSessionId.make("logging-session"),
                subject: "logging-test",
                method: "bearer-access-token" as const,
                scopes: ["orchestration:read", "orchestration:operate"],
              }),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(shell),
        sendToThread: () => {
          sent += 1;
          return (
            options.send ??
            Effect.fail(
              new ThreadManagementService.ThreadManagementNoSteerableRunError({
                threadId,
                mode: "steer",
              }),
            )
          );
        },
      }),
      Layer.mock(ProjectService.ProjectService)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/test" }),
      Layer.mock(ProviderRegistry.ProviderRegistry)({}),
      ServerSettings.layerTest(),
      Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({
        enqueueCommand: <V, F>(effect: Effect.Effect<V, F>) => effect,
      }),
      Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({}),
      Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
      Layer.mock(Orchestrator.OrchestratorV2)({}),
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ServerSecretStore.ServerSecretStore)({}),
      ServerConfig.layerTest(process.cwd(), { prefix: "control-send-logging" }),
      Layer.succeed(SqlClient.SqlClient, sql),
      ...(options.analytics === false
        ? []
        : [
            Layer.mock(Analytics.Analytics)({
              record: (event) =>
                Effect.sync(() => {
                  samples.push(event);
                }),
            }),
          ]),
    ).pipe(Layer.provideMerge(NodeServices.layer));
    const web = yield* Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          controlRouteLayer.pipe(
            Layer.provide(dependencies),
            Layer.provideMerge(logger),
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
    const result = yield* test({
      logs,
      samples,
      sent: () => sent,
      post: (body, path = `/threads/${threadId}/send`, signal) =>
        Effect.promise(() =>
          web.handler(
            new Request(`http://env.local${CONTROL_ROUTE_PREFIX}${path}`, {
              method: "POST",
              headers: {
                authorization: `Bearer ${credential}`,
                "content-type": "application/json",
              },
              body,
              ...(signal === undefined ? {} : { signal }),
            }),
          ),
        ),
    });
    const recorded = JSON.stringify({ logs, samples });
    for (const secret of [privateText, privateGuidance, privateAttachment, credential]) {
      assert.notInclude(recorded, secret);
    }
    return result;
  }).pipe(Effect.scoped, Effect.provide(Sqlite.layerMemory));

const body = JSON.stringify({ text: privateText, mode: "steer", clientRequestId });

const rejection = (logs: readonly unknown[]) => {
  const rows = logs.filter(
    (entry): entry is [string, Record<string, unknown>] =>
      Array.isArray(entry) && entry[0] === "ardud control request rejected",
  );
  assert.lengthOf(rows, 1);
  return rows[0]![1];
};

const invariantRefusals = [
  [
    "Context compaction must run as a separate turn. Queue it or wait for the active turn to finish.",
    "compaction_requires_separate_turn",
  ],
  [
    "Signing out must run as a separate turn. Queue it or wait for the active turn to finish.",
    "sign_out_requires_separate_turn",
  ],
  [
    "Goal commands must run as a separate turn. Queue it or wait for the active turn to finish.",
    "goal_requires_separate_turn",
  ],
  [
    "Wait for context compaction to finish before steering the thread.",
    "context_compaction_in_progress",
  ],
  ["Wait for sign-out to finish before steering the thread.", "sign_out_in_progress"],
  ["Active-turn-only steering cannot restart the turn.", "active_turn_only_restart_forbidden"],
  ["Silent child recovery is no longer safe or was already attempted.", "silent_recovery_not_safe"],
  ["The active ACP session does not expose a model-switch capability.", "model_switch_unsupported"],
] as const;

const capabilityRefusals = [
  ["queued_messages", "unsupported_queued_messages"],
  ["active_steering", "unsupported_active_steering"],
  ["interrupt", "unsupported_interrupt"],
  ["interrupt_restart_steering", "unsupported_interrupt_restart_steering"],
  ["native_fork", "unsupported_native_fork"],
  ["fork_from_turn", "unsupported_fork_from_turn"],
  ["rollback", "unsupported_rollback"],
  ["rollback_snapshot", "unsupported_rollback_snapshot"],
  ["context_handoff", "unsupported_context_handoff"],
  ["strong_terminal_status", "unsupported_strong_terminal_status"],
] as const satisfies ReadonlyArray<readonly [CommandPolicy.CommandPolicyCapability, string]>;

describe("control send refusal logging", () => {
  it.effect("records the typed no-steerable-run reason once with request correlation", () =>
    withHarness({}, ({ post, logs, samples, sent }) =>
      Effect.gen(function* () {
        const response = yield* post(body);
        assert.equal(response.status, 409);
        assert.equal(sent(), 1);
        assert.deepInclude(rejection(logs), {
          httpRoute: route,
          httpMethod: "POST",
          threadId,
          mode: "steer",
          clientRequestId,
          status: 409,
          code: "conflict",
          errorTag: "ThreadManagementNoSteerableRunError",
          reason: "no_steerable_run",
        });
        assert.isAtLeast(rejection(logs).durationMs as number, 0);
        assert.equal(rejection(logs).requestId, response.headers.get(CONTROL_REQUEST_ID_HEADER));
        assert.lengthOf(samples, 1);
        assert.deepEqual(decodeAnalyticsEvent(samples[0]), samples[0]);
        assert.deepInclude(samples[0]!.props, {
          httpRoute: route,
          status: 409,
          code: "conflict",
          errorTag: "ThreadManagementNoSteerableRunError",
          reason: "no_steerable_run",
        });
        assert.equal(samples[0]!.durationMs, rejection(logs).durationMs);
        assert.equal(samples[0]!.props?.requestId, rejection(logs).requestId);
      }),
    ),
  );

  it.effect.each([
    ...invariantRefusals.flatMap(([detail, reason]) => [
      {
        cause: new Orchestrator.OrchestratorDispatchError({
          commandId,
          commandType: "message.dispatch",
          cause: detail,
        }),
        errorTag: "OrchestratorDispatchError",
        reason,
      },
      {
        cause: new Orchestrator.OrchestratorCommandPreviouslyRejectedError({
          commandId,
          commandType: "message.dispatch",
          detail,
        }),
        errorTag: "OrchestratorCommandPreviouslyRejectedError",
        reason,
      },
    ]),
    ...capabilityRefusals.map(([capability, reason]) => ({
      cause: new Orchestrator.OrchestratorCommandPreviouslyRejectedError({
        commandId,
        commandType: "message.dispatch",
        detail:
          userFacingDispatchErrorMessage(
            new CommandPolicy.CommandPolicyCapabilityUnsupportedError({
              commandId,
              threadId,
              providerInstanceId: ProviderInstanceId.make(privateAttachment),
              capability,
              detail: privateGuidance,
            }),
          ) ?? privateText,
      }),
      errorTag: "OrchestratorCommandPreviouslyRejectedError",
      reason,
    })),
    {
      cause: new Orchestrator.OrchestratorCommandPreviouslyRejectedError({
        commandId,
        commandType: "message.dispatch",
        detail: `${privateAttachment} cannot deliver a message that way right now.`,
      }),
      errorTag: "OrchestratorCommandPreviouslyRejectedError",
      reason: "dispatch_mode_unsupported",
    },
    ...[
      ...capabilityRefusals.map(([capability, reason]) => ({
        cause: new CommandPolicy.CommandPolicyCapabilityUnsupportedError({
          commandId,
          threadId,
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          capability,
          detail: privateGuidance,
        }),
        errorTag: "CommandPolicyCapabilityUnsupportedError",
        reason,
      })),
      ...(
        [
          ["steer_active", "steer_target_not_active"],
          ["restart_active", "restart_target_not_active"],
          [privateText, "dispatch_mode_unsupported"],
        ] as const
      ).map(([requestedMode, reason]) => ({
        cause: new CommandPolicy.CommandPolicyUnsupportedError({
          commandId,
          threadId,
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          requestedMode,
        }),
        errorTag: "CommandPolicyUnsupportedError",
        reason,
      })),
      {
        cause: { _tag: "CommandPolicyCapabilityUnsupportedError", capability: privateText },
        errorTag: "CommandPolicyCapabilityUnsupportedError",
        reason: "capability_unsupported",
      },
    ].flatMap(({ cause, ...expected }) => [
      {
        cause: new Orchestrator.OrchestratorDispatchError({
          commandId,
          commandType: "message.dispatch",
          cause,
        }),
        ...expected,
      },
      {
        cause: new Orchestrator.OrchestratorCommandRejectedError({
          commandId,
          commandType: "message.dispatch",
          cause: new CommandPolicy.CommandPolicyMessageDispatchError({
            commandId,
            threadId,
            cause,
          }),
        }),
        ...expected,
      },
    ]),
    ...(
      [
        ["No running provider turn found for active run old-run.", "no_running_provider_turn"],
        [
          "No running providerInstanceId turn found for active run old-run.",
          "no_running_provider_turn",
        ],
        [privateText, "message_dispatch_failed"],
      ] as const
    ).map(([cause, reason]) => ({
      cause: new Orchestrator.OrchestratorCommandRejectedError({
        commandId,
        commandType: "message.dispatch",
        cause: new CommandPolicy.CommandPolicyMessageDispatchError({ commandId, threadId, cause }),
      }),
      errorTag: "CommandPolicyMessageDispatchError",
      reason,
    })),
  ])("records $errorTag / $reason through the send route", ({ cause, errorTag, reason }) =>
    withHarness({ send: Effect.fail(cause) }, ({ post, logs, samples }) =>
      Effect.gen(function* () {
        assert.equal((yield* post(body)).status, 409);
        assert.deepInclude(rejection(logs), {
          httpRoute: route,
          threadId,
          mode: "steer",
          clientRequestId,
          status: 409,
          code: "conflict",
          errorTag,
          reason,
        });
        assert.lengthOf(samples, 1);
        assert.deepEqual(decodeAnalyticsEvent(samples[0]), samples[0]);
        assert.deepInclude(samples[0]!.props, { errorTag, reason });
      }),
    ),
  );

  it.effect.each([
    {
      cause: new Orchestrator.OrchestratorCommandIdConflictError({
        commandId,
        commandType: "message.dispatch",
        receiptThreadId: ThreadId.make("other"),
        commandThreadId: threadId,
      }),
      errorTag: "OrchestratorCommandIdConflictError",
      reason: "command_id_conflict",
    },
    {
      cause: new Orchestrator.OrchestratorDispatchError({
        commandId,
        commandType: "message.dispatch",
        cause: "Target run old-run is stopping and cannot be steered.",
      }),
      errorTag: "OrchestratorDispatchError",
      reason: "run_stopping",
    },
    {
      cause: new Orchestrator.OrchestratorDispatchError({
        commandId,
        commandType: "message.dispatch",
        cause: "Target run old-run was not found.",
      }),
      errorTag: "OrchestratorDispatchError",
      reason: "target_run_not_found",
    },
    {
      cause: new Orchestrator.OrchestratorDispatchError({
        commandId,
        commandType: "message.dispatch",
        cause: "Target run old-run is interrupted and cannot be steered.",
      }),
      errorTag: "OrchestratorDispatchError",
      reason: "target_run_not_running",
    },
    {
      cause: new Orchestrator.OrchestratorDispatchError({
        commandId,
        commandType: "message.dispatch",
        cause: "Target run old-run does not belong to thread another-thread.",
      }),
      errorTag: "OrchestratorDispatchError",
      reason: "run_thread_mismatch",
    },
    {
      cause: new Orchestrator.OrchestratorDispatchError({
        commandId,
        commandType: "message.dispatch",
        cause: "No running provider turn found for active run old-run.",
      }),
      errorTag: "OrchestratorDispatchError",
      reason: "no_running_provider_turn",
    },
    {
      cause: new Orchestrator.OrchestratorCommandRejectedError({
        commandId,
        commandType: "message.dispatch",
        cause: new ThreadManagementService.ThreadManagementNoSteerableRunError({
          threadId,
          mode: "steer",
        }),
      }),
      errorTag: "ThreadManagementNoSteerableRunError",
      reason: "no_steerable_run",
    },
    {
      cause: new Orchestrator.OrchestratorCommandPreviouslyRejectedError({
        commandId,
        commandType: "message.dispatch",
        detail: "Target run old-run is stopping and cannot be steered.",
      }),
      errorTag: "OrchestratorCommandPreviouslyRejectedError",
      reason: "run_stopping",
    },
    {
      cause: new Orchestrator.OrchestratorDispatchError({
        commandId,
        commandType: "message.dispatch",
        cause: new Error(privateText),
      }),
      errorTag: "OrchestratorDispatchError",
      reason: "dispatch_failed",
      status: 500,
      code: "internal",
    },
    {
      cause: new Orchestrator.OrchestratorCommandPreviouslyRejectedError({
        commandId,
        commandType: "message.dispatch",
        detail: privateText,
      }),
      errorTag: "OrchestratorCommandPreviouslyRejectedError",
      reason: "previously_rejected",
    },
  ])(
    "keeps $reason distinct without copying rejection text",
    ({ cause, errorTag, reason, status = 409, code = "conflict" }) =>
      withHarness({ send: Effect.fail(cause) }, ({ post, logs, samples }) =>
        Effect.gen(function* () {
          assert.equal((yield* post(body)).status, status);
          assert.deepInclude(rejection(logs), { errorTag, reason, code, status });
          assert.lengthOf(samples, 1);
          assert.deepInclude(samples[0]!.props, { errorTag, reason });
        }),
      ),
  );

  it.effect("logs unknown defects safely when analytics is absent", () =>
    withHarness(
      {
        send: Effect.die({ _tag: privateText, message: privateGuidance, body: privateAttachment }),
        analytics: false,
      },
      ({ post, logs, samples }) =>
        Effect.gen(function* () {
          const response = yield* post(body);
          assert.equal(response.status, 500);
          assert.deepInclude(rejection(logs), {
            httpRoute: route,
            threadId,
            mode: "steer",
            clientRequestId,
            status: 500,
            code: "internal",
            errorTag: "Defect",
            reason: "unexpected_failure",
          });
          assert.isEmpty(samples);
          assert.deepEqual(yield* Effect.promise(() => response.json()), {
            ok: false,
            error: { code: "internal", message: "Internal error." },
          });
        }),
    ),
  );

  it.effect("logs forbidden guidance without logging the guidance or message", () =>
    withHarness({}, ({ post, logs, sent }) =>
      Effect.gen(function* () {
        assert.equal(
          (yield* post(
            JSON.stringify({
              text: privateText,
              guidance: privateGuidance,
              mode: "steer",
              clientRequestId,
            }),
          )).status,
          403,
        );
        assert.deepInclude(rejection(logs), {
          code: "forbidden",
          reason: "forbidden",
          mode: "steer",
          clientRequestId,
        });
        assert.equal(sent(), 0);
      }),
    ),
  );

  it.effect("retains the generated request ID when the caller omits one", () =>
    withHarness({}, ({ post, logs }) =>
      Effect.gen(function* () {
        assert.equal(
          (yield* post(JSON.stringify({ text: privateText, mode: "steer" }))).status,
          409,
        );
        assert.match(
          rejection(logs).clientRequestId as string,
          /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/,
        );
      }),
    ),
  );

  it.effect("logs an attachment refusal without names or attachment payloads", () =>
    withHarness({}, ({ post, logs, sent }) =>
      Effect.gen(function* () {
        const attachment = {
          attachmentId: "duplicate-file",
          name: privateAttachment,
          type: "file",
          mimeType: "text/plain",
          sizeBytes: 1,
        };
        assert.equal(
          (yield* post(
            JSON.stringify({
              text: privateText,
              mode: "steer",
              clientRequestId,
              attachments: [attachment, attachment],
            }),
          )).status,
          400,
        );
        assert.deepInclude(rejection(logs), {
          errorTag: "AttachmentClaimError",
          reason: "duplicate_attachment_id",
          code: "invalid_request",
        });
        assert.equal(sent(), 0);
      }),
    ),
  );

  it.effect.each([
    { raw: `{${privateText}`, mode: null, id: null },
    {
      raw: JSON.stringify({
        text: { [privateText]: privateGuidance },
        attachments: privateAttachment,
        mode: "steer",
        clientRequestId,
      }),
      mode: "steer",
      id: clientRequestId,
    },
    {
      raw: JSON.stringify({
        text: privateText,
        mode: privateGuidance,
        clientRequestId: privateAttachment.repeat(100),
      }),
      mode: null,
      id: null,
    },
  ])("records malformed input safely ($mode)", ({ raw, mode, id }) =>
    withHarness({}, ({ post, logs, sent }) =>
      Effect.gen(function* () {
        assert.equal((yield* post(raw)).status, 400);
        assert.deepInclude(rejection(logs), {
          httpRoute: route,
          threadId,
          mode,
          clientRequestId: id,
          status: 400,
          code: "invalid_request",
          reason: "invalid_request",
        });
        assert.equal(sent(), 0);
      }),
    ),
  );

  it.effect("records authorization failures without reading credentials or the body", () =>
    withHarness({ unauthorized: true }, ({ post, logs, sent }) =>
      Effect.gen(function* () {
        assert.equal((yield* post(body)).status, 401);
        assert.deepInclude(rejection(logs), {
          httpRoute: route,
          threadId,
          mode: null,
          clientRequestId: null,
          status: 401,
          code: "unauthorized",
          reason: "unauthorized",
        });
        assert.equal(sent(), 0);
      }),
    ),
  );

  it.effect("also logs non-send control refusals through the generic handler", () =>
    withHarness({ unauthorized: true }, ({ post, logs }) =>
      Effect.gen(function* () {
        assert.equal((yield* post("{}", `/threads/${threadId}/interrupt`)).status, 401);
        assert.deepInclude(rejection(logs), {
          httpRoute: `${CONTROL_ROUTE_PREFIX}/threads/:threadId/interrupt`,
          threadId,
          status: 401,
          code: "unauthorized",
        });
      }),
    ),
  );

  it.effect("logs an aborted send once with the router's 499 status", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      yield* withHarness(
        { send: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)) },
        ({ post, logs }) =>
          Effect.gen(function* () {
            const abort = new AbortController();
            const response = yield* post(body, undefined, abort.signal).pipe(Effect.forkChild);
            yield* Deferred.await(entered);
            yield* Effect.sync(() => abort.abort());
            assert.equal((yield* Fiber.join(response)).status, 499);
            assert.deepInclude(rejection(logs), {
              httpRoute: route,
              threadId,
              mode: "steer",
              clientRequestId,
              status: 499,
            });
          }),
      );
    }),
  );
});
