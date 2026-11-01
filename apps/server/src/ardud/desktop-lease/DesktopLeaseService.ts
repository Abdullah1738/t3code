import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { DesktopLease, DesktopLeaseError, type LeaseRequest } from "./DesktopLease.ts";

export class DesktopLeaseServiceError extends Schema.TaggedError<DesktopLeaseServiceError>()(
  "DesktopLeaseServiceError",
  { code: Schema.String, detail: Schema.String },
) {}

const failure = (cause: unknown) =>
  cause instanceof DesktopLeaseError
    ? new DesktopLeaseServiceError({ code: cause.code, detail: cause.message })
    : new DesktopLeaseServiceError({ code: "unavailable", detail: "Desktop lease storage is unavailable." });

export class DesktopLeaseService extends Context.Service<
  DesktopLeaseService,
  {
    readonly status: () => Effect.Effect<ReturnType<DesktopLease["status"]>, DesktopLeaseServiceError>;
    readonly acquire: (input: LeaseRequest) => Effect.Effect<ReturnType<DesktopLease["acquire"]>, DesktopLeaseServiceError>;
    readonly heartbeat: (ticket: string) => Effect.Effect<ReturnType<DesktopLease["heartbeat"]>, DesktopLeaseServiceError>;
    readonly stop: (ticket: string) => Effect.Effect<ReturnType<DesktopLease["stop"]>, DesktopLeaseServiceError>;
    readonly stopTask: (taskId: string) => Effect.Effect<ReturnType<DesktopLease["stopTask"]>, DesktopLeaseServiceError>;
    readonly release: (ticket: string) => Effect.Effect<ReturnType<DesktopLease["release"]>, DesktopLeaseServiceError>;
    readonly startCall: (ticket: string, callId: string) => Effect.Effect<ReturnType<DesktopLease["startCall"]>, DesktopLeaseServiceError>;
    readonly endCall: (ticket: string, callId: string, outcome: "completed" | "uncertain") => Effect.Effect<ReturnType<DesktopLease["endCall"]>, DesktopLeaseServiceError>;
    readonly recordVerifiedQuiescence: (ticket: string, evidence: string) => Effect.Effect<ReturnType<DesktopLease["recordVerifiedQuiescence"]>, DesktopLeaseServiceError>;
    readonly reconcile: (ticket: string, evidence: string) => Effect.Effect<ReturnType<DesktopLease["reconcile"]>, DesktopLeaseServiceError>;
  }
>()("t3/ardud/desktop-lease/DesktopLeaseService") {}

const make = Effect.gen(function* () {
  const store = yield* Effect.acquireRelease(
    Effect.try({ try: () => new DesktopLease(), catch: failure }),
    (store) => Effect.sync(() => store.close()),
  );
  return DesktopLeaseService.of({
    status: Effect.fn("DesktopLease.status")(function* () {
      return yield* Effect.try({ try: () => store.status(), catch: failure });
    }),
    acquire: Effect.fn("DesktopLease.acquire")(function* (input) {
      return yield* Effect.try({ try: () => store.acquire(input), catch: failure });
    }),
    heartbeat: Effect.fn("DesktopLease.heartbeat")(function* (ticket) {
      return yield* Effect.try({ try: () => store.heartbeat(ticket), catch: failure });
    }),
    stop: Effect.fn("DesktopLease.stop")(function* (ticket) {
      return yield* Effect.try({ try: () => store.stop(ticket), catch: failure });
    }),
    stopTask: Effect.fn("DesktopLease.stopTask")(function* (taskId) {
      return yield* Effect.try({ try: () => store.stopTask(taskId), catch: failure });
    }),
    release: Effect.fn("DesktopLease.release")(function* (ticket) {
      return yield* Effect.try({ try: () => store.release(ticket), catch: failure });
    }),
    startCall: Effect.fn("DesktopLease.startCall")(function* (ticket, callId) {
      return yield* Effect.try({ try: () => store.startCall(ticket, callId), catch: failure });
    }),
    endCall: Effect.fn("DesktopLease.endCall")(function* (ticket, callId, outcome) {
      return yield* Effect.try({ try: () => store.endCall(ticket, callId, outcome), catch: failure });
    }),
    recordVerifiedQuiescence: Effect.fn("DesktopLease.recordVerifiedQuiescence")(function* (ticket, evidence) {
      return yield* Effect.try({ try: () => store.recordVerifiedQuiescence(ticket, evidence), catch: failure });
    }),
    reconcile: Effect.fn("DesktopLease.reconcile")(function* (ticket, evidence) {
      return yield* Effect.try({ try: () => store.reconcile(ticket, evidence), catch: failure });
    }),
  });
});

export const layer = Layer.effect(DesktopLeaseService, make);
