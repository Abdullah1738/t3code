// @effect-diagnostics nodeBuiltinImport:off - builds throwaway bridge chat stores for the chat lookup.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthSessionId, MissionMessageId, type MissionId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { HttpServerRequest } from "effect/http";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";

import * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import { masterThread, missionId, ownerApp, seed } from "../asks/AsksService.testkit.ts";
import * as MissionStore from "../store/MissionStore.ts";
import * as MissionRouter from "./MissionRouter.ts";
import { fakeRouterThreads, routerOverFakes } from "./MissionRouter.testkit.ts";
import * as ReportChats from "./reportChats.ts";
import { qualityRoomId, reportsRoutes } from "./reportsHttp.ts";
import { RouterStore } from "./RouterStore.ts";

const SCOPES = ["orchestration:read" as const, "orchestration:operate" as const];

const SESSIONS: Record<string, object> = {
  "Bearer control-token": { sessionId: "session-control", subject: "control" },
  "Bearer owner-token": {
    sessionId: "session-owner",
    subject: "owner",
    origin: { _tag: "owner", source: "desktop" },
  },
  "Bearer cli-token": {
    sessionId: "session-cli",
    subject: "cli",
    origin: { _tag: "component", component: "mission-cli" },
  },
  "Bearer crw-token": {
    sessionId: "session-crw",
    subject: "crw",
    origin: { _tag: "component", component: "crw" },
  },
  "Bearer bridge-token": {
    sessionId: "session-bridge",
    subject: "bridge",
    origin: { _tag: "component", component: "spectrum-bridge" },
  },
  "Bearer read-token": {
    sessionId: "session-read",
    subject: "cli",
    origin: { _tag: "component", component: "mission-cli" },
    scopes: ["orchestration:read" as const],
  },
};

const fakeAuth = {
  authenticateHttpRequest: (request: HttpServerRequest.HttpServerRequest) => {
    const session = SESSIONS[request.headers.authorization ?? ""];
    return session === undefined
      ? Effect.fail(new EnvironmentAuth.ServerAuthInvalidCredentialError({ diagnostic: "none" }))
      : Effect.succeed({
          scopes: SCOPES,
          ...session,
          sessionId: AuthSessionId.make((session as { sessionId: string }).sessionId),
          method: "bearer-access-token" as const,
        });
  },
} as unknown as EnvironmentAuth.EnvironmentAuth["Service"];

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const MONI_THREAD = "6f1c2a9e-0000-4000-8000-00000000a001";
const OWNER_THREAD = "6f1c2a9e-0000-4000-8000-00000000a002";
const GROUP_THREAD = "6f1c2a9e-0000-4000-8000-00000000a003";
/** The bridge keeps dots and up to 80 characters of a group's name, plus a collision suffix. */
const GROUP = `group-sat.night-dinner-${"x".repeat(70)}-2`;

/** A bridge home like `~/.config/spectrum-bridge`: his chat at the top, the rest under chats/. */
const bridgeHome = () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "missions-reports-"));
  const store = (file: string, route: string) => {
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    const db = new NodeSqlite.DatabaseSync(file);
    db.exec("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT)");
    db.prepare("INSERT INTO kv (key, value) VALUES ('route', ?)").run(route);
    db.close();
  };
  const routed = (thread: string) =>
    JSON.stringify({ id: `ardud-control:thread:${thread}`, directory: "/x", generation: 4 });
  store(NodePath.join(home, "state.sqlite"), routed(OWNER_THREAD));
  store(NodePath.join(home, "chats", "moni", "state.sqlite"), routed(MONI_THREAD));
  store(NodePath.join(home, "chats", GROUP, "state.sqlite"), routed(GROUP_THREAD));
  // Stores that name no thread: a cleared route and a file that isn't a database.
  store(NodePath.join(home, "chats", "cleared", "state.sqlite"), "null");
  NodeFS.mkdirSync(NodePath.join(home, "chats", "junk"));
  NodeFS.writeFileSync(NodePath.join(home, "chats", "junk", "state.sqlite"), "not a database");
  return {
    bridgeDatabase: NodePath.join(home, "state.sqlite"),
    chatsDirectory: NodePath.join(home, "chats"),
  };
};

type Handler = (request: Request) => Promise<Response>;

const harness = () => {
  const threads = fakeRouterThreads();
  const layer = routerOverFakes(threads).pipe(
    Layer.provideMerge(MissionStore.layer),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(
      Layer.succeed(ReportChats.ReportChats, ReportChats.reportChatsFrom(bridgeHome())),
    ),
  );
  return { threads, layer };
};

