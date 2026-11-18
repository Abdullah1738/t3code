// @effect-diagnostics nodeBuiltinImport:off -- response events exercise the native lifecycle without opening a server.
import * as NodeEvents from "node:events";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as ControlRequestAnalytics from "./ardud/control/ControlRequestAnalytics.ts";
import * as HttpRequestLifecycle from "./ardud/http/HttpRequestLifecycle.ts";
import { assert, it } from "@effect/vitest";
import type { AnalyticsEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpEffect, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Analytics from "./ardud/analytics/Analytics.ts";
import { httpAnalyticsMiddleware } from "./http.ts";
import * as ControlHttpTelemetry from "./observability/ControlHttpTelemetry.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { AnalyticsEvent as AnalyticsEventSchema } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decodeAnalyticsEvent = Schema.decodeUnknownSync(AnalyticsEventSchema, {
  onExcessProperty: "error",
});

const layerHttpAnalytics = Layer.unwrap(
  Effect.map(httpAnalyticsMiddleware, (middleware) =>
    HttpRouter.middleware((app) => middleware(app), { global: true }),
  ),
);

it("attributes control HTTP rows with safe query modes, clients and separate reader timings", async () => {
  const events: AnalyticsEvent[] = [];
  const app = Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/api/ardud/control/threads",
      Effect.gen(function* () {
        const client = yield* ControlHttpTelemetry.AuthenticatedClientObserver;
        client?.({ clientLabel: "Telegram bridge" });
        const wait = yield* NodeSqliteClient.ReaderWaitObserver;
        wait?.(27, "background");
        const statements = yield* NodeSqliteClient.StatementTimingObserver;
        statements?.({
          connection: "reader",
          lane: "background",
          operation: "read",
          durationMs: 13,
          outcome: "success",
        });
        return HttpServerResponse.text("ok");
      }),
    ),
    layerHttpAnalytics,
  ).pipe(
    Layer.provide(
      Layer.mock(Analytics.Analytics)({
        record: (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
      }),
    ),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(app, { disableLogger: true });
  try {
    await handler(
      new Request(
        "http://test/api/ardud/control/threads?active=true&limit=500&includeSubagents=true&ids=private&token=secret",
        { headers: { "User-Agent": "Python-urllib/3.14" } },
      ),
    );
    assert.lengthOf(events, 1);
    assert.equal(events[0]?.kind, "server.http");
    assert.deepInclude(events[0]!.props!, {
      queryShape: "active:true/ids/includeSubagents:true/limit:500/other",
      controlClient: "telegram-bridge",
      userAgent: "python-urllib/3.14",
      readerLane: "background",
      readerAcquireMs: 27,
      readerQueryMs: 13,
      readerStatements: 1,
    });
    decodeAnalyticsEvent(events[0]);
    assert.notInclude(JSON.stringify(events), "secret");
    assert.notInclude(JSON.stringify(events), "private");
  } finally {
    await dispose();
  }
});

it.effect("redacts arbitrary control metadata and bounds query shapes", () =>
  Effect.gen(function* () {
    const telemetry = yield* ControlHttpTelemetry.make(
      "/api/ardud/control/threads?active=private&limit=secret&secret=value",
      "Bearer private-secret",
    );
    yield* telemetry.observe(
      Effect.gen(function* () {
        (yield* ControlHttpTelemetry.AuthenticatedClientObserver)?.({
          clientLabel: "private-secret",
        });
      }),
    );
    const props = telemetry.props();
    assert.equal(props.queryShape, "active:other/limit:other/other");
    assert.equal(props.userAgent, "other");
    assert.match(props.controlClient!, /^sha256:[0-9a-f]{64}$/);
    assert.notInclude(JSON.stringify(props), "private");
    assert.notProperty(props, "readerLane");
  }),
);

it.each([
  ["active=true&limit=500", "active:true/limit:500"],
  ["active=1&archived=0&limit=001", "active:1/archived:0/limit:1"],
  ["active=true&active=false&limit=500&limit=1", "active:other/limit:other"],
  ["limit=-1&includeSubagents=secret", "includeSubagents:other/limit:other"],
  ["limit=501&private-key=value", "limit:other/other"],
  ["ids=id&cursor=secret&updatedSince=secret", "cursor/ids/updatedSince"],
  [
    "after=secret&afterMessageId=secret&boardId=secret&drain=true&role=secret&runId=secret&threadId=secret&timeoutMs=secret&types=secret&until=secret",
    "after/afterMessageId/boardId/drain:true/role/runId/threadId/timeoutMs/types/until",
  ],
  ["limit=1e2&origin=secret&state=secret", "limit:other/origin/state"],
])("bounds query shape %s", (input, expected) => {
  assert.equal(ControlHttpTelemetry.queryShape(`/api/ardud/control/threads?${input}`), expected);
});

