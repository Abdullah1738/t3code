import { assert, it } from "@effect/vitest";
import { CommandId, ControlErrorBody, OrchestratorMcpFailure, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { ControlError, operationFailure, rejectionDetails } from "./ControlErrors.ts";

const threadId = ThreadId.make("thread");
const commandId = CommandId.make("command");
const decodeError = Schema.decodeUnknownSync(ControlErrorBody);

it("preserves a send deadline's same-id retry guarantee as 503", () => {
  const error = operationFailure(
    new OrchestratorMcpFailure({
      code: "send_timeout",
      message: "Nothing saved; retry with clientRequestId original.",
    }),
  );
  assert.equal(error.code, "unavailable");
  assert.deepEqual(rejectionDetails(error), {
    reason: "send_timeout",
    retrySafe: true,
    holder: null,
  });
  assert.include(error.message, "original");
});

it("unwraps a typed preflight refusal while preserving the holder it observed", () => {
  const holder = { threadId, runId: "last-run", status: "failed" };
  const error = operationFailure(
    new Orchestrator.OrchestratorDispatchError({
      commandId,
      commandType: "message.dispatch",
      cause: new ThreadManagement.ThreadManagementNoSteerableRunError({
        threadId,
        mode: "steer",
        holder,
      }),
    }),
  );
  assert.equal(error.code, "conflict");
  assert.deepEqual(rejectionDetails(error), {
    reason: "no_steerable_turn",
    retrySafe: true,
    holder,
  });
  decodeError({
    code: error.code,
    message: error.message,
    ...rejectionDetails(error),
  });
});

it("does not label a storage failure or ambiguous accepted outcome as a retryable conflict", () => {
  for (const cause of [
    new Error("storage failed"),
    new Orchestrator.OrchestratorDispatchError({
      commandId,
      commandType: "message.dispatch",
      cause: new Error("commit response lost"),
    }),
  ]) {
    const error = operationFailure(cause);
    assert.equal(error.code, "internal");
    assert.isUndefined(rejectionDetails(error));
  }
});

it("keeps unknown conflicts conservative and retains already classified errors", () => {
  const error = new ControlError({ code: "conflict", message: "refused" });
  assert.strictEqual(operationFailure(error), error);
  assert.deepEqual(rejectionDetails(error), {
    reason: "operation_conflict",
    retrySafe: false,
    holder: null,
  });
});
