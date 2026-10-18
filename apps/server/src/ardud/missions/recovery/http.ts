import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  MissionId,
  RecoveryReportInput,
  RecoveryResumeInput,
  RecoverySettingsInput,
  RoleId,
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

/** stream-recovery is the only system reporter today. */
const REPORTER: MissionProvenance = { _tag: "system", component: "stream-recovery" };

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
const decodeResume = Schema.decodeUnknownEffect(RecoveryResumeInput);
const decodeSettings = Schema.decodeUnknownEffect(RecoverySettingsInput);
const decodeMissionId = Schema.decodeUnknownEffect(MissionId);
const decodeThreadIds = Schema.decodeUnknownEffect(Schema.Array(ThreadId));
const decodeThreadId = Schema.decodeUnknownEffect(ThreadId);
const decodeRoleId = Schema.decodeUnknownEffect(RoleId);

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

/** Agent provenance from the caller's headers, as in the core mission routes. */
const agentProvenance = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const threadHeader = request.headers["x-t3-thread-id"]?.trim() ?? "";
  if (threadHeader.length === 0) {
    return yield* fail("forbidden", "Recovery changes need the calling thread in x-t3-thread-id.");
  }
  const threadId = yield* decodeThreadId(threadHeader).pipe(
    Effect.mapError(() => fail("invalid_request", "x-t3-thread-id is not a thread id.")),
  );
  const roleHeader = request.headers["x-t3-role-id"]?.trim() ?? "";
  const roleId =
    roleHeader.length === 0
      ? null
      : yield* decodeRoleId(roleHeader).pipe(
          Effect.mapError(() => fail("invalid_request", "x-t3-role-id is not a role id.")),
        );
  return { _tag: "agent", threadId, roleId } satisfies MissionProvenance;
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
    });

  const call = <A, R>(effect: Effect.Effect<A, MissionError, R>) =>
    effect.pipe(
      Effect.catchTags({
        MissionError: (error) => Effect.fail(fail(MISSION_CODES[error.code], error.detail)),
      }),
    );

  /** stream-recovery's findings; answers which threads mission recovery takes over. */
  const postIncident = Effect.gen(function* () {
    yield* authenticate(AuthOrchestrationOperateScope);
    const input = yield* decodeBody(decodeReport);
    return json({ ok: true, ...(yield* call(recovery.report(REPORTER, input))) });
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

  const postResume = Effect.gen(function* () {
    yield* authenticate(AuthOrchestrationOperateScope);
    const provenance = yield* agentProvenance;
    const input = yield* decodeBody(decodeResume);
    return json({ ok: true, status: yield* call(recovery.resume(provenance, input)) });
  });

  const postSettings = Effect.gen(function* () {
    yield* authenticate(AuthOrchestrationOperateScope);
    const provenance = yield* agentProvenance;
    const input = yield* decodeBody(decodeSettings);
    return json({ ok: true, settings: yield* call(recovery.setSettings(provenance, input)) });
  });

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
 * never the owner: resume and settings changes name the calling thread, and
 * only the mission's master thread may make them over HTTP.
 */
export const recoveryRouteLayer = HttpRouter.addAll(makeRoutes);
