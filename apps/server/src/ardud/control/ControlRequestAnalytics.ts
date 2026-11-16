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

import * as Analytics from "../analytics/Analytics.ts";
import { recordServerAnalytics } from "../../observability/RpcInstrumentation.ts";
import * as ReplyBuilders from "../http/ReplyBuilders.ts";

const RequestMethod = Context.Reference<
  { method: string; threadId?: string; serializationMs: number } | undefined
>("t3/ardud/control/RequestMethod", { defaultValue: () => undefined });

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
export const sendMode = Effect.fnUntraced(function* (mode: "auto" | "queue" | "steer" | "restart") {
  const request = yield* RequestMethod;
  if (request) request.method = `control.send.${mode}`;
});

// Only decoded route parameters enter correlation, never arbitrary URL text.
export const thread = Effect.fnUntraced(function* (threadId: string) {
  const request = yield* RequestMethod;
  if (request) request.threadId = threadId;
});

// Response encoding belongs to the request span, rather than another span per reply.
export const encoding = Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
  const request = yield* RequestMethod;
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
  const request: { method: string; threadId?: string; serializationMs: number } = {
    method,
    serializationMs: 0,
  };
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
    Effect.provideService(RequestMethod, request),
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
        const status = Exit.isSuccess(exit) ? exit.value.status : undefined;
        const durationMs = Math.max(0, Number(clock.monotonicTimeNanosUnsafe() - started) / 1e6);
        yield* Effect.annotateCurrentSpan({
          "control.duration_ms": durationMs,
          ...(status === undefined ? {} : { "http.response.status_code": status }),
        });
        const outcome = Exit.isFailure(exit)
          ? Cause.hasInterrupts(exit.cause)
            ? ("interrupted" as const)
            : ("error" as const)
          : status !== undefined && status >= 400
            ? ("error" as const)
            : ("ok" as const);
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
              : { errorTag: outcome === "interrupted" ? "Interrupted" : "ControlRequestError" }),
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
