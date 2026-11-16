import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ExecutionIdentity from "../identity/ExecutionIdentity.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { DesktopLease, DesktopLeaseError, type LeaseRequest } from "./DesktopLease.ts";

export class DesktopLeaseServiceError extends Schema.TaggedError<DesktopLeaseServiceError>()(
  "DesktopLeaseServiceError",
  { code: Schema.String, detail: Schema.String },
) {}

const failure = (cause: unknown) =>
  cause instanceof DesktopLeaseError
    ? new DesktopLeaseServiceError({ code: cause.code, detail: cause.message })
    : new DesktopLeaseServiceError({
        code: "unavailable",
        detail: "Desktop lease storage is unavailable.",
      });

type CallerIdentity = {
  readonly driver: string;
  readonly nativeId: string;
  readonly agentId?: string;
};

type StoreOptions = {
  readonly filename?: string;
  readonly now?: () => number;
  readonly factory?: (options: { filename?: string; now?: () => number }) => DesktopLease;
};

// Each measured phase owns its span; this wrapper only records the elapsed time on exit.
const measureStart = Effect.fnUntraced(function* <A, E, R>(
  phase: "total" | "caller" | "lease" | "runningTurn" | "persistence",
  toolUseId: string,
  operation: Effect.Effect<A, E, R>,
) {
  const started = yield* Clock.currentTimeMillis;
  return yield* operation.pipe(
    Effect.onExit((exit) =>
      Effect.gen(function* () {
        const ended = yield* Clock.currentTimeMillis;
        yield* Effect.logInfo("Desktop lease call-start timing", {
          toolUseId,
          phase,
          durationMs: ended - started,
          outcome: exit._tag,
        });
      }),
    ),
    Effect.withSpan(`DesktopLease.callStart.${phase}`, { attributes: { toolUseId } }),
  );
});

export class DesktopLeaseService extends Context.Service<
  DesktopLeaseService,
  {
    readonly status: () => Effect.Effect<
      ReturnType<DesktopLease["status"]>,
      DesktopLeaseServiceError
    >;
    readonly acquire: (
      caller: CallerIdentity,
      input: LeaseRequest,
    ) => Effect.Effect<ReturnType<DesktopLease["acquire"]>, DesktopLeaseServiceError>;
    readonly heartbeat: (
      caller: CallerIdentity,
      ticket: string,
    ) => Effect.Effect<ReturnType<DesktopLease["heartbeat"]>, DesktopLeaseServiceError>;
    readonly release: (
      caller: CallerIdentity,
      ticket: string,
    ) => Effect.Effect<ReturnType<DesktopLease["release"]>, DesktopLeaseServiceError>;
    readonly callStart: (
      caller: CallerIdentity,
      toolUseId: string,
    ) => Effect.Effect<ReturnType<DesktopLease["callStart"]>, DesktopLeaseServiceError>;
    readonly callEnd: (
      toolUseId: string,
      outcome: "completed" | "failed",
    ) => Effect.Effect<ReturnType<DesktopLease["callEnd"]>, DesktopLeaseServiceError>;
    readonly reconcile: (
      ticket: string,
      evidence: string,
    ) => Effect.Effect<ReturnType<DesktopLease["reconcile"]>, DesktopLeaseServiceError>;
  }
>()("t3/ardud/desktop-lease/DesktopLeaseService") {}

const make = Effect.fn("DesktopLeaseService.make")(function* (options: StoreOptions = {}) {
  const identity = yield* ExecutionIdentity.ExecutionIdentity;
  const projection = yield* ProjectionStore.ProjectionStoreV2;
  const { factory = (storeOptions) => new DesktopLease(storeOptions), ...storeOptions } = options;
  let store: DesktopLease | undefined;

  // Opening is synchronous, so concurrent calls cannot construct two stores in this layer.
  const withStore = Effect.fn("DesktopLease.withStore")(function* <A>(
    operation: (store: DesktopLease) => A,
    toolUseId?: string,
  ) {
    const measure = <B, E, R>(
      phase: "lease" | "runningTurn" | "persistence",
      effect: Effect.Effect<B, E, R>,
    ) => (toolUseId === undefined ? effect : measureStart(phase, toolUseId, effect));
    const current = yield* measure(
      "lease",
      Effect.try({
        try: () => {
          store ??= factory(storeOptions);
          return { store, lease: store.currentLease() };
        },
        catch: failure,
      }),
    );
    const { lease } = current;
    const running =
      lease?.state === "held"
        ? yield* measure(
            "runningTurn",
            projection.getRunningTurnContext(ThreadId.make(lease.childThreadId)).pipe(
              Effect.map((context) => context.run?.status === "running"),
              Effect.orElseSucceed(() => false),
            ),
          )
        : false;
    return yield* measure(
      "persistence",
      Effect.try({
        try: () => {
          if (running && lease) current.store.touchHolder(lease.childThreadId, lease.ticket);
          return operation(current.store);
        },
        catch: failure,
      }),
    );
  });

  yield* Effect.addFinalizer(() => Effect.sync(() => store?.close()));

  const resolveCaller = Effect.fn("DesktopLease.resolveCaller")(function* (input: CallerIdentity) {
    const resolved = yield* identity.resolve(input).pipe(
      Effect.mapError(
        () =>
          new DesktopLeaseServiceError({
            code: "unavailable",
            detail: "Execution identity is unavailable.",
          }),
      ),
    );
    if (resolved.resolution !== "resolved" || !resolved.robobThreadId || !resolved.rootThreadId) {
      return yield* new DesktopLeaseServiceError({
        code: "conflict",
        detail: `Caller identity resolution: ${resolved.resolution}${resolved.resolution === "resolved" ? " (missing thread identity)" : ""}.`,
      });
    }
    return { robobThreadId: resolved.robobThreadId, rootThreadId: resolved.rootThreadId };
  });

  return DesktopLeaseService.of({
    status: Effect.fn("DesktopLease.status")(function* () {
      return yield* withStore((store) => store.status());
    }),
    acquire: Effect.fn("DesktopLease.acquire")(function* (caller, input) {
      const resolved = yield* resolveCaller(caller);
      return yield* withStore((store) => store.acquire(resolved, input));
    }),
    heartbeat: Effect.fn("DesktopLease.heartbeat")(function* (caller, ticket) {
      const resolved = yield* resolveCaller(caller);
      return yield* withStore((store) => store.heartbeat(resolved, ticket));
    }),
    release: Effect.fn("DesktopLease.release")(function* (caller, ticket) {
      const resolved = yield* resolveCaller(caller);
      return yield* withStore((store) => store.release(resolved, ticket));
    }),
    callStart: Effect.fn("DesktopLease.callStart")(function* (caller, toolUseId) {
      yield* Effect.annotateCurrentSpan({ toolUseId });
      return yield* measureStart(
        "total",
        toolUseId,
        Effect.gen(function* () {
          const resolved = yield* measureStart("caller", toolUseId, resolveCaller(caller));
          return yield* withStore((store) => store.callStart(resolved, toolUseId), toolUseId);
        }),
      );
    }),
    callEnd: Effect.fn("DesktopLease.callEnd")(function* (toolUseId, outcome) {
      return yield* withStore((store) => store.callEnd(toolUseId, outcome));
    }),
    reconcile: Effect.fn("DesktopLease.reconcile")(function* (ticket, evidence) {
      return yield* withStore((store) => store.reconcile(ticket, evidence));
    }),
  });
});

export const layerWithOptions = (options: StoreOptions) =>
  Layer.effect(DesktopLeaseService, make(options));
export const layer = layerWithOptions({});
