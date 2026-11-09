import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as FindMyWay from "effect/http/FindMyWay";
import {
  HttpBody,
  HttpEffect,
  HttpMiddleware,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import * as LargeReplyLog from "../../observability/LargeReplyLog.ts";
import * as ReplyBuilders from "./ReplyBuilders.ts";
import * as ReplyReadiness from "./replyReadiness.ts";
import {
  MAX_BUFFERED_COMPRESSION_BYTES,
  MAX_REPLY_BYTES,
  REPLY_TOO_LARGE,
  ReplyTooLarge,
} from "./replyBudget.ts";

// Use the HTTP router's matcher so encoded paths, delimiters and aliases cannot bypass admission.
// A wider parameter limit is conservative: rejected routes may take a permit, never the reverse.
const replyRoutes = FindMyWay.make<"board" | "control">({ maxParamLength: Number.MAX_SAFE_INTEGER });
for (const path of [
  "/api/orchestration/shell",
  "/api/orchestration/threads/:threadId",
  "/api/orchestration/threads/:threadId/bounded",
  "/api/orchestration/threads/:threadId/history",
  "/api/orchestration/threads/:threadId/transcript",
  "/api/ardud/control/threads",
  "/api/ardud/control/threads/:threadId/messages",
] as const) replyRoutes.on("GET", path, "control");
for (const path of ["/api/ardud/kanban/boards/:boardId", "/api/ardud/kanban/cards/:cardId"] as const)
  replyRoutes.on("GET", path, "board");

export const guardResponse = (
  response: HttpServerResponse.HttpServerResponse,
  name: string,
  log?: LargeReplyLog.LargeReplyRecorder,
) => {
  const body = response.body;
  const contentType =
    response.headers["content-type"] ??
    ("contentType" in body ? body.contentType : undefined) ??
    "";
  const structured =
    /json/i.test(contentType) ||
    (body._tag === "Uint8Array" && /^text\/(?!event-stream)/i.test(contentType));
  const length = "contentLength" in body ? body.contentLength : undefined;
  if (response.headers["x-robob-reply-rejected"] === "true")
    log?.record({ kind: "http", name, bytes: MAX_REPLY_BYTES + 1, rejected: true });
  if (length !== undefined && length >= LargeReplyLog.LARGE_REPLY_BYTES) {
    try {
      log?.record({
        kind: "http",
        name,
        bytes: length,
        ...(structured && length > MAX_REPLY_BYTES ? { rejected: true } : {}),
      });
    } catch {
      /* Diagnostics cannot bypass the cap. */
    }
  }
  if (structured && length !== undefined && length > MAX_REPLY_BYTES)
    return HttpServerResponse.jsonUnsafe(
      { error: "reply_too_large", message: REPLY_TOO_LARGE },
      { status: 413, headers: { "cache-control": "no-store" } },
    );
  if (body._tag === "Stream" && structured) {
    let bytes = 0;
    response = HttpServerResponse.setBody(
      response,
      HttpBody.stream(
        body.stream.pipe(
          Stream.mapEffect((chunk) => {
            bytes += chunk.byteLength;
            if (bytes <= MAX_REPLY_BYTES) return Effect.succeed(chunk);
            log?.record({ kind: "http", name, bytes, rejected: true });
            return Effect.die(new Error(REPLY_TOO_LARGE));
          }),
        ),
        body.contentType,
        body.contentLength,
      ),
    );
  }
  // Effect uses zlibBuffer on materialized bodies. Never make a second multi-MiB copy.
  return response.headers["content-encoding"] === undefined &&
    (length === undefined || length > MAX_BUFFERED_COMPRESSION_BYTES)
    ? HttpServerResponse.setHeader(response, "content-encoding", "identity")
    : response;
};

export const middleware = HttpMiddleware.make((app) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const log = yield* Effect.serviceOption(LargeReplyLog.LargeReplyLog);
    yield* HttpEffect.appendPreResponseHandler((_request, response) =>
      Effect.serviceOption(HttpRouter.RouteContext).pipe(
        Effect.map((route) =>
          guardResponse(
            response,
            `${request.method} ${Option.isSome(route) ? route.value.route.path : "unmatched"}`,
            Option.getOrUndefined(log),
          ),
        ),
      ),
    );
    const admission = replyRoutes.find(request.method === "HEAD" ? "GET" : request.method, request.url)?.handler;
    const buildsLargeReply = admission !== undefined;
    if (buildsLargeReply) {
      // Authentication also reads session origins from the split control database.
      yield* ReplyReadiness.controlReady.pipe(Effect.interruptible);
      if (admission === "board") {
        yield* ReplyReadiness.boardReady.pipe(Effect.interruptible);
      }
    }
    // This global middleware runs before route authentication: no verified session is
    // in context yet. Keep HTTP (including control-token reads) on the agent lane.
    return yield* (buildsLargeReply ? ReplyBuilders.bounded(app).pipe(Effect.interruptible) : app).pipe(
      Effect.catchCauseIf(
        (cause) =>
          cause.reasons.some(
            (reason) => Cause.isDieReason(reason) && reason.defect instanceof ReplyTooLarge,
          ),
        () =>
          Effect.succeed(
            HttpServerResponse.jsonUnsafe(
              { error: "reply_too_large", message: REPLY_TOO_LARGE },
              {
                status: 413,
                headers: { "cache-control": "no-store", "x-robob-reply-rejected": "true" },
              },
            ),
          ),
      ),
    );
  }),
);
