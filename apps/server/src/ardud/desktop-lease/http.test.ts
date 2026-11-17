// @effect-diagnostics nodeBuiltinImport:off - these use isolated file-backed SQLite stores.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { AnalyticsEvent, AuthSessionId, type AuthEnvironmentScope } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Analytics from "../analytics/Analytics.ts";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ExecutionIdentity from "../identity/ExecutionIdentity.ts";
import { DesktopLease, QUIET_MS, STALE_MS, type HolderTurnActive } from "./DesktopLease.ts";
import * as DesktopLeaseService from "./DesktopLeaseService.ts";
import { desktopLeaseRoutes } from "./http.ts";

const decodeAnalyticsEvent = Schema.decodeUnknownEffect(AnalyticsEvent, {
  onExcessProperty: "error",
});

const prefix = "/api/ardud/control/desktop-lease";
const holder = { driver: "codex", nativeId: "holder-native", agentId: "child-agent" };
const other = { driver: "codex", nativeId: "other-native" };

const makeHarness = (
  options: {
    readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
    readonly failFirstOpen?: boolean;
    readonly holderTurnActive?: (root: string) => HolderTurnActive;
    readonly failRootLookup?: boolean;
    readonly failAnalytics?: boolean;
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
    const events: AnalyticsEvent[] = [];
    const activityRoots: string[] = [];
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
          parentNativeAgentId: null,
          nativeOwnerThreadId: null,
          model: null,
          acceptsMessages: resolution === "resolved",
          candidates: resolution === "ambiguous" ? ["thread-a", "thread-b"] : [],
        });
      },
    });
    const service = DesktopLeaseService.layerWithOptions({
      filename,
      ...(options.holderTurnActive ? { holderTurnActive: options.holderTurnActive } : {}),
      now: () => now,
      bootTimeMs: () => null,
      factory: (storeOptions) => {
        opens++;
        if (options.failFirstOpen && opens === 1) throw new Error("simulated open failure");
        return new DesktopLease(storeOptions);
      },
    }).pipe(
      Layer.provide(identity),
      Layer.provide(
        Layer.mock(Analytics.Analytics)({
          record: (event) =>
            decodeAnalyticsEvent(event).pipe(
              Effect.orDie,
              Effect.flatMap((decoded) =>
                Effect.sync(() => {
                  if (options.failAnalytics) throw new Error("analytics unavailable");
                  events.push(decoded);
                }),
              ),
            ),
        }),
      ),
      Layer.provide(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRunningTurnContext: (threadId) => {
            activityRoots.push(threadId);
            if (options.failRootLookup && threadId.startsWith("root-"))
              return Effect.fail(
                new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId }),
              );
            return Effect.succeed({
              run: undefined,
              providerThread: undefined,
              providerTurn: undefined,
            });
          },
        }),
      ),
    );
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
              quarantinedAt: string | null;
              openCallId: string | null;
            } | null;
            status: {
              lease: {
                childThreadId: string;
                rootThreadId: string;
                ticket: string;
                staleAfterMs?: number;
                heartbeatAt: string;
                heartbeatBy?: string;
              } | null;
            };
            error: { code: string; message: string };
          },
        };
      });
    return {
      request,
      resolvedInputs,
      events: () => events.filter((event) => "ticket" in event),
      activityRoots,
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
        assert.strictEqual(acquired.body.status.lease?.staleAfterMs, 120_000);
        assert.strictEqual(
          acquired.body.status.lease?.heartbeatBy,
          DateTime.formatIso(
            DateTime.add(DateTime.makeUnsafe(acquired.body.status.lease!.heartbeatAt), {
              milliseconds: 120_000,
            }),
          ),
        );

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

  it.effect("withdraws queued owners over HTTP and records each committed transition once", () =>
    run(({ request, events, advance }) =>
      Effect.gen(function* () {
        const acquired = yield* request("POST", "/acquire", {
          ...holder,
          taskId: "held",
          scope: "app",
          mode: "native",
        });
        const queued = yield* request("POST", "/acquire", {
          ...other,
          taskId: "queued",
          scope: "app",
          mode: "cua-driver",
        });
        assert.equal(
          (yield* request("POST", "/release", { ...holder, ticket: queued.body.ticket })).status,
          409,
        );
        assert.equal(
          (yield* request("POST", "/release", { ...other, ticket: queued.body.ticket })).status,
          200,
        );
        assert.equal(
          (yield* request("POST", "/release", { ...other, ticket: queued.body.ticket })).status,
          200,
        );
        assert.equal(
          (yield* request("POST", "/acquire", {
            ...other,
            taskId: "queued",
            scope: "app",
            mode: "cua-driver",
          })).body.state,
          "cancelled",
        );
        yield* request("POST", "/acquire", {
          ...other,
          taskId: "expires",
          scope: "app",
          mode: "native",
        });
        advance(STALE_MS);
        assert.equal(
          (yield* request("POST", "/heartbeat", { ...other, ticket: acquired.body.ticket })).status,
          409,
        );
        yield* request("GET", "");
        assert.deepEqual(
          events().map((e) => e.reason),
          ["queued_withdrawn", "queue_expired"],
        );
        assert.deepEqual(
          events().map((e) => e.kind),
          ["desktop_lease.transition", "desktop_lease.transition"],
        );
        assert.equal(events()[0]?.ticket, queued.body.ticket);
        assert.equal(events()[0]?.mode, "cua-driver");
        assert.equal(events()[1]?.age_ms, STALE_MS);
      }),
    ),
  );

  it.effect.each([false, true, "unknown", "lookup_error"] as const)(
    "preserves quarantine unless root inactivity is known (%s)",
    (active) =>
      run(
        ({ request, advance, events, activityRoots }) =>
          Effect.gen(function* () {
            const acquired = yield* request("POST", "/acquire", {
              ...holder,
              taskId: "task",
              scope: "app",
              mode: "native",
            });
            yield* request("POST", "/call-start", { ...holder, toolUseId: "hung" });
            advance(QUIET_MS);
            const quarantined = yield* request("GET", "");
            assert.equal(quarantined.body.lease?.state, "quarantined");
            assert.equal(quarantined.body.lease?.openCallId, "hung");
            assert.equal(quarantined.body.lease?.quarantinedAt, "2025-06-15T15:16:40.000Z");
            advance(QUIET_MS - 1);
            assert.equal((yield* request("GET", "")).body.lease?.state, "quarantined");
            advance(1);
            const recovered = yield* request("GET", "");
            if (active === false) {
              assert.isNull(recovered.body.lease);
              assert.include(activityRoots, "root-holder-native");
              assert.equal(
                (yield* request("POST", "/call-end", { toolUseId: "hung", outcome: "failed" }))
                  .status,
                200,
              );
              assert.equal(
                (yield* request("POST", "/call-end", { toolUseId: "hung", outcome: "completed" }))
                  .status,
                409,
              );
            } else {
              assert.equal(recovered.body.lease?.state, "quarantined");
              assert.equal(
                (yield* request("POST", "/reconcile", {
                  ticket: acquired.body.ticket,
                  evidence: "operator checked",
                })).status,
                200,
              );
            }
            yield* request("GET", "");
            assert.deepEqual(
              events().map((e) => e.reason),
              ["open_call_timeout", active === false ? "auto_reconciled" : "manual_reconciled"],
            );
          }),
        {
          scopes: ["orchestration:read", "orchestration:operate", "environment:maintain"],
          ...(active === false || active === "lookup_error"
            ? {}
            : { holderTurnActive: () => active }),
          failRootLookup: active === "lookup_error",
        },
      ),
  );

  it.effect.each([
    ["plain", "task-1807", "task-1807"],
    ["spaces", "inspect settings", "inspect%20settings"],
    ["equals", "task=1807", "task%3D1807"],
    ["separators", "task?part=1&child#2", "task%3Fpart%3D1%26child%232"],
    ["literal escape", "task%2F1807", "task%252F1807"],
    ["unicode", "فحص", "%D9%81%D8%AD%D8%B5"],
    ["controls", 'a\nb\t"\\', "a%0Ab%09%22%5C"],
    ["nul", "a\0b", "a%00b"],
    ["unpaired surrogate", "a\ud800b", "a%EF%BF%BDb"],
    ["maximum ascii", "x".repeat(1024), "x".repeat(1024)],
    [
      "maximum unicode",
      "漢".repeat(1024),
      "sha256:3bc0fb40f33dab3892291cb6a0f92eb5f200afc4d5be9001f124761952db12ac",
    ],
  ] as const)(
    "records one bounded transition for an accepted %s task ID",
    ([_shape, taskId, expected]) =>
      run(({ request, events }) =>
        Effect.gen(function* () {
          yield* request("POST", "/acquire", {
            ...holder,
            taskId: "holder",
            scope: "app",
            mode: "native",
          });
          const queued = yield* request("POST", "/acquire", {
            ...other,
            taskId,
            scope: "app",
            mode: "native",
          });
          assert.equal(queued.status, 200);
          assert.equal(
            (yield* request("POST", "/release", { ...other, ticket: queued.body.ticket })).status,
            200,
          );
          assert.equal(
            (yield* request("POST", "/release", { ...other, ticket: queued.body.ticket })).status,
            200,
          );
          assert.equal(events().length, 1);
          assert.equal(events()[0]?.taskId, expected);
          assert.equal(events()[0]?.reason, "queued_withdrawn");
          assert.isBelow(new TextEncoder().encode(JSON.stringify(events()[0])).length, 8192);
        }),
      ),
  );

  it.effect("analytics failure cannot undo a withdrawal", () =>
    run(
      ({ request }) =>
        Effect.gen(function* () {
          yield* request("POST", "/acquire", {
            ...holder,
            taskId: "held",
            scope: "app",
            mode: "native",
          });
          const queued = yield* request("POST", "/acquire", {
            ...other,
            taskId: "queued",
            scope: "app",
            mode: "native",
          });
          assert.equal(
            (yield* request("POST", "/release", { ...other, ticket: queued.body.ticket })).status,
            200,
          );
          assert.equal(
            (yield* request("POST", "/acquire", {
              ...other,
              taskId: "queued",
              scope: "app",
              mode: "native",
            })).body.state,
            "cancelled",
          );
        }),
      { failAnalytics: true },
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
