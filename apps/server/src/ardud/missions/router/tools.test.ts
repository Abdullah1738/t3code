import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, RoomId, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as McpHttpServer from "../../../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import { liveThreadsLayer } from "../../../mcp/McpToolAccess.testkit.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import {
  laneThread,
  masterThread,
  missionId,
  ownerApp,
  seed,
  strayThread,
  writerThread,
} from "../asks/AsksService.testkit.ts";
import * as MissionStore from "../store/MissionStore.ts";
import * as MissionRouter from "./MissionRouter.ts";
import { fakeRouterThreads, routerOverFakes } from "./MissionRouter.testkit.ts";
import * as RouterToolHandlers from "./toolHandlers.ts";
import { RouterToolkit } from "./tools.ts";

const threadCaller = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
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

const toolsLayer = () => {
  const threads = fakeRouterThreads();
  return {
    threads,
    layer: McpHttpServer.toolkitRegistration(RouterToolkit, RouterToolHandlers.layer).pipe(
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provideMerge(liveThreadsLayer),
      Layer.provideMerge(routerOverFakes(threads)),
      Layer.provideMerge(MissionStore.layer),
      Layer.provideMerge(Sqlite.layerMemory),
    ),
  };
};

const call = (name: string, threadId: ThreadId, args: Record<string, unknown>) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name, arguments: args })),
    Effect.map((result) => ({
      isError: result.isError === true,
      text: result.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
      structured: (result.structuredContent as Record<string, unknown> | undefined) ?? {},
    })),
    Effect.provideService(McpInvocationContext.McpInvocationContext, threadCaller(threadId)),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
  );

const control = RoomId.make(`${missionId}:room:control`);

describe("router MCP tools", () => {
  it.effect("the wake line's tools read the caller's own inbox and ack by reading", () => {
    const { layer, threads } = toolsLayer();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      yield* router.post(
        {
          missionId,
          roomId: control,
          kind: "request",
          summary: "Rebase the API branch",
          body: "Main moved; rebase before review.",
          to: [{ _tag: "thread", threadId: writerThread }],
        },
        ownerApp,
      );
      expect(threads.sent.filter((each) => each.threadId === writerThread)).toHaveLength(1);

      const inbox = yield* call("mission_inbox", writerThread, {});
      expect(inbox.isError).toBe(false);
      expect(inbox.structured.unread).toBe(1);
      const [entry] = inbox.structured.entries as ReadonlyArray<{
        body: string;
        message: { seq: number };
      }>;
      expect(entry?.body).toBe("Main moved; rebase before review.");

      // Another member's inbox is its own; nothing leaks across threads.
      const lane = yield* call("mission_inbox", laneThread, {});
      expect(lane.structured.unread).toBe(0);

      const read = yield* call("mission_mark_read", writerThread, {
        roomId: control,
        seq: entry?.message.seq ?? 0,
      });
      expect(read.isError).toBe(false);
      const after = yield* call("mission_inbox", writerThread, {});
      expect(after.structured.unread).toBe(0);

      const page = yield* call("mission_room", writerThread, { roomId: control });
      expect(page.isError).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("outsiders cannot read rooms and only the master sees its decidable knocks", () => {
    const { layer } = toolsLayer();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      yield* router.post(
        { missionId, roomId: control, kind: "status", summary: "Green" },
        ownerApp,
      );
      const outsider = yield* call("mission_room", strayThread, { roomId: control });
      expect(outsider.isError).toBe(true);
      expect(outsider.text).toContain("not a member");

      // One knock for the master (owner's alone), one for the lane (master may decide).
      const toMaster = yield* router.guard({
        path: "thread-send",
        targetThreadId: masterThread,
        from: { _tag: "thread", threadId: strayThread, title: "Stray" },
        text: "hey master",
        requestKey: "tools-test:1",
      });
      const toLane = yield* router.guard({
        path: "thread-send",
        targetThreadId: laneThread,
        from: { _tag: "thread", threadId: strayThread, title: "Stray" },
        text: "hey lane",
        requestKey: "tools-test:2",
      });
      if (toMaster._tag !== "knocked" || toLane._tag !== "knocked") {
        return expect.unreachable("expected two knocks");
      }

      const listed = yield* call("mission_knocks", masterThread, { missionId });
      expect(listed.isError).toBe(false);
      expect((listed.structured.knocks as ReadonlyArray<{ id: string }>).map((k) => k.id)).toEqual([
        toLane.knockId,
      ]);
      const lane = yield* call("mission_knocks", laneThread, { missionId });
      expect(lane.isError).toBe(true);

      const refused = yield* call("mission_knock_decide", masterThread, {
        knockId: toMaster.knockId,
        action: "drop",
      });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("Only the owner decides knocks addressed to the master");
      const dropped = yield* call("mission_knock_decide", masterThread, {
        knockId: toLane.knockId,
        action: "drop",
      });
      expect(dropped.isError).toBe(false);
    }).pipe(Effect.provide(layer));
  });
});
