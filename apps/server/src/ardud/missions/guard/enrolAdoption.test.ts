/**
 * A thread enrolled after import hands its legacy schedules to the master:
 * their runs stop knocking, and one timeline event lists them.
 */
import { assert, it } from "@effect/vitest";
import { MissionId, RoleId, ScheduledTaskId, type MissionEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as MissionService from "../MissionService.ts";
import { OPUS_XHIGH } from "../policy/models.ts";
import * as PolicyService from "../policy/PolicyService.ts";
import { OWNER, makePorts, testLayer } from "../policy/testing.ts";
import * as MissionStore from "../store/MissionStore.ts";
import { authorityStore } from "./authority.ts";
import { adoptForEnrolment, enrolAdoptionLayer } from "./enrolAdoption.ts";
import { lane, master, membershipGuard, missionId } from "./guard.testkit.ts";
import { guardScheduleRun } from "./schedules.ts";

const ports = makePorts();
const at = "2026-10-01T00:00:00.000Z";
const taskId = ScheduledTaskId.make("task-lane");

const legacySchedule = (threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO scheduled_tasks ${sql.insert({
      task_id: taskId,
      title: "Lane check-in",
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
  });

it.effect("enrolling a thread with a legacy schedule lets the schedule run without knocking", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* membershipGuard;
      const sql = yield* SqlClient.SqlClient;
      const store = yield* MissionStore.MissionStore;
      // Subscribed first: the wiring adopts in the background, so the event may
      // follow the role binding or the lane, whichever it handles last.
      const subscription = yield* store.subscribe;
      const missions = yield* MissionService.MissionService;
      const policy = yield* PolicyService.PolicyService;
      const authority = authorityStore(sql);
      const run = guardScheduleRun(authority, {
        task: { id: taskId, title: "Lane check-in" },
        targetThreadId: lane,
        text: "Check in.",
        commandId: "command-1",
      });

      yield* missions.createMission(OWNER, {
        missionId: MissionId.make(missionId),
        slug: "m-1",
        title: "Mission",
      });
      ports.threads.set(master, { exists: true, idle: true, modelSelection: OPUS_XHIGH });
      yield* policy.bindRole(OWNER, { roleId: RoleId.make("m-1:master"), threadId: master });
      yield* legacySchedule(lane);
      const refused = yield* Effect.flip(run);
      assert.strictEqual(refused._tag === "SendRefused" && refused.outcome._tag, "knocked");

      yield* missions.upsertLane(OWNER, { missionId, name: "API", threadId: lane });
      const adopted = yield* Stream.fromSubscription(subscription).pipe(
        Stream.filter(
          (item) =>
            item._tag === "upsert" &&
            item.record._tag === "event" &&
            item.record.record.kind === "guard.adopted",
        ),
        Stream.runHead,
        Effect.map((item) => {
          const found = Option.getOrThrow(item);
          if (found._tag !== "upsert" || found.record._tag !== "event") throw new Error("no event");
          return found.record.record;
        }),
      );
      assert.deepStrictEqual(adopted.payload, {
        master,
        schedules: [{ id: taskId, threadId: lane, title: "Lane check-in" }],
        watches: [],
      });

      yield* run;
      assert.deepStrictEqual(yield* authority.read("scheduled-task", taskId), {
        _tag: "thread",
        threadId: master,
        title: master,
      });

      // Once: the same enrolment again finds nothing left to adopt.
      const created = (yield* store.eventsSince(missionId, 0, 500)).find(
        (event: MissionEvent) => event.kind === "lane.created",
      );
      assert.isNull(yield* adoptForEnrolment(store, created!));
      const events = yield* store.eventsSince(missionId, 0, 500);
      assert.strictEqual(events.filter((event) => event.kind === "guard.adopted").length, 1);
    }),
  ).pipe(Effect.provide(enrolAdoptionLayer.pipe(Layer.provideMerge(testLayer(ports.layer))))),
);
