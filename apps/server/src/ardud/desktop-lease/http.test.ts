// @effect-diagnostics nodeBuiltinImport:off - these use isolated file-backed SQLite stores.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { AuthSessionId, type AuthEnvironmentScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ExecutionIdentity from "../identity/ExecutionIdentity.ts";
import { DesktopLease, QUIET_MS } from "./DesktopLease.ts";
import * as DesktopLeaseService from "./DesktopLeaseService.ts";
import { desktopLeaseRoutes } from "./http.ts";

const prefix = "/api/ardud/control/desktop-lease";
const holder = { driver: "codex", nativeId: "holder-native", agentId: "child-agent" };
const other = { driver: "codex", nativeId: "other-native" };

const makeHarness = (
  options: {
    readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
    readonly failFirstOpen?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const dir = yield* Effect.acquireRelease(
      Effect.sync(() =>
        NodeFS.mkdtempSync(NodePath.join(process.cwd(), ".desktop-lease-http-test-")),
      ),
      (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
    );
    const filename = NodePath.join(dir, "lease.sqlite");
    const resolvedInputs: ExecutionIdentity.ResolveInput[] = [];
    let opens = 0;
    let now = 1_750_000_000_000;
    const identity = Layer.mock(ExecutionIdentity.ExecutionIdentity)({
      resolve: (input) => {
        resolvedInputs.push(input);
        const resolution =
          input.nativeId === "pending"
            ? "pending"
            : input.nativeId === "ambiguous"
              ? "ambiguous"
              : input.nativeId === "missing"
                ? "unavailable"
                : "resolved";
        return Effect.succeed({
          resolution,
          robobThreadId: resolution === "resolved" ? `thread-${input.nativeId}` : null,
          rootThreadId: resolution === "resolved" ? `root-${input.nativeId}` : null,
          parentThreadId: null,
          executionKind: resolution === "resolved" ? "top-level" : null,
          driver: input.driver ?? null,
          providerInstanceId: null,
          nativeSessionId: input.nativeId,
          nativeAgentId: input.agentId ?? null,
          model: null,
          acceptsMessages: resolution === "resolved",
          candidates: resolution === "ambiguous" ? ["thread-a", "thread-b"] : [],
        });
      },
    });
    const service = DesktopLeaseService.layerWithOptions({
      filename,
      now: () => now,
      factory: (storeOptions) => {
        opens++;
        if (options.failFirstOpen && opens === 1) throw new Error("simulated open failure");
        return new DesktopLease(storeOptions);
      },
    }).pipe(Layer.provide(identity));
    const web = yield* Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          desktopLeaseRoutes.pipe(
            Layer.provide(service),
            Layer.provide(
              Layer.mock(EnvironmentAuth.EnvironmentAuth)({
                authenticateHttpRequest: () =>
                  Effect.succeed({
                    sessionId: AuthSessionId.make("desktop-lease-test"),
                    subject: "test-session",
                    method: "bearer-access-token" as const,
                    scopes: options.scopes ?? ["orchestration:read", "orchestration:operate"],
                  }),
              }),
            ),
            Layer.provide(
              HttpPlatform.layer.pipe(
                Layer.provideMerge(NodeServices.layer),
                Layer.provideMerge(Etag.layerWeak),
              ),
            ),
          ),
          { disableLogger: true },
        ),
      ),
      (handler) => Effect.promise(() => handler.dispose()),
    );
    const request = (method: "GET" | "POST", path: string, payload?: unknown) =>
      Effect.promise(async () => {
        const response = await web.handler(
          new Request(`http://env.local${prefix}${path}`, {
            method,
            headers: { authorization: "Bearer test", "content-type": "application/json" },
            ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
          }),
        );
        return {
          status: response.status,
          body: (await response.json()) as {
            ticket: string;
            state: string;
            position: number | null;
            lease: {
              childThreadId: string;
              rootThreadId: string;
              ticket: string;
              state: string;
            } | null;
            status: {
              lease: { childThreadId: string; rootThreadId: string; ticket: string } | null;
            };
            error: { code: string; message: string };
          },
        };
      });
    return {
      request,
      resolvedInputs,
      opens: () => opens,
      filename,
      advance: (ms: number) => {
        now += ms;
      },
    };
  });

