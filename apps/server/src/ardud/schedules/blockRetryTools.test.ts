import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
  type RuntimeMode,
  type ScheduledTask,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";
import * as SqlClient from "effect/sql/SqlClient";

import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import { liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as BlockRetry from "./blockRetryTools.ts";
import { ensureRunFollowTables, readBlockRetry, writeBlockRetry } from "./runFollow.ts";

const lowCaller = ThreadId.make("t-low");
const boundThread = ThreadId.make("t-bound");
const fallback = { instanceId: "opencode", model: "opus/gpt-6-astra" } as never;

/** Bound to a thread that now runs above the task's own modes. */
const task = {
  id: ScheduledTaskId.make("scheduled-task:bound"),
  title: "Bound check",
  threadId: boundThread,
  createdAt: "2026-10-22T00:00:00.000Z",
  runtimeMode: "approval-required",
  interactionMode: "default",
} as unknown as ScheduledTask;

/** Starts new threads; lowered to approval-required after a full-access run started. */
const unbound = {
  ...task,
  id: ScheduledTaskId.make("scheduled-task:unbound"),
  title: "Nightly",
  threadId: null,
} as unknown as ScheduledTask;

const modesOf: Record<string, RuntimeMode> = { [lowCaller]: "approval-required" };

const caller = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: `provider:${threadId}`,
  thread: {
    threadId,
    providerSessionId: `provider:${threadId}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const layer = McpHttpServer.toolkitRegistration(
  BlockRetry.ScheduledTaskBlockRetryToolkit,
  BlockRetry.layer,
).pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: (threadId) =>
        Effect.succeed(
          liveThreadShell(threadId, { runtimeMode: modesOf[threadId] ?? "full-access" }),
        ),
    }),
  ),
  Layer.provideMerge(
    Layer.mock(ScheduledTaskService.ScheduledTaskService)({
      list: () => Effect.succeed({ tasks: [task, unbound], timeZone: "UTC" } as never),
    }),
  ),
  Layer.provideMerge(Sqlite.layerMemory),
);

const call = (threadId: ThreadId, args: Record<string, unknown>) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) =>
      server.callTool({ name: "t3_scheduled_task_block_retry", arguments: args }),
    ),
    Effect.map((result) => ({
      isError: result.isError === true,
      text: result.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
    })),
    Effect.provideService(McpInvocationContext.McpInvocationContext, caller(threadId)),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
  );

describe("t3_scheduled_task_block_retry", () => {
  it.effect("changes to a bound task's retry pass the same checks as an edit", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // Armed while the task was unbound, then bound.
      yield* writeBlockRetry(sql, task, {
        fallbacks: [fallback],
        limits: { runtimeMode: "full-access", interactionMode: "default" },
      });
      const clear = { scheduledTaskId: task.id, fallbacks: null };

      // Within the task's modes, but below the bound thread's current ones.
      const fromLow = yield* call(lowCaller, clear);
      expect(fromLow.isError).toBe(true);
      expect(fromLow.text).toContain("broader than");
      expect(yield* readBlockRetry(sql, task)).not.toBeNull();

      const fromBound = yield* call(boundThread, clear);
      expect(fromBound.isError).toBe(false);
      expect(yield* readBlockRetry(sql, task)).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("arming checks the modes a run already started with", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* ensureRunFollowTables(sql);
      const launch = JSON.stringify({
        projectId: "project-1",
        title: unbound.title,
        workspaceStrategy: { type: "root" },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdBy: "agent",
        creationSource: "mcp",
      });
      yield* sql`
        INSERT INTO ardud_scheduled_task_follows
          (task_id, task_created_at, started_at, since, fire_key, prompt, launch_json, thread_id)
        VALUES (${unbound.id}, ${unbound.createdAt}, '2026-10-22T20:00:00.000Z',
          '2026-10-22T20:00:00.000Z', 'fire', 'Run the review.', ${launch}, 'thread-run')
      `;
      const arm = { scheduledTaskId: unbound.id, fallbacks: [fallback] };

      const fromLow = yield* call(lowCaller, arm);
      expect(fromLow.isError).toBe(true);
      expect(fromLow.text).toContain("broader than");
      expect(yield* readBlockRetry(sql, unbound)).toBeNull();

      // Once that run has been retried, arming can't reach it any more. The
      // caller's modes are kept, so a launch still in flight can't retry above them.
      yield* sql`UPDATE ardud_scheduled_task_follows SET attempt = 1`;
      const later = yield* call(lowCaller, arm);
      expect(later.isError).toBe(false);
      expect(yield* readBlockRetry(sql, unbound)).toEqual({
        fallbacks: [fallback],
        limits: { runtimeMode: "approval-required", interactionMode: "default" },
      });
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
