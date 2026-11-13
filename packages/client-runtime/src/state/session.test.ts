import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { EnvironmentId, WS_METHODS, type AuthSessionState } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { TestClock } from "effect/testing";

import {
  RemoteEnvironmentAuthFetchError,
  RemoteEnvironmentAuthTimeoutError,
  RemoteEnvironmentAuthUndeclaredStatusError,
} from "../rpc/http.ts";
import {
  createEnvironmentSessionAtoms,
  isTransientSessionStateError,
  isRejectedSessionStateError,
} from "./session.ts";
import { createCommandPermissions } from "./commandPermissions.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import {
  ConnectionBlockedError,
  AVAILABLE_CONNECTION_STATE,
  type SupervisorConnectionState,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";

const environmentId = EnvironmentId.make("session-test");
const target = new PrimaryConnectionTarget({
  environmentId,
  label: "test",
  httpBaseUrl: "http://test.local",
  wsBaseUrl: "ws://test.local",
});
const prepared: PreparedConnection = {
  environmentId,
  label: target.label,
  target,
  httpBaseUrl: target.httpBaseUrl,
  socketUrl: target.wsBaseUrl,
  httpAuthorization: null,
};
const grant: AuthSessionState = {
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes: ["orchestration:operate"],
};

// Atom fibers use their layer's clock; keep retries on the test clock too.
const makeHarness = Effect.fnUntraced(function* (options?: {
  dpop?: boolean;
  initiallySlow?: boolean;
  initiallyBlocked?: boolean;
  initialResponse?: Response;
}) {
  const binding = options?.dpop
    ? {
        ...prepared,
        httpAuthorization: {
          _tag: "Dpop" as const,
          accessToken: "test-access",
          expiresAtEpochMs: 999_999,
        },
      }
    : prepared;
  const preparedRef = yield* SubscriptionRef.make(Option.some(binding));
  const stateRef = yield* SubscriptionRef.make<SupervisorConnectionState>({
    ...AVAILABLE_CONNECTION_STATE,
    phase: "connected",
  });
  const supervisor = { prepared: preparedRef, state: stateRef } as EnvironmentSupervisor["Service"];
  const environments = {
    followStream: (_id, stream) => Stream.provideService(stream, EnvironmentSupervisor, supervisor),
  } as EnvironmentRegistry["Service"];
  let reply: () => Effect.Effect<Response, HttpClientError.HttpClientError> = () =>
    options?.initialResponse !== undefined
      ? Effect.succeed(options.initialResponse)
      : options?.initiallySlow
        ? Effect.never
        : Effect.succeed(Response.json(grant));
  const calls: number[] = [];
  const clock = yield* Clock.Clock;
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      calls.push(yield* Clock.currentTimeMillis);
      return HttpClientResponse.fromWeb(request, yield* reply());
    }),
  );
  let blocked: ConnectionBlockedError | undefined = options?.initiallyBlocked
    ? new ConnectionBlockedError({ reason: "authentication", detail: "Initially rejected" })
    : undefined;
  let rejectRenewal = false;
  let authorizations = 0;
  const remote = RemoteEnvironmentAuthorization.of({
    authorizeBearer: () => Effect.die("Unexpected bearer"),
    authorizeDpop: () => Effect.die("Unexpected socket"),
    authorizeDpopHttp: (input) =>
      Effect.suspend(() => {
        authorizations++;
        return blocked && (!rejectRenewal || input.rejectedAccessToken !== undefined)
          ? Effect.fail(blocked)
          : Effect.succeed({
              environmentId,
              label: "test",
              httpBaseUrl: prepared.httpBaseUrl,
              httpAuthorization: {
                _tag: "Dpop" as const,
                accessToken: "test-access",
                expiresAtEpochMs: 999_999,
              },
            });
      }),
  });
  const runtime = Atom.runtime(
    Layer.mergeAll(
      Layer.succeed(EnvironmentRegistry, environments),
      Layer.succeed(HttpClient.HttpClient, client),
      Layer.succeed(Clock.Clock, clock),
      Layer.succeed(RemoteEnvironmentAuthorization, remote),
      Layer.succeed(
        ManagedRelayDpopSigner,
        ManagedRelayDpopSigner.of({
          thumbprint: Effect.succeed("test"),
          createProof: () => Effect.succeed("test-proof"),
        }),
      ),
    ),
  );
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      let active = true;
      queueMicrotask(() => {
        if (active) task();
      });
      return () => {
        active = false;
      };
    },
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  const atoms = createEnvironmentSessionAtoms(runtime);
  const atom = atoms.sessionStateAtom(environmentId);
  const permissions = createCommandPermissions(runtime, WS_METHODS.scheduledTasksDelete);
  const permission = permissions.permissionAtom(environmentId);
  const status = permissions.permissionStatusAtom(environmentId);
  const stopPermission = registry.mount(permission);
  const stopStatus = registry.mount(status);
  const unmount = () => {
    stopPermission();
    stopStatus();
  };
  const read = AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true });
  return {
    registry,
    atom,
    permission,
    status,
    stateRef,
    atoms,
    read,
    unmount,
    preparedRef,
    binding,
    calls,
    reply: (next: typeof reply) => {
      reply = next;
    },
    reject: (reason: ConnectionBlockedError["reason"], renewalOnly = false) => {
      blocked = new ConnectionBlockedError({ reason, detail: "Rejected test authorization" });
      rejectRenewal = renewalOnly;
    },
    authorizations: () => authorizations,
    offline: () => {
      reply = () =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request: HttpClientRequest.get(prepared.httpBaseUrl),
              cause: new TypeError("offline"),
            }),
          }),
        );
    },
  };
});

