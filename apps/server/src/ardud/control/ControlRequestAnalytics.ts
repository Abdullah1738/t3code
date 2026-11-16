import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Option from "effect/Option";
import type * as HttpServerResponse from "effect/http/HttpServerResponse";
import type * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerError from "effect/http/HttpServerError";

import * as Analytics from "../analytics/Analytics.ts";
import { recordServerAnalytics } from "../../observability/RpcInstrumentation.ts";
import * as ReplyBuilders from "../http/ReplyBuilders.ts";

export interface FailureDetails {
  readonly errorTag: string;
  readonly reason: string;
}

type SendMode = "auto" | "queue" | "steer" | "restart";
interface RequestDetails {
  method: string;
  serializationMs: number;
  threadId?: string | undefined;
  mode?: SendMode;
  clientRequestId?: string | undefined;
  failure?: FailureDetails & { readonly code: string };
}
const RequestContext = Context.Reference<RequestDetails | undefined>(
  "t3/ardud/control/RequestContext",
  { defaultValue: () => undefined },
);

// Match only server-owned invariant templates. The interpolated IDs and all other
// text (including previously persisted rejection details) stay out of logs.
const dispatchReason = (cause: unknown): string | undefined => {
  if (typeof cause !== "string" || cause.length > 8192) return;
  if (/^Target run \S+ is stopping and cannot be steered\.$/.test(cause)) return "run_stopping";
  if (/^Target run \S+ was not found\.$/.test(cause)) return "target_run_not_found";
  if (/^Target run \S+ has no root node\.$/.test(cause)) return "target_run_missing_root";
  if (
    /^Target run \S+ is (?:queued|starting|waiting|completed|failed|interrupted|cancelled) and cannot be steered\.$/.test(
      cause,
    )
  )
    return "target_run_not_running";
  if (/^Target run \S+ does not belong to thread \S+\.$/.test(cause)) return "run_thread_mismatch";
  if (/^Run \S+ is not running in this thread\.$/.test(cause)) return "run_thread_mismatch";
  if (/^Thread \S+ was stopped\.$/.test(cause)) return "thread_stopped";
  if (/^No running provider turn found for active run \S+\.$/.test(cause))
    return "no_running_provider_turn";
  if (/^Provider thread \S+ has no active provider session for steering\.$/.test(cause))
    return "no_active_provider_session";
  if (/^Provider session \S+ is not active\.$/.test(cause)) return "provider_session_inactive";
  if (cause === "Delivery was revoked before dispatch.") return "delivery_revoked";
};

// Error tags are an allowlist, never a copy of an arbitrary defect's tag/message.
export const failureDetails = (cause: unknown, depth = 0): FailureDetails => {
  const unknown = { errorTag: "UnknownError", reason: "unknown_failure" };
  if (depth >= 8 || typeof cause !== "object" || cause === null || !("_tag" in cause))
    return unknown;
  const errorTag = cause._tag;
  switch (errorTag) {
    case "ThreadManagementNoSteerableRunError":
      return { errorTag, reason: "no_steerable_run" };
    case "ThreadManagementThreadNotFoundError":
      return { errorTag, reason: "thread_not_found" };
    case "ThreadManagementRunNotFoundError":
      return { errorTag, reason: "run_thread_mismatch" };
    case "ThreadManagementThreadArchivedError":
      return { errorTag, reason: "thread_archived" };
    case "ThreadManagementThreadNotInterruptibleError":
      return { errorTag, reason: "run_not_interruptible" };
    case "ThreadManagementProviderInstanceDisabledError":
      return { errorTag, reason: "provider_disabled" };
    case "ThreadManagementDurableRunProjectionError":
      return { errorTag, reason: "durable_run_missing" };
    case "OrchestratorCommandIdConflictError":
      return { errorTag, reason: "command_id_conflict" };
    case "OrchestratorThreadAlreadyExistsError":
      return { errorTag, reason: "thread_already_exists" };
    case "OrchestratorSubagentThreadReadOnlyError":
      return { errorTag, reason: "subagent_read_only" };
    case "OrchestratorThreadAboveModeLimitError":
      return { errorTag, reason: "mode_limit" };
    case "OrchestratorThreadNotIdleError":
      return { errorTag, reason: "thread_not_idle" };
    case "AttachmentClaimError":
      return {
        errorTag,
        reason:
          "message" in cause && cause.message === "Duplicate attachment ids are not allowed."
            ? "duplicate_attachment_id"
            : "attachment_claim_failed",
      };
    case "OrchestratorMcpFailure":
      return {
        errorTag,
        reason:
          "code" in cause && cause.code === "send_timeout"
            ? "send_timeout"
            : "orchestrator_failure",
      };
    case "ServerRuntimeStartupError":
      return { errorTag, reason: "startup_unavailable" };
    case "OrchestratorCommandPreviouslyRejectedError":
      return {
        errorTag,
        reason:
          dispatchReason("detail" in cause ? cause.detail : undefined) ?? "previously_rejected",
      };
    case "OrchestratorDispatchError":
    case "OrchestratorCommandRejectedError":
    case "OrchestratorProjectionError":
    case "OrchestratorProviderAdapterError":
    case "ThreadManagementProjectionLoadError": {
      const underlying = "cause" in cause ? cause.cause : undefined;
      const reason = dispatchReason(underlying);
      if (reason !== undefined) return { errorTag, reason };
      const nested = failureDetails(underlying, depth + 1);
      if (nested.errorTag !== "UnknownError") return nested;
      return {
        errorTag,
        reason:
          errorTag === "OrchestratorCommandRejectedError"
            ? "command_rejected"
            : errorTag === "OrchestratorDispatchError"
              ? "dispatch_failed"
              : errorTag === "OrchestratorProviderAdapterError"
                ? "provider_adapter_failed"
                : "projection_failed",
      };
    }
    default:
      return unknown;
  }
};

