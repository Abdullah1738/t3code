import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  ProviderThreadId,
  RunId,
  RunAttemptId,
  ThreadId,
  TurnItemId,
  type ApplicationStoredEvent,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as Sqlite from "../persistence/Sqlite.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

const threadId = ThreadId.make("thread:phases");
const now = DateTime.makeUnsafe("2026-11-12T12:00:00.000Z");
const instanceId = ProviderInstanceId.make("codex");
const created = {
  id: EventId.make("event:created"),
  type: "thread.created",
  threadId,
  occurredAt: now,
  payload: {
    id: threadId,
    projectId: ProjectId.make("project:phases"),
    title: "Phases",
    createdBy: "user",
    creationSource: "web",
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "gpt-6.1-sol" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  },
} satisfies OrchestrationV2DomainEvent;
const item = (index: number) =>
  ({
    id: EventId.make(`event:item:${index}`),
    type: "turn-item.updated",
    threadId,
    occurredAt: now,
    payload: {
      id: TurnItemId.make(`item:${index}`),
      threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: index,
      status: "completed",
      title: "item",
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      type: "command_execution",
      input: "pwd",
    },
  }) satisfies OrchestrationV2DomainEvent;

const stores = Layer.mergeAll(
  EventStore.layer,
  ProjectionStore.layer,
  CommandReceiptStore.layer,
  EffectOutbox.layer,
  ProjectStore.layer,
  TurnItemPositionStore.layer,
).pipe(Layer.provideMerge(Sqlite.layerMemory));

const testLayer = (
  hooks: {
    append?: Effect.Effect<void>;
    project?: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
    outbox?: Effect.Effect<void>;
    normalize?: Effect.Effect<void>;
    publish?: (events: ReadonlyArray<ApplicationStoredEvent>) => Effect.Effect<void>;
  } = {},
) => {
  const decorated = Layer.mergeAll(
    Layer.effect(
      EventStore.EventStoreV2,
      Effect.map(EventStore.EventStoreV2, (store) => ({
        ...store,
        append: (input) => (hooks.append ?? Effect.void).pipe(Effect.andThen(store.append(input))),
        publishCommitted: (events) =>
          (hooks.publish?.(events) ?? Effect.void).pipe(
            Effect.andThen(store.publishCommitted(events)),
          ),
      })),
    ),
    Layer.effect(
      ProjectionStore.ProjectionStoreV2,
      Effect.map(ProjectionStore.ProjectionStoreV2, (store) => ({
        ...store,
        apply: (event) =>
          (hooks.project?.(event) ?? Effect.void).pipe(Effect.andThen(store.apply(event))),
      })),
    ),
    Layer.effect(
      EffectOutbox.EffectOutboxV2,
      Effect.map(EffectOutbox.EffectOutboxV2, (store) => ({
        ...store,
        enqueue: (effects) =>
          (hooks.outbox ?? Effect.void).pipe(Effect.andThen(store.enqueue(effects))),
      })),
    ),
    Layer.effect(
      TurnItemPositionStore.TurnItemPositionStoreV2,
      Effect.map(TurnItemPositionStore.TurnItemPositionStoreV2, (store) => ({
        ...store,
        normalize: (value, ordinal) =>
          (hooks.normalize ?? Effect.void).pipe(Effect.andThen(store.normalize(value, ordinal))),
      })),
    ),
  ).pipe(Layer.provideMerge(stores));
  return EventSink.layerFromStores.pipe(Layer.provideMerge(decorated));
};

const capture = () => {
  const spans: Array<Tracer.Span> = [];
  const logs: Array<unknown> = [];
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  const logger = Logger.make(({ message, logLevel }) => {
    if (logLevel === "Warn") logs.push(message);
  });
  return { spans, logs, tracer, logger };
};
const phase = (span: Tracer.Span, name: string) =>
  span.attributes.get(`orchestration_v2.phase.${name}`);
const writeSpans = (spans: ReadonlyArray<Tracer.Span>) =>
  spans.filter((span) => span.name === "orchestrationV2.EventSink.write");

it.effect(
  "records each phase and the slowest event on the enclosing span with body tracing disabled",
  () => {
    const trace = capture();
    return Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      yield* sink.write({ events: [created, item(1), item(2)] });
      const span = writeSpans(trace.spans)[0]!;
      assert.equal(phase(span, "normalize_ms"), 14);
      assert.equal(phase(span, "append_ms"), 11);
      assert.equal(phase(span, "project_ms"), 27);
      assert.equal(phase(span, "outbox_ms"), 17);
      assert.equal(phase(span, "lane_wait_ms"), 0);
      assert.equal(phase(span, "tx_ms"), 69);
      assert.equal(phase(span, "slowest_project_type"), "turn-item.updated");
      assert.equal(phase(span, "slowest_project_ms"), 13);
      assert.equal(
        span.attributes.get("orchestration_v2.event_types"),
        "thread.created,turn-item.updated",
      );
      assert.isFalse(trace.spans.some((span) => span.name === "orchestrationV2.EventStore.append"));
      assert.lengthOf(trace.logs, 0);
    }).pipe(
      Effect.provide(
        testLayer({
          normalize: TestClock.adjust(7),
          append: TestClock.adjust(11),
          project: (event) => TestClock.adjust(event.type === "thread.created" ? 1 : 13),
          outbox: TestClock.adjust(17),
        }),
      ),
      Effect.withTracer(trace.tracer),
      Effect.provide(Logger.layer([trace.logger])),
    );
  },
);