it("records normalized HTTP routes, UTF-8/stream bytes and safe failures", async () => {
  const events: AnalyticsEvent[] = [];
  const encoder = new TextEncoder();
  const app = Layer.mergeAll(
    HttpRouter.add("GET", "/api/cards/:cardId", HttpServerResponse.text("é")),
    HttpRouter.add(
      "GET",
      "/api/stream/:id",
      HttpServerResponse.stream(Stream.make(encoder.encode("é"), encoder.encode("hello"))),
    ),
    HttpRouter.add(
      "GET",
      "/api/fail",
      Effect.fail({ _tag: "TestFailureError", message: "private failure" }),
    ),
    HttpRouter.add(
      "POST",
      "/api/ardud/analytics/ingest",
      HttpServerResponse.empty({ status: 204 }),
    ),
    layerHttpAnalytics,
  ).pipe(
    Layer.provide(
      Layer.mock(Analytics.Analytics)({
        record: (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
      }),
    ),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(app, { disableLogger: true });
  try {
    const card = await handler(
      new Request("http://test/api/cards/private-card?token=private-query"),
    );
    assert.equal(await card.text(), "é");
    const stream = await handler(new Request("http://test/api/stream/private-stream"));
    assert.equal(await stream.text(), "éhello");
    const failed = await handler(new Request("http://test/api/fail?token=private-query"));
    assert.equal(failed.status, 500);
    const missing = await handler(new Request("http://test/private-path?token=private-query"));
    assert.equal(missing.status, 404);
    const head = await handler(
      new Request("http://test/api/cards/private-card", { method: "HEAD" }),
    );
    assert.equal(await head.text(), "");
    await handler(new Request("http://test/api/ardud/analytics/ingest", { method: "POST" }));
    assert.equal(events.length, 5);
    assert.deepEqual(
      events.map((event) => [event.route, event.props?.bytes, event.props?.status]),
      [
        ["/api/cards/:cardId", 2, 200],
        ["/api/stream/:id", 7, 200],
        ["/api/fail", 0, 500],
        ["unmatched", 0, 404],
        ["/api/cards/:cardId", 0, 200],
      ],
    );
    assert.equal(events[2]?.props?.errorTag, "TestFailureError");
    assert.equal(events[3]?.props?.pathHint, "/:value");
    assert.match(events[3]?.props?.pathHash ?? "", /^sha256:[0-9a-f]{64}$/);
    assert.equal(events[3]?.props?.remoteKind, "unknown");
    assert.isTrue(
      events.every((event) => event.durationMs !== undefined && event.props?.span !== undefined),
    );
    assert.isFalse(JSON.stringify(events).includes("private"));
  } finally {
    await dispose();
  }
});

it("preserves HTTP responses when analytics is absent or defective", async () => {
  for (const withBrokenAnalytics of [false, true]) {
    let app = Layer.merge(
      HttpRouter.add("GET", "/ok", HttpServerResponse.text("ok")),
      layerHttpAnalytics,
    );
    if (withBrokenAnalytics)
      app = app.pipe(
        Layer.provide(
          Layer.mock(Analytics.Analytics)({ record: () => Effect.die("private observer error") }),
        ),
      );
    const { handler, dispose } = HttpRouter.toWebHandler(app, { disableLogger: true });
    try {
      assert.equal(await (await handler(new Request("http://test/ok"))).text(), "ok");
    } finally {
      await dispose();
    }
  }
});

it.each(["buffered", "stream", "head", "closed"])(
  "records one end-to-end control HTTP budget after %s delivery",
  async (form) => {
    const events: AnalyticsEvent[] = [];
    const recorded = Promise.withResolvers<void>();
    let tick = 0;
    const source = new Request(
      "http://test/api/ardud/control/threads/private/messages?token=secret",
      {
        method: form === "head" ? "HEAD" : "GET",
        headers: { "x-request-id": "lifecycle-test", "user-agent": "Bun/1.4.1" },
      },
    );
    const responseEvents = new NodeEvents.EventEmitter();
    HttpRequestLifecycle.observe(source, responseEvents, () => tick);
    const app = Layer.mergeAll(
      HttpRouter.add(
        "GET",
        "/api/ardud/control/threads/:threadId/messages",
        ControlRequestAnalytics.observe(
          "control.messages",
          Effect.gen(function* () {
            (yield* NodeSqliteClient.ReaderWaitObserver)?.(27, "foreground");
            (yield* NodeSqliteClient.StatementTimingObserver)?.({
              connection: "reader",
              lane: "foreground",
              operation: "read",
              durationMs: 13,
              outcome: "success",
            });
            tick = 40;
            return yield* ControlRequestAnalytics.encoding(
              Effect.succeed(
                form === "stream"
                  ? HttpServerResponse.stream(Stream.make(new TextEncoder().encode("ok")))
                  : HttpServerResponse.text("ok"),
              ),
            );
          }),
          { path: "/api/ardud/control/threads/:threadId/messages", method: "GET" },
        ).pipe(Effect.provide(NodeCrypto.layer)),
      ),
      layerHttpAnalytics,
    ).pipe(
      Layer.provide(
        Layer.mock(Analytics.Analytics)({
          record: (event) =>
            Effect.sync(() => {
              events.push(event);
              if (event.kind === "server.http") recorded.resolve();
            }),
        }),
      ),
    );
    const { handler, dispose } = HttpRouter.toWebHandler(app, { disableLogger: true });
    try {
      tick = 10;
      await (await handler(source)).text();
      assert.lengthOf(
        events.filter((event) => event.kind === "server.http"),
        0,
      );
      tick = 55;
      responseEvents.emit(form === "closed" ? "close" : "finish");
      responseEvents.emit(form === "closed" ? "finish" : "close");
      await recorded.promise;
      const rows = events.filter((event) => event.kind === "server.http");
      assert.lengthOf(rows, 1);
      const event = rows[0]!;
      assert.equal(event.route, "/api/ardud/control/threads/:threadId/messages");
      assert.equal(event.durationMs, 55);
      assert.equal(event.responseDelivery, form === "closed" ? "closed" : "finished");
      assert.deepInclude(event.props!, {
        requestId: "lifecycle-test",
        receiveToHandlerMs: 10,
        responseReadyMs: 40,
        writeOutMs: 15,
      });
      assert.isNumber(event.props?.serializationMs);
      assert.deepEqual(event.props?.readerTimings, [
        { lane: "foreground", waitMs: 27, queryMs: 13, statements: 1 },
      ]);
      assert.isNumber(event.props?.handlerMs);
      decodeAnalyticsEvent(event);
      assert.notInclude(JSON.stringify(event), "private");
      assert.notInclude(JSON.stringify(event), "secret");
    } finally {
      await dispose();
    }
  },
);

it.each([
  {
    status: 409,
    failure: {
      code: "conflict",
      errorTag: "ThreadManagementNoSteerableRunError",
      reason: "no_steerable_run",
    },
    expectedTag: "ThreadManagementNoSteerableRunError",
  },
  {
    status: 503,
    failure: {
      code: "unavailable",
      errorTag: "ServerRuntimeStartupError",
      reason: "startup_unavailable",
    },
    expectedTag: "ServerRuntimeStartupError",
  },
  { status: 404, failure: undefined, expectedTag: "Http4xx" },
  { status: 503, failure: undefined, expectedTag: "Http5xx" },
])(
  "preserves $expectedTag for a $status control response",
  async ({ status, failure, expectedTag }) => {
    const events: AnalyticsEvent[] = [];
    const recorded = Promise.withResolvers<void>();
    const route = "/api/ardud/control/threads/:threadId/send";
    const source = new Request("http://test/api/ardud/control/threads/private/send", {
      method: "POST",
      headers: { "x-request-id": "rejection-test" },
    });
    const responseEvents = new NodeEvents.EventEmitter();
    HttpRequestLifecycle.observe(source, responseEvents, () => 0);
    const response = HttpServerResponse.empty({ status });
    const app = Layer.mergeAll(
      Layer.unwrap(
        Effect.map(ControlRequestAnalytics.make, (observeControl) =>
          HttpRouter.add(
            "POST",
            route,
            failure === undefined
              ? response
              : observeControl(
                  "control.send",
                  Effect.gen(function* () {
                    yield* ControlRequestAnalytics.sendMode("steer");
                    yield* ControlRequestAnalytics.failure(failure.code, failure);
                    return response;
                  }),
                  { path: route, method: "POST" },
                ),
          ),
        ),
      ),
      layerHttpAnalytics,
    ).pipe(
      Layer.provide(
        Layer.mock(Analytics.Analytics)({
          record: (event) =>
            Effect.sync(() => {
              events.push(event);
              if (event.kind === "server.http") recorded.resolve();
            }),
        }),
      ),
    );
    const { handler, dispose } = HttpRouter.toWebHandler(app, { disableLogger: true });
    try {
      assert.equal((await handler(source)).status, status);
      responseEvents.emit("finish");
      await recorded.promise;
      const http = events.filter((event) => event.kind === "server.http");
      assert.lengthOf(http, 1);
      assert.equal(http[0]?.props?.errorTag, expectedTag);
      assert.equal(http[0]?.props?.status, status);
      const rpc = events.filter((event) => event.kind === "rpc.request");
      assert.lengthOf(rpc, failure === undefined ? 0 : 1);
      if (failure !== undefined) {
        for (const event of [http[0]!, rpc[0]!]) {
          assert.deepInclude(event.props!, { ...failure, requestId: "rejection-test" });
        }
      }
      for (const event of events) decodeAnalyticsEvent(event);
    } finally {
      await dispose();
    }
  },
);

it("retains normalized unknown paths and a bounded caller hint", () => {
  const a = ControlHttpTelemetry.pathHint("/api/secret-token/messages?token=query-secret");
  const b = ControlHttpTelemetry.pathHint("/api/another-value/messages");
  assert.equal(a.pathHint, "/api/:value/messages");
  assert.equal(a.pathHint, b.pathHint);
  assert.notEqual(a.pathHash, b.pathHash);
  assert.equal(ControlHttpTelemetry.userAgent("Python-urllib/3.15"), "python-urllib/3.15");
  assert.notInclude(JSON.stringify(a), "secret");
});

it("records a control disconnect before the handler builds a response", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const recorded = Promise.withResolvers<AnalyticsEvent>();
  const source = new Request("http://test/api/ardud/control/threads?active=true", {
    headers: { "x-request-id": "early-close-test" },
  });
  let tick = 0;
  const responseEvents = new NodeEvents.EventEmitter();
  HttpRequestLifecycle.observe(source, responseEvents, () => tick);
  const app = Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/api/ardud/control/threads",
      ControlRequestAnalytics.observe(
        "control.threads",
        Effect.promise(async () => {
          entered.resolve();
          await release.promise;
          return HttpServerResponse.text("ok");
        }),
        { path: "/api/ardud/control/threads", method: "GET" },
      ).pipe(Effect.provide(NodeCrypto.layer)),
    ),
    layerHttpAnalytics,
  ).pipe(
    Layer.provide(
      Layer.mock(Analytics.Analytics)({
        record: (event) =>
          Effect.sync(() => {
            if (event.kind === "server.http") recorded.resolve(event);
          }),
      }),
    ),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(app, { disableLogger: true });
  try {
    tick = 10;
    const pending = handler(source);
    await entered.promise;
    tick = 25;
    responseEvents.emit("close");
    const event = await recorded.promise;
    assert.equal(event.route, "/api/ardud/control/threads");
    assert.equal(event.durationMs, 25);
    assert.equal(event.responseDelivery, "closed");
    assert.equal(event.props?.requestId, "early-close-test");
    assert.equal(event.props?.receiveToHandlerMs, 10);
    assert.notProperty(event.props, "handlerMs");
    assert.notProperty(event.props, "writeOutMs");
    decodeAnalyticsEvent(event);
    release.resolve();
    await pending;
  } finally {
    release.resolve();
    await dispose();
  }
});

