/**
 * Routes for coord's forward mode, under `/api/ardud/missions/coord`:
 *
 * - `POST /post`  `{ mission, channel, as, kind, key, hash, summary, to, work, env, rev, authority, body, replyTo }`
 * - `GET  /inbox?mission&as&unacked&after&limit`
 * - `POST /ack`   `{ mission, as, refs }`
 *
 * Success is `{ ok: true, ... }` with coord's reply fields; a refusal is
 * `{ ok: false, error: { code, message, ...extra } }`, which coord rethrows as
 * its own error. Anything unexpected answers 503 without a code, which coord
 * reports as `messaging_unavailable` so its caller retries the same key.
 */
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  MissionId,
  MissionMessageKind,
  NonNegativeInt,
  type MissionError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import { CoordRefusal, CoordShim } from "./coordShim.ts";

export const COORD_SHIM_PREFIX = "/api/ardud/missions/coord";
const INBOX_LIMIT_DEFAULT = 100;

const NO_STORE = { "cache-control": "no-store" } as const;

const json = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: NO_STORE });

const refusal = (error: CoordRefusal) =>
  json(
    { ok: false, error: { code: error.code, message: error.message, ...error.extra } },
    error.status,
  );

const MISSION_STATUS: Record<MissionError["code"], number> = {
  "not-found": 404,
  conflict: 409,
  forbidden: 403,
  locked: 409,
  "fence-mismatch": 409,
  "pool-full": 409,
  "provenance-required": 403,
  "provenance-invalid": 403,
  invalid: 400,
};

const missionRefusal = (error: MissionError) =>
  new CoordRefusal({
    code: error.code.replaceAll("-", "_"),
    message: error.detail,
    status: MISSION_STATUS[error.code],
  });

const Nullable = <S extends Schema.Top>(schema: S) => Schema.optional(Schema.NullOr(schema));

const PostBody = Schema.Struct({
  mission: MissionId,
  channel: Schema.String.check(Schema.isNonEmpty()),
  as: Schema.String.check(Schema.isNonEmpty()),
  kind: MissionMessageKind,
  key: Schema.String.check(Schema.isNonEmpty()),
  hash: Schema.String,
  summary: Schema.String,
  to: Nullable(Schema.Array(Schema.String)),
  work: Nullable(Schema.String),
  env: Nullable(Schema.String),
  rev: Nullable(Schema.String),
  authority: Nullable(Schema.String),
  body: Schema.optional(Schema.Unknown),
  replyTo: Nullable(NonNegativeInt),
});

const AckBody = Schema.Struct({
  mission: MissionId,
  as: Schema.String.check(Schema.isNonEmpty()),
  refs: Schema.Array(Schema.String),
});

const decodeJsonText = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodePost = Schema.decodeUnknownEffect(PostBody);
const decodeAck = Schema.decodeUnknownEffect(AckBody);
const decodeMission = Schema.decodeUnknownEffect(MissionId);

const invalid = (message: string) => new CoordRefusal({ code: "invalid", message, status: 400 });

const decodeBody = <A>(decode: (input: unknown) => Effect.Effect<A, Schema.SchemaError>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const text = yield* request.text.pipe(
      Effect.mapError(() => invalid("Unable to read the request body.")),
    );
    const raw = yield* decodeJsonText(text).pipe(
      Effect.mapError(() => invalid("The request body is not valid JSON.")),
    );
    return yield* decode(raw).pipe(Effect.mapError((error) => invalid(error.message)));
  });

const searchParams = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  return Option.isSome(url) ? url.value.searchParams : new URLSearchParams();
});

const intParam = (raw: string | null, fallback: number) => {
  if (raw === null || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
};

const makeRoutes = Effect.gen(function* () {
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const shim = yield* CoordShim;

  const authenticate = (
    scope: typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope,
  ) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      // An internal auth fault is not a refusal: it ends in the 503 below.
      const session = yield* auth.authenticateHttpRequest(request).pipe(
        Effect.catchIf(
          (error) => !EnvironmentAuth.isServerAuthCredentialError(error),
          (error) => Effect.die(error),
        ),
        Effect.mapError(
          () => new CoordRefusal({ code: "unauthorized", message: "bad token", status: 401 }),
        ),
      );
      if (!session.scopes.includes(scope)) {
        return yield* new CoordRefusal({
          code: "forbidden",
          message: `This token lacks the ${scope} scope.`,
          status: 403,
        });
      }
      return session;
    });

  const post = authenticate(AuthOrchestrationOperateScope).pipe(
    Effect.andThen(decodeBody(decodePost)),
    Effect.flatMap((body) =>
      shim.post({
        mission: body.mission,
        channel: body.channel,
        as: body.as,
        kind: body.kind,
        key: body.key,
        hash: body.hash,
        summary: body.summary,
        to: body.to ?? null,
        work: body.work ?? null,
        env: body.env ?? null,
        rev: body.rev ?? null,
        authority: body.authority ?? null,
        body: body.body ?? null,
        replyTo: body.replyTo ?? null,
      }),
    ),
    Effect.map((reply) => json({ ok: true, ...reply })),
  );

  const inbox = authenticate(AuthOrchestrationReadScope).pipe(
    Effect.andThen(searchParams),
    Effect.flatMap((params) =>
      Effect.gen(function* () {
        const mission = yield* decodeMission(params.get("mission") ?? "").pipe(
          Effect.mapError(() => invalid("mission is required")),
        );
        const as = params.get("as")?.trim() ?? "";
        if (as.length === 0) return yield* invalid("as is required");
        const after = intParam(params.get("after"), 0);
        const limit = intParam(params.get("limit"), INBOX_LIMIT_DEFAULT);
        if (after === null || limit === null) {
          return yield* invalid("after and limit must be non-negative integers");
        }
        const events = yield* shim.inbox({
          mission,
          as,
          unacked: params.get("unacked") === "1",
          after,
          limit,
        });
        return json({ ok: true, events });
      }),
    ),
  );

  const ack = authenticate(AuthOrchestrationOperateScope).pipe(
    Effect.andThen(decodeBody(decodeAck)),
    Effect.flatMap((body) => shim.ack(body)),
    Effect.map((acked) => json({ ok: true, acked })),
  );

  const handle = <R>(
    effect: Effect.Effect<HttpServerResponse.HttpServerResponse, CoordRefusal | MissionError, R>,
  ) =>
    effect.pipe(
      Effect.catchTags({
        CoordRefusal: (error) => Effect.succeed(refusal(error)),
        MissionError: (error) => Effect.succeed(refusal(missionRefusal(error))),
      }),
      Effect.catchCause((cause) =>
        Effect.logWarning("ardud missions coord shim request failed", { cause }).pipe(
          Effect.as(
            json({ ok: false, error: { message: "Robob could not take this request." } }, 503),
          ),
        ),
      ),
    );

  const p = COORD_SHIM_PREFIX;
  return [
    HttpRouter.route("POST", `${p}/post`, handle(post)),
    HttpRouter.route("GET", `${p}/inbox`, handle(inbox)),
    HttpRouter.route("POST", `${p}/ack`, handle(ack)),
  ] as const;
});

export const coordShimRouteLayer = HttpRouter.addAll(makeRoutes);
