import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  MissionId,
  ReorderSubMissionsInput,
  RoleId,
  ThreadId,
  UpdateMissionInput,
  UpsertLaneInput,
  UpsertMilestoneInput,
  UpsertSubMissionInput,
  UpsertWorkItemInput,
  type MissionError,
  type MissionErrorCode,
  type MissionMutationResult,
  type MissionProvenance,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as MissionService from "./MissionService.ts";

/**
 * Missions HTTP API at /api/ardud/missions, for the `mission` CLI and other
 * local callers. Same bearer auth and `{ ok, ... }` envelope as the control
 * API: reads need orchestration:read, writes orchestration:operate.
 *
 * A token holder is never the owner. Writes are agent writes and must name the
 * calling thread in `x-t3-thread-id` (optionally `x-t3-role-id`); the owner's
 * locks and owner-only fields still apply. Other tracks mount their own routes
 * under this prefix and register them in `layer.ts`.
 */
export const MISSIONS_ROUTE_PREFIX = "/api/ardud/missions";

type HttpErrorCode =
  | "unauthorized"
  | "forbidden"
  | "invalid_request"
  | "not_found"
  | "conflict"
  | "internal";

class MissionsHttpError extends Data.TaggedError("MissionsHttpError")<{
  readonly code: HttpErrorCode;
  readonly message: string;
  readonly missionCode?: MissionErrorCode;
}> {}

const STATUS: Record<HttpErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  invalid_request: 400,
  not_found: 404,
  conflict: 409,
  internal: 500,
};

const HTTP_CODE: Record<MissionErrorCode, HttpErrorCode> = {
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

const fail = (code: HttpErrorCode, message: string) => new MissionsHttpError({ code, message });

const fromMissionError = (error: MissionError) =>
  new MissionsHttpError({
    code: HTTP_CODE[error.code],
    message: error.detail,
    missionCode: error.code,
  });

const json = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: { "cache-control": "no-store" } });

const errorResponse = (error: MissionsHttpError) =>
  json(
    {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.missionCode === undefined ? {} : { missionCode: error.missionCode }),
      },
    },
    STATUS[error.code],
  );

const decodeJsonText = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeMissionId = Schema.decodeUnknownEffect(MissionId);
const decodeThreadId = Schema.decodeUnknownEffect(ThreadId);
const decodeRoleId = Schema.decodeUnknownEffect(RoleId);
const decodeUpdateMission = Schema.decodeUnknownEffect(UpdateMissionInput);
const decodeUpsertSubMission = Schema.decodeUnknownEffect(UpsertSubMissionInput);
const decodeReorder = Schema.decodeUnknownEffect(ReorderSubMissionsInput);
const decodeUpsertMilestone = Schema.decodeUnknownEffect(UpsertMilestoneInput);
const decodeUpsertLane = Schema.decodeUnknownEffect(UpsertLaneInput);
const decodeUpsertWorkItem = Schema.decodeUnknownEffect(UpsertWorkItemInput);

const searchParams = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  return Option.isSome(url) ? url.value.searchParams : new URLSearchParams();
});

const missionParam = (raw: string | null) =>
  raw === null || raw.trim().length === 0
    ? Effect.succeed(null)
    : decodeMissionId(raw).pipe(
        Effect.mapError(() => fail("invalid_request", "mission must be a mission id.")),
      );

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

/** Agent provenance from the caller's headers. Never read from the body. */
const agentProvenance = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const threadHeader = request.headers["x-t3-thread-id"];
  if (threadHeader === undefined || threadHeader.trim().length === 0) {
    return yield* new MissionsHttpError({
      code: "forbidden",
      message: "Mission writes need the calling thread in x-t3-thread-id.",
      missionCode: "provenance-required",
    });
  }
  const threadId = yield* decodeThreadId(threadHeader).pipe(
    Effect.mapError(() => fail("invalid_request", "x-t3-thread-id is not a thread id.")),
  );
  const roleHeader = request.headers["x-t3-role-id"];
  const roleId =
    roleHeader === undefined || roleHeader.trim().length === 0
      ? null
      : yield* decodeRoleId(roleHeader).pipe(
          Effect.mapError(() => fail("invalid_request", "x-t3-role-id is not a role id.")),
        );
  return { _tag: "agent", threadId, roleId } satisfies MissionProvenance;
});

