// @effect-diagnostics globalRandom:off - Fallback correlation namespace is non-secret and only used when platform Crypto is unavailable.
import * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as RpcClient from "effect/rpc/RpcClient";

export type ActionPhase =
  | "send"
  | "pending-paint"
  | "durable-ack"
  | "authoritative-paint"
  | "decode"
  | "state-ready";
export interface ActionMark {
  actionId: string;
  action: string;
  phase: ActionPhase;
  elapsedMs: number;
}
export interface Action {
  id: string;
  name: string;
  started: number;
}
export const ACTION_HEADER = "x-robob-action-id";
let sink: ((mark: ActionMark) => void) | undefined;
// The host owns sampling/export. No payload, identity or message text is recorded.
export const setActionTelemetrySink = (next?: (mark: ActionMark) => void) => {
  sink = next;
};
let sequence = 0;
const namespace = Math.random().toString(36).slice(2);
export function startAction(name: string, id = `action-${namespace}-${++sequence}`): Action {
  const action = { id, name, started: performance.now() };
  markAction(action, "send");
  return action;
}
export function markAction(action: Action, phase: ActionPhase) {
  try {
    sink?.({
      actionId: action.id,
      action: action.name,
      phase,
      elapsedMs: performance.now() - action.started,
    });
  } catch {
    /* Export must never fail a user action. */
  }
}
export class CurrentAction extends Context.Reference<Action | undefined>("@t3tools/CurrentAction", {
  defaultValue: () => undefined,
}) {}
export function withAction<A, E, R>(effect: Effect.Effect<A, E, R>, action: Action) {
  return effect.pipe(
    RpcClient.withHeaders({ [ACTION_HEADER]: action.id }),
    Effect.provideService(CurrentAction, action),
    Effect.withSpan("client.action", {
      attributes: { "action.id": action.id, "action.name": action.name },
    }),
  );
}

export const allocateAction = (name: string) =>
  Effect.gen(function* () {
    const crypto = yield* Effect.serviceOption(Crypto.Crypto);
    const id =
      crypto._tag === "Some"
        ? yield* crypto.value.randomUUIDv4().pipe(Effect.orElseSucceed(() => undefined))
        : undefined;
    return startAction(name, id);
  });
