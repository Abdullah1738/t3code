import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
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
  return { registry, signals, removed, written, graces: () => graceCount };
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
  it.effect("retains a denied group and fails before startup can continue", () =>
    Effect.gen(function* () {
      const f = fixture({
        signal: () => {
          throw new Error("EPERM");
        },
      });
      const exit = yield* Effect.exit(f.registry.reap);
      assert.equal(exit._tag, "Failure");
      assert.deepEqual(f.removed, []);
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
