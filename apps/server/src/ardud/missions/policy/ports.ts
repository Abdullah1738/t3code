// @effect-diagnostics nodeBuiltinImport:off - command ids only need a random UUID.
import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  MissionError,
  ScheduledTaskUpsertInput,
  type ModelSelection,
  type SuccessionMove,
  type ThreadId,
} from "@t3tools/contracts";
import { modelSelectionCommandType } from "@t3tools/shared/model";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../../../processRunner.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import { stateFromShell } from "../../control/model.ts";
import type { HolderThread } from "./roles.ts";
import {
  crwBudgetWindow,
  crwReviewsQuery,
  parseCoordClaims,
  parseCrwReviews,
  parseOffboxSpend,
  parseQuota,
  type PoolSource,
  type UsageSample,
} from "./sources.ts";

/**
 * The threads that hold roles. Policy reads whether a holder is idle and sets
 * its model only then, so a change lands at the thread's next turn.
 */
export class PolicyThreads extends Context.Service<
  PolicyThreads,
  {
    readonly view: (threadId: ThreadId) => Effect.Effect<HolderThread>;
    /** Same path as `t3_thread_configure`. Call it only for an idle thread. */
    readonly setModel: (
      threadId: ThreadId,
      selection: ModelSelection,
    ) => Effect.Effect<void, MissionError>;
  }
>()("t3/ardud/missions/policy/ports/PolicyThreads") {}

/** Moves what a role holder owns to its successor thread. */
export class PolicySuccession extends Context.Service<
  PolicySuccession,
  {
    readonly move: (from: ThreadId, to: ThreadId) => Effect.Effect<ReadonlyArray<SuccessionMove>>;
  }
>()("t3/ardud/missions/policy/ports/PolicySuccession") {}

/** Reads an observed pool's usage from its outside system. Read-only by construction. */
export class PolicySampler extends Context.Service<
  PolicySampler,
  {
    readonly sample: (
      source: PoolSource,
      nowMs: number,
    ) => Effect.Effect<UsageSample, MissionError>;
  }
>()("t3/ardud/missions/policy/ports/PolicySampler") {}

const isMissionError = Schema.is(MissionError);

const unavailable = (detail: string) => new MissionError({ code: "conflict", detail });

const missingThread = (threadId: ThreadId): HolderThread => ({
  threadId,
  exists: false,
  idle: false,
  modelSelection: null,
});

const makeThreads = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;

  const view = (threadId: ThreadId): Effect.Effect<HolderThread> =>
    threads.getThreadShell(threadId).pipe(
      Effect.map((shell): HolderThread => {
        if (shell === null || shell.deletedAt !== null) return missingThread(threadId);
        return {
          threadId,
          exists: true,
          idle: stateFromShell(shell) === "idle",
          modelSelection: shell.modelSelection,
        };
      }),
      // An unreadable thread is treated as busy, so nothing switches under it.
      Effect.catch(() =>
        Effect.succeed<HolderThread>({ threadId, exists: true, idle: false, modelSelection: null }),
      ),
    );

  const setModel = (threadId: ThreadId, selection: ModelSelection) =>
    Effect.gen(function* () {
      const shell = yield* threads.getThreadShell(threadId);
      if (shell === null || shell.deletedAt !== null) {
        return yield* new MissionError({ code: "not-found", detail: `thread ${threadId} is gone` });
      }
      yield* threads.dispatch({
        type: modelSelectionCommandType(shell.providerInstanceId, selection),
        threadId,
        commandId: CommandId.make(`mission-policy:${NodeCrypto.randomUUID()}`),
        modelSelection: selection,
      });
    }).pipe(
      Effect.catch((error) =>
        isMissionError(error)
          ? Effect.fail(error)
          : Effect.fail(unavailable(`could not set the model on ${threadId}: ${error.message}`)),
      ),
    );

  return PolicyThreads.of({ view, setModel });
});

export const threadsLayer = Layer.effect(PolicyThreads, makeThreads);

const decodeScheduleUpsert = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);