const requestTargets = [
  { target: "/api/secret/messages?token=secret", hint: "/api/:value/messages" },
  { target: "//[?token=secret", hint: "//:value" },
  { target: "//api/messages?token=secret", hint: "//api/messages" },
  { target: "/\\[?token=secret", hint: "/:value" },
  { target: "/api/%ZZ?token=secret", hint: "/api/:value" },
  { target: "/api/%2F%3F?token=secret", hint: "/api/:value" },
  { target: "https://example.invalid/api/secret?token=secret", hint: "/api/:value" },
  { target: "http://[?token=secret", hint: ":value//:value" },
  { target: "private/messages?token=secret", hint: ":value/messages" },
  { target: "*?token=secret", hint: ":value" },
  { target: "", hint: "/" },
];

it.effect.each(requestTargets)(
  "logs raw request target $target without affecting its response",
  ({ target, hint }) =>
    Effect.gen(function* () {
      const events: AnalyticsEvent[] = [];
      const request = HttpServerRequest.fromWeb(new Request("http://test/")).modify({
        url: target,
      });
      let responses = 0;
      yield* Effect.gen(function* () {
        const middleware = yield* httpAnalyticsMiddleware;
        yield* HttpEffect.toHandled(
          Effect.succeed(HttpServerResponse.empty({ status: 404 })),
          (_request, response) =>
            Effect.sync(() => {
              responses += 1;
              assert.equal(response.status, 404);
            }),
          middleware,
        );
      }).pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
        Effect.provide(
          Layer.mock(Analytics.Analytics)({
            record: (event) =>
              Effect.sync(() => {
                events.push(event);
              }),
          }),
        ),
      );
      assert.equal(responses, 1);
      assert.lengthOf(events, 1);
      const event = events[0]!;
      assert.equal(event.route, "unmatched");
      assert.equal(event.props?.pathHint, hint);
      assert.equal(
        event.props?.pathHash,
        ControlHttpTelemetry.pathHint(target.split("?", 1)[0]!).pathHash,
      );
      assert.notInclude(JSON.stringify(event), "secret");
      decodeAnalyticsEvent(event);
    }),
);
