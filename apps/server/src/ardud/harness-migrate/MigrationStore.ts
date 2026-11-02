/**
 * Reads and writes the migration ledger. The state rules live in
 * MigrationLedger.ts; this only runs the DDL and the row queries.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { LEDGER_DDL, type MigrationState } from "./MigrationLedger.ts";

export class MigrationStoreError extends Schema.TaggedError<MigrationStoreError>()(
  "MigrationStoreError",
  { operation: Schema.String, cause: Schema.Unknown },
) {}

export interface LedgerEntry {
  readonly threadId: string;
  readonly version: number;
  readonly sourceSession: string;
  readonly sourceDigest: string;
  readonly targetDriver: string;
  readonly targetInstance: string;
  readonly targetNativeId: string;
  readonly home: string | null;
  readonly cliVersion: string | null;
  readonly state: MigrationState;
  readonly error: string | null;
  readonly firstResumeConfirmedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly originalSelectionJson: string;
}

interface EntryRow {
  readonly thread_id: string;
  readonly version: number;
  readonly source_session: string;
  readonly source_digest: string;
  readonly target_driver: string;
  readonly target_instance: string;
  readonly target_native_id: string;
  readonly home: string | null;
  readonly cli_version: string | null;
  readonly state: MigrationState;
  readonly error: string | null;
  readonly first_resume_confirmed_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly original_selection_json: string;
}

const fromRow = (row: EntryRow): LedgerEntry => ({
  threadId: row.thread_id,
  version: row.version,
  sourceSession: row.source_session,
  sourceDigest: row.source_digest,
  targetDriver: row.target_driver,
  targetInstance: row.target_instance,
  targetNativeId: row.target_native_id,
  home: row.home,
  cliVersion: row.cli_version,
  state: row.state,
  error: row.error,
  firstResumeConfirmedAt: row.first_resume_confirmed_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  originalSelectionJson: row.original_selection_json,
});

export interface MigrationStoreShape {
  readonly get: (threadId: string) => Effect.Effect<LedgerEntry | null, MigrationStoreError>;
  readonly list: () => Effect.Effect<ReadonlyArray<LedgerEntry>, MigrationStoreError>;
  readonly insert: (entry: LedgerEntry) => Effect.Effect<void, MigrationStoreError>;
  readonly setState: (input: {
    readonly threadId: string;
    readonly state: MigrationState;
    readonly updatedAt: string;
    readonly error?: string | null;
    readonly firstResumeConfirmedAt?: string | null;
  }) => Effect.Effect<void, MigrationStoreError>;
}

export class MigrationStore extends Context.Service<MigrationStore, MigrationStoreShape>()(
  "t3/ardud/harness-migrate/MigrationStore",
) {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fail = (operation: string) => (cause: unknown) => new MigrationStoreError({ operation, cause });

  yield* sql.unsafe(LEDGER_DDL).pipe(Effect.mapError(fail("ensure-ledger")));

  return MigrationStore.of({
    get: (threadId) =>
      sql<EntryRow>`
        SELECT * FROM ardud_harness_migration WHERE thread_id = ${threadId}
      `.pipe(
        Effect.map((rows) => (rows[0] === undefined ? null : fromRow(rows[0]))),
        Effect.mapError(fail("get")),
      ),
    list: () =>
      sql<EntryRow>`
        SELECT * FROM ardud_harness_migration ORDER BY created_at, thread_id
      `.pipe(
        Effect.map((rows) => rows.map(fromRow)),
        Effect.mapError(fail("list")),
      ),
    insert: (entry) =>
      sql`
        INSERT INTO ardud_harness_migration (
          thread_id, version, source_session, source_digest, target_driver,
          target_instance, target_native_id, home, cli_version, state, error,
          first_resume_confirmed_at, created_at, updated_at, original_selection_json
        ) VALUES (
          ${entry.threadId}, ${entry.version}, ${entry.sourceSession}, ${entry.sourceDigest},
          ${entry.targetDriver}, ${entry.targetInstance}, ${entry.targetNativeId}, ${entry.home},
          ${entry.cliVersion}, ${entry.state}, ${entry.error}, ${entry.firstResumeConfirmedAt},
          ${entry.createdAt}, ${entry.updatedAt}, ${entry.originalSelectionJson}
        )
      `.pipe(Effect.asVoid, Effect.mapError(fail("insert"))),
    setState: (input) =>
      sql`
        UPDATE ardud_harness_migration
        SET state = ${input.state},
            updated_at = ${input.updatedAt},
            error = ${input.error ?? null},
            first_resume_confirmed_at = COALESCE(${input.firstResumeConfirmedAt ?? null}, first_resume_confirmed_at)
        WHERE thread_id = ${input.threadId}
      `.pipe(Effect.asVoid, Effect.mapError(fail("set-state"))),
  });
});

export const layer = Layer.effect(MigrationStore, make);
