/**
 * H7: schedules bound to mission members. Every change and every run is judged
 * against the recorded authority or the actual caller, never the task's
 * caller-written `createdBy`.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import { ScheduledTaskUpsertInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadLaunchService from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../../../scheduling/Scheduler.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import { authorityStore } from "./authority.ts";
import {
  lane,
  makeDelivered,
  master,
  membershipGuard,
  outsider,
  recordingThreads,
} from "./guard.testkit.ts";
import { CurrentPrincipal, type GuardPrincipal } from "./principal.ts";
import { refusedByGuard, withoutHiddenWebhooks } from "./schedules.ts";

const decodeUpsert = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);

const owner: GuardPrincipal = {
  _tag: "owner",
  provenance: { _tag: "owner-app", surface: "web", sessionId: "session-owner" },
};
const asThread = (threadId: typeof master, title = threadId): GuardPrincipal => ({
  _tag: "thread",
  threadId,
  title,
});
const cliSession: GuardPrincipal = {
  _tag: "session",
  sessionId: "session-cli",
  subject: "cli-issued-session",
};

const taskInput = (overrides: Record<string, unknown> = {}) =>
  decodeUpsert({
    id: "scheduled-task:check",
    title: "Release check",
    prompt: "Check in on the release.",
    enabled: true,
    schedule: { type: "interval", everyMs: 3_600_000 },
    projectId: "project:guard",
    threadId: master,
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: "codex", model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdBy: "agent",
    creationSource: "mcp",
    ...overrides,
  });

const as =
  (principal: GuardPrincipal | undefined) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, CurrentPrincipal, principal);

/** A real scheduler over in-memory SQLite, with the membership guard installed. */
const harness = Effect.gen(function* () {
  const delivered = yield* makeDelivered;
  const seen = yield* membershipGuard;
  const context = yield* Layer.build(
    Layer.provideMerge(
      ScheduledTaskService.layer,
      Layer.mergeAll(
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
        recordingThreads(delivered),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.succeed(
          ScheduledTaskService.ScheduledTaskWebhookOrigin,
          Effect.succeed({ relayHookBaseUrl: "https://relay.example.com/v1/hooks/abc" }),
        ),
        NodeCrypto.layer,
        Scheduler.layer,
      ),
    ),
  );
  const service = yield* ScheduledTaskService.ScheduledTaskService.pipe(Effect.provide(context));
  const store = authorityStore(yield* SqlClient.SqlClient);
  return { service, store, seen, delivered };
});

const run = <A, E>(body: (h: Effect.Success<typeof harness>) => Effect.Effect<A, E, Scope.Scope>) =>
  Effect.scoped(Effect.flatMap(harness, body)).pipe(Effect.provide(Sqlite.layerMemory));

