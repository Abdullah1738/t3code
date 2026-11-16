import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as CredentialStore from "../mcp/CredentialStore.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProviderSessionManager from "../../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import * as OrchestratorHandlers from "../../mcp/toolkits/orchestrator/handlers.ts";
import { OrchestratorToolkit } from "../../mcp/toolkits/orchestrator/tools.ts";
import * as BackgroundTerminals from "./BackgroundTerminals.ts";

const threadId = ThreadId.make("thread:exec-owner");
const sessionId = ProviderSessionId.make("session:exec");
const credentialId = "mcp-credential:exec";
const instanceId = ProviderInstanceId.make("codex");
const providerThreadId = ProviderThreadId.make("provider-thread:exec");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:exec"),
  requestNamespace: "exec",
  thread: { threadId, providerSessionId: credentialId, providerInstanceId: instanceId },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};

const decodeProviderThread = Schema.decodeUnknownSync(OrchestrationV2ProviderThread);
const unused = () => Effect.die("Unused fake adapter operation");

const fixture = (
  driver = "codex",
  foreign = false,
  staleSession = false,
  credential:
    | "valid"
    | "missing"
    | "foreign_thread"
    | "foreign_provider"
    | "unbound"
    | "other_runtime" = "valid",
  callerScope = scope,
) => {
  const shell = { ...liveThreadShell(threadId), activeProviderThreadId: providerThreadId };
  const thread = idleThreadProjection(shell).thread;
  const providerThread = decodeProviderThread({
    id: providerThreadId,
    providerSessionId: sessionId,
    providerInstanceId: instanceId,
    appThreadId: foreign ? "thread:other" : threadId,
    driver,
    status: "active",
    nativeThreadRef: { driver, nativeId: "native-own", strength: "strong" },
    ownerNodeId: null,
    nativeConversationHeadRef: null,
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    nativeMetadata: {},
    createdAt: shell.createdAt,
    updatedAt: shell.updatedAt,
  });
  const terminals = new Map([["89673", { processId: "89673", command: "sleep 30", osPid: 123 }]]);
  const foreignTerminals = new Map([["11111", { processId: "11111" }]]);
  const stopped: string[] = [];
  const fake: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
    instanceId,
    providerSessionId: sessionId,
    providerSession: {
      id: sessionId,
      driver: ProviderDriverKind.make(driver),
      providerInstanceId: instanceId,
      status: "running",
      cwd: "/workspace",
      model: "test",
      capabilities: CodexProviderCapabilitiesV2,
      createdAt: shell.createdAt,
      updatedAt: shell.updatedAt,
      lastError: null,
    },
    events: Stream.empty,
    ensureThread: unused,
    resumeThread: unused,
    startTurn: unused,
    steerTurn: unused,
    interruptTurn: unused,
    respondToRuntimeRequest: unused,
    readThreadSnapshot: unused,
    rollbackThread: unused,
    forkThread: unused,
    driver: ProviderDriverKind.make(driver),
    listBackgroundTerminals: ({
      providerThread: target,
    }: {
      providerThread: OrchestrationV2ProviderThread;
    }) => {
      assert.equal(target.appThreadId, threadId);
      return Effect.succeed([...terminals.values()]);
    },
    terminateBackgroundTerminal: ({ processId }: { processId: string }) =>
      Effect.sync(() => {
        stopped.push(processId);
        const existed = terminals.delete(processId) || foreignTerminals.delete(processId);
        return { terminated: true, alreadyGone: !existed } as const;
      }),
  };
  const dependencies = Layer.mergeAll(
    Layer.mock(McpProviderSessions.McpProviderSessions)({
      read: (id) => {
        assert.equal(id, threadId);
        return Effect.succeed(
          credential === "missing"
            ? undefined
            : {
                environmentId: callerScope.environmentId,
                threadId:
                  credential === "foreign_thread" ? ThreadId.make("thread:other") : threadId,
                providerSessionId: callerScope.thread!.providerSessionId,
                ...(credential === "unbound"
                  ? {}
                  : {
                      runtimeProviderSessionId:
                        credential === "other_runtime"
                          ? ProviderSessionId.make("session:other")
                          : sessionId,
                    }),
                providerInstanceId:
                  credential === "foreign_provider" ? ProviderInstanceId.make("other") : instanceId,
                endpoint: "http://127.0.0.1/mcp",
                authorizationHeader: "Bearer test-only",
                browserToolsAvailable: false,
              },
        );
      },
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      getThreadRecords: () =>
        Effect.succeed({
          ...idleThreadProjection(shell),
          thread,
          providerThreads: [providerThread],
        }),
    }),
    Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
      get: (id) => {
        assert.equal(id, sessionId);
        return Effect.succeed(staleSession ? Option.none() : Option.some(fake));
      },
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getCallerRow: () => Effect.succeed(shell),
      getThreadShell: () => Effect.succeed(shell),
    }),
    Layer.succeed(McpInvocationContext.McpInvocationContext, callerScope),
  );
  return {
    stopped,
    foreignTerminals,
    dependencies,
    layer: BackgroundTerminals.layer.pipe(Layer.provide(dependencies)),
  };
};