/** `since` is a seq (digits) or an ISO time; missing means the latest events. */
const parseSince = (
  raw: string | null,
): Effect.Effect<MissionService.MissionDigestSince, MissionsHttpError> => {
  if (raw === null || raw.trim().length === 0) return Effect.succeed({ _tag: "recent" });
  const text = raw.trim();
  if (/^\d+$/.test(text)) return Effect.succeed({ _tag: "seq", seq: Number(text) });
  const at = DateTime.make(text);
  return Option.isNone(at)
    ? Effect.fail(fail("invalid_request", "since must be a seq or an ISO time."))
    : Effect.succeed({ _tag: "at", at: DateTime.formatIso(at.value) });
};

const makeRoutes = Effect.gen(function* () {
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const missions = yield* MissionService.MissionService;

  const authenticate = (
    scope: typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope,
  ) =>
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

  const handle = <R>(
    effect: Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      MissionsHttpError | MissionError,
      R
    >,
  ) =>
    effect.pipe(
      Effect.catchTags({
        MissionsHttpError: (error) => Effect.succeed(errorResponse(error)),
        MissionError: (error) => Effect.succeed(errorResponse(fromMissionError(error))),
      }),
      Effect.catchCause((cause) =>
        Effect.logWarning("ardud missions request failed", { cause }).pipe(
          Effect.as(errorResponse(fail("internal", "Internal error."))),
        ),
      ),
    );

  const status = Effect.gen(function* () {
    yield* authenticate(AuthOrchestrationReadScope);
    const params = yield* searchParams;
    const missionId = yield* missionParam(params.get("mission"));
    if (missionId === null) {
      const snapshot = yield* missions.listSnapshot;
      return json({ ok: true, ...snapshot });
    }
    return json({ ok: true, overview: yield* missions.overview(missionId) });
  });

  const digest = Effect.gen(function* () {
    yield* authenticate(AuthOrchestrationReadScope);
    const params = yield* searchParams;
    const missionId = yield* missionParam(params.get("mission"));
    if (missionId === null) {
      return yield* fail("invalid_request", "digest needs ?mission=<id>.");
    }
    const since = yield* parseSince(params.get("since"));
    return json({ ok: true, ...(yield* missions.digest(missionId, since)) });
  });

  const inbox = Effect.gen(function* () {
    yield* authenticate(AuthOrchestrationReadScope);
    const params = yield* searchParams;
    const missionId = yield* missionParam(params.get("mission"));
    return json({ ok: true, inbox: yield* missions.inbox(missionId) });
  });

  const write = <I>(
    decode: (input: unknown) => Effect.Effect<I, Schema.SchemaError>,
    run: (
      provenance: MissionProvenance,
      input: I,
    ) => Effect.Effect<MissionMutationResult, MissionError>,
  ) =>
    Effect.gen(function* () {
      yield* authenticate(AuthOrchestrationOperateScope);
      const provenance = yield* agentProvenance;
      const input = yield* decodeBody(decode);
      return json({ ok: true, ...(yield* run(provenance, input)) });
    });

  const p = MISSIONS_ROUTE_PREFIX;
  return [
    HttpRouter.route("GET", `${p}/status`, handle(status)),
    HttpRouter.route("GET", `${p}/digest`, handle(digest)),
    HttpRouter.route("GET", `${p}/inbox`, handle(inbox)),
    HttpRouter.route(
      "POST",
      `${p}/mission`,
      handle(write(decodeUpdateMission, missions.updateMission)),
    ),
    HttpRouter.route(
      "POST",
      `${p}/sub-missions`,
      handle(write(decodeUpsertSubMission, missions.upsertSubMission)),
    ),
    HttpRouter.route(
      "POST",
      `${p}/sub-missions/reorder`,
      handle(write(decodeReorder, missions.reorderSubMissions)),
    ),
    HttpRouter.route(
      "POST",
      `${p}/milestones`,
      handle(write(decodeUpsertMilestone, missions.upsertMilestone)),
    ),
    HttpRouter.route("POST", `${p}/lanes`, handle(write(decodeUpsertLane, missions.upsertLane))),
    HttpRouter.route(
      "POST",
      `${p}/work-items`,
      handle(write(decodeUpsertWorkItem, missions.upsertWorkItem)),
    ),
  ] as const;
});

export const missionsRouteLayer = HttpRouter.addAll(makeRoutes);