const settle = TestClock.adjust(0);

describe("session state retry", () => {
  it.each([400, 401, 403, 500, 502, 503, 504])(
    "classifies HTTP %s through both error forms",
    (status) => {
      const request = HttpClientRequest.get(prepared.httpBaseUrl);
      const response = HttpClientResponse.fromWeb(request, new Response("unavailable", { status }));
      const wrapped = new RemoteEnvironmentAuthFetchError({
        message: "HTTP failure",
        cause: new HttpClientError.HttpClientError({
          reason: new HttpClientError.StatusCodeError({ request, response }),
        }),
      });
      const transient = [502, 503, 504].includes(status);
      expect(isTransientSessionStateError(wrapped)).toBe(transient);
      expect(isRejectedSessionStateError(wrapped)).toBe(status === 401 || status === 403);
      expect(
        isTransientSessionStateError(
          new RemoteEnvironmentAuthUndeclaredStatusError(prepared.httpBaseUrl, status),
        ),
      ).toBe(transient);
    },
  );
  it("retries a session read that timed out on a busy server", () => {
    expect(
      isTransientSessionStateError(
        new RemoteEnvironmentAuthTimeoutError("http://127.0.0.1:3773/api/auth/session", 6_000),
      ),
    ).toBe(true);
  });

  it("retries a transport failure", () => {
    expect(
      isTransientSessionStateError(
        new RemoteEnvironmentAuthFetchError({
          message: "Failed to fetch",
          cause: new TypeError("Failed to fetch"),
        }),
      ),
    ).toBe(true);
  });

  it("does not retry a rejected renewal or a credential answer", () => {
    expect(
      isTransientSessionStateError(
        new RemoteEnvironmentAuthFetchError({
          message: "The environment rejected the renewed session authorization.",
          cause: { authenticated: false },
        }),
      ),
    ).toBe(false);
    expect(isTransientSessionStateError({ _tag: "EnvironmentAuthInvalidError" })).toBe(false);
    expect(isTransientSessionStateError({ _tag: "EnvironmentScopeRequiredError" })).toBe(false);
  });

  it.each(["Dpop", "RelayConnectionTarget", { _tag: "UnknownAuthorizationError" }])(
    "does not retry unavailable or unknown authorization (%s)",
    (cause) =>
      expect(
        isTransientSessionStateError(
          new RemoteEnvironmentAuthFetchError({ message: "Authorization unavailable", cause }),
        ),
      ).toBe(false),
  );
});

