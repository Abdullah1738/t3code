// @effect-diagnostics nodeBuiltinImport:off - command ids only need a random UUID.
import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  MessageId,
  MissionError,
  ScheduledTaskUpsertInput,
  type MissionId,
  type ModelSelection,
  type MissionProvenance,
  type Suggestion,
  type SuccessionMove,
  type ThreadId,
} from "@t3tools/contracts";
import { modelSelectionCommandType } from "@t3tools/shared/model";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as ThreadLaunchService from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../../../processRunner.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import { stateFromShell } from "../../control/model.ts";
import * as AsksService from "../asks/AsksService.ts";
import { optionalAuthorityStore } from "../guard/authority.ts";
import { CurrentPrincipal, type GuardPrincipal } from "../guard/principal.ts";
import { SuccessionRetarget } from "../guard/schedules.ts";
import { checkSend } from "../router/guardHook.ts";
import * as MissionRouter from "../router/MissionRouter.ts";
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

/** Whose move a succession is and which of the old thread's schedules are the role's. */
export interface SuccessionScope {
  /** Who decided the handoff; undefined for the policy's own components and imports. */
  readonly decider: GuardPrincipal | undefined;
  /** Set when the old thread serves something else too, so none of its schedules move. */
  readonly shared: string | null;
  /** The mission's current threads: a schedule one of them set may move with the role. */
  readonly members: ReadonlySet<ThreadId>;
}

/** Moves what a role holder owns to its successor thread. */
export class PolicySuccession extends Context.Service<
  PolicySuccession,
  {
    readonly move: (
      from: ThreadId,
      to: ThreadId,
      scope: SuccessionScope,
    ) => Effect.Effect<ReadonlyArray<SuccessionMove>>;
  }
>()("t3/ardud/missions/policy/ports/PolicySuccession") {}

/**
 * What a handoff needs beyond the binding: a fresh thread for the new lead, its
 * brief, and the old holder's room subscriptions. Optional, so a policy built
 * without it (the crw import) still works: handoffs then need an existing
 * thread and subscriptions stay put.
 */
export class PolicyHandoff extends Context.Service<
  PolicyHandoff,
  {
    /**
     * Launches an idle thread in the project and workspace `from` works in. A
     * second launch with the same `launchId` returns the thread the first made.
     */
    readonly launch: (input: {
      readonly from: ThreadId;
      readonly title: string;
      readonly modelSelection: ModelSelection;
      readonly launchId: string;
    }) => Effect.Effect<ThreadId, MissionError>;
    /** Queues `text` as a system message to the thread; it runs at the next idle turn. */
    readonly brief: (
      threadId: ThreadId,
      text: string,
      key: string,
    ) => Effect.Effect<void, MissionError>;
    /**
     * Gives `to` every room subscription held by `from` itself in the mission.
     * Role and lane subscriptions already follow the holder. Run it after the
     * succession commits, when `to` is a member; never fails.
     */
    readonly moveSubscriptions: (
      missionId: MissionId,
      from: ThreadId,
      to: ThreadId,
    ) => Effect.Effect<SuccessionMove>;
  }
>()("t3/ardud/missions/policy/ports/PolicyHandoff") {}

/**
 * Where governor suggestions go: the asks track's suggestion inbox. Proposing
 * never fails the caller; a refused duplicate is just logged.
 */
export class PolicySuggestions extends Context.Service<
  PolicySuggestions,
  { readonly propose: (suggestion: Suggestion) => Effect.Effect<void> }
>()("t3/ardud/missions/policy/ports/PolicySuggestions") {}

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

/**
 * Why the decider may not move schedules between the two threads, or null.
 * Checked without side effects first, so a refused move posts no knock and
 * leaves every schedule where it was.
 */
const deciderRefusal = (decider: GuardPrincipal | undefined, threads: ReadonlyArray<ThreadId>) =>
  Effect.gen(function* () {
    if (decider === undefined || decider._tag === "owner") return null;
    for (const targetThreadId of threads) {
      const decision = yield* checkSend({ path: "schedule-edit", targetThreadId, from: decider });
      if (decision._tag !== "allow" && decision._tag !== "not-member") {
        return `Schedules on the old thread stay there: whoever handed the role over may not edit schedules on ${targetThreadId}.`;
      }
    }
    return null;
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(`Schedules on the old thread stay there: ${error.detail}`),
    ),
  );

