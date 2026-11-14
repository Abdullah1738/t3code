import { assert, it } from "@effect/vitest";
import type { AnalyticsEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerResponse } from "effect/http";
import * as Analytics from "./ardud/analytics/Analytics.ts";
import { httpAnalyticsMiddleware } from "./http.ts";

const layerHttpAnalytics = Layer.unwrap(
  Effect.map(httpAnalyticsMiddleware, (middleware) =>
    HttpRouter.middleware((app) => middleware(app), { global: true }),
  ),
);

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
