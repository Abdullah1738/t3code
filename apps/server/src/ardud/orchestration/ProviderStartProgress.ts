import type {
  OrchestratorMcpStartProgress,
  OrchestrationV2DomainEvent,
  OrchestrationV2ProviderTurn,
  OrchestrationV2Run,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as KanbanStore from "../kanban/store/KanbanStore.ts";
import { providerStartAccepted } from "../../orchestration-v2/providerStartDeadlinePolicy.ts";

type Attempt = {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly attemptId: RunAttemptId;
};
type Step = OrchestratorMcpStartProgress["step"];
type Evidence = "sdk_received" | "native_accepted" | "adapter_emitted" | "orchestration_ingestion";
type SessionWait = {
  readonly providerSessionId: ProviderSessionId;
  readonly threadId?: ThreadId;
  readonly nativeSessionId?: string;
};
type Wait = {
  readonly session?: SessionWait;
  readonly attempt?: Attempt;
  readonly step: Step;
  readonly since: string;
};

export const startState = (
  run: OrchestrationV2Run | undefined | null,
  turns: ReadonlyArray<OrchestrationV2ProviderTurn>,
  progress: OrchestratorMcpStartProgress | null,
) => {
  const startPending =
    run != null &&
    ["preparing", "starting", "running"].includes(run.status) &&
    !providerStartAccepted(run, turns ?? [], []);
  return {
    startPending,
    startProgress:
      !startPending || run?.activeAttemptId == null
        ? null
        : (progress ?? {
            runId: run.id,
            attemptId: run.activeAttemptId,
            step:
              run.status === "preparing"
                ? ("workspace_preparation" as const)
                : run.status === "starting"
                  ? ("awaiting_worker" as const)
                  : ("awaiting_native_acceptance" as const),
            since: DateTime.formatIso(run.startedAt ?? run.requestedAt),
            nativeSessionId: null,
            sdkReceivedAt: null,
            nativeAcceptedAt: null,
            adapterEmittedAt: null,
          }),
  };
};

export class ProviderStartProgress extends Context.Service<
  ProviderStartProgress,
  {
    readonly begin: (
      input: Attempt & {
        readonly provider: ProviderInstanceId;
        readonly model: string | null;
        readonly delegated: boolean;
        readonly providerSessionId: ProviderSessionId;
        readonly attemptOrdinal: number;
      },
    ) => Effect.Effect<void>;
    readonly step: (attempt: Attempt, step: Step, nativeSessionId?: string) => Effect.Effect<void>;
    readonly observe: (
      attempt: Attempt,
      evidence: Evidence,
      nativeSessionId?: string,
    ) => Effect.Effect<void>;
    readonly get: (
      runId: RunId,
      attemptId: RunAttemptId | null,
    ) => OrchestratorMcpStartProgress | null;
    readonly release: (attempt: Attempt) => Effect.Effect<void>;
    readonly withSessionStep: <A, E, R>(
      session: SessionWait,
      step: "session_status_audience" | "session_status_write",
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    readonly withRunStep: <A, E, R>(
      attempt: Attempt,
      step: "run_ingestion_write",
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/ardud/orchestration/ProviderStartProgress") {}

const make = Effect.gen(function* () {
  const boards = yield* Effect.serviceOption(KanbanStore.KanbanStore);
  const scope = yield* Effect.scope;
  const records = new Map<
    RunId,
    {
      readonly identity: Attempt;
      readonly provider: ProviderInstanceId;
      readonly model: string | null;
      readonly delegated: boolean;
      readonly providerSessionId: ProviderSessionId;
      readonly attemptOrdinal: number;
      readonly beganAt: number;
      role: string;
      warning?: Fiber.Fiber<void>;
      ingestionObserved: boolean;
      progress: OrchestratorMcpStartProgress;
    }
  >();
  const waits = new Map<symbol, Wait>();
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      records.clear();
      waits.clear();
    }),
  );
  const matches = (record: NonNullable<ReturnType<typeof records.get>>, wait: Wait) =>
    wait.attempt !== undefined
      ? wait.attempt.runId === record.identity.runId &&
        wait.attempt.attemptId === record.identity.attemptId &&
        wait.attempt.threadId === record.identity.threadId
      : wait.session?.providerSessionId === record.providerSessionId &&
        (wait.session.threadId === undefined ||
          wait.session.threadId === record.identity.threadId) &&
        (wait.session.nativeSessionId === undefined ||
          wait.session.nativeSessionId === record.progress.nativeSessionId);
  const snapshot = (record: NonNullable<ReturnType<typeof records.get>>) => {
    const active =
      [...waits.values()].find(
        (wait) => wait.step === "run_ingestion_write" && matches(record, wait),
      ) ??
      [...waits.values()].find(
        (wait) => wait.step === "session_status_write" && matches(record, wait),
      ) ??
      [...waits.values()].find((wait) => matches(record, wait));
    return active === undefined
      ? record.progress
      : { ...record.progress, step: active.step, since: active.since };
  };
  const release = Effect.fnUntraced(function* (attempt: Attempt) {
    const record = find(attempt);
    if (record === undefined) return;
    records.delete(attempt.runId);
    for (const [key, wait] of waits) {
      if (wait.attempt?.attemptId === attempt.attemptId && wait.attempt.runId === attempt.runId)
        waits.delete(key);
    }
    if (record.warning !== undefined)
      yield* Fiber.interrupt(record.warning).pipe(Effect.forkIn(scope), Effect.asVoid);
  });
  const find = (attempt: Attempt) => {
    const record = records.get(attempt.runId);
    return record?.identity.threadId === attempt.threadId &&
      record.identity.attemptId === attempt.attemptId
      ? record
      : undefined;
  };
  // Progress is per native boundary, never per token, and is not persisted.
  const step = Effect.fnUntraced(function* (
    attempt: Attempt,
    next: Step,
    nativeSessionId?: string,
  ) {
    const record = find(attempt);
    if (record === undefined) return;
    if (
      record.progress.sdkReceivedAt !== null ||
      record.progress.nativeAcceptedAt !== null ||
      record.ingestionObserved
    )
      return;
    record.progress = {
      ...record.progress,
      ...(record.progress.step === next
        ? {}
        : { step: next, since: DateTime.formatIso(yield* DateTime.now) }),
      ...(nativeSessionId === undefined ? {} : { nativeSessionId }),
    };
  });
  // These observers follow an existing await; they add no queue or persistence.
  const withWait = <A, E, R>(wait: Omit<Wait, "since">, effect: Effect.Effect<A, E, R>) =>
    Effect.suspend(() => {
      const key = Symbol();
      return DateTime.now.pipe(
        Effect.tap((now) =>
          Effect.sync(() => waits.set(key, { ...wait, since: DateTime.formatIso(now) })),
        ),
        Effect.andThen(effect),
        Effect.ensuring(Effect.sync(() => waits.delete(key))),
      );
    });
  return ProviderStartProgress.of({
    begin: Effect.fnUntraced(function* (input) {
      if (find(input) !== undefined) return;
      const previous = records.get(input.runId);
      if (previous !== undefined && previous.attemptOrdinal >= input.attemptOrdinal) return;
      if (previous !== undefined) yield* release(previous.identity);
      const now = yield* DateTime.now;
      const record: NonNullable<ReturnType<typeof records.get>> = {
        identity: { threadId: input.threadId, runId: input.runId, attemptId: input.attemptId },
        provider: input.provider,
        model: input.model,
        delegated: input.delegated,
        providerSessionId: input.providerSessionId,
        attemptOrdinal: input.attemptOrdinal,
        beganAt: DateTime.toEpochMillis(now),
        role: input.delegated ? "delegated" : Option.isSome(boards) ? "unknown" : "chat",
        ingestionObserved: false,
        progress: {
          runId: input.runId,
          attemptId: input.attemptId,
          step: "admission",
          since: DateTime.formatIso(now),
          nativeSessionId: null,
          sdkReceivedAt: null,
          nativeAcceptedAt: null,
          adapterEmittedAt: null,
        },
      };
      records.set(input.runId, record);
      record.warning = yield* Effect.gen(function* () {
        if (Option.isSome(boards)) {
          yield* boards.value.threadLink(input.threadId).pipe(
            Effect.timeoutOption("2 seconds"),
            Effect.orElseSucceed(() => Option.none()),
            Effect.tap((link) =>
              Effect.sync(() => {
                if (Option.isSome(link))
                  record.role = input.delegated ? "delegated" : (link.value?.role ?? "chat");
              }),
            ),
            Effect.forkChild,
          );
        }
        const elapsed = DateTime.toEpochMillis(yield* DateTime.now) - record.beganAt;
        yield* Effect.sleep(Math.max(0, 60_000 - elapsed));
        if (records.get(input.runId) !== record) return;
        const fields = {
          ...record.identity,
          ...snapshot(record),
          provider: record.provider,
          providerSessionId: record.providerSessionId,
          model: record.model ?? "unknown",
          role: record.role,
          delegated: record.delegated,
          elapsedMs: DateTime.toEpochMillis(yield* DateTime.now) - record.beganAt,
        };
        yield* Effect.gen(function* () {
          // Local retention must not depend on whether the configured logger
          // also exports span events (OTLP log export replaces that logger).
          const span = yield* Effect.currentSpan.pipe(Effect.option);
          if (Option.isSome(span))
            span.value.event("provider.start-waiting", yield* Clock.currentTimeNanos, {
              "effect.logLevel": "WARN",
            });
          yield* Effect.logWarning("provider.start-waiting", fields);
        }).pipe(Effect.withSpan("provider.start-waiting", { attributes: fields }));
      }).pipe(Effect.forkIn(scope, { uninterruptible: false }));
    }),
    step,
    observe: Effect.fnUntraced(function* (attempt, evidence, nativeSessionId) {
      const record = find(attempt);
      if (record === undefined) return;
      const field = {
        sdk_received: "sdkReceivedAt",
        native_accepted: "nativeAcceptedAt",
        adapter_emitted: "adapterEmittedAt",
        orchestration_ingestion: null,
      } as const;
      const key = field[evidence];
      if (key === null) {
        if (record.ingestionObserved) return;
        record.ingestionObserved = true;
      }
      if (key !== null) {
        if (record.progress[key] !== null) return;
        record.progress = { ...record.progress, [key]: DateTime.formatIso(yield* DateTime.now) };
      }
      const next = record.ingestionObserved
        ? "orchestration_ingestion"
        : record.progress.adapterEmittedAt !== null
          ? "adapter_emitted"
          : record.progress.nativeAcceptedAt !== null
            ? "native_accepted"
            : "sdk_received";
      record.progress = {
        ...record.progress,
        ...(record.progress.step === next
          ? {}
          : { step: next, since: DateTime.formatIso(yield* DateTime.now) }),
        ...(nativeSessionId === undefined ? {} : { nativeSessionId }),
      };
    }),
    get: (runId, attemptId) => {
      const record = records.get(runId);
      return record?.identity.attemptId === attemptId ? snapshot(record) : null;
    },
    release,
    withSessionStep: (session, step, effect) => withWait({ session, step }, effect),
    withRunStep: (attempt, step, effect) => withWait({ attempt, step }, effect),
    handle: Effect.fnUntraced(function* (event) {
      if (event.type === "run-attempt.updated") {
        const record = records.get(event.payload.runId);
        if (
          record !== undefined &&
          (event.payload.attemptOrdinal > record.attemptOrdinal ||
            (event.payload.id === record.identity.attemptId &&
              !["pending", "running"].includes(event.payload.status) &&
              DateTime.toEpochMillis(event.occurredAt) >= record.beganAt))
        )
          yield* release(record.identity);
      }
      if (event.type === "provider-turn.updated" && event.payload.promptAcceptedAt !== undefined) {
        for (const record of records.values()) {
          if (record.identity.attemptId === event.payload.runAttemptId)
            yield* release(record.identity);
        }
      }
      if (event.type !== "run.updated" && event.type !== "run.created") return;
      const record = records.get(event.payload.id);
      if (record === undefined) return;
      if (
        event.payload.activeAttemptId === record.identity.attemptId &&
        ["waiting", "completed", "failed", "interrupted", "cancelled", "rolled_back"].includes(
          event.payload.status,
        ) &&
        DateTime.toEpochMillis(event.occurredAt) >= record.beganAt
      )
        yield* release(record.identity);
    }),
  });
});

export const layer = Layer.effect(ProviderStartProgress, make);
