import { MissionError, type EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, type Atom, type AtomRegistry } from "effect/reactivity";

import type * as EnvironmentRegistry from "../../connection/registry.ts";
import * as EnvironmentSupervisor from "../../connection/supervisor.ts";
import { isRpcClientError } from "../../rpc/client.ts";
import {
  createEnvironmentRpcCommand,
  followStreamInEnvironment,
  runAtomCommand,
  squashAtomCommandFailure,
} from "../../state/runtime.ts";
import type { MissionsRequestTag, MissionsStreamTag, MissionsTransport } from "./rpcSource.ts";

// The Effect side of the missions RPC source: streams run as atoms in the
// client's connection runtime and follow re-pairing and reconnects; requests
// go through the same permission-checked commands as the rest of the app.

export interface AtomMissionsTransportOptions<R, ER> {
  readonly runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>;
  readonly registry: AtomRegistry.AtomRegistry;
  /** The environment whose missions the client reads; `null` while none is connected. */
  readonly environmentId: Atom.Atom<EnvironmentId | null>;
}

const isTransportFailure = (cause: Cause.Cause<unknown>) =>
  cause.reasons.length > 0 &&
  cause.reasons.every((reason) => reason._tag === "Fail" && isRpcClientError(reason.error));

/**
 * One stream per live session. A dropped connection ends the session's stream
 * quietly; the next session starts it again and the server replays its
 * snapshot.
 */
function sessionStream(tag: MissionsStreamTag, input: unknown) {
  return Stream.unwrap(
    Effect.gen(function* () {
      const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
      return SubscriptionRef.changes(supervisor.session).pipe(
        Stream.switchMap(
          Option.match({
            onNone: () => Stream.empty,
            onSome: (session) => {
              const method = session.client[tag] as unknown as (
                payload: unknown,
              ) => Stream.Stream<unknown, unknown>;
              return method(input).pipe(
                Stream.catchCause((cause) =>
                  isTransportFailure(cause) ? Stream.empty : Stream.failCause(cause),
                ),
              );
            },
          }),
        ),
      );
    }),
  );
}

export function createAtomMissionsTransport<R, ER>(
  options: AtomMissionsTransportOptions<R, ER>,
): MissionsTransport {
  const { runtime, registry, environmentId } = options;
  const commands = new Map<string, { readonly run: (...args: never[]) => unknown }>();

  const commandFor = (tag: MissionsRequestTag) => {
    const existing = commands.get(tag);
    if (existing !== undefined) return existing;
    const created = createEnvironmentRpcCommand(runtime, { label: `missions:${tag}`, tag });
    commands.set(tag, created);
    return created;
  };

  return {
    stream(tag, input, onValue, onError) {
      const atom = runtime.atom((get) => {
        const target = get(environmentId);
        if (target === null) return Stream.empty;
        // Chunks, so a burst of items reaches the listener whole rather than
        // as its last item only.
        return Stream.chunks(followStreamInEnvironment(target, sessionStream(tag, input)));
      });
      let delivered: unknown = null;
      return registry.subscribe(
        atom,
        (result) => {
          if (AsyncResult.isSuccess(result)) {
            if (result.value === delivered) return;
            delivered = result.value;
            for (const item of result.value) onValue(item as never);
            return;
          }
          if (!AsyncResult.isFailure(result) || Cause.hasInterruptsOnly(result.cause)) return;
          const error = Cause.squash(result.cause);
          if (Cause.isNoSuchElementError(error)) return;
          onError?.(error);
        },
        { immediate: true },
      );
    },

    async request(tag, input) {
      const target = registry.get(environmentId);
      if (target === null) {
        throw new MissionError({ code: "invalid", detail: "No server is connected." });
      }
      const command = commandFor(tag) as unknown as Parameters<typeof runAtomCommand>[1];
      const result = await runAtomCommand(
        registry,
        command,
        { environmentId: target, input },
        { reportFailure: false, reportDefect: false },
      );
      if (result._tag === "Success") return result.value as never;
      throw squashAtomCommandFailure(result);
    },
  };
}