const makeSuccession = Effect.gen(function* () {
  const schedules = yield* ScheduledTaskService.ScheduledTaskService;

  const moveSchedules = (from: ThreadId, to: ThreadId) =>
    Effect.gen(function* () {
      const { tasks } = yield* schedules.list();
      let moved = 0;
      let failed = 0;
      for (const task of tasks) {
        if (task.threadId !== from) continue;
        const saved = yield* decodeScheduleUpsert({
          id: task.id,
          requireExisting: true,
          title: task.title,
          prompt: task.prompt,
          enabled: task.enabled,
          schedule: task.schedule,
          projectId: task.projectId,
          threadId: to,
          workspaceStrategy: task.workspaceStrategy,
          modelSelection: task.modelSelection,
          runtimeMode: task.runtimeMode,
          interactionMode: task.interactionMode,
        }).pipe(
          Effect.flatMap((input) => schedules.upsert(input)),
          Effect.as(true),
          Effect.catch((error) =>
            Effect.logWarning("mission policy could not move a schedule", {
              taskId: task.id,
              error: String(error),
            }).pipe(Effect.as(false)),
          ),
        );
        if (saved) moved += 1;
        else failed += 1;
      }
      return { what: "schedules", moved, failed, supported: true } satisfies SuccessionMove;
    }).pipe(
      Effect.catch(() =>
        Effect.succeed<SuccessionMove>({ what: "schedules", moved: 0, failed: 1, supported: true }),
      ),
    );

  const move = (from: ThreadId, to: ThreadId) =>
    moveSchedules(from, to).pipe(
      Effect.map((schedulesMove): ReadonlyArray<SuccessionMove> => [
        schedulesMove,
        // Room subscriptions live with the router track; children have no reparent command.
        { what: "subscriptions", moved: 0, failed: 0, supported: false },
        { what: "children", moved: 0, failed: 0, supported: false },
      ]),
    );

  return PolicySuccession.of({ move });
});

export const successionLayer = Layer.effect(PolicySuccession, makeSuccession);

const SAMPLE_TIMEOUT = Duration.seconds(60);
const SAMPLE_MAX_OUTPUT = 4 * 1024 * 1024;

const makeSampler = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;

  const run = (command: string, args: ReadonlyArray<string>, cwd?: string) =>
    runner
      .run({
        command,
        args,
        cwd,
        timeout: SAMPLE_TIMEOUT,
        maxOutputBytes: SAMPLE_MAX_OUTPUT,
      })
      .pipe(
        Effect.mapError((error) => unavailable(`${command} failed: ${error.message}`)),
        Effect.flatMap((output) =>
          output.code === 0
            ? Effect.succeed(output.stdout)
            : Effect.fail(
                unavailable(
                  `${command} exited ${String(output.code)}: ${output.stderr.trim().slice(0, 200)}`,
                ),
              ),
        ),
      );

  const parse = <A>(f: () => A) =>
    Effect.try({
      try: f,
      catch: (error) =>
        isMissionError(error)
          ? error
          : new MissionError({ code: "invalid", detail: String(error) }),
    });

  const sample = (source: PoolSource, nowMs: number): Effect.Effect<UsageSample, MissionError> => {
    switch (source._tag) {
      case "coord-claims":
        return Effect.gen(function* () {
          const active = yield* run(source.command, ["claims", "--state", "active"]);
          const stuck = yield* run(source.command, ["claims", "--state", "reconcile_required"]);
          const first = yield* parse(() => parseCoordClaims(active, source));
          const second = yield* parse(() => parseCoordClaims(stuck, source));
          return { ...first, used: first.used + second.used };
        });
      case "crw-reviews":
        return Effect.gen(function* () {
          const config = yield* fs
            .readFileString(source.configPath)
            .pipe(Effect.mapError(() => unavailable(`cannot read ${source.configPath}`)));
          const window = yield* parse(() => crwBudgetWindow(config, nowMs));
          const rows = yield* run("sqlite3", [
            "-readonly",
            "-json",
            source.dbPath,
            crwReviewsQuery(window.since),
          ]);
          return yield* parse(() => parseCrwReviews(rows, window));
        });
      case "quota":
        return run("python3", [source.script], process.env.HOME).pipe(
          Effect.flatMap((stdout) => parse(() => parseQuota(stdout, source))),
        );
      case "offbox-spend":
        return run(source.command, ["spend", "--json"]).pipe(
          Effect.flatMap((stdout) => parse(() => parseOffboxSpend(stdout))),
        );
    }
  };

  return PolicySampler.of({ sample });
});

export const samplerLayer = Layer.effect(PolicySampler, makeSampler).pipe(
  Layer.provide(ProcessRunner.layer),
);

export const portsLayer = Layer.mergeAll(threadsLayer, successionLayer, samplerLayer);
