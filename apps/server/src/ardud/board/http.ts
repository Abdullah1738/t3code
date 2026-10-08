import {
  ArdudBoardClearInput,
  ArdudBoardDelta,
  ArdudBoardImportInput,
  ArdudBoardSnapshot,
  ArdudBoardToken,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  HttpServerRespondable,
} from "effect/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../../auth/http.ts";
import * as BoardImport from "./BoardImport.ts";
import * as BoardService from "./BoardService.ts";

/**
 * Session board routes under /api/ardud/board. Same bearer/cookie auth as the
 * /api/orchestration routes: reads need orchestration:read, actions need
 * orchestration:operate.
 */
const PREFIX = "/api/ardud/board";
const NO_STORE = { "cache-control": "no-store" };

class InvalidBoardRequest extends Schema.TaggedError<InvalidBoardRequest>()(
  "InvalidBoardRequest",
  {},
) {}

const authenticate = (
  scope: typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* auth.authenticateHttpRequest(request).pipe(
      Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
        failEnvironmentAuthInvalid(
          EnvironmentAuth.serverAuthCredentialReason(error),
          EnvironmentAuth.serverAuthDpopFailureReason(error),
        ),
      ),
      Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
        failEnvironmentInternal("internal_error", error),
      ),
    );
    if (!session.scopes.includes(scope)) return yield* failEnvironmentScopeRequired(scope);
  });

const json = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: NO_STORE });

const decodeBody = <A, I>(schema: Schema.Codec<A, I>) =>
  HttpServerRequest.schemaBodyJson(schema).pipe(Effect.mapError(() => new InvalidBoardRequest()));

type RouteError =
  | Effect.Error<ReturnType<typeof authenticate>>
  | InvalidBoardRequest
  | BoardService.BoardConflictError
  | BoardService.BoardUnavailableError
  | BoardImport.BoardImportError;

const respond = <R>(effect: Effect.Effect<HttpServerResponse.HttpServerResponse, RouteError, R>) =>
  effect.pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
      InvalidBoardRequest: () =>
        Effect.succeed(json({ error: "Invalid session board request." }, 400)),
      BoardConflictError: (error) =>
        Effect.succeed(json({ error: error.message, reason: error.reason }, 409)),
      BoardImportError: (error) => Effect.succeed(json({ error: error.message }, 400)),
      BoardUnavailableError: (error) =>
        Effect.logWarning("session board request failed", { cause: error.cause }).pipe(
          Effect.as(json({ error: error.message }, 503)),
        ),
    }),
  );

const route = <R>(
  method: "GET" | "POST",
  path: string,
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, RouteError, R>,
) => HttpRouter.add(method, `${PREFIX}${path}`, respond(handler));

const action = (name: "review" | "backlog" | "restore") =>
  route(
    "POST",
    `/${name}`,
    Effect.gen(function* () {
      yield* authenticate(AuthOrchestrationOperateScope);
      const token = yield* decodeBody(ArdudBoardToken);
      const board = yield* BoardService.BoardService;
      return json(yield* board.act(name, token));
    }),
  );

const encoder = new TextEncoder();
const sse = (event: string, data: string) => encoder.encode(`event: ${event}\ndata: ${data}\n\n`);
const encodeSnapshot = Schema.encodeSync(Schema.fromJsonString(ArdudBoardSnapshot));
const encodeDelta = Schema.encodeSync(Schema.fromJsonString(ArdudBoardDelta));

export const ardudBoardRouteLayer = Layer.mergeAll(
  route(
    "GET",
    "",
    Effect.gen(function* () {
      yield* authenticate(AuthOrchestrationReadScope);
      const board = yield* BoardService.BoardService;
      return json(yield* board.snapshot);
    }),
  ),
  // One snapshot, then small deltas as threads change. No client polling; a
  // keep-alive comment stops proxies from dropping an idle stream.
  route(
    "GET",
    "/events",
    Effect.gen(function* () {
      yield* authenticate(AuthOrchestrationReadScope);
      const board = yield* BoardService.BoardService;
      const events = board.events.pipe(
        Stream.map((event) =>
          event.kind === "snapshot"
            ? sse("snapshot", encodeSnapshot(event.snapshot))
            : sse("delta", encodeDelta(event.delta)),
        ),
      );
      const keepAlive = Stream.tick(Duration.seconds(25)).pipe(
        Stream.map(() => encoder.encode(": keep-alive\n\n")),
      );
      return HttpServerResponse.stream(Stream.merge(events, keepAlive), {
        contentType: "text/event-stream",
        // no-transform keeps the compression middleware from buffering the stream.
        headers: {
          "cache-control": "no-cache, no-transform",
          "x-accel-buffering": "no",
        },
      });
    }),
  ),
  action("review"),
  action("backlog"),
  action("restore"),
  route(
    "POST",
    "/clear",
    Effect.gen(function* () {
      yield* authenticate(AuthOrchestrationOperateScope);
      const input = yield* decodeBody(ArdudBoardClearInput);
      const board = yield* BoardService.BoardService;
      return json(yield* board.clearLane(input));
    }),
  ),
  route(
    "POST",
    "/reconcile",
    Effect.gen(function* () {
      yield* authenticate(AuthOrchestrationOperateScope);
      const board = yield* BoardService.BoardService;
      return json(yield* board.reconcile);
    }),
  ),
  route(
    "POST",
    "/import-openchamber",
    Effect.gen(function* () {
      yield* authenticate(AuthOrchestrationOperateScope);
      const input = yield* decodeBody(ArdudBoardImportInput);
      const importer = yield* BoardImport.BoardImport;
      return json(yield* importer.importOpenChamber(input));
    }),
  ),
);
