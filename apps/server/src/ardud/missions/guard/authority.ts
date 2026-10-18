/**
 * Who authorized something that later puts text into a thread: a schedule, a
 * pull request watch, a fork, or a control-API message or thread. Upstream
 * records only carry a `createdBy` label the caller chose, so the guard keeps
 * the authenticated principal here and reads it back when the thing fires.
 *
 * Reads fail closed: a missing or unreadable record is `null`, which the guard
 * treats as "not self, not owner".
 */
import { MissionProvenance, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { threadPullRequestKeyOf } from "@t3tools/shared/threadPullRequests";

import type { GuardPrincipal } from "./principal.ts";

export type AuthorityKind = "scheduled-task" | "pr-watch" | "fork" | "message" | "thread";

const DDL = `CREATE TABLE IF NOT EXISTS ardud_mission_guard_authority (
  kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  principal_json TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (kind, subject_id)
)`;

const PrincipalJson = Schema.fromJsonString(
  Schema.Union([
    Schema.TaggedStruct("owner", { provenance: MissionProvenance }),
    Schema.TaggedStruct("thread", { threadId: ThreadId, title: Schema.String }),
    Schema.TaggedStruct("session", { sessionId: Schema.String, subject: Schema.String }),
    Schema.TaggedStruct("mcp-client", { sessionId: Schema.String, label: Schema.String }),
  ]),
);
const encodePrincipal = Schema.encodeSync(PrincipalJson);
const decodePrincipal = Schema.decodeUnknownOption(PrincipalJson);

export interface AuthorityStore {
  /** Best effort: a failed write is logged, and the later read fails closed. */
  readonly record: (
    kind: AuthorityKind,
    subjectId: string,
    principal: GuardPrincipal,
  ) => Effect.Effect<void>;
  readonly read: (kind: AuthorityKind, subjectId: string) => Effect.Effect<GuardPrincipal | null>;
  readonly forget: (kind: AuthorityKind, subjectId: string) => Effect.Effect<void>;
}

const ready = new WeakSet<SqlClient.SqlClient>();

export const authorityStore = (sql: SqlClient.SqlClient): AuthorityStore => {
  const ensure = Effect.suspend(() =>
    ready.has(sql)
      ? Effect.void
      : sql.unsafe(DDL).pipe(
          Effect.andThen(
            Effect.sync(() => {
              ready.add(sql);
            }),
          ),
        ),
  );
  return {
    record: (kind, subjectId, principal) =>
      Effect.gen(function* () {
        yield* ensure;
        const recordedAt = DateTime.formatIso(yield* DateTime.now);
        yield* sql`
          INSERT INTO ardud_mission_guard_authority (kind, subject_id, principal_json, recorded_at)
          VALUES (${kind}, ${subjectId}, ${encodePrincipal(principal)}, ${recordedAt})
          ON CONFLICT (kind, subject_id) DO UPDATE SET
            principal_json = excluded.principal_json,
            recorded_at = excluded.recorded_at
        `;
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("missions guard: could not record authority", {
            kind,
            subjectId,
            cause,
          }),
        ),
      ),
    read: (kind, subjectId) =>
      Effect.gen(function* () {
        yield* ensure;
        const rows = yield* sql<{ readonly json: string }>`
          SELECT principal_json AS "json" FROM ardud_mission_guard_authority
          WHERE kind = ${kind} AND subject_id = ${subjectId}
        `;
        const row = rows[0];
        return row === undefined ? null : Option.getOrNull(decodePrincipal(row.json));
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("missions guard: could not read authority", {
            kind,
            subjectId,
            cause,
          }).pipe(Effect.as(null)),
        ),
      ),
    forget: (kind, subjectId) =>
      Effect.gen(function* () {
        yield* ensure;
        yield* sql`
          DELETE FROM ardud_mission_guard_authority WHERE kind = ${kind} AND subject_id = ${subjectId}
        `;
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("missions guard: could not forget authority", {
            kind,
            subjectId,
            cause,
          }),
        ),
      ),
  };
};

/** Nothing recorded and nothing remembered: every read is `null`. */
const noAuthority: AuthorityStore = {
  record: () => Effect.void,
  read: () => Effect.succeed(null),
  forget: () => Effect.void,
};

/**
 * The store over the app database when one is present, for services that do
 * not otherwise depend on SQL. Read once at construction.
 */
export const optionalAuthorityStore: Effect.Effect<AuthorityStore> = Effect.serviceOption(
  SqlClient.SqlClient,
).pipe(Effect.map(Option.match({ onNone: () => noAuthority, onSome: authorityStore })));

/** Key for a pull request watch on one thread, by the link's canonical identity. */
export const prWatchKey = (input: {
  readonly threadId: string;
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly url?: string;
}): string =>
  `${input.threadId}|${threadPullRequestKeyOf({
    host: input.host,
    repository: input.repository,
    number: input.number,
    ...(input.url === undefined ? {} : { url: input.url }),
  })}`;
