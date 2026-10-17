import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  NoteSeverity,
  NoteType,
  SuggestionTargetKind,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import { type ScribeError, ScribeService } from "./ScribeService.ts";

/** Routes the scribe runner calls, under the missions HTTP prefix. */
export const SCRIBE_ROUTE_PREFIX = "/api/ardud/missions/scribe";

type ErrorCode =
  | "unauthorized"
  | "forbidden"
  | "invalid_request"
  | "not_found"
  | "conflict"
  | "internal";

class ScribeHttpError extends Data.TaggedError("ScribeHttpError")<{
  readonly code: ErrorCode;
  readonly message: string;
}> {}

const STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  invalid_request: 400,
  not_found: 404,
  conflict: 409,
  internal: 500,
};

const fail = (code: ErrorCode, message: string) => new ScribeHttpError({ code, message });

const json = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: { "cache-control": "no-store" } });

const errorResponse = (error: ScribeHttpError) =>
  json({ ok: false, error: { code: error.code, message: error.message } }, STATUS[error.code]);

const MISSION_CODES: Record<string, ErrorCode> = {
  "not-found": "not_found",
  conflict: "conflict",
  forbidden: "forbidden",
  locked: "conflict",
};

// ---------------------------------------------------------------------------
// Bodies. The runner already shapes these; the server still checks every field.
// ---------------------------------------------------------------------------

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const NoteDraftBody = Schema.Struct({
  type: NoteType,
  summary: Schema.String,
  quote: Schema.String,
  event: Count,
  fromEvent: Count,
  toEvent: Count,
  basis: Schema.Literals(["observed", "claimed"]),
  severity: NoteSeverity,
  confidence: Schema.Number,
  replaces: Schema.NullOr(Schema.String),
});

const CandidateDraftBody = Schema.Struct({
  targetKind: SuggestionTargetKind,
  title: Schema.String,
  proposal: Schema.String,
  why: Schema.String,
  quote: Schema.String,
  event: Count,
});

const Usage = Schema.Struct({ input: Count, output: Count });

const BatchBody = Schema.Struct({
  missionId: Schema.String,
  laneId: Schema.NullOr(Schema.String),
  subMissionId: Schema.NullOr(Schema.String),
  threadId: Schema.String,
  fromEvent: Count,
  toEvent: Count,
  notes: Schema.Array(NoteDraftBody),
  candidates: Schema.Array(CandidateDraftBody),
  droppedCount: Count,
  usage: Usage,
  model: Schema.NullOr(Schema.String),
});

const EditorBody = Schema.Struct({
  missionId: Schema.String,
  since: Schema.String,
  reply: Schema.Unknown,
  model: Schema.NullOr(Schema.String),
  usage: Usage,
});

const ReportBody = Schema.Struct({
  missionId: Schema.String,
  kind: Schema.Literals(["update", "daily"]),
  from: Schema.optional(Schema.NullOr(Schema.String)),
  to: Schema.optional(Schema.NullOr(Schema.String)),
  save: Schema.optional(Schema.Boolean),
});

const decodeJsonText = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeBatch = Schema.decodeUnknownEffect(BatchBody);
const decodeEditor = Schema.decodeUnknownEffect(EditorBody);
const decodeReport = Schema.decodeUnknownEffect(ReportBody);

const decodeBody = <A>(decode: (input: unknown) => Effect.Effect<A, Schema.SchemaError>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const text = yield* request.text.pipe(
      Effect.mapError(() => fail("invalid_request", "Unable to read the request body.")),
    );
    const raw =
      text.trim().length === 0
        ? {}
        : yield* decodeJsonText(text).pipe(
            Effect.mapError(() => fail("invalid_request", "The request body is not valid JSON.")),
          );
    return yield* decode(raw).pipe(
      Effect.mapError((error) => fail("invalid_request", error.message)),
    );
  });

const searchParams = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  return Option.isSome(url) ? url.value.searchParams : new URLSearchParams();
});

const required = (params: URLSearchParams, name: string) => {
  const value = params.get(name)?.trim() ?? "";
  return value.length > 0
    ? Effect.succeed(value)
    : Effect.fail(fail("invalid_request", `Missing query parameter ${name}.`));
};

const limitParam = (raw: string | null, fallback: number, max: number) => {
  const value = raw === null ? Number.NaN : Number(raw);
  return Number.isInteger(value) && value > 0 ? Math.min(value, max) : fallback;
};

type Scope = typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope;

