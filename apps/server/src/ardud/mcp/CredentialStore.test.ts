// @effect-diagnostics nodeBuiltinImport:off
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as CredentialStore from "./CredentialStore.ts";

const environmentId = EnvironmentId.make("environment-store");
const otherEnvironmentId = EnvironmentId.make("environment-other");
const record: CredentialStore.CredentialRecord = {
  tokenHash: "a".repeat(64),
  scope: {
    environmentId,
    requestNamespace: "namespace-1",
    thread: {
      threadId: ThreadId.make("thread-1"),
      providerSessionId: "session-1",
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
    capabilities: new Set(["orchestration", "device"]),
    issuedAt: 123,
  },
  lastAliveAt: 124,
};

it.effect(
  "reopens hash-only records with their exact scope and applies conditional updates and revocation",
  () => {
    const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "mcp-credential-store-"));
    const file = Path.join(dir, "state.sqlite");
    const persistence = () => NodeSqliteClient.layer({ filename: file });
    const run = <A, E>(
      effect: Effect.Effect<A, E, CredentialStore.CredentialStore | SqlClient.SqlClient>,
    ) => effect.pipe(Effect.provide(CredentialStore.layer.pipe(Layer.provideMerge(persistence()))));
    return Effect.gen(function* () {
      yield* run(
        Effect.gen(function* () {
          const store = yield* CredentialStore.CredentialStore;
          yield* store.insert(record);
          yield* store.insert({
            ...record,
            tokenHash: "b".repeat(64),
            scope: { ...record.scope, environmentId: otherEnvironmentId },
          });
        }),
      );
      yield* run(
        Effect.gen(function* () {
          const store = yield* CredentialStore.CredentialStore;
          const sql = yield* SqlClient.SqlClient;
          expect(yield* store.load(environmentId)).toEqual([record]);
          expect(yield* store.load(otherEnvironmentId)).toHaveLength(1);
          const raw = yield* sql`SELECT * FROM ardud_mcp_credentials`;
          expect(JSON.stringify(raw)).not.toContain("Bearer");
          expect(Object.keys(raw[0]!)).toEqual(
            expect.not.arrayContaining(["token", "authorization_header"]),
          );
          yield* store.updateLiveness(environmentId, record.tokenHash, 222);
          expect((yield* store.load(environmentId))[0]?.lastAliveAt).toBe(222);
          yield* store.revokeProviderSession(environmentId, "session-1");
          yield* store.updateLiveness(environmentId, record.tokenHash, 333);
          yield* store.touchThread(environmentId, record.scope.thread.threadId, 333);
          expect(yield* store.load(environmentId)).toEqual([]);
          expect(yield* store.load(otherEnvironmentId)).toHaveLength(1);
          yield* store.revokeAll(otherEnvironmentId);
          expect(yield* store.load(otherEnvironmentId)).toEqual([]);
        }),
      );
    }).pipe(Effect.ensuring(Effect.sync(() => Fs.rmSync(dir, { recursive: true, force: true }))));
  },
);

it.effect("rejects invalid persisted capabilities and fields without exposing their values", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* CredentialStore.CredentialStore;
    yield* store.insert(record);
    yield* sql`UPDATE ardud_mcp_credentials SET capabilities = '["forged-capability"]'`;
    const failure = yield* store.load(environmentId).pipe(Effect.flip);
    expect(failure.operation).toBe("load");
    expect(String(failure)).not.toContain("forged-capability");
  }).pipe(
    Effect.provide(
      CredentialStore.layer.pipe(
        Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
      ),
    ),
  ),
);
