import type { ProviderDriverKind, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";

import type { McpProviderSessionConfig } from "./mcpSession.ts";
import { ProviderAdapterProtocolError } from "./ProviderAdapter.ts";

export type WakeCallerState = "inactive" | "starting" | "live";

type WakeCaller = Pick<
  McpProviderSessionConfig,
  "threadId" | "providerSessionId" | "providerInstanceId"
>;
type WakeCredential = WakeCaller & Pick<McpProviderSessionConfig, "runtimeProviderSessionId">;
type WakeProbe = { readonly caller: WakeCredential; readonly read: () => WakeCallerState };

export class McpProviderSessions extends Context.Service<
  McpProviderSessions,
  {
    readonly set: (config: McpProviderSessionConfig) => Effect.Effect<void>;
    readonly read: (threadId: ThreadId) => Effect.Effect<McpProviderSessionConfig | undefined>;
    readonly registerWakeCaller: (
      caller: WakeCredential,
      read: () => WakeCallerState,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly readWakeCaller: (caller: WakeCaller) => Effect.Effect<WakeCallerState>;
    readonly clear: (threadId: ThreadId) => Effect.Effect<void>;
  }
>()("@t3tools/provider-core/server/McpProviderSessions") {}

export const readForRuntime = Effect.fn("McpProviderSessions.readForRuntime")(function* (
  sessions: McpProviderSessions["Service"],
  threadId: ThreadId,
  providerSessionId: ProviderSessionId,
  driver: ProviderDriverKind,
) {
  const credential = yield* sessions.read(threadId);
  if (credential !== undefined && credential.runtimeProviderSessionId !== providerSessionId) {
    return yield* new ProviderAdapterProtocolError({
      driver,
      detail: "MCP credential is not owned by this provider runtime; reopen this session.",
    });
  }
  return credential;
});

const make = Effect.gen(function* () {
  const sessions = yield* Ref.make(new Map<ThreadId, McpProviderSessionConfig>());
  const wakeCallers = new Map<ThreadId, WakeProbe>();
  const isCurrentWakeCredential = (caller: WakeCredential) => {
    const config = Ref.getUnsafe(sessions).get(caller.threadId);
    return (
      caller.runtimeProviderSessionId !== undefined &&
      config?.runtimeProviderSessionId === caller.runtimeProviderSessionId &&
      config.providerSessionId === caller.providerSessionId &&
      config.providerInstanceId === caller.providerInstanceId
    );
  };
  return McpProviderSessions.of({
    registerWakeCaller: Effect.fn("McpProviderSessions.registerWakeCaller")(
      function* (caller, read) {
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            if (!isCurrentWakeCredential(caller)) return undefined;
            const probe = { caller, read };
            wakeCallers.set(caller.threadId, probe);
            return probe;
          }),
          (probe) =>
            Effect.sync(() => {
              // An older runtime's teardown must not remove its replacement's probe.
              if (probe !== undefined && wakeCallers.get(caller.threadId) === probe)
                wakeCallers.delete(caller.threadId);
            }),
        );
      },
    ),
    readWakeCaller: (caller) =>
      Effect.sync(() => {
        const probe = wakeCallers.get(caller.threadId);
        if (
          probe?.caller.providerSessionId !== caller.providerSessionId ||
          probe.caller.providerInstanceId !== caller.providerInstanceId ||
          !isCurrentWakeCredential(probe.caller)
        )
          return "inactive";
        return probe.read();
      }),
    set: (config) =>
      Ref.update(sessions, (current) => new Map(current).set(config.threadId, config)),
    read: (threadId) => Ref.get(sessions).pipe(Effect.map((current) => current.get(threadId))),
    clear: (threadId) =>
      Ref.update(sessions, (current) => {
        wakeCallers.delete(threadId);
        const next = new Map(current);
        next.delete(threadId);
        return next;
      }),
  });
});

export const layer = Layer.effect(McpProviderSessions, make);
