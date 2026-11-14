import { requestGuarded, runStreamGuarded } from "../rpc/client.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { RpcSession } from "../rpc/session.ts";
import { it } from "@effect/vitest";
import { vi, afterEach, describe, expect } from "vite-plus/test";
import {
  AuthOrchestrationOperateScope,
  KANBAN_WS_METHODS,
  KanbanBoardId,
  AuthPreviewOperateScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  ThreadId,
  EnvironmentId,
  ScheduledTaskId,
  WS_METHODS,
  type AuthSessionState,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { createCommandPermissions } from "./commandPermissions.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";
import { sessionHarness, delayedSession } from "./session.testkit.ts";

vi.mock("./session.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session.ts")>();
  return {
    ...actual,
    createEnvironmentSessionAtoms: (
      runtime: Parameters<typeof actual.createEnvironmentSessionAtoms>[0],
    ) =>
      liveRuntimes.has(runtime)
        ? actual.createEnvironmentSessionAtoms(runtime)
        : { sessionStateAtom: sessions },
  };
});
const liveRuntimes = new WeakSet<object>();
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, unknown>>(AsyncResult.initial()),
);
const env = EnvironmentId.make("target");
const other = EnvironmentId.make("other");
const grant = (allowed: boolean): AuthSessionState => ({
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes: allowed ? [AuthOrchestrationOperateScope] : [],
  permissions: allowed ? [AuthOrchestrationOperateScope] : [],
});
const runtime = Atom.runtime(
  Layer.succeed(EnvironmentRegistry, {
    run: (_id: EnvironmentId, effect: Effect.Effect<unknown>) => effect,
  } as unknown as EnvironmentRegistry["Service"]),
);
const permissions = createCommandPermissions(runtime, WS_METHODS.scheduledTasksDelete);
const setup = Effect.gen(function* () {
  const registry = AtomRegistry.make();
  registry.mount(sessions(env));
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  return registry;
});

