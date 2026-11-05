import { expect, it } from "@effect/vitest";
import { HttpServerResponse } from "effect/http";
import { guardResponse } from "./replyMiddleware.ts";
import { MAX_BUFFERED_COMPRESSION_BYTES, MAX_REPLY_BYTES } from "./replyBudget.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpRouter } from "effect/http";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as ServerHttp from "../../http.ts";
import * as LargeReplyLog from "../../observability/LargeReplyLog.ts";
import { checkJsonReply, jsonReply } from "./jsonReply.ts";

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
      HttpRouter.route("GET", "/before-stringify", checkJsonReply(Effect.succeed({ detail: "x".repeat(MAX_REPLY_BYTES + 1) })).pipe(Effect.map(jsonReply))),
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