const makeSuccession = Effect.gen(function* () {
  const schedules = yield* ScheduledTaskService.ScheduledTaskService;
  const authority = yield* optionalAuthorityStore;

  const moveSchedules = (from: ThreadId, to: ThreadId, scope: SuccessionScope) =>
    Effect.gen(function* () {
      const { tasks } = yield* schedules.list();
      const bound = tasks.filter((task) => task.threadId === from);
      const none = { what: "schedules", moved: 0, failed: 0, supported: true } as const;
      if (bound.length === 0) return none satisfies SuccessionMove;
      if (scope.shared !== null) {
        return { ...none, kept: bound.length, detail: scope.shared } satisfies SuccessionMove;
      }
      const refusal = yield* deciderRefusal(scope.decider, [from, to]);
      if (refusal !== null) {
        return { ...none, kept: bound.length, detail: refusal } satisfies SuccessionMove;
      }
      let moved = 0;
      let failed = 0;
      let kept = 0;
      for (const task of bound) {
        const recorded = yield* Effect.result(authority.lookup("scheduled-task", task.id));
        if (Result.isFailure(recorded)) {
          failed += 1;
          continue;
        }
        // Set by a thread outside the mission for its own reasons: not the role's.
        const setBy = recorded.success;
        if (
          setBy?._tag === "thread" &&
          setBy.threadId !== from &&
          !scope.members.has(setBy.threadId)
        ) {
          kept += 1;
          continue;
        }
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
          // Saved as the decider, so the guard checks both threads for them; the
          // retarget keeps the decider from becoming who the schedule speaks as.
          Effect.flatMap((input) =>
            schedules
              .upsert(input)
              .pipe(
                Effect.provideService(CurrentPrincipal, scope.decider),
                Effect.provideService(SuccessionRetarget, { from, to }),
              ),
          ),
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
      return {
        what: "schedules",
        moved,
        failed,
        supported: true,
        ...(kept === 0
          ? {}
          : {
              kept,
              detail: `${kept} schedule(s) set by threads outside this mission stay on ${from}.`,
            }),
      } satisfies SuccessionMove;
    }).pipe(
      Effect.catch(() =>
        Effect.succeed<SuccessionMove>({ what: "schedules", moved: 0, failed: 1, supported: true }),
      ),
    );

  const move = (from: ThreadId, to: ThreadId, scope: SuccessionScope) =>
    moveSchedules(from, to, scope).pipe(
      Effect.map((schedulesMove): ReadonlyArray<SuccessionMove> => [
        schedulesMove,
        // Subscriptions move after the succession commits (PolicyHandoff). Children
        // have no reparent command; recovery tells the new holder about them.
        { what: "children", moved: 0, failed: 0, supported: false },
      ]),
    );

  return PolicySuccession.of({ move });
});

export const successionLayer = Layer.effect(PolicySuccession, makeSuccession);

const HANDOFF: MissionProvenance = { _tag: "system", component: "mission-policy" };

const threadFailure = (what: string) => (error: unknown) =>
  unavailable(`${what}: ${error instanceof Error ? error.message : String(error)}`);

/**
 * Copies `from`'s own room subscriptions in the mission to `to`, same mode and
 * wake kinds, then mutes the old entry. The mute only lands while `from` is
 * still a member (explicit member row or lineage); otherwise the router already
 * skips it, since it only delivers to members.
 */
export const subscriptionMover =
  (router: MissionRouter.MissionRouter["Service"]) =>
  (missionId: MissionId, from: ThreadId, to: ThreadId): Effect.Effect<SuccessionMove> =>
    Effect.gen(function* () {
      let moved = 0;
      let failed = 0;
      for (const room of yield* router.rooms(missionId, HANDOFF)) {
        const tuning = yield* Effect.result(router.roomTuning({ roomId: room.id }, HANDOFF));
        if (Result.isFailure(tuning)) {
          failed += 1;
          continue;
        }
        for (const subscription of tuning.success.subscriptions) {
          const subscriber = subscription.subscriber;
          if (subscriber._tag !== "thread" || subscriber.threadId !== from) continue;
          const copied = yield* Effect.result(
            router.subscribe(
              {
                roomId: room.id,
                subscriber: { _tag: "thread", threadId: to },
                mode: subscription.mode,
                wakeOn: subscription.wakeOn,
              },
              HANDOFF,
            ),
          );
          if (Result.isFailure(copied)) {
            failed += 1;
            continue;
          }
          moved += 1;
          yield* router
            .subscribe({ roomId: room.id, subscriber, mode: "mute", wakeOn: [] }, HANDOFF)
            .pipe(Effect.ignore);
        }
      }
      return { what: "subscriptions", moved, failed, supported: true } satisfies SuccessionMove;
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("mission policy could not move room subscriptions", {
          missionId,
          from,
          to,
          detail: error.detail,
        }).pipe(
          Effect.as({
            what: "subscriptions",
            moved: 0,
            failed: 1,
            supported: true,
          } satisfies SuccessionMove),
        ),
      ),
    );

const makeHandoff = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const launcher = yield* ThreadLaunchService.ThreadLaunchService;
  const router = yield* MissionRouter.MissionRouter;

  const shellOf = (threadId: ThreadId) =>
    threads.getThreadShell(threadId).pipe(
      Effect.mapError(threadFailure(`Cannot read thread ${threadId}`)),
      Effect.flatMap((shell) =>
        shell === null || shell.deletedAt !== null
          ? Effect.fail(new MissionError({ code: "not-found", detail: `No thread ${threadId}.` }))
          : Effect.succeed(shell),
      ),
    );

  return PolicyHandoff.of({
    launch: (input) =>
      Effect.gen(function* () {
        const shell = yield* shellOf(input.from);
        const launched = yield* launcher
          .launch({
            commandId: CommandId.make(`mission-policy:handoff:${input.launchId}`),
            projectId: shell.projectId,
            title: input.title,
            modelSelection: input.modelSelection,
            runtimeMode: shell.runtimeMode,
            interactionMode: shell.interactionMode,
            workspaceStrategy:
              shell.worktreePath === null
                ? { type: "root" }
                : {
                    type: "existing_worktree",
                    worktreePath: shell.worktreePath,
                    branch: shell.branch ?? undefined,
                  },
            createdBy: "system",
            creationSource: "server",
          })
          .pipe(Effect.mapError(threadFailure("Cannot launch the new lead thread")));
        return launched.threadId;
      }),
    brief: (threadId, text, key) =>
      Effect.gen(function* () {
        const shell = yield* shellOf(threadId);
        const id = `mission-policy:${key}`;
        yield* threads
          .sendToThread({
            projectId: shell.projectId,
            commandId: CommandId.make(id),
            messageId: MessageId.make(id),
            threadId,
            text,
            attachments: [],
            mode: "queue",
            createdBy: "system",
            creationSource: "server",
          })
          .pipe(Effect.mapError(threadFailure("Cannot brief the new lead thread")));
      }),
    moveSubscriptions: subscriptionMover(router),
  });
});