const run = <A, E>(
  body: (h: Effect.Success<ReturnType<typeof makeHarness>>) => Effect.Effect<A, E>,
  options?: Parameters<typeof makeHarness>[0],
) => Effect.scoped(Effect.flatMap(makeHarness(options), body));

describe("desktop lease HTTP", () => {
  it.effect(
    "refuses every unresolved identity with its resolution and does not open the store",
    () =>
      run(({ request, opens }) =>
        Effect.gen(function* () {
          for (const [nativeId, resolution] of [
            ["pending", "pending"],
            ["ambiguous", "ambiguous"],
            ["missing", "unavailable"],
          ] as const) {
            const result = yield* request("POST", "/acquire", {
              driver: "codex",
              nativeId,
              taskId: "task",
              scope: "app",
              mode: "native",
            });
            assert.strictEqual(result.status, 409);
            assert.strictEqual(result.body.error.code, "conflict");
            assert.include(result.body.error.message, resolution);
          }
          assert.strictEqual(opens(), 0);
        }),
      ),
  );

  it.effect("resolves the caller, admits calls and releases the holder", () =>
    run(({ request, resolvedInputs }) =>
      Effect.gen(function* () {
        const acquired = yield* request("POST", "/acquire", {
          ...holder,
          taskId: "task",
          scope: "app",
          mode: "native",
          childThreadId: "forged-child",
          rootThreadId: "forged-root",
        });
        assert.strictEqual(acquired.status, 200);
        assert.strictEqual(acquired.body.state, "held");
        assert.isString(acquired.body.ticket);
        assert.deepStrictEqual(resolvedInputs[0], holder);
        assert.strictEqual(acquired.body.status.lease?.childThreadId, "thread-holder-native");
        assert.strictEqual(acquired.body.status.lease?.rootThreadId, "root-holder-native");

        const status = yield* request("GET", "");
        assert.strictEqual(status.status, 200);
        assert.strictEqual(status.body.lease?.ticket, acquired.body.ticket);
        assert.strictEqual(
          (yield* request("POST", "/heartbeat", { ...holder, ticket: acquired.body.ticket }))
            .status,
          200,
        );
        assert.strictEqual(
          (yield* request("POST", "/call-start", { ...holder, toolUseId: "call-1" })).status,
          200,
        );
        assert.strictEqual(
          (yield* request("POST", "/call-end", { toolUseId: "call-1", outcome: "completed" }))
            .status,
          200,
        );
        const released = yield* request("POST", "/release", {
          ...holder,
          ticket: acquired.body.ticket,
        });
        assert.strictEqual(released.status, 200);
        assert.isNull(released.body.lease);
        assert.deepStrictEqual(resolvedInputs, [holder, holder, holder, holder]);
      }),
    ),
  );

  it.effect("denies a different resolved caller and enforces route scopes", () =>
    run(({ request }) =>
      Effect.gen(function* () {
        const acquired = yield* request("POST", "/acquire", {
          ...holder,
          taskId: "task",
          scope: "app",
          mode: "cua-driver",
        });
        assert.strictEqual(acquired.status, 200);
        assert.strictEqual(
          (yield* request("POST", "/call-start", { ...other, toolUseId: "call-2" })).status,
          409,
        );
        assert.strictEqual(
          (yield* request("POST", "/heartbeat", { ...other, ticket: acquired.body.ticket })).status,
          409,
        );
        assert.strictEqual(
          (yield* request("POST", "/release", { ...other, ticket: acquired.body.ticket })).status,
          409,
        );
        const reconcile = yield* request("POST", "/reconcile", {
          ticket: acquired.body.ticket,
          evidence: "reviewed",
        });
        assert.strictEqual(reconcile.status, 403);
        assert.strictEqual(reconcile.body.error.code, "forbidden");
        assert.strictEqual(
          (yield* request("POST", "/call-start", { ...holder, toolUseId: "call-2" })).status,
          200,
        );
        assert.strictEqual(
          (yield* request("POST", "/call-end", { toolUseId: "call-2", outcome: "failed" })).status,
          200,
        );
        assert.strictEqual(
          (yield* request("POST", "/release", { ...holder, ticket: acquired.body.ticket })).status,
          200,
        );
      }),
    ),
  );

  it.effect("reconciles a quarantined call only with maintenance scope", () =>
    run(
      ({ request, advance }) =>
        Effect.gen(function* () {
          const acquired = yield* request("POST", "/acquire", {
            ...holder,
            taskId: "task",
            scope: "app",
            mode: "native",
          });
          assert.strictEqual(acquired.status, 200);
          assert.strictEqual(
            (yield* request("POST", "/call-start", {
              ...holder,
              toolUseId: "long-call",
            })).status,
            200,
          );
          advance(QUIET_MS);
          const quarantined = yield* request("GET", "");
          assert.strictEqual(quarantined.status, 200);
          assert.strictEqual(quarantined.body.lease?.state, "quarantined");
          const reconciled = yield* request("POST", "/reconcile", {
            ticket: acquired.body.ticket,
            evidence: "controller checked",
          });
          assert.strictEqual(reconciled.status, 200);
          assert.isNull(reconciled.body.lease);
        }),
      { scopes: ["orchestration:read", "orchestration:operate", "environment:maintain"] },
    ),
  );

  it.effect("checks operate scope before opening the store", () =>
    run(
      ({ request, opens }) =>
        Effect.gen(function* () {
          assert.strictEqual(
            (yield* request("POST", "/acquire", {
              ...holder,
              taskId: "task",
              scope: "app",
              mode: "native",
            })).status,
            403,
          );
          assert.strictEqual(opens(), 0);
          assert.strictEqual((yield* request("GET", "")).status, 200);
          assert.strictEqual(opens(), 1);
        }),
      { scopes: ["orchestration:read"] },
    ),
  );

  it.effect("rejects malformed bodies and old call outcomes", () =>
    run(({ request, opens }) =>
      Effect.gen(function* () {
        const missingCaller = yield* request("POST", "/acquire", {
          rootThreadId: "client-root",
          childThreadId: "client-child",
          taskId: "task",
          scope: "app",
          mode: "native",
        });
        assert.strictEqual(missingCaller.status, 400);
        assert.strictEqual(
          (yield* request("POST", "/call-end", {
            toolUseId: "call",
            outcome: "uncertain",
          })).status,
          400,
        );
        assert.strictEqual(opens(), 0);
      }),
    ),
  );

  it.effect("builds without opening the store, returns 503 on open failure, and retries", () =>
    run(
      ({ request, opens, filename }) =>
        Effect.gen(function* () {
          const forbidden = yield* request("POST", "/reconcile", {
            ticket: "unused",
            evidence: "unused",
          });
          assert.strictEqual(forbidden.status, 403);
          assert.strictEqual(opens(), 0);
          assert.isFalse(NodeFS.existsSync(filename));

          const unavailable = yield* request("GET", "");
          assert.strictEqual(unavailable.status, 503);
          assert.strictEqual(unavailable.body.error.code, "unavailable");
          assert.strictEqual(opens(), 1);
          const recovered = yield* request("GET", "");
          assert.strictEqual(recovered.status, 200);
          assert.isNull(recovered.body.lease);
          assert.strictEqual(opens(), 2);
          assert.strictEqual((yield* request("GET", "")).status, 200);
          assert.strictEqual(opens(), 2);
        }),
      { failFirstOpen: true },
    ),
  );
});