describe("session permissions", () => {
  it.effect("does not revalidate an initially blocked synchronous DPoP authorization", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ dpop: true, initiallyBlocked: true });
      yield* h.read.pipe(Effect.flip);
      yield* settle;
      expect(h.authorizations()).toBe(1);
      yield* TestClock.adjust(60_000);
      expect(h.authorizations()).toBe(1);
      expect(h.registry.get(h.permission)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("starts the data cache TTL on unmount, not while actively mounted", () =>
    Effect.gen(function* () {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      yield* Effect.addFinalizer(() => Effect.sync(() => vi.useRealTimers()));
      const h = yield* makeHarness();
      yield* h.read;
      vi.advanceTimersByTime(301_000);
      h.unmount();
      yield* settle;
      vi.advanceTimersByTime(1_000);
      h.reply(() => Effect.never);
      h.registry.mount(h.permission);
      yield* settle;
      expect(h.registry.get(h.permission)).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("recovers an initial slow session without remounting", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ initiallySlow: true });
      yield* settle;
      expect(h.registry.get(h.permission)).toBe(false);
      expect(h.registry.get(h.status)).toBe("unknown");
      yield* TestClock.adjust(6_000);
      expect(h.calls).toHaveLength(1);
      expect(h.registry.get(h.status)).toBe("unknown");
      h.reply(() => Effect.succeed(Response.json(grant)));
      yield* TestClock.adjust(1_000);
      yield* h.read;
      expect(h.registry.get(h.permission)).toBe(true);
      expect(h.registry.get(h.status)).toBe("granted");
      expect(h.calls).toHaveLength(2);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps the last same-connection grant through timeout and recovery", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.read;
      h.reply(() => Effect.never);
      h.registry.refresh(h.atom);
      yield* TestClock.adjust(6_000);
      expect(h.registry.get(h.permission)).toBe(true);
      expect(h.calls).toHaveLength(2);
      h.reply(() => Effect.succeed(Response.json({ ...grant, scopes: [] })));
      yield* TestClock.adjust(1_000);
      yield* h.read;
      expect(h.registry.get(h.permission)).toBe(false);
      expect(h.registry.get(h.status)).toBe("denied");
      expect(h.calls).toHaveLength(3);
    }).pipe(Effect.scoped),
  );

  it.effect.each(["credentials", "origin", "none"] as const)(
    "clears an old grant when %s replaces the connection",
    (change) =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        yield* h.read;
        h.reply(() => Effect.never);
        yield* SubscriptionRef.set(
          h.preparedRef,
          change === "none"
            ? Option.none()
            : Option.some({
                ...h.binding,
                ...(change === "credentials"
                  ? { httpAuthorization: { _tag: "Bearer" as const, token: "replacement" } }
                  : { httpBaseUrl: "http://replacement.local" }),
              }),
        );
        yield* settle;
        expect(h.registry.get(h.permission)).toBe(false);
        yield* TestClock.adjust(20_000);
        expect(h.registry.get(h.permission)).toBe(false);
        if (change === "none") {
          yield* SubscriptionRef.set(h.preparedRef, Option.some(h.binding));
          yield* settle;
          expect(h.registry.get(h.permission)).toBe(false);
        }
      }).pipe(Effect.scoped),
  );

  it.effect.each([
    { status: 401, typed: false },
    { status: 401, typed: true },
    { status: 403, typed: false },
    { status: 403, typed: true },
  ])("clears a grant on HTTP $status (typed=$typed) and never retries it", ({ status, typed }) =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.read;
      h.reply(() =>
        Effect.succeed(
          typed
            ? Response.json(
                status === 401
                  ? {
                      _tag: "EnvironmentAuthInvalidError",
                      code: "auth_invalid",
                      reason: "invalid_credential",
                      traceId: "test",
                    }
                  : {
                      _tag: "EnvironmentScopeRequiredError",
                      code: "scope_required",
                      requiredScope: "orchestration:operate",
                      traceId: "test",
                    },
                { status },
              )
            : new Response("rejected", { status }),
        ),
      );
      h.registry.refresh(h.atom);
      yield* h.read.pipe(Effect.flip);
      expect(h.registry.get(h.permission)).toBe(false);
      expect(Option.isNone(AsyncResult.value(h.registry.get(h.atom)))).toBe(true);
      expect(h.registry.get(h.status)).toBe("denied");
      yield* SubscriptionRef.update(h.stateRef, (state) => ({
        ...state,
        phase: "backoff" as const,
      }));
      yield* settle;
      yield* SubscriptionRef.update(h.stateRef, (state) => ({
        ...state,
        phase: "connected" as const,
      }));
      yield* settle;
      yield* TestClock.adjust(60_000);
      expect(h.calls).toHaveLength(2);
    }).pipe(Effect.scoped),
  );

  it.effect.each(["authentication", "permission", "configuration", "unsupported"] as const)(
    "does not retry a wrapped DPoP %s rejection",
    (reason) =>
      Effect.gen(function* () {
        const h = yield* makeHarness({ dpop: true });
        yield* h.read;
        h.reject(reason);
        h.registry.refresh(h.atom);
        const failure = yield* h.read.pipe(Effect.flip);
        expect(failure).toMatchObject({
          _tag: "RemoteEnvironmentAuthFetchError",
          cause: { _tag: "ConnectionBlockedError", reason },
        });
        expect(h.registry.get(h.permission)).toBe(false);
        expect(Option.isNone(AsyncResult.value(h.registry.get(h.atom)))).toBe(true);
        yield* TestClock.adjust(60_000);
        expect(h.authorizations()).toBe(2);
        expect(h.calls).toHaveLength(1);
      }).pipe(Effect.scoped),
  );

  it.effect("paces offline retries at 1/2/4/8/15/15 seconds", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.read;
      h.offline();
      h.registry.refresh(h.atom);
      yield* settle;
      const started = h.calls[1]!;
      for (const delay of [1_000, 2_000, 4_000, 8_000, 15_000, 15_000]) {
        const count = h.calls.length;
        yield* TestClock.adjust(delay - 1);
        expect(h.calls).toHaveLength(count);
        yield* TestClock.adjust(1);
        expect(h.calls).toHaveLength(count + 1);
      }
      expect(h.calls.slice(1).map((time) => time - started)).toEqual([
        0, 1_000, 3_000, 7_000, 15_000, 30_000, 45_000,
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("clears a grant when a rejected DPoP token cannot renew", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ dpop: true });
      yield* h.read;
      h.reject("authentication", true);
      h.reply(() => Effect.succeed(Response.json({ ...grant, authenticated: false })));
      h.registry.refresh(h.atom);
      const failure = yield* h.read.pipe(Effect.flip);
      expect(failure).toMatchObject({
        _tag: "RemoteEnvironmentAuthFetchError",
        cause: { _tag: "ConnectionBlockedError" },
      });
      expect(h.registry.get(h.permission)).toBe(false);
      yield* TestClock.adjust(60_000);
      expect(h.authorizations()).toBe(3);
      expect(h.calls).toHaveLength(2);
    }).pipe(Effect.scoped),
  );

  it.effect("does not retry persistent DPoP unauthenticated session answers", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ dpop: true });
      yield* h.read;
      h.reply(() => Effect.succeed(Response.json({ ...grant, authenticated: false })));
      h.registry.refresh(h.atom);
      yield* h.read.pipe(Effect.flip);
      expect(h.registry.get(h.permission)).toBe(false);
      yield* TestClock.adjust(60_000);
      expect(h.calls).toHaveLength(3);
      expect(h.authorizations()).toBe(3);
    }).pipe(Effect.scoped),
  );

  it.effect("cancels the old request when credentials are replaced", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.read;
      let interrupted = false;
      h.reply(() =>
        Effect.never.pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              interrupted = true;
            }),
          ),
        ),
      );
      h.registry.refresh(h.atom);
      yield* settle;
      h.reply(() => Effect.succeed(Response.json({ ...grant, scopes: [] })));
      yield* SubscriptionRef.set(
        h.preparedRef,
        Option.some({ ...h.binding, httpAuthorization: { _tag: "Bearer", token: "replacement" } }),
      );
      yield* settle;
      yield* h.read;
      expect(interrupted).toBe(true);
      expect(h.registry.get(h.permission)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("does not resurrect a rejected grant during a later refresh", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.read;
      h.reply(() => Effect.succeed(new Response("rejected", { status: 401 })));
      h.registry.refresh(h.atom);
      yield* h.read.pipe(Effect.flip);
      h.reply(() => Effect.never);
      h.registry.refresh(h.atom);
      yield* settle;
      expect(h.registry.get(h.permission)).toBe(false);
      expect(Option.isNone(AsyncResult.value(h.registry.get(h.atom)))).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("rechecks the connection after an idle replacement instead of reusing its grant", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.read;
      h.unmount();
      yield* settle;
      yield* SubscriptionRef.set(
        h.preparedRef,
        Option.some({
          ...h.binding,
          httpAuthorization: { _tag: "Bearer", token: "new-idle-token" },
        }),
      );
      h.reply(() => Effect.never);
      h.registry.mount(h.permission);
      yield* settle;
      expect(h.registry.get(h.permission)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("cancels an in-flight request when the last consumer unmounts", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.read;
      let interrupted = false;
      h.reply(() =>
        Effect.never.pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              interrupted = true;
            }),
          ),
        ),
      );
      h.registry.refresh(h.atom);
      yield* settle;
      h.unmount();
      yield* settle;
      expect(interrupted).toBe(true);
      yield* TestClock.adjust(60_000);
      expect(h.calls).toHaveLength(2);
    }).pipe(Effect.scoped),
  );

  it.effect("stops retries on last unmount but retains same-connection cached data", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.read;
      h.offline();
      h.registry.refresh(h.atom);
      yield* settle;
      h.unmount();
      yield* settle;
      yield* TestClock.adjust(60_000);
      expect(h.calls).toHaveLength(2);
      h.reply(() => Effect.never);
      h.registry.mount(h.permission);
      yield* settle;
      expect(h.registry.get(h.permission)).toBe(true);
    }).pipe(Effect.scoped),
  );
});

