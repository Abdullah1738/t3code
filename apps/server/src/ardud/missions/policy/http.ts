import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  BindRoleInput,
  CreatePoolInput,
  CreateRoleInput,
  EditReviewPolicyInput,
  MissionId,
  PoolId,
  ReconcileHoldInput,
  RecordCriticalityInput,
  RecordReviewInput,
  ReleaseHoldInput,
  RenewHoldInput,
  RetireRoleInput,
  ReviewPlanRequest,
  RoleId,
  SetCriticalityGuideInput,
  SetPoolCapacityInput,
  SetRoleModelInput,
  SucceedRoleInput,
  TakeHoldInput,
  ThreadId,
  UnbindRoleInput,
  UpdatePoolInput,
  UpdateRoleInput,
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
import { PolicyService } from "./PolicyService.ts";
import { PoolSource } from "./sources.ts";

/**
 * Policy routes under /api/ardud/missions: roles, review policy and plan,
 * pools and holds, and the governor. Same bearer auth and `{ ok, ... }`
 * envelope as the rest of the missions API.
 *
 * A token holder is never the owner. A write that names its thread in
 * `x-t3-thread-id` (optionally `x-t3-role-id`) acts as that agent. A named
 * server component (`x-t3-component`, one of POLICY_COMPONENTS: crw) acts in
 * its own name, so its holds and review records say who took them. Anything
 * else (scripts) acts as the control API. Components and the control API may
 * do what a master may.
 */
export const POLICY_CONTROL_PROVENANCE: MissionProvenance = {
  _tag: "system",
  component: "control-api",
};

/** Components that call the policy routes in their own name with the control token. */
export const POLICY_COMPONENTS: ReadonlySet<string> = new Set(["crw"]);

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
const decodeThreadId = Schema.decodeUnknownEffect(ThreadId);
const decodeRoleId = Schema.decodeUnknownEffect(RoleId);

const SetPoolSourceBody = Schema.Struct({ poolId: PoolId, source: Schema.NullOr(PoolSource) });