const withDesk = <A>(use: (handler: Handler) => Promise<A>) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<
      | MissionRouter.MissionRouter
      | MissionStore.MissionStore
      | ReportChats.ReportChats
      | RouterStore
    >();
    const routes = reportsRoutes.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeedContext(context),
          Layer.succeed(EnvironmentAuth.EnvironmentAuth, fakeAuth),
        ),
      ),
      Layer.provideMerge(
        HttpPlatform.layer.pipe(
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(Etag.layerWeak),
        ),
      ),
      Layer.provide(NodeServices.layer),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
      ({ handler }) => Effect.tryPromise(() => use((input) => handler(input))),
      ({ dispose }) => Effect.promise(dispose),
    );
  });

const post = async (handle: Handler, body: unknown, token = "cli-token") => {
  const response = await handle(
    new Request("http://127.0.0.1/api/ardud/missions/desk/reports", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: encodeJson(body),
    }),
  );
  return { status: response.status, reply: (await response.json()) as Record<string, any> };
};

const roomMessages = (roomId: ReturnType<typeof qualityRoomId>) =>
  Effect.gen(function* () {
    const router = yield* MissionRouter.MissionRouter;
    return (yield* router.roomPage({ roomId }, ownerApp)).messages;
  });

const bodyOf = (messageId: string) =>
  Effect.gen(function* () {
    const router = yield* MissionRouter.MissionRouter;
    return (yield* router.messageBody({ messageId: MissionMessageId.make(messageId) }, ownerApp))
      .body;
  });

const openQualityRoom = (mission: MissionId) =>
  Effect.gen(function* () {
    const router = yield* MissionRouter.MissionRouter;
    yield* router.createRoom(
      { missionId: mission, slug: "quality", title: "Assistant quality" },
      ownerApp,
    );
  });

const archiveQualityRoom = (mission: MissionId) =>
  Effect.gen(function* () {
    const router = yield* MissionRouter.MissionRouter;
    yield* router.updateRoom({ roomId: qualityRoomId(mission), archived: true }, ownerApp);
  });

const masterWakes = (threads: ReturnType<typeof fakeRouterThreads>) =>
  threads.sent.filter(
    (each) => each.threadId === masterThread && each.key.startsWith("mission-wake:"),
  );

const broke =
  "noon order CLI failed\ncommerce order noon --items-file x.json -> 502 at checkout, flow f-12";

