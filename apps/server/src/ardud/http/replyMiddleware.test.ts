import { expect, it } from "@effect/vitest";
import { HttpServerResponse } from "effect/http";
import { guardResponse, middleware } from "./replyMiddleware.ts";
import { MAX_BUFFERED_COMPRESSION_BYTES, MAX_REPLY_BYTES } from "./replyBudget.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { HttpClient, HttpRouter, HttpServerRequest } from "effect/http";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as ServerHttp from "../../http.ts";
import * as LargeReplyLog from "../../observability/LargeReplyLog.ts";
import { checkJsonReply, jsonReply } from "./jsonReply.ts";
import * as ReplyBuilders from "./ReplyBuilders.ts";
import { KanbanService } from "../kanban/engine/KanbanService.ts";
import { BoardsDatabase } from "../persistence/BoardsDatabase.ts";
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as SessionOrigins from "../auth/SessionOrigins.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";

it.effect.each([
  ["HEAD", "/api/orchestration/shell"],
  ["GET", "/api/orchestration/shell/"],
  ["GET", "/API//ORCHESTRATION///SHELL/?paged=true"],
  ["GET", "/api/orchestration/threads/test/transcript"],
  ["HEAD", "/API//ARDUD/KANBAN//BOARDS/test/"],
  ["GET", "/api/orchestration/%73hell?paged=true"],
  ["GET", "/api/orchestration/shell;anything"],
  ["HEAD", "/api/ardud/%6banban/boards/test;anything"],
] as const)("bounds router-equivalent request %s before building", ([method, url]) =>
  Effect.gen(function* () {
    const builders = yield* ReplyBuilders.ReplyBuilders;
    let owned = false;
    yield* middleware(
      Effect.gen(function* () {
        const both = yield* builders.snapshot.takeIfAvailable(2);
        if (both) yield* builders.snapshot.release(2);
        owned = !both;
        return jsonReply({ ready: true });
      }),
    ).pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(new Request(`http://localhost${url}`, { method })),
      ),
    );
    expect(owned).toBe(true);
    expect(yield* builders.snapshot.takeIfAvailable(2)).toBe(true);
    yield* builders.snapshot.release(2);
  }).pipe(Effect.provide(ReplyBuilders.layer)),
);

it.effect.each([
  ["GET", "/api/ardud/control/threads?active=true"],
  ["GET", "/api/ardud/control/threads/thread-1/messages?all=true"],
  ["GET", "/api/ardud/control/identity/resolve?nativeId=x"],
  ["GET", "/api/ardud/control/health"],
] as const)("holds no reply lane around the control handler %s %s", ([method, url]) =>
  Effect.gen(function* () {
    const builders = yield* ReplyBuilders.ReplyBuilders;
    const free: Array<boolean> = [];
    yield* middleware(
      Effect.gen(function* () {
        for (const lane of ["agent", "snapshot", "poll"] as const) {
          const all = yield* builders[lane].takeIfAvailable(ReplyBuilders.PERMITS[lane]);
          if (all) yield* builders[lane].release(ReplyBuilders.PERMITS[lane]);
          free.push(all);
        }
        return jsonReply({ ready: true });
      }),
    ).pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(new Request(`http://localhost${url}`, { method })),
      ),
      Effect.provide(
        Layer.merge(
          Layer.mock(KanbanService)({ ready: Effect.void, attachmentPath: () => null }),
          Layer.mock(BoardsDatabase)({ ready: Effect.void, path: ":memory:" }),
        ),
      ),
    );
    expect(free).toEqual([true, true, true]);
  }).pipe(Effect.provide(ReplyBuilders.layer)),
);

it.effect("does not hold a reply builder for a websocket upgrade", () =>
  Effect.gen(function* () {
    const builders = yield* ReplyBuilders.ReplyBuilders;
    yield* middleware(
      Effect.gen(function* () {
        const available = yield* builders.agent.takeIfAvailable(2);
        if (available) yield* builders.agent.release(2);
        expect(available).toBe(true);
        return HttpServerResponse.empty({ status: 200 });
      }),
    ).pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(
          new Request("http://localhost/ws", { headers: { upgrade: "websocket" } }),
        ),
      ),
    );
  }).pipe(Effect.provide(ReplyBuilders.layer)),
);

