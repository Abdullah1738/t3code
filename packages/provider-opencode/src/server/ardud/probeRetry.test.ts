import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { describe } from "vite-plus/test";

import { makeOpenCodeProbeRetry } from "./probeRetry.ts";

const snapshotWith = (status: ServerProvider["status"]): ServerProvider => ({
  instanceId: ProviderInstanceId.make("opencode"),
  driver: ProviderDriverKind.make("opencode"),
  enabled: true,
  installed: status !== "warning",
  version: null,
  status,
  auth: { status: "unknown" },
  checkedAt: "2026-10-21T00:00:00.000Z",
  message: status === "error" ? "Couldn't reach the configured OpenCode server." : undefined,
  models: [],
  slashCommands: [],
  skills: [],
});

const maintenance = {
  provider: ProviderDriverKind.make("opencode"),
  packageName: null,
  update: null,
} as const;

/**
 * A managed provider wired the way the driver wires it, whose check answers
 * with `statusFor(n)` on its nth call.
 */
const makeProvider = (statusFor: (call: number) => ServerProvider["status"]) =>
  Effect.gen(function* () {
    const checks = yield* Ref.make(0);
    const firstCheck = yield* Deferred.make<void>();
    const probeRetry = yield* makeOpenCodeProbeRetry();
    const provider = yield* makeManagedServerProvider<{ readonly enabled: boolean }>({
      resolveMaintenance: () => Effect.succeed(maintenance),
      getSettings: Effect.succeed({ enabled: true }),
      streamSettings: Stream.empty,
      haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
      checkProviderOnSettingsChange: () => false,
      refreshOnInterval: false,
      initialSnapshot: () => Effect.succeed(snapshotWith("warning")),
      checkProvider: Ref.updateAndGet(checks, (count) => count + 1).pipe(
        Effect.map((count) => snapshotWith(statusFor(count))),
        Effect.tap(probeRetry.observe),
        Effect.tap(() => Deferred.succeed(firstCheck, undefined)),
      ),
    });
    yield* probeRetry.start(provider);
    yield* Deferred.await(firstCheck);
    yield* Effect.yieldNow;
    return { provider, checks: Ref.get(checks) };
  });

const status = (provider: { readonly getSnapshot: Effect.Effect<ServerProvider> }) =>
  provider.getSnapshot.pipe(Effect.map((snapshot) => snapshot.status));

const advanceMinutes = (minutes: number) =>
  Effect.forEach(Array.from({ length: minutes }), () => TestClock.adjust("1 minute"), {
    discard: true,
  });

const layer = Layer.mergeAll(TestProviderHost.layer(), TestClock.layer()).pipe(
  Layer.provideMerge(NodeServices.layer),
);

describe("OpenCode health check retry", () => {
  it.effect("retries a failed boot check until the server answers", () =>
    Effect.gen(function* () {
      const { provider, checks } = yield* makeProvider((call) => (call <= 2 ? "error" : "ready"));
      assert.strictEqual(yield* status(provider), "error");

      yield* TestClock.adjust("5 seconds");
      assert.strictEqual(yield* checks, 2);
      assert.strictEqual(yield* status(provider), "error");

      yield* TestClock.adjust("10 seconds");
      assert.strictEqual(yield* checks, 3);
      assert.strictEqual(yield* status(provider), "ready");

      yield* advanceMinutes(60);
      assert.strictEqual(yield* checks, 3);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("backs off to two minutes and gives up after half an hour", () =>
    Effect.gen(function* () {
      const { provider, checks } = yield* makeProvider(() => "error");

      // Retries at 5s, 15s, 35s, 75s, 155s, then every 2 minutes; the one at
      // 1835s is the first past half an hour and the last.
      yield* advanceMinutes(30);
      assert.strictEqual(yield* checks, 19);
      yield* advanceMinutes(60);
      assert.strictEqual(yield* checks, 20);

      // The next failed check, here a manual refresh, starts over.
      yield* provider.refresh;
      assert.strictEqual(yield* checks, 21);
      yield* TestClock.adjust("5 seconds");
      assert.strictEqual(yield* checks, 22);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("stops once another check succeeds", () =>
    Effect.gen(function* () {
      let fixed = false;
      const { provider, checks } = yield* makeProvider(() => (fixed ? "ready" : "error"));

      yield* TestClock.adjust("5 seconds");
      assert.strictEqual(yield* checks, 2);

      fixed = true;
      yield* provider.refresh;
      assert.strictEqual(yield* checks, 3);
      assert.strictEqual(yield* status(provider), "ready");

      yield* advanceMinutes(60);
      assert.strictEqual(yield* checks, 3);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("leaves a provider that is not in error alone", () =>
    Effect.gen(function* () {
      const { provider, checks } = yield* makeProvider(() => "warning");
      yield* advanceMinutes(60);
      assert.strictEqual(yield* checks, 1);
      assert.strictEqual(yield* status(provider), "warning");
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
