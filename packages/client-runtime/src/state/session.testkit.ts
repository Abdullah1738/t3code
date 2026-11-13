import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  type AuthSessionState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";
import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { layerRemoteHttpClient } from "../rpc/http.ts";
import { createEnvironmentSessionAtoms } from "./session.ts";
import type { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import type { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";

export const TEST_SESSION: AuthSessionState = {
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes: [AuthOrchestrationOperateScope],
  permissions: [AuthOrchestrationOperateScope],
};

export async function sessionHarness(
  fetchFn: typeof fetch,
  services?: Layer.Layer<RemoteEnvironmentAuthorization | ManagedRelayDpopSigner>,
) {
  const environmentId = EnvironmentId.make("slow-session");
  const target = new PrimaryConnectionTarget({
    environmentId,
    label: "Session test",
    httpBaseUrl: "https://session.example.test",
    wsBaseUrl: "wss://session.example.test",
  });
  const prepared: PreparedConnection = {
    environmentId,
    label: target.label,
    httpBaseUrl: target.httpBaseUrl,
    socketUrl: "wss://session.example.test/ws",
    httpAuthorization: null,
    target,
  };
  const preparedRef = await Effect.runPromise(SubscriptionRef.make(Option.some(prepared)));
  const supervisor = { prepared: preparedRef } as EnvironmentSupervisor["Service"];
  const environmentRegistry = {
    followStream: (
      _id: EnvironmentId,
      stream: Stream.Stream<unknown, unknown, EnvironmentSupervisor>,
    ) => Stream.provideService(stream, EnvironmentSupervisor, supervisor),
  } as unknown as EnvironmentRegistry["Service"];
  const runtime = Atom.runtime(
    Layer.merge(
      Layer.succeed(EnvironmentRegistry, environmentRegistry),
      layerRemoteHttpClient(fetchFn),
    ).pipe(Layer.merge(services ?? Layer.empty)),
  );
  const registry = AtomRegistry.make();
  const sessions = createEnvironmentSessionAtoms(runtime);
  const atom = sessions.sessionStateAtom(environmentId);
  return { runtime, registry, sessions, atom, environmentId, preparedRef, prepared };
}

export function delayedSession(ms: number, signal?: AbortSignal | null): Promise<Response> {
  return Effect.runPromise(Effect.sleep(ms).pipe(Effect.as(Response.json(TEST_SESSION))), {
    ...(signal == null ? {} : { signal }),
  });
}
