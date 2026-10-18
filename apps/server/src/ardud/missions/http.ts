import {
  ApprovalId,
  ApprovalStatus,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CloseStaleApprovalInput,
  MissionId,
  OpenApprovalInput,
  type MissionError,
  type MissionErrorCode,
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
 * Missions HTTP API at /api/ardud/missions, for the `mission` CLI and local
 * systems. Same bearer auth and `{ ok, ... }` envelope as the control API:
 * reads need orchestration:read, writes orchestration:operate.
 *
 * A token holder is never the owner and never a thread: HTTP cannot prove
 * which thread is calling (`x-t3-thread-id` was only a claim). So the plan
 * writes that depend on the caller (the master's) are refused here and point
 * at the MCP tool, which knows the calling thread. HTTP keeps reads and
 * `system` writes by named components: crw opens and stale-closes its
 * approvals in its own name. Other tracks mount their own routes under this
 * prefix and register them in `layer.ts`.
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
const decodeApprovalIds = Schema.decodeUnknownEffect(Schema.Array(ApprovalId));
const decodeApprovalStatuses = Schema.decodeUnknownEffect(Schema.Array(ApprovalStatus));
const decodeOpenApproval = Schema.decodeUnknownEffect(OpenApprovalInput);
const decodeCloseStaleApproval = Schema.decodeUnknownEffect(CloseStaleApprovalInput);

/** Components that may open and stale-close approvals over HTTP, in their own name. */
const APPROVAL_COMPONENTS: ReadonlySet<string> = new Set(["crw"]);

/** Plan writes that only the calling thread may make, and the MCP tool to use instead. */
const THREAD_WRITES = [
  { path: "/mission", tool: "mission_update" },
  { path: "/sub-missions", tool: "mission_sub_mission" },
  { path: "/sub-missions/reorder", tool: "mission_sub_mission_reorder" },
  { path: "/milestones", tool: "mission_milestone" },
  { path: "/lanes", tool: "mission_lane" },
  { path: "/work-items", tool: "mission_work_item" },
] as const;

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

const systemProvenance = (component: string): MissionProvenance => ({
  _tag: "system",
  component,
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
      return session;
    });

  // ardud missions: core (H3)
  /**
   * The component an approval route acts for. A component credential is that
   * component and may only act for itself. The shared control token still
   * names the component in the body until cutover retires it.
   */
  const approvalComponent = (session: EnvironmentAuth.AuthenticatedSession, named: string) =>
    Effect.gen(function* () {
      const component = session.origin?._tag === "component" ? session.origin.component : null;
      if (component !== null && component !== named) {
        return yield* fail(
          "forbidden",
          `This credential is ${component}; it cannot act for ${named}.`,
        );
      }
      if (!APPROVAL_COMPONENTS.has(named)) {
        return yield* fail(
          "forbidden",
          `Only ${[...APPROVAL_COMPONENTS].join(", ")} open approvals over HTTP.`,
        );
      }
      return systemProvenance(named);
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

  const refuseThreadWrite = (tool: string) =>
    Effect.gen(function* () {
      yield* authenticate(AuthOrchestrationReadScope);
      return yield* new MissionsHttpError({
        code: "forbidden",
        message: `HTTP cannot prove which thread is calling, so this write is not taken here. Use the MCP tool ${tool} from the mission's master thread.`,
        missionCode: "provenance-required",
      });
    });

  const approvals = Effect.gen(function* () {
    yield* authenticate(AuthOrchestrationReadScope);
    const params = yield* searchParams;
    const missionId = yield* missionParam(params.get("mission"));
    if (missionId === null) {
      return yield* fail("invalid_request", "approvals needs ?mission=<id>.");
    }
    const ids = params.getAll("id");
    const statuses = params.getAll("status");
    const exact =
      ids.length === 0
        ? undefined
        : yield* decodeApprovalIds(ids).pipe(
            Effect.mapError(() => fail("invalid_request", "id must be an approval id.")),
          );
    const status =
      statuses.length === 0
        ? undefined
        : yield* decodeApprovalStatuses(statuses).pipe(
            Effect.mapError(() =>
              fail(
                "invalid_request",
                "status must be pending, approved, rejected or stale-closed.",
              ),
            ),
          );
    const found = yield* missions.approvals({
      missionId,
      ...(exact === undefined ? {} : { ids: exact }),
      ...(status === undefined ? {} : { status }),
    });
    return json({ ok: true, approvals: found });
  });

  const openApproval = Effect.gen(function* () {
    const session = yield* authenticate(AuthOrchestrationOperateScope);
    const input = yield* decodeBody(decodeOpenApproval);
    const provenance = yield* approvalComponent(session, input.requestedBy);
    const result = yield* missions.openApproval(provenance, input);
    return json({ ok: true, ...result });
  });

  const closeStaleApproval = Effect.gen(function* () {
    const session = yield* authenticate(AuthOrchestrationOperateScope);
    const input = yield* decodeBody(decodeCloseStaleApproval);
    const [record] = yield* missions.approvals({
      missionId: input.missionId,
      ids: [input.approvalId],
    });
    // A missing record falls through to the service's not-found.
    const component = record?.requestedBy ?? "crw";
    if (!APPROVAL_COMPONENTS.has(component)) {
      return yield* fail("forbidden", `Approval ${input.approvalId} was not opened over HTTP.`);
    }
    const provenance = yield* approvalComponent(session, component);
    const result = yield* missions.closeStaleApproval(provenance, input);
    return json({ ok: true, ...result });
  });

  const p = MISSIONS_ROUTE_PREFIX;
  return [
    HttpRouter.route("GET", `${p}/status`, handle(status)),
    HttpRouter.route("GET", `${p}/digest`, handle(digest)),
    HttpRouter.route("GET", `${p}/inbox`, handle(inbox)),
    HttpRouter.route("GET", `${p}/approvals`, handle(approvals)),
    HttpRouter.route("POST", `${p}/approvals/open`, handle(openApproval)),
    HttpRouter.route("POST", `${p}/approvals/stale`, handle(closeStaleApproval)),
    ...THREAD_WRITES.map(({ path, tool }) =>
      HttpRouter.route("POST", `${p}${path}`, handle(refuseThreadWrite(tool))),
    ),
  ] as const;
});

export const missionsRouteLayer = HttpRouter.addAll(makeRoutes);
