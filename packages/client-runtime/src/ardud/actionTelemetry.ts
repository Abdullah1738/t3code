// @effect-diagnostics globalRandom:off - Fallback correlation namespace is non-secret and only used when platform Crypto is unavailable.
import * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as RpcClient from "effect/rpc/RpcClient";
import { recordAnalytics } from "./analytics.ts";

export type ActionPhase =
  | "board-painted"
  | "discussion-painted"
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
  environmentId?: string;
}
export const ACTION_HEADER = "x-robob-action-id";
let sink: ((mark: ActionMark) => void) | undefined;
// The host owns sampling/export. No payload, identity or message text is recorded.
export const setActionTelemetrySink = (next?: (mark: ActionMark) => void) => {
  sink = next;
};
let sequence = 0;
const namespace = Math.random().toString(36).slice(2);
export function startAction(
  name: string,
  id = `action-${namespace}-${++sequence}`,
  environmentId?: string,
): Action {
  const action: Action = {
    id,
    name,
    started: performance.now(),
    ...(environmentId ? { environmentId } : {}),
  };
  markAction(action, "send");
  return action;
}
export function markAction(action: Action, phase: ActionPhase) {
  try {
    if (action.name !== "analytics.ingest" && phase !== "send" && phase !== "state-ready") {
      recordAnalytics(action.environmentId, "performance.action", {
        durationMs: performance.now() - action.started,
        props: { method: action.name, phase },
      });
    }
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

// Action allocation is a hot path; the request already owns the tracing span.
export const allocateAction = Effect.fnUntraced(function* (name: string, environmentId?: string) {
  const crypto = yield* Effect.serviceOption(Crypto.Crypto);
  const id =
    crypto._tag === "Some"
      ? yield* crypto.value.randomUUIDv4().pipe(Effect.orElseSucceed(() => undefined))
      : undefined;
  return startAction(name, id, environmentId);
});

// Hosts call this after their render commit; mobile supplies its frame scheduler.
// Weak keys keep telemetry from retaining snapshots or message payloads.
const valueActions = new WeakMap<object, Action>();
export function bindActionValue(value: unknown, action: Action | undefined) {
  if (value !== null && typeof value === "object" && action) valueActions.set(value, action);
}
export function actionForValue(value: unknown): Action | undefined {
  return value !== null && typeof value === "object" ? valueActions.get(value) : undefined;
}
export function carryActionValue(from: unknown, to: unknown) {
  bindActionValue(to, actionForValue(from));
}
const completedPaints = new WeakMap<Action, Set<ActionPhase>>();
export function paintActionValue(
  value: unknown,
  phase: "board-painted" | "discussion-painted" | "pending-paint" | "authoritative-paint",
  schedule: (callback: () => void) => () => void,
): () => void {
  const action = actionForValue(value);
  return action
    ? schedule(() => {
        const phases = completedPaints.get(action) ?? new Set<ActionPhase>();
        if (phases.has(phase)) return;
        phases.add(phase);
        completedPaints.set(action, phases);
        markAction(action, phase);
      })
    : () => {};
}