it.effect(
  "attributes time waiting for the previous publisher to the lane, excluding its own publication",
  () =>
    Effect.gen(function* () {
      const publishing = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const secondEnqueue = yield* Deferred.make<void>();
      const trace = capture();
      let enqueues = 0;
      yield* Effect.gen(function* () {
        const sink = yield* EventSink.EventSinkV2;
        const first = yield* sink.write({ events: [created] }).pipe(Effect.forkChild);
        yield* Deferred.await(publishing);
        const second = yield* sink.write({ events: [item(1)] }).pipe(Effect.forkChild);
        yield* Deferred.await(secondEnqueue);
        yield* TestClock.adjust(250);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        const [firstSpan, secondSpan] = writeSpans(trace.spans);
        assert.equal(phase(firstSpan!, "lane_wait_ms"), 0);
        assert.equal(phase(firstSpan!, "tx_ms"), 0);
        assert.equal(phase(secondSpan!, "lane_wait_ms"), 250);
        assert.equal(phase(secondSpan!, "tx_ms"), 250);
        assert.lengthOf(trace.logs, 0);
      }).pipe(
        Effect.provide(
          testLayer({
            publish: (events) =>
              events[0] !== undefined &&
              "event" in events[0] &&
              events[0].event.type === "thread.created"
                ? Deferred.succeed(publishing, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                  )
                : Effect.void,
            outbox: Effect.suspend(() =>
              ++enqueues === 2
                ? Deferred.succeed(secondEnqueue, undefined).pipe(Effect.asVoid)
                : Effect.void,
            ),
          }),
        ),
        Effect.withTracer(trace.tracer),
        Effect.provide(Logger.layer([trace.logger])),
      );
    }),
);

it.effect(
  "retains failure timings and rolls back events, projections and receipts without publishing",
  () => {
    const trace = capture();
    const published: Array<ApplicationStoredEvent> = [];
    return Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const store = yield* EventStore.EventStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const result = yield* sink
        .commitCommand({
          commandId: CommandId.make("command:rollback"),
          threadId,
          commandType: "test",
          acceptedAt: now,
          events: [created],
          effects: [],
        })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(result));
      assert.lengthOf(published, 0);
      assert.deepEqual(Array.from(yield* store.read().pipe(Stream.runCollect)), []);
      assert.deepEqual(yield* sql`SELECT * FROM orchestration_v2_projection_threads`, []);
      assert.deepEqual(yield* sql`SELECT * FROM orchestration_v2_command_receipts`, []);
      const span = trace.spans.find(
        (span) => span.name === "orchestrationV2.EventSink.commitCommand",
      )!;
      assert.equal(phase(span, "outbox_ms"), 5_001);
      assert.equal(phase(span, "tx_ms"), 5_001);
      assert.equal(phase(span, "slowest_project_type"), "thread.created");
      assert.lengthOf(trace.logs, 1);
      assert.deepEqual(trace.logs[0], [
        "Slow EventSink transaction",
        Object.fromEntries(
          [...span.attributes].filter(
            ([key]) =>
              key.startsWith("orchestration_v2.phase.") || key === "orchestration_v2.event_types",
          ),
        ),
      ]);
    }).pipe(
      Effect.provide(
        testLayer({
          outbox: TestClock.adjust(5_001).pipe(Effect.andThen(Effect.die("enqueue failed"))),
          publish: (events) =>
            Effect.sync(() => {
              published.push(...events);
            }),
        }),
      ),
      Effect.withTracer(trace.tracer),
      Effect.provide(Logger.layer([trace.logger])),
    );
  },
);

it.effect.each([5_000, 5_001])(
  "warns once only when a successful transaction exceeds 5 seconds (%i ms)",
  (ms) => {
    const trace = capture();
    return Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      yield* sink.write({ events: [created] });
      const span = writeSpans(trace.spans)[0]!;
      assert.equal(phase(span, "tx_ms"), ms);
      assert.equal(phase(span, "append_ms"), ms);
      assert.lengthOf(trace.logs, ms > 5_000 ? 1 : 0);
    }).pipe(
      Effect.provide(testLayer({ append: TestClock.adjust(ms) })),
      Effect.withTracer(trace.tracer),
      Effect.provide(Logger.layer([trace.logger])),
    );
  },
);

