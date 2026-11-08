// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as CredentialStore from "../ardud/mcp/CredentialStore.ts";
import * as BoardsDatabase from "../ardud/persistence/BoardsDatabase.ts";

const environmentId = EnvironmentId.make("environment-1");
const makeFakeHttpServer = (hostname: string, port = 43123) =>
  HttpServer.HttpServer.of({
    address: NetAddress.inetAddressFromIpStringUnsafe(hostname, port),
    serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
  });
const fakeHttpServer = makeFakeHttpServer("127.0.0.1");
const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("unused"),
});
const persistentMemory = Layer.merge(
  CredentialStore.layer.pipe(Layer.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  NodeServices.layer,
);

const makeRegistry = (now: () => number, httpServer = fakeHttpServer) => {
  const records = new Map<string, CredentialStore.CredentialRecord>();
  const store = CredentialStore.CredentialStore.of({
    load: () => Effect.sync(() => [...records.values()]),
    insert: (record) =>
      Effect.sync(() => {
        records.set(record.tokenHash, record);
      }),
    updateLiveness: (_, hash, timestamp) =>
      Effect.sync(() => {
        const record = records.get(hash);
        if (record) records.set(hash, { ...record, lastAliveAt: timestamp });
      }),
    touchThread: (_, threadId, timestamp) =>
      Effect.sync(() => {
        for (const [hash, record] of records)
          if (record.scope.thread.threadId === threadId)
            records.set(hash, { ...record, lastAliveAt: timestamp });
      }),
    revokeThread: (_, threadId) =>
      Effect.sync(() => {
        for (const [hash, record] of records)
          if (record.scope.thread.threadId === threadId) records.delete(hash);
      }),
    revokeProviderSession: (_, id) =>
      Effect.sync(() => {
        for (const [hash, record] of records)
          if (record.scope.thread.providerSessionId === id) records.delete(hash);
      }),
    revokeAll: () => Effect.sync(() => records.clear()),
  });
  return McpSessionRegistry.__testing
    .make({
      now,
      livenessWindowMs: 100,
    })
    .pipe(
      Effect.provideService(HttpServer.HttpServer, httpServer),
      Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
      Effect.provideService(CredentialStore.CredentialStore, store),
      Effect.provide(NodeServices.layer),
    );
};

it.effect(
  "constructs before the boards copy finishes and loads credentials once before serving",
  () =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>();
      const issued = yield* Deferred.make<void>();
      let loads = 0;
      const context = yield* Layer.build(NodeSqliteClient.layer({ filename: ":memory:" }));
      yield* Effect.gen(function* () {
        const registry = yield* McpSessionRegistry.__testing.make({ now: () => 1_000 });
        expect(loads).toBe(0);
        const issuing = yield* registry
          .issue({
            threadId: ThreadId.make("post-migration"),
            providerInstanceId: ProviderInstanceId.make("codex"),
          })
          .pipe(Effect.andThen(Deferred.succeed(issued, undefined)), Effect.forkScoped);
        yield* Effect.yieldNow;
        expect(yield* Deferred.isDone(issued)).toBe(false);
        yield* Deferred.succeed(ready, undefined);
        yield* Fiber.join(issuing);
        yield* registry.resolve("unknown");
        expect(loads).toBe(1);
      }).pipe(
        Effect.provideService(
          BoardsDatabase.BoardsDatabase,
          BoardsDatabase.BoardsDatabase.of({
            sql: Context.get(context, SqlClient.SqlClient),
            ready: Deferred.await(ready),
            path: ":memory:",
          }),
        ),
        Effect.provideService(HttpServer.HttpServer, fakeHttpServer),
        Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
        Effect.provide(NodeServices.layer),
        Effect.provideService(
          CredentialStore.CredentialStore,
          CredentialStore.CredentialStore.of({
            load: () =>
              Deferred.await(ready).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    loads++;
                    return [];
                  }),
                ),
              ),
            insert: () => Effect.void,
            updateLiveness: () => Effect.void,
            touchThread: () => Effect.void,
            revokeThread: () => Effect.void,
            revokeProviderSession: () => Effect.void,
            revokeAll: () => Effect.void,
          }),
        ),
      );
    }),
);

