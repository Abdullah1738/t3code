import { assert, it } from "@effect/vitest";
import type { AnalyticsEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerResponse } from "effect/http";
import * as Analytics from "./ardud/analytics/Analytics.ts";
import { httpAnalyticsMiddleware } from "./http.ts";
import * as ControlHttpTelemetry from "./observability/ControlHttpTelemetry.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { AnalyticsEvent as AnalyticsEventSchema } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

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
    Schema.decodeUnknownSync(AnalyticsEventSchema, { onExcessProperty: "error" })(events[0]);
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
