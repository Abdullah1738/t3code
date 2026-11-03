import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";

export class CredentialStoreError extends Schema.TaggedError<CredentialStoreError>()(
  "CredentialStoreError",
  { operation: Schema.String },
) {
  override get message(): string {
    return `MCP credential persistence failed (${this.operation}).`;
  }
}

export interface CredentialRecord {
  readonly tokenHash: string;
  readonly scope: McpInvocationContext.McpThreadInvocationScope;
  readonly lastAliveAt: number;
}

export class CredentialStore extends Context.Service<
  CredentialStore,
  {
    readonly load: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<ReadonlyArray<CredentialRecord>, CredentialStoreError>;
    readonly insert: (record: CredentialRecord) => Effect.Effect<void, CredentialStoreError>;
    readonly updateLiveness: (
      environmentId: EnvironmentId,
      tokenHash: string,
      timestamp: number,
    ) => Effect.Effect<void, CredentialStoreError>;
    readonly touchThread: (
      environmentId: EnvironmentId,
      threadId: ThreadId,
      timestamp: number,
    ) => Effect.Effect<void, CredentialStoreError>;
    readonly revokeThread: (
      environmentId: EnvironmentId,
      threadId: ThreadId,
    ) => Effect.Effect<void, CredentialStoreError>;
    readonly revokeProviderSession: (
      environmentId: EnvironmentId,
      providerSessionId: string,
    ) => Effect.Effect<void, CredentialStoreError>;
    readonly revokeAll: (environmentId: EnvironmentId) => Effect.Effect<void, CredentialStoreError>;
  }
>()("t3/ardud/mcp/CredentialStore") {}

const Capabilities = Schema.fromJsonString(
  Schema.Array(Schema.Literals(McpInvocationContext.ALL_MCP_CAPABILITIES)),
);
const encodeCapabilities = Schema.encodeSync(Capabilities);
const Row = Schema.Struct({
  token_hash: Schema.String,
  environment_id: EnvironmentId,
  request_namespace: Schema.String,
  thread_id: ThreadId,
  provider_session_id: Schema.String,
  provider_instance_id: ProviderInstanceId,
  capabilities: Capabilities,
  issued_at: Schema.Number,
  last_alive_at: Schema.Number,
});
const decodeRow = Schema.decodeUnknownEffect(Row);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Do not include SQL errors or malformed row values in logs or error messages.
  const fail = (operation: string) => () => new CredentialStoreError({ operation });

  yield* sql`
    CREATE TABLE IF NOT EXISTS ardud_mcp_credentials (
      token_hash TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL,
      request_namespace TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      provider_session_id TEXT NOT NULL,
      provider_instance_id TEXT NOT NULL,
      capabilities TEXT NOT NULL,
      issued_at INTEGER NOT NULL,
      last_alive_at INTEGER NOT NULL
    )
  `.pipe(Effect.mapError(fail("initialize")));
  yield* sql`CREATE INDEX IF NOT EXISTS ardud_mcp_credentials_thread ON ardud_mcp_credentials (environment_id, thread_id)`.pipe(
    Effect.mapError(fail("initialize")),
  );
  yield* sql`CREATE INDEX IF NOT EXISTS ardud_mcp_credentials_provider_session ON ardud_mcp_credentials (environment_id, provider_session_id)`.pipe(
    Effect.mapError(fail("initialize")),
  );

  const load = Effect.fn("CredentialStore.load")(
    function* (environmentId: EnvironmentId) {
      const rows = yield* sql`SELECT token_hash, environment_id, request_namespace, thread_id,
      provider_session_id, provider_instance_id, capabilities, issued_at, last_alive_at
      FROM ardud_mcp_credentials WHERE environment_id = ${environmentId}`;
      return yield* Effect.forEach(rows, (raw) =>
        decodeRow(raw).pipe(
          Effect.flatMap((row) => {
            if (
              !/^[0-9a-f]{64}$/.test(row.token_hash) ||
              !row.request_namespace ||
              !row.provider_session_id ||
              !Number.isFinite(row.issued_at) ||
              !Number.isFinite(row.last_alive_at)
            ) {
              return Effect.fail(new CredentialStoreError({ operation: "decode" }));
            }
            return Effect.succeed({
              tokenHash: row.token_hash,
              scope: {
                environmentId: row.environment_id,
                requestNamespace: row.request_namespace,
                thread: {
                  threadId: row.thread_id,
                  providerSessionId: row.provider_session_id,
                  providerInstanceId: row.provider_instance_id,
                },
                client: undefined,
                capabilities: new Set(row.capabilities),
                issuedAt: row.issued_at,
              },
              lastAliveAt: row.last_alive_at,
            });
          }),
        ),
      );
    },
    Effect.mapError(fail("load")),
  );

  const insert = Effect.fn("CredentialStore.insert")(
    function* (record: CredentialRecord) {
      const { scope } = record;
      yield* sql`INSERT INTO ardud_mcp_credentials
      (token_hash, environment_id, request_namespace, thread_id, provider_session_id, provider_instance_id, capabilities, issued_at, last_alive_at)
      VALUES (${record.tokenHash}, ${scope.environmentId}, ${scope.requestNamespace}, ${scope.thread.threadId},
        ${scope.thread.providerSessionId}, ${scope.thread.providerInstanceId}, ${encodeCapabilities([...scope.capabilities])}, ${scope.issuedAt}, ${record.lastAliveAt})`;
    },
    Effect.mapError(fail("insert")),
  );

  const updateLiveness = Effect.fn("CredentialStore.updateLiveness")(
    function* (environmentId: EnvironmentId, tokenHash: string, timestamp: number) {
      yield* sql`UPDATE ardud_mcp_credentials SET last_alive_at = ${timestamp} WHERE environment_id = ${environmentId} AND token_hash = ${tokenHash}`;
    },
    Effect.mapError(fail("update-liveness")),
  );
  const touchThread = Effect.fn("CredentialStore.touchThread")(
    function* (environmentId: EnvironmentId, threadId: ThreadId, timestamp: number) {
      yield* sql`UPDATE ardud_mcp_credentials SET last_alive_at = ${timestamp} WHERE environment_id = ${environmentId} AND thread_id = ${threadId}`;
    },
    Effect.mapError(fail("touch-thread")),
  );
  const revokeThread = Effect.fn("CredentialStore.revokeThread")(
    function* (environmentId: EnvironmentId, threadId: ThreadId) {
      yield* sql`DELETE FROM ardud_mcp_credentials WHERE environment_id = ${environmentId} AND thread_id = ${threadId}`;
    },
    Effect.mapError(fail("revoke-thread")),
  );
  const revokeProviderSession = Effect.fn("CredentialStore.revokeProviderSession")(
    function* (environmentId: EnvironmentId, providerSessionId: string) {
      yield* sql`DELETE FROM ardud_mcp_credentials WHERE environment_id = ${environmentId} AND provider_session_id = ${providerSessionId}`;
    },
    Effect.mapError(fail("revoke-provider-session")),
  );
  const revokeAll = Effect.fn("CredentialStore.revokeAll")(
    function* (environmentId: EnvironmentId) {
      yield* sql`DELETE FROM ardud_mcp_credentials WHERE environment_id = ${environmentId}`;
    },
    Effect.mapError(fail("revoke-all")),
  );
  return CredentialStore.of({
    load,
    insert,
    updateLiveness,
    touchThread,
    revokeThread,
    revokeProviderSession,
    revokeAll,
  });
});

export const layer = Layer.effect(CredentialStore, make);