it.effect("stores only a token hash, resolves the bearer token, and revokes by thread", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-1");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["preview"]),
    });
    expect(issued.config.endpoint).toBe("http://127.0.0.1:43123/mcp");
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    expect(token.length).toBeGreaterThan(20);

    const resolved = yield* registry.resolve(token);
    expect(resolved?.thread.threadId).toBe(threadId);
    expect(resolved?.capabilities).toEqual(
      new Set(["preview", "orchestration", "worktree", "pull-requests"]),
    );

    yield* registry.revokeThread(threadId);
    expect(yield* registry.resolve(token)).toBeUndefined();

    timestamp += 2_000;
  }),
);

it.effect("always grants pull-requests and gates browser and device access independently", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000);
    const withPreview = yield* registry.issue({
      threadId: ThreadId.make("thread-preview"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["preview"]),
    });
    const withoutPreview = yield* registry.issue({
      threadId: ThreadId.make("thread-no-preview"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(),
    });
    const withDevice = yield* registry.issue({
      threadId: ThreadId.make("thread-device"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["device"]),
    });
    const capabilitiesOf = (issued: typeof withPreview) =>
      registry
        .resolve(issued.config.authorizationHeader.replace(/^Bearer\s+/, ""))
        .pipe(Effect.map((scope) => [...(scope?.capabilities ?? [])].sort()));

    expect(yield* capabilitiesOf(withPreview)).toEqual([
      "orchestration",
      "preview",
      "pull-requests",
      "worktree",
    ]);
    expect(yield* capabilitiesOf(withoutPreview)).toEqual([
      "orchestration",
      "pull-requests",
      "worktree",
    ]);
    expect(yield* capabilitiesOf(withDevice)).toEqual([
      "device",
      "orchestration",
      "pull-requests",
      "worktree",
    ]);
  }),
);

it.effect("builds MCP endpoints from the bound server host", () =>
  Effect.gen(function* () {
    const cases = [
      ["100.64.0.40", "http://100.64.0.40:43123/mcp"],
      ["0.0.0.0", "http://127.0.0.1:43123/mcp"],
      ["::", "http://127.0.0.1:43123/mcp"],
      ["::1", "http://[::1]:43123/mcp"],
      ["127.0.0.1", "http://127.0.0.1:43123/mcp"],
    ] as const;

    for (const [hostname, expectedEndpoint] of cases) {
      const registry = yield* makeRegistry(() => 1_000, makeFakeHttpServer(hostname));
      const issued = yield* registry.issue({
        threadId: ThreadId.make(`thread-${hostname}`),
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set(["preview"]),
      });
      expect(issued.config.endpoint).toBe(expectedEndpoint);
    }
  }),
);

it.effect("expires credentials once their session stops showing signs of life", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-2"),
      providerInstanceId: ProviderInstanceId.make("claude"),
      capabilities: new Set(["preview"]),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    timestamp += 101;
    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

it.effect("keeps a credential alive across turns that never touch an MCP tool", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-3");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("claude"),
      capabilities: new Set(["preview"]),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

    for (let turn = 0; turn < 10; turn += 1) {
      timestamp += 99;
      yield* registry.touch(threadId);
    }

    expect((yield* registry.resolve(token))?.thread.threadId).toBe(threadId);
  }),
);

