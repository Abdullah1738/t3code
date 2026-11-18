import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as TestClock from "effect/testing/TestClock";
import { makeRegistry, type RegistryHost } from "./ProviderProcessRegistry.ts";

const old = {
  pid: 42,
  pgid: 42,
  startTime: "100:123456",
  commandLine: "/opt/claude --session-id abc",
  providerCommandLine: "/opt/claude --session-id abc",
  members: [],
  bootId: "old",
  provider: "claudeAgent" as const,
  threadId: "thread-1",
  recordedAt: 100,
};
function fixture(overrides: Partial<RegistryHost> = {}) {
  const signals: unknown[] = [];
  const removed: unknown[] = [];
  const written: Array<Parameters<RegistryHost["write"]>[0]> = [];
  const logs: Array<ReadonlyArray<unknown>> = [];
  let graceCount = 0;
  const registry = makeRegistry({
    platform: "darwin",
    bootId: "new",
    now: () => 500,
    inspect: () => old,
    members: () => [],
    read: () => [old],
    write: (record) => {
      written.push(record);
    },
    remove: (record) => {
      removed.push(record);
    },
    signal: (pgid, signal) => {
      signals.push([pgid, signal]);
    },
    grace: Effect.sync(() => {
      graceCount++;
    }),
    ...overrides,
  });
  return {
    registry: {
      ...registry,
      reap: registry.reap.pipe(
        Effect.provide(
          Logger.layer(
            [
              Logger.make(({ message }) => {
                logs.push(Array.isArray(message) ? message : [message]);
              }),
            ],
            { mergeWithExisting: false },
          ),
        ),
      ),
    },
    signals,
    removed,
    written,
    logs,
    graces: () => graceCount,
  };
}

describe("previous boot provider groups", () => {
  it.effect("sends TERM, waits once for the batch, then identity-checked KILL", () =>
    Effect.gen(function* () {
      const f = fixture();
      assert.deepEqual(yield* f.registry.reap, [old]);
      assert.deepEqual(f.signals, [
        [42, "SIGTERM"],
        [42, "SIGKILL"],
      ]);
      assert.equal(f.graces(), 1);
      assert.deepEqual(f.removed, [old]);
    }),
  );
  it.effect.each([
    ["current boot", { read: () => [{ ...old, bootId: "new" }] }],
    ["dead PID", { inspect: () => undefined }],
    ["reused PID with changed command", { inspect: () => ({ ...old, commandLine: "/opt/other" }) }],
    [
      "reused PID with same command and different start",
      { inspect: () => ({ ...old, startTime: "100:123457" }) },
    ],
    ["changed process group", { inspect: () => ({ ...old, pgid: 24 }) }],
    ["shared group record", { read: () => [{ ...old, pgid: 24 }] }],
    ["invalid PID", { read: () => [{ ...old, pid: 0, pgid: 0 }] }],
    ["Windows", { platform: "win32" }],
  ] satisfies ReadonlyArray<readonly [string, Partial<RegistryHost>]>)(
    "leaves %s alone",
    ([_name, overrides]) =>
      Effect.gen(function* () {
        const f = fixture(overrides);
        assert.deepEqual(yield* f.registry.reap, []);
        assert.deepEqual(f.signals, []);
        assert.equal(f.graces(), 0);
      }),
  );
  it.effect("rechecks identity after grace, including same-command PID reuse", () =>
    Effect.gen(function* () {
      let live = old;
      const f = fixture({
        inspect: () => live,
        grace: Effect.sync(() => {
          live = { ...old, startTime: "101:1" };
        }),
      });
      yield* f.registry.reap;
      assert.deepEqual(f.signals, [[42, "SIGTERM"]]);
    }),
  );
  it.effect("does not KILL when TERM ended the leader", () =>
    Effect.gen(function* () {
      let live = true;
      const f = fixture({
        inspect: () => (live ? old : undefined),
        grace: Effect.sync(() => {
          live = false;
        }),
      });
      yield* f.registry.reap;
      assert.deepEqual(f.signals, [[42, "SIGTERM"]]);
    }),
  );
  it.effect("retains a denied group without failing startup", () =>
    Effect.gen(function* () {
      const f = fixture({
        signal: () => {
          throw new Error("EPERM");
        },
      });
      assert.deepEqual(yield* f.registry.reap, []);
      assert.deepEqual(f.removed, []);
      assert.equal(f.logs[0]?.[0], "provider.previous-boot-reap-failed");
    }),
  );
  it("records ownership synchronously and removes it on exit", () => {
    const f = fixture();
    const untrack = f.registry.track(42, "claudeAgent", "thread-2", old.providerCommandLine);
    assert.deepEqual(f.written, [{ ...old, bootId: "new", threadId: "thread-2", recordedAt: 500 }]);
    untrack();
    assert.deepEqual(f.removed, f.written);
  });
  it("refuses an unidentifiable or shared process group", () => {
    for (const inspect of [() => undefined, () => ({ ...old, pgid: 24 })]) {
      const f = fixture({ inspect });
      assert.throws(() => f.registry.track(42, "claudeAgent", "thread-2", old.providerCommandLine));
      assert.deepEqual(f.written, []);
    }
  });
});