it.effect("accepts the authenticated scope issued by the production MCP registry", () =>
  Effect.gen(function* () {
    const registry = yield* McpSessionRegistry.__testing.make();
    const issued = yield* registry.issue({ threadId, providerInstanceId: instanceId });
    const authenticated = yield* registry.resolve(
      issued.config.authorizationHeader.replace(/^Bearer\s+/, ""),
    );
    assert.isDefined(authenticated);
    assert.notEqual(authenticated!.thread.providerSessionId, sessionId);
    const test = fixture("codex", false, false, "valid", authenticated!);
    yield* Effect.gen(function* () {
      const service = yield* BackgroundTerminals.BackgroundTerminals;
      assert.lengthOf((yield* service.listBackgroundTerminals(authenticated!)).sessions, 1);
      assert.deepEqual(
        yield* service.stopBackgroundTerminal(authenticated!, { sessionId: "89673" }),
        { terminated: true, alreadyGone: false },
      );
      assert.deepEqual(test.stopped, ["89673"]);
    }).pipe(Effect.provide(test.layer));
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeCrypto.layer,
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(scope.environmentId),
        }),
        Layer.mock(CredentialStore.CredentialStore)({
          load: () => Effect.succeed([]),
          insert: () => Effect.void,
          updateLiveness: () => Effect.void,
        }),
        Layer.mock(HttpServer.HttpServer)({
          address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
        }),
      ),
    ),
  ),
);