const boundedId = (value: unknown): string | undefined =>
  typeof value === "string" && value.length <= 512 && /^[a-zA-Z0-9_.:/#@%+!~'()*-]+$/.test(value)
    ? value
    : undefined;

// These setters share the request span; none creates another tracing boundary.
export const requestThread = Effect.fnUntraced(function* (threadId: string | undefined) {
  const request = yield* RequestContext;
  if (request) request.threadId = boundedId(threadId);
});

export const sendInput = Effect.fnUntraced(function* (input: unknown) {
  const request = yield* RequestContext;
  if (request?.method !== "control.send" || typeof input !== "object" || input === null) return;
  const mode = "mode" in input ? input.mode : "auto";
  if (mode === "auto" || mode === "queue" || mode === "steer" || mode === "restart") {
    request.mode = mode;
  }
  request.clientRequestId = boundedId(
    "clientRequestId" in input ? input.clientRequestId : undefined,
  );
});

export const sendRequestId = Effect.fnUntraced(function* (clientRequestId: string) {
  const request = yield* RequestContext;
  if (request) request.clientRequestId = boundedId(clientRequestId);
});

export const failure = Effect.fnUntraced(function* (code: string, details?: FailureDetails) {
  const request = yield* RequestContext;
  if (request)
    request.failure = { code, ...(details ?? { errorTag: "ControlError", reason: code }) };
});

// Route layers supply services while building handlers, before the HTTP request fiber exists.
export const make = Effect.gen(function* () {
  const analytics = yield* Effect.serviceOption(Analytics.Analytics);
  return <E, R>(
    method: string,
    effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
    route?: { readonly path: string; readonly method: string },
  ) => observe(method, effect, route, analytics);
});

// Use route patterns here so auxiliary handlers never put request IDs into metric labels.
export const observeRoutes = Effect.fn("ArdudControl.observeRoutes")(function* <E, R>(
  routes: ReadonlyArray<HttpRouter.Route<E, R>>,
) {
  const observeControl = yield* make;
  return routes.map((route) => ({
    ...route,
    handler: observeControl(
      `control.${route.method}.${route.path.slice("/api/ardud/control/".length).replaceAll("/", ".").replaceAll(":", "")}`,
      route.handler,
      { path: route.path, method: route.method },
    ),
  }));
});

// The HTTP route already owns the span; only its decoded mode enters analytics.
export const sendMode = Effect.fnUntraced(function* (mode: SendMode) {
  const request = yield* RequestContext;
  if (request) {
    request.method = `control.send.${mode}`;
    request.mode = mode;
  }
});

export const thread = requestThread;

// Response encoding belongs to the request span, rather than another span per reply.
export const encoding = Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
  const request = yield* RequestContext;
  if (!request) return yield* effect;
  const clock = yield* Clock.Clock;
  const started = clock.monotonicTimeNanosUnsafe();
  return yield* effect.pipe(
    Effect.ensuring(
      Effect.sync(() => {
        request.serializationMs += Number(clock.monotonicTimeNanosUnsafe() - started) / 1e6;
      }),
    ),
  );
});

