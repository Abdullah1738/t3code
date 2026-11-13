import {
  CommandId,
  type OrchestrationV2Run,
  OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type ProviderSessionId,
  OrchestrationV2StoredEvent,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  NodeId,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Request from "effect/Request";
import * as RequestResolver from "effect/RequestResolver";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Scheduler from "effect/Scheduler";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SendAcknowledgement from "../ardud/orchestration/ThreadSendAcknowledgement.ts";

import { replayAndBufferProjectedLiveEvents } from "./LiveStreamBudget.ts";
import type { UnsequencedProjectEvent } from "../persistence/OrchestrationEventStore.ts";
import { projectDomainEventForWire } from "./WireProjection.ts";

import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

export class EventSinkWriteError extends Schema.TaggedError<EventSinkWriteError>()(
  "EventSinkWriteError",
  {
    eventCount: Schema.Number,
    commandId: Schema.optional(CommandId),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to write ${this.eventCount} orchestration V2 event(s).`;
  }
}

export class EventSinkStreamError extends Schema.TaggedError<EventSinkStreamError>()(
  "EventSinkStreamError",
  {
    threadId: Schema.optional(ThreadId),
    afterSequence: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.threadId === undefined
      ? "Failed to stream orchestration V2 events."
      : `Failed to stream orchestration V2 events for thread ${this.threadId}.`;
  }
}

export const EventSinkV2Error = Schema.Union([EventSinkWriteError, EventSinkStreamError]);
export type EventSinkV2Error = typeof EventSinkV2Error.Type;

export interface EventSinkV2Shape {
  /** Publish an already-committed maintenance rewrite to application and live thread subscribers. */
  readonly publishCommitted: (
    events: ReadonlyArray<OrchestrationV2StoredEvent>,
  ) => Effect.Effect<void>;
  readonly write: (input: {
    /** Restate still-bound canonical session rows inside the write transaction. */
    readonly refreshBoundProviderSessions?: true;
    /** Return no events if another thread owns this native session at commit time. */
    readonly unlessNativeThreadOwned?: Pick<
      OrchestrationV2ProviderThread,
      "driver" | "providerInstanceId" | "appThreadId" | "nativeThreadRef"
    >;
    readonly guardPendingUserInputCancellations?: boolean;
    readonly commandId?: CommandId;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  }) => Effect.Effect<ReadonlyArray<OrchestrationV2StoredEvent>, EventSinkV2Error>;
  readonly writeWithEffects: (input: {
    /** Restate still-bound canonical session rows inside the write transaction. */
    readonly refreshBoundProviderSessions?: true;
    /**
     * Rebuilds each run.updated from the stored row with only its delegatedCompletion replaced.
     * The batch must not also change that run's lifecycle.
     */
    readonly updateDelegatedCompletionOnly?: boolean;
    readonly unlessNativeThreadOwned?: Pick<
      OrchestrationV2ProviderThread,
      "driver" | "providerInstanceId" | "appThreadId" | "nativeThreadRef"
    >;
    readonly guardPendingUserInputCancellations?: boolean;
    readonly commandId?: CommandId;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
    readonly effects: ReadonlyArray<EffectOutbox.PendingOrchestrationEffectV2>;
  }) => Effect.Effect<ReadonlyArray<OrchestrationV2StoredEvent>, EventSinkV2Error>;
  readonly writeIfRunCurrent: (input: {
    readonly unlessClaudeRefused?: ProviderThreadId;
    readonly guardPendingUserInputCancellations?: boolean;
    readonly commandId?: CommandId;
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly activeAttemptId: RunAttemptId;
    readonly expectedStatus: OrchestrationV2Run["status"];
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
    readonly effects?: ReadonlyArray<EffectOutbox.PendingOrchestrationEffectV2>;
  }) => Effect.Effect<
    {
      readonly committed: boolean;
      readonly storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>;
    },
    EventSinkV2Error
  >;
  /**
   * Atomically commit only when the provider thread is still owned by the
   * expected run attempt and ordinal. Used for late post-terminal
   * provider_thread updates so a completed or superseded attempt cannot clobber
   * a newer attempt that already claimed the thread.
   */
  readonly writeIfProviderThreadOwner: (input: {
    readonly guardPendingUserInputCancellations?: boolean;
    readonly commandId?: CommandId;
    readonly providerThreadId: ProviderThreadId;
    readonly runId: RunId;
    readonly activeAttemptId: RunAttemptId;
    readonly expectedLastRunOrdinal: number;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  }) => Effect.Effect<
    {
      readonly committed: boolean;
      readonly storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>;
    },
    EventSinkV2Error
  >;
  /**
   * Atomically commit only while the stored provider thread still equals
   * `expected`, the row its writer read, so a read-modify-write of the row
   * cannot overwrite an update published in between. The whole row is
   * compared because not every writer moves `updatedAt`.
   */
  readonly writeIfProviderThreadUnchanged: (input: {
    readonly expected: OrchestrationV2ProviderThread;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  }) => Effect.Effect<
    {
      readonly committed: boolean;
      readonly storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>;
    },
    EventSinkV2Error
  >;
  readonly commitCommand: (input: {
    readonly commandId: CommandId;
    readonly threadId: ThreadId;
    readonly commandType: string;
    readonly acceptedAt: DateTime.Utc;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
    readonly effects: ReadonlyArray<EffectOutbox.PendingOrchestrationEffectV2>;
    readonly cancelUnsettledEffects?: {
      readonly effectTypes: ReadonlyArray<EffectOutbox.OrchestrationEffectRequestV2["type"]>;
      readonly reason: string;
    };
    /**
     * ardud: runs inside the write transaction before any event is appended.
     * A failure rolls the command back and comes out as the write error's cause.
     */
    readonly recheck?: Effect.Effect<void, unknown>;
  }) => Effect.Effect<
    {
      readonly receipt: CommandReceiptStore.CommandReceiptV2;
      readonly storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>;
      readonly committed: boolean;
      readonly cancelledEffectCount: number;
    },
    EventSinkV2Error
  >;
  readonly commitRejectedCommand: (input: {
    readonly commandId: CommandId;
    readonly threadId: ThreadId;
    readonly commandType: string;
    readonly rejectedAt: DateTime.Utc;
    readonly error: string;
  }) => Effect.Effect<CommandReceiptStore.CommandReceiptV2, EventSinkV2Error>;
  readonly commitProjectCommand: (input: {
    readonly commandId: CommandId;
    readonly projectId: ProjectId;
    readonly commandType: string;
    readonly acceptedAt: DateTime.Utc;
    readonly event: UnsequencedProjectEvent;
  }) => Effect.Effect<
    { readonly receipt: CommandReceiptStore.ProjectCommandReceiptV2; readonly committed: boolean },
    EventSinkV2Error
  >;
  readonly commitRejectedProjectCommand: (input: {
    readonly commandId: CommandId;
    readonly projectId: ProjectId;
    readonly commandType: string;
    readonly rejectedAt: DateTime.Utc;
    readonly error: string;
  }) => Effect.Effect<CommandReceiptStore.ProjectCommandReceiptV2, EventSinkV2Error>;
  readonly stream: (input?: {
    readonly threadId?: ThreadId;
    readonly afterSequence?: number;
    readonly eventType?: OrchestrationV2DomainEvent["type"];
    /** Bound RPC subscribers; internal workers must not drop their subscription under load. */
    readonly bounded?: boolean;
  }) => Stream.Stream<OrchestrationV2StoredEvent, EventSinkV2Error>;
  readonly latestSequence: (input?: {
    readonly threadId?: ThreadId;
  }) => Effect.Effect<number, EventSinkV2Error>;
  readonly readByCommandId: (input: {
    readonly commandId: CommandId;
  }) => Stream.Stream<OrchestrationV2StoredEvent, EventSinkV2Error>;
}

export class EventSinkV2 extends Context.Service<EventSinkV2, EventSinkV2Shape>()(
  "t3/orchestration-v2/EventSink/EventSinkV2",
) {}

// Only ordinary writes join a batch. Conditional and acknowledged commands keep
// their own transaction, and callers already in a transaction stay on its connection.
const WriteBatch = Context.Reference<
  { readonly publications: Array<Effect.Effect<void>> } | undefined
>("t3/orchestration-v2/EventSink/WriteBatch", { defaultValue: () => undefined });

interface QueuedWrite extends Request.Request<ReadonlyArray<OrchestrationV2StoredEvent>, unknown> {
  readonly isCancelled: () => boolean;
  readonly input: Parameters<EventSinkV2Shape["writeWithEffects"]>[0];
}
const QueuedWrite = Request.of<QueuedWrite>();

type WritePhase = "normalize" | "append" | "project" | "outbox" | "lane_wait";

interface WriteTiming {
  readonly measure: <A, E, R>(
    phase: WritePhase,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly projectEvent: <A, E, R>(
    type: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

const layerBase: Layer.Layer<
  EventSinkV2,
  never,
  | CommandReceiptStore.CommandReceiptStoreV2
  | EffectOutbox.EffectOutboxV2
  | EventStore.EventStoreV2
  | ProjectionStore.ProjectionStoreV2
  | ProjectStore.ProjectStoreV2
  | SqlClient.SqlClient
  | TurnItemPositionStore.TurnItemPositionStoreV2
> = Layer.effect(
  EventSinkV2,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const commandReceipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
    const effectOutbox = yield* EffectOutbox.EffectOutboxV2;
    const eventStore = yield* EventStore.EventStoreV2;
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const projectStore = yield* ProjectStore.ProjectStoreV2;
    const turnItemPositions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
    const liveEvents = yield* PubSub.unbounded<OrchestrationV2StoredEvent>();
    const liveEventsByType = new Map<
      OrchestrationV2DomainEvent["type"],
      PubSub.PubSub<OrchestrationV2StoredEvent>
    >();
    const publishLiveEvents =
      /* This helper runs for individual orchestration events; the enclosing operation owns the span. */
      Effect.fnUntraced(function* (events: ReadonlyArray<OrchestrationV2StoredEvent>) {
        yield* PubSub.publishAll(liveEvents, events);
        for (const [type, pubsub] of liveEventsByType) {
          yield* PubSub.publishAll(
            pubsub,
            events.filter((stored) => stored.event.type === type),
          );
        }
      });
    const publishStoredEvents = (events: ReadonlyArray<OrchestrationV2StoredEvent>) =>
      eventStore.publishCommitted(events).pipe(Effect.andThen(publishLiveEvents(events)));

    // Transactions commit one at a time, but each writer publishes after its
    // commit. If a writer is descheduled in between, a later commit reaches
    // subscribers first, and clients drop any event at or below the newest
    // sequence they have applied.
    const publishLane = yield* Semaphore.make(1);
    // The caller owns the write span; phase timers must not create child spans.
    const commitThenPublish = Effect.fnUntraced(function* <A, E, R>(
      events: ReadonlyArray<{ readonly type: string }>,
      transaction: (timing: WriteTiming) => Effect.Effect<A, E, R>,
      publish: (committed: A) => Effect.Effect<void>,
      acceptance?: {
        readonly check: () => boolean;
        readonly prepare: (value: A) => () => void;
      },
    ) {
      const batch = yield* WriteBatch;
      const clock = yield* Clock.Clock;
      const now = () => clock.monotonicTimeNanosUnsafe();
      const elapsed = (start: bigint) => Number(now() - start) / 1_000_000;
      const phases = { normalize: 0, append: 0, project: 0, outbox: 0, lane_wait: 0 };
      let slowestProjectType = "";
      let slowestProjectMs = 0;
      // These timers run with tracing disabled; only the enclosing write span is annotated.
      const measure: WriteTiming["measure"] = (phase, effect) =>
        Effect.suspend(() => {
          const start = now();
          return effect.pipe(
            Effect.ensuring(
              Effect.sync(() => {
                phases[phase] += elapsed(start);
              }),
            ),
          );
        });
      const timing: WriteTiming = {
        measure,
        projectEvent: (type, effect) =>
          Effect.suspend(() => {
            const start = now();
            return effect.pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  const ms = elapsed(start);
                  if (slowestProjectType === "" || ms > slowestProjectMs) {
                    slowestProjectType = type;
                    slowestProjectMs = ms;
                  }
                }),
              ),
            );
          }),
      };
      let holdsLane = false;
      let txStart: bigint | undefined;
      let txMs = 0;
      const takeLane = measure(
        "lane_wait",
        publishLane.take(1).pipe(
          Effect.andThen(
            Effect.sync(() => {
              holdsLane = true;
            }),
          ),
          Effect.uninterruptible,
        ),
      );
      const report = Effect.suspend(() => {
        const eventTypes = new Set<string>();
        for (const event of events) {
          eventTypes.add(event.type);
          if (eventTypes.size === 10) break;
        }
        const fields = {
          "orchestration_v2.phase.normalize_ms": phases.normalize,
          "orchestration_v2.phase.append_ms": phases.append,
          "orchestration_v2.phase.project_ms": phases.project,
          "orchestration_v2.phase.outbox_ms": phases.outbox,
          "orchestration_v2.phase.lane_wait_ms": phases.lane_wait,
          "orchestration_v2.phase.tx_ms": txMs,
          "orchestration_v2.event_types": [...eventTypes].join(","),
          "orchestration_v2.phase.slowest_project_type": slowestProjectType,
          "orchestration_v2.phase.slowest_project_ms": slowestProjectMs,
        };
        return Effect.annotateCurrentSpan(fields).pipe(
          Effect.andThen(
            txMs > 5_000 ? Effect.logWarning("Slow EventSink transaction", fields) : Effect.void,
          ),
        );
      });
      const started = performance.now();
      let accepted: (() => void) | undefined;
      const body = Effect.suspend(() => {
        txStart = now();
        return transaction(timing).pipe(
          Effect.tap(() => (batch === undefined ? takeLane : Effect.void)),
          Effect.tap((value) =>
            Effect.suspend(() => {
              // The lane wait is masked. A timed-out sender must roll back when it resumes.
              if (acceptance !== undefined && !acceptance.check()) return Effect.interrupt;
              return Effect.sync(() => {
                accepted = acceptance?.prepare(value);
              });
            }),
          ),
        );
      });
      return yield* (batch === undefined ? sql.withTransaction(body) : body).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            // Capture before restoring scheduler yields, so a descheduled reporter cannot
            // inflate the writer hold. db.lock_wait_ms already records acquisition.
            txMs = txStart === undefined ? 0 : elapsed(txStart);
          }),
        ),
        // Keep synchronous writer work from yielding behind the saturated run queue.
        // A real wait (including the publish lane) still suspends.
        Effect.provideService(Scheduler.PreventSchedulerYield, true),
        Effect.provideService(
          NodeSqliteClient.TransactionCommitObserver,
          acceptance === undefined
            ? undefined
            : () => {
                accepted?.();
              },
        ),
        Effect.tap(() =>
          Effect.annotateCurrentSpan(
            "orchestration_v2.transaction_ms",
            Math.round(performance.now() - started),
          ),
        ),
        // Diagnostics must not suppress publication after a successful commit.
        Effect.ensuring(report.pipe(Effect.ignoreCause)),
        Effect.tap((value) =>
          batch === undefined
            ? publish(value)
            : Effect.sync(() => {
                batch.publications.push(publish(value));
              }),
        ),
        Effect.ensuring(Effect.suspend(() => (holdsLane ? publishLane.release(1) : Effect.void))),
      );
    });

    // A user can answer after terminal normalization reads the pending request.
    // Recheck inside the write transaction so stale cleanup cannot erase answers.
    const guardUserInputCancellations =
      /* This helper runs for individual orchestration events; the enclosing operation owns the span. */
      Effect.fnUntraced(function* (events: ReadonlyArray<OrchestrationV2DomainEvent>) {
        const staleRequests = new Set<RuntimeRequestId>();
        const staleNodes = new Set<NodeId>();
        for (const event of events) {
          if (
            event.type !== "runtime-request.updated" ||
            event.payload.kind !== "user_input" ||
            event.payload.status !== "cancelled"
          )
            continue;
          const current = yield* projectionStore.getRuntimeRequest(
            event.threadId,
            event.payload.id,
          );
          if (
            current?.status !== "pending" ||
            current.kind !== "user_input" ||
            current.providerTurnId !== event.payload.providerTurnId ||
            current.responseCapability.type === "message"
          ) {
            staleRequests.add(event.payload.id);
            staleNodes.add(event.payload.nodeId);
          }
        }
        return events.filter((event) => {
          switch (event.type) {
            case "runtime-request.updated":
              return event.payload.status !== "cancelled" || !staleRequests.has(event.payload.id);
            case "node.updated":
              return event.payload.status !== "cancelled" || !staleNodes.has(event.payload.id);
            case "turn-item.updated":
              return (
                event.payload.type !== "user_input_request" ||
                event.payload.status !== "cancelled" ||
                !staleRequests.has(event.payload.requestId)
              );
            default:
              return true;
          }
        });
      });

    const normalizeEvents = (events: ReadonlyArray<OrchestrationV2DomainEvent>) => {
      const providerSessions = new Map<
        ProviderThreadId,
        {
          native_id: string | null;
          instance_id: string;
          driver: string;
          refused: number;
        }
      >();
      const runOrdinals = new Map(
        events.flatMap((event) =>
          event.type === "run.created" || event.type === "run.updated"
            ? [[event.payload.id, event.payload.ordinal] as const]
            : [],
        ),
      );
      return Effect.forEach(
        events,
        (event): Effect.Effect<OrchestrationV2DomainEvent, unknown> =>
          Effect.gen(function* () {
            if (event.type === "provider-thread.updated") {
              const incoming = event.payload;
              if (incoming.driver !== "claudeAgent") {
                providerSessions.set(incoming.id, {
                  native_id: incoming.nativeThreadRef?.nativeId ?? null,
                  instance_id: incoming.providerInstanceId,
                  driver: incoming.driver,
                  refused: 0,
                });
                return event;
              }
              const prior =
                providerSessions.get(incoming.id) ??
                (yield* sql<{
                  native_id: string | null;
                  instance_id: string;
                  driver: string;
                  refused: number;
                }>`SELECT
              json_extract(payload_json, '$.nativeThreadRef.nativeId') AS native_id,
              provider_instance_id AS instance_id, driver,
              COALESCE(json_extract(payload_json, '$.nativeMetadata.claudeRefusalObserved'), 0) AS refused
              FROM orchestration_v2_projection_provider_threads
              WHERE provider_thread_id = ${incoming.id} LIMIT 1`)[0];
              const nativeId = incoming.nativeThreadRef?.nativeId ?? null;
              // A queued pre-refusal snapshot must not erase durable history for
              // the same native Claude session. A new native identity starts fresh.
              const preserve =
                incoming.driver === "claudeAgent" &&
                nativeId !== null &&
                prior?.driver === incoming.driver &&
                prior.instance_id === incoming.providerInstanceId &&
                prior.native_id === nativeId &&
                prior.refused === 1;
              const payload = preserve
                ? {
                    ...incoming,
                    nativeMetadata: { ...incoming.nativeMetadata, claudeRefusalObserved: true },
                  }
                : incoming;
              providerSessions.set(incoming.id, {
                native_id: nativeId,
                instance_id: incoming.providerInstanceId,
                driver: incoming.driver,
                refused: payload.nativeMetadata?.claudeRefusalObserved === true ? 1 : 0,
              });
              return { ...event, payload };
            }
            return event.type === "turn-item.updated"
              ? yield* turnItemPositions
                  .normalize(
                    event.payload,
                    event.payload.runId === null ? undefined : runOrdinals.get(event.payload.runId),
                  )
                  .pipe(Effect.map((payload) => ({ ...event, payload })))
              : event;
          }),
        { concurrency: 1 },
      );
    };

    const applyStoredEvents =
      /* This helper runs for individual orchestration events; the enclosing operation owns the span. */
      Effect.fnUntraced(function* (
        storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>,
        timing: WriteTiming,
      ) {
        yield* Effect.forEach(
          storedEvents,
          (stored) => timing.projectEvent(stored.event.type, projectionStore.apply(stored.event)),
          {
            concurrency: 1,
          },
        );
        const sequence = storedEvents.at(-1)?.sequence;
        if (sequence !== undefined) {
          const now = DateTime.formatIso(yield* DateTime.now);
          yield* sql`
            INSERT INTO orchestration_v2_projection_metadata (
              projection_name,
              schema_version,
              last_sequence,
              updated_at
            )
            VALUES (
              'thread-projections',
              ${ProjectionStore.ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION},
              ${sequence},
              ${now}
            )
            ON CONFLICT(projection_name)
            DO UPDATE SET
              schema_version = excluded.schema_version,
              last_sequence = excluded.last_sequence,
              updated_at = excluded.updated_at
          `;
        }
      });

    const writeDirect = Effect.fn("orchestrationV2.EventSink.write")(function* (
      input: Parameters<EventSinkV2Shape["writeWithEffects"]>[0],
      isCancelled?: () => boolean,
    ) {
      yield* Effect.annotateCurrentSpan({
        "orchestration_v2.command_id": input.commandId ?? null,
        "orchestration_v2.event_count": input.events.length,
        "orchestration_v2.thread_id": input.events[0]?.threadId ?? null,
        // ardud: names the write when a long writer hold shows up in a trace.
        "orchestration_v2.event_types": [...new Set(input.events.map((event) => event.type))].join(
          ",",
        ),
      });

      return yield* commitThenPublish(
        input.events,
        (timing) =>
          Effect.gen(function* () {
            let sourceEvents = input.events;
            if (input.refreshBoundProviderSessions === true) {
              const requests = input.events.filter(
                (
                  event,
                ): event is Extract<
                  OrchestrationV2DomainEvent,
                  { type: "provider-session.attached" | "provider-session.updated" }
                > => event.type === "provider-session.updated",
              );
              if (
                requests.length !== input.events.length ||
                input.effects.length > 0 ||
                input.unlessNativeThreadOwned !== undefined ||
                input.guardPendingUserInputCancellations !== undefined ||
                input.updateDelegatedCompletionOnly !== undefined
              ) {
                return yield* new EventSinkWriteError({
                  eventCount: input.events.length,
                  ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                  cause: "Session refresh cannot include other events, effects or write guards.",
                });
              }
              // The preflight payload only identifies a binding. A read outside this
              // transaction could overwrite a newer status or resurrect a detached session.
              const recordsByThread = new Map(
                yield* Effect.forEach(
                  new Set(requests.map((event) => event.threadId)),
                  (threadId) =>
                    projectionStore.getThreadRecords(threadId, ["providerSessions"]).pipe(
                      Effect.catchIf(
                        Schema.is(ProjectionStore.ProjectionStoreThreadNotFoundError),
                        () => Effect.succeed(undefined),
                      ),
                      Effect.map((records) => [threadId, records] as const),
                    ),
                  { concurrency: 1 },
                ),
              );
              const seenByThread = new Map<ThreadId, Set<ProviderSessionId>>();
              const refreshed: Array<OrchestrationV2DomainEvent> = [];
              const occurredAt = yield* DateTime.now;
              for (const event of requests) {
                const seen = seenByThread.get(event.threadId) ?? new Set<ProviderSessionId>();
                if (seen.has(event.payload.id)) continue;
                seen.add(event.payload.id);
                seenByThread.set(event.threadId, seen);
                const records = recordsByThread.get(event.threadId);
                if (
                  records === undefined ||
                  records.thread.deletedAt !== null ||
                  records.thread.archivedAt !== null
                )
                  continue;
                const session = records.providerSessions.find(
                  (session) => session.id === event.payload.id,
                );
                if (
                  session?.driver !== "opencode" ||
                  !session.capabilities.sessions.supportsMultipleProviderThreadsPerSession
                )
                  continue;
                refreshed.push({
                  ...event,
                  payload: session,
                  driver: session.driver,
                  providerInstanceId: session.providerInstanceId,
                  occurredAt,
                });
              }
              sourceEvents = refreshed;
              if (sourceEvents.length === 0) return [];
            }
            // Check ownership in the same transaction that claims the native session.
            const imported = input.unlessNativeThreadOwned;
            if (imported?.nativeThreadRef != null) {
              const owners = yield* sql`
              SELECT provider_thread_id
              FROM orchestration_v2_projection_provider_threads
              WHERE driver = ${imported.driver}
                AND provider_instance_id = ${imported.providerInstanceId}
                AND thread_id IS NOT ${imported.appThreadId}
                AND json_extract(payload_json, '$.nativeThreadRef.nativeId') = ${imported.nativeThreadRef.nativeId}
              LIMIT 1
            `;
              if (owners.length > 0) return [];
            }
            // Checkpoint capture can finish after a cohort writer reads its parent run.
            // Merge in this transaction so the event log and projection keep that completion.
            const events = input.updateDelegatedCompletionOnly
              ? yield* Effect.forEach(sourceEvents, (event) =>
                  Effect.gen(function* () {
                    if (event.type !== "run.updated") return event;
                    const { runs } = yield* projectionStore.getThreadRecords(
                      event.threadId,
                      ["runs"],
                      { runIds: [event.payload.id] },
                    );
                    const current = runs[0];
                    return current === undefined
                      ? event
                      : {
                          ...event,
                          payload: {
                            ...current,
                            delegatedCompletion: event.payload.delegatedCompletion,
                          },
                        };
                  }),
                )
              : sourceEvents;
            const normalized = yield* timing.measure(
              "normalize",
              normalizeEvents(
                input.guardPendingUserInputCancellations === true
                  ? yield* guardUserInputCancellations(events)
                  : events,
              ),
            );
            const committed = yield* timing.measure(
              "append",
              eventStore.append({
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                events: normalized,
              }),
            );
            yield* timing.measure("project", applyStoredEvents(committed, timing));
            yield* timing.measure("outbox", effectOutbox.enqueue(input.effects));
            return committed;
          }).pipe(Effect.withTracerEnabled(false)),
        (storedEvents) =>
          Effect.gen(function* () {
            if (input.effects.length > 0) {
              yield* effectOutbox.notifyAvailable(input.effects.length);
            }
            yield* publishStoredEvents(storedEvents);
          }),
        isCancelled === undefined
          ? undefined
          : {
              check: () => !isCancelled(),
              prepare: () => () => {},
            },
      );
    });

    const writeResolver = RequestResolver.makeWith<QueuedWrite>({
      batchKey: () => undefined,
      // A real event-loop turn collects independent fibers without a wall-clock
      // delay or a TestClock dependency. Serial callers still await durability.
      delay: Effect.callback<void>((resume) => {
        const handle = setImmediate(() => resume(Effect.void));
        return Effect.sync(() => clearImmediate(handle));
      }),
      collectWhile: (entries) => entries.size < 100,
      runAll: (entries) => {
        const direct = (entry: Request.Entry<QueuedWrite>) =>
          (entry.request.isCancelled()
            ? Effect.interrupt
            : writeDirect(entry.request.input, entry.request.isCancelled)
          ).pipe(Effect.provideContext(entry.context));
        if (entries.length === 1)
          return Effect.exit(direct(entries[0]!)).pipe(
            Effect.tap((exit) => Effect.sync(() => entries[0]!.completeUnsafe(exit))),
            Effect.asVoid,
          );
        return Effect.gen(function* () {
          const publications: Array<Effect.Effect<void>> = [];
          let holdsLane = false;
          const committed = yield* sql
            .withTransaction(
              Effect.gen(function* () {
                const connection = yield* sql.transactionService;
                const results = yield* Effect.forEach(entries, (entry) =>
                  writeDirect(entry.request.input, entry.request.isCancelled).pipe(
                    // Restore the caller's clock, tracing and references, but never its
                    // transaction binding: every statement must use this batch's writer.
                    Effect.provideContext(
                      Context.add(
                        Context.add(entry.context, sql.transactionService, connection),
                        WriteBatch,
                        { publications },
                      ),
                    ),
                  ),
                );
                yield* publishLane.take(1);
                holdsLane = true;
                if (entries.some((entry) => entry.request.isCancelled()))
                  return yield* Effect.interrupt;
                return results;
              }),
            )
            .pipe(Effect.provideService(Scheduler.PreventSchedulerYield, true), Effect.exit);
          if (Exit.isFailure(committed)) {
            if (holdsLane) yield* publishLane.release(1);
            // The whole speculative batch rolled back. Retry in admission order,
            // giving each caller its own error and retaining later successful writes.
            for (const entry of entries) entry.completeUnsafe(yield* Effect.exit(direct(entry)));
            return;
          }
          yield* Effect.forEach(entries, (entry, index) =>
            Effect.gen(function* () {
              const published = yield* Effect.exit(publications[index]!);
              entry.completeUnsafe(
                Exit.isFailure(published) ? published : Exit.succeed(committed.value[index]!),
              );
            }),
          ).pipe(Effect.ensuring(publishLane.release(1)));
        }).pipe(
          Effect.withSpan("orchestrationV2.EventSink.batch", {
            attributes: { "orchestration_v2.batch_size": entries.length },
          }),
          // Once admitted, a caller leaving must not strand committed publication
          // or cancel the other callers sharing its transaction.
          Effect.uninterruptible,
        );
      },
    });
    // The direct operation owns the per-write phase span.
    const writeEffect = Effect.fnUntraced(function* (
      input: Parameters<EventSinkV2Shape["writeWithEffects"]>[0],
    ) {
      if (Option.isSome(yield* Effect.serviceOption(sql.transactionService))) {
        return yield* writeDirect(input);
      }
      let cancelled = false;
      return yield* Effect.request(
        QueuedWrite({ input, isCancelled: () => cancelled }),
        writeResolver,
      ).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            cancelled = true;
          }),
        ),
      );
    });

    const writeIfRunCurrentEffect = Effect.fn("orchestrationV2.EventSink.writeIfRunCurrent")(
      function* (input: Parameters<EventSinkV2Shape["writeIfRunCurrent"]>[0]) {
        yield* Effect.annotateCurrentSpan({
          "orchestration_v2.command_id": input.commandId ?? null,
          "orchestration_v2.event_count": input.events.length,
          "orchestration_v2.run_id": input.runId,
          "orchestration_v2.thread_id": input.threadId,
        });

        return yield* commitThenPublish(
          input.events,
          (timing) =>
            Effect.gen(function* () {
              const rows = yield* sql<{
                readonly status: string;
                readonly active_attempt_id: string | null;
              }>`
            SELECT
              status,
              json_extract(payload_json, '$.activeAttemptId') AS active_attempt_id
            FROM orchestration_v2_projection_runs
            WHERE run_id = ${input.runId}
              AND thread_id = ${input.threadId}
            LIMIT 1
          `;
              const current = rows[0];
              if (
                current === undefined ||
                current.status !== input.expectedStatus ||
                current.active_attempt_id !== input.activeAttemptId
              ) {
                return {
                  committed: false as const,
                  storedEvents: [] as ReadonlyArray<OrchestrationV2StoredEvent>,
                };
              }

              if (input.unlessClaudeRefused !== undefined) {
                const refused = yield* sql`SELECT provider_thread_id
                  FROM orchestration_v2_projection_provider_threads
                  WHERE provider_thread_id = ${input.unlessClaudeRefused}
                    AND driver = 'claudeAgent'
                    AND json_extract(payload_json, '$.nativeMetadata.claudeRefusalObserved') = 1
                  LIMIT 1`;
                if (refused.length > 0) return { committed: false as const, storedEvents: [] };
              }

              const normalized = yield* timing.measure(
                "normalize",
                normalizeEvents(
                  input.guardPendingUserInputCancellations === true
                    ? yield* guardUserInputCancellations(input.events)
                    : input.events,
                ),
              );
              const storedEvents = yield* timing.measure(
                "append",
                eventStore.append({
                  ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                  events: normalized,
                }),
              );
              yield* timing.measure("project", applyStoredEvents(storedEvents, timing));
              yield* timing.measure("outbox", effectOutbox.enqueue(input.effects ?? []));
              return { committed: true as const, storedEvents };
            }),
          (result) =>
            Effect.gen(function* () {
              if (!result.committed) return;
              if (input.effects !== undefined && input.effects.length > 0) {
                yield* effectOutbox.notifyAvailable(input.effects.length);
              }
              yield* publishStoredEvents(result.storedEvents);
            }),
        );
      },
    );

    const writeIfProviderThreadOwnerEffect = Effect.fn(
      "orchestrationV2.EventSink.writeIfProviderThreadOwner",
    )(function* (input: Parameters<EventSinkV2Shape["writeIfProviderThreadOwner"]>[0]) {
      yield* Effect.annotateCurrentSpan({
        "orchestration_v2.command_id": input.commandId ?? null,
        "orchestration_v2.event_count": input.events.length,
        "orchestration_v2.provider_thread_id": input.providerThreadId,
        "orchestration_v2.run_id": input.runId,
        "orchestration_v2.active_attempt_id": input.activeAttemptId,
        "orchestration_v2.expected_last_run_ordinal": input.expectedLastRunOrdinal,
      });

      return yield* commitThenPublish(
        input.events,
        (timing) =>
          Effect.gen(function* () {
            const rows = yield* sql<{
              readonly active_attempt_id: string | null;
              readonly last_run_ordinal: number | null;
            }>`
            SELECT
              json_extract(r.payload_json, '$.activeAttemptId') AS active_attempt_id,
              p.last_run_ordinal
            FROM orchestration_v2_projection_provider_threads p
            JOIN orchestration_v2_projection_runs r
              ON r.run_id = ${input.runId}
             AND r.thread_id = p.thread_id
            WHERE p.provider_thread_id = ${input.providerThreadId}
            LIMIT 1
          `;
            const current = rows[0];
            if (
              current === undefined ||
              current.active_attempt_id !== input.activeAttemptId ||
              current.last_run_ordinal !== input.expectedLastRunOrdinal
            ) {
              return {
                committed: false as const,
                storedEvents: [] as ReadonlyArray<OrchestrationV2StoredEvent>,
              };
            }

            const normalized = yield* timing.measure(
              "normalize",
              normalizeEvents(
                input.guardPendingUserInputCancellations === true
                  ? yield* guardUserInputCancellations(input.events)
                  : input.events,
              ),
            );
            const storedEvents = yield* timing.measure(
              "append",
              eventStore.append({
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                events: normalized,
              }),
            );
            yield* timing.measure("project", applyStoredEvents(storedEvents, timing));
            return { committed: true as const, storedEvents };
          }),
        (result) => (result.committed ? publishStoredEvents(result.storedEvents) : Effect.void),
      );
    });

    const writeIfProviderThreadUnchangedEffect = Effect.fn(
      "orchestrationV2.EventSink.writeIfProviderThreadUnchanged",
    )(function* (input: Parameters<EventSinkV2Shape["writeIfProviderThreadUnchanged"]>[0]) {
      yield* Effect.annotateCurrentSpan({
        "orchestration_v2.event_count": input.events.length,
        "orchestration_v2.provider_thread_id": input.expected.id,
      });
      const expectedJson = yield* ProjectionStore.encodeProviderThreadPayload(input.expected);

      return yield* commitThenPublish(
        input.events,
        (timing) =>
          Effect.gen(function* () {
            const rows = yield* sql<{ readonly payload_json: string }>`
            SELECT payload_json
            FROM orchestration_v2_projection_provider_threads
            WHERE provider_thread_id = ${input.expected.id}
            LIMIT 1
          `;
            if (rows[0]?.payload_json !== expectedJson) {
              return {
                committed: false as const,
                storedEvents: [] as ReadonlyArray<OrchestrationV2StoredEvent>,
              };
            }

            const normalized = yield* timing.measure("normalize", normalizeEvents(input.events));
            const storedEvents = yield* timing.measure(
              "append",
              eventStore.append({ events: normalized }),
            );
            yield* timing.measure("project", applyStoredEvents(storedEvents, timing));
            return { committed: true as const, storedEvents };
          }),
        (result) => (result.committed ? publishStoredEvents(result.storedEvents) : Effect.void),
      );
    });

    const existingCommandResult =
      /* This helper runs for individual orchestration events; the enclosing operation owns the span. */
      Effect.fnUntraced(function* (commandId: CommandId) {
        const existing = yield* commandReceipts.getByCommandId(commandId);
        if (Option.isNone(existing)) {
          return yield* Effect.die(
            new Error(`Command receipt ${commandId} disappeared during its transaction.`),
          );
        }
        const storedEvents = yield* eventStore.readByCommandId({ commandId }).pipe(
          Stream.runCollect,
          Effect.map((events): ReadonlyArray<OrchestrationV2StoredEvent> => Array.from(events)),
        );
        return { receipt: existing.value, storedEvents };
      });

    const commitCommandEffect = Effect.fn("orchestrationV2.EventSink.commitCommand")(function* (
      input: Parameters<EventSinkV2Shape["commitCommand"]>[0],
    ) {
      const observer = yield* SendAcknowledgement.command;
      const acceptance = observer?.id === input.commandId ? observer : undefined;
      const result = yield* commitThenPublish(
        input.events,
        (timing) =>
          Effect.gen(function* () {
            const reserved = yield* commandReceipts.insertIfAbsent({
              commandId: input.commandId,
              threadId: input.threadId,
              commandType: input.commandType,
              acceptedAt: input.acceptedAt,
              resultSequence: 0,
              status: "accepted",
              error: null,
            });
            if (!reserved) {
              const existing = yield* existingCommandResult(input.commandId);
              return { ...existing, committed: false as const, cancelledEffectIds: [] };
            }
            if (input.recheck !== undefined) yield* input.recheck;

            const normalized = yield* timing.measure("normalize", normalizeEvents(input.events));
            const storedEvents = yield* timing.measure(
              "append",
              eventStore.append({
                commandId: input.commandId,
                events: normalized,
              }),
            );
            const sequence = storedEvents.at(-1)?.sequence;
            if (sequence === undefined) {
              return yield* Effect.die(
                new Error(`Command ${input.commandId} produced no orchestration events.`),
              );
            }
            yield* timing.measure("project", applyStoredEvents(storedEvents, timing));
            yield* timing.measure("outbox", effectOutbox.enqueue(input.effects));
            const receipt: CommandReceiptStore.CommandReceiptV2 = {
              commandId: input.commandId,
              threadId: input.threadId,
              commandType: input.commandType,
              acceptedAt: input.acceptedAt,
              resultSequence: sequence,
              status: "accepted",
              error: null,
            };
            yield* commandReceipts.upsert(receipt);
            const cancelledEffectIds =
              input.cancelUnsettledEffects === undefined
                ? []
                : yield* timing.measure(
                    "outbox",
                    effectOutbox.cancelUnsettled({
                      threadId: input.threadId,
                      ...input.cancelUnsettledEffects,
                    }),
                  );
            return { receipt, storedEvents, committed: true as const, cancelledEffectIds };
          }),
        (result) =>
          Effect.gen(function* () {
            yield* effectOutbox.signalCancellations(result.cancelledEffectIds);
            if (result.committed && input.effects.length > 0) {
              yield* effectOutbox.notifyAvailable(input.effects.length);
            }
            if (result.committed) yield* publishStoredEvents(result.storedEvents);
          }),
        acceptance === undefined
          ? undefined
          : {
              check: acceptance.check,
              prepare: (result) => {
                // Another thread can win the command-id reservation after planning.
                // The orchestrator checks the receipt before returning its refusal.
                if (
                  result.receipt.threadId !== input.threadId ||
                  result.receipt.status !== "accepted" ||
                  result.receipt.commandType !== input.commandType
                )
                  return () => {};
                const reply = acceptance.result(result.storedEvents);
                if (reply === undefined)
                  throw new Error("Message commit has no acknowledgement result.");
                return () => acceptance.accept(reply);
              },
            },
      );
      return {
        receipt: result.receipt,
        storedEvents: result.storedEvents,
        committed: result.committed,
        cancelledEffectCount: result.cancelledEffectIds.length,
      };
    });

    const commitRejectedCommandEffect = Effect.fn(
      "orchestrationV2.EventSink.commitRejectedCommand",
    )(function* (input: Parameters<EventSinkV2Shape["commitRejectedCommand"]>[0]) {
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const sequence = yield* eventStore.latestSequence({ threadId: input.threadId });
            const receipt: CommandReceiptStore.CommandReceiptV2 = {
              commandId: input.commandId,
              threadId: input.threadId,
              commandType: input.commandType,
              acceptedAt: input.rejectedAt,
              resultSequence: sequence,
              status: "rejected",
              error: input.error,
            };
            const inserted = yield* commandReceipts.insertIfAbsent(receipt);
            yield* SendAcknowledgement.check(input.commandId);
            if (inserted) {
              return receipt;
            }
            const existing = yield* commandReceipts.getByCommandId(input.commandId);
            return Option.getOrElse(existing, () => receipt);
          }),
        )
        .pipe(Effect.provideService(Scheduler.PreventSchedulerYield, true));
    });

    const existingProjectReceipt = (commandId: CommandId) =>
      commandReceipts.getProjectByCommandId(commandId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(`Command ${commandId} was already used by a thread command.` as const),
            onSome: Effect.succeed,
          }),
        ),
      );

    const commitProjectCommandEffect = Effect.fn("orchestrationV2.EventSink.commitProjectCommand")(
      function* (input: Parameters<EventSinkV2Shape["commitProjectCommand"]>[0]) {
        const result = yield* commitThenPublish(
          [input.event],
          (timing) =>
            Effect.gen(function* () {
              const reserved: CommandReceiptStore.ProjectCommandReceiptV2 = {
                commandId: input.commandId,
                projectId: input.projectId,
                commandType: input.commandType,
                acceptedAt: input.acceptedAt,
                resultSequence: 0,
                status: "accepted",
                error: null,
              };
              if (!(yield* commandReceipts.insertIfAbsent(reserved))) {
                return {
                  receipt: yield* existingProjectReceipt(input.commandId),
                  event: undefined,
                };
              }
              const event = yield* timing.measure(
                "append",
                eventStore.appendProjectEvent(input.event),
              );
              yield* timing.measure(
                "project",
                timing.projectEvent(event.type, projectStore.apply(event)),
              );
              const receipt = { ...reserved, resultSequence: event.sequence };
              yield* commandReceipts.upsert(receipt);
              return { receipt, event };
            }),
          (result) =>
            result.event === undefined ? Effect.void : eventStore.publishCommitted([result.event]),
        );
        return { receipt: result.receipt, committed: result.event !== undefined };
      },
    );

    const commitRejectedProjectCommandEffect = Effect.fn(
      "orchestrationV2.EventSink.commitRejectedProjectCommand",
    )(function* (input: Parameters<EventSinkV2Shape["commitRejectedProjectCommand"]>[0]) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const receipt: CommandReceiptStore.ProjectCommandReceiptV2 = {
            commandId: input.commandId,
            projectId: input.projectId,
            commandType: input.commandType,
            acceptedAt: input.rejectedAt,
            resultSequence: yield* eventStore.latestApplicationSequence,
            status: "rejected",
            error: input.error,
          };
          return (yield* commandReceipts.insertIfAbsent(receipt))
            ? receipt
            : yield* existingProjectReceipt(input.commandId);
        }),
      );
    });

    const catchUp = (input: {
      readonly afterSequence: number;
      readonly throughSequence: number;
      readonly threadId?: ThreadId;
      readonly eventType?: OrchestrationV2DomainEvent["type"];
    }): Stream.Stream<OrchestrationV2StoredEvent, unknown> => {
      const pageSize = 256;
      const loop = (afterSequence: number): Stream.Stream<OrchestrationV2StoredEvent, unknown> =>
        Stream.unwrap(
          eventStore
            .read({
              afterSequence,
              throughSequence: input.throughSequence,
              ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
              ...(input.eventType === undefined ? {} : { eventType: input.eventType }),
              limit: pageSize,
            })
            .pipe(
              Stream.runCollect,
              Effect.map((chunk) => Array.from(chunk)),
              Effect.map((events) => {
                if (events.length === 0) {
                  return Stream.empty;
                }
                const current = Stream.fromIterable(events);
                const last = events.at(-1)?.sequence ?? input.throughSequence;
                return events.length < pageSize || last >= input.throughSequence
                  ? current
                  : Stream.concat(current, loop(last));
              }),
            ),
        );
      return loop(input.afterSequence);
    };

    const stream = (input?: Parameters<EventSinkV2Shape["stream"]>[0]) => {
      const afterSequence = input?.afterSequence ?? 0;
      const matches = (stored: OrchestrationV2StoredEvent) =>
        (input?.threadId === undefined || stored.event.threadId === input.threadId) &&
        (input?.eventType === undefined || stored.event.type === input.eventType);
      const replay = (throughSequence: number) =>
        catchUp({
          afterSequence,
          throughSequence,
          ...(input?.threadId === undefined ? {} : { threadId: input.threadId }),
          ...(input?.eventType === undefined ? {} : { eventType: input.eventType }),
        }).pipe(Stream.filter(matches));
      return Stream.unwrap(
        Effect.gen(function* () {
          let pubsub = liveEvents;
          if (input?.eventType !== undefined) {
            const existing = liveEventsByType.get(input.eventType);
            if (existing !== undefined) {
              pubsub = existing;
            } else {
              const created = yield* PubSub.unbounded<OrchestrationV2StoredEvent>();
              pubsub = liveEventsByType.get(input.eventType) ?? created;
              liveEventsByType.set(input.eventType, pubsub);
            }
          }
          if (input?.bounded === true) {
            return replayAndBufferProjectedLiveEvents({
              subscribe: PubSub.subscribe(pubsub),
              latestSequence: eventStore.latestSequence(),
              afterSequence,
              filter: matches,
              replay,
              project: (stored) => ({ ...stored, event: projectDomainEventForWire(stored.event) }),
            });
          }
          const subscription = yield* PubSub.subscribe(pubsub);
          const highWater = yield* eventStore.latestSequence();
          const live = Stream.fromSubscription(subscription).pipe(
            Stream.filter((stored) => stored.sequence > Math.max(highWater, afterSequence)),
            Stream.filter(matches),
          );
          return Stream.concat(replay(highWater), live);
        }),
      );
    };

    return EventSinkV2.of({
      publishCommitted: Effect.fn("orchestrationV2.EventSink.publishCommitted")((events) =>
        publishLane.withPermit(publishStoredEvents(events)).pipe(Effect.uninterruptible),
      ),
      write: (input) =>
        writeEffect({ ...input, effects: [] }).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                eventCount: input.events.length,
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                cause,
              }),
          ),
        ),
      writeWithEffects: (input) =>
        writeEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                eventCount: input.events.length,
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                cause,
              }),
          ),
        ),
      writeIfRunCurrent: (input) =>
        writeIfRunCurrentEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                eventCount: input.events.length,
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                cause,
              }),
          ),
        ),
      writeIfProviderThreadOwner: (input) =>
        writeIfProviderThreadOwnerEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                eventCount: input.events.length,
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                cause,
              }),
          ),
        ),
      writeIfProviderThreadUnchanged: (input) =>
        writeIfProviderThreadUnchangedEffect(input).pipe(
          Effect.mapError(
            (cause) => new EventSinkWriteError({ eventCount: input.events.length, cause }),
          ),
        ),
      commitCommand: (input) =>
        commitCommandEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                commandId: input.commandId,
                eventCount: input.events.length,
                cause,
              }),
          ),
        ),
      commitRejectedCommand: (input) =>
        commitRejectedCommandEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                commandId: input.commandId,
                eventCount: 0,
                cause,
              }),
          ),
        ),
      commitProjectCommand: (input) =>
        commitProjectCommandEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({ commandId: input.commandId, eventCount: 1, cause }),
          ),
        ),
      commitRejectedProjectCommand: (input) =>
        commitRejectedProjectCommandEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({ commandId: input.commandId, eventCount: 0, cause }),
          ),
        ),
      stream: (input) =>
        stream(input).pipe(
          Stream.mapError(
            (cause) =>
              new EventSinkStreamError({
                ...(input?.threadId === undefined ? {} : { threadId: input.threadId }),
                ...(input?.afterSequence === undefined
                  ? {}
                  : { afterSequence: input.afterSequence }),
                cause,
              }),
          ),
        ),
      latestSequence: (input) =>
        eventStore.latestSequence(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkStreamError({
                ...(input?.threadId === undefined ? {} : { threadId: input.threadId }),
                cause,
              }),
          ),
        ),
      readByCommandId: (input) =>
        eventStore.readByCommandId(input).pipe(
          Stream.mapError(
            (cause) =>
              new EventSinkStreamError({
                cause,
              }),
          ),
        ),
    } satisfies EventSinkV2Shape);
  }),
);

/**
 * Keeping the outbox instance shared with the worker is important because enqueue notifications
 * are in-memory wakeups backed by the durable SQL queue.
 */
export const layerFromStores = layerBase;

export const layer: Layer.Layer<
  EventSinkV2,
  never,
  EventStore.EventStoreV2 | ProjectionStore.ProjectionStoreV2 | SqlClient.SqlClient
> = layerBase.pipe(
  Layer.provide(
    Layer.mergeAll(
      CommandReceiptStore.layer,
      EffectOutbox.layer,
      ProjectStore.layer,
      TurnItemPositionStore.layer,
    ),
  ),
);
