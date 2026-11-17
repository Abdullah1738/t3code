import { OrchestratorMcpFailure, type OrchestratorMcpThreadSendInput } from "@t3tools/contracts";
import { OrchestratorToolkit } from "./tools.ts";
import * as Effect from "effect/Effect";

import { readCaller } from "../../threadAccess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import * as ThreadMetadataMcpService from "../../ThreadMetadataMcpService.ts";

import * as BackgroundTerminals from "../../../ardud/exec-sessions/BackgroundTerminals.ts";

const handlers = Effect.gen(function* () {
  const serviceScope = yield* Effect.scope;
  return {
    t3_exec_sessions: McpToolAccess.readsAsCaller(() =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* BackgroundTerminals.BackgroundTerminals;
        return yield* service.listBackgroundTerminals(scope);
      }),
    ),
    t3_exec_session_stop: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* BackgroundTerminals.BackgroundTerminals;
        return yield* service.stopBackgroundTerminal(scope, input);
      }),
    ),
    orchestrator_capabilities: McpToolAccess.reads(() =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        return yield* service.capabilities(scope);
      }),
    ),
    delegate_task: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        return yield* service.delegateTask(scope, input);
      }),
    ),
    task_status: McpToolAccess.readsAsCaller(({ taskId }) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        return yield* service.taskStatus(scope, taskId);
      }),
    ),
    task_cancel: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        return yield* service.cancelTask(scope, input);
      }),
    ),
    t3_workflow_stop: McpToolAccess.writesThreads(
      (input) => [input.threadId],
      (input) =>
        Effect.gen(function* () {
          const { threads } = yield* readCaller();
          return yield* threads.stopWorkflow(input).pipe(
            Effect.as({}),
            Effect.mapError(
              (cause) =>
                new OrchestratorMcpFailure({
                  reason: "invalid_args",
                  code:
                    cause.reason === "unavailable" || cause.reason === "stop-failed"
                      ? "orchestration_error"
                      : "invalid_request",
                  message: cause.message,
                }),
            ),
          );
        }),
    ),
    schedule_task: McpToolAccess.startsThreads(
      () => ({}),
      (input) =>
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext.McpInvocationContext;
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          return yield* service.scheduleTask(scope, input);
        }),
    ),
    list_scheduled_tasks: McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        return yield* service.listScheduledTasks(scope, input);
      }),
    ),
    update_scheduled_task: McpToolAccess.writes((input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        return yield* service.updateScheduledTask(scope, input);
      }),
    ),
    delete_scheduled_task: McpToolAccess.writes((input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        return yield* service.deleteScheduledTask(scope, input);
      }),
    ),
    request_secret: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        return yield* service.requestSecret(scope, input);
      }),
    ),
    create_threads: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        return yield* service.createThreads(scope, input);
      }),
    ),
    t3_thread_list: McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        return yield* service.listThreads(scope, input);
      }),
    ),
    t3_thread_read: McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        return yield* service.readThread(scope, input);
      }),
    ),
    t3_thread_update: McpToolAccess.writesThreads(
      (input) => [input.threadId],
      (input) =>
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext.McpInvocationContext;
          const service = yield* ThreadMetadataMcpService.ThreadMetadataMcpService;
          return yield* service.update(scope, input);
        }),
    ),
    t3_thread_send: McpToolAccess.boundedThreadSend(
      McpToolAccess.writesThreads(
        (input: OrchestratorMcpThreadSendInput) => [input.threadId],
        (input: OrchestratorMcpThreadSendInput) =>
          Effect.gen(function* () {
            const scope = yield* McpInvocationContext.McpInvocationContext;
            const service = yield* OrchestratorMcpService.OrchestratorMcpService;
            return yield* service.sendToThread(scope, input);
          }),
      ),
      serviceScope,
    ),
    t3_thread_wait: McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        return yield* service.waitForThread(scope, input);
      }),
    ),
    t3_thread_interrupt: McpToolAccess.writesThreads(
      (input) => [input.threadId],
      (input) =>
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext.McpInvocationContext;
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          return yield* service.interruptThread(scope, input);
        }),
    ),
  } satisfies McpToolAccess.Handlers<typeof OrchestratorToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(OrchestratorToolkit, handlers);
