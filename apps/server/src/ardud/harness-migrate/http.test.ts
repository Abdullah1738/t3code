import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { AuthSessionId, RunId, ThreadId, type AuthEnvironmentScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Etag, HttpPlatform, HttpRouter } from "effect/http";
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as Startup from "../../serverRuntimeStartup.ts";
import * as Cutover from "./CutoverEngine.ts";
import * as Input from "./CutoverInput.ts";
import * as Job from "./CutoverJob.ts";
import { routes } from "./http.ts";

const status: Cutover.CutoverStatus = {
  active: false,
  completed: false,
  claimedThreadIds: [],
  claimedRuns: [],
  items: [],
  refusals: [],
};
const plan: Cutover.CutoverPlan = {
  readiness: [{ id: "native", ready: true, reason: "ready" }],
  items: [],
  refusals: [],
};
const claims: Input.CutoverInput = {
  version: 1,
  stoppedCards: [],
  interruptedThreads: [{ threadId: ThreadId.make("interrupted"), runId: RunId.make("source-run") }],
};
const platform = HttpPlatform.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(Etag.layerWeak),
);
const scopes: Record<string, ReadonlyArray<AuthEnvironmentScope>> = {
  "Bearer read": ["orchestration:read"],
  "Bearer maintain": ["environment:maintain"],
};
const success = (cutover: unknown) => ({ ok: true, cutover });
const make = (
  options: {
    state?: Cutover.CutoverStatus;
    prepared?: Input.CutoverInputSource["Service"]["readOptional"];
    failure?: "refused" | "defect";
  } = {},
) =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const state = options.state ?? status;
    const execute = <A>(name: string, value: A) =>
      Effect.gen(function* () {
        calls.push(name);
        if (options.failure === "refused")
          return yield* new Cutover.CutoverError({ operation: "readiness" });
        if (options.failure === "defect") return yield* Effect.die("private failure");
        return value;
      });
    const dependencies = Layer.mergeAll(
      Layer.mock(EnvironmentAuth.EnvironmentAuth)({
        authenticateHttpRequest: (request) => {
          const token = request.headers.authorization;
          if (!token || token === "Bearer invalid")
            return Effect.fail(new EnvironmentAuth.ServerAuthInvalidCredentialError({}));
          return Effect.succeed({
            sessionId: AuthSessionId.make("cutover-test"),
            subject: "test",
            method: "bearer-access-token",
            scopes: scopes[token] ?? [],
          });
        },
      }),
      Layer.mock(Startup.ServerRuntimeStartup)({ awaitCommandReady: Effect.void }),
      Layer.succeed(Cutover.HarnessCutover, {
        plan: () => execute("plan", plan),
        status: () => execute("status", state),
        run: () => Effect.die("HTTP must use the paced job"),
      }),
      Layer.succeed(Job.CutoverJob, { start: () => execute("run", state) }),
      Layer.mock(Input.CutoverInputSource)({
        readOptional: options.prepared ?? Effect.succeed(null),
      }),
    );
    const routeLayer = routes.pipe(Layer.provide(dependencies), Layer.provide(platform));
    const web = yield* Effect.acquireRelease(
      Effect.sync(() => HttpRouter.toWebHandler(routeLayer, { disableLogger: true })),
      (handler) => Effect.promise(() => handler.dispose()),
    );
    const request = (action: "plan" | "run" | "status", token?: string) =>
      Effect.promise(async () => {
        const response = await web.handler(
          new Request(`http://test.local/api/ardud/control/harness-cutover/${action}`, {
            method: action === "run" ? "POST" : "GET",
            headers: token ? { authorization: `Bearer ${token}` } : {},
            ...(action === "run" ? { body: "{}" } : {}),
          }),
        );
        return {
          status: response.status,
          body: (await response.json()) as unknown,
          cache: response.headers.get("cache-control"),
        };
      });
    return { request, calls };
  });
it.effect("requires authentication on every route and read/maintain scopes separately", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { request, calls } = yield* make();
      for (const action of ["plan", "status", "run"] as const) {
        for (const token of [undefined, "invalid"]) {
          const response = yield* request(action, token);
          assert.strictEqual(response.status, 401);
          assert.deepStrictEqual(response.body, {
            ok: false,
            error: { code: "unauthorized", message: "A valid bearer token is required." },
          });
        }
        assert.strictEqual((yield* request(action, "none")).status, 403);
      }
      assert.strictEqual((yield* request("run", "read")).status, 403);
      assert.strictEqual((yield* request("plan", "maintain")).status, 403);
      assert.strictEqual((yield* request("status", "maintain")).status, 403);
      assert.deepStrictEqual(calls, []);
    }),
  ),
);
it.effect("returns uncached plan/status schemas and starts run only through the paced job", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { request, calls } = yield* make();
      for (const action of ["plan", "status", "run"] as const) {
        const response = yield* request(action, action === "run" ? "maintain" : "read");
        assert.deepStrictEqual(response, {
          status: 200,
          cache: "no-store",
          body: success(action === "plan" ? plan : status),
        });
      }
      assert.deepStrictEqual(calls, ["plan", "status", "run"]);
    }),
  ),
);
it.effect("status exposes prepared claims before a ledger exists without starting work", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { request } = yield* make({ prepared: Effect.succeed(claims) });
      assert.deepStrictEqual(
        (yield* request("status", "read")).body,
        success({
          ...status,
          active: true,
          claimedThreadIds: ["interrupted"],
          claimedRuns: claims.interruptedThreads,
        }),
      );
    }),
  ),
);
it.effect("bad preparation fails closed until cutover is completed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const error = new Input.CutoverInputError({ cause: "private details" });
      const prepared = Effect.fail(error);
      const pending = yield* make({ prepared });
      assert.deepStrictEqual(yield* pending.request("status", "read"), {
        status: 503,
        cache: "no-store",
        body: { ok: false, error: { code: "preparation_unavailable", message: error.message } },
      });
      const state = { ...status, completed: true };
      const { request } = yield* make({ prepared, state });
      assert.deepStrictEqual((yield* request("status", "read")).body, success(state));
    }),
  ),
);
it.effect.each(["refused", "defect"] as const)(
  "maps %s failures without leaking causes",
  (failure) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { request } = yield* make({ failure });
        const response = yield* request("run", "maintain");
        assert.strictEqual(response.status, failure === "refused" ? 409 : 503);
        assert.deepStrictEqual(response.body, {
          ok: false,
          error:
            failure === "refused"
              ? {
                  code: "cutover_refused",
                  message: "Harness cutover failed during readiness.",
                  operation: "readiness",
                }
              : { code: "unavailable", message: "Harness cutover unavailable." },
        });
      }),
    ),
);
