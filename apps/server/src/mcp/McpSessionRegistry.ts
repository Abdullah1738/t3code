import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as CredentialStore from "../ardud/mcp/CredentialStore.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";

export interface McpCredentialRequest {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  /**
   * When false, the credential is minted without the "preview" capability so
   * the user's choice to withhold agent browser access holds everywhere the
   * token is honored (#7083). Defaults to full access.
   */
  readonly browserToolsAvailable?: boolean;
  readonly capabilities?: ReadonlySet<McpInvocationContext.McpCapability>;
}

export interface McpIssuedCredential {
  readonly config: McpProviderSession.McpProviderSessionConfig;
}

export interface McpSessionRegistryShape {
  readonly issue: (request: McpCredentialRequest) => Effect.Effect<McpIssuedCredential>;
  readonly resolve: (
    rawToken: string,
  ) => Effect.Effect<McpInvocationContext.McpThreadInvocationScope | undefined>;
  readonly touch: (threadId: ThreadId) => Effect.Effect<void>;
  readonly revokeProviderSession: (providerSessionId: string) => Effect.Effect<void>;
  readonly revokeThread: (threadId: ThreadId) => Effect.Effect<void>;
  readonly revokeAll: Effect.Effect<void>;
}

export class McpSessionRegistry extends Context.Service<
  McpSessionRegistry,
  McpSessionRegistryShape
>()("t3/mcp/McpSessionRegistry") {}

interface CredentialRecord extends CredentialStore.CredentialRecord {
  readonly persistedAliveAt: number;
}

interface RegistryState {
  readonly records: ReadonlyMap<string, CredentialRecord>;
}

export interface McpSessionRegistryOptions {
  readonly livenessWindowMs?: number;
  readonly now?: () => number;
}

/**
 * `/mcp` is outside environment auth, so idle tokens stop authenticating.
 * Keep expired records until explicit revocation: a trusted provider turn can
 * refresh the token its subprocess still holds; MCP requests cannot.
 */
const DEFAULT_LIVENESS_WINDOW_MS = 24 * 60 * 60 * 1_000;
const LIVENESS_WRITE_INTERVAL_MS = 60_000;

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const tokenFromBytes = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

const getHttpMcpEndpointHost = (address: NetAddress.IpAddress): string =>
  NetAddress.isUnspecified(address)
    ? "127.0.0.1"
    : NetAddress.formatUrlHostString(NetAddress.formatIp(address));