const makeRoutes = Effect.gen(function* () {
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const scribe = yield* ScribeService;

  const authenticate = (scope: Scope) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const session = yield* auth
        .authenticateHttpRequest(request)
        .pipe(
          Effect.mapError((error) =>
            EnvironmentAuth.isServerAuthCredentialError(error)
              ? fail("unauthorized", "A valid bearer token is required.")
              : fail("internal", "Authentication failed."),
          ),
        );
      if (!session.scopes.includes(scope)) {
        return yield* fail("forbidden", `This token lacks the ${scope} scope.`);
      }
    });

  /** Run a service call and map its errors onto HTTP codes. */
  const call = <A, R>(effect: Effect.Effect<A, ScribeError, R>) =>
    effect.pipe(
      Effect.catchTags({
        MissionError: (error) =>
          Effect.fail(fail(MISSION_CODES[error.code] ?? "invalid_request", error.detail)),
        ScribeStoreError: (error) => Effect.fail(fail("internal", error.message)),
      }),
    );

  const lanes = Effect.gen(function* () {
    yield* authenticate(AuthOrchestrationReadScope);
    const missionId = yield* required(yield* searchParams, "missionId");
    return json({ ok: true, lanes: yield* call(scribe.lanes(missionId)) });
  });

  const openNotes = Effect.gen(function* () {
    yield* authenticate(AuthOrchestrationReadScope);
    const params = yield* searchParams;
    const missionId = yield* required(params, "missionId");
    const threadId = yield* required(params, "threadId");
    return json({ ok: true, notes: yield* call(scribe.openNotes(missionId, threadId)) });
  });

  const fyi = Effect.gen(function* () {
    yield* authenticate(AuthOrchestrationReadScope);
    const params = yield* searchParams;
    const missionId = yield* required(params, "missionId");
    const limit = limitParam(params.get("limit"), 12, 100);
    return json({ ok: true, notes: yield* call(scribe.fyi(missionId, limit)) });
  });

  const stats = Effect.gen(function* () {
    yield* authenticate(AuthOrchestrationReadScope);
    const params = yield* searchParams;
    const missionId = yield* required(params, "missionId");
    const since = params.get("since")?.trim() || null;
    return json({ ok: true, stats: yield* call(scribe.stats(missionId, since)) });
  });

  const postBatch = Effect.gen(function* () {
    yield* authenticate(AuthOrchestrationOperateScope);
    const body = yield* decodeBody(decodeBatch);
    return json({ ok: true, result: yield* call(scribe.ingest(body)) });
  });

  const editorInput = Effect.gen(function* () {
    yield* authenticate(AuthOrchestrationReadScope);
    const missionId = yield* required(yield* searchParams, "missionId");
    return json({ ok: true, input: yield* call(scribe.editorInput(missionId)) });
  });

  const postEditor = Effect.gen(function* () {
    yield* authenticate(AuthOrchestrationOperateScope);
    const body = yield* decodeBody(decodeEditor);
    return json({ ok: true, result: yield* call(scribe.applyEditor(body)) });
  });

  const postReport = Effect.gen(function* () {
    const body = yield* decodeBody(decodeReport);
    // Building is a read; keeping the report for the next close-out is a write.
    yield* authenticate(
      body.save === true ? AuthOrchestrationOperateScope : AuthOrchestrationReadScope,
    );
    const report = yield* call(
      scribe.report({
        missionId: body.missionId,
        kind: body.kind,
        from: body.from ?? undefined,
        to: body.to ?? undefined,
        save: body.save === true,
      }),
    );
    return json({ ok: true, report });
  });

  const handle = <R>(
    effect: Effect.Effect<HttpServerResponse.HttpServerResponse, ScribeHttpError, R>,
  ) =>
    effect.pipe(
      Effect.catchTags({ ScribeHttpError: (error) => Effect.succeed(errorResponse(error)) }),
      Effect.catchCause((cause) =>
        Effect.logWarning("ardud scribe request failed", { cause }).pipe(
          Effect.as(errorResponse(fail("internal", "Internal error."))),
        ),
      ),
    );

  const p = SCRIBE_ROUTE_PREFIX;
  return [
    HttpRouter.route("GET", `${p}/lanes`, handle(lanes)),
    HttpRouter.route("GET", `${p}/open-notes`, handle(openNotes)),
    HttpRouter.route("GET", `${p}/fyi`, handle(fyi)),
    HttpRouter.route("GET", `${p}/stats`, handle(stats)),
    HttpRouter.route("POST", `${p}/batches`, handle(postBatch)),
    HttpRouter.route("GET", `${p}/editor/input`, handle(editorInput)),
    HttpRouter.route("POST", `${p}/editor`, handle(postEditor)),
    HttpRouter.route("POST", `${p}/reports`, handle(postReport)),
  ] as const;
});

/**
 * Scribe routes. Same bearer auth as the control API: reads need
 * orchestration:read, writes need orchestration:operate. Core mounts this next
 * to its own `/api/ardud/missions/*` routes.
 */
export const scribeRouteLayer = HttpRouter.addAll(makeRoutes);
