import { assert, it } from "@effect/vitest";
import {
  NodeId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  type OrchestrationV2ExecutionNode,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlError from "effect/sql/SqlError";
import * as TestClock from "effect/testing/TestClock";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as EventSink from "./EventSink.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

// ardud (9 Nov): when the statev2 reader was retired, every queued read failed,
// including this one in a live turn's event pump, which failed the turn.
const driver = ProviderDriverKind.make("claudeAgent");
const threadId = ThreadId.make("thread:transient-read");

const readFailure = (message: string) =>
  new SqlError.SqlError({
    reason: new SqlError.UnknownError({
      cause: new Error(message),
      message: "Failed to execute statement",
      operation: "execute",
    }),
  });

const makeLayer = (input: {
  readonly reads: Ref.Ref<number>;
  readonly writes: Ref.Ref<number>;
  readonly failFirst: number;
  readonly message: string;
}) =>
  ProviderEventIngestor.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          isNodeStored: () =>
            Ref.getAndUpdate(input.reads, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                count < input.failFirst
                  ? Effect.fail(
                      new ProjectionStore.ProjectionStoreReadError({
                        threadId,
                        cause: readFailure(input.message),
                      }),
                    )
                  : Effect.succeed(false),
              ),
            ),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          write: (payload) =>
            Ref.update(input.writes, (count) => count + payload.events.length).pipe(Effect.as([])),
        }),
        Layer.mock(GitVcsDriver.GitVcsDriver)({}),
        Layer.mock(ThreadCommandExecutor.ThreadCommandExecutor)({}),
        IdAllocator.layer,
      ),
    ),
  );

const ingestNode = Effect.gen(function* () {
  const now = yield* DateTime.now;
  const nodeId = NodeId.make("node:transient-read");
  const node: OrchestrationV2ExecutionNode = {
    id: nodeId,
    threadId,
    runId: null,
    parentNodeId: null,
    rootNodeId: nodeId,
    kind: "approval_request",
    status: "waiting",
    countsForRun: false,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    runtimeRequestId: null,
    checkpointScopeId: null,
    startedAt: now,
    completedAt: null,
  };
  const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
  return yield* ingestor.ingestNormalized({
    providerSessionId: ProviderSessionId.make("session:transient-read"),
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    threadId,
    event: { type: "node.updated", driver, node },
  });
});

it.effect("waits out a retired statev2 reader instead of failing the event", () =>
  Effect.gen(function* () {
    const reads = yield* Ref.make(0);
    const writes = yield* Ref.make(0);
    const fiber = yield* ingestNode.pipe(
      Effect.provide(
        makeLayer({
          reads,
          writes,
          failFirst: 3,
          message: "Database reader retired: a statement ran longer than 120000 ms",
        }),
      ),
      Effect.forkChild,
    );
    yield* TestClock.adjust("1 minute");
    const exit = yield* Fiber.await(fiber);
    assert.isTrue(Exit.isSuccess(exit));
    assert.equal(yield* Ref.get(reads), 4);
    assert.equal(yield* Ref.get(writes), 1);
  }),
);

it.effect("still fails at once on a read error that is not transient", () =>
  Effect.gen(function* () {
    const reads = yield* Ref.make(0);
    const writes = yield* Ref.make(0);
    const exit = yield* ingestNode.pipe(
      Effect.provide(makeLayer({ reads, writes, failFirst: 1, message: "no such column: x" })),
      Effect.exit,
    );
    assert.isTrue(Exit.isFailure(exit));
    assert.equal(yield* Ref.get(reads), 1);
    assert.equal(yield* Ref.get(writes), 0);
  }),
);

it.effect("gives up once the reader stays gone past the retry budget", () =>
  Effect.gen(function* () {
    const reads = yield* Ref.make(0);
    const writes = yield* Ref.make(0);
    const fiber = yield* ingestNode.pipe(
      Effect.provide(
        makeLayer({
          reads,
          writes,
          failFirst: Number.MAX_SAFE_INTEGER,
          message: "Reader lane unavailable",
        }),
      ),
      Effect.forkChild,
    );
    yield* TestClock.adjust("11 minutes");
    const exit = yield* Fiber.await(fiber);
    assert.isTrue(Exit.isFailure(exit));
    assert.equal(yield* Ref.get(writes), 0);
  }),
);

it.effect.each([
  { delegated: false, transient: true },
  { delegated: true, transient: true },
  { delegated: false, transient: false },
  { delegated: true, transient: false },
])(
  "#1711 retries acknowledgement lookup before persistence (delegated=$delegated transient=$transient)",
  ({ delegated, transient }) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const runId = RunId.make("run:ack-read");
      const nodeId = NodeId.make("node:ack-read");
      const messageId = MessageId.make("message:ack-read");
      let reads = 0;
      let writes = 0;
      const effects: EffectOutbox.PendingOrchestrationEffectV2[] = [];
      const write = (payload: Parameters<EventSink.EventSinkV2Shape["write"]>[0]) =>
        Effect.sync(() => {
          writes += payload.events.length;
          return [];
        });
      const layer = ProviderEventIngestor.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getRunMessage: () =>
                Effect.suspend(() => {
                  if (reads++ === 0)
                    return Effect.fail(
                      new ProjectionStore.ProjectionStoreReadError({
                        threadId,
                        cause: readFailure(
                          transient ? "Reader lane unavailable" : "no such column: x",
                        ),
                      }),
                    );
                  return Effect.succeed({
                    id: messageId,
                    threadId,
                    runId,
                    nodeId,
                    role: "user" as const,
                    text: "Task finished",
                    phase: "unknown" as const,
                    attachments: [],
                    streaming: false,
                    createdBy: "agent" as const,
                    creationSource: "server" as const,
                    createdAt: now,
                    updatedAt: now,
                    ...(delegated
                      ? {
                          delegatedCompletion: {
                            parentRunId: RunId.make("run:source"),
                            generation: 1,
                            taskIds: [nodeId],
                          },
                        }
                      : {}),
                  });
                }),
            }),
            Layer.mock(EventSink.EventSinkV2)({
              write,
              writeWithEffects: (payload) => {
                effects.push(...(payload.effects ?? []));
                return write(payload);
              },
            }),
            Layer.mock(GitVcsDriver.GitVcsDriver)({}),
            Layer.mock(ThreadCommandExecutor.ThreadCommandExecutor)({}),
            IdAllocator.layer,
          ),
        ),
      );
      const fiber = yield* Effect.gen(function* () {
        const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
        return yield* ingestor.ingestNormalized({
          providerSessionId: ProviderSessionId.make("session:ack-read"),
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          threadId,
          runId,
          nodeId,
          event: {
            type: "provider_turn.updated",
            driver,
            providerTurn: {
              id: ProviderTurnId.make("turn:ack-read"),
              providerThreadId: ProviderThreadId.make("provider-thread:ack-read"),
              nodeId,
              runAttemptId: null,
              nativeTurnRef: null,
              ordinal: 1,
              status: "running",
              startedAt: now,
              completedAt: null,
              promptAcceptedAt: now,
            },
          },
        });
      }).pipe(Effect.provide(layer), Effect.forkChild);
      yield* TestClock.adjust("1 minute");
      const exit = yield* Fiber.await(fiber);
      assert.equal(Exit.isSuccess(exit), transient);
      assert.equal(reads, transient ? 2 : 1);
      assert.equal(writes, transient ? 1 : 0);
      assert.deepEqual(
        effects,
        delegated && transient
          ? [EffectOutbox.nativeNoticeAcceptanceEffect(threadId, messageId)]
          : [],
      );
    }),
);
