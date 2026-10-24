import { assert, it } from "@effect/vitest";
import { MissionError, RoleId, type Lane, type RecoveryIncident } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import {
  agent,
  binding,
  lane,
  laneThread,
  masterThread,
  missionId,
  role,
} from "../asks/AsksService.testkit.ts";
import * as MissionService from "../MissionService.ts";
import * as Model from "./model.ts";
import * as RecoveryService from "./RecoveryService.ts";
import {
  T0,
  boot,
  childRow,
  harness,
  itemRow,
  plus,
  previousBoot,
  runRow,
  test,
  threadRow,
  webLane,
  webThread,
  world,
} from "./testkit.ts";

// The server came up at 09:00 after a short restart; limits hit later.
const UP = 3600;
const LIMIT_MESSAGE =
  '[claude/claude-opus-5-5] [429]: {"type":"rate_limit_error"} (reset after 10m 43s)';

const limitWorld = (lanes: ReadonlyArray<Lane>, extra?: Parameters<typeof world>[0]) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(T0 + UP * 1000);
    yield* world({ ...extra, lanes });
    yield* previousBoot(plus(UP - 60));
    assert.isNull(yield* boot);
  });

/**
 * A run that failed on the usage limit at `at` seconds, then (as OpenCode
 * does) a one-second run that only delivered a background notification.
 */
const limitFailure = (
  threadId: string,
  ordinal: number,
  at: number,
  options: {
    readonly message?: string;
    readonly resetAt?: string;
    readonly tail?: boolean;
    /** Seconds the run ran before failing; a minute by default. */
    readonly ran?: number;
    /** A command still in flight when it failed, instead of a finished test run. */
    readonly running?: string;
  } = {},
) =>
  Effect.gen(function* () {
    const runId = `${threadId}-run-${ordinal}`;
    yield* runRow({
      threadId,
      ordinal,
      status: "failed",
      completedAt: plus(at),
      startedAt: plus(at - (options.ran ?? 60)),
    });
    yield* itemRow(
      runId,
      threadId,
      1,
      "command_execution",
      options.running === undefined ? "completed" : "running",
      { input: options.running ?? "offbox run -- vp test run src/a.test.ts" },
    );
    yield* itemRow(runId, threadId, 2, "error", "failed", {
      failure: {
        class: "usage_limit",
        code: "provider.rate-limit",
        message: options.message ?? LIMIT_MESSAGE,
        retryable: null,
        ...(options.resetAt === undefined ? {} : { resetAt: options.resetAt }),
      },
    });
    if (options.tail !== false) {
      const tail = `${threadId}-run-${ordinal + 1}`;
      yield* runRow({
        threadId,
        ordinal: ordinal + 1,
        status: "completed",
        completedAt: plus(at + 1),
        startedAt: plus(at),
      });
      yield* itemRow(tail, threadId, 1, "notification", "completed", { source: "background_task" });
      yield* itemRow(tail, threadId, 2, "checkpoint", "completed", {});
    }
  });

/** A completed run that did real work. */
const workRun = (threadId: string, ordinal: number, at: number) =>
  Effect.gen(function* () {
    yield* runRow({
      threadId,
      ordinal,
      status: "completed",
      completedAt: plus(at),
      startedAt: plus(at - 10),
    });
    yield* itemRow(`${threadId}-run-${ordinal}`, threadId, 1, "assistant_message", "completed", {
      text: "Carried on.",
    });
  });

const view = (incident: RecoveryIncident | null) => {
  assert.isNotNull(incident);
  return (incident?.threads ?? []).map((thread) => ({
    threadId: thread.threadId,
    action: thread.action,
    state: thread.state,
    usageLimit: thread.usageLimit ?? null,
    notBefore: thread.notBefore ?? null,
  }));
};

const at = (seconds: number) => TestClock.setTime(T0 + seconds * 1000);

it.effect("Model: a usage limit resumes after its reset plus a margin", () =>
  Effect.sync(() => {
    const run = {
      runId: "r",
      threadId: laneThread,
      ordinal: 1,
      status: "failed",
      completedAt: "2026-10-23T15:18:00.000Z",
      interruptMessage: null,
      continued: true,
      workedAfter: false,
      items: [],
    };
    const failure = {
      class: "usage_limit",
      code: "provider.rate-limit",
      message: LIMIT_MESSAGE,
      resetAt: null,
    };
    assert.strictEqual(Model.limitResetOf({ ...run, failure }), "2026-10-23T15:29:43.000Z");
    assert.strictEqual(
      Model.limitResetOf({ ...run, failure: { ...failure, message: "(reset after 1h 2m)" } }),
      "2026-10-23T16:21:00.000Z",
    );
    assert.strictEqual(
      Model.limitResetOf({ ...run, failure: { ...failure, resetAt: "2026-10-23T15:40:00.000Z" } }),
      "2026-10-23T15:41:00.000Z",
    );
    // No reset named: a default wait.
    assert.strictEqual(
      Model.limitResetOf({ ...run, failure: { ...failure, message: "429 Too Many Requests" } }),
      "2026-10-23T15:34:00.000Z",
    );
    // Only the rate-limit code is enough.
    assert.isNotNull(
      Model.limitResetOf({ ...run, failure: { ...failure, class: "provider_error" } }),
    );
    // Other failures are not limits.
    assert.isNull(
      Model.limitResetOf({
        ...run,
        failure: { ...failure, class: "provider_error", code: "provider.internal" },
      }),
    );
    assert.isNull(Model.limitResetOf({ ...run, status: "cancelled", failure }));
  }),
);

