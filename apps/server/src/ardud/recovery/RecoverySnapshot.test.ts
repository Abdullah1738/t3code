/**
 * The recovery snapshot reads every live thread's run, runtime and children
 * without loading or touching a provider session. Paging covers every id.
 */
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProviderSessionManager from "../../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ControlStore from "../control/ControlStore.ts";
import * as ExecutionIdentity from "../identity/ExecutionIdentity.ts";
import * as RecoverySnapshot from "./RecoverySnapshot.ts";

const at = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
const startedAt = DateTime.makeUnsafe("2026-01-01T00:01:00.000Z");

const providerThreadFor = (
  id: string,
  providerSessionId: string | null,
): OrchestrationV2ProviderThread =>
  ({
    id: ProviderThreadId.make(`pt-${id}`),
    driver: ProviderDriverKind.make("opencode"),
    providerInstanceId: ProviderInstanceId.make("opencode"),
    providerSessionId:
      providerSessionId === null ? null : ProviderSessionId.make(providerSessionId),
    nativeThreadRef: null,
    status: "idle",
  }) as unknown as OrchestrationV2ProviderThread;

const runFor = (id: string, status: OrchestrationV2Run["status"]): OrchestrationV2Run =>
  ({
    id: RunId.make(`run-${id}`),
    status,
    activeAttemptId: RunAttemptId.make(`attempt-${id}`),
    startedAt,
  }) as unknown as OrchestrationV2Run;

const shellFor = (id: string): OrchestrationV2ThreadShell =>
  ({
    id: ThreadId.make(id),
    activeProviderThreadId: ProviderThreadId.make(`pt-${id}`),
    modelSelection: { instanceId: ProviderInstanceId.make("opencode"), model: "opus/model" },
    updatedAt: at,
  }) as unknown as OrchestrationV2ThreadShell;

const idleSession = {
  shutdown: Effect.void,
  get: () => Effect.die("get must not run on the recovery snapshot"),
  open: () => Effect.die("open must not run on the recovery snapshot"),
  isLive: () => Effect.die("isLive must not run on the recovery snapshot"),
};

const sessionsWith = (
  peek: ProviderSessionManager.ProviderSessionManagerV2Shape["peek"] | undefined,
): ProviderSessionManager.ProviderSessionManagerV2Shape =>
  ({ ...idleSession, peek }) as unknown as ProviderSessionManager.ProviderSessionManagerV2Shape;

const presentRuntime = (holds: boolean) =>
  Option.some({
    holdsWorkForThread: () => Effect.succeed(holds),
  } as never);

interface Fixture {
  readonly liveIds: ReadonlyArray<string>;
  readonly shells: ReadonlyMap<string, OrchestrationV2ThreadShell>;
  readonly runs: ReadonlyMap<string, ReadonlyArray<OrchestrationV2Run>>;
  readonly providerThreads: ReadonlyMap<string, ReadonlyArray<OrchestrationV2ProviderThread>>;
  readonly subagents?: ReadonlyMap<string, ReadonlyArray<OrchestrationV2Subagent>>;
}

const layerFor = (
  fixture: Fixture,
  sessions: ProviderSessionManager.ProviderSessionManagerV2Shape,
): Layer.Layer<RecoverySnapshot.RecoverySnapshot> => {
  const control = Layer.mock(ControlStore.ControlStore)({
    liveThreadIds: () => Effect.succeed(fixture.liveIds),
  });
  const identity = Layer.mock(ExecutionIdentity.ExecutionIdentity)({
    currentNative: () => Effect.succeed(new Map()),
  });
  const threads = Layer.mock(ThreadManagementService.ThreadManagementService)({
    getShellSnapshot: () =>
      Effect.succeed({
        schemaVersion: 1,
        snapshotSequence: 1,
        threads: [...fixture.shells.values()],
        archivedThreads: [],
      } as never),
    getThreadShell: (id) => Effect.succeed(fixture.shells.get(id) ?? null),
    getThreadRecords: (id) =>
      Effect.succeed({
        runs: fixture.runs.get(id) ?? [],
        providerThreads: fixture.providerThreads.get(id) ?? [],
        runtimeRequests: [],
        subagents: fixture.subagents?.get(id) ?? [],
      } as never),
  });
  const sessionLayer = Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)(sessions);
  return RecoverySnapshot.layer.pipe(
    Layer.provide(Layer.mergeAll(control, identity, threads, sessionLayer)),
  );
};