const decode = {
  createRole: Schema.decodeUnknownEffect(CreateRoleInput),
  updateRole: Schema.decodeUnknownEffect(UpdateRoleInput),
  retireRole: Schema.decodeUnknownEffect(RetireRoleInput),
  setRoleModel: Schema.decodeUnknownEffect(SetRoleModelInput),
  bindRole: Schema.decodeUnknownEffect(BindRoleInput),
  unbindRole: Schema.decodeUnknownEffect(UnbindRoleInput),
  succeedRole: Schema.decodeUnknownEffect(SucceedRoleInput),
  editReviewPolicy: Schema.decodeUnknownEffect(EditReviewPolicyInput),
  setCriticalityGuide: Schema.decodeUnknownEffect(SetCriticalityGuideInput),
  recordCriticality: Schema.decodeUnknownEffect(RecordCriticalityInput),
  recordReview: Schema.decodeUnknownEffect(RecordReviewInput),
  reviewPlan: Schema.decodeUnknownEffect(ReviewPlanRequest),
  createPool: Schema.decodeUnknownEffect(CreatePoolInput),
  updatePool: Schema.decodeUnknownEffect(UpdatePoolInput),
  setPoolCapacity: Schema.decodeUnknownEffect(SetPoolCapacityInput),
  setPoolSource: Schema.decodeUnknownEffect(SetPoolSourceBody),
  takeHold: Schema.decodeUnknownEffect(TakeHoldInput),
  releaseHold: Schema.decodeUnknownEffect(ReleaseHoldInput),
  renewHold: Schema.decodeUnknownEffect(RenewHoldInput),
  reconcileHold: Schema.decodeUnknownEffect(ReconcileHoldInput),
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

/** The calling agent or named component from its headers, else the control API. */
const callerProvenance = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const threadHeader = request.headers["x-t3-thread-id"];
  const component = request.headers["x-t3-component"]?.trim() ?? "";
  if (threadHeader === undefined || threadHeader.trim().length === 0) {
    if (component.length === 0) return POLICY_CONTROL_PROVENANCE;
    if (!POLICY_COMPONENTS.has(component)) {
      return yield* fail("forbidden", `x-t3-component ${component} is not a known component.`);
    }
    return { _tag: "system", component } satisfies MissionProvenance;
  }
  if (component.length > 0) {
    return yield* fail("invalid_request", "Name a thread or a component, not both.");
  }
  const threadId = yield* decodeThreadId(threadHeader.trim()).pipe(
    Effect.mapError(() => fail("invalid_request", "x-t3-thread-id is not a thread id.")),
  );
  const roleHeader = request.headers["x-t3-role-id"];
  const roleId =
    roleHeader === undefined || roleHeader.trim().length === 0
      ? null
      : yield* decodeRoleId(roleHeader.trim()).pipe(
          Effect.mapError(() => fail("invalid_request", "x-t3-role-id is not a role id.")),
        );
  return { _tag: "agent", threadId, roleId } satisfies MissionProvenance;
});

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
      yield* authenticate(AuthOrchestrationOperateScope);
      const provenance = yield* callerProvenance;
      const input = yield* decodeBody(decodeInput);
      return json({ ok: true, ...(yield* run(provenance, input)) });
    });

  const roles = Effect.gen(function* () {
    yield* authenticate(AuthOrchestrationReadScope);
    return json({ ok: true, ...(yield* policy.roles(yield* requireMissionQuery)) });
  });

  const reviewPolicy = Effect.gen(function* () {
    yield* authenticate(AuthOrchestrationReadScope);
    return json({ ok: true, ...(yield* policy.reviewPolicy(yield* requireMissionQuery)) });
  });

  // A read, so the read scope is enough. With `facts` it also records a fired hard trigger.
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

  return [
    HttpRouter.route("GET", `${p}/roles`, handle(roles)),
    post("/roles", decode.createRole, policy.createRole),
    post("/roles/update", decode.updateRole, policy.updateRole),
    post("/roles/retire", decode.retireRole, policy.retireRole),
    post("/roles/model", decode.setRoleModel, policy.setRoleModel),
    post("/roles/bind", decode.bindRole, policy.bindRole),
    post("/roles/unbind", decode.unbindRole, policy.unbindRole),
    post("/roles/succeed", decode.succeedRole, policy.succeedRole),
    HttpRouter.route("GET", `${p}/review-policy`, handle(reviewPolicy)),
    post("/review-policy", decode.editReviewPolicy, policy.editReviewPolicy),
    post("/review-policy/guide", decode.setCriticalityGuide, policy.setCriticalityGuide),
    post("/criticality", decode.recordCriticality, policy.recordCriticality),
    post("/reviews", decode.recordReview, policy.recordReview),
    HttpRouter.route("POST", `${p}/review-plan`, handle(reviewPlan)),
    HttpRouter.route("GET", `${p}/pools`, handle(pools)),
    post("/pools", decode.createPool, policy.createPool),
    post("/pools/update", decode.updatePool, policy.updatePool),
    post("/pools/capacity", decode.setPoolCapacity, policy.setPoolCapacity),
    post("/pools/source", decode.setPoolSource, policy.setPoolSource),
    post("/pools/holds", decode.takeHold, policy.takeHold),
    post("/pools/holds/release", decode.releaseHold, policy.releaseHold),
    post("/pools/holds/renew", decode.renewHold, (provenance, input) =>
      policy.renewHold(provenance, input).pipe(Effect.map((hold) => ({ hold }))),
    ),
    post("/pools/holds/reconcile", decode.reconcileHold, policy.reconcileHold),
    HttpRouter.route("GET", `${p}/governor`, handle(governor)),
  ] as const;
});

export const policyRouteLayer = HttpRouter.addAll(makeRoutes);
