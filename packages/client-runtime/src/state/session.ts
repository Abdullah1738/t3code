import type { AuthSessionState, EnvironmentId, ServerConfig } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient, HttpClientError } from "effect/http";
import { AsyncResult, Atom } from "effect/reactivity";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import type { PreparedConnection } from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import { followStreamInEnvironment } from "./environmentStreams.ts";

/** @public Required to name the error in consumers' inferred session results. */
export class SessionHttpClientUnavailable extends Data.TaggedError(
  "SessionHttpClientUnavailable",
) {}

function initialConfigOption<E>(
  initialConfig: Effect.Effect<ServerConfig, E>,
): Effect.Effect<Option.Option<ServerConfig>> {
  return initialConfig.pipe(
    Effect.asSome,
    Effect.catch((error) =>
      Effect.logWarning("Could not load the initial environment configuration.").pipe(
        Effect.annotateLogs({ ...safeErrorLogAttributes(error) }),
        Effect.as(Option.none<ServerConfig>()),
      ),
    ),
  );
}

const DEFAULT_SESSION_STATE_TIMEOUT_MS = 6_000;

// Session reads can time out behind reload traffic; write controls need recovery
// without remounting, but credential rejections must still revoke cached grants.
const SESSION_STATE_RETRY_SCHEDULE = Schedule.exponential("1 second").pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.seconds(15))),
  ),
);

export function isTransientSessionStateError(error: {
  readonly _tag: string;
  readonly cause?: unknown;
}): boolean {
  if (error._tag === "RemoteEnvironmentAuthTimeoutError") return true;
  if (error._tag !== "RemoteEnvironmentAuthFetchError") return false;
  // The HTTP helper also wraps renewal rejections and missing relay services.
  const cause = error.cause;
  if (HttpClientError.isHttpClientError(cause)) return cause.reason._tag === "TransportError";
  if (typeof cause === "object" && cause !== null && "_tag" in cause) {
    return cause._tag === "ConnectionTransientError";
  }
  return cause instanceof Error;
}

export const fetchEnvironmentSessionState = Effect.fn(
  "clientRuntime.state.fetchEnvironmentSessionState",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelay.ManagedRelayDpopSigner["Service"]>;
  readonly remoteAuthorization?: Option.Option<
    RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization["Service"]
  >;
  readonly timeoutMs?: number;
}) {
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "auth",
    method: "GET",
    url: (urls) => urls.session(),
    timeoutMs: input.timeoutMs ?? DEFAULT_SESSION_STATE_TIMEOUT_MS,
    request: ({ client, headers }) => client.session({ headers }),
    // This endpoint returns 200 with authenticated:false for expired credentials.
    isUnauthorizedResponse: (response) => !response.authenticated,
  });
});

function makeEnvironmentSessionAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  const initialConfigAtom = Atom.family((environmentId: EnvironmentId) =>
    runtime.atom(
      followStreamInEnvironment(
        environmentId,
        Stream.unwrap(
          EnvironmentSupervisor.EnvironmentSupervisor.pipe(
            Effect.map((supervisor) =>
              SubscriptionRef.changes(supervisor.session).pipe(
                Stream.mapEffect(
                  Option.match({
                    onNone: () => Effect.succeed(Option.none<ServerConfig>()),
                    onSome: (session) => initialConfigOption(session.initialConfig),
                  }),
                ),
              ),
            ),
          ),
        ),
      ),
      { initialValue: Option.none() },
    ),
  );

  // This is only the bootstrap config captured when a transport session is
  // established. Consumers that need current provider/settings state must use
  // createServerEnvironmentAtoms(...).configValueAtom instead.
  const initialConfigValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): ServerConfig | null =>
      Option.getOrNull(
        Option.getOrElse(AsyncResult.value(get(initialConfigAtom(environmentId))), () =>
          Option.none(),
        ),
      ),
    ).pipe(Atom.withLabel(`environment-config-value:${environmentId}`)),
  );

  const preparedConnectionAtom = Atom.family((environmentId: EnvironmentId) =>
    runtime.atom(
      followStreamInEnvironment(
        environmentId,
        Stream.unwrap(
          EnvironmentSupervisor.EnvironmentSupervisor.pipe(
            Effect.map((supervisor) => SubscriptionRef.changes(supervisor.prepared)),
          ),
        ),
      ),
    ),
  );

  const preparedConnectionValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) =>
      Option.getOrElse(AsyncResult.value(get(preparedConnectionAtom(environmentId))), () =>
        Option.none<PreparedConnection>(),
      ),
    ).pipe(Atom.withLabel(`environment-prepared-connection:${environmentId}`)),
  );

  const sessionStateAtom = Atom.family((environmentId: EnvironmentId) => {
    const refreshSignal = Atom.make(() => ({})).pipe(Atom.setIdleTTL(0));
    const connection = Atom.make((get) => {
      const prepared = Option.getOrNull(get(preparedConnectionValueAtom(environmentId)));
      const previous = get.self<{ readonly prepared: PreparedConnection | null }>();
      return Option.isSome(previous) && previous.value.prepared === prepared
        ? previous.value
        : { prepared };
    }).pipe(Atom.setIdleTTL(0));
    // Each connection boundary gets its own async state, including A -> None -> A.
    const request = Atom.family((binding: Atom.Type<typeof connection>) =>
      runtime
        .atom((get) => {
          get(refreshSignal);
          const prepared = binding.prepared;
          if (prepared === null) return Effect.never;
          return Effect.gen(function* () {
            const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
            const remoteAuthorization = yield* Effect.serviceOption(
              RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
            );
            const client = yield* Effect.serviceOption(HttpClient.HttpClient);
            if (Option.isNone(client)) return yield* new SessionHttpClientUnavailable();
            return yield* fetchEnvironmentSessionState({
              prepared,
              signer,
              remoteAuthorization,
            }).pipe(
              Effect.retry({
                while: isTransientSessionStateError,
                schedule: SESSION_STATE_RETRY_SCHEDULE,
              }),
              Effect.provideService(HttpClient.HttpClient, client.value),
            );
          });
        })
        .pipe(Atom.setIdleTTL(0)),
    );
    type SessionResult = Atom.Type<ReturnType<typeof request>>;
    // Only data is retained while idle, never a subscription or retry fiber.
    const cached = Atom.make<
      Option.Option<{
        readonly prepared: PreparedConnection | null;
        readonly result: SessionResult;
      }>
    >(Option.none()).pipe(Atom.setIdleTTL(5 * 60_000));

    return Atom.readable(
      (get): SessionResult => {
        get.mount(cached);
        // An uninitialized stream is not an explicit disconnect. Do not erase
        // cached data until the supervisor has answered on a remount.
        const preparedState = get(preparedConnectionAtom(environmentId));
        if (preparedState._tag !== "Success") {
          if (preparedState._tag === "Failure") get.set(cached, Option.none());
          return AsyncResult.initial();
        }
        const binding = get(connection);
        const current =
          binding.prepared === null
            ? AsyncResult.initial<AuthSessionState>()
            : get(request(binding));
        const previous = get.once(cached);
        const result: SessionResult =
          current._tag === "Failure"
            ? AsyncResult.failure(current.cause, { waiting: current.waiting })
            : current._tag === "Initial" &&
                binding.prepared !== null &&
                Option.isSome(previous) &&
                previous.value.prepared === binding.prepared
              ? AsyncResult.waiting(previous.value.result)
              : current;
        get.set(cached, Option.some({ prepared: binding.prepared, result }));
        return result;
      },
      (refresh) => refresh(refreshSignal),
    ).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-session-state:${environmentId}`));
  });

  const sessionStateValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get): AuthSessionState | null =>
        Option.getOrNull(AsyncResult.value(get(sessionStateAtom(environmentId)))) ?? null,
    ).pipe(Atom.withLabel(`environment-session-state-value:${environmentId}`)),
  );

  return {
    initialConfigAtom,
    initialConfigValueAtom,
    preparedConnectionAtom,
    preparedConnectionValueAtom,
    sessionStateAtom,
    sessionStateValueAtom,
  };
}

const sessionAtomsByRuntime = new WeakMap<object, ReturnType<typeof makeEnvironmentSessionAtoms>>();

export function createEnvironmentSessionAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
): ReturnType<typeof makeEnvironmentSessionAtoms<R, E>> {
  const existing = sessionAtomsByRuntime.get(runtime);
  if (existing) return existing as ReturnType<typeof makeEnvironmentSessionAtoms<R, E>>;
  const atoms = makeEnvironmentSessionAtoms(runtime);
  sessionAtomsByRuntime.set(runtime, atoms);
  return atoms;
}
