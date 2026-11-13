import {
  clientRpcRequiredScopes,
  sessionGrantsScope,
  authScopeRequiredResponse,
  EnvironmentAuthorizationError,
  type EnvironmentId,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import { createEnvironmentSessionAtoms, isRejectedSessionStateError } from "./session.ts";

// Two six-second reads plus the first one-second backoff, with room to settle.
const SESSION_AUTHORIZATION_TIMEOUT_MS = 15_000;

function makeCommandPermissions<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  method: string,
) {
  const sessions = createEnvironmentSessionAtoms(runtime);
  const requiredScopes = (input?: unknown) => clientRpcRequiredScopes(method, input);
  const atomsByEnvironment = Atom.family((environmentId: EnvironmentId | null) =>
    Atom.family((scopeKey: string) =>
      Atom.make((get) => {
        if (environmentId === null) return false;
        const scopes = scopeKey.split(",").filter(Boolean) as AuthEnvironmentScope[];
        if (scopes.length === 0) return true;
        const result = get(sessions.sessionStateAtom(environmentId));
        const session = Option.getOrNull(AsyncResult.value(result));
        return (
          result._tag !== "Failure" &&
          session !== null &&
          scopes.every((scope) => sessionGrantsScope(session, scope))
        );
      }),
    ),
  );
  const permissionAtom = (environmentId: EnvironmentId | null, input?: unknown) =>
    atomsByEnvironment(environmentId)(requiredScopes(input).join(","));
  const authorize = (
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
    input?: unknown,
  ) =>
    Effect.suspend(() => {
      const scopes = requiredScopes(input);
      if (scopes.length === 0) return Effect.void;
      const denied = (scope: AuthEnvironmentScope) =>
        new EnvironmentAuthorizationError({
          ...authScopeRequiredResponse(scope),
          message: `This connection requires ${scope}.`,
        });
      const atom = sessions.sessionStateAtom(environmentId);
      return Effect.scoped(
        Effect.gen(function* () {
          yield* AtomRegistry.mount(registry, atom);
          const session = yield* AtomRegistry.getResult(registry, atom, {
            suspendOnWaiting: false,
          }).pipe(
            Effect.timeout(SESSION_AUTHORIZATION_TIMEOUT_MS),
            Effect.mapError((error) =>
              isRejectedSessionStateError(error)
                ? denied(scopes[0]!)
                : new EnvironmentRpcUnavailableError({
                    environmentId,
                    message: "Could not check this connection's permissions. Try again.",
                  }),
            ),
          );
          const missing = scopes.find((scope) => !sessionGrantsScope(session, scope));
          if (missing !== undefined) return yield* Effect.fail(denied(missing));
        }),
      );
    });
  return { requiredScopes, permissionAtom, authorize };
}

const permissionsByRuntime = new WeakMap<
  object,
  Map<string, ReturnType<typeof makeCommandPermissions>>
>();

export function createCommandPermissions<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  method: string,
) {
  let permissions = permissionsByRuntime.get(runtime);
  if (permissions === undefined) {
    permissions = new Map();
    permissionsByRuntime.set(runtime, permissions);
  }
  const existing = permissions.get(method);
  if (existing !== undefined) return existing;
  const created = makeCommandPermissions(runtime, method);
  permissions.set(method, created);
  return created;
}