describe("reports from an iMessage chat", () => {
  it.live("lands once as a request to the master in the quality room, from the chat", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      yield* openQualityRoom(missionId);
      const sent = yield* withDesk(async (handle) => [
        await post(handle, {
          missionId,
          chat: `ardud-control:thread:${MONI_THREAD}@4`,
          text: broke,
          file: "/tmp/noon-502.log",
        }),
        // The same report again: the same message, posted once.
        await post(handle, {
          missionId,
          chat: `ardud-control:thread:${MONI_THREAD}@5`,
          text: broke,
          file: "/tmp/noon-502.log",
        }),
      ]);
      expect(sent.map((each) => each.status)).toEqual([200, 200]);
      expect(sent[0]!.reply.report.chat).toBe("moni");
      expect(sent[1]!.reply.report.messageId).toBe(sent[0]!.reply.report.messageId);

      const messages = yield* roomMessages(qualityRoomId(missionId));
      expect(messages).toHaveLength(1);
      const [message] = messages;
      expect(message).toMatchObject({
        kind: "request",
        author: { _tag: "system", component: "imessage:moni" },
        provenance: { _tag: "system", component: "imessage:moni" },
        to: [{ _tag: "role", roleId: "role-master" }],
        summary: "noon order CLI failed",
        links: [{ kind: "file", label: "noon-502.log", url: null, ref: "/tmp/noon-502.log" }],
      });
      const body = yield* bodyOf(message!.id);
      expect(body).toContain("502 at checkout, flow f-12");
      expect(body).toContain("From iMessage chat moni");

      expect(masterWakes(h.threads)).toHaveLength(1);
    }).pipe(Effect.provide(h.layer));
  });

  it.live("falls back to the control room, and a key keeps a retry the same report", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const sent = yield* withDesk(async (handle) => [
        await post(handle, { missionId, chat: "owner", text: "first take", key: "k-1" }),
        await post(handle, { missionId, chat: OWNER_THREAD, text: "first take", key: "k-1" }),
        // Same key, other words: a different report can't hide behind it.
        await post(handle, { missionId, chat: "owner", text: "second take", key: "k-1" }),
      ]);
      expect(sent.map((each) => each.status)).toEqual([200, 200, 409]);
      const messages = yield* roomMessages(MissionRouter.controlRoomId(missionId));
      expect(messages.filter((each) => each.author._tag === "system")).toMatchObject([
        { kind: "request", author: { component: "imessage:owner" }, key: "report:owner:k-1" },
      ]);
    }).pipe(Effect.provide(h.layer));
  });

  it.live("follows the quality room as it opens and closes; a retry stays where it landed", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const control = MissionRouter.controlRoomId(missionId);
      const quality = qualityRoomId(missionId);
      const send = (text: string) => (handle: Handler) =>
        post(handle, { missionId, chat: "moni", text });
      const before = yield* withDesk(send("before the room"));
      yield* openQualityRoom(missionId);
      const opened = yield* withDesk(async (handle) => [
        await send("before the room")(handle),
        await send("while it is open")(handle),
      ]);
      yield* archiveQualityRoom(missionId);
      const closed = yield* withDesk(async (handle) => [
        await send("while it is open")(handle),
        await send("after it closed")(handle),
      ]);

      const sent = [before, ...opened, ...closed];
      expect(sent.map((each) => each.status)).toEqual([200, 200, 200, 200, 200]);
      expect(sent.map((each) => each.reply.report.roomId)).toEqual([
        control,
        control,
        quality,
        quality,
        control,
      ]);
      expect(opened[0]!.reply.report.messageId).toBe(before.reply.report.messageId);
      expect(closed[0]!.reply.report.messageId).toBe(opened[1]!.reply.report.messageId);
      expect(masterWakes(h.threads)).toHaveLength(3);
    }).pipe(Effect.provide(h.layer));
  });

  it.live("takes the bridge's credential, long dotted group slugs, and keys the file in", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const text = "the group's dinner booking skipped the deposit step";
      const sent = yield* withDesk(async (handle) => [
        await post(handle, { missionId, chat: GROUP, text }, "bridge-token"),
        await post(handle, { missionId, chat: `ardud-control:thread:${GROUP_THREAD}@2`, text }),
        // The same words with another file is another report, not a clash.
        await post(handle, {
          missionId,
          chat: GROUP,
          text,
          file: "/tmp/booking.png",
        }),
      ]);
      expect(sent.map((each) => each.status)).toEqual([200, 200, 200]);
      expect(sent.map((each) => each.reply.report.chat)).toEqual([GROUP, GROUP, GROUP]);
      expect(sent[1]!.reply.report.messageId).toBe(sent[0]!.reply.report.messageId);
      expect(sent[2]!.reply.report.messageId).not.toBe(sent[0]!.reply.report.messageId);
      const messages = yield* roomMessages(MissionRouter.controlRoomId(missionId));
      expect(
        messages
          .filter((each) => each.author._tag === "system")
          .map((each) => each.author._tag === "system" && each.author.component),
      ).toEqual([`imessage:${GROUP}`, `imessage:${GROUP}`]);
    }).pipe(Effect.provide(h.layer));
  });

  it.live("refuses other callers, unknown chats and empty text before posting", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      yield* openQualityRoom(missionId);
      const report = { missionId, chat: "moni", text: broke };
      const refused = yield* withDesk(async (handle) => [
        await post(handle, report, "crw-token"),
        await post(handle, report, "owner-token"),
        await post(handle, report, "control-token"),
        await post(handle, report, "read-token"),
        await post(handle, report, "nope"),
        await post(handle, { ...report, chat: "group-nobody" }),
        await post(handle, { ...report, chat: "ardud-control:thread:no-such-thread@1" }),
        await post(handle, { ...report, text: "   " }),
        await post(handle, { ...report, file: "relative/log.txt" }),
        await post(handle, { ...report, missionId: "m-404" }),
      ]);
      expect(refused.map((each) => each.status)).toEqual([
        403, 403, 403, 403, 401, 400, 400, 400, 400, 404,
      ]);
      expect(yield* roomMessages(qualityRoomId(missionId))).toHaveLength(0);
      expect(h.threads.sent.filter((each) => each.key.startsWith("mission-wake:"))).toHaveLength(0);
    }).pipe(Effect.provide(h.layer));
  });
});
