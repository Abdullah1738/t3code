import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as HttpServerResponse from "effect/http/HttpServerResponse";

import * as Analytics from "../analytics/Analytics.ts";
import { recordServerAnalytics } from "../../observability/RpcInstrumentation.ts";

const RequestMethod = Context.Reference<{ method: string } | undefined>(
  "t3/ardud/control/RequestMethod",
  { defaultValue: () => undefined },
);

// Route layers supply services while building handlers, before the HTTP request fiber exists.
export const make = Effect.gen(function* () {
  const analytics = yield* Effect.serviceOption(Analytics.Analytics);
  return <E, R>(method: string, effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    analytics._tag === "None"
      ? effect
      : observe(method, effect).pipe(Effect.provideService(Analytics.Analytics, analytics.value));
});

// The HTTP route already owns the span; only its decoded mode enters analytics.
export const sendMode = Effect.fnUntraced(function* (mode: "auto" | "queue" | "steer" | "restart") {
  const request = yield* RequestMethod;
  if (request) request.method = `control.send.${mode}`;
});

// HTTP owns the span; record one request sample, including interrupted acquisitions.
export const observe = Effect.fnUntraced(function* <E, R>(
  method: string,
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) {
  const analytics = yield* Effect.serviceOption(Analytics.Analytics);
  if (analytics._tag === "None") return yield* effect;
  const clock = yield* Clock.Clock;
  const started = clock.monotonicTimeNanosUnsafe();
  const request = { method };
  let waitMs = 0;
  const parent = yield* NodeSqliteClient.ReaderWaitObserver;
  return yield* effect.pipe(
    Effect.provideService(RequestMethod, request),
    Effect.provideService(NodeSqliteClient.ReaderWaitObserver, (ms) => {
      waitMs += ms;
      parent?.(ms);
    }),
    Effect.onExit((exit) =>
      Effect.gen(function* () {
        const status = Exit.isSuccess(exit) ? exit.value.status : undefined;
        const outcome = Exit.isFailure(exit)
          ? Cause.hasInterrupts(exit.cause)
            ? ("interrupted" as const)
            : ("error" as const)
          : status !== undefined && status >= 400
            ? ("error" as const)
            : ("ok" as const);
        yield* recordServerAnalytics(analytics.value, {
          ts: DateTime.formatIso(yield* DateTime.now),
          kind: "rpc.request",
          surface: "server",
          route: request.method,
          durationMs: Math.max(0, Number(clock.monotonicTimeNanosUnsafe() - started) / 1e6),
          outcome,
          props: {
            method: request.method,
            phase: "unary",
            waitMs,
            ...(status === undefined ? {} : { status }),
            ...(outcome === "ok"
              ? {}
              : { errorTag: outcome === "interrupted" ? "Interrupted" : "ControlRequestError" }),
          },
        });
      }),
    ),
  );
});