/** Needs the router; `PolicyLive` gives it the same router the rest of missions uses. */
export const handoffLayer = Layer.effect(PolicyHandoff, makeHandoff);

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

const GOVERNOR: MissionProvenance = { _tag: "system", component: "governor" };

/** Governor suggestions through `AsksService.proposeSuggestion`, authored by the governor. */
export const suggestionsLayer = Layer.effect(
  PolicySuggestions,
  Effect.gen(function* () {
    const asks = yield* AsksService.AsksService;
    return PolicySuggestions.of({
      propose: (suggestion) =>
        asks
          .proposeSuggestion(
            {
              missionId: suggestion.missionId,
              targetKind: suggestion.targetKind,
              target: suggestion.target,
              title: suggestion.title,
              before: suggestion.before,
              after: suggestion.after,
              diffText: suggestion.diffText,
              why: suggestion.why,
              evidence: suggestion.evidence,
              acceptor: suggestion.acceptor,
            },
            GOVERNOR,
          )
          .pipe(
            Effect.asVoid,
            Effect.catch((error) =>
              Effect.logDebug("mission governor suggestion not filed", {
                title: suggestion.title,
                detail: error.detail,
              }),
            ),
          ),
    });
  }),
);

export const portsLayer = Layer.mergeAll(threadsLayer, successionLayer, samplerLayer);