describe("launch transitions and surviving group members", () => {
  it.effect.each([
    {
      name: "shell launcher",
      commandLine: '/bin/sh -c exec "$@" t3-agent /opt/claude --session-id abc',
    },
    {
      name: "systemd launcher",
      commandLine: "/usr/bin/systemd-run --user --scope -- /opt/claude --session-id abc",
    },
    { name: "provider", commandLine: old.providerCommandLine },
  ])("keeps ownership after exec to $name", ({ commandLine }) =>
    Effect.gen(function* () {
      let live = { ...old, commandLine: "/bin/sh before exec" };
      const f = fixture({ inspect: () => live });
      f.registry.track(42, "claudeAgent", "thread-2", old.providerCommandLine);
      const saved = f.written[0]!;
      live = { ...live, commandLine };
      const afterRestart = fixture({ bootId: "next", read: () => [saved], inspect: () => live });
      yield* afterRestart.registry.reap;
      assert.deepEqual(afterRestart.signals, [
        [42, "SIGTERM"],
        [42, "SIGKILL"],
      ]);
    }),
  );

  const child = { pid: 43, pgid: 42, startTime: "100:123457", commandLine: "/opt/tool" };
  it.effect.each([
    { name: "surviving tool child", after: child, kill: true },
    { name: "exited tool child", after: undefined, kill: false },
    {
      name: "reused child PID with changed command",
      after: { ...child, commandLine: "/opt/other" },
      kill: false,
    },
    {
      name: "reused child PID with changed start",
      after: { ...child, startTime: "101:1" },
      kill: false,
    },
    { name: "child moved to another group", after: { ...child, pgid: 44 }, kill: false },
  ])("rechecks $name after TERM exits the leader", ({ after, kill }) =>
    Effect.gen(function* () {
      let leaderAlive = true;
      const f = fixture({
        members: () => [child],
        inspect: (pid) =>
          pid === old.pid ? (leaderAlive ? old : undefined) : leaderAlive ? child : after,
        grace: Effect.sync(() => {
          leaderAlive = false;
        }),
      });
      yield* f.registry.reap;
      assert.deepEqual(
        f.signals,
        kill
          ? [
              [42, "SIGTERM"],
              [42, "SIGKILL"],
            ]
          : [[42, "SIGTERM"]],
      );
      assert.deepEqual(f.written, [{ ...old, members: [child] }]);
    }),
  );

  it.effect("retains group identity across a second backend death after TERM", () =>
    Effect.gen(function* () {
      const f = fixture({
        read: () => [{ ...old, members: [child] }],
        inspect: (pid) => (pid === child.pid ? child : undefined),
        members: () => [child],
      });
      yield* f.registry.reap;
      assert.deepEqual(f.signals, [
        [42, "SIGTERM"],
        [42, "SIGKILL"],
      ]);
    }),
  );

  it.effect("does not adopt a replacement group during the member snapshot", () =>
    Effect.gen(function* () {
      let live = old;
      const f = fixture({
        inspect: (pid) => (pid === old.pid ? live : child),
        members: () => {
          live = { ...old, startTime: "101:1" };
          return [child];
        },
      });
      yield* f.registry.reap;
      assert.deepEqual(f.signals, []);
      assert.deepEqual(f.written, []);
    }),
  );
});

