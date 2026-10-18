import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  MissionId,
  RecordReviewInput,
  RecordTriggerFactsInput,
  ReleaseHoldInput,
  RenewHoldInput,
  ReviewPlanRequest,
  TakeHoldInput,
  type MissionError,
  type MissionErrorCode,
  type MissionProvenance,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import { MISSIONS_ROUTE_PREFIX } from "../http.ts";
import { componentProvenance } from "../core/provenance.ts";
import { PolicyService } from "./PolicyService.ts";

/**
 * Policy routes under /api/ardud/missions: roles, review policy and plan,
 * pools and holds, and the governor. Same bearer auth and `{ ok, ... }`
 * envelope as the rest of the missions API.
 *
 * ardud missions: core (H3). Who calls comes from the token, never from a
 * header. A component credential (`t3 ardud component-token issue crw`)
 * acts as that component; the shared control token acts as the control API
 * until cutover. Either way HTTP only carries reads and the named operations
 * crw needs: record a review, report PR facts, take, renew and release a
 * hold. Governance (roles, review policy, verdicts, pool admin) needs a
 * proven thread or the owner, so it goes through the MCP tools or the app.
 */
export const POLICY_CONTROL_PROVENANCE: MissionProvenance = {
  _tag: "system",
  component: "control-api",
};

/** Components whose credential may make the named policy writes in their own name. */
export const POLICY_COMPONENTS: ReadonlySet<string> = new Set(["crw"]);

/** Headers older callers sent to claim an identity. Refused, so nobody thinks they still work. */
const IDENTITY_HEADERS = ["x-t3-thread-id", "x-t3-role-id", "x-t3-component"] as const;

type HttpErrorCode =
  | "unauthorized"
  | "forbidden"
  | "invalid_request"
  | "not_found"
  | "conflict"
  | "internal";

class PolicyHttpError extends Data.TaggedError("PolicyHttpError")<{
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

const fail = (code: HttpErrorCode, message: string) => new PolicyHttpError({ code, message });

const fromMissionError = (error: MissionError) =>
  new PolicyHttpError({
    code: HTTP_CODE[error.code],
    message: error.detail,
    missionCode: error.code,
  });

const json = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: { "cache-control": "no-store" } });

const errorResponse = (error: PolicyHttpError) =>
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
const decode = {
  recordReview: Schema.decodeUnknownEffect(RecordReviewInput),
  recordTriggerFacts: Schema.decodeUnknownEffect(RecordTriggerFactsInput),
  reviewPlan: Schema.decodeUnknownEffect(ReviewPlanRequest),
  takeHold: Schema.decodeUnknownEffect(TakeHoldInput),
  releaseHold: Schema.decodeUnknownEffect(ReleaseHoldInput),
  renewHold: Schema.decodeUnknownEffect(RenewHoldInput),
};

const searchParams = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  return Option.isSome(url) ? url.value.searchParams : new URLSearchParams();
});

/** `?missionId=` (what crw sends) or `?mission=` (the rest of the missions API). */
const missionQuery = Effect.gen(function* () {
  const params = yield* searchParams;
  const raw = (params.get("missionId") ?? params.get("mission") ?? "").trim();
  if (raw.length === 0) return null;
  return yield* decodeMissionId(raw).pipe(
    Effect.mapError(() => fail("invalid_request", "missionId must be a mission id.")),
  );
});

const requireMissionQuery = missionQuery.pipe(
  Effect.flatMap((missionId) =>
    missionId === null
      ? Effect.fail(fail("invalid_request", "This read needs ?missionId=<id>."))
      : Effect.succeed(missionId),
  ),
);

const decodeBody = <A>(decodeInput: (input: unknown) => Effect.Effect<A, Schema.SchemaError>) =>
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
    return yield* decodeInput(raw).pipe(
      Effect.mapError((error) => fail("invalid_request", error.message)),
    );
  });

/**
 * The caller, from its session alone: a component credential is that
 * component; any other token is the control API.
 */
const callerProvenance = (session: EnvironmentAuth.AuthenticatedSession) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const header = IDENTITY_HEADERS.find((name) => request.headers[name] !== undefined);
    if (header !== undefined) {
      return yield* fail(
        "invalid_request",
        `${header} is not accepted. The token says who is calling; thread writes go through the MCP tools.`,
      );
    }
    const component = componentProvenance(session);
    if (component === null) return POLICY_CONTROL_PROVENANCE;
    if (component._tag === "system" && !POLICY_COMPONENTS.has(component.component)) {
      return yield* fail("forbidden", `${component.component} does not write policy records.`);
    }
    return component;
  });

/** Governance over HTTP: refused with the MCP tool to use instead. */
const GOVERNANCE_TOOLS = {
  "/roles": "mission_role_create",
  "/roles/update": "mission_role_update",
  "/roles/retire": "mission_role_retire",
  "/roles/model": "mission_role_model",
  "/roles/bind": "mission_role_bind",
  "/roles/unbind": "mission_role_unbind",
  "/roles/succeed": "mission_role_succeed",
  "/review-policy": "mission_review_policy_edit",
  "/review-policy/guide": "mission_criticality_guide",
  "/criticality": "mission_criticality",
  "/pools": "mission_pool_create",
  "/pools/update": "mission_pool_update",
  "/pools/capacity": "mission_pool_capacity",
  "/pools/source": "the crw import",
  "/pools/holds/reconcile": "mission_hold_reconcile",
} as const;