it.effect("does not keep credentials of other threads alive", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-4"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["preview"]),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

    timestamp += 99;
    yield* registry.touch(ThreadId.make("thread-unrelated"));
    timestamp += 2;

    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

it.effect("only a trusted touch restores an expired token with its original scope", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-idle");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("claude"),
      capabilities: new Set(["preview"]),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    const scope = yield* registry.resolve(token);
    expect(scope).toBeDefined();

    timestamp += 101;
    expect(yield* registry.resolve(token)).toBeUndefined();
    const otherThreadId = ThreadId.make("thread-active");
    const other = yield* registry.issue({
      threadId: otherThreadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["device"]),
    });
    yield* registry.touch(otherThreadId);
    expect(
      (yield* registry.resolve(other.config.authorizationHeader.replace(/^Bearer\s+/, "")))?.thread
        .threadId,
    ).toBe(otherThreadId);
    expect(yield* registry.resolve("unknown-token")).toBeUndefined();
    expect(yield* registry.resolve(token)).toBeUndefined();

    yield* registry.touch(threadId);
    expect(yield* registry.resolve(token)).toEqual(scope);
    timestamp += 101;
    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

it.effect.each(["provider-session", "thread", "all"] as const)(
  "never restores an expired token after %s revocation",
  (revocation) =>
    Effect.gen(function* () {
      let timestamp = 1_000;
      const registry = yield* makeRegistry(() => timestamp);
      const threadId = ThreadId.make("thread-revoked");
      const issued = yield* registry.issue({
        threadId,
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set(["preview"]),
      });
      const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

      timestamp += 101;
      yield* {
        "provider-session": registry.revokeProviderSession(issued.config.providerSessionId),
        thread: registry.revokeThread(threadId),
        all: registry.revokeAll,
      }[revocation];
      yield* registry.touch(threadId);
      expect(yield* registry.resolve(token)).toBeUndefined();
    }),
);

it.effect(
  "restores the same scope across separate registry and database lifetimes, preserving expiry and revocation",
  () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcp-registry-restart-"));
    const dbPath = NodePath.join(dir, "state.sqlite");
    let now = 1_000;
    const run = <A, E>(
      body: (registry: McpSessionRegistry.McpSessionRegistryShape) => Effect.Effect<A, E>,
      env = fakeEnvironment,
    ) =>
      Effect.scoped(
        Effect.gen(function* () {
          const registry = yield* McpSessionRegistry.__testing.make({
            now: () => now,
            livenessWindowMs: 100,
          });
          return yield* body(registry);
        }).pipe(
          Effect.provideService(HttpServer.HttpServer, fakeHttpServer),
          Effect.provideService(ServerEnvironment.ServerEnvironment, env),
          Effect.provide(
            Layer.merge(
              CredentialStore.layer.pipe(
                Layer.provide(NodeSqliteClient.layer({ filename: dbPath })),
              ),
              NodeServices.layer,
            ),
          ),
        ),
      );
    return Effect.gen(function* () {
      const issued = yield* run((registry) =>
        registry.issue({
          threadId: ThreadId.make("restart-thread"),
          providerInstanceId: ProviderInstanceId.make("claude"),
          capabilities: new Set(["device"]),
        }),
      );
      const token = issued.config.authorizationHeader.slice("Bearer ".length);
      const original = yield* run((registry) => registry.resolve(token));
      expect(original).toEqual({
        environmentId,
        requestNamespace: issued.config.providerSessionId,
        thread: {
          threadId: issued.config.threadId,
          providerSessionId: issued.config.providerSessionId,
          providerInstanceId: issued.config.providerInstanceId,
        },
        client: undefined,
        capabilities: new Set(["orchestration", "worktree", "pull-requests", "device"]),
        issuedAt: 1_000,
      });
      const foreign = ServerEnvironment.ServerEnvironment.of({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("foreign-env")),
        getDescriptor: Effect.die("unused"),
      });
      expect(yield* run((registry) => registry.resolve(token), foreign)).toBeUndefined();
      const persisted = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql`SELECT * FROM ardud_mcp_credentials`;
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
      expect(JSON.stringify(persisted)).not.toContain(token);
      now += 101;
      expect(yield* run((registry) => registry.resolve(token))).toBeUndefined();
      yield* run((registry) => registry.touch(issued.config.threadId));
      expect(yield* run((registry) => registry.resolve(token))).toEqual(original);
      yield* run((registry) => registry.revokeThread(issued.config.threadId));
      yield* run((registry) => registry.touch(issued.config.threadId));
      expect(yield* run((registry) => registry.resolve(token))).toBeUndefined();
    }).pipe(
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true }))),
    );
  },
);

