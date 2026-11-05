import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ServerSettings from "../../serverSettings.ts";
import { abortSession, configuredConnection, OpenCodeHttpError } from "./OpenCodeHttp.ts";

export interface StaleOpenCodeSession {
  readonly sessionId: string;
  readonly directory: string | null;
  readonly providerInstanceId: string;
}

export class StaleOpenCodeSessions extends Context.Service<
  StaleOpenCodeSessions,
  {
    readonly abort: (
      sessions: ReadonlyArray<StaleOpenCodeSession>,
    ) => Effect.Effect<{ readonly aborted: number; readonly failed: number }>;
  }
>()("t3/ardud/opencode-import/StaleRuns/StaleOpenCodeSessions") {}

// ardud: cap each request; recovery visits projections serially.
const ABORT_TIMEOUT = "3 seconds";

export const layer = Layer.effect(
  StaleOpenCodeSessions,
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    // ardud: avoid waiting three seconds for every projection when OpenCode is down.
    const gaveUp = yield* Ref.make(false);
    return StaleOpenCodeSessions.of({
      abort: (sessions) =>
        Effect.gen(function* () {
          if (sessions.length === 0) return { aborted: 0, failed: 0 };
          if (yield* Ref.get(gaveUp)) {
            yield* Effect.logWarning(
              "Skipping stale OpenCode interrupts after a connection failure",
              {
                sessions: sessions.length,
              },
            );
            return { aborted: 0, failed: sessions.length };
          }
          const instanceIds = [...new Set(sessions.map((session) => session.providerInstanceId))];
          const configs = new Map(
            yield* Effect.forEach(
              instanceIds,
              (id) =>
                configuredConnection(settings, id).pipe(
                  Effect.map((config) => [id, config] as const),
                ),
              { concurrency: 4 },
            ),
          );
          const results = yield* Effect.forEach(
            sessions,
            (session) =>
              Effect.gen(function* () {
                if (yield* Ref.get(gaveUp)) return "breaker" as const;
                const configured = configs.get(session.providerInstanceId);
                if (configured?.kind !== "external") return "skipped" as const;
                const result = yield* abortSession(configured.connection, session.sessionId).pipe(
                  Effect.as({ status: "aborted" as const }),
                  Effect.catch((error) =>
                    Effect.succeed(
                      Schema.is(OpenCodeHttpError)(error) && error.status === 404
                        ? { status: "aborted" as const }
                        : {
                            status: error.status ?? "request failed",
                            connectionFailure: error.status === undefined,
                          },
                    ),
                  ),
                  Effect.timeoutOption(ABORT_TIMEOUT),
                );
                if (Option.isSome(result) && result.value.status === "aborted")
                  return "aborted" as const;
                if (
                  Option.isNone(result) ||
                  ("connectionFailure" in result.value && result.value.connectionFailure)
                ) {
                  yield* Ref.set(gaveUp, true);
                }
                yield* Effect.logWarning("Failed to abort stale OpenCode session", {
                  sessionId: session.sessionId,
                  status: Option.isNone(result) ? "timeout" : result.value.status,
                });
                return "failed" as const;
              }).pipe(
                // ardud: do not leak the HTTP request or its authorization header on defects.
                Effect.catchCauseIf(
                  (cause) => !Cause.hasInterruptsOnly(cause),
                  () =>
                    Effect.logWarning("Failed to abort stale OpenCode session", {
                      sessionId: session.sessionId,
                      status: "request failed",
                    }).pipe(Effect.as("failed" as const)),
                ),
              ),
            { concurrency: 4 },
          );
          const skippedByBreaker = results.filter((result) => result === "breaker").length;
          if (skippedByBreaker > 0) {
            yield* Effect.logWarning(
              "Skipping stale OpenCode interrupts after a connection failure",
              {
                sessions: skippedByBreaker,
              },
            );
          }
          return {
            aborted: results.filter((result) => result === "aborted").length,
            failed: results.filter((result) => result === "failed").length + skippedByBreaker,
          };
        }).pipe(
          // ardud: recovery must continue even if settings or the abort service defects.
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            () => Effect.succeed({ aborted: 0, failed: sessions.length }),
          ),
        ),
    });
  }),
);