const makeRoutes = Effect.gen(function* () {
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const policy = yield* PolicyService;

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

  const handle = <R>(
    effect: Effect.Effect<HttpServerResponse.HttpServerResponse, PolicyHttpError | MissionError, R>,
  ) =>
    effect.pipe(
      Effect.catchTags({
        PolicyHttpError: (error) => Effect.succeed(errorResponse(error)),
        MissionError: (error) => Effect.succeed(errorResponse(fromMissionError(error))),
      }),
      Effect.catchCause((cause) =>
        Effect.logWarning("ardud mission policy request failed", { cause }).pipe(
          Effect.as(errorResponse(fail("internal", "Internal error."))),
        ),
      ),
    );

  /** A write: decode the body, run it as the caller, return `{ ok, ...result }`. */
  const write = <I, A extends object>(
    decodeInput: (input: unknown) => Effect.Effect<I, Schema.SchemaError>,
    run: (provenance: MissionProvenance, input: I) => Effect.Effect<A, MissionError>,
  ) =>
    Effect.gen(function* () {
      const session = yield* authenticate(AuthOrchestrationOperateScope);
      const provenance = yield* callerProvenance(session);
      const input = yield* decodeBody(decodeInput);
      return json({ ok: true, ...(yield* run(provenance, input)) });
    });

  const refuseGovernance = (tool: string) =>
    Effect.gen(function* () {
      yield* authenticate(AuthOrchestrationOperateScope);
      return yield* new PolicyHttpError({
        code: "forbidden",
        message: `HTTP cannot prove a thread or the owner, so governance is not taken here. Use ${tool} from the mission's master thread, or the Robob app.`,
        missionCode: "provenance-required",
      });
    });

  const roles = Effect.gen(function* () {
    yield* authenticate(AuthOrchestrationReadScope);
    return json({ ok: true, ...(yield* policy.roles(yield* requireMissionQuery)) });
  });

  const reviewPolicy = Effect.gen(function* () {
    yield* authenticate(AuthOrchestrationReadScope);
    return json({ ok: true, ...(yield* policy.reviewPolicy(yield* requireMissionQuery)) });
  });

  // A pure read, so the read scope is enough. Facts preview a trigger; they never record one.
  const reviewPlan = Effect.gen(function* () {
    yield* authenticate(AuthOrchestrationReadScope);
    const request = yield* decodeBody(decode.reviewPlan);
    return json({ ok: true, plan: yield* policy.reviewPlan(request) });
  });

  const pools = Effect.gen(function* () {
    yield* authenticate(AuthOrchestrationReadScope);
    const missionId = yield* missionQuery;
    return json({
      ok: true,
      ...(yield* policy.pools(missionId === null ? {} : { missionId })),
    });
  });

  const governor = Effect.gen(function* () {
    yield* authenticate(AuthOrchestrationReadScope);
    return json({ ok: true, ...(yield* policy.governor) });
  });

  const p = MISSIONS_ROUTE_PREFIX;
  const post = <I, A extends object>(
    path: string,
    decodeInput: (input: unknown) => Effect.Effect<I, Schema.SchemaError>,
    run: (provenance: MissionProvenance, input: I) => Effect.Effect<A, MissionError>,
  ) => HttpRouter.route("POST", `${p}${path}`, handle(write(decodeInput, run)));

  const refused = Object.entries(GOVERNANCE_TOOLS).map(([path, tool]) =>
    HttpRouter.route("POST", `${p}${path}`, handle(refuseGovernance(tool))),
  );

  return [
    HttpRouter.route("GET", `${p}/roles`, handle(roles)),
    HttpRouter.route("GET", `${p}/review-policy`, handle(reviewPolicy)),
    post("/reviews", decode.recordReview, policy.recordReview),
    // ardud missions: core (M2) - verified PR facts, recorded in the reporter's name.
    post("/criticality/facts", decode.recordTriggerFacts, policy.recordTriggerFacts),
    HttpRouter.route("POST", `${p}/review-plan`, handle(reviewPlan)),
    HttpRouter.route("GET", `${p}/pools`, handle(pools)),
    post("/pools/holds", decode.takeHold, policy.takeHold),
    post("/pools/holds/release", decode.releaseHold, policy.releaseHold),
    post("/pools/holds/renew", decode.renewHold, (provenance, input) =>
      policy.renewHold(provenance, input).pipe(Effect.map((hold) => ({ hold }))),
    ),
    HttpRouter.route("GET", `${p}/governor`, handle(governor)),
    ...refused,
  ] as const;
});

export const policyRouteLayer = HttpRouter.addAll(makeRoutes);
