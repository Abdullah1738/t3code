import { WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, type Atom, type AtomRegistry } from "effect/reactivity";
import * as Effect from "effect/Effect";
import { requestGuarded, EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAnalyticsCollector,
  registerEnvironmentAnalytics,
  type ClientAnalyticsEvent,
} from "../ardud/analytics.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

export function registerRuntimeAnalytics<R, E>(options: {
  readonly runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>;
  readonly registry: AtomRegistry.AtomRegistry;
  readonly environmentId: EnvironmentId;
  readonly surface: ClientAnalyticsEvent["surface"];
}) {
  const command = createEnvironmentRpcCommand(options.runtime, {
    label: "analytics:ingest",
    tag: WS_METHODS.analyticsIngest,
    execute: (input) =>
      requestGuarded(WS_METHODS.analyticsIngest, input).pipe(
        Effect.timeout(8_000),
        Effect.catchTags({
          TimeoutError: () =>
            Effect.fail(
              new EnvironmentRpcUnavailableError({
                environmentId: options.environmentId,
                message: "AnalyticsUnavailable",
              }),
            ),
        }),
      ),
  });
  const collector = createAnalyticsCollector({
    surface: options.surface,
    send: async (events) => {
      if (!options.registry.get(command.permissionAtom(options.environmentId)))
        throw new Error("AnalyticsUnavailable");
      const result = await command.run(options.registry, {
        environmentId: options.environmentId,
        input: { events },
      });
      if (!AsyncResult.isSuccess(result)) throw new Error("AnalyticsUnavailable");
    },
  });
  const unregister = registerEnvironmentAnalytics(options.environmentId, collector);
  const unmount = options.registry.mount(command.permissionAtom(options.environmentId));
  collector.record("client.lifecycle", { props: { phase: "start" } });
  return {
    collector,
    unregister: () => {
      unmount();
      unregister();
    },
  };
}