describe("command permissions", () => {
  it.effect(
    "requires the destination grant to revoke a standing approval and rechecks revocation",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const registry = yield* setup;
          const revoke = createCommandPermissions(
            runtime,
            KANBAN_WS_METHODS.standingApprovalRevoke,
          );
          const input = {
            boardId: KanbanBoardId.make("board-toy"),
            id: "sa-one",
            reason: "Withdrawn",
          };
          registry.set(sessions(env), AsyncResult.success(grant(true)));
          registry.set(sessions(other), AsyncResult.success(grant(false)));
          expect(registry.get(revoke.permissionAtom(env, input))).toBe(true);
          yield* revoke.authorize(registry, env, input);
          expect(yield* revoke.authorize(registry, other, input).pipe(Effect.flip)).toMatchObject({
            _tag: "EnvironmentAuthorizationError",
          });
          registry.set(sessions(env), AsyncResult.success(grant(false)));
          expect(registry.get(revoke.permissionAtom(env, input))).toBe(false);
          expect(yield* revoke.authorize(registry, env, input).pipe(Effect.flip)).toMatchObject({
            _tag: "EnvironmentAuthorizationError",
          });
        }),
      ),
  );
  it.effect("requires analytics' destination grant and rechecks revocation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const analytics = createCommandPermissions(runtime, WS_METHODS.analyticsIngest);
        const input = {
          events: [
            { ts: "2026-11-13T12:00:00Z", kind: "screen.open", surface: "web", route: "board" },
          ],
        };
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        registry.set(sessions(other), AsyncResult.success(grant(false)));
        expect(analytics.requiredScopes(input)).toContain(AuthOrchestrationOperateScope);
        expect(registry.get(analytics.permissionAtom(env, input))).toBe(true);
        yield* analytics.authorize(registry, env, input);
        expect(registry.get(analytics.permissionAtom(other, input))).toBe(false);
        expect(yield* analytics.authorize(registry, other, input).pipe(Effect.flip)).toMatchObject({
          _tag: "EnvironmentAuthorizationError",
        });
        registry.set(sessions(env), AsyncResult.success(grant(false)));
        expect(registry.get(analytics.permissionAtom(env, input))).toBe(false);
        expect(yield* analytics.authorize(registry, env, input).pipe(Effect.flip)).toMatchObject({
          _tag: "EnvironmentAuthorizationError",
        });
      }),
    ),
  );
  it.effect("distinguishes unanswered checks, cached grants and scope revocation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const status = permissions.permissionStatusAtom(env);
        yield* AtomRegistry.mount(registry, status);
        expect(registry.get(permissions.permissionStatusAtom(null))).toBe("denied");
        const unguarded = createCommandPermissions(runtime, "unguarded.read");
        expect(registry.get(unguarded.permissionStatusAtom(env))).toBe("granted");
        const unanswered: AsyncResult.AsyncResult<AuthSessionState, unknown>[] = [
          AsyncResult.initial<AuthSessionState>(),
          AsyncResult.waiting(AsyncResult.initial<AuthSessionState>()),
          AsyncResult.failure(Cause.fail({ _tag: "RemoteEnvironmentAuthTimeoutError" })),
          AsyncResult.failure(
            Cause.fail({
              _tag: "RemoteEnvironmentAuthFetchError",
              cause: new TypeError("offline"),
            }),
          ),
          AsyncResult.failure(
            Cause.fail({ _tag: "RemoteEnvironmentAuthUndeclaredStatusError", status: 503 }),
          ),
        ];
        for (const result of unanswered) {
          registry.set(sessions(env), result);
          expect(registry.get(status)).toBe("unknown");
          expect(registry.get(permissions.permissionAtom(env))).toBe(false);
        }
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(status)).toBe("granted");
        registry.set(sessions(env), AsyncResult.waiting(AsyncResult.success(grant(true))));
        expect(registry.get(status)).toBe("granted");
        registry.set(sessions(env), AsyncResult.success(grant(false)));
        expect(registry.get(status)).toBe("denied");
      }),
    ),
  );

  it.effect.each([
    { _tag: "RemoteEnvironmentAuthUndeclaredStatusError", status: 401 },
    { _tag: "RemoteEnvironmentAuthUndeclaredStatusError", status: 403 },
    { _tag: "EnvironmentAuthInvalidError" },
    { _tag: "EnvironmentScopeRequiredError" },
    { _tag: "RemoteEnvironmentAuthFetchError", cause: { _tag: "ConnectionBlockedError" } },
  ])("reports terminal session rejection as denied ($ _tag)", (error) =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        registry.set(sessions(env), AsyncResult.failure(Cause.fail(error)));
        expect(registry.get(permissions.permissionStatusAtom(env))).toBe("denied");
      }),
    ),
  );

  it.effect("requires the destination preview grant to close a browser tab", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const close = createCommandPermissions(runtime, WS_METHODS.previewClose);
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(close.permissionAtom(env))).toBe(false);
        expect((yield* close.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
          "EnvironmentAuthorizationError",
        );
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(false),
            scopes: [AuthPreviewOperateScope],
            permissions: [AuthPreviewOperateScope],
          }),
        );
        expect(registry.get(close.permissionAtom(env))).toBe(true);
        yield* close.authorize(registry, env);
        registry.set(sessions(other), AsyncResult.success(grant(false)));
        expect(registry.get(close.permissionAtom(other))).toBe(false);
        expect((yield* close.authorize(registry, other).pipe(Effect.flip))._tag).toBe(
          "EnvironmentAuthorizationError",
        );
      }),
    ),
  );

  it.effect("requires the destination settings grant to run storage cleanup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const cleanup = createCommandPermissions(runtime, WS_METHODS.serverRunStorageCleanup);
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(cleanup.permissionAtom(env))).toBe(false);
        expect((yield* cleanup.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
          "EnvironmentAuthorizationError",
        );
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(true),
            scopes: [AuthSettingsWriteScope],
            permissions: [AuthSettingsWriteScope],
          }),
        );
        expect(registry.get(cleanup.permissionAtom(env))).toBe(true);
        yield* cleanup.authorize(registry, env);
        registry.set(sessions(other), AsyncResult.success(grant(false)));
        expect(registry.get(cleanup.permissionAtom(other))).toBe(false);
      }),
    ),
  );

  it.effect("requires the destination settings grant to check OTLP endpoints", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const check = createCommandPermissions(runtime, WS_METHODS.serverCheckOtlpEndpoint);
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(check.permissionAtom(env))).toBe(false);
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(false),
            scopes: [AuthSettingsWriteScope],
            permissions: [AuthSettingsWriteScope],
          }),
        );
        expect(registry.get(check.permissionAtom(env))).toBe(true);
        yield* check.authorize(registry, env);
      }),
    ),
  );

  it.effect("uses the target grant for both availability and execution", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(permissions.permissionAtom(env))).toBe(true);
        expect(permissions.permissionAtom(env)).toBe(permissions.permissionAtom(env));
        yield* permissions.authorize(registry, env);
        registry.set(sessions(other), AsyncResult.success(grant(false)));
        expect(registry.get(permissions.permissionAtom(other))).toBe(false);
        const denied = yield* permissions.authorize(registry, other).pipe(Effect.flip);
        expect(denied._tag).toBe("EnvironmentAuthorizationError");
      }),
    ),
  );
  it.effect("waits for an initial grant", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const fiber = yield* permissions.authorize(registry, env).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        yield* Fiber.join(fiber);
      }),
    ),
  );
  it.effect("bounds a session that never loads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const fiber = yield* permissions
          .authorize(registry, env)
          .pipe(Effect.flip, Effect.forkChild);
        yield* TestClock.adjust("15 seconds");
        expect((yield* Fiber.join(fiber))._tag).toBe("EnvironmentRpcUnavailableError");
      }),
    ),
  );
  it.effect(
    "denies failed and unauthenticated sessions, but accepts a cached refreshing grant",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const registry = yield* setup;
          registry.set(sessions(env), AsyncResult.failure(Cause.fail("offline")));
          expect((yield* permissions.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
            "EnvironmentRpcUnavailableError",
          );
          registry.set(
            sessions(env),
            AsyncResult.success({ ...grant(true), authenticated: false }),
          );
          expect((yield* permissions.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
            "EnvironmentAuthorizationError",
          );
          registry.set(sessions(env), AsyncResult.waiting(AsyncResult.success(grant(true))));
          yield* permissions.authorize(registry, env);
        }),
      ),
  );
  it("rechecks permission after waiting in a serial command lane", async () => {
    const registry = AtomRegistry.make();
    const unmount = registry.mount(sessions(env));
    registry.set(sessions(env), AsyncResult.success(grant(true)));
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const command = createEnvironmentRpcCommand(runtime, {
      label: "test.delete",
      tag: WS_METHODS.scheduledTasksDelete,
      concurrency: { mode: "serial", key: () => "target" },
      execute: () =>
        Effect.promise(async () => {
          calls++;
          started();
          await gate;
          return { id: ScheduledTaskId.make("task") };
        }),
    });
    const target = { environmentId: env, input: { id: ScheduledTaskId.make("task") } };
    try {
      const first = command.run(registry, target);
      await entered;
      const second = command.run(registry, target);
      registry.set(sessions(env), AsyncResult.success(grant(false)));
      release();
      expect((await first)._tag).toBe("Success");
      expect((await second)._tag).toBe("Failure");
      expect(calls).toBe(1);
    } finally {
      unmount();
      registry.dispose();
    }
  });
});

