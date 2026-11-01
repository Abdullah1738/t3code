import {
  AuthEnvironmentMaintainScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as DesktopLeaseService from "./DesktopLeaseService.ts";

const prefix = "/api/ardud/control/desktop-lease";
const json = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: { "cache-control": "no-store" } });
class RouteError extends Data.TaggedError("DesktopLeaseRouteError")<{
  code: string;
  message: string;
  status: number;
}> {}
const routeError = (code: string, message: string, status: number) => new RouteError({ code, message, status });
const decodedJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const RequestBody = Schema.Struct({
  rootThreadId: Schema.String,
  childThreadId: Schema.String,
  taskId: Schema.String,
  scope: Schema.String,
  mode: Schema.Literals(["native", "cua-driver"]),
});
const TicketBody = Schema.Struct({ ticket: Schema.String });
const CallStartBody = Schema.Struct({ ticket: Schema.String, callId: Schema.String });
const CallEndBody = Schema.Struct({
  ticket: Schema.String,
  callId: Schema.String,
  outcome: Schema.Literals(["completed", "uncertain"]),
});
const ReconcileBody = Schema.Struct({ ticket: Schema.String, evidence: Schema.String });

const body = <A>(decode: (input: unknown) => Effect.Effect<A, Schema.SchemaError>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const text = yield* request.text.pipe(Effect.mapError(() => routeError("invalid_request", "Unable to read body.", 400)));
    const value = yield* decodedJson(text).pipe(Effect.mapError(() => routeError("invalid_request", "Body is not JSON.", 400)));
    return yield* decode(value).pipe(Effect.mapError((error) => routeError("invalid_request", error.message, 400)));
  });

export const desktopLeaseRoutes = HttpRouter.addAll(
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const lease = yield* DesktopLeaseService.DesktopLeaseService;
    const authenticate = (scope: typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope | typeof AuthEnvironmentMaintainScope) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const session = yield* auth.authenticateHttpRequest(request).pipe(
          Effect.mapError((error) =>
            EnvironmentAuth.isServerAuthCredentialError(error)
              ? routeError("unauthorized", "A valid bearer token is required.", 401)
              : routeError("unavailable", "Authentication unavailable.", 503)),
        );
        if (!session.scopes.includes(scope)) return yield* routeError("forbidden", `This token lacks ${scope}.`, 403);
      });
    const handle = <R>(effect: Effect.Effect<HttpServerResponse.HttpServerResponse, RouteError | DesktopLeaseService.DesktopLeaseServiceError, R>) =>
      effect.pipe(
        Effect.catchTags({
          DesktopLeaseRouteError: (error) => Effect.succeed(json({ ok: false, error: { code: error.code, message: error.message } }, error.status)),
          DesktopLeaseServiceError: (error) => Effect.succeed(json({ ok: false, error: { code: error.code, message: error.detail } },
            error.code === "conflict" ? 409 : error.code === "not_found" ? 404 : error.code === "invalid_request" ? 400 : 503)),
        }),
        Effect.catchCause(() => Effect.succeed(json({ ok: false, error: { code: "internal", message: "Internal error." } }, 500))),
      );
    const status = Effect.gen(function* () {
      yield* authenticate(AuthOrchestrationReadScope);
      return json(yield* lease.status());
    });
    const acquire = Effect.gen(function* () {
      yield* authenticate(AuthOrchestrationOperateScope);
      const input = yield* body(Schema.decodeUnknownEffect(RequestBody));
      return json(yield* lease.acquire(input));
    });
    const ticketAction = (action: "heartbeat" | "stop" | "release") => Effect.gen(function* () {
      yield* authenticate(AuthOrchestrationOperateScope);
      const input = yield* body(Schema.decodeUnknownEffect(TicketBody));
      return json(yield* lease[action](input.ticket));
    });
    const startCall = Effect.gen(function* () {
      yield* authenticate(AuthOrchestrationOperateScope);
      const input = yield* body(Schema.decodeUnknownEffect(CallStartBody));
      return json(yield* lease.startCall(input.ticket, input.callId));
    });
    const endCall = Effect.gen(function* () {
      yield* authenticate(AuthOrchestrationOperateScope);
      const input = yield* body(Schema.decodeUnknownEffect(CallEndBody));
      return json(yield* lease.endCall(input.ticket, input.callId, input.outcome));
    });
    const reconcile = Effect.gen(function* () {
      yield* authenticate(AuthEnvironmentMaintainScope);
      const input = yield* body(Schema.decodeUnknownEffect(ReconcileBody));
      return json(yield* lease.reconcile(input.ticket, input.evidence));
    });
    return [
      HttpRouter.route("GET", prefix, handle(status)),
      HttpRouter.route("POST", `${prefix}/acquire`, handle(acquire)),
      HttpRouter.route("POST", `${prefix}/heartbeat`, handle(ticketAction("heartbeat"))),
      HttpRouter.route("POST", `${prefix}/stop`, handle(ticketAction("stop"))),
      HttpRouter.route("POST", `${prefix}/release`, handle(ticketAction("release"))),
      HttpRouter.route("POST", `${prefix}/call-start`, handle(startCall)),
      HttpRouter.route("POST", `${prefix}/call-end`, handle(endCall)),
      HttpRouter.route("POST", `${prefix}/reconcile`, handle(reconcile)),
    ] as const;
  }),
);

export const desktopLeaseRouteLayer = desktopLeaseRoutes.pipe(Layer.provide(DesktopLeaseService.layer));