const makeWithOptions = Effect.fn("McpSessionRegistry.make")(function* (
  options: McpSessionRegistryOptions = {},
) {
  const crypto = yield* Crypto.Crypto;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const store = yield* CredentialStore.CredentialStore;
  const httpServer = yield* HttpServer.HttpServer;
  const loaded = yield* store.load(environmentId).pipe(Effect.orDie);
  const state = yield* SynchronizedRef.make<RegistryState>({
    records: new Map(
      loaded.map((record) => [
        record.tokenHash,
        { ...record, persistedAliveAt: record.lastAliveAt },
      ]),
    ),
  });
  const currentTimeMillis = options.now ? Effect.sync(options.now) : Clock.currentTimeMillis;
  const livenessWindowMs = options.livenessWindowMs ?? DEFAULT_LIVENESS_WINDOW_MS;
  const endpoint = NetAddress.isInetAddress(httpServer.address)
    ? `http://${getHttpMcpEndpointHost(httpServer.address.address)}:${httpServer.address.port}/mcp`
    : "http://127.0.0.1/mcp";

  const hashToken = (token: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(token))
      .pipe(Effect.map(bytesToHex), Effect.orDie);

  const issue: McpSessionRegistryShape["issue"] = Effect.fn("McpSessionRegistry.issue")(
    function* (request) {
      const issuedAt = yield* currentTimeMillis;
      const providerSessionId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      const rawToken = yield* crypto.randomBytes(32).pipe(Effect.map(tokenFromBytes), Effect.orDie);
      const tokenHash = yield* hashToken(rawToken);
      const browserToolsAvailable = request.browserToolsAvailable ?? true;
      const scope: McpInvocationContext.McpThreadInvocationScope = {
        environmentId,
        requestNamespace: providerSessionId,
        thread: {
          threadId: ThreadId.make(request.threadId),
          providerSessionId,
          providerInstanceId: ProviderInstanceId.make(request.providerInstanceId),
        },
        client: undefined,
        capabilities: new Set<McpInvocationContext.McpCapability>([
          "orchestration",
          "worktree",
          "pull-requests",
          ...(request.capabilities ?? (browserToolsAvailable ? (["preview"] as const) : [])),
        ]),
        issuedAt,
      };
      yield* SynchronizedRef.updateEffect(state, ({ records }) =>
        Effect.gen(function* () {
          const record = { tokenHash, scope, lastAliveAt: issuedAt, persistedAliveAt: issuedAt };
          yield* store.insert(record).pipe(Effect.orDie);
          const next = new Map(records);
          next.set(tokenHash, record);
          return { records: next };
        }),
      ).pipe(Effect.uninterruptible);
      return {
        config: {
          environmentId,
          threadId: scope.thread.threadId,
          providerSessionId,
          providerInstanceId: scope.thread.providerInstanceId,
          endpoint,
          authorizationHeader: `Bearer ${rawToken}`,
          browserToolsAvailable: scope.capabilities.has("preview"),
          capabilities: scope.capabilities,
        },
      };
    },
  );

  const resolve: McpSessionRegistryShape["resolve"] = Effect.fn("McpSessionRegistry.resolve")(
    function* (rawToken) {
      if (rawToken.length === 0) return undefined;
      const tokenHash = yield* hashToken(rawToken);
      return yield* SynchronizedRef.modifyEffect(state, ({ records }) =>
        Effect.gen(function* () {
          const timestamp = yield* currentTimeMillis;
          const record = records.get(tokenHash);
          if (!record || timestamp - record.lastAliveAt > livenessWindowMs) {
            return [undefined, { records }] as const;
          }
          const lastAliveAt = Math.max(timestamp, record.lastAliveAt);
          const persist = lastAliveAt - record.persistedAliveAt >= LIVENESS_WRITE_INTERVAL_MS;
          if (persist)
            yield* store.updateLiveness(environmentId, tokenHash, lastAliveAt).pipe(Effect.orDie);
          const next = new Map(records);
          next.set(tokenHash, {
            ...record,
            lastAliveAt,
            persistedAliveAt: persist ? lastAliveAt : record.persistedAliveAt,
          });
          return [record.scope, { records: next }] as const;
        }),
      ).pipe(Effect.uninterruptible);
    },
  );

  const touch: McpSessionRegistryShape["touch"] = Effect.fn("McpSessionRegistry.touch")(
    function* (threadId) {
      yield* SynchronizedRef.updateEffect(state, ({ records }) =>
        Effect.gen(function* () {
          const timestamp = yield* currentTimeMillis;
          const matching = Array.from(records.values()).filter(
            (record) => record.scope.thread.threadId === threadId,
          );
          if (matching.length === 0) return { records };
          const lastAliveAt = Math.max(timestamp, ...matching.map((record) => record.lastAliveAt));
          yield* store.touchThread(environmentId, threadId, lastAliveAt).pipe(Effect.orDie);
          const next = new Map(records);
          for (const record of matching)
            next.set(record.tokenHash, { ...record, lastAliveAt, persistedAliveAt: lastAliveAt });
          return { records: next };
        }),
      ).pipe(Effect.uninterruptible);
    },
  );

  const revokeWhere = (
    predicate: (record: CredentialRecord) => boolean,
    persist: Effect.Effect<void, CredentialStore.CredentialStoreError>,
  ) =>
    SynchronizedRef.updateEffect(state, ({ records }) =>
      persist.pipe(
        Effect.orDie,
        Effect.as({
          records: new Map(Array.from(records).filter(([, record]) => !predicate(record))),
        }),
      ),
    ).pipe(Effect.uninterruptible);

  return McpSessionRegistry.of({
    issue,
    resolve,
    touch,
    revokeProviderSession: Effect.fn("McpSessionRegistry.revokeProviderSession")(
      function* (providerSessionId) {
        yield* revokeWhere(
          (record) => record.scope.thread.providerSessionId === providerSessionId,
          store.revokeProviderSession(environmentId, providerSessionId),
        );
      },
    ),
    revokeThread: Effect.fn("McpSessionRegistry.revokeThread")(function* (threadId) {
      yield* revokeWhere(
        (record) => record.scope.thread.threadId === threadId,
        store.revokeThread(environmentId, threadId),
      );
    }),
    revokeAll: revokeWhere(() => true, store.revokeAll(environmentId)),
  });
});

let activeMcpSessionRegistry: McpSessionRegistryShape | undefined;

const make = Effect.acquireRelease(
  makeWithOptions().pipe(
    Effect.tap((registry) =>
      Effect.sync(() => {
        activeMcpSessionRegistry = registry;
      }),
    ),
  ),
  (registry) =>
    Effect.sync(() => {
      if (activeMcpSessionRegistry === registry) {
        activeMcpSessionRegistry = undefined;
      }
    }),
);

export const layer = Layer.effect(McpSessionRegistry, make);

export const issueActiveMcpCredential = (
  request: McpCredentialRequest,
): Effect.Effect<McpIssuedCredential | undefined> =>
  activeMcpSessionRegistry
    ? activeMcpSessionRegistry
        .revokeThread(request.threadId)
        .pipe(Effect.andThen(activeMcpSessionRegistry.issue(request)))
    : Effect.undefined;

export const touchActiveMcpThread = (threadId: ThreadId): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.touch(threadId) : Effect.void;

const revokeActiveMcpThread = (threadId: ThreadId): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.revokeThread(threadId) : Effect.void;

const revokeAllActiveMcpCredentials = (): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.revokeAll : Effect.void;

export const __testing = {
  make: makeWithOptions,
};
