/**
 * MCP callers as guard principals. The calling thread comes from the
 * invocation scope the MCP transport authenticated, never from tool input.
 */
import { OrchestratorMcpFailure, type ScheduledTaskError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { McpInvocationScope } from "../../../mcp/McpInvocationContext.ts";
import type { SendGuardFailed, SendRefused } from "../router/guardPaths.ts";
import { CurrentPrincipal, type GuardPrincipal } from "./principal.ts";
import { refusedByGuard } from "./schedules.ts";

export const mcpPrincipal = (
  scope: Pick<McpInvocationScope, "thread" | "client">,
  thread?: { readonly title: string },
): GuardPrincipal =>
  scope.thread !== undefined
    ? {
        _tag: "thread",
        threadId: scope.thread.threadId,
        title: thread?.title ?? scope.thread.threadId,
      }
    : {
        _tag: "mcp-client",
        sessionId: scope.client?.sessionId ?? "unknown",
        label: scope.client?.label ?? "unidentified MCP caller",
      };

/** Runs schedule service calls as this MCP caller. */
export const schedulesAs =
  (principal: GuardPrincipal) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.provideService(effect, CurrentPrincipal, principal);

/** A guard refusal is `capability_denied`; a guard failure is an orchestration error. */
export const guardFailure = (error: SendRefused | SendGuardFailed): OrchestratorMcpFailure =>
  new OrchestratorMcpFailure({
    code: error._tag === "SendRefused" ? "capability_denied" : "orchestration_error",
    message: error.message,
  });

/** A guard refusal is `capability_denied` with the guard's explanation. */
export const scheduleFailure =
  (prefix: string) =>
  (error: ScheduledTaskError): OrchestratorMcpFailure =>
    refusedByGuard(error)
      ? new OrchestratorMcpFailure({ code: "capability_denied", message: error.message })
      : new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: `${prefix}: ${error.message}`,
        });
