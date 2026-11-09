import { assert, it } from "@effect/vitest";
import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
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
