import { AuthEnvironmentMaintainScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServerRuntimeStartup from "../../serverRuntimeStartup.ts";
import * as Cutover from "./CutoverEngine.ts";
import * as Actions from "./CutoverActions.ts";
import * as Store from "./CutoverStore.ts";
import * as Input from "./CutoverInput.ts";
import * as Readiness from "./CutoverReadiness.ts";
import * as Projections from "../../orchestration-v2/ProjectionStore.ts";
import * as Job from "./CutoverJob.ts";

const prefix = "/api/ardud/control/harness-cutover";
const json = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, {
    status,
    headers: { "cache-control": "no-store" },
  });

export const summarizePlan = (plan: Cutover.CutoverPlan) => {
  const kinds: Record<string, number> = {};
  const scopes: Record<string, number> = {};
  let wake = 0;
  for (const item of plan.items) {
    kinds[item.kind] = (kinds[item.kind] ?? 0) + 1;
    const scope = item.key.split(":")[0] ?? item.kind;
    scopes[scope] = (scopes[scope] ?? 0) + 1;
    if (item.wake) wake++;
  }
  const refusalReasons: Record<string, number> = {};
  for (const refusal of plan.refusals)
    refusalReasons[refusal.reason] = (refusalReasons[refusal.reason] ?? 0) + 1;
  return {
    summary: true,
    items: plan.items.length,
    kinds,
    scopes,
    wakeThreads: wake,
    readiness: plan.readiness,
    refusals: plan.refusals.length,
    refusalReasons,
    refusalSamples: plan.refusals.slice(0, 20),
    itemSamples: plan.items
      .slice(0, 10)
      .map(({ key, kind, ref, wake }) => ({ key, kind, ref, wake })),
  };
};

/**
 * Status without per-item payloads. 7 Nov 2026: a production status listed every ledger item
 * with its payload (~436 MB), which the 16 MiB reply cap only rejected after building it.
 * Callers (stream-recovery, the installer) read only active/completed/claims; `?items=1` adds a
 * small per-item view without payloads.
 */
export const summarizeStatus = (status: Cutover.CutoverStatus, withItems = false) => {
  const counts: Record<string, number> = {};
  const reasons: Record<string, number> = {};
  for (const item of status.items) {
    const key = `${item.kind}:${item.state}`;
    counts[key] = (counts[key] ?? 0) + 1;
    if (item.reason !== null) reasons[item.reason] = (reasons[item.reason] ?? 0) + 1;
  }
  return {
    active: status.active,
    completed: status.completed,
    claimedThreadIds: status.claimedThreadIds,
    claimedRuns: status.claimedRuns,
    refusals: status.refusals,
    counts,
    reasons,
    ...(withItems
      ? {
          items: status.items.map(
            ({
              key,
              kind,
              ref,
              wake,
              state,
              phase,
              attempts,
              reason,
              rollbackAttempts,
              rolledBack,
            }) => ({
              key,
              kind,
              ref,
              wake,
              state,
              phase,
              attempts,
              reason,
              rollbackAttempts,
              rolledBack,
            }),
          ),
        }
      : {}),
  };
};

export const routes = HttpRouter.addAll(
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
    const cutover = yield* Cutover.HarnessCutover;
    const job = yield* Job.CutoverJob;
    const input = yield* Input.CutoverInputSource;
    const handle = Effect.fn("HarnessCutoverHttp.handle")(
      function* (action: "plan" | "run" | "status") {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const session = yield* auth.authenticateHttpRequest(request).pipe(Effect.result);
        if (session._tag === "Failure")
          return json(
            {
              ok: false,
              error: { code: "unauthorized", message: "A valid bearer token is required." },
            },
            401,
          );
        const scope = action === "run" ? AuthEnvironmentMaintainScope : AuthOrchestrationReadScope;
        if (!session.success.scopes.includes(scope))
          return json(
            { ok: false, error: { code: "forbidden", message: `This token lacks ${scope}.` } },
            403,
          );
        yield* startup.awaitCommandReady;
        const url = new URL(request.url, "http://localhost");
        // Per-item rows (no payloads) only on request: 36k items are ~11 MB even without payloads.
        const withItems = url.searchParams.get("items") === "1";
        if (action === "status") {
          const status = yield* cutover.status();
          const prepared = yield* input.readOptional.pipe(Effect.result);
          if (prepared._tag === "Failure" && !status.completed)
            return json(
              {
                ok: false,
                error: { code: "preparation_unavailable", message: prepared.failure.message },
              },
              503,
            );
          const claims = prepared._tag === "Success" ? prepared.success : null;
          const ledgerThreads = new Set(
            status.items.filter((item) => item.kind === "thread").map((item) => item.ref),
          );
          const preparedRuns =
            claims?.interruptedThreads.filter((row) => !ledgerThreads.has(row.threadId)) ?? [];
          const preparedCards =
            claims?.stoppedCards.filter((row) => !ledgerThreads.has(row.thread)) ?? [];
          return json({
            ok: true,
            cutover: {
              ...summarizeStatus(status, withItems),
              active: status.active || (!status.completed && claims !== null),
              claimedThreadIds: [
                ...new Set([
                  ...status.claimedThreadIds,
                  ...preparedRuns.map((row) => row.threadId),
                  ...preparedCards.map((row) => row.thread),
                ]),
              ],
              claimedRuns: [...status.claimedRuns, ...preparedRuns],
            },
          });
        }
        if (action === "run")
          return json({ ok: true, cutover: summarizeStatus(yield* job.start(), withItems) });
        const plan = yield* cutover.plan();
        // A production plan lists every thread with its payload and passes the
        // control API's 16 MiB reply cap; ?summary=1 returns counts instead.
        return json({
          ok: true,
          cutover: url.searchParams.get("summary") === "1" ? summarizePlan(plan) : plan,
        });
      },
      Effect.catchTags({
        CutoverError: (error) =>
          Effect.succeed(
            json(
              {
                ok: false,
                error: {
                  code: "cutover_refused",
                  message: error.message,
                  operation: error.operation,
                },
              },
              409,
            ),
          ),
      }),
      Effect.catchCause(() =>
        Effect.succeed(
          json(
            { ok: false, error: { code: "unavailable", message: "Harness cutover unavailable." } },
            503,
          ),
        ),
      ),
    );
    return [
      HttpRouter.route("GET", `${prefix}/plan`, handle("plan")),
      HttpRouter.route("POST", `${prefix}/run`, handle("run")),
      HttpRouter.route("GET", `${prefix}/status`, handle("status")),
    ];
  }),
);

export const harnessCutoverRouteLayer = routes.pipe(
  Layer.provideMerge(Job.layer),
  Layer.provide(
    Cutover.layer.pipe(
      Layer.provide(Store.layer),
      Layer.provide(
        Actions.layer.pipe(
          Layer.provide(Readiness.layer),
          Layer.provide(Input.layer),
          Layer.provide(Projections.layer),
        ),
      ),
    ),
  ),
  Layer.provide(Input.layer),
);
