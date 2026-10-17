import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, RoleId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as McpHttpServer from "../../../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import { liveThreadsLayer } from "../../../mcp/McpToolAccess.testkit.ts";
import * as MissionService from "../MissionService.ts";
import { HAIKU, OPUS_XHIGH, SOL_XHIGH, modelKey } from "./models.ts";
import * as PolicyService from "./PolicyService.ts";
import { CRPKO, OWNER, makePorts, testLayer } from "./testing.ts";
import * as PolicyToolHandlers from "./toolHandlers.ts";
import { PolicyToolkit } from "./tools.ts";

const threadCaller = (threadId: string): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: `provider:${threadId}`,
  thread: {
    threadId: ThreadId.make(threadId),
    providerSessionId: `provider:${threadId}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});

const clientCaller: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "client:session",
  thread: undefined,
  client: { sessionId: "session", label: "Claude Code", access: "full-access" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};

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

interface ToolOutcome {
  readonly isError: boolean;
  readonly text: string;
  readonly structured: Record<string, unknown>;
}

const call = (
  name: string,
  scope: McpInvocationContext.McpInvocationScope,
  args: Record<string, unknown>,
) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name, arguments: args })),
    Effect.map((result): ToolOutcome => ({
      isError: result.isError === true,
      text: result.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
      structured: (result.structuredContent as Record<string, unknown> | undefined) ?? {},
    })),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
  );

const ports = makePorts();
const toolsLayer = McpHttpServer.toolkitRegistration(PolicyToolkit, PolicyToolHandlers.layer).pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(liveThreadsLayer),
  Layer.provideMerge(testLayer(ports.layer)),
);

const seed = Effect.gen(function* () {
  const missions = yield* MissionService.MissionService;
  const policy = yield* PolicyService.PolicyService;
  yield* missions.createMission(OWNER, { missionId: CRPKO, slug: "crpko", title: "Crpko" });
  ports.threads.set("thread-master", { exists: true, idle: true, modelSelection: OPUS_XHIGH });
  ports.threads.set("thread-writer", { exists: true, idle: true, modelSelection: HAIKU });
  yield* policy.bindRole(OWNER, {
    roleId: RoleId.make("crpko:master"),
    threadId: ThreadId.make("thread-master"),
  });
});

describe("mission policy MCP tools", () => {
  it.effect("gives the master every role, review and pool control as the calling thread", () =>
    Effect.gen(function* () {
      yield* seed;
      const master = threadCaller("thread-master");
      const stranger = threadCaller("thread-stranger");

      // Reads work for any caller, including a signed-in MCP client.
      const roles = yield* call("mission_roles", clientCaller, { missionId: CRPKO });
      expect(roles.isError).toBe(false);
      const listed = roles.structured.roles as ReadonlyArray<{ id: string }>;
      expect(listed.map((role) => role.id)).toContain("crpko:reviewer");

      // The master binds a writer and moves the reviewer to Haiku, then cancels.
      const bound = yield* call("mission_role_bind", master, {
        roleId: "crpko:writer",
        threadId: "thread-writer",
      });
      expect(bound.isError).toBe(false);
      const moved = yield* call("mission_role_model", master, {
        roleId: "crpko:reviewer",
        modelSelection: HAIKU,
        reason: "trial",
      });
      expect(moved.isError).toBe(false);
      const cancelled = yield* call("mission_role_model", master, {
        roleId: "crpko:reviewer",
        modelSelection: SOL_XHIGH,
        reason: "back",
      });
      expect(cancelled.isError).toBe(false);
      const policy = yield* PolicyService.PolicyService;
      const after = yield* policy.roles(CRPKO);
      const reviewer = after.roles.find((role) => role.id === "crpko:reviewer");
      expect(reviewer?.pendingModelSelection).toBeNull();
      expect(modelKey(reviewer!.modelSelection)).toBe(modelKey(SOL_XHIGH));

      // A thread with no master role is refused, and the refusal says so.
      const refused = yield* call("mission_role_model", stranger, {
        roleId: "crpko:reviewer",
        modelSelection: HAIKU,
        reason: "nope",
      });
      expect(refused.isError).toBe(true);

      // Review: the master writes a guide, records a verdict and reads the plan.
      const guide = yield* call("mission_criticality_guide", master, {
        missionId: CRPKO,
        text: "Critical: anything that moves real funds.",
        hardTriggers: [{ _tag: "changed-lines", atLeast: 1500 }],
      });
      expect(guide.isError).toBe(false);
      const pullRequest = { repository: "crpko/ledger", number: 7 };
      const verdict = yield* call("mission_criticality", master, {
        missionId: CRPKO,
        pullRequest,
        critical: true,
        reason: "settlement math",
      });
      expect(verdict.isError).toBe(false);
      const plan = yield* call("mission_review_plan", master, {
        missionId: CRPKO,
        pullRequest,
        headSha: "abc123",
      });
      expect(plan.isError).toBe(false);
      expect(plan.structured.ladderId).toBe("critical");
      expect(plan.structured.mergeAllowed).toBe(false);

      // Pools: any scope, any capacity, holds with fences.
      const created = yield* call("mission_pool_create", master, {
        poolId: "crpko-review-slots",
        name: "Crpko review slots",
        unit: "review",
        capacity: 1,
        scope: { _tag: "mission", missionId: CRPKO },
        kind: "lease",
        backend: "native",
      });
      expect(created.isError).toBe(false);
      const raised = yield* call("mission_pool_capacity", master, {
        poolId: "crpko-review-slots",
        capacity: 3,
      });
      expect(raised.isError).toBe(false);
      const taken = yield* call("mission_hold_take", master, {
        poolId: "crpko-review-slots",
        missionId: CRPKO,
        purpose: "review crpko/ledger#7",
        ttlSeconds: 600,
      });
      expect(taken.isError).toBe(false);
      const hold = taken.structured.hold as { id: string; fence: number; status: string };
      expect(hold.status).toBe("active");
      expect(hold.fence).toBe(1);
      const wrongFence = yield* call("mission_hold_release", master, {
        holdId: hold.id,
        fence: 9,
        note: "done",
      });
      expect(wrongFence.isError).toBe(true);
      expect(wrongFence.text).toContain("fence-mismatch");
      const released = yield* call("mission_hold_release", master, {
        holdId: hold.id,
        fence: hold.fence,
        note: "done",
      });
      expect(released.isError).toBe(false);

      // Writes need a T3 thread, not just a signed-in client.
      const fromClient = yield* call("mission_pool_capacity", clientCaller, {
        poolId: "crpko-review-slots",
        capacity: 5,
      });
      expect(fromClient.isError).toBe(true);
    }).pipe(Effect.provide(toolsLayer)),
  );
});