it.effect(
  "a lane that failed on the usage limit is resumed once the limit resets, not before",
  () => {
    const { fake, layer } = harness();
    return Effect.gen(function* () {
      yield* limitWorld([lane]);
      const recovery = yield* RecoveryService.RecoveryService;
      // Fails at 09:10:00; the notification run right after doesn't count as carrying on.
      yield* limitFailure(laneThread, 1, UP + 600);
      yield* childRow({
        id: "sub-done",
        threadId: laneThread,
        runId: `${laneThread}-run-1`,
        status: "completed",
        title: "Harness sweep",
        completedAt: plus(UP + 590),
        session: "ses_done",
      });
      yield* at(UP + 600 + 301);
      const incident = yield* recovery.scan;
      assert.deepStrictEqual(view(incident), [
        {
          threadId: laneThread,
          action: "resume",
          state: "pending",
          usageLimit: "first",
          notBefore: plus(UP + 600 + 643 + 60),
        },
      ]);
      assert.strictEqual(
        incident?.threads[0]?.stateReason,
        "waiting for the usage limit to reset at 09:21",
      );

      // Still limited at 09:20: nothing goes out.
      yield* at(UP + 1200);
      assert.strictEqual(yield* recovery.tick, 0);
      assert.deepStrictEqual(fake.sent, []);

      yield* at(UP + 600 + 643 + 60);
      assert.strictEqual(yield* recovery.tick, 1);
      assert.strictEqual(
        fake.sent[0]?.text,
        `[mission recovery] Your run failed at 09:10 on a provider usage limit (${LIMIT_MESSAGE}); it should have reset by now. Your turn was cut while you were running \`offbox run -- vp test run src/a.test.ts\`. You had no background children. Background children that finished while you were stopped already have their results: read them (task_status, or the subagent's last message) instead of running them again. Then continue your work.`,
      );
      assert.isUndefined(fake.sent[0]?.kind);
      assert.isNull(yield* recovery.scan);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("a lane that carried on before the reset is not resumed", () => {
  const { fake, layer } = harness();
  return Effect.gen(function* () {
    yield* limitWorld([lane]);
    const recovery = yield* RecoveryService.RecoveryService;
    yield* limitFailure(laneThread, 1, UP + 600);
    yield* at(UP + 901);
    const incident = yield* recovery.scan;
    assert.strictEqual(incident?.threads[0]?.state, "pending");
    // The owner nudged it and it worked again before the limit wait ran out.
    yield* workRun(laneThread, 3, UP + 1000);
    yield* at(UP + 600 + 703);
    assert.strictEqual(yield* recovery.tick, 0);
    const [after] = yield* recovery.incidents(missionId);
    assert.deepStrictEqual(
      after?.threads.map((thread) => [thread.state, thread.stateReason]),
      [["skipped", "carried on before the limit reset"]],
    );
    assert.deepStrictEqual(fake.sent, []);
  }).pipe(Effect.provide(layer));
});

it.effect("a limit failure the scan finds after the lane already carried on is skipped", () => {
  const { layer } = harness();
  return Effect.gen(function* () {
    yield* limitWorld([lane]);
    const recovery = yield* RecoveryService.RecoveryService;
    yield* limitFailure(laneThread, 1, UP + 600);
    yield* workRun(laneThread, 3, UP + 650);
    yield* at(UP + 901);
    assert.isNull(yield* recovery.scan);
  }).pipe(Effect.provide(layer));
});

it.effect("several limited lanes: the master's summary waits for the reset too", () => {
  const { fake, layer } = harness();
  return Effect.gen(function* () {
    yield* limitWorld([lane, webLane]);
    const recovery = yield* RecoveryService.RecoveryService;
    yield* limitFailure(laneThread, 1, UP + 600);
    yield* limitFailure(webThread, 1, UP + 610);
    yield* at(UP + 911);
    const incident = yield* recovery.scan;
    const reset = plus(UP + 600 + 703);
    assert.deepStrictEqual(view(incident), [
      {
        threadId: masterThread,
        action: "notice-only",
        state: "pending",
        usageLimit: null,
        notBefore: reset,
      },
      {
        threadId: laneThread,
        action: "resume",
        state: "pending",
        usageLimit: "first",
        notBefore: reset,
      },
      {
        threadId: webThread,
        action: "resume",
        state: "pending",
        usageLimit: "first",
        notBefore: plus(UP + 610 + 703),
      },
    ]);
    yield* at(UP + 1200);
    assert.strictEqual(yield* recovery.tick, 0);
    yield* at(UP + 600 + 703);
    assert.strictEqual(yield* recovery.tick, 1);
    assert.deepStrictEqual(
      fake.sent.map((sent) => sent.threadId),
      [masterThread],
    );
    assert.include(fake.sent[0]?.text ?? "", "failed on a usage limit");
    // Lanes follow the master's lead, each once its own reset passed.
    yield* TestClock.adjust("61 seconds");
    assert.strictEqual(yield* recovery.tick, 2);
    assert.deepStrictEqual(
      fake.sent.map((sent) => sent.threadId),
      [masterThread, laneThread, webThread],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("a second limit failure before the reset keeps one notice, only later", () => {
  const { fake, layer } = harness();
  return Effect.gen(function* () {
    yield* limitWorld([lane]);
    const recovery = yield* RecoveryService.RecoveryService;
    yield* limitFailure(laneThread, 1, UP + 600);
    yield* at(UP + 901);
    const first = yield* recovery.scan;
    assert.isNotNull(first);
    // The owner pokes it at 09:15; it fails on the limit again with a later reset.
    yield* limitFailure(laneThread, 3, UP + 900, { message: "(reset after 20m)" });
    yield* at(UP + 1201);
    assert.isNull(yield* recovery.scan);
    const [after] = yield* recovery.incidents(missionId);
    assert.strictEqual(after?.id, first?.id);
    assert.deepStrictEqual(view(after ?? null), [
      {
        threadId: laneThread,
        action: "resume",
        state: "pending",
        usageLimit: "first",
        notBefore: plus(UP + 900 + 1200 + 60),
      },
    ]);
    assert.strictEqual(after?.threads[0]?.cutRunId, `${laneThread}-run-3`);
    yield* at(UP + 600 + 703);
    assert.strictEqual(yield* recovery.tick, 0);
    yield* at(UP + 900 + 1260);
    assert.strictEqual(yield* recovery.tick, 1);
    assert.include(fake.sent[0]?.text ?? "", "failed at 09:15 on a provider usage limit");
  }).pipe(Effect.provide(layer));
});

it.effect(
  "failing on the limit again right after its resume goes to the master as a blocker",
  () => {
    const { fake, layer } = harness();
    return Effect.gen(function* () {
      yield* limitWorld([lane]);
      const recovery = yield* RecoveryService.RecoveryService;
      yield* limitFailure(laneThread, 1, UP + 600);
      yield* at(UP + 901);
      yield* recovery.scan;
      yield* at(UP + 600 + 703);
      assert.strictEqual(yield* recovery.tick, 1);

      // The resumed turn fails on the limit again two minutes later.
      yield* limitFailure(laneThread, 3, UP + 600 + 703 + 120);
      yield* at(UP + 600 + 703 + 120 + 301);
      const again = yield* recovery.scan;
      assert.deepStrictEqual(view(again), [
        {
          threadId: masterThread,
          action: "notice-only",
          state: "pending",
          usageLimit: null,
          notBefore: null,
        },
        {
          threadId: laneThread,
          action: "resume",
          state: "held",
          usageLimit: "again",
          notBefore: plus(UP + 600 + 703 + 120 + 703),
        },
      ]);
      assert.strictEqual(again?.threads[1]?.stateReason, Model.LIMIT_AGAIN_REASON);
      // A lane held this way is the master's call, not an owner FYI.
      const missions = yield* MissionService.MissionService;
      assert.deepStrictEqual((yield* missions.inbox(missionId)).fyi, []);

      assert.strictEqual(yield* recovery.tick, 1);
      const blocker = fake.sent.at(-1);
      assert.strictEqual(blocker?.threadId, masterThread);
      assert.strictEqual(blocker?.kind, "blocker");
      assert.include(
        blocker?.text ?? "",
        'Blocked, failed on a provider usage limit again right after recovery resumed them once: lane "API"',
      );
      assert.notInclude(blocker?.text ?? "", "Resume plan, in order");
      // Never resumed again on its own.
      yield* TestClock.adjust("30 minutes");
      assert.strictEqual(yield* recovery.tick, 0);
      assert.deepStrictEqual(
        fake.sent.map((sent) => sent.threadId),
        [laneThread, masterThread],
      );

      // The master resumes it by hand.
      yield* recovery.resume(agent(masterThread), {
        missionId,
        mode: "now",
        threadId: laneThread,
      });
      assert.deepStrictEqual(
        fake.sent.map((sent) => sent.threadId),
        [laneThread, masterThread, laneThread],
      );
    }).pipe(Effect.provide(layer));
  },
);

it.effect("a limit failure after real work since the resume is a fresh one", () => {
  const { fake, layer } = harness();
  return Effect.gen(function* () {
    yield* limitWorld([lane]);
    const recovery = yield* RecoveryService.RecoveryService;
    yield* limitFailure(laneThread, 1, UP + 600);
    yield* at(UP + 901);
    yield* recovery.scan;
    yield* at(UP + 1303);
    assert.strictEqual(yield* recovery.tick, 1);
    // It worked for a while, then hit the limit again.
    yield* workRun(laneThread, 3, UP + 1400);
    yield* limitFailure(laneThread, 4, UP + 1500);
    yield* at(UP + 1801);
    const next = yield* recovery.scan;
    assert.deepStrictEqual(
      view(next).map((thread) => [thread.threadId, thread.state, thread.usageLimit]),
      [[laneThread, "pending", "first"]],
    );
    yield* at(UP + 1500 + 703);
    assert.strictEqual(yield* recovery.tick, 1);
    assert.deepStrictEqual(
      fake.sent.map((sent) => sent.threadId),
      [laneThread, laneThread],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("a limited lane interrupted three times in an hour still gets its resume", () => {
  const { fake, layer } = harness();
  return Effect.gen(function* () {
    yield* limitWorld([lane]);
    const recovery = yield* RecoveryService.RecoveryService;
    for (const [ordinal, seconds] of [
      [1, UP + 300],
      [2, UP + 400],
    ] as const) {
      yield* runRow({
        threadId: laneThread,
        ordinal,
        status: "cancelled",
        completedAt: plus(seconds),
      });
      yield* itemRow(
        `${laneThread}-run-${ordinal}`,
        laneThread,
        1,
        "run_interrupt_request",
        "completed",
        {
          message: "Interrupt requested",
        },
      );
    }
    yield* at(UP + 500);
    yield* recovery.scan;
    yield* limitFailure(laneThread, 3, UP + 600);
    yield* at(UP + 901);
    const incident = yield* recovery.scan;
    assert.deepStrictEqual(
      view(incident).map((thread) => [thread.threadId, thread.action, thread.usageLimit]),
      [[laneThread, "resume", "first"]],
    );
    yield* at(UP + 1303);
    assert.strictEqual(yield* recovery.tick, 1);
    assert.deepStrictEqual(
      fake.sent.map((sent) => sent.threadId),
      [laneThread],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("a sub-coordinator that fails on the limit is resumed after the reset", () => {
  const { fake, layer } = harness();
  const subThread = "t-sub" as typeof masterThread;
  return Effect.gen(function* () {
    yield* limitWorld([lane], {
      extra: [
        { _tag: "role", record: role("role-sub", "sub-coordinator") },
        { _tag: "role-binding", record: binding("b-sub", "role-sub", subThread) },
      ],
    });
    yield* threadRow(subThread, "Sub coordinator");
    const recovery = yield* RecoveryService.RecoveryService;
    yield* limitFailure(subThread, 1, UP + 600);
    yield* at(UP + 901);
    const incident = yield* recovery.scan;
    assert.deepStrictEqual(view(incident), [
      {
        threadId: subThread,
        action: "resume",
        state: "pending",
        usageLimit: "first",
        notBefore: plus(UP + 1303),
      },
    ]);
    assert.strictEqual(incident?.threads[0]?.roleId, RoleId.make("role-sub"));
    yield* at(UP + 1303);
    assert.strictEqual(yield* recovery.tick, 1);
    assert.deepStrictEqual(
      fake.sent.map((sent) => sent.threadId),
      [subThread],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("the master failing on the limit again is held and the owner told", () => {
  const { fake, layer } = harness();
  return Effect.gen(function* () {
    yield* limitWorld([lane]);
    const recovery = yield* RecoveryService.RecoveryService;
    yield* limitFailure(masterThread, 1, UP + 600);
    yield* at(UP + 901);
    const first = yield* recovery.scan;
    assert.deepStrictEqual(
      view(first).map((thread) => [thread.threadId, thread.state, thread.usageLimit]),
      [[masterThread, "pending", "first"]],
    );
    yield* at(UP + 1303);
    assert.strictEqual(yield* recovery.tick, 1);
    assert.include(fake.sent[0]?.text ?? "", "on a provider usage limit");

    yield* limitFailure(masterThread, 3, UP + 1400);
    yield* at(UP + 1701);
    const again = yield* recovery.scan;
    assert.deepStrictEqual(
      view(again).map((thread) => [thread.threadId, thread.state, thread.usageLimit]),
      [[masterThread, "held", "again"]],
    );
    const missions = yield* MissionService.MissionService;
    const fyi = (yield* missions.inbox(missionId)).fyi;
    assert.strictEqual(fyi.length, 1);
    assert.include(fyi[0]?.summary ?? "", "Failed on a usage limit again after one resume");
    yield* TestClock.adjust("1 hour");
    assert.strictEqual(yield* recovery.tick, 0);
    assert.strictEqual(fake.sent.length, 1);
  }).pipe(Effect.provide(layer));
});

it.effect("a resume queued behind a long turn counts from when it ran, not when it went", () => {
  const { fake, layer } = harness();
  return Effect.gen(function* () {
    yield* limitWorld([lane]);
    const recovery = yield* RecoveryService.RecoveryService;
    yield* limitFailure(laneThread, 1, UP + 600);
    yield* at(UP + 901);
    yield* recovery.scan;
    // Busy with a background notification turn: the resume queues behind it.
    fake.busy.add(laneThread);
    yield* at(UP + 1303);
    assert.strictEqual(yield* recovery.tick, 1);
    assert.isTrue(fake.sent[0]?.queue);
    // That turn did no work and ran half an hour; the resume then started and
    // failed on the limit a second later.
    yield* runRow({
      threadId: laneThread,
      ordinal: 3,
      status: "completed",
      completedAt: plus(UP + 1303 + 1800),
      startedAt: plus(UP + 1303),
    });
    yield* itemRow(`${laneThread}-run-3`, laneThread, 1, "notification", "completed", {
      source: "background_task",
    });
    fake.busy.delete(laneThread);
    yield* limitFailure(laneThread, 4, UP + 1303 + 1801, { ran: 1, tail: false });
    yield* at(UP + 1303 + 1801 + 301);
    const again = yield* recovery.scan;
    assert.deepStrictEqual(
      view(again).map((thread) => [thread.threadId, thread.state, thread.usageLimit]),
      [
        [masterThread, "pending", null],
        [laneThread, "held", "again"],
      ],
    );
    assert.strictEqual(yield* recovery.tick, 1);
    assert.strictEqual(fake.sent.at(-1)?.kind, "blocker");
  }).pipe(Effect.provide(layer));
});

it.effect("a newer limit failure the scan hasn't judged yet holds back the older notice", () => {
  const { fake, layer } = harness();
  return Effect.gen(function* () {
    yield* limitWorld([lane]);
    const recovery = yield* RecoveryService.RecoveryService;
    yield* limitFailure(laneThread, 1, UP + 600);
    yield* at(UP + 901);
    yield* recovery.scan;
    // Poked again, it fails on the limit at 09:20:50, still inside the scan's settle time.
    yield* limitFailure(laneThread, 3, UP + 1250, { message: "(reset after 20m)" });
    yield* at(UP + 1303);
    assert.strictEqual(yield* recovery.tick, 0);
    assert.deepStrictEqual(fake.sent, []);
    // The scan folds it into the waiting notice, which goes after the newer reset.
    yield* at(UP + 1551);
    assert.isNull(yield* recovery.scan);
    const [open] = yield* recovery.incidents(missionId);
    assert.deepStrictEqual(view(open ?? null), [
      {
        threadId: laneThread,
        action: "resume",
        state: "pending",
        usageLimit: "first",
        notBefore: plus(UP + 1250 + 1260),
      },
    ]);
    yield* at(UP + 2509);
    assert.strictEqual(yield* recovery.tick, 0);
    yield* at(UP + 2510);
    assert.strictEqual(yield* recovery.tick, 1);
    assert.include(fake.sent[0]?.text ?? "", "failed at 09:20 on a provider usage limit");
  }).pipe(Effect.provide(layer));
});

it.effect("an owner Stop while the notice waits for the reset ends it", () => {
  const { fake, layer } = harness();
  return Effect.gen(function* () {
    yield* limitWorld([lane]);
    const recovery = yield* RecoveryService.RecoveryService;
    yield* limitFailure(laneThread, 1, UP + 600);
    yield* at(UP + 901);
    yield* recovery.scan;
    // He runs it by hand at 09:16 and stops it.
    yield* runRow({
      threadId: laneThread,
      ordinal: 3,
      status: "cancelled",
      completedAt: plus(UP + 1000),
      startedAt: plus(UP + 960),
    });
    yield* itemRow(`${laneThread}-run-3`, laneThread, 1, "run_interrupt_request", "completed", {
      message: "Interrupt requested",
    });
    yield* at(UP + 1303);
    assert.strictEqual(yield* recovery.tick, 0);
    const [after] = yield* recovery.incidents(missionId);
    assert.deepStrictEqual(
      after?.threads.map((thread) => [thread.state, thread.stateReason]),
      [["skipped", "stopped by the owner"]],
    );
    yield* TestClock.adjust("1 hour");
    assert.strictEqual(yield* recovery.tick, 0);
    assert.deepStrictEqual(fake.sent, []);
  }).pipe(Effect.provide(layer));
});

it.effect("a newer cut inside a git push is replanned when it folds, keeping what was lost", () => {
  const { fake, layer } = harness();
  return Effect.gen(function* () {
    yield* limitWorld([lane]);
    const recovery = yield* RecoveryService.RecoveryService;
    yield* limitFailure(laneThread, 1, UP + 600);
    yield* childRow({
      id: "sub-first",
      threadId: laneThread,
      runId: `${laneThread}-run-1`,
      status: "cancelled",
      title: "Lint sweep",
      completedAt: plus(UP + 600),
      session: "ses_first",
    });
    yield* at(UP + 901);
    const first = yield* recovery.scan;
    assert.deepStrictEqual(
      first?.threads.map((thread) => thread.lostChildren.map((child) => child.title)),
      [["Lint sweep"]],
    );
    // Poked again, it fails on the limit mid `git push` with a child running.
    yield* limitFailure(laneThread, 3, UP + 1000, {
      message: "(reset after 20m)",
      running: "git push origin main",
      tail: false,
    });
    yield* childRow({
      id: "sub-second",
      threadId: laneThread,
      runId: `${laneThread}-run-3`,
      status: "cancelled",
      title: "Release notes",
      completedAt: plus(UP + 1000),
      session: "ses_second",
    });
    yield* at(UP + 1301);
    assert.isNull(yield* recovery.scan);
    const [open] = yield* recovery.incidents(missionId);
    assert.deepStrictEqual(
      open?.threads.map((thread) => ({
        threadId: thread.threadId,
        position: thread.position,
        action: thread.action,
        cutRunId: thread.cutRunId,
        lost: thread.lostChildren.map((child) => child.title),
      })),
      [
        { threadId: masterThread, position: 0, action: "notice-only", cutRunId: null, lost: [] },
        {
          threadId: laneThread,
          position: 1,
          action: "reconcile-first",
          cutRunId: `${laneThread}-run-3`,
          lost: ["Lint sweep", "Release notes"],
        },
      ],
    );
    assert.strictEqual(open?.threads[1]?.reason, "cut inside a git push (`git push origin main`)");
    // Not before the newer reset; then the master first, the lane after its lead.
    yield* at(UP + 2259);
    assert.strictEqual(yield* recovery.tick, 0);
    yield* at(UP + 2260);
    assert.strictEqual(yield* recovery.tick, 1);
    assert.strictEqual(fake.sent[0]?.threadId, masterThread);
    yield* TestClock.adjust("61 seconds");
    assert.strictEqual(yield* recovery.tick, 1);
    assert.include(fake.sent[1]?.text ?? "", "You were inside a git push");
    assert.include(fake.sent[1]?.text ?? "", "Release notes");
    assert.include(fake.sent[1]?.text ?? "", "Lint sweep");
  }).pipe(Effect.provide(layer));
});

it.effect("lanes folded onto later resets move the master's summary with them", () => {
  const { fake, layer } = harness();
  return Effect.gen(function* () {
    yield* limitWorld([lane, webLane]);
    const recovery = yield* RecoveryService.RecoveryService;
    yield* limitFailure(laneThread, 1, UP + 600);
    yield* limitFailure(webThread, 1, UP + 610);
    yield* at(UP + 911);
    const first = yield* recovery.scan;
    assert.strictEqual(first?.threads[0]?.notBefore, plus(UP + 1303));
    // Both fail again before 09:21 with a forty-minute reset.
    yield* limitFailure(laneThread, 3, UP + 700, { message: "(reset after 40m)" });
    yield* limitFailure(webThread, 3, UP + 710, { message: "(reset after 40m)" });
    yield* at(UP + 1011);
    assert.isNull(yield* recovery.scan);
    const [open] = yield* recovery.incidents(missionId);
    assert.deepStrictEqual(
      view(open ?? null).map((thread) => [thread.threadId, thread.notBefore]),
      [
        [masterThread, plus(UP + 700 + 2460)],
        [laneThread, plus(UP + 700 + 2460)],
        [webThread, plus(UP + 710 + 2460)],
      ],
    );
    yield* at(UP + 1303);
    assert.strictEqual(yield* recovery.tick, 0);
    yield* at(UP + 3160);
    assert.strictEqual(yield* recovery.tick, 1);
    assert.deepStrictEqual(
      fake.sent.map((sent) => sent.threadId),
      [masterThread],
    );
  }).pipe(Effect.provide(layer));
});

/** An owner Stop: a cancelled run he interrupted himself. */
const ownerStop = (threadId: string, ordinal: number, at: number) =>
  Effect.gen(function* () {
    yield* runRow({
      threadId,
      ordinal,
      status: "cancelled",
      completedAt: plus(at),
      startedAt: plus(at - 40),
    });
    yield* itemRow(
      `${threadId}-run-${ordinal}`,
      threadId,
      1,
      "run_interrupt_request",
      "completed",
      {
        message: "Interrupt requested",
      },
    );
  });

it.effect("a restart report and a newer limit cut on a waiting lane still send one notice", () => {
  const { fake, layer } = harness();
  return Effect.gen(function* () {
    yield* limitWorld([lane]);
    const recovery = yield* RecoveryService.RecoveryService;
    yield* limitFailure(laneThread, 1, UP + 600);
    yield* at(UP + 901);
    const waiting = yield* recovery.scan;
    assert.isNotNull(waiting);
    // Poked by hand, it is cut by an OpenCode restart at 09:16:40.
    yield* runRow({
      threadId: laneThread,
      ordinal: 3,
      status: "cancelled",
      completedAt: plus(UP + 1000),
      startedAt: plus(UP + 960),
    });
    yield* itemRow(`${laneThread}-run-3`, laneThread, 1, "command_execution", "running", {
      input: "vp test run",
    });
    yield* at(UP + 1010);
    const report = yield* recovery.report(test, {
      reportId: "rs-20261024T091640Z",
      cause: "opencode-restart",
      startAt: plus(UP + 995),
      endAt: plus(UP + 1005),
      threads: [{ threadId: laneThread, runIds: [`${laneThread}-run-3`], childIds: [] }],
    });
    assert.strictEqual(report.incidentId, waiting?.id);
    // Then it fails on the limit once more before anything went out.
    yield* limitFailure(laneThread, 5, UP + 1020);
    yield* at(UP + 1330);
    assert.isNull(yield* recovery.scan);
    const open = yield* recovery.incidents(missionId);
    assert.deepStrictEqual(
      open.map((incident) => [incident.id, view(incident)]),
      [
        [
          waiting?.id,
          [
            {
              threadId: laneThread,
              action: "resume",
              state: "pending",
              usageLimit: "first",
              notBefore: plus(UP + 1020 + 703),
            },
          ],
        ],
      ],
    );
    yield* at(UP + 1723);
    assert.strictEqual(yield* recovery.tick, 1);
    yield* TestClock.adjust("1 hour");
    assert.strictEqual(yield* recovery.tick, 0);
    assert.deepStrictEqual(
      fake.sent.map((sent) => sent.threadId),
      [laneThread],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("a held limit notice takes a newer cut and stays held with what was lost", () => {
  const { fake, layer } = harness();
  return Effect.gen(function* () {
    yield* limitWorld([lane]);
    const recovery = yield* RecoveryService.RecoveryService;
    yield* limitFailure(laneThread, 1, UP + 600, {
      running: "git push origin main",
      tail: false,
    });
    yield* childRow({
      id: "sub-first",
      threadId: laneThread,
      runId: `${laneThread}-run-1`,
      status: "cancelled",
      title: "Lint sweep",
      completedAt: plus(UP + 600),
      session: "ses_first",
    });
    yield* at(UP + 901);
    const first = yield* recovery.scan;
    assert.isNotNull(first);
    yield* recovery.resume(agent(masterThread), { missionId, mode: "hold", threadId: laneThread });
    // Poked by hand, it fails on the limit again.
    yield* limitFailure(laneThread, 3, UP + 1000, { tail: false });
    yield* at(UP + 1301);
    assert.isNull(yield* recovery.scan);
    const open = yield* recovery.incidents(missionId);
    assert.deepStrictEqual(
      open.map((incident) =>
        incident.threads
          .filter((thread) => thread.threadId === laneThread)
          .map((thread) => ({
            id: incident.id,
            state: thread.state,
            action: thread.action,
            cutRunId: thread.cutRunId,
            lost: thread.lostChildren.map((child) => child.title),
            held: thread.decidedBy !== null,
          })),
      ),
      [
        [
          {
            id: first?.id,
            state: "held",
            action: "reconcile-first",
            cutRunId: `${laneThread}-run-3`,
            lost: ["Lint sweep"],
            held: true,
          },
        ],
      ],
    );
    yield* TestClock.adjust("1 hour");
    yield* recovery.tick;
    assert.notInclude(
      fake.sent.map((sent) => sent.threadId),
      laneThread,
    );
    // Released, it goes once, with the reconcile and the lost child.
    yield* recovery.resume(agent(masterThread), { missionId, mode: "now", threadId: laneThread });
    const lanes = fake.sent.filter((sent) => sent.threadId === laneThread);
    assert.strictEqual(lanes.length, 1);
    assert.include(lanes[0]?.text ?? "", "You were inside a git push");
    assert.include(lanes[0]?.text ?? "", "Lint sweep");
  }).pipe(Effect.provide(layer));
});

it.effect("a newer cut the scans never saw is replanned before a long reset sends", () => {
  const { fake, layer } = harness();
  return Effect.gen(function* () {
    yield* limitWorld([lane]);
    const recovery = yield* RecoveryService.RecoveryService;
    // A limit that resets in three hours.
    yield* limitFailure(laneThread, 1, UP + 600, { resetAt: plus(UP + 600 + 3 * 3600) });
    yield* at(UP + 901);
    const waiting = yield* recovery.scan;
    assert.strictEqual(waiting?.threads[0]?.notBefore, plus(UP + 600 + 3 * 3600 + 60));
    // Poked by hand, it fails on something else mid `git push` with a child running,
    // and no scan runs again until long after.
    yield* runRow({
      threadId: laneThread,
      ordinal: 3,
      status: "failed",
      completedAt: plus(UP + 1500),
      startedAt: plus(UP + 1440),
    });
    yield* itemRow(`${laneThread}-run-3`, laneThread, 1, "command_execution", "running", {
      input: "git push origin main",
    });
    yield* itemRow(`${laneThread}-run-3`, laneThread, 2, "error", "failed", {
      failure: {
        class: "provider",
        code: "provider.internal",
        message: "OAuth token expired",
        retryable: null,
      },
    });
    yield* childRow({
      id: "sub-second",
      threadId: laneThread,
      runId: `${laneThread}-run-3`,
      status: "cancelled",
      title: "Release notes",
      completedAt: plus(UP + 1500),
      session: "ses_second",
    });
    yield* at(UP + 600 + 3 * 3600 + 60);
    // The master goes first: the newer cut needs a reconcile, not the old plain resume.
    assert.strictEqual(yield* recovery.tick, 1);
    assert.deepStrictEqual(
      fake.sent.map((sent) => sent.threadId),
      [masterThread],
    );
    const [open] = yield* recovery.incidents(missionId);
    const lanePlan = open?.threads.find((thread) => thread.threadId === laneThread);
    assert.deepStrictEqual(
      {
        action: lanePlan?.action,
        cutRunId: lanePlan?.cutRunId,
        lost: lanePlan?.lostChildren.map((child) => child.title),
      },
      { action: "reconcile-first", cutRunId: `${laneThread}-run-3`, lost: ["Release notes"] },
    );
    yield* TestClock.adjust("61 seconds");
    assert.strictEqual(yield* recovery.tick, 1);
    assert.include(fake.sent[1]?.text ?? "", "You were inside a git push");
    assert.include(fake.sent[1]?.text ?? "", "Release notes");
  }).pipe(Effect.provide(layer));
});

it.effect("a lane the owner stopped is under Skipped in the master's summary", () => {
  const { fake, layer } = harness();
  return Effect.gen(function* () {
    yield* limitWorld([lane, webLane]);
    const recovery = yield* RecoveryService.RecoveryService;
    yield* limitFailure(laneThread, 1, UP + 600);
    yield* limitFailure(webThread, 1, UP + 610);
    yield* at(UP + 911);
    assert.isNotNull(yield* recovery.scan);
    yield* ownerStop(laneThread, 3, UP + 1000);
    // With the API lane out, the summary waits for the web lane's reset.
    yield* at(UP + 1303);
    assert.strictEqual(yield* recovery.tick, 0);
    yield* at(UP + 1313);
    assert.strictEqual(yield* recovery.tick, 1);
    const summary = fake.sent[0];
    assert.strictEqual(summary?.threadId, masterThread);
    assert.include(summary?.text ?? "", '1. lane "Web"');
    assert.notInclude(summary?.text ?? "", "2. lane");
    assert.include(
      summary?.text ?? "",
      `Skipped: lane "API" ("Lane API", ${laneThread}) (stopped by the owner).`,
    );
    const [open] = yield* recovery.incidents(missionId);
    assert.deepStrictEqual(
      open?.threads
        .filter((thread) => thread.threadId === laneThread)
        .map((thread) => [thread.action, thread.state]),
      [["skip", "skipped"]],
    );
    yield* TestClock.adjust("2 minutes");
    yield* recovery.tick;
    assert.deepStrictEqual(
      fake.sent.map((sent) => sent.threadId),
      [masterThread, webThread],
    );
  }).pipe(Effect.provide(layer));
});

/** A run an OpenCode restart cut mid command, reported by the restart watch. */
const restartCut = (ordinal: number, at: number) =>
  Effect.gen(function* () {
    const recovery = yield* RecoveryService.RecoveryService;
    const runId = `${laneThread}-run-${ordinal}`;
    yield* runRow({
      threadId: laneThread,
      ordinal,
      status: "cancelled",
      completedAt: plus(at),
      startedAt: plus(at - 40),
    });
    yield* itemRow(runId, laneThread, 1, "command_execution", "running", { input: "vp test run" });
    yield* TestClock.setTime(T0 + (at + 10) * 1000);
    return yield* recovery.report(test, {
      reportId: `rs-${runId}`,
      cause: "opencode-restart",
      startAt: plus(at - 5),
      endAt: plus(at + 5),
      threads: [{ threadId: laneThread, runIds: [runId], childIds: [] }],
    });
  });

it.effect("notices the router refused fold into one limit notice that waits for the reset", () => {
  const { fake, layer } = harness();
  return Effect.gen(function* () {
    yield* limitWorld([lane]);
    const recovery = yield* RecoveryService.RecoveryService;
    fake.refuse.set(laneThread, new MissionError({ code: "conflict", detail: "Room is busy." }));
    // Two restarts, and the router turns both lane notices away.
    const first = yield* restartCut(1, UP + 300);
    assert.isNotNull(first.incidentId);
    yield* recovery.tick;
    yield* TestClock.adjust("61 seconds");
    yield* recovery.tick;
    const second = yield* restartCut(3, UP + 400);
    assert.isNotNull(second.incidentId);
    assert.notStrictEqual(second.incidentId, first.incidentId);
    yield* recovery.tick;
    yield* TestClock.adjust("61 seconds");
    yield* recovery.tick;
    // Then it fails on the limit before either went out.
    yield* limitFailure(laneThread, 5, UP + 600);
    yield* at(UP + 901);
    assert.isNull(yield* recovery.scan);
    fake.refuse.delete(laneThread);
    const laneEntries = Effect.map(recovery.incidents(missionId), (open) =>
      open.flatMap((incident) =>
        incident.threads
          .filter((thread) => thread.threadId === laneThread)
          .map((thread) => [incident.id, thread.state, thread.usageLimit ?? null]),
      ),
    );
    assert.deepStrictEqual(yield* laneEntries, [
      [second.incidentId, "skipped", null],
      [first.incidentId, "pending", "first"],
    ]);
    yield* at(UP + 1302);
    yield* recovery.tick;
    assert.notInclude(
      fake.sent.map((sent) => sent.threadId),
      laneThread,
    );
    yield* at(UP + 1303);
    yield* recovery.tick;
    yield* TestClock.adjust("1 hour");
    yield* recovery.tick;
    assert.strictEqual(fake.sent.filter((sent) => sent.threadId === laneThread).length, 1);
  }).pipe(Effect.provide(layer));
});

it.effect(
  "a newer limit still settling holds the notice even after an older cut is replanned",
  () => {
    const { fake, layer } = harness();
    return Effect.gen(function* () {
      yield* limitWorld([lane]);
      const recovery = yield* RecoveryService.RecoveryService;
      yield* limitFailure(laneThread, 1, UP + 600);
      yield* at(UP + 901);
      assert.strictEqual((yield* recovery.scan)?.threads[0]?.notBefore, plus(UP + 1303));
      // Poked by hand: one failure on something else, then the limit again at 09:20:50.
      yield* runRow({
        threadId: laneThread,
        ordinal: 3,
        status: "failed",
        completedAt: plus(UP + 950),
        startedAt: plus(UP + 920),
      });
      yield* itemRow(`${laneThread}-run-3`, laneThread, 1, "error", "failed", {
        failure: {
          class: "provider",
          code: "provider.internal",
          message: "OAuth token expired",
          retryable: null,
        },
      });
      yield* limitFailure(laneThread, 4, UP + 1250, {
        message: '[claude/claude-opus-5-5] [429]: {"type":"rate_limit_error"} (reset after 20m)',
      });
      // At the first reset the older cut has settled and the newer one hasn't.
      yield* at(UP + 1303);
      assert.strictEqual(yield* recovery.tick, 0);
      yield* at(UP + 1551);
      assert.isNull(yield* recovery.scan);
      yield* at(UP + 2509);
      assert.strictEqual(yield* recovery.tick, 0);
      yield* at(UP + 2510);
      assert.strictEqual(yield* recovery.tick, 1);
      yield* TestClock.adjust("1 hour");
      yield* recovery.tick;
      assert.deepStrictEqual(
        fake.sent.map((sent) => sent.threadId),
        [laneThread],
      );
      assert.include(fake.sent[0]?.text ?? "", "failed at 09:20");
    }).pipe(Effect.provide(layer));
  },
);

it.effect("a held limit notice stays the one notice through a restart and another limit", () => {
  const { fake, layer } = harness();
  return Effect.gen(function* () {
    yield* limitWorld([lane]);
    const recovery = yield* RecoveryService.RecoveryService;
    yield* limitFailure(laneThread, 1, UP + 600);
    yield* at(UP + 901);
    const waiting = yield* recovery.scan;
    assert.isNotNull(waiting);
    yield* recovery.resume(agent(masterThread), { missionId, mode: "hold", threadId: laneThread });
    // Poked by hand, an OpenCode restart cuts it, then it fails on the limit again.
    const report = yield* restartCut(3, UP + 1000);
    assert.strictEqual(report.incidentId, waiting?.id);
    yield* limitFailure(laneThread, 5, UP + 1020);
    yield* at(UP + 1330);
    assert.isNull(yield* recovery.scan);
    assert.deepStrictEqual(
      (yield* recovery.incidents(missionId)).map((incident) => [incident.id, view(incident)]),
      [
        [
          waiting?.id,
          [
            {
              threadId: laneThread,
              action: "resume",
              state: "held",
              usageLimit: "first",
              notBefore: plus(UP + 1020 + 703),
            },
          ],
        ],
      ],
    );
    yield* TestClock.adjust("1 hour");
    yield* recovery.tick;
    assert.deepStrictEqual(fake.sent, []);
    // Released, it goes once.
    yield* recovery.resume(agent(masterThread), {
      missionId,
      mode: "release",
      threadId: laneThread,
    });
    yield* recovery.tick;
    yield* TestClock.adjust("1 hour");
    yield* recovery.tick;
    assert.deepStrictEqual(
      fake.sent.map((sent) => sent.threadId),
      [laneThread],
    );
  }).pipe(Effect.provide(layer));
});