const snapshotOf = <A, E>(
  layer: Layer.Layer<RecoverySnapshot.RecoverySnapshot>,
  body: (snapshot: RecoverySnapshot.RecoverySnapshot["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const snapshot = yield* RecoverySnapshot.RecoverySnapshot;
    return yield* body(snapshot);
  }).pipe(Effect.provide(layer));

/** A fixture of `count` live threads, each with a running run and an unloaded session. */
const liveFixture = (count: number): Fixture => {
  const liveIds = Array.from(
    { length: count },
    (_, index) => `thread-${String(index).padStart(4, "0")}`,
  );
  return {
    liveIds,
    shells: new Map(liveIds.map((id) => [id, shellFor(id)])),
    runs: new Map(liveIds.map((id) => [id, [runFor(id, "running")]])),
    providerThreads: new Map(liveIds.map((id) => [id, [providerThreadFor(id, null)]])),
  };
};

describe("RecoverySnapshot", () => {
  it.effect("pages 1,200 live ids as 500, 500 and 200 with every id once", () =>
    Effect.gen(function* () {
      const fixture = liveFixture(1200);
      const layer = layerFor(
        fixture,
        sessionsWith(() => Effect.succeed(Option.none())),
      );
      const pages = yield* snapshotOf(layer, (snapshot) =>
        Effect.gen(function* () {
          const first = yield* snapshot.page({ active: true, cursor: null, limit: 500 });
          const second = yield* snapshot.page({
            active: true,
            cursor: first.nextCursor,
            limit: 500,
          });
          const third = yield* snapshot.page({
            active: true,
            cursor: second.nextCursor,
            limit: 500,
          });
          return { first, second, third };
        }),
      );
      assert.deepStrictEqual(
        [pages.first.threads.length, pages.second.threads.length, pages.third.threads.length],
        [500, 500, 200],
      );
      const seen = [...pages.first.threads, ...pages.second.threads, ...pages.third.threads].map(
        (entry) => entry.threadId,
      );
      assert.strictEqual(new Set(seen).size, 1200);
      assert.deepStrictEqual(seen, [...fixture.liveIds]);
      assert.strictEqual(pages.third.nextCursor, null);
    }),
  );

  it.effect("reports runtime absent when the active provider thread has no session", () =>
    Effect.gen(function* () {
      const fixture = liveFixture(1);
      const layer = layerFor(
        fixture,
        sessionsWith(() => Effect.die("peek must not run without a session")),
      );
      const page = yield* snapshotOf(layer, (snapshot) =>
        snapshot.page({ active: true, cursor: null, limit: 10 }),
      );
      assert.strictEqual(page.threads[0]?.runtime, "absent");
      assert.strictEqual(page.threads[0]?.heldWork, null);
    }),
  );

  it.effect("reports runtime unknown when the session manager has no peek", () =>
    Effect.gen(function* () {
      const fixture: Fixture = {
        ...liveFixture(1),
        providerThreads: new Map([
          ["thread-0000", [providerThreadFor("thread-0000", "session-a")]],
        ]),
      };
      const layer = layerFor(fixture, sessionsWith(undefined));
      const page = yield* snapshotOf(layer, (snapshot) =>
        snapshot.page({ active: true, cursor: null, limit: 10 }),
      );
      assert.strictEqual(page.threads[0]?.runtime, "unknown");
      assert.strictEqual(page.threads[0]?.heldWork, null);
    }),
  );

  it.effect("reports runtime unknown when peek dies rather than failing the page", () =>
    Effect.gen(function* () {
      const fixture: Fixture = {
        ...liveFixture(1),
        providerThreads: new Map([
          ["thread-0000", [providerThreadFor("thread-0000", "session-a")]],
        ]),
      };
      const layer = layerFor(
        fixture,
        sessionsWith(() => Effect.die("peek exploded")),
      );
      const page = yield* snapshotOf(layer, (snapshot) =>
        snapshot.page({ active: true, cursor: null, limit: 10 }),
      );
      assert.strictEqual(page.threads[0]?.runtime, "unknown");
      assert.strictEqual(page.threads[0]?.heldWork, null);
    }),
  );

  it.effect("reports a present session with heldWork from holdsWorkForThread", () =>
    Effect.gen(function* () {
      const fixture: Fixture = {
        ...liveFixture(1),
        providerThreads: new Map([
          ["thread-0000", [providerThreadFor("thread-0000", "session-a")]],
        ]),
      };
      const holding = layerFor(
        fixture,
        sessionsWith(() => Effect.succeed(presentRuntime(true))),
      );
      const idle = layerFor(
        fixture,
        sessionsWith(() => Effect.succeed(presentRuntime(false))),
      );
      const held = yield* snapshotOf(holding, (snapshot) =>
        snapshot.page({ active: true, cursor: null, limit: 10 }),
      );
      const free = yield* snapshotOf(idle, (snapshot) =>
        snapshot.page({ active: true, cursor: null, limit: 10 }),
      );
      assert.strictEqual(held.threads[0]?.runtime, "present");
      assert.strictEqual(held.threads[0]?.heldWork, true);
      assert.strictEqual(free.threads[0]?.runtime, "present");
      assert.strictEqual(free.threads[0]?.heldWork, false);
    }),
  );

  it.effect("reports heldWork as unknown when a present session's work probe dies", () =>
    Effect.gen(function* () {
      const fixture: Fixture = {
        ...liveFixture(1),
        providerThreads: new Map([
          ["thread-0000", [providerThreadFor("thread-0000", "session-a")]],
        ]),
      };
      // Both thread-specific probes and the session-wide fallback must preserve
      // failure rather than reporting the archive path's conservative true.
      const runtimes = [
        {
          hasPendingBackgroundWorkForThread: () => Effect.die("running work probe failed"),
          holdsWorkForThread: () => Effect.succeed(true),
        },
        {
          hasPendingBackgroundWorkForThread: () => Effect.succeed(false),
          holdsWorkForThread: () => Effect.die("held work probe failed"),
        },
        { hasPendingBackgroundWork: Effect.die("session-wide probe failed") },
      ];
      for (const runtime of runtimes) {
        const layer = layerFor(
          fixture,
          sessionsWith(() => Effect.succeed(Option.some(runtime as never))),
        );
        const page = yield* snapshotOf(layer, (snapshot) =>
          snapshot.page({ active: true, cursor: null, limit: 10 }),
        );
        assert.strictEqual(page.threads[0]?.runtime, "present");
        assert.strictEqual(page.threads[0]?.heldWork, null);
      }
    }),
  );

  it.effect("never loads or touches an idle session", () =>
    Effect.gen(function* () {
      // get, open and isLive die if called (see idleSession). A present session
      // must still read as present, through peek alone.
      const fixture: Fixture = {
        ...liveFixture(1),
        providerThreads: new Map([
          ["thread-0000", [providerThreadFor("thread-0000", "session-a")]],
        ]),
      };
      const layer = layerFor(
        fixture,
        sessionsWith(() => Effect.succeed(presentRuntime(false))),
      );
      const page = yield* snapshotOf(layer, (snapshot) =>
        snapshot.page({ active: true, cursor: null, limit: 10 }),
      );
      assert.strictEqual(page.threads[0]?.runtime, "present");
    }),
  );

  it.effect("lists native children from subagents that have a child thread", () =>
    Effect.gen(function* () {
      const child = {
        childThreadId: ThreadId.make("child-a"),
        origin: "provider_native",
        status: "running",
      } as unknown as OrchestrationV2Subagent;
      const orphan = {
        childThreadId: null,
        origin: "app_owned",
        status: "pending",
      } as unknown as OrchestrationV2Subagent;
      const fixture: Fixture = {
        ...liveFixture(1),
        subagents: new Map([["thread-0000", [child, orphan]]]),
      };
      const layer = layerFor(
        fixture,
        sessionsWith(() => Effect.succeed(Option.none())),
      );
      const page = yield* snapshotOf(layer, (snapshot) =>
        snapshot.page({ active: true, cursor: null, limit: 10 }),
      );
      assert.deepStrictEqual(page.threads[0]?.children, [
        { threadId: "child-a", kind: "provider_native", status: "running" },
      ]);
    }),
  );
});
