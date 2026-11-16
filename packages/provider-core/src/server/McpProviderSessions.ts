import type { ProviderDriverKind, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import type { McpProviderSessionConfig } from "./mcpSession.ts";
import { ProviderAdapterProtocolError } from "./ProviderAdapter.ts";

export class McpProviderSessions extends Context.Service<
  McpProviderSessions,
  {
    readonly set: (config: McpProviderSessionConfig) => Effect.Effect<void>;
    readonly read: (threadId: ThreadId) => Effect.Effect<McpProviderSessionConfig | undefined>;
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
  return McpProviderSessions.of({
    set: (config) =>
      Ref.update(sessions, (current) => new Map(current).set(config.threadId, config)),
    read: (threadId) => Ref.get(sessions).pipe(Effect.map((current) => current.get(threadId))),
    clear: (threadId) =>
      Ref.update(sessions, (current) => {
        const next = new Map(current);
        next.delete(threadId);
        return next;
      }),
  });
});

export const layer = Layer.effect(McpProviderSessions, make);