describe("best effort startup cleanup", () => {
  const other = { ...old, pid: 52, pgid: 52 };
  const failure = new Error("start time unavailable");

  it.effect("retains an uninspectable PID and reaps the next record", () =>
    Effect.gen(function* () {
      const f = fixture({
        read: () => [old, other],
        inspect: (pid) => {
          if (pid === old.pid) throw failure;
          return other;
        },
      });
      assert.deepEqual(yield* f.registry.reap, [other]);
      assert.deepEqual(f.signals, [
        [52, "SIGTERM"],
        [52, "SIGKILL"],
      ]);
      assert.deepEqual(f.written, [{ ...old, inspectFailures: 1 }, other]);
      assert.deepEqual(f.removed, [other]);
      const warnings = f.logs.filter(
        ([event]) => event === "provider.previous-boot-process-uninspectable",
      );
      assert.deepEqual(warnings, [
        [
          "provider.previous-boot-process-uninspectable",
          {
            pid: 42,
            pgid: 42,
            provider: "claudeAgent",
            threadId: "thread-1",
            bootId: "old",
            ageMs: 400,
            stage: "owns",
            error: failure,
            inspectFailures: 1,
          },
        ],
      ]);
    }),
  );

  it.effect.each([
    { name: "third failed boot", failures: 2, ageMs: 400, drop: true },
    { name: "older than 24 hours", failures: 0, ageMs: 86_400_001, drop: true },
    { name: "second failed boot", failures: 1, ageMs: 400, drop: false },
    { name: "exactly 24 hours", failures: 0, ageMs: 86_400_000, drop: false },
  ])("caps retention at $name", ({ failures, ageMs, drop }) =>
    Effect.gen(function* () {
      const record = { ...old, inspectFailures: failures };
      const f = fixture({
        read: () => [record],
        now: () => old.recordedAt + ageMs,
        inspect: () => {
          throw failure;
        },
      });
      assert.deepEqual(yield* f.registry.reap, []);
      assert.deepEqual(f.signals, []);
      assert.deepEqual(f.removed, drop ? [record] : []);
      assert.deepEqual(f.written, drop ? [] : [{ ...record, inspectFailures: failures + 1 }]);
      assert.equal(
        f.logs.filter(([event]) => event === "provider.previous-boot-process-dropped").length,
        drop ? 1 : 0,
      );
    }),
  );

  it.effect("retains ownership when member inspection throws", () =>
    Effect.gen(function* () {
      const f = fixture({
        members: () => {
          throw failure;
        },
      });
      assert.deepEqual(yield* f.registry.reap, []);
      assert.deepEqual(f.signals, []);
      assert.deepEqual(f.removed, []);
      assert.deepEqual(f.written, [{ ...old, inspectFailures: 1 }]);
      assert.deepInclude(f.logs[0]?.[1], { stage: "members", error: failure });
    }),
  );

  it.effect.each([2, 3, 4])("fails closed on inspection call %s", (failAt) =>
    Effect.gen(function* () {
      let calls = 0;
      const child = { ...old, pid: 43, commandLine: "/opt/tool" };
      const anchored = { ...old, members: [child] };
      const f = fixture({
        members: () => [child],
        inspect: () => {
          if (++calls === failAt) throw failure;
          return old;
        },
      });
      yield* f.registry.reap;
      assert.deepEqual(f.signals, failAt === 4 ? [[42, "SIGTERM"]] : []);
      assert.deepEqual(f.removed, []);
      assert.deepEqual(f.written.at(-1), {
        ...(failAt === 2 ? old : anchored),
        inspectFailures: 1,
      });
      assert.deepInclude(f.logs.at(-1)?.[1], { stage: "recheck", error: failure });
    }),
  );

  it.effect("fails closed when a saved member cannot be inspected", () =>
    Effect.gen(function* () {
      const child = { ...old, pid: 43 };
      const record = { ...old, members: [child] };
      const f = fixture({
        read: () => [record],
        inspect: (pid) => {
          if (pid === child.pid) throw failure;
          return undefined;
        },
      });
      yield* f.registry.reap;
      assert.deepEqual(f.signals, []);
      assert.deepEqual(f.written, [{ ...record, inspectFailures: 1 }]);
    }),
  );

  it.effect("leaves remaining records untouched when inspection exhausts the budget", () =>
    Effect.gen(function* () {
      let now = 500;
      const inspected: number[] = [];
      const f = fixture({
        now: () => now,
        read: () => [old, other],
        inspect: (pid) => {
          inspected.push(pid);
          now += 10_000;
          throw failure;
        },
      });
      assert.deepEqual(yield* f.registry.reap, []);
      assert.deepEqual(inspected, [42]);
      assert.deepEqual(f.signals, []);
      assert.deepEqual(f.written, [{ ...old, inspectFailures: 1 }]);
      assert.deepEqual(f.removed, []);
      assert.deepEqual(f.logs.slice(-1), [
        [
          "provider.previous-boot-reap-budget",
          {
            budgetMs: 10_000,
            elapsedMs: 10_000,
            records: 2,
            deferredRecords: 2,
            stoppedRecords: 0,
            pendingEscalations: 0,
          },
        ],
      ]);
    }),
  );

  it.effect("checks the budget during a member scan", () =>
    Effect.gen(function* () {
      let now = 500;
      const f = fixture({
        now: () => now,
        members: (_pgid, remainingMs) => {
          assert.equal(remainingMs?.(), 10_000);
          now += 10_000;
          remainingMs?.();
          assert.fail("must stop the member scan");
        },
      });
      yield* f.registry.reap;
      assert.deepEqual(f.signals, []);
      assert.deepEqual(f.written, [{ ...old, inspectFailures: 1 }]);
      assert.deepEqual(f.removed, []);
      assert.equal(f.logs.at(-1)?.[0], "provider.previous-boot-reap-budget");
    }),
  );

  it.effect("drops a repeatedly budget-exhausting record on its third failed boot", () =>
    Effect.gen(function* () {
      let saved: Parameters<RegistryHost["write"]>[0] | undefined = old;
      for (let boot = 1; boot <= 4; boot++) {
        let now = 500;
        const f = fixture({
          bootId: `boot-${boot}`,
          now: () => now,
          read: () => (saved === undefined ? [other] : [saved, other]),
          inspect: (pid) => (pid === old.pid ? old : other),
          members: (pgid, remainingMs) => {
            if (pgid === old.pgid) {
              now += 10_000;
              remainingMs?.();
            }
            return [];
          },
          write: (record) => {
            if (record.pid === old.pid) saved = record;
          },
          remove: (record) => {
            if (record.pid === old.pid) saved = undefined;
          },
        });
        yield* f.registry.reap;
        assert.deepEqual(
          f.signals,
          boot === 4
            ? [
                [52, "SIGTERM"],
                [52, "SIGKILL"],
              ]
            : [],
        );
        if (boot < 3) assert.equal(saved?.inspectFailures, boot);
        else assert.isUndefined(saved);
        if (boot === 3) assert.equal(f.logs[1]?.[0], "provider.previous-boot-process-dropped");
      }
    }),
  );

  it.effect.each([
    { name: "third failure", inspectFailures: 2, ageMs: 400 },
    { name: "24 hour limit", inspectFailures: 0, ageMs: 86_400_001 },
  ])("applies $name when a recheck consumes the budget", ({ inspectFailures, ageMs }) =>
    Effect.gen(function* () {
      const record = { ...old, inspectFailures };
      let now = old.recordedAt + ageMs;
      const f = fixture({
        now: () => now,
        read: () => [record],
        inspect: () => old,
        grace: Effect.sync(() => {
          now += 10_000;
        }),
      });
      yield* f.registry.reap;
      assert.deepEqual(f.signals, [[42, "SIGTERM"]]);
      assert.deepEqual(f.removed, [record]);
      assert.equal(f.logs[1]?.[0], "provider.previous-boot-process-dropped");
      assert.deepInclude(f.logs.at(-1)?.[1], { pendingEscalations: 0 });
    }),
  );

  it.effect.each([
    { stage: "remove unowned record", deferredRecords: 1, pendingEscalations: 1 },
    { stage: "grace after removal", deferredRecords: 0, pendingEscalations: 1 },
    { stage: "remove after KILL", deferredRecords: 0, pendingEscalations: 1 },
  ])("reports completed operations when timing out in $stage", ({ stage, ...counts }) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const blocked = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never));
      const f = fixture({
        inspect: (pid) =>
          pid === old.pid ? old : stage === "remove after KILL" ? other : undefined,
        grace: stage === "grace after removal" ? blocked : Effect.void,
        cleanupIO: {
          read: Effect.succeed([old, other]),
          write: () => Effect.void,
          remove: (record) =>
            (stage === "remove unowned record" && record.pid === other.pid) ||
            (stage === "remove after KILL" && record.pid === old.pid)
              ? blocked
              : Effect.void,
        },
      });
      const fiber = yield* f.registry.reap.pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* TestClock.adjust("10 seconds");
      yield* Fiber.join(fiber);
      assert.deepInclude(f.logs.at(-1)?.[1], { records: 2, ...counts });
      assert.equal(f.logs.at(-1)?.[0], "provider.previous-boot-reap-budget");
      assert.deepEqual(
        f.signals,
        stage === "remove after KILL"
          ? [
              [42, "SIGTERM"],
              [52, "SIGTERM"],
              [42, "SIGKILL"],
            ]
          : [[42, "SIGTERM"]],
      );
    }),
  );

  it.effect.each(["read", "write", "remove"] as const)("bounds stalled cleanup %s I/O", (stage) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const blocked = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never));
      const f = fixture({
        inspect: () => (stage === "remove" ? undefined : old),
        cleanupIO: {
          read: stage === "read" ? blocked : Effect.succeed([old]),
          write: () => (stage === "write" ? blocked : Effect.void),
          remove: () => (stage === "remove" ? blocked : Effect.void),
        },
      });
      const fiber = yield* f.registry.reap.pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* TestClock.adjust("10 seconds");
      assert.deepEqual(yield* Fiber.join(fiber), []);
      assert.deepEqual(f.signals, []);
      assert.equal(f.logs.at(-1)?.[0], "provider.previous-boot-reap-budget");
    }),
  );

  it.effect("keeps anchors and skips KILL after the budget expires in grace", () =>
    Effect.gen(function* () {
      let now = 500;
      const f = fixture({
        now: () => now,
        grace: Effect.sync(() => {
          now += 10_000;
        }),
      });
      yield* f.registry.reap;
      assert.deepEqual(f.signals, [[42, "SIGTERM"]]);
      assert.deepEqual(f.written, [old, { ...old, inspectFailures: 1 }]);
      assert.deepEqual(f.removed, []);
      assert.deepInclude(f.logs.at(-1)?.[1], { pendingEscalations: 1 });
    }),
  );

  it.effect.each(["read", "write", "remove"] as const)("contains unexpected %s failures", (stage) =>
    Effect.gen(function* () {
      const f = fixture({
        [stage]: () => {
          throw failure;
        },
        ...(stage === "remove" ? { inspect: () => undefined } : {}),
      });
      assert.deepEqual(yield* f.registry.reap, []);
      assert.deepEqual(f.signals, []);
      assert.equal(f.logs[0]?.[0], "provider.previous-boot-reap-failed");
    }),
  );
});
