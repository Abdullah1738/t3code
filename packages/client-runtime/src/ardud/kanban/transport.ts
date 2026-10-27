import { KANBAN_WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, type Atom, type AtomRegistry } from "effect/reactivity";

import type * as EnvironmentRegistry from "../../connection/registry.ts";
import * as EnvironmentSupervisor from "../../connection/supervisor.ts";
import { isRpcClientError, type EnvironmentRpcSuccess } from "../../rpc/client.ts";
import type { WsRpcProtocolClient } from "../../rpc/protocol.ts";
import {
  createEnvironmentRpcCommand,
  followStreamInEnvironment,
  runAtomCommand,
  squashAtomCommandFailure,
} from "../../state/runtime.ts";
import type { Unsubscribe } from "../common/store.ts";

type KanbanMethod = (typeof KANBAN_WS_METHODS)[keyof typeof KANBAN_WS_METHODS];
export type KanbanStreamTag = typeof KANBAN_WS_METHODS.subscribe | typeof KANBAN_WS_METHODS.boards;
export type KanbanRequestTag = Exclude<KanbanMethod, KanbanStreamTag>;
export type KanbanRpcInput<TTag extends KanbanMethod> = Parameters<WsRpcProtocolClient[TTag]>[0];
export type KanbanStreamValue<TTag extends KanbanStreamTag> = WsRpcProtocolClient[TTag] extends (
  input: any,
  options?: any,
) => Stream.Stream<infer A, any, any>
  ? A
  : never;

export interface KanbanTransport {
  /** Calls `onValue` for every item; follows reconnects, so a new snapshot follows a drop. */
  stream<TTag extends KanbanStreamTag>(
    tag: TTag,
    input: KanbanRpcInput<TTag>,
    onValue: (value: KanbanStreamValue<TTag>) => void,
    onError?: (error: unknown) => void,
  ): Unsubscribe;
  request<TTag extends KanbanRequestTag>(
    tag: TTag,
    input: KanbanRpcInput<TTag>,
  ): Promise<EnvironmentRpcSuccess<TTag>>;
}

/** No server is connected yet. Reads wait and retry on it instead of failing. */
export class KanbanOfflineError extends Error {
  readonly _tag = "KanbanOfflineError";
  readonly detail = "No server is connected.";
  constructor() {
    super("No server is connected.");
  }
}

const SERVER_ANSWER_TAGS = new Set(["KanbanError", "EnvironmentAuthorizationError"]);

/** True for an answer from the server (not found, denied...), as opposed to a dropped or missing connection. */
export const isKanbanServerError = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  SERVER_ANSWER_TAGS.has(String((error as { readonly _tag?: unknown })._tag));

export interface AtomKanbanTransportOptions<R, ER> {
  readonly runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>;
  readonly registry: AtomRegistry.AtomRegistry;
  readonly environmentId: Atom.Atom<EnvironmentId | null>;
}

const isTransportFailure = (cause: Cause.Cause<unknown>) =>
  cause.reasons.length > 0 &&
  cause.reasons.every((reason) => reason._tag === "Fail" && isRpcClientError(reason.error));

// A dropped connection ends the session's stream quietly and the next session
// replays the snapshot.
function sessionStream(tag: KanbanStreamTag, input: unknown) {
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

export function createAtomKanbanTransport<R, ER>(
  options: AtomKanbanTransportOptions<R, ER>,
): KanbanTransport {
  const { runtime, registry, environmentId } = options;
  const commands = new Map<string, { readonly run: (...args: never[]) => unknown }>();

  const commandFor = (tag: KanbanRequestTag) => {
    const existing = commands.get(tag);
    if (existing !== undefined) return existing;
    const created = createEnvironmentRpcCommand(runtime, { label: `kanban:${tag}`, tag });
    commands.set(tag, created);
    return created;
  };

  return {
    stream(tag, input, onValue, onError) {
      const atom = runtime.atom((get) => {
        const target = get(environmentId);
        if (target === null) return Stream.empty;
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
        throw new KanbanOfflineError();
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
