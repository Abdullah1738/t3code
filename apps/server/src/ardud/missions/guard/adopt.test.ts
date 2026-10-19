/**
 * Legacy schedules and watches on mission threads become the master's at
 * import; anything recorded, off the mission, or not watched is left alone.
 */
import { assert, describe, it } from "@effect/vitest";
import { RoleId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../../../persistence/Sqlite.ts";
import { adoptLegacyAuthority, renderAdoption, type AdoptionCast } from "./adopt.ts";
import { authorityStore } from "./authority.ts";
import { lane, master, membershipGuard, outsider } from "./guard.testkit.ts";
import type { GuardPrincipal } from "./principal.ts";
import { admitWatchWake } from "./watches.ts";

const retired = ThreadId.make("t-retired");
const masterRole = RoleId.make("m-1:master");
const cast: AdoptionCast = {
  roles: [
    { id: masterRole, kind: "master" },
    { id: RoleId.make("m-1:lane-lead:api"), kind: "lane-lead" },
  ],
  bindings: [
    { roleId: masterRole, threadId: master, endedAt: null },
    { roleId: RoleId.make("m-1:lane-lead:api"), threadId: lane, endedAt: null },
    {
      roleId: masterRole,
      threadId: ThreadId.make("t-old-master"),
      endedAt: "2026-10-01T00:00:00.000Z",
    },
  ],
  lanes: [
    { threadId: lane, status: "working" },
    { threadId: retired, status: "retired" },
  ],
};

const at = "2026-10-01T00:00:00.000Z";
const link = (number: number, extra: Record<string, unknown> = {}) => ({
  host: "github.com",
  repository: "Org/Repo",
  number,
  url: `https://github.com/Org/Repo/pull/${number}`,
  source: "manual",
  linkedAt: at,
  snapshot: null,
  stack: null,
  ...extra,
});
const watch = { startedAt: at, headSha: null, failedChecks: [], passed: false, passedChecks: [] };

const harness = Effect.gen(function* () {
  const seen = yield* membershipGuard;
  const sql = yield* SqlClient.SqlClient;
  const schedule = (id: string, threadId: string) =>
    sql`INSERT INTO scheduled_tasks ${sql.insert({
      task_id: id,
      title: `Task ${id}`,
      prompt: "Check in.",
      enabled: 1,
      schedule_json: '{"type":"interval","everyMs":60000}',
      project_id: "project-1",
      thread_id: threadId,
      workspace_strategy_json: '{"type":"root"}',
      model_selection_json: '{"instanceId":"codex","model":"gpt-5"}',
      runtime_mode: "full-access",
      interaction_mode: "default",
      created_by: "agent",
      creation_source: "mcp",
      created_at: at,
      updated_at: at,
      next_run_at: at,
      last_run_at: null,
      last_run_status: "never",
      last_run_error: null,
      run_count: 0,
    })}`;
  const thread = (
    threadId: string,
    pullRequests: ReadonlyArray<unknown>,
    options: { archivedAt?: string } = {},
  ) =>
    sql`
      INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        created_at, updated_at, archived_at, deleted_at, payload_json
      ) VALUES (
        ${threadId}, 'project-1', ${threadId}, 'codex', 'full-access', 'default',
        ${at}, ${at}, ${options.archivedAt ?? null}, NULL,
        ${JSON.stringify({ archivedAt: options.archivedAt ?? null, pullRequests })}
      )
    `;
  const store = authorityStore(sql);
  yield* schedule("task-master", master);
  yield* schedule("task-lane", lane);
  yield* schedule("task-owner", lane);
  yield* schedule("task-outsider", outsider);
  yield* schedule("task-retired", retired);
  yield* store.bind("scheduled-task", "task-owner", {
    _tag: "owner",
    provenance: { _tag: "owner-app", surface: "web", sessionId: "session-owner" },
  });
  yield* thread(lane, [link(7, { watch }), link(8), link(9, { watch, source: "stack-dismissed" })]);
  yield* thread(master, [link(10, { watch })], { archivedAt: at });
  yield* thread(outsider, [link(11, { watch })]);
  return { sql, store, seen };
});

const run = <A, E>(
  body: (
    h: Effect.Success<typeof harness>,
  ) => Effect.Effect<A, E, Scope.Scope | SqlClient.SqlClient>,
) => Effect.scoped(Effect.flatMap(harness, body)).pipe(Effect.provide(Sqlite.layerMemory));

const authorityRows = (sql: SqlClient.SqlClient) =>
  sql<{ readonly kind: string; readonly subjectId: string; readonly json: string }>`
    SELECT kind, subject_id AS "subjectId", principal_json AS "json"
    FROM ardud_mission_guard_authority ORDER BY kind, subject_id
  `;

describe("legacy authority adoption at import", () => {
  it.effect("lists the mission threads' unrecorded schedules and watches, writing nothing", () =>
    run(({ sql }) =>
      Effect.gen(function* () {
        const before = yield* authorityRows(sql);
        const adoption = yield* adoptLegacyAuthority(cast, { apply: false });
        assert.equal(adoption.master, master);
        assert.isFalse(adoption.applied);
        assert.deepStrictEqual(
          adoption.schedules.map((schedule) => schedule.id),
          ["task-lane", "task-master"],
        );
        assert.deepStrictEqual(adoption.watches, [
          { threadId: lane, pullRequest: "github.com/org/repo#7" },
        ]);
        assert.deepStrictEqual(yield* authorityRows(sql), before);
        const report = renderAdoption(adoption);
        assert.include(
          report,
          `would adopt as the master's (${master}): 2 schedule(s), 1 watch(es)`,
        );
        assert.include(report, `schedule task-lane on ${lane}: Task task-lane`);
        assert.include(report, `watch github.com/org/repo#7 on ${lane}`);
      }),
    ),
  );

  it.effect("records the master as their setter, so they run instead of knocking", () =>
    run(({ store }) =>
      Effect.gen(function* () {
        const pr = { host: "github.com", repository: "Org/Repo", number: 7, url: link(7).url };
        const wake = (wakeId: string) =>
          admitWatchWake(store, { threadId: lane, link: pr, text: "Checks passed.", wakeId });
        assert.isFalse(yield* wake("before"));

        const adoption = yield* adoptLegacyAuthority(cast, { apply: true });
        assert.isTrue(adoption.applied);
        const asMaster: GuardPrincipal = { _tag: "thread", threadId: master, title: master };
        for (const id of ["task-lane", "task-master"]) {
          assert.deepStrictEqual(yield* store.read("scheduled-task", id), asMaster);
        }
        assert.equal((yield* store.read("scheduled-task", "task-owner"))?._tag, "owner");
        assert.isNull(yield* store.read("scheduled-task", "task-outsider"));
        assert.isNull(yield* store.read("scheduled-task", "task-retired"));
        assert.isTrue(yield* wake("after"));
        assert.include(renderAdoption(adoption), "adopted as the master's");

        const again = yield* adoptLegacyAuthority(cast, { apply: true });
        assert.deepStrictEqual([again.schedules.length, again.watches.length], [0, 0]);
        assert.include(renderAdoption(again), "none on mission threads");
      }),
    ),
  );

  it.effect("adopts nothing when no thread holds the master role", () =>
    run(({ store }) =>
      Effect.gen(function* () {
        const adoption = yield* adoptLegacyAuthority(
          { ...cast, bindings: cast.bindings.filter((binding) => binding.roleId !== masterRole) },
          { apply: true },
        );
        assert.isNull(adoption.master);
        assert.isFalse(adoption.applied);
        assert.isNull(yield* store.read("scheduled-task", "task-lane"));
        assert.include(renderAdoption(adoption), "no thread holds the master role: none adopted");
      }),
    ),
  );
});