it.effect("a broken diagnostic logger cannot suppress publication after commit", () => {
  const published: Array<ApplicationStoredEvent> = [];
  const logger = Logger.make(() => {
    throw new Error("logger unavailable");
  });
  return Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const committed = yield* sink
      .write({ events: [created] })
      .pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
    assert.deepEqual(published, [...committed]);
  }).pipe(
    Effect.provide(
      testLayer({
        append: TestClock.adjust(5_001),
        publish: (events) =>
          Effect.sync(() => {
            published.push(...events);
          }),
      }),
    ),
  );
});

it.effect("writer acquisition time is excluded from transaction time", () =>
  Effect.gen(function* () {
    const inside = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const started = yield* Deferred.make<void>();
    const trace = capture();
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const sink = yield* EventSink.EventSinkV2;
      const holder = yield* sql
        .withTransaction(
          Deferred.succeed(inside, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(inside);
      const writer = yield* Deferred.succeed(started, undefined).pipe(
        Effect.andThen(sink.write({ events: [created] })),
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      yield* TestClock.adjust(9_000);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      yield* Fiber.join(writer);
      assert.equal(phase(writeSpans(trace.spans)[0]!, "tx_ms"), 0);
      assert.lengthOf(trace.logs, 0);
    }).pipe(
      Effect.provide(testLayer()),
      Effect.withTracer(trace.tracer),
      Effect.provide(Logger.layer([trace.logger])),
    );
  }),
);

it.effect(
  "instruments project writes, command writes, and each conditional write entry point",
  () => {
    const trace = capture();
    return Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const projectId = ProjectId.make("project:phases");
      const providerThreadId = ProviderThreadId.make("provider-thread:missing");
      const runId = RunId.make("run:missing");
      const activeAttemptId = RunAttemptId.make("attempt:missing");
      yield* sink.commitProjectCommand({
        commandId: CommandId.make("command:project"),
        projectId,
        commandType: "project.create",
        acceptedAt: now,
        event: {
          eventId: EventId.make("event:project"),
          aggregateKind: "project",
          aggregateId: projectId,
          type: "project.created",
          occurredAt: DateTime.formatIso(now),
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: {
            projectId,
            title: "Phases",
            workspaceRoot: "/tmp/phases",
            defaultModelSelection: null,
            scripts: [],
            createdAt: DateTime.formatIso(now),
            updatedAt: DateTime.formatIso(now),
          },
        },
      });
      yield* sink.commitCommand({
        commandId: CommandId.make("command:thread"),
        threadId,
        commandType: "thread.create",
        acceptedAt: now,
        events: [created],
        effects: [],
      });
      yield* sink.writeIfRunCurrent({
        threadId,
        runId,
        activeAttemptId,
        expectedStatus: "running",
        events: [],
      });
      yield* sink.writeIfProviderThreadOwner({
        providerThreadId,
        runId,
        activeAttemptId,
        expectedLastRunOrdinal: 1,
        events: [],
      });
      yield* sink.writeIfProviderThreadUnchanged({
        expected: {
          id: providerThreadId,
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: instanceId,
          providerSessionId: null,
          appThreadId: threadId,
          ownerNodeId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        },
        events: [],
      });
      const spans = trace.spans.filter((span) =>
        span.name.startsWith("orchestrationV2.EventSink."),
      );
      assert.lengthOf(spans, 5);
      for (const span of spans) {
        for (const name of [
          "normalize",
          "append",
          "project",
          "outbox",
          "lane_wait",
          "tx",
          "slowest_project",
        ]) {
          assert.isNumber(phase(span, `${name}_ms`));
        }
      }
      const projectSpan = spans[0]!;
      assert.equal(projectSpan.attributes.get("orchestration_v2.event_types"), "project.created");
      assert.equal(phase(projectSpan, "slowest_project_type"), "project.created");
      assert.equal(spans.at(-1)!.attributes.get("orchestration_v2.event_types"), "");
    }).pipe(Effect.provide(testLayer()), Effect.withTracer(trace.tracer));
  },
);

it.effect("freezes transaction duration before post-commit reporting can be delayed", () => {
  const trace = capture();
  let reportingDelay = 0n;
  const tracer = Tracer.make({
    span(options) {
      const span = trace.tracer.span(options);
      const attribute = span.attribute.bind(span);
      span.attribute = (key, value) => {
        // This existing annotation runs after the transaction's scheduler guard is restored.
        if (key === "orchestration_v2.transaction_ms") reportingDelay += 9_000_000_000n;
        attribute(key, value);
      };
      return span;
    },
  });
  return Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    const sink = yield* EventSink.EventSinkV2;
    yield* sink.write({ events: [created] }).pipe(
      Effect.provideService(Clock.Clock, {
        ...clock,
        monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe() + reportingDelay,
      }),
    );
    assert.equal(reportingDelay, 9_000_000_000n);
    assert.equal(phase(writeSpans(trace.spans)[0]!, "tx_ms"), 0);
    assert.lengthOf(trace.logs, 0);
  }).pipe(
    Effect.provide(testLayer()),
    Effect.withTracer(tracer),
    Effect.provide(Logger.layer([trace.logger])),
  );
});
