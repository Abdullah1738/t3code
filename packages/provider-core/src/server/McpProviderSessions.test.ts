import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";

import * as McpProviderSessions from "./McpProviderSessions.ts";

it.effect.each([
  { name: "own runtime", binding: "runtime:own", thread: "thread:own", accepted: true },
  {
    name: "replacement runtime",
    binding: "runtime:replacement",
    thread: "thread:own",
    accepted: false,
  },
  { name: "unbound record", binding: undefined, thread: "thread:own", accepted: false },
  { name: "other thread", binding: "runtime:own", thread: "thread:other", accepted: true },
] as const)(
  "reads credentials only for the owning runtime: $name",
  ({ binding, thread, accepted }) =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      const credential = {
        environmentId: EnvironmentId.make("test"),
        threadId: ThreadId.make("thread:own"),
        providerSessionId: "credential-uuid",
        ...(binding === undefined
          ? {}
          : { runtimeProviderSessionId: ProviderSessionId.make(binding) }),
        providerInstanceId: ProviderInstanceId.make("codex"),
        endpoint: "http://localhost/mcp",
        authorizationHeader: "Bearer test-token",
        browserToolsAvailable: false,
      };
      yield* sessions.set(credential);
      const result = yield* McpProviderSessions.readForRuntime(
        sessions,
        ThreadId.make(thread),
        ProviderSessionId.make("runtime:own"),
        ProviderDriverKind.make("codex"),
      ).pipe(Effect.result);
      if (accepted) {
        assert.equal(result._tag, "Success");
        if (result._tag === "Success")
          assert.deepEqual(result.success, thread === "thread:own" ? credential : undefined);
      } else {
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.include(result.failure.detail, "not owned by this provider runtime");
          assert.notInclude(String(result.failure), credential.authorizationHeader);
        }
      }
    }).pipe(Effect.provide(McpProviderSessions.layer)),
);

it.effect.each([
  { name: "own runtime", runtime: "runtime:own", credential: "credential", instance: "claude" },
  {
    name: "replacement runtime",
    runtime: "runtime:new",
    credential: "credential",
    instance: "claude",
  },
  { name: "unbound record", runtime: undefined, credential: "credential", instance: "claude" },
  { name: "stale credential", runtime: "runtime:own", credential: "old", instance: "claude" },
  { name: "foreign instance", runtime: "runtime:own", credential: "credential", instance: "codex" },
] as const)(
  "wake evidence requires the current bound credential: $name",
  ({ name, runtime, credential, instance }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const sessions = yield* McpProviderSessions.McpProviderSessions;
        const config = {
          environmentId: EnvironmentId.make("test"),
          threadId: ThreadId.make("thread:wake"),
          providerSessionId: "credential",
          runtimeProviderSessionId: ProviderSessionId.make("runtime:own"),
          providerInstanceId: ProviderInstanceId.make("claude"),
          endpoint: "http://localhost/mcp",
          authorizationHeader: "Bearer test",
          browserToolsAvailable: false,
        };
        yield* sessions.set(config);
        let state: McpProviderSessions.WakeCallerState = "starting";
        const { runtimeProviderSessionId: _, ...withoutRuntime } = config;
        yield* sessions.registerWakeCaller(
          {
            ...withoutRuntime,
            providerSessionId: credential,
            providerInstanceId: ProviderInstanceId.make(instance),
            ...(runtime === undefined
              ? {}
              : { runtimeProviderSessionId: ProviderSessionId.make(runtime) }),
          },
          () => state,
        );
        for (const phase of ["starting", "live", "inactive"] as const) {
          state = phase;
          assert.equal(
            yield* sessions.readWakeCaller(config),
            name === "own runtime" ? phase : "inactive",
          );
        }
        state = "live";
        yield* sessions.set({
          ...config,
          runtimeProviderSessionId: ProviderSessionId.make("runtime:new"),
        });
        assert.equal(yield* sessions.readWakeCaller(config), "inactive");
      }),
    ).pipe(Effect.provide(McpProviderSessions.layer)),
);

it.effect(
  "a delayed wake registration and predecessor cleanup cannot replace current wake evidence",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sessions = yield* McpProviderSessions.McpProviderSessions;
        const predecessorScope = yield* Scope.make();
        const predecessor = {
          environmentId: EnvironmentId.make("test"),
          threadId: ThreadId.make("thread:wake"),
          providerSessionId: "credential:old",
          runtimeProviderSessionId: ProviderSessionId.make("runtime:old"),
          providerInstanceId: ProviderInstanceId.make("claude"),
          endpoint: "http://localhost/mcp",
          authorizationHeader: "Bearer old",
          browserToolsAvailable: false,
        };
        yield* sessions.set(predecessor);
        yield* sessions
          .registerWakeCaller(predecessor, () => "live")
          .pipe(Effect.provideService(Scope.Scope, predecessorScope));
        const replacement = {
          ...predecessor,
          providerSessionId: "credential:new",
          runtimeProviderSessionId: ProviderSessionId.make("runtime:new"),
          authorizationHeader: "Bearer new",
        };
        yield* sessions.set(replacement);
        yield* sessions.registerWakeCaller(replacement, () => "live");
        yield* sessions
          .registerWakeCaller(predecessor, () => "starting")
          .pipe(Effect.provideService(Scope.Scope, predecessorScope));
        assert.equal(yield* sessions.readWakeCaller(predecessor), "inactive");
        assert.equal(yield* sessions.readWakeCaller(replacement), "live");
        yield* Scope.close(predecessorScope, Exit.void);
        assert.equal(yield* sessions.readWakeCaller(replacement), "live");
        yield* sessions.clear(replacement.threadId);
        yield* sessions.set(replacement);
        assert.equal(yield* sessions.readWakeCaller(replacement), "inactive");
      }),
    ).pipe(Effect.provide(McpProviderSessions.layer)),
);
