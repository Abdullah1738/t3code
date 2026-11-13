import { expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import { ClientAbort as HttpClientAbort } from "effect/http/HttpServerError";
import { ClientAbort as RpcClientAbort } from "effect/rpc/RpcSchema";
import { AnalyticsInterruptCause, interruptionProps } from "./analyticsInterruption.ts";

it("uses typed interruption evidence and never diagnoses from exception text", () => {
  for (const annotation of [HttpClientAbort.annotation, RpcClientAbort.annotation]) {
    expect(interruptionProps(Cause.annotate(Cause.interrupt(), annotation))).toEqual({
      cause: "client_disconnect",
    });
  }
  for (const reason of ["stop", "shutdown", "deadline"] as const)
    expect(
      interruptionProps(Cause.annotate(Cause.interrupt(), AnalyticsInterruptCause.context(reason))),
    ).toEqual({ cause: reason });
  expect(interruptionProps(Cause.interrupt())).toEqual({ cause: "unknown" });
  expect(interruptionProps(Cause.fail(new Cause.TimeoutError("private")))).toEqual({
    cause: "deadline",
  });
  expect(interruptionProps(Cause.fail(new Error("shutdown stop deadline token=private")))).toEqual(
    {},
  );
});
