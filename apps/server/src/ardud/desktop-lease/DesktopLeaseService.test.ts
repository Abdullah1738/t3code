import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ExecutionIdentity from "../identity/ExecutionIdentity.ts";
import { DesktopLease, QUIET_MS, STALE_MS } from "./DesktopLease.ts";
import * as DesktopLeaseService from "./DesktopLeaseService.ts";

const caller = { driver: "codex", nativeId: "native-child" };
const childThreadId = ThreadId.make("child-holder");
const request = { taskId: "task", scope: "fixture", mode: "native" as const };
const at = DateTime.makeUnsafe("2026-11-13T00:00:00Z");
const running: OrchestrationV2Run = {
  id: RunId.make("run-holder"),
  threadId: childThreadId,
  ordinal: 1,
  providerInstanceId: ProviderInstanceId.make("codex"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-terra" },
  providerThreadId: null,
  userMessageId: MessageId.make("message-holder"),
  rootNodeId: null,
  activeAttemptId: null,
  status: "running",
  requestedAt: at,
  startedAt: at,
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
};

type Lookup = "running" | "idle" | "waiting" | "failed";
const makeHarness = Effect.fn("test.DesktopLeaseService.makeHarness")(function* () {
  let now = DateTime.toEpochMillis(at);
  let lookup: Lookup = "running";
  let lookupGate = Effect.void;
  const lookedUp: ThreadId[] = [];
  const store = new DesktopLease({ filename: ":memory:", now: () => now });
  const identity = Layer.mock(ExecutionIdentity.ExecutionIdentity)({
    resolve: () =>
      Effect.succeed({
        resolution: "resolved",
        robobThreadId: childThreadId,
        rootThreadId: "root-holder",
        parentThreadId: "root-holder",
        executionKind: "app-managed-child",
        driver: "codex",
        providerInstanceId: "codex",
        nativeSessionId: caller.nativeId,
        nativeAgentId: null,
        parentNativeAgentId: null,
        nativeOwnerThreadId: null,
        model: null,
        acceptsMessages: true,
        candidates: [],
      }),
  });
  const projection = Layer.mock(ProjectionStore.ProjectionStoreV2)({
    getRunningTurnContext: (threadId) =>
      Effect.gen(function* () {
        lookedUp.push(threadId);
        yield* lookupGate;
        if (lookup === "failed")
          return yield* new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId });
        return {
          run:
            lookup === "idle"
              ? undefined
              : {
                  ...running,
                  status: lookup === "waiting" ? ("waiting" as const) : ("running" as const),
                },
          providerThread: undefined,
          providerTurn: undefined,
        };
      }),
  });
  const context = yield* Layer.build(
    DesktopLeaseService.layerWithOptions({ factory: () => store }).pipe(
      Layer.provide(identity),
      Layer.provide(projection),
    ),
  );
  return {
    service: Context.get(context, DesktopLeaseService.DesktopLeaseService),
    store,
    lookedUp,
    addTime: (ms: number) => {
      now += ms;
    },
    setLookup: (value: Lookup) => {
      lookup = value;
    },
    setLookupGate: (gate: Effect.Effect<void>) => {
      lookupGate = gate;
    },
  };
});
const run = <A, E>(
  body: (h: Effect.Success<ReturnType<typeof makeHarness>>) => Effect.Effect<A, E>,
) => Effect.scoped(Effect.flatMap(makeHarness(), body));

