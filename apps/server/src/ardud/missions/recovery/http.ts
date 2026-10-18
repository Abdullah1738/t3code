import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  MissionId,
  RecoveryReportInput,
  ThreadId,
  type MissionError,
  type MissionProvenance,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import { RecoveryService } from "./RecoveryService.ts";

export const RECOVERY_ROUTE_PREFIX = "/api/ardud/missions/recovery";

/** The one component that reports restarts (`t3 ardud component-token issue stream-recovery`). */
export const RECOVERY_REPORTER = "stream-recovery";

type ErrorCode =
  | "unauthorized"
  | "forbidden"
  | "invalid_request"
  | "not_found"
  | "conflict"
  | "internal";

class RecoveryHttpError extends Data.TaggedError("RecoveryHttpError")<{
  readonly code: ErrorCode;
  readonly message: string;
}> {}

const STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  invalid_request: 400,
  not_found: 404,
  conflict: 409,
  internal: 500,
};

const MISSION_CODES: Record<MissionError["code"], ErrorCode> = {
  "not-found": "not_found",
  conflict: "conflict",
  "fence-mismatch": "conflict",
  "pool-full": "conflict",
  forbidden: "forbidden",
  locked: "forbidden",
  "provenance-required": "forbidden",
  "provenance-invalid": "forbidden",
  invalid: "invalid_request",
};

const fail = (code: ErrorCode, message: string) => new RecoveryHttpError({ code, message });

const json = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: { "cache-control": "no-store" } });

const errorResponse = (error: RecoveryHttpError) =>
  json({ ok: false, error: { code: error.code, message: error.message } }, STATUS[error.code]);

const decodeJsonText = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeReport = Schema.decodeUnknownEffect(RecoveryReportInput);
const decodeMissionId = Schema.decodeUnknownEffect(MissionId);
const decodeThreadIds = Schema.decodeUnknownEffect(Schema.Array(ThreadId));

const decodeBody = <A>(decode: (input: unknown) => Effect.Effect<A, Schema.SchemaError>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const text = yield* request.text.pipe(
      Effect.mapError(() => fail("invalid_request", "Unable to read the request body.")),
    );
    const raw =
      text.trim().length === 0
        ? {}
        : yield* decodeJsonText(text).pipe(
            Effect.mapError(() => fail("invalid_request", "The request body is not valid JSON.")),
          );
    return yield* decode(raw).pipe(
      Effect.mapError((error) => fail("invalid_request", error.message)),
    );
  });

const searchParams = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  return Option.isSome(url) ? url.value.searchParams : new URLSearchParams();
});

type Scope = typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope;

const makeRoutes = Effect.gen(function* () {
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const recovery = yield* RecoveryService;

  const authenticate = (scope: Scope) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const session = yield* auth
        .authenticateHttpRequest(request)
        .pipe(
          Effect.mapError((error) =>
            EnvironmentAuth.isServerAuthCredentialError(error)
              ? fail("unauthorized", "A valid bearer token is required.")
              : fail("internal", "Authentication failed."),
          ),
        );
      if (!session.scopes.includes(scope)) {
        return yield* fail("forbidden", `This token lacks the ${scope} scope.`);
      }
      return session;
    });

  /** Only stream-recovery's own credential reports; the shared control token does not. */
  const reporter = (session: EnvironmentAuth.AuthenticatedSession) => {
    const component = session.origin?._tag === "component" ? session.origin.component : null;
    if (component === null) {
      return Effect.fail(
        fail(
          "forbidden",
          `Restart reports need ${RECOVERY_REPORTER}'s own component credential (t3 ardud component-token issue ${RECOVERY_REPORTER}).`,
        ),
      );
    }
    if (component !== RECOVERY_REPORTER) {
      return Effect.fail(
        fail(
          "forbidden",
          `This credential is ${component}; only ${RECOVERY_REPORTER} reports restarts.`,
        ),
      );
    }
    return Effect.succeed({ _tag: "system", component } satisfies MissionProvenance);
  };

  /**
   * HTTP cannot prove which thread or person is calling, so recovery controls
   * are not taken here. A valid reader learns where they are taken instead.
   */
  const refuseControl = (tool: string, rpc: string) =>
    Effect.gen(function* () {
      yield* authenticate(AuthOrchestrationReadScope);
      return yield* fail(
        "forbidden",
        `HTTP cannot prove who is calling, so recovery changes are not taken here. The master uses the MCP tool ${tool} from its thread; the owner uses the Robob app (${rpc}).`,
      );
    });

  const call = <A, R>(effect: Effect.Effect<A, MissionError, R>) =>
    effect.pipe(
      Effect.catchTags({
        MissionError: (error) => Effect.fail(fail(MISSION_CODES[error.code], error.detail)),
      }),
    );

  /** stream-recovery's findings; answers which threads mission recovery takes over. */
  const postIncident = Effect.gen(function* () {
    const provenance = yield* reporter(yield* authenticate(AuthOrchestrationOperateScope));
    const input = yield* decodeBody(decodeReport);
    return json({ ok: true, ...(yield* call(recovery.report(provenance, input))) });
  });

  /** `threadIds=a,b`: which of these threads belong to a live mission. */
  const members = Effect.gen(function* () {
    yield* authenticate(AuthOrchestrationReadScope);
    const raw = (yield* searchParams).get("threadIds") ?? "";
    const ids = yield* decodeThreadIds(
      raw
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id.length > 0),
    ).pipe(Effect.mapError(() => fail("invalid_request", "threadIds holds an invalid id.")));
    return json({ ok: true, members: yield* call(recovery.members(ids)) });
  });

  const status = Effect.gen(function* () {
    yield* authenticate(AuthOrchestrationReadScope);
    const raw = (yield* searchParams).get("missionId")?.trim() ?? "";
    const missionId = yield* decodeMissionId(raw).pipe(
      Effect.mapError(() => fail("invalid_request", "Missing or invalid missionId.")),
    );
    return json({ ok: true, status: yield* call(recovery.status(missionId)) });
  });

  const postResume = refuseControl("mission_recovery_resume", "missions.recovery.resume");
  const postSettings = refuseControl("mission_recovery_settings", "missions.recovery.settings");

  const handle = <R>(
    effect: Effect.Effect<HttpServerResponse.HttpServerResponse, RecoveryHttpError, R>,
  ) =>
    effect.pipe(
      Effect.catchTags({ RecoveryHttpError: (error) => Effect.succeed(errorResponse(error)) }),
      Effect.catchCause((cause) =>
        Effect.logWarning("ardud missions recovery request failed", { cause }).pipe(
          Effect.as(errorResponse(fail("internal", "Internal error."))),
        ),
      ),
    );

  const p = RECOVERY_ROUTE_PREFIX;
  return [
    HttpRouter.route("POST", `${p}/incident`, handle(postIncident)),
    HttpRouter.route("GET", `${p}/members`, handle(members)),
    HttpRouter.route("GET", `${p}/status`, handle(status)),
    HttpRouter.route("POST", `${p}/resume`, handle(postResume)),
    HttpRouter.route("POST", `${p}/settings`, handle(postSettings)),
  ] as const;
});

/**
 * Recovery routes, same bearer auth as the control API. A token holder is
 * never the owner and never a thread (`x-t3-thread-id` was only a claim), so
 * HTTP keeps reads and stream-recovery's restart report, which needs that
 * component's own credential. Resume and settings changes come from the
 * master's MCP tools or the owner's paired app over WebSocket.
 */
export const recoveryRouteLayer = HttpRouter.addAll(makeRoutes);