describe("session recovery on reconnect", () => {
  it.effect.each([502, 503, 504])("retries HTTP %s and grants without remounting", (status) =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ initialResponse: new Response("restarting", { status }) });
      yield* settle;
      expect(h.calls).toHaveLength(1);
      expect(h.registry.get(h.status)).toBe("unknown");
      h.reply(() => Effect.succeed(Response.json(grant)));
      yield* TestClock.adjust(999);
      expect(h.calls).toHaveLength(1);
      yield* TestClock.adjust(1);
      yield* h.read;
      expect(h.registry.get(h.status)).toBe("granted");
      expect(h.calls).toHaveLength(2);
    }).pipe(Effect.scoped),
  );

  it.effect("rereads a nonterminal failure once per reconnect and stops on unmount", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ initialResponse: Response.json({ invalid: true }) });
      yield* h.read.pipe(Effect.flip);
      yield* settle;
      expect(h.registry.get(h.status)).toBe("unknown");
      expect(h.calls).toHaveLength(1);
      yield* SubscriptionRef.update(h.stateRef, (state) => ({
        ...state,
        phase: "backoff" as const,
      }));
      yield* settle;
      expect(h.calls).toHaveLength(1);
      yield* SubscriptionRef.update(h.stateRef, (state) => ({
        ...state,
        phase: "connected" as const,
      }));
      yield* settle;
      yield* h.read.pipe(Effect.flip);
      expect(h.calls).toHaveLength(2);
      yield* SubscriptionRef.update(h.stateRef, (state) => ({
        ...state,
        attempt: state.attempt + 1,
      }));
      yield* TestClock.adjust(60_000);
      expect(h.calls).toHaveLength(2);
      h.reply(() => Effect.succeed(Response.json(grant)));
      yield* SubscriptionRef.update(h.stateRef, (state) => ({
        ...state,
        phase: "backoff" as const,
      }));
      yield* settle;
      yield* SubscriptionRef.update(h.stateRef, (state) => ({
        ...state,
        phase: "connected" as const,
      }));
      yield* settle;
      yield* h.read;
      expect(h.calls).toHaveLength(3);
      expect(h.registry.get(h.status)).toBe("granted");
      h.unmount();
      yield* settle;
      yield* SubscriptionRef.update(h.stateRef, (state) => ({
        ...state,
        phase: "backoff" as const,
      }));
      yield* settle;
      yield* SubscriptionRef.update(h.stateRef, (state) => ({
        ...state,
        phase: "connected" as const,
      }));
      yield* TestClock.adjust(60_000);
      expect(h.calls).toHaveLength(3);
    }).pipe(Effect.scoped),
  );

  it.effect("does not restart a healthy read or its backoff on reconnect", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.read;
      for (const phase of ["backoff", "connected"] as const) {
        yield* SubscriptionRef.update(h.stateRef, (state) => ({ ...state, phase }));
        yield* settle;
      }
      expect(h.calls).toHaveLength(1);
      h.offline();
      h.registry.refresh(h.atom);
      yield* settle;
      yield* TestClock.adjust(1_000);
      expect(h.calls).toHaveLength(3);
      for (const phase of ["backoff", "connected"] as const) {
        yield* SubscriptionRef.update(h.stateRef, (state) => ({ ...state, phase }));
        yield* settle;
      }
      yield* TestClock.adjust(1_999);
      expect(h.calls).toHaveLength(3);
      yield* TestClock.adjust(1);
      expect(h.calls).toHaveLength(4);
    }).pipe(Effect.scoped),
  );
});
