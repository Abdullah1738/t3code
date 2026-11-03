// @effect-diagnostics nodeBuiltinImport:off
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as CredentialStore from "../ardud/mcp/CredentialStore.ts";

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
    const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "mcp-registry-restart-"));
    const dbPath = Path.join(dir, "state.sqlite");
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
    }).pipe(Effect.ensuring(Effect.sync(() => Fs.rmSync(dir, { recursive: true, force: true }))));
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
    const delayed = CredentialStore.CredentialStore.of({
      ...base,
      touchThread: (...args) =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(resume)),
          Effect.andThen(base.touchThread(...args)),
        ),
    });
    const registry = yield* McpSessionRegistry.__testing
      .make({ now: () => 1_000 })
      .pipe(
        Effect.provideService(HttpServer.HttpServer, fakeHttpServer),
        Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
        Effect.provideService(CredentialStore.CredentialStore, delayed),
      );
    const issued = yield* registry.issue({
      threadId: ThreadId.make("race"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
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
