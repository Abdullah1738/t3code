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
import * as PendingContext from "./CutoverContext.ts";
import * as Projections from "../../orchestration-v2/ProjectionStore.ts";
import * as Job from "./CutoverJob.ts";

const prefix = "/api/ardud/control/harness-cutover";
const json = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, {
    status,
    headers: { "cache-control": "no-store" },
  });

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
              ...status,
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
        return json({ ok: true, cutover: yield* action === "run" ? job.start() : cutover.plan() });
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
          Layer.provide(PendingContext.layer),
          Layer.provide(Projections.layer),
        ),
      ),
    ),
  ),
  Layer.provide(Input.layer),
);