// The span below measures response construction, so the function adds no second span.
// An SSE connection's lifetime is not request latency.
export const observe = Effect.fnUntraced(function* <E, R>(
  method: string,
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  route?: { readonly path: string; readonly method: string },
  analyticsOverride?: Option.Option<Analytics.Analytics["Service"]>,
) {
  const analytics = analyticsOverride ?? (yield* Effect.serviceOption(Analytics.Analytics));
  const clock = yield* Clock.Clock;
  const started = clock.monotonicTimeNanosUnsafe();
  const startedAt = DateTime.formatIso(yield* DateTime.now);
  const request: RequestDetails = { method, serializationMs: 0 };
  let waitMs = 0;
  const readerTimings = new Map<
    string,
    { lane: string; waitMs: number; queryMs: number; statements: number }
  >();
  const replyAdmissions: Array<{ lane: string; waitMs: number; runMs: number; acquired: boolean }> =
    [];
  const timing = (lane: string) => {
    let row = readerTimings.get(lane);
    if (!row) {
      row = { lane, waitMs: 0, queryMs: 0, statements: 0 };
      readerTimings.set(lane, row);
    }
    return row;
  };
  const parent = yield* NodeSqliteClient.ReaderWaitObserver;
  const parentStatement = yield* NodeSqliteClient.StatementTimingObserver;
  const parentAdmission = yield* ReplyBuilders.AdmissionObserver;
  const parentContention = yield* NodeSqliteClient.ReaderContentionObserver;
  const readerHolders = new Map<string, { lane: string; holder: string; holdMs: number }>();
  return yield* effect.pipe(
    Effect.provideService(RequestContext, request),
    Effect.provideService(NodeSqliteClient.ReaderWaitObserver, (ms, lane) => {
      waitMs += ms;
      timing(lane ?? "unknown").waitMs += ms;
      parent?.(ms, lane);
    }),
    Effect.provideService(NodeSqliteClient.StatementTimingObserver, (sample) => {
      const row = timing(sample.lane ?? sample.connection);
      row.queryMs += sample.durationMs;
      row.statements++;
      parentStatement?.(sample);
    }),
    Effect.provideService(ReplyBuilders.AdmissionObserver, (sample) => {
      if (replyAdmissions.length < 8) replyAdmissions.push(sample);
      parentAdmission?.(sample);
    }),
    Effect.provideService(NodeSqliteClient.ReaderContentionObserver, (sample) => {
      const key = `${sample.lane}:${sample.holder}`;
      // Bound request-local work even when a long read meets many distinct workloads.
      const row = readerHolders.get(key);
      if (row) row.holdMs += sample.holdMs;
      else if (readerHolders.size < 64)
        readerHolders.set(key, { lane: sample.lane, holder: sample.holder, holdMs: sample.holdMs });
      parentContention?.(sample);
    }),
    Effect.onExit((exit) =>
      Effect.gen(function* () {
        const status = Exit.isSuccess(exit)
          ? exit.value.status
          : Cause.hasInterruptsOnly(exit.cause)
            ? exit.cause.reasons
                .findLast((reason) => reason._tag === "Interrupt")
                ?.annotations.has(HttpServerError.ClientAbort.key)
              ? 499
              : 503
            : 500;
        const durationMs = Math.max(0, Number(clock.monotonicTimeNanosUnsafe() - started) / 1e6);
        yield* Effect.annotateCurrentSpan({
          "control.duration_ms": durationMs,
          "http.response.status_code": status,
        });
        const outcome = Exit.isFailure(exit)
          ? Cause.hasInterrupts(exit.cause)
            ? ("interrupted" as const)
            : ("error" as const)
          : status < 200 || status >= 300
            ? ("error" as const)
            : ("ok" as const);
        const failure =
          request.failure ??
          (Exit.isFailure(exit)
            ? {
                code: outcome === "interrupted" ? "interrupted" : "internal",
                errorTag:
                  outcome === "interrupted"
                    ? "Interrupted"
                    : Cause.hasDies(exit.cause)
                      ? "Defect"
                      : "UnknownError",
                reason: outcome === "interrupted" ? "interrupted" : "unexpected_failure",
              }
            : undefined);
        if (status < 200 || status >= 300) {
          yield* Effect.logWarning("ardud control request rejected", {
            httpRoute: route?.path ?? null,
            httpMethod: route?.method ?? null,
            threadId: request.threadId ?? null,
            mode: request.mode ?? null,
            clientRequestId: request.clientRequestId ?? null,
            status,
            code: failure?.code ?? (outcome === "interrupted" ? "interrupted" : "unknown"),
            errorTag:
              failure?.errorTag ??
              (outcome === "interrupted" ? "Interrupted" : "ControlRequestError"),
            reason: failure?.reason ?? (outcome === "interrupted" ? "interrupted" : "http_error"),
            durationMs,
          }).pipe(Effect.catchCause(() => Effect.void));
        }
        if (analytics._tag === "None") return;
        yield* recordServerAnalytics(analytics.value, {
          ts: DateTime.formatIso(yield* DateTime.now),
          startedAt,
          kind: "rpc.request",
          surface: "server",
          route: request.method,
          ...(request.threadId === undefined ? {} : { threadId: request.threadId }),
          durationMs,
          outcome,
          props: {
            method: request.method,
            ...(route === undefined ? {} : { httpMethod: route.method, httpRoute: route.path }),
            phase: "unary",
            waitMs,
            readerTimings: [...readerTimings.values()],
            replyAdmissions,
            serializationMs: request.serializationMs,
            readerHolders: [...readerHolders.values()]
              .sort((a, b) => b.holdMs - a.holdMs)
              .slice(0, 8),
            ...(status === undefined ? {} : { status }),
            ...(outcome === "ok"
              ? {}
              : {
                  errorTag:
                    failure?.errorTag ??
                    (outcome === "interrupted" ? "Interrupted" : "ControlRequestError"),
                  ...(failure === undefined ? {} : { code: failure.code, reason: failure.reason }),
                }),
          },
        });
      }),
    ),
    Effect.withSpan("ArdudControl.request", {
      attributes:
        route === undefined
          ? {}
          : { "http.route": route.path, "http.request.method": route.method },
    }),
  );
});