describe("desktop lease service liveness", () => {
  it.effect("attributes a six-second running-turn stall to its phase with the call id", () => {
    const timings: { toolUseId: string; phase: string; durationMs: number }[] = [];
    const logger = Logger.make(({ message }) => {
      for (const value of Array.isArray(message) ? message : [message]) {
        if (
          typeof value === "object" &&
          value !== null &&
          "toolUseId" in value &&
          "phase" in value &&
          "durationMs" in value
        ) {
          timings.push(value as (typeof timings)[number]);
        }
      }
    });
    return run(({ service, setLookupGate }) =>
      Effect.gen(function* () {
        yield* service.acquire(caller, request);
        setLookupGate(TestClock.adjust("6 seconds"));
        yield* service.callStart(caller, "measured-call");
        assert.deepEqual(
          timings.map(({ phase, durationMs }) => [phase, durationMs]),
          [
            ["caller", 0],
            ["lease", 0],
            ["runningTurn", 6000],
            ["persistence", 0],
            ["total", 6000],
          ],
        );
        assert.isTrue(timings.every(({ toolUseId }) => toolUseId === "measured-call"));
      }),
    ).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
  });

  it.effect("does not touch a replacement ticket for the same child after a paused lookup", () =>
    run(({ service, store, addTime, setLookupGate }) =>
      Effect.gen(function* () {
        const first = yield* service.acquire(caller, request);
        const reading = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        setLookupGate(
          Deferred.succeed(reading, undefined).pipe(Effect.andThen(Deferred.await(resume))),
        );
        const pending = yield* Effect.forkChild(service.status());
        yield* Deferred.await(reading);
        const resolved = { robobThreadId: childThreadId, rootThreadId: "root-holder" };
        store.release(resolved, first.ticket);
        const replacement = store.acquire(resolved, { ...request, taskId: "replacement" });
        assert.notEqual(replacement.ticket, first.ticket);
        addTime(100_000);
        yield* Deferred.succeed(resume, undefined);
        const result = yield* Fiber.join(pending);
        assert.equal(result.lease?.ticket, replacement.ticket);
        assert.equal(result.lease?.state, "held");
        assert.equal(result.lease?.heartbeatAt, replacement.status.lease?.heartbeatAt);
      }),
    ),
  );

  it.effect("does not revive a lease that goes stale during the projection read", () =>
    run(({ service, store, addTime, setLookupGate }) =>
      Effect.gen(function* () {
        const initial = yield* service.acquire(caller, request);
        const reading = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        setLookupGate(
          Deferred.succeed(reading, undefined).pipe(Effect.andThen(Deferred.await(resume))),
        );
        const pending = yield* Effect.forkChild(service.status());
        yield* Deferred.await(reading);
        addTime(STALE_MS);
        assert.equal(store.status().lease?.state, "stopping");
        yield* Deferred.succeed(resume, undefined);
        const result = yield* Fiber.join(pending);
        assert.equal(result.lease?.state, "stopping");
        assert.equal(result.lease?.heartbeatAt, initial.status.lease?.heartbeatAt);
      }),
    ),
  );
  it.effect(
    "keeps a running holder held beyond the heartbeat deadline, then expires after it stops",
    () =>
      run(({ service, store, lookedUp, addTime, setLookup }) =>
        Effect.gen(function* () {
          yield* service.acquire(caller, request);
          assert.deepEqual(lookedUp, []);
          addTime(3 * STALE_MS);
          const active = (yield* service.status()).lease!;
          assert.equal(active.state, "held");
          assert.deepEqual(lookedUp, [childThreadId]);
          assert.equal(
            active.heartbeatBy,
            DateTime.formatIso(DateTime.mapEpochMillis(at, (time) => time + 4 * STALE_MS)),
          );
          setLookup("idle");
          addTime(STALE_MS - 1);
          assert.equal((yield* service.status()).lease?.state, "held");
          addTime(1);
          assert.equal((yield* service.status()).lease?.state, "stopping");
          setLookup("running");
          addTime(QUIET_MS - 1);
          assert.equal((yield* service.status()).lease?.state, "stopping");
          assert.equal(store.currentLease()?.heartbeatAt, active.heartbeatAt);
          addTime(1);
          assert.isNull((yield* service.status()).lease);
        }),
      ),
  );

  it.effect.each(["idle", "waiting", "failed"] as const)(
    "preserves stale expiry when the projection is %s",
    (lookup) =>
      run(({ service, addTime, setLookup }) =>
        Effect.gen(function* () {
          const initial = yield* service.acquire(caller, request);
          setLookup(lookup);
          addTime(STALE_MS);
          const lease = (yield* service.status()).lease!;
          assert.equal(lease.state, "stopping");
          assert.equal(lease.heartbeatAt, initial.status.lease?.heartbeatAt);
        }),
      ),
  );

  it.effect(
    "quarantines old open calls even while the turn runs and preserves manual stopping",
    () =>
      run(({ service, store, addTime }) =>
        Effect.gen(function* () {
          const first = yield* service.acquire(caller, request);
          yield* service.callStart(caller, "hung");
          addTime(STALE_MS * 3);
          const stopped = (yield* service.release(caller, first.ticket)).lease!;
          assert.equal(stopped.state, "stopping");
          addTime(QUIET_MS - STALE_MS * 3);
          const quarantined = (yield* service.status()).lease!;
          assert.equal(quarantined.state, "quarantined");
          assert.equal(quarantined.heartbeatAt, stopped.heartbeatAt);
          addTime(STALE_MS);
          assert.equal((yield* service.callEnd("hung", "completed")).lease?.state, "quarantined");
          assert.equal((yield* service.release(caller, first.ticket)).lease?.state, "quarantined");
          assert.equal(store.currentLease()?.heartbeatAt, stopped.heartbeatAt);
          assert.isNull((yield* service.reconcile(first.ticket, "operator checked")).lease);
        }),
      ),
  );

  it.effect("quarantines an old open call while the holder stays running and held", () =>
    run(({ service, addTime }) =>
      Effect.gen(function* () {
        yield* service.acquire(caller, request);
        yield* service.callStart(caller, "old-open-call");
        addTime(QUIET_MS);
        assert.equal((yield* service.status()).lease?.state, "quarantined");
      }),
    ),
  );

  it.effect.each(["acquire", "heartbeat", "callStart", "callEnd"] as const)(
    "refreshes a running holder before %s",
    (operation) =>
      run(({ service, addTime }) =>
        Effect.gen(function* () {
          const first = yield* service.acquire(caller, request);
          yield* service.callStart(caller, "call");
          addTime(3 * STALE_MS);
          const status =
            operation === "acquire"
              ? (yield* service.acquire(caller, request)).status
              : operation === "heartbeat"
                ? yield* service.heartbeat(caller, first.ticket)
                : operation === "callStart"
                  ? yield* service.callStart(caller, "next-call")
                  : yield* service.callEnd("call", "completed");
          assert.equal(status.lease?.state, "held");
        }),
      ),
  );
});