describe("slow session authorization", () => {
  afterEach(() => vi.useRealTimers());

  it("waits through a first read over six seconds and its fast retry, then authorizes again", async () => {
    vi.useFakeTimers();
    let reads = 0;
    let aborted = 0;
    const harness = await sessionHarness((_url, init) => {
      reads++;
      init?.signal?.addEventListener("abort", () => aborted++);
      return delayedSession(reads === 1 ? 8_000 : 100, init?.signal);
    });
    liveRuntimes.add(harness.runtime);
    const permission = createCommandPermissions(harness.runtime, WS_METHODS.scheduledTasksDelete);
    const status = permission.permissionStatusAtom(harness.environmentId);
    const unmount = harness.registry.mount(status);
    try {
      const first = Effect.runPromiseExit(
        permission.authorize(harness.registry, harness.environmentId),
      );
      let settled = false;
      void first.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(6_001);
      expect(reads).toBe(1);
      expect(aborted).toBe(1);
      expect(settled).toBe(false);
      expect(harness.registry.get(status)).toBe("unknown");
      await vi.advanceTimersByTimeAsync(1_100);
      expect((await first)._tag).toBe("Success");
      expect(reads).toBe(2);
      expect(harness.registry.get(status)).toBe("granted");
      const second = Effect.runPromiseExit(
        permission.authorize(harness.registry, harness.environmentId),
      );
      await vi.advanceTimersByTimeAsync(100);
      expect((await second)._tag).toBe("Success");
    } finally {
      unmount();
      harness.registry.dispose();
    }
  });

  it("reports a retryable connection failure when no session read can finish", async () => {
    vi.useFakeTimers();
    let reads = 0;
    const harness = await sessionHarness((_url, init) => {
      reads++;
      return delayedSession(20_000, init?.signal);
    });
    liveRuntimes.add(harness.runtime);
    const permission = createCommandPermissions(harness.runtime, WS_METHODS.scheduledTasksDelete);
    try {
      const result = Effect.runPromise(
        permission.authorize(harness.registry, harness.environmentId).pipe(Effect.flip),
      );
      await vi.advanceTimersByTimeAsync(15_001);
      expect(await result).toMatchObject({ _tag: "EnvironmentRpcUnavailableError" });
      const readsAtClose = reads;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(reads).toBe(readsAtClose);
    } finally {
      harness.registry.dispose();
    }
  });

  it("cancels an authorization request during backoff without retrying after its scope closes", async () => {
    vi.useFakeTimers();
    let reads = 0;
    const harness = await sessionHarness((_url, init) => {
      reads++;
      return delayedSession(8_000, init?.signal);
    });
    liveRuntimes.add(harness.runtime);
    const permission = createCommandPermissions(harness.runtime, WS_METHODS.scheduledTasksDelete);
    try {
      const fiber = Effect.runFork(permission.authorize(harness.registry, harness.environmentId));
      await vi.advanceTimersByTimeAsync(6_001);
      await Effect.runPromise(Fiber.interrupt(fiber));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(reads).toBe(1);
    } finally {
      harness.registry.dispose();
    }
  });

  it.each([401, 403])(
    "keeps HTTP %s denial terminal rather than turning it into a connection retry",
    async (status) => {
      vi.useFakeTimers();
      let reads = 0;
      const harness = await sessionHarness(async () => {
        reads++;
        return Response.json(
          status === 401
            ? {
                _tag: "EnvironmentAuthInvalidError",
                code: "auth_invalid",
                reason: "invalid_credential",
                traceId: "test",
              }
            : {
                _tag: "EnvironmentScopeRequiredError",
                code: "insufficient_scope",
                requiredScope: "orchestration:operate",
                traceId: "test",
              },
          { status },
        );
      });
      liveRuntimes.add(harness.runtime);
      const permission = createCommandPermissions(harness.runtime, WS_METHODS.scheduledTasksDelete);
      try {
        const result = Effect.runPromise(
          permission.authorize(harness.registry, harness.environmentId).pipe(Effect.flip),
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(await result).toMatchObject({ _tag: "EnvironmentAuthorizationError" });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(reads).toBe(1);
      } finally {
        harness.registry.dispose();
      }
    },
  );
});

it.effect(
  "requires source control alone for git, and both grants when attaching a worktree to a thread",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        const git = createCommandPermissions(runtime, WS_METHODS.vcsInit);
        expect(yield* git.authorize(registry, env).pipe(Effect.flip)).toMatchObject({
          requiredPermission: AuthSourceControlWriteScope,
        });
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(false),
            scopes: [AuthSourceControlWriteScope],
            permissions: [AuthSourceControlWriteScope],
          }),
        );
        yield* git.authorize(registry, env);
        const prepare = createCommandPermissions(runtime, WS_METHODS.gitPreparePullRequestThread);
        const input = {
          cwd: "/repo",
          reference: "123",
          mode: "worktree",
          threadId: ThreadId.make("thread"),
        };
        expect(registry.get(prepare.permissionAtom(env, input))).toBe(false);
        expect(yield* prepare.authorize(registry, env, input).pipe(Effect.flip)).toMatchObject({
          requiredScope: AuthOrchestrationOperateScope,
        });
        yield* prepare.authorize(registry, env, { ...input, threadId: undefined });
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(true),
            scopes: [AuthSourceControlWriteScope, AuthOrchestrationOperateScope],
            permissions: [AuthSourceControlWriteScope, AuthOrchestrationOperateScope],
          }),
        );
        expect(registry.get(prepare.permissionAtom(env, input))).toBe(true);
        yield* prepare.authorize(registry, env, input);
      }),
    ),
);