it.effect("orchestration authentication waits outside reply builders during boards migration", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let waiting = 0;
    const ready = Effect.suspend(() => {
      waiting++;
      return (waiting === 2 ? Deferred.succeed(entered, undefined) : Effect.void).pipe(
        Effect.andThen(Deferred.await(release)),
      );
    });
    const services = yield* Layer.build(
      EnvironmentAuth.layer.pipe(
        Layer.provideMerge(Sqlite.layerMemory),
        Layer.provideMerge(ServerSecretStore.layer),
        Layer.provideMerge(ServerEnvironment.layerIdentity),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-builder-auth-" })),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    const origins = Context.get(services, SessionOrigins.SessionOrigins);
    const gatedAuth = yield* EnvironmentAuth.make.pipe(
      Effect.provide(
        services.pipe(
          Context.add(SessionOrigins.SessionOrigins, {
            ...origins,
            originOf: (sessionId) => ready.pipe(Effect.andThen(origins.originOf(sessionId))),
          }),
        ),
      ),
    );
    const sessions = yield* Effect.forEach([1, 2], (number) =>
      gatedAuth.issueSession({ subject: `uncached-${number}`, scopes: ["orchestration:read"] }),
    );
    const routes = HttpRouter.addAll([
      HttpRouter.route(
        "GET",
        "/api/orchestration/shell",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          yield* gatedAuth.authenticateHttpRequest(request).pipe(Effect.orDie);
          return jsonReply({ threads: [] });
        }),
      ),
    ]);
    const http = yield* Layer.build(
      HttpRouter.serve(Layer.merge(routes, ServerHttp.layerHttpCompression), {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(
        Layer.provideMerge(NodeHttpServer.layerTest),
        Layer.provide(NodeHttpPlatform.layer),
        Layer.provideMerge(ReplyBuilders.layer),
        Layer.provide(Layer.mock(BoardsDatabase)({ ready, path: ":memory:" })),
      ),
    );
    const client = Context.get(http, HttpClient.HttpClient);
    const requests = yield* Effect.forEach(sessions, (session) =>
      client
        .get("/api/orchestration/shell", { headers: { authorization: `Bearer ${session.token}` } })
        .pipe(Effect.forkScoped),
    );
    yield* Deferred.await(entered);
    const builders = Context.get(http, ReplyBuilders.ReplyBuilders);
    const available = yield* builders.agent.takeIfAvailable(2);
    if (available) yield* builders.agent.release(2);
    yield* Deferred.succeed(release, undefined);
    for (const request of requests) expect((yield* Fiber.join(request)).status).toBe(200);
    expect(available).toBe(true);
  }).pipe(Effect.scoped),
);

it.effect("cancels readiness admission even when the HTTP middleware caller is masked", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const cancelled = yield* Deferred.make<void>();
    const ready = Deferred.succeed(entered, undefined).pipe(
      Effect.andThen(Deferred.await(release)),
      Effect.onInterrupt(() => Deferred.succeed(cancelled, undefined)),
    );
    const request = yield* middleware(Effect.succeed(jsonReply({ ready: true }))).pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(new Request("http://localhost/api/ardud/kanban/boards/test")),
      ),
      Effect.provide(Layer.mock(KanbanService)({ ready, attachmentPath: () => null })),
      Effect.uninterruptible,
      Effect.forkScoped,
    );
    yield* Deferred.await(entered);
    const interrupt = yield* Fiber.interrupt(request).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    const interrupted = yield* Deferred.isDone(cancelled);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(interrupt);
    expect(interrupted).toBe(true);
  }).pipe(Effect.scoped),
);

it.effect.each(["/api/ardud/kanban/boards/test", "/api/ardud/control/threads"] as const)(
  "keeps reply builders available while %s waits for readiness",
  (path) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let waiting = 0;
      const ready = Effect.suspend(() => {
        waiting++;
        return (waiting === 2 ? Deferred.succeed(entered, undefined) : Effect.void).pipe(
          Effect.andThen(Deferred.await(release)),
        );
      });
      const routes = HttpRouter.addAll([
        HttpRouter.route("GET", path, Effect.succeed(jsonReply({ ready: true }))),
        HttpRouter.route(
          "GET",
          "/api/orchestration/shell",
          Effect.succeed(jsonReply({ threads: [] })),
        ),
      ]);
      const services = yield* Layer.build(
        HttpRouter.serve(Layer.merge(routes, ServerHttp.layerHttpCompression), {
          disableListenLog: true,
          disableLogger: true,
        }).pipe(
          Layer.provideMerge(NodeHttpServer.layerTest),
          Layer.provide(NodeHttpPlatform.layer),
          Layer.provideMerge(ReplyBuilders.layer),
          Layer.provide(
            Layer.merge(
              Layer.mock(KanbanService)({ ready, attachmentPath: () => null }),
              Layer.mock(BoardsDatabase)({ ready, path: ":memory:" }),
            ),
          ),
        ),
      );
      const client = Context.get(services, HttpClient.HttpClient);
      const requests = yield* Effect.forEach([1, 2], () =>
        client.get(path).pipe(Effect.forkScoped),
      );
      yield* Deferred.await(entered);
      const builders = Context.get(services, ReplyBuilders.ReplyBuilders);
      expect(yield* builders.agent.takeIfAvailable(2)).toBe(true);
      yield* builders.agent.release(2);
      expect(
        yield* ReplyBuilders.bounded(Effect.succeed(200)).pipe(
          Effect.provideService(ReplyBuilders.ReplyBuilders, builders),
        ),
      ).toBe(200);
      yield* Deferred.succeed(release, undefined);
      for (const request of requests) expect((yield* Fiber.join(request)).status).toBe(200);
    }).pipe(Effect.scoped),
);

