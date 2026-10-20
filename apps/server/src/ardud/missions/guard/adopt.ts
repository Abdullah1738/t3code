/**
 * Legacy authority. Schedules and pull request watches made before the guard
 * recorded who set them up have no authority row, so each of their runs
 * knocks. At import the mission's master adopts the ones bound to mission
 * threads (coordinator call): from then on they run as the master's, and the
 * import report lists every one. A recorded authority is never replaced.
 */
import type { Lane, Role, RoleBinding, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import { threadPullRequestKeyOf } from "@t3tools/shared/threadPullRequests";

import { encodePrincipal, ensureAuthorityTable } from "./authority.ts";
import type { GuardPrincipal } from "./principal.ts";
import { watchKey } from "./watches.ts";

/** The parts of an imported mission that say who its master and members are. */
export interface AdoptionCast {
  readonly roles: ReadonlyArray<Pick<Role, "id" | "kind">>;
  readonly bindings: ReadonlyArray<Pick<RoleBinding, "roleId" | "threadId" | "endedAt">>;
  readonly lanes: ReadonlyArray<Pick<Lane, "threadId" | "status">>;
}

export interface AdoptedSchedule {
  readonly id: string;
  readonly threadId: string;
  readonly title: string;
}

export interface AdoptedWatch {
  readonly threadId: string;
  readonly pullRequest: string;
}

export interface LegacyAdoption {
  /** Null when no thread holds the master role; then nothing is adopted. */
  readonly master: ThreadId | null;
  readonly schedules: ReadonlyArray<AdoptedSchedule>;
  readonly watches: ReadonlyArray<AdoptedWatch>;
  readonly applied: boolean;
}

const IDS_PER_READ = 400;

const chunks = <A>(items: ReadonlyArray<A>): Array<ReadonlyArray<A>> => {
  const out: Array<ReadonlyArray<A>> = [];
  for (let at = 0; at < items.length; at += IDS_PER_READ) {
    out.push(items.slice(at, at + IDS_PER_READ));
  }
  return out;
};

// Only what tells a watched link apart; a link that does not decode is not adopted.
const ThreadLinks = Schema.fromJsonString(
  Schema.Struct({
    pullRequests: Schema.optional(
      Schema.Array(
        Schema.Struct({
          host: Schema.String,
          repository: Schema.String,
          number: Schema.Number,
          url: Schema.String,
          source: Schema.String,
          watch: Schema.optional(Schema.Unknown),
        }),
      ),
    ),
  }),
);
const decodeLinks = Schema.decodeUnknownOption(ThreadLinks);

const castThreads = (cast: AdoptionCast) => {
  const active = cast.bindings.filter((binding) => binding.endedAt === null);
  const masterRoles = new Set(
    cast.roles.filter((role) => role.kind === "master").map((role) => role.id),
  );
  const master = active.find((binding) => masterRoles.has(binding.roleId))?.threadId ?? null;
  const members = new Set<string>(active.map((binding) => binding.threadId));
  for (const lane of cast.lanes) {
    if (lane.status !== "retired" && lane.threadId !== null) members.add(lane.threadId);
  }
  return { master, members: [...members].toSorted() };
};

/**
 * Finds the mission threads' schedules and watches nobody is recorded as
 * having set up, and with `apply` records the master as their authority. A
 * dry run writes nothing. Tables the target does not have yet hold nothing.
 */
export const adoptLegacyAuthority = (
  cast: AdoptionCast,
  options: { readonly apply: boolean },
): Effect.Effect<LegacyAdoption, SqlError.SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { master, members } = castThreads(cast);
    const tables = new Set(
      (yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ${sql.in([
          "scheduled_tasks",
          "orchestration_v2_projection_threads",
          "ardud_mission_guard_authority",
        ])}
      `).map((row) => row.name),
    );
    const recorded = new Set(
      tables.has("ardud_mission_guard_authority")
        ? (yield* sql<{ readonly kind: string; readonly subjectId: string }>`
            SELECT kind, subject_id AS "subjectId" FROM ardud_mission_guard_authority
            WHERE kind IN ('scheduled-task', 'pr-watch')
          `).map((row) => `${row.kind}|${row.subjectId}`)
        : [],
    );

    const schedules: Array<AdoptedSchedule> = [];
    const watches: Array<AdoptedWatch & { readonly key: string }> = [];
    for (const chunk of chunks(members)) {
      if (tables.has("scheduled_tasks")) {
        const rows = yield* sql<AdoptedSchedule>`
          SELECT task_id AS "id", thread_id AS "threadId", title FROM scheduled_tasks
          WHERE thread_id IN ${sql.in(chunk)}
        `;
        for (const row of rows) {
          if (!recorded.has(`scheduled-task|${row.id}`)) schedules.push(row);
        }
      }
      if (tables.has("orchestration_v2_projection_threads")) {
        // The same threads the pull request watch reactor sweeps.
        const rows = yield* sql<{ readonly threadId: ThreadId; readonly payload: string }>`
          SELECT thread_id AS "threadId", payload_json AS "payload"
          FROM orchestration_v2_projection_threads
          WHERE thread_id IN ${sql.in(chunk)}
            AND deleted_at IS NULL
            AND json_extract(payload_json, '$.archivedAt') IS NULL
        `;
        for (const row of rows) {
          const links = Option.match(decodeLinks(row.payload), {
            onNone: () => [],
            onSome: (decoded) => decoded.pullRequests ?? [],
          });
          for (const link of links) {
            if (link.watch === undefined || link.source === "stack-dismissed") continue;
            const key = watchKey(row.threadId, link);
            if (recorded.has(`pr-watch|${key}`)) continue;
            watches.push({
              threadId: row.threadId,
              pullRequest: threadPullRequestKeyOf(link),
              key,
            });
          }
        }
      }
    }
    schedules.sort((left, right) => left.id.localeCompare(right.id));
    watches.sort((left, right) => left.key.localeCompare(right.key));

    const apply = options.apply && master !== null;
    if (apply && schedules.length + watches.length > 0) {
      const principal = encodePrincipal({
        _tag: "thread",
        threadId: master,
        title: master,
      } satisfies GuardPrincipal);
      const recordedAt = DateTime.formatIso(yield* DateTime.now);
      const rows = [
        ...schedules.map((schedule) => ["scheduled-task", schedule.id] as const),
        ...watches.map((watch) => ["pr-watch", watch.key] as const),
      ];
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* ensureAuthorityTable(sql);
          for (const [kind, subjectId] of rows) {
            yield* sql`
              INSERT INTO ardud_mission_guard_authority (kind, subject_id, principal_json, recorded_at)
              VALUES (${kind}, ${subjectId}, ${principal}, ${recordedAt})
              ON CONFLICT (kind, subject_id) DO NOTHING
            `;
          }
        }),
      );
    }
    return {
      master,
      schedules,
      watches: watches.map(({ threadId, pullRequest }) => ({ threadId, pullRequest })),
      applied: apply,
    };
  });

/** The import report's section for `adoptLegacyAuthority`. */
export const renderAdoption = (adoption: LegacyAdoption): string => {
  const out = ["", "Legacy schedules and watches (no recorded setter)"];
  const total = adoption.schedules.length + adoption.watches.length;
  if (total === 0) {
    out.push("  none on mission threads");
  } else if (adoption.master === null) {
    out.push(
      `  ${total} found, but no thread holds the master role: none adopted, they keep knocking`,
    );
  } else {
    out.push(
      `  ${adoption.applied ? "adopted" : "would adopt"} as the master's (${adoption.master}): ` +
        `${adoption.schedules.length} schedule(s), ${adoption.watches.length} watch(es)`,
    );
  }
  for (const schedule of adoption.schedules) {
    out.push(`  schedule ${schedule.id} on ${schedule.threadId}: ${schedule.title}`);
  }
  for (const watch of adoption.watches) {
    out.push(`  watch ${watch.pullRequest} on ${watch.threadId}`);
  }
  return `${out.join("\n")}\n`;
};
