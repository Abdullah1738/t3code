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

  it.effect("parameters are strict: unknown keys are refused, nested ones too", () => {
    const { layer } = toolsLayer();
    return Effect.gen(function* () {
      yield* seed;
      const refused = (name: string, args: Record<string, unknown>) =>
        Effect.exit(call(name, masterThread, args)).pipe(
          Effect.map((exit) => exit._tag === "Failure" || exit.value.isError),
        );
      expect(yield* refused("mission_inbox", { threadId: writerThread })).toBe(true);
      expect(
        yield* refused("mission_subscribe", {
          roomId: control,
          subscriber: { _tag: "thread", threadId: writerThread, asOwner: true },
          mode: "wake",
        }),
      ).toBe(true);
      expect(
        yield* refused("mission_set_member", {
          missionId,
          principal: { _tag: "thread", threadId: strayThread },
          member: true,
          provenance: { _tag: "owner-app", surface: "web", sessionId: null },
        }),
      ).toBe(true);
      // The same calls without the extra keys go through.
      const subscribed = yield* call("mission_subscribe", masterThread, {
        roomId: control,
        subscriber: { _tag: "thread", threadId: writerThread },
        mode: "wake",
      });
      expect(subscribed.isError).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("the master registers members; other threads cannot", () => {
    const { layer } = toolsLayer();
    return Effect.gen(function* () {
      yield* seed;
      const args = {
        missionId,
        principal: { _tag: "session", sessionId: "s-crw", label: "crw" },
        member: true,
      };
      const lane = yield* call("mission_set_member", laneThread, args);
      expect(lane.isError).toBe(true);
      const master = yield* call("mission_set_member", masterThread, args);
      expect(master.isError).toBe(false);
      const router = yield* MissionRouter.MissionRouter;
      const outcome = yield* router.guard({
        path: "control-api",
        targetThreadId: masterThread,
        from: { _tag: "session", sessionId: "s-crw", subject: "crw" },
        text: "review done",
        requestKey: "tools-test:3",
      });
      expect(outcome._tag).toBe("routed");
    }).pipe(Effect.provide(layer));
  });

  it.effect("the master tunes a room through its tool; any member reads the rules", () => {
    const { layer } = toolsLayer();
    return Effect.gen(function* () {
      yield* seed;
      const args = {
        roomId: control,
        muted: true,
        rules: [{ subscriber: { _tag: "thread", threadId: writerThread }, mode: "read" }],
      };
      expect((yield* call("mission_tune_room", laneThread, args)).isError).toBe(true);
      expect((yield* call("mission_tune_room", masterThread, args)).isError).toBe(false);
      const read = yield* call("mission_room_tuning", laneThread, { roomId: control });
      expect(read.structured).toMatchObject({
        tuning: { muted: true, subscriptions: [{ mode: "read", wakeOn: [] }] },
      });
      const attention = yield* call("mission_attention", masterThread, { missionId });
      expect(attention.structured).toEqual({ entries: [] });
      expect((yield* call("mission_attention", laneThread, { missionId })).isError).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("the master opens a room a coord channel can post into", () => {
    const { layer } = toolsLayer();
    return Effect.gen(function* () {
      yield* seed;
      const args = { missionId, slug: "delivery", title: "Delivery" };
      expect((yield* call("mission_create_room", laneThread, args)).isError).toBe(true);
      const opened = yield* call("mission_create_room", masterThread, args);
      expect(opened.structured).toMatchObject({
        room: { id: `${missionId}:room:delivery`, kind: "custom", title: "Delivery" },
      });
      const again = yield* call("mission_create_room", masterThread, {
        ...args,
        title: "Something else",
      });
      expect(again.structured).toMatchObject({ room: { title: "Delivery" } });
      const release = yield* call("mission_create_room", masterThread, {
        missionId,
        slug: "release",
        title: "Ignored",
      });
      expect(release.structured).toMatchObject({ room: { kind: "release", title: "Release" } });
      const badSlug = yield* Effect.exit(
        call("mission_create_room", masterThread, { missionId, slug: "request:x", title: "x" }),
      );
      expect(badSlug._tag).toBe("Failure");
    }).pipe(Effect.provide(layer));
  });

  it.effect("only the master works owner requests through its tools", () => {
    const { layer } = toolsLayer();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      const request = yield* router.openRequest({ missionId, text: "Status?" }, ownerApp);
      for (const [name, args] of [
        ["mission_requests", { missionId }],
        ["mission_request_reply", { requestId: request.id, text: "Fine." }],
        ["mission_request_settle", { requestId: request.id }],
        ["mission_request_open", { missionId, text: "Status?", quotedFrom: "iMessage" }],
      ] as const) {
        expect((yield* call(name, laneThread, args)).isError).toBe(true);
      }
      const listed = yield* call("mission_requests", masterThread, { missionId });
      expect((listed.structured.requests as ReadonlyArray<unknown>).length).toBe(1);
      const replied = yield* call("mission_request_reply", masterThread, {
        requestId: request.id,
        text: "Fine.",
        status: "answered",
      });
      expect(replied.structured).toMatchObject({ request: { status: "answered" } });
      const settled = yield* call("mission_request_settle", masterThread, {
        requestId: request.id,
      });
      expect(settled.structured).toMatchObject({ request: { status: "settled" } });
      const reopened = yield* call("mission_request_reopen", masterThread, {
        requestId: request.id,
      });
      expect(reopened.structured).toMatchObject({ request: { status: "waiting-on-master" } });
    }).pipe(Effect.provide(layer));
  });

  // --- permissions additions ---
  it.effect("a lane's lead answers its permission request; the lane and outsiders cannot", () => {
    const { threads, layer } = toolsLayer();
    return Effect.gen(function* () {
      yield* seed;
      threads.approvals.set(`${laneThread}:perm-1`, {
        requestKind: "command",
        title: "bash",
        prompt: "make deploy",
        options: null,
      });
      const args = { threadId: laneThread, requestId: "perm-1", decision: "accept" };
      expect((yield* call("mission_approval_respond", laneThread, args)).isError).toBe(true);
      expect((yield* call("mission_approval_respond", strayThread, args)).isError).toBe(true);
      const alwaysArgs = { ...args, decision: "acceptAlways" };
      const always = yield* Effect.exit(call("mission_approval_respond", masterThread, alwaysArgs));
      expect(always._tag === "Failure" || always.value.isError).toBe(true);
      expect(threads.answered).toEqual([]);
      const approved = yield* call("mission_approval_respond", masterThread, args);
      expect(approved.isError).toBe(false);
      expect(approved.structured).toMatchObject({ requestId: "perm-1", decision: "accept" });
      expect(threads.answered).toMatchObject([
        { threadId: laneThread, requestId: "perm-1", decision: "accept" },
      ]);
    }).pipe(Effect.provide(layer));
  });
  // --- end permissions additions ---
});
