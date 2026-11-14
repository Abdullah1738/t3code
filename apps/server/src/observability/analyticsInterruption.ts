import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import { ClientAbort as HttpClientAbort } from "effect/http/HttpServerError";
import { ClientAbort as RpcClientAbort } from "effect/rpc/RpcSchema";

export class AnalyticsInterruptCause extends Context.Service<
  AnalyticsInterruptCause,
  "shutdown" | "stop" | "deadline"
>()("t3/observability/analyticsInterruption/AnalyticsInterruptCause") {}

export const interruptionProps = (cause: Cause.Cause<unknown>) => {
  const annotations = Cause.annotations(cause);
  const known = Context.getOrUndefined(annotations, AnalyticsInterruptCause);
  const disconnected =
    Context.getOrUndefined(annotations, HttpClientAbort) === true ||
    Context.getOrUndefined(annotations, RpcClientAbort) === true;
  const deadline = cause.reasons.some(
    (reason) => reason._tag === "Fail" && Cause.isTimeoutError(reason.error),
  );
  if (!Cause.hasInterrupts(cause) && !deadline) return {};
  // A fiber id alone cannot distinguish Stop, shutdown and an internal cancellation.
  return {
    cause:
      known ??
      (disconnected
        ? ("client_disconnect" as const)
        : deadline
          ? ("deadline" as const)
          : ("unknown" as const)),
  };
};