it("rejects an oversized JSON response and logs the named route without the payload", () => {
  const entries: unknown[] = [];
  const response = guardResponse(
    HttpServerResponse.text("x".repeat(MAX_REPLY_BYTES + 1), { contentType: "application/json" }),
    "POST /mcp",
    { record: (entry) => entries.push(entry) },
  );
  expect(response.status).toBe(413);
  expect(entries).toEqual([
    { kind: "http", name: "POST /mcp", bytes: MAX_REPLY_BYTES + 1, rejected: true },
  ]);
});

it("skips whole-buffer compression above 2 MiB but preserves small responses and asset downloads", () => {
  const big = HttpServerResponse.text("x".repeat(MAX_BUFFERED_COMPRESSION_BYTES + 1));
  expect(guardResponse(big, "GET /test").headers["content-encoding"]).toBe("identity");
  const small = HttpServerResponse.text("small");
  expect(guardResponse(small, "GET /test")).toBe(small);
  expect(
    guardResponse(HttpServerResponse.uint8Array(new Uint8Array(MAX_REPLY_BYTES + 1)), "GET /asset")
      .status,
  ).toBe(200);
});

it.effect("runs the named cap before Brotli without encoding a large text body", () =>
  Effect.gen(function* () {
    const entries: LargeReplyLog.LargeReply[] = [];
    const routes = HttpRouter.addAll([
      HttpRouter.route(
        "GET",
        "/big/:id",
        Effect.sync(() =>
          HttpServerResponse.text("x".repeat(MAX_REPLY_BYTES + 1), {
            contentType: "application/json",
          }),
        ),
      ),
      HttpRouter.route(
        "GET",
        "/medium",
        Effect.sync(() =>
          HttpServerResponse.text("x".repeat(MAX_BUFFERED_COMPRESSION_BYTES + 1), {
            contentType: "application/json",
          }),
        ),
      ),
      HttpRouter.route(
        "GET",
        "/before-stringify",
        checkJsonReply(Effect.succeed({ detail: "x".repeat(MAX_REPLY_BYTES + 1) })).pipe(
          Effect.map(jsonReply),
        ),
      ),
    ]);
    const services = yield* Layer.build(
      HttpRouter.serve(Layer.merge(routes, ServerHttp.layerHttpCompression), {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(
        Layer.provideMerge(NodeHttpServer.layerTest),
        Layer.provide(NodeHttpPlatform.layer),
        Layer.provide(
          Layer.succeed(LargeReplyLog.LargeReplyLog, { record: (entry) => entries.push(entry) }),
        ),
      ),
    );
    const client = Context.get(services, HttpClient.HttpClient);
    const big = yield* client.get("/big/private-id", { headers: { "accept-encoding": "br" } });
    expect(big.status).toBe(413);
    expect(yield* big.text).toContain("16 MiB limit");
    expect(entries).toContainEqual({
      kind: "http",
      name: "GET /big/:id",
      bytes: MAX_REPLY_BYTES + 1,
      rejected: true,
    });
    const medium = yield* client.get("/medium", { headers: { "accept-encoding": "br" } });
    expect(medium.status).toBe(200);
    expect(medium.headers["content-encoding"]).toBeUndefined();
    expect((yield* medium.text).length).toBe(MAX_BUFFERED_COMPRESSION_BYTES + 1);
    const before = yield* client.get("/before-stringify");
    expect(before.status).toBe(413);
    expect(yield* before.text).toContain("16 MiB limit");
  }).pipe(Effect.scoped),
);