it.effect("honors exact empty permissions and preserves legacy parent grants", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const registry = yield* setup;
      const git = createCommandPermissions(runtime, WS_METHODS.vcsInit);
      registry.set(sessions(env), AsyncResult.success({ ...grant(true), permissions: [] }));
      expect(registry.get(git.permissionAtom(env))).toBe(false);
      const denied = yield* git.authorize(registry, env).pipe(Effect.flip);
      expect(denied).toMatchObject({
        requiredPermission: AuthSourceControlWriteScope,
        requiredScope: AuthOrchestrationOperateScope,
      });
      const { permissions: _exact, ...legacy } = grant(true);
      registry.set(sessions(env), AsyncResult.success(legacy));
      expect(registry.get(git.permissionAtom(env))).toBe(true);
      yield* git.authorize(registry, env);
    }),
  ),
);

it.effect("rejects protected unary and streamed RPCs outside a guarded command", () =>
  Effect.gen(function* () {
    let writes = 0;
    const session = {
      client: {
        [WS_METHODS.scheduledTasksDelete]: () =>
          Effect.sync(() => {
            writes++;
            return { id: ScheduledTaskId.make("task") };
          }),
        [WS_METHODS.gitRunStackedAction]: () =>
          Stream.fromEffect(
            Effect.sync(() => {
              writes++;
            }),
          ),
      },
    } as unknown as RpcSession;
    const supervisor = {
      target: { environmentId: env, label: "target" },
      session: yield* SubscriptionRef.make(Option.some(session)),
    } as unknown as EnvironmentSupervisor["Service"];
    const unary = yield* requestGuarded(WS_METHODS.scheduledTasksDelete, {
      id: ScheduledTaskId.make("task"),
    }).pipe(Effect.provideService(EnvironmentSupervisor, supervisor), Effect.flip);
    expect(unary._tag).toBe("EnvironmentAuthorizationError");
    const streamed = yield* runStreamGuarded(WS_METHODS.gitRunStackedAction, {
      actionId: "test-action",
      cwd: "/repo",
      action: "commit",
    }).pipe(Stream.runDrain, Effect.provideService(EnvironmentSupervisor, supervisor), Effect.flip);
    expect(streamed._tag).toBe("EnvironmentAuthorizationError");
    expect(writes).toBe(0);
  }),
);
