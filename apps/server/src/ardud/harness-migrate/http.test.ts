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
import { routes, summarizePlan } from "./http.ts";

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
const rolledBack: Cutover.CutoverStatus = {
  ...status,
  active: true,
  items: [
    {
      key: "thread:interrupted",
      kind: "thread",
      ref: "interrupted",
      payload: null,
      wake: false,
      state: "failed",
      phase: "switch",
      attempts: 3,
      reason: "failed",
      rolledBack: true,
      rollbackAttempts: 1,
    },
  ],
};
const make = (
  options: {
    state?: Cutover.CutoverStatus;
    prepared?: Input.CutoverInputSource["Service"]["readOptional"];
  } = {},
) =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const state = options.state ?? status;
    const execute = <A>(name: string, value: A) =>
      Effect.sync(() => {
        calls.push(name);
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
it.effect.each([status, rolledBack])(
  "prepared claims never reclaim rolled-back ledger threads (%j)",
  (state) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { request } = yield* make({ state, prepared: Effect.succeed(claims) });
        assert.deepStrictEqual(
          (yield* request("status", "read")).body,
          success({
            ...state,
            active: true,
            claimedThreadIds: state.items.length ? [] : ["interrupted"],
            claimedRuns: state.items.length ? [] : claims.interruptedThreads,
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

it("summarizes a plan without payloads", () => {
  const summary = summarizePlan({
    readiness: [{ id: "native", ready: false, reason: "evidence missing" }],
    items: [
      { key: "thread:a", kind: "thread", ref: "a", payload: { big: "x".repeat(100) }, wake: true },
      { key: "thread:b", kind: "thread", ref: "b", payload: {}, wake: false },
      { key: "settings:model", kind: "selection", ref: "settings", payload: {}, wake: false },
    ],
    refusals: [
      { ref: "c", reason: "unknown model" },
      { ref: "d", reason: "unknown model" },
    ],
  });
  assert.deepStrictEqual(summary.kinds, { thread: 2, selection: 1 });
  assert.deepStrictEqual(summary.scopes, { thread: 2, settings: 1 });
  assert.strictEqual(summary.wakeThreads, 1);
  assert.deepStrictEqual(summary.refusalReasons, { "unknown model": 2 });
  assert.ok(!JSON.stringify(summary).includes("xxxx"));
});
