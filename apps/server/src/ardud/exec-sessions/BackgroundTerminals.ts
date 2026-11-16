import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { requireThreadScope, type McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProviderSessionManager from "../../orchestration-v2/ProviderSessionManager.ts";

export const ExecSession = ProviderAdapter.ProviderBackgroundTerminal.mapFields(
  ({ processId, ...fields }) => ({
    ...fields,
    sessionId: processId,
  }),
);
export const StopInput = Schema.Struct({
  sessionId: Schema.String.check(Schema.isPattern(/^[0-9]{1,20}$/)),
});
export const StopResult = Schema.Struct({
  terminated: Schema.Literal(true),
  alreadyGone: Schema.Boolean,
});

export class BackgroundTerminals extends Context.Service<
  BackgroundTerminals,
  {
    readonly listBackgroundTerminals: (
      scope: McpInvocationScope,
    ) => Effect.Effect<
      { readonly sessions: ReadonlyArray<typeof ExecSession.Type> },
      OrchestratorMcpFailure
    >;
    readonly stopBackgroundTerminal: (
      scope: McpInvocationScope,
      input: typeof StopInput.Type,
    ) => Effect.Effect<typeof StopResult.Type, OrchestratorMcpFailure>;
  }
>()("t3/ardud/exec-sessions/BackgroundTerminals") {}

const unavailable = () =>
  new OrchestratorMcpFailure({
    code: "provider_unavailable",
    message: "The calling thread's live Codex session is unavailable.",
  });
const unsupported = () =>
  new OrchestratorMcpFailure({
    code: "not_supported",
    message:
      "Background exec sessions are supported only for Codex. For Claude use KillShell/TaskStop; other providers have no supported background exec session control.",
  });

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const credentials = yield* McpProviderSessions.McpProviderSessions;

  const resolveCaller = Effect.fn("BackgroundTerminals.resolveCaller")(function* (
    scope: McpInvocationScope,
  ) {
    if (!scope.capabilities.has("orchestration")) {
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        reason: "capability_missing",
        message: "This credential cannot control threads.",
      });
    }
    const caller = (yield* requireThreadScope(scope, "t3_exec_sessions / t3_exec_session_stop"))
      .thread;
    // MCP's providerSessionId identifies a credential, not a provider runtime.
    const credential = yield* credentials.read(caller.threadId);
    if (
      credential?.providerSessionId !== caller.providerSessionId ||
      credential.threadId !== caller.threadId ||
      credential.providerInstanceId !== caller.providerInstanceId
    ) {
      return yield* unavailable();
    }
    const records = yield* orchestrator
      .getThreadRecords(caller.threadId, ["providerThreads"])
      .pipe(Effect.mapError(unavailable));
    const activeThread = records.providerThreads.find(
      (thread) => thread.id === records.thread.activeProviderThreadId,
    );
    if (activeThread !== undefined && activeThread.driver !== "codex") return yield* unsupported();
    const providerThread = records.providerThreads.find(
      (thread) =>
        thread.id === records.thread.activeProviderThreadId &&
        thread.appThreadId === caller.threadId &&
        thread.providerInstanceId === caller.providerInstanceId &&
        thread.driver === "codex",
    );
    if (records.thread.deletedAt !== null || providerThread?.providerSessionId == null) {
      return yield* unavailable();
    }
    const runtime = yield* sessions
      .get(providerThread.providerSessionId)
      .pipe(Effect.mapError(unavailable));
    if (Option.isNone(runtime)) return yield* unavailable();
    if (
      runtime.value.driver !== "codex" ||
      runtime.value.listBackgroundTerminals === undefined ||
      runtime.value.terminateBackgroundTerminal === undefined
    )
      return yield* unsupported();
    return {
      providerThread,
      list: runtime.value.listBackgroundTerminals,
      stop: runtime.value.terminateBackgroundTerminal,
    };
  });

  const listBackgroundTerminals = Effect.fn("BackgroundTerminals.listBackgroundTerminals")(
    function* (scope: McpInvocationScope) {
      const caller = yield* resolveCaller(scope);
      const terminals = yield* caller
        .list({ providerThread: caller.providerThread })
        .pipe(Effect.mapError(unavailable));
      return {
        sessions: terminals.map(({ processId, ...fields }) => ({
          sessionId: processId,
          ...fields,
        })),
      };
    },
  );

  const stopBackgroundTerminal = Effect.fn("BackgroundTerminals.stopBackgroundTerminal")(function* (
    scope: McpInvocationScope,
    input: typeof StopInput.Type,
  ) {
    const startedAt = yield* Clock.currentTimeMillis;
    return yield* Effect.gen(function* () {
      const caller = yield* resolveCaller(scope);
      // Check ownership before dispatch, even for an adapter that accepts arbitrary ids.
      const terminals = yield* caller
        .list({ providerThread: caller.providerThread })
        .pipe(Effect.mapError(unavailable));
      if (!terminals.some((terminal) => terminal.processId === input.sessionId)) {
        return { terminated: true, alreadyGone: true } as const;
      }
      return yield* caller
        .stop({ providerThread: caller.providerThread, processId: input.sessionId })
        .pipe(Effect.mapError(unavailable));
    }).pipe(
      Effect.onExit((result) =>
        Effect.gen(function* () {
          yield* Effect.logInfo("background_terminal.stop").pipe(
            Effect.annotateLogs({
              threadId: scope.thread?.threadId ?? "none",
              sessionId: input.sessionId,
              result: Exit.isSuccess(result)
                ? result.value.alreadyGone
                  ? "already_gone"
                  : "terminated"
                : "failed",
              durationMs: (yield* Clock.currentTimeMillis) - startedAt,
            }),
          );
        }),
      ),
    );
  });
  return BackgroundTerminals.of({ listBackgroundTerminals, stopBackgroundTerminal });
});

export const layer = Layer.effect(BackgroundTerminals, make);