it.effect("coalesces request liveness writes and makes trusted touch durable", () =>
  Effect.gen(function* () {
    const base = yield* CredentialStore.CredentialStore;
    let writes = 0;
    let now = 1_000;
    const instrumented = CredentialStore.CredentialStore.of({
      ...base,
      updateLiveness: (...args) =>
        Effect.sync(() => {
          writes += 1;
        }).pipe(Effect.andThen(base.updateLiveness(...args))),
    });
    const create = McpSessionRegistry.__testing
      .make({ now: () => now, livenessWindowMs: 180_000 })
      .pipe(
        Effect.provideService(HttpServer.HttpServer, fakeHttpServer),
        Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
        Effect.provideService(CredentialStore.CredentialStore, instrumented),
      );
    const first = yield* create;
    const issued = yield* first.issue({
      threadId: ThreadId.make("coalesced"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    const token = issued.config.authorizationHeader.slice(7);
    now = 60_999;
    yield* first.resolve(token);
    yield* first.resolve(token);
    expect(writes).toBe(0);
    expect((yield* base.load(environmentId))[0]?.lastAliveAt).toBe(1_000);
    now = 61_000;
    yield* first.resolve(token);
    yield* first.resolve(token);
    yield* TestClock.adjust("1 minute");
    expect(writes).toBe(1);
    expect((yield* base.load(environmentId))[0]?.lastAliveAt).toBe(61_000);
    now = 61_001;
    yield* first.touch(issued.config.threadId);
    expect((yield* base.load(environmentId))[0]?.lastAliveAt).toBe(61_001);
    const second = yield* create;
    expect(yield* second.resolve(token)).toEqual(yield* first.resolve(token));
  }).pipe(Effect.provide(persistentMemory)),
);

it.effect("serializes a delayed trusted touch against revocation without resurrection", () =>
  Effect.gen(function* () {
    const base = yield* CredentialStore.CredentialStore;
    const started = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    let now = 1_000;
    const delayed = CredentialStore.CredentialStore.of({
      ...base,
      updateLiveness: (...args) =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(resume)),
          Effect.andThen(base.updateLiveness(...args)),
        ),
    });
    const registry = yield* McpSessionRegistry.__testing
      .make({ now: () => now })
      .pipe(
        Effect.provideService(HttpServer.HttpServer, fakeHttpServer),
        Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
        Effect.provideService(CredentialStore.CredentialStore, delayed),
      );
    const issued = yield* registry.issue({
      threadId: ThreadId.make("race"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    now = 2_000;
    const touch = yield* registry.touch(issued.config.threadId).pipe(Effect.forkChild);
    yield* Deferred.await(started);
    const revoke = yield* registry.revokeThread(issued.config.threadId).pipe(Effect.forkChild);
    yield* Deferred.succeed(resume, undefined);
    yield* Fiber.join(touch);
    yield* Fiber.join(revoke);
    expect(yield* base.load(environmentId)).toEqual([]);
    expect(yield* registry.resolve(issued.config.authorizationHeader.slice(7))).toBeUndefined();
  }).pipe(Effect.provide(persistentMemory)),
);

it.effect("resolves all tokens while a dirty liveness write is blocked", () =>
  Effect.gen(function* () {
    const base = yield* CredentialStore.CredentialStore;
    const started = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    let now = 1_000;
    const delayed = CredentialStore.CredentialStore.of({
      ...base,
      updateLiveness: (...args) =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(resume)),
          Effect.andThen(base.updateLiveness(...args)),
        ),
    });
    const registry = yield* McpSessionRegistry.__testing
      .make({ now: () => now, livenessWindowMs: 180_000 })
      .pipe(
        Effect.provideService(HttpServer.HttpServer, fakeHttpServer),
        Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
        Effect.provideService(CredentialStore.CredentialStore, delayed),
      );
    const credentials = yield* Effect.forEach(["one", "two", "three"], (id) =>
      registry.issue({
        threadId: ThreadId.make(id),
        providerInstanceId: ProviderInstanceId.make("codex"),
      }),
    );
    const tokens = credentials.map((credential) => credential.config.authorizationHeader.slice(7));
    now = 61_000;
    const first = yield* registry.resolve(tokens[0]!).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* TestClock.adjust("1 minute");
    yield* Effect.yieldNow;
    const second = yield* registry.resolve(tokens[1]!).pipe(Effect.forkChild);
    const third = yield* registry.resolve(tokens[2]!).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    const startedBeforeRelease = yield* Deferred.isDone(started);
    const beforeRelease = [first.pollUnsafe(), second.pollUnsafe(), third.pollUnsafe()];
    yield* Deferred.succeed(resume, undefined);
    const scopes = yield* Effect.all([Fiber.join(first), Fiber.join(second), Fiber.join(third)]);
    expect(startedBeforeRelease).toBe(true);
    expect(beforeRelease.every((exit) => exit !== undefined && Exit.isSuccess(exit))).toBe(true);
    expect(scopes.map((scope) => scope?.thread.threadId)).toEqual(["one", "two", "three"]);
  }).pipe(Effect.provide(persistentMemory)),
);

it.effect("revokes another thread while a liveness flush is blocked", () =>
  Effect.gen(function* () {
    const base = yield* CredentialStore.CredentialStore;
    const started = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    let now = 1_000;
    const delayed = CredentialStore.CredentialStore.of({
      ...base,
      updateLiveness: (...args) =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(resume)),
          Effect.andThen(base.updateLiveness(...args)),
        ),
    });
    const registry = yield* McpSessionRegistry.__testing
      .make({ now: () => now, livenessWindowMs: 180_000 })
      .pipe(
        Effect.provideService(HttpServer.HttpServer, fakeHttpServer),
        Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
        Effect.provideService(CredentialStore.CredentialStore, delayed),
      );
    const first = yield* registry.issue({
      threadId: ThreadId.make("flush"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    const other = yield* registry.issue({
      threadId: ThreadId.make("revoke"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    now = 61_000;
    const resolving = yield* registry
      .resolve(first.config.authorizationHeader.slice(7))
      .pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* TestClock.adjust("1 minute");
    yield* Effect.yieldNow;
    const revoking = yield* registry.revokeThread(other.config.threadId).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    const startedBeforeRelease = yield* Deferred.isDone(started);
    const revokeBeforeRelease = revoking.pollUnsafe();
    yield* Deferred.succeed(resume, undefined);
    yield* Fiber.join(resolving);
    yield* Fiber.join(revoking);
    expect(startedBeforeRelease).toBe(true);
    expect(revokeBeforeRelease && Exit.isSuccess(revokeBeforeRelease)).toBe(true);
    expect(yield* registry.resolve(other.config.authorizationHeader.slice(7))).toBeUndefined();
  }).pipe(Effect.provide(persistentMemory)),
);

it.effect("flushes dirty liveness once and retries a failed flush on the next interval", () =>
  Effect.gen(function* () {
    const base = yield* CredentialStore.CredentialStore;
    let attempts = 0;
    let now = 1_000;
    const failingOnce = CredentialStore.CredentialStore.of({
      ...base,
      updateLiveness: (...args) =>
        Effect.suspend(() => {
          attempts += 1;
          return attempts === 1
            ? Effect.fail(
                new CredentialStore.CredentialStoreError({ operation: "update-liveness" }),
              )
            : base.updateLiveness(...args);
        }),
    });
    const registry = yield* McpSessionRegistry.__testing
      .make({ now: () => now, livenessWindowMs: 180_000 })
      .pipe(
        Effect.provideService(HttpServer.HttpServer, fakeHttpServer),
        Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
        Effect.provideService(CredentialStore.CredentialStore, failingOnce),
      );
    const issued = yield* registry.issue({
      threadId: ThreadId.make("retry"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    now = 61_000;
    const result = yield* Effect.exit(registry.resolve(issued.config.authorizationHeader.slice(7)));
    expect(Exit.isSuccess(result)).toBe(true);
    expect(attempts).toBe(0);
    yield* TestClock.adjust("1 minute");
    expect(attempts).toBe(1);
    expect((yield* base.load(environmentId))[0]?.lastAliveAt).toBe(1_000);
    yield* TestClock.adjust("1 minute");
    expect(attempts).toBe(2);
    expect((yield* base.load(environmentId))[0]?.lastAliveAt).toBe(61_000);
    yield* TestClock.adjust("1 minute");
    expect(attempts).toBe(2);
  }).pipe(Effect.provide(persistentMemory)),
);

it.effect("does not resurrect a revoked token when its delayed flush completes", () =>
  Effect.gen(function* () {
    const base = yield* CredentialStore.CredentialStore;
    const started = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    const finished = yield* Deferred.make<void>();
    let now = 1_000;
    const delayed = CredentialStore.CredentialStore.of({
      ...base,
      updateLiveness: (...args) =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(resume)),
          Effect.andThen(base.updateLiveness(...args)),
          Effect.tap(() => Deferred.succeed(finished, undefined)),
        ),
    });
    const create = McpSessionRegistry.__testing
      .make({ now: () => now, livenessWindowMs: 180_000 })
      .pipe(
        Effect.provideService(HttpServer.HttpServer, fakeHttpServer),
        Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
        Effect.provideService(CredentialStore.CredentialStore, delayed),
      );
    const registry = yield* create;
    const issued = yield* registry.issue({
      threadId: ThreadId.make("revoke-flush"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    const token = issued.config.authorizationHeader.slice(7);
    now = 61_000;
    const resolving = yield* registry.resolve(token).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* TestClock.adjust("1 minute");
    yield* Effect.yieldNow;
    const revoking = yield* registry.revokeThread(issued.config.threadId).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    const startedBeforeRelease = yield* Deferred.isDone(started);
    const revokeBeforeRelease = revoking.pollUnsafe();
    yield* Deferred.succeed(resume, undefined);
    yield* Fiber.join(resolving);
    yield* Fiber.join(revoking);
    yield* Deferred.await(finished);
    const restored = yield* create;
    expect(startedBeforeRelease).toBe(true);
    expect(revokeBeforeRelease && Exit.isSuccess(revokeBeforeRelease)).toBe(true);
    expect(yield* restored.resolve(token)).toBeUndefined();
    expect(yield* base.load(environmentId)).toEqual([]);
  }).pipe(Effect.provide(persistentMemory)),
);

it.effect("makes touch durable without blocking a concurrent resolve", () =>
  Effect.gen(function* () {
    const base = yield* CredentialStore.CredentialStore;
    const started = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    let now = 1_000;
    const delayed = CredentialStore.CredentialStore.of({
      ...base,
      updateLiveness: (...args) =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(resume)),
          Effect.andThen(base.updateLiveness(...args)),
        ),
    });
    const registry = yield* McpSessionRegistry.__testing
      .make({ now: () => now })
      .pipe(
        Effect.provideService(HttpServer.HttpServer, fakeHttpServer),
        Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
        Effect.provideService(CredentialStore.CredentialStore, delayed),
      );
    const issued = yield* registry.issue({
      threadId: ThreadId.make("touch"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    now = 2_000;
    const touching = yield* registry.touch(issued.config.threadId).pipe(Effect.forkChild);
    yield* Deferred.await(started);
    const resolving = yield* registry
      .resolve(issued.config.authorizationHeader.slice(7))
      .pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    const resolveBeforeRelease = resolving.pollUnsafe();
    expect(touching.pollUnsafe()).toBeUndefined();
    yield* Deferred.succeed(resume, undefined);
    yield* Fiber.join(touching);
    expect((yield* base.load(environmentId))[0]?.lastAliveAt).toBe(2_000);
    expect((yield* Fiber.join(resolving))?.thread.threadId).toBe(issued.config.threadId);
    expect(resolveBeforeRelease && Exit.isSuccess(resolveBeforeRelease)).toBe(true);
  }).pipe(Effect.provide(persistentMemory)),
);

it.effect("rechecks a queued flush after a different thread's trusted touch", () =>
  Effect.gen(function* () {
    const base = yield* CredentialStore.CredentialStore;
    const started = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    const lastWritten = yield* Deferred.make<void>();
    let writes = 0;
    let now = 1_000;
    const wrapped = CredentialStore.CredentialStore.of({
      ...base,
      updateLiveness: (...args) =>
        Effect.gen(function* () {
          writes += 1;
          if (writes === 1) {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(resume);
          }
          yield* base.updateLiveness(...args);
          const records = yield* base.load(environmentId);
          if (
            records.find((record) => record.tokenHash === args[1])?.scope.thread.threadId === "last"
          ) {
            yield* Deferred.succeed(lastWritten, undefined);
          }
        }),
    });
    const registry = yield* McpSessionRegistry.__testing
      .make({ now: () => now, livenessWindowMs: 180_000 })
      .pipe(
        Effect.provideService(HttpServer.HttpServer, fakeHttpServer),
        Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
        Effect.provideService(CredentialStore.CredentialStore, wrapped),
      );
    const credentials = yield* Effect.forEach(["first", "second", "last"], (id) =>
      registry.issue({
        threadId: ThreadId.make(id),
        providerInstanceId: ProviderInstanceId.make("codex"),
      }),
    );
    now = 61_000;
    for (const credential of credentials)
      yield* registry.resolve(credential.config.authorizationHeader.slice(7));
    yield* TestClock.adjust("1 minute");
    yield* Deferred.await(started);
    now = 100_000;
    yield* registry.touch(ThreadId.make("second"));
    yield* Deferred.succeed(resume, undefined);
    yield* Deferred.await(lastWritten);
    expect(
      (yield* base.load(environmentId)).find((record) => record.scope.thread.threadId === "second")
        ?.lastAliveAt,
    ).toBe(100_000);
  }).pipe(Effect.provide(persistentMemory)),
);

it.effect("concurrent trusted touches cannot backdate durable liveness", () =>
  Effect.gen(function* () {
    const base = yield* CredentialStore.CredentialStore;
    const started = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    let now = 1_000;
    const wrapped = CredentialStore.CredentialStore.of({
      ...base,
      updateLiveness: (...args) =>
        args[2] === 2_000
          ? Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(resume)),
              Effect.andThen(base.updateLiveness(...args)),
            )
          : base.updateLiveness(...args),
    });
    const registry = yield* McpSessionRegistry.__testing
      .make({ now: () => now })
      .pipe(
        Effect.provideService(HttpServer.HttpServer, fakeHttpServer),
        Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
        Effect.provideService(CredentialStore.CredentialStore, wrapped),
      );
    const issued = yield* registry.issue({
      threadId: ThreadId.make("touch-race"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    now = 2_000;
    const old = yield* registry.touch(issued.config.threadId).pipe(Effect.forkChild);
    yield* Deferred.await(started);
    now = 3_000;
    const newer = yield* registry.touch(issued.config.threadId).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* Deferred.succeed(resume, undefined);
    yield* Fiber.join(old);
    yield* Fiber.join(newer);
    expect((yield* base.load(environmentId))[0]?.lastAliveAt).toBe(3_000);
  }).pipe(Effect.provide(persistentMemory)),
);

it.effect("a delayed trusted touch cannot backdate a newly issued credential", () =>
  Effect.gen(function* () {
    const base = yield* CredentialStore.CredentialStore;
    const started = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    let now = 1_000;
    const wrapped = CredentialStore.CredentialStore.of({
      ...base,
      updateLiveness: (...args) =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(resume)),
          Effect.andThen(base.updateLiveness(...args)),
        ),
    });
    const registry = yield* McpSessionRegistry.__testing
      .make({ now: () => now })
      .pipe(
        Effect.provideService(HttpServer.HttpServer, fakeHttpServer),
        Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
        Effect.provideService(CredentialStore.CredentialStore, wrapped),
      );
    const request = {
      threadId: ThreadId.make("issue-race"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    };
    yield* registry.issue(request);
    now = 2_000;
    const touching = yield* registry.touch(request.threadId).pipe(Effect.forkChild);
    yield* Deferred.await(started);
    now = 100_000;
    const issuing = yield* registry.issue(request).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* Deferred.succeed(resume, undefined);
    yield* Fiber.join(touching);
    const newer = yield* Fiber.join(issuing);
    expect(
      (yield* base.load(environmentId)).find(
        (record) => record.scope.thread.providerSessionId === newer.config.providerSessionId,
      )?.lastAliveAt,
    ).toBe(100_000);
  }).pipe(Effect.provide(persistentMemory)),
);

it.effect("flushes active liveness within one interval despite phase offsets", () =>
  Effect.gen(function* () {
    const base = yield* CredentialStore.CredentialStore;
    let now = 1_000;
    const registry = yield* McpSessionRegistry.__testing
      .make({ now: () => now, livenessWindowMs: 180_000 })
      .pipe(
        Effect.provideService(HttpServer.HttpServer, fakeHttpServer),
        Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
      );
    const issued = yield* registry.issue({
      threadId: ThreadId.make("phase"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    const token = issued.config.authorizationHeader.slice(7);
    now = 60_999;
    yield* TestClock.adjust(59_999);
    yield* registry.resolve(token);
    now = 61_000;
    yield* TestClock.adjust(1);
    now = 61_001;
    yield* TestClock.adjust(1);
    yield* registry.resolve(token);
    now = 120_999;
    yield* TestClock.adjust(59_998);
    yield* registry.resolve(token);
    expect(now - (yield* base.load(environmentId))[0]!.lastAliveAt).toBeLessThanOrEqual(60_000);
  }).pipe(Effect.provide(persistentMemory)),
);

it.effect("scope closure interrupts a blocked liveness flusher", () =>
  Effect.gen(function* () {
    const base = yield* CredentialStore.CredentialStore;
    const started = yield* Deferred.make<void>();
    const neverResume = yield* Deferred.make<void>();
    let writes = 0;
    let now = 1_000;
    const wrapped = CredentialStore.CredentialStore.of({
      ...base,
      updateLiveness: (...args) =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(neverResume)),
          Effect.andThen(base.updateLiveness(...args)),
          Effect.tap(() =>
            Effect.sync(() => {
              writes += 1;
            }),
          ),
        ),
    });
    const scope = yield* Scope.make();
    const registry = yield* Scope.provide(scope)(
      McpSessionRegistry.__testing
        .make({ now: () => now })
        .pipe(
          Effect.provideService(HttpServer.HttpServer, fakeHttpServer),
          Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
          Effect.provideService(CredentialStore.CredentialStore, wrapped),
        ),
    );
    const issued = yield* registry.issue({
      threadId: ThreadId.make("scope"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    now = 61_000;
    yield* registry.resolve(issued.config.authorizationHeader.slice(7));
    yield* TestClock.adjust("1 minute");
    yield* Deferred.await(started);
    yield* Scope.close(scope, Exit.void);
    yield* TestClock.adjust("5 minutes");
    expect(writes).toBe(0);
    expect((yield* base.load(environmentId))[0]?.lastAliveAt).toBe(1_000);
  }).pipe(Effect.provide(persistentMemory)),
);

it.effect("surfaces issue and revoke write errors rather than reporting memory-only success", () =>
  Effect.gen(function* () {
    const base = yield* CredentialStore.CredentialStore;
    let failInsert = true;
    let failRevoke = false;
    const broken = CredentialStore.CredentialStore.of({
      ...base,
      insert: (record) =>
        failInsert
          ? Effect.fail(new CredentialStore.CredentialStoreError({ operation: "insert" }))
          : base.insert(record),
      revokeThread: (...args) =>
        failRevoke
          ? Effect.fail(new CredentialStore.CredentialStoreError({ operation: "revoke-thread" }))
          : base.revokeThread(...args),
    });
    const registry = yield* McpSessionRegistry.__testing
      .make({ now: () => 1_000 })
      .pipe(
        Effect.provideService(HttpServer.HttpServer, fakeHttpServer),
        Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
        Effect.provideService(CredentialStore.CredentialStore, broken),
      );
    const request = {
      threadId: ThreadId.make("failed"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    };
    expect(Exit.isFailure(yield* Effect.exit(registry.issue(request)))).toBe(true);
    expect(yield* base.load(environmentId)).toEqual([]);
    failInsert = false;
    const issued = yield* registry.issue(request);
    failRevoke = true;
    expect(Exit.isFailure(yield* Effect.exit(registry.revokeThread(request.threadId)))).toBe(true);
    expect(yield* registry.resolve(issued.config.authorizationHeader.slice(7))).toBeDefined();
    expect(yield* base.load(environmentId)).toHaveLength(1);
  }).pipe(Effect.provide(persistentMemory)),
);

it.effect(
  "terminal cleanup revokes a restored credential even without a live provider session",
  () =>
    Effect.gen(function* () {
      const registry = yield* McpSessionRegistry.__testing
        .make({ now: () => 1_000 })
        .pipe(
          Effect.provideService(HttpServer.HttpServer, fakeHttpServer),
          Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
        );
      const issued = yield* registry.issue({
        threadId: ThreadId.make("archived"),
        providerInstanceId: ProviderInstanceId.make("codex"),
      });
      const restored = yield* McpSessionRegistry.__testing
        .make({ now: () => 1_000 })
        .pipe(
          Effect.provideService(HttpServer.HttpServer, fakeHttpServer),
          Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
        );
      const token = issued.config.authorizationHeader.slice(7);
      expect(yield* restored.resolve(token)).toBeDefined();
      yield* restored.revokeThread(issued.config.threadId);
      const after = yield* McpSessionRegistry.__testing
        .make({ now: () => 1_000 })
        .pipe(
          Effect.provideService(HttpServer.HttpServer, fakeHttpServer),
          Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
        );
      expect(yield* after.resolve(token)).toBeUndefined();
    }).pipe(Effect.provide(persistentMemory)),
);