it.effect(
  "uses distinct credential/runtime ids and stops only owned sessions; unknown and foreign ids are gone",
  () => {
    const test = fixture();
    return Effect.gen(function* () {
      const service = yield* BackgroundTerminals.BackgroundTerminals;
      assert.deepEqual(yield* service.listBackgroundTerminals(scope), {
        sessions: [{ sessionId: "89673", command: "sleep 30", osPid: 123 }],
      });
      assert.deepEqual(yield* service.stopBackgroundTerminal(scope, { sessionId: "11111" }), {
        terminated: true,
        alreadyGone: true,
      });
      assert.deepEqual(test.stopped, []);
      assert.isTrue(test.foreignTerminals.has("11111"));
      assert.deepEqual(yield* service.stopBackgroundTerminal(scope, { sessionId: "89673" }), {
        terminated: true,
        alreadyGone: false,
      });
      assert.deepEqual(yield* service.stopBackgroundTerminal(scope, { sessionId: "89673" }), {
        terminated: true,
        alreadyGone: true,
      });
      assert.deepEqual(test.stopped, ["89673"]);
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect.each([
  "foreign_thread",
  "foreign_credential",
  "foreign_provider",
  "missing_credential",
  "credential_foreign_thread",
  "credential_foreign_provider",
  "unbound",
  "other_runtime",
  "no_capability",
  "no_runtime",
  "claudeAgent",
  "opencode",
  "no_caller",
])("refuses %s before stopping anything", (scenario) => {
  const test = fixture(
    scenario === "claudeAgent" || scenario === "opencode" ? scenario : "codex",
    scenario === "foreign_thread",
    scenario === "no_runtime",
    scenario === "missing_credential"
      ? "missing"
      : scenario === "credential_foreign_thread"
        ? "foreign_thread"
        : scenario === "credential_foreign_provider"
          ? "foreign_provider"
          : scenario === "unbound" || scenario === "other_runtime"
            ? scenario
            : "valid",
  );
  const caller =
    scenario === "no_caller"
      ? { ...scope, thread: undefined }
      : scenario === "foreign_credential"
        ? { ...scope, thread: { ...scope.thread!, providerSessionId: "other-session" } }
        : scenario === "foreign_provider"
          ? {
              ...scope,
              thread: { ...scope.thread!, providerInstanceId: ProviderInstanceId.make("other") },
            }
          : scenario === "no_capability"
            ? { ...scope, capabilities: new Set<McpInvocationContext.McpCapability>() }
            : scope;
  return Effect.gen(function* () {
    const service = yield* BackgroundTerminals.BackgroundTerminals;
    const error = yield* service
      .stopBackgroundTerminal(caller, { sessionId: "89673" })
      .pipe(Effect.flip);
    assert.equal(
      error.code,
      scenario === "no_capability"
        ? "capability_denied"
        : scenario === "no_caller"
          ? "thread_credential_required"
          : scenario === "claudeAgent" || scenario === "opencode"
            ? "not_supported"
            : "provider_unavailable",
    );
    if (scenario === "claudeAgent") assert.include(error.message, "KillShell/TaskStop");
    assert.deepEqual(test.stopped, []);
  }).pipe(Effect.provide(test.layer));
});

it.effect("MCP decodes inputs and uses the real service with a fake adapter", () => {
  const test = fixture();
  return Effect.gen(function* () {
    const toolkit = yield* OrchestratorToolkit;
    const listed = yield* toolkit
      .handle("t3_exec_sessions", {})
      .pipe(Stream.unwrap, Stream.runCollect);
    assert.isFalse(listed.at(-1)?.isFailure);
    assert.deepEqual(listed.at(-1)?.result, {
      sessions: [{ sessionId: "89673", command: "sleep 30", osPid: 123 }],
    });
    const stopped = yield* toolkit
      .handle("t3_exec_session_stop", { sessionId: "89673" })
      .pipe(Stream.unwrap, Stream.runCollect);
    assert.isFalse(stopped.at(-1)?.isFailure);
    assert.deepEqual(stopped.at(-1)?.result, { terminated: true, alreadyGone: false });
    assert.deepEqual(test.stopped, ["89673"]);
    const invalid = yield* toolkit
      .handle("t3_exec_session_stop", { sessionId: "not-a-session" })
      .pipe(Stream.unwrap, Stream.runCollect);
    assert.isTrue(invalid.at(-1)?.isFailure);
    assert.deepEqual(test.stopped, ["89673"]);
  }).pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(OrchestratorHandlers.layer).pipe(
        Layer.provideMerge(Layer.merge(test.layer, test.dependencies)),
      ),
    ),
  );
});

it.effect("logs one bounded stop result for success and failure without command text", () => {
  const test = fixture();
  const logs: Array<{ message: unknown; annotations: unknown }> = [];
  const logger = Logger.make(({ message, fiber }) => {
    logs.push({ message, annotations: fiber.getRef(References.CurrentLogAnnotations) });
  });
  return Effect.gen(function* () {
    const service = yield* BackgroundTerminals.BackgroundTerminals;
    yield* service.stopBackgroundTerminal(scope, { sessionId: "89673" });
    yield* service
      .stopBackgroundTerminal({ ...scope, thread: undefined }, { sessionId: "89673" })
      .pipe(Effect.flip);
    assert.lengthOf(logs, 2);
    const encoded = JSON.stringify(logs);
    assert.include(encoded, "background_terminal.stop");
    assert.include(encoded, "durationMs");
    assert.include(encoded, "terminated");
    assert.include(encoded, "failed");
    assert.notInclude(encoded, "sleep 30");
  }).pipe(
    Effect.provide(Layer.merge(test.layer, Logger.layer([logger], { mergeWithExisting: false }))),
  );
});