describe("schedules bound to mission members (H7)", () => {
  it.effect("a control bearer cannot bind a schedule to the master", () =>
    run(({ service, seen }) =>
      Effect.gen(function* () {
        const error = yield* service.upsert(yield* taskInput()).pipe(as(cliSession), Effect.flip);
        assert.isTrue(refusedByGuard(error));
        assert.equal(seen[0]?.path, "schedule-edit");
        const { tasks } = yield* service.list();
        assert.equal(tasks.length, 0);
      }),
    ),
  );

  it.effect("an outsider cannot turn the master's schedule into an unsigned webhook", () =>
    run(({ service, seen }) =>
      Effect.gen(function* () {
        yield* service.upsert(yield* taskInput()).pipe(as(owner));
        // Same prompt: only the trigger and the signature change.
        const error = yield* service
          .upsert(yield* taskInput({ schedule: { type: "webhook", signature: null } }))
          .pipe(as(asThread(outsider)), Effect.flip);
        assert.isTrue(refusedByGuard(error));
        assert.equal(seen.at(-1)?.path, "schedule-edit");
        const { tasks } = yield* service.list();
        assert.equal(tasks[0]?.schedule.type, "interval");
      }),
    ),
  );

  it.effect("an outsider cannot pause, delete or run the master's schedule", () =>
    run(({ service, delivered }) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(yield* taskInput()).pipe(as(owner));
        const outsiderCall = as(asThread(outsider));
        const pause = yield* service
          .setEnabled({ id: task.id, enabled: false })
          .pipe(outsiderCall, Effect.flip);
        assert.isTrue(refusedByGuard(pause));
        const remove = yield* service.delete({ id: task.id }).pipe(outsiderCall, Effect.flip);
        assert.isTrue(refusedByGuard(remove));

        // run_scheduled_task_now speaks as its caller, not as the owner who made the task.
        const { task: after } = yield* service.runNow({ id: task.id }).pipe(outsiderCall);
        assert.equal(after.lastRunStatus, "failed");
        assert.include(after.lastRunError ?? "", "waiting in the owner's inbox");
        assert.equal(yield* Queue.size(delivered.sends), 0);
      }),
    ),
  );

  it.effect("only the owner, the bound thread and the recorded creator see a webhook URL", () =>
    run(({ service, store }) =>
      Effect.gen(function* () {
        yield* service
          .upsert(yield* taskInput({ schedule: { type: "webhook" } }))
          .pipe(as(asThread(master)));
        const { tasks } = yield* service.list();
        assert.isNotNull(tasks[0]?.webhook?.url ?? null);
        const visibleTo = (principal: GuardPrincipal) =>
          withoutHiddenWebhooks(store, principal, tasks).pipe(
            Effect.map((visible) => visible[0]?.webhook !== undefined),
          );
        assert.isTrue(yield* visibleTo(owner));
        assert.isTrue(yield* visibleTo(asThread(master)));
        assert.isFalse(yield* visibleTo(asThread(outsider)));
        assert.isFalse(yield* visibleTo(asThread(lane)));
        assert.isFalse(yield* visibleTo(cliSession));
      }),
    ),
  );

  it.effect("an agent schedule nobody recorded is not treated as the thread's own", () =>
    run(({ service, delivered, seen }) =>
      Effect.gen(function* () {
        // In-process saves (imports, migrations) record no authority.
        const { task } = yield* service.upsert(yield* taskInput());
        const { task: after } = yield* service.runNow({ id: task.id });
        assert.equal(after.lastRunStatus, "failed");
        assert.deepStrictEqual(seen.at(-1)?.from, {
          _tag: "schedule",
          scheduledTaskId: task.id,
          title: task.title,
          creator: null,
        });
        assert.equal(yield* Queue.size(delivered.sends), 0);
      }),
    ),
  );

  it.effect("owner schedules, self schedules and the master's schedules for its lanes run", () =>
    run(({ service, delivered }) =>
      Effect.gen(function* () {
        const owners = yield* service
          .upsert(yield* taskInput({ id: "scheduled-task:owner" }))
          .pipe(as(owner));
        const own = yield* service
          .upsert(yield* taskInput({ id: "scheduled-task:self" }))
          .pipe(as(asThread(master)));
        const forLane = yield* service
          .upsert(yield* taskInput({ id: "scheduled-task:lane", threadId: lane }))
          .pipe(as(asThread(master)));
        for (const { task } of [owners, own, forLane]) {
          // No invoker: the run speaks as whoever authorized the schedule.
          const { task: after } = yield* service.runNow({ id: task.id });
          assert.notEqual(after.lastRunStatus, "failed", after.lastRunError ?? "");
        }
        const sends = yield* Queue.takeAll(delivered.sends);
        assert.deepStrictEqual(
          sends.map((send) => send.threadId),
          [master, master, lane],
        );
      }),
    ),
  );

  it.effect("a lane cannot schedule text into its master", () =>
    run(({ service, seen }) =>
      Effect.gen(function* () {
        const error = yield* service
          .upsert(yield* taskInput())
          .pipe(as(asThread(lane)), Effect.flip);
        assert.isTrue(refusedByGuard(error));
        assert.deepStrictEqual(seen.at(-1)?.from, { _tag: "thread", threadId: lane, title: lane });
      }),
    ),
  );
});
