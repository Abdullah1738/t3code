import { ControlRejectionHolder, type ControlRejection } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Data from "effect/Data";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { userFacingDispatchErrorMessage } from "../../orchestration-v2/UserFacingErrors.ts";

export type ControlErrorCode =
  | "unauthorized"
  | "forbidden"
  | "invalid_request"
  | "not_found"
  | "conflict"
  | "unavailable"
  | "internal";

export class ControlError extends Data.TaggedError("ControlError")<{
  readonly code: ControlErrorCode;
  readonly message: string;
  readonly rejection?: ControlRejection;
  readonly failure?: { readonly errorTag: string; readonly reason: string };
}> {}

export const fail = (code: ControlErrorCode, message: string, rejection?: ControlRejection) =>
  new ControlError({ code, message, ...(rejection === undefined ? {} : { rejection }) });

export const errorDetail = (cause: unknown): string =>
  userFacingDispatchErrorMessage(cause) ?? (cause instanceof Error ? cause.message : String(cause));

// Unknown refusals are actionable as alerts, never as permission to retry a mutation.
export const rejectionDetails = (error: ControlError): ControlRejection | undefined =>
  error.rejection ??
  (error.code === "conflict"
    ? { reason: "operation_conflict", retrySafe: false, holder: null }
    : undefined);

const isHolder = Schema.is(ControlRejectionHolder);

export function operationFailure(cause: unknown, depth = 0): ControlError {
  if (cause instanceof ControlError) return cause;
  const message = errorDetail(cause);
  const tagged = Predicate.isObject(cause) ? cause : {};
  const holder = isHolder(tagged.holder)
    ? tagged.holder
    : typeof tagged.threadId === "string"
      ? {
          threadId: tagged.threadId,
          runId: typeof tagged.runId === "string" ? tagged.runId : null,
          status: null,
        }
      : null;
  const refusal = (reason: ControlRejection["reason"], retrySafe = false) =>
    fail("conflict", message, { reason, retrySafe, holder });
  switch (tagged._tag) {
    case "ProviderSessionEndedError":
      return refusal("no_steerable_turn");
    case "ThreadManagementNoSteerableRunError":
      return refusal("no_steerable_turn", true);
    case "ThreadManagementThreadArchivedError":
      return refusal("thread_archived");
    case "ThreadManagementThreadNotInterruptibleError":
      return refusal("run_not_interruptible");
    case "ThreadManagementRunNotFoundError":
      return refusal("run_not_found");
    case "ThreadManagementThreadNotFoundError":
      return fail("not_found", message);
    case "AttachmentClaimError":
      // Claim I/O failures retain a cause; validation refusals do not.
      return fail(tagged.cause === undefined ? "invalid_request" : "internal", message);
    case "OrchestratorCommandIdConflictError":
      return refusal("command_id_conflict");
    case "ServerRuntimeStartupError":
      return fail("unavailable", message, {
        reason: "startup_unavailable",
        retrySafe: true,
        holder,
      });
    case "OrchestratorMcpFailure":
      if (tagged.code === "send_timeout")
        return fail("unavailable", message, { reason: "send_timeout", retrySafe: true, holder });
      break;
    case "OrchestratorDispatchError":
      if (typeof tagged.cause === "string") return refusal("command_rejected");
      // Dispatch wraps typed preflight failures; preserve their transport meaning.
      if (depth < 4 && Predicate.isObject(tagged.cause) && "_tag" in tagged.cause)
        return operationFailure(tagged.cause, depth + 1);
      break;
    case "OrchestratorCommandRejectedError":
    case "OrchestratorCommandPreviouslyRejectedError":
      return refusal("command_rejected");
    case "OrchestratorThreadAlreadyExistsError":
    case "OrchestratorSubagentThreadReadOnlyError":
    case "OrchestratorThreadAboveModeLimitError":
    case "ThreadManagementProviderInstanceDisabledError":
    case "ProjectConflictError":
    case "ProjectNotEmptyError":
    case "CommandPolicyUnsupportedError":
    case "CommandPolicyCapabilityUnsupportedError":
      return refusal("operation_conflict");
    case "ThreadLaunchError":
      if (depth < 4 && Predicate.isObject(tagged.cause) && "_tag" in tagged.cause)
        return operationFailure(tagged.cause, depth + 1);
      break;
  }
  if (NodeSqliteClient.readerLaneFailure(cause) !== undefined)
    return fail("unavailable", message, { reason: "reader_unavailable", retrySafe: false, holder });
  return fail("internal", message);
}
