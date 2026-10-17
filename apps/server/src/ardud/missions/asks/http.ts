/**
 * Missions desk over the local control API, for the `mission` CLI and
 * robob-watch checks. Same auth and `{ ok, ... }` envelope as
 * `/api/ardud/control`. Callers here are never the owner: answers and draft
 * approvals only pass with an iMessage inbound id the server verifies.
 */
import {
  AskId,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  DraftId,
  MissionError,
  type MissionEvent,
  MissionId,
  type MissionProvenance,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import { parseSince } from "../../control/model.ts";
import { AsksService } from "./AsksService.ts";
import {
  isWatchKind,
  watchAddCommand,
  watchCheckCommand,
  watchMatches,
  type WatchKind,
} from "./watch.ts";

export const MISSIONS_DESK_PREFIX = "/api/ardud/missions/desk";

/** The CLI robob-watch checks call; `cli/mission.mjs` installed on PATH. */
const MISSION_CLI = "mission";

/** Everything arriving here is a token holder, not the owner typing in Robob. */
export const CONTROL_PROVENANCE: MissionProvenance = { _tag: "system", component: "control-api" };

type DeskErrorCode =
  | "unauthorized"
  | "forbidden"
  | "invalid_request"
  | "not_found"
  | "conflict"
  | "internal";

class DeskError extends Data.TaggedError("DeskError")<{
  readonly code: DeskErrorCode;
  readonly message: string;
}> {}

const STATUS: Record<DeskErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  invalid_request: 400,
  not_found: 404,
  conflict: 409,
  internal: 500,
};

const fail = (code: DeskErrorCode, message: string) => new DeskError({ code, message });

const fromMissionError = (error: MissionError): DeskError => {
  switch (error.code) {
    case "not-found":
      return fail("not_found", error.message);
    case "conflict":
    case "fence-mismatch":
    case "pool-full":
      return fail("conflict", error.message);
    case "forbidden":
    case "locked":
    case "provenance-required":
    case "provenance-invalid":
      return fail("forbidden", error.message);
    case "invalid":
      return fail("invalid_request", error.message);
  }
};

const NO_STORE = { "cache-control": "no-store" } as const;

const json = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: NO_STORE });

const errorResponse = (error: DeskError) =>
  json({ ok: false, error: { code: error.code, message: error.message } }, STATUS[error.code]);

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

const decodeJsonText = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const AnswerBody = Schema.Struct({
  optionId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  text: Schema.optional(Schema.String),
  inboundId: TrimmedNonEmptyString,
});
const decodeAnswerBody = Schema.decodeUnknownEffect(AnswerBody);

const DecideBody = Schema.Struct({
  action: Schema.Literals(["approve", "rewrite", "drop"]),
  editedText: Schema.optional(Schema.String),
  rewriteNote: Schema.optional(Schema.String),
  inboundId: TrimmedNonEmptyString,
});
const decodeDecideBody = Schema.decodeUnknownEffect(DecideBody);

const searchParams = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  return Option.isSome(url) ? url.value.searchParams : new URLSearchParams();
});

const param = (name: string) =>
  Effect.gen(function* () {
    const params = yield* HttpRouter.params;
    const value = params[name]?.trim();
    if (value === undefined || value.length === 0) {
      return yield* fail("invalid_request", `Missing path parameter ${name}.`);
    }
    return value;
  });

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

const listParam = (raw: string | null): ReadonlyArray<string> | undefined => {
  const values = (raw ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return values.length === 0 ? undefined : values;
};

const missionParam = (raw: string | null) => {
  const value = raw?.trim() ?? "";
  return value.length === 0 ? undefined : MissionId.make(value);
};

const requireMission = (raw: string | null) => {
  const missionId = missionParam(raw);
  return missionId === undefined
    ? Effect.fail(fail("invalid_request", "The mission query parameter is required."))
    : Effect.succeed(missionId);
};

const RELATIVE = /^(\d+)\s*([mhd])$/;
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** `--since` accepts ISO times, epoch ms, or `30m` / `6h` / `2d` back from now. */
export const sinceMillis = (raw: string | null, nowMs: number): number | undefined => {
  const value = raw?.trim() ?? "";
  const relative = RELATIVE.exec(value);
  if (relative !== null) {
    return nowMs - Number(relative[1]) * UNIT_MS[relative[2] as keyof typeof UNIT_MS];
  }
  return parseSince(value);
};

const nonNegativeInt = (raw: string | null, fallback: number) => {
  const value = raw === null ? Number.NaN : Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
};

const WATCH_PAGE = 500;
const WATCH_MAX_EVENTS = 5_000;

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const makeRoutes = Effect.gen(function* () {
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const asks = yield* AsksService;

  const authenticate = (
    scope: typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope,
  ) =>
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
      return session;
    });

  const read = <A, R>(effect: Effect.Effect<A, DeskError | MissionError, R>) =>
    authenticate(AuthOrchestrationReadScope).pipe(Effect.andThen(effect));
  const write = <A, R>(effect: Effect.Effect<A, DeskError | MissionError, R>) =>
    authenticate(AuthOrchestrationOperateScope).pipe(Effect.andThen(effect));

  const nowMs = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));

  const listMissions = read(
    Effect.gen(function* () {
      return json({ ok: true, missions: yield* asks.missions() });
    }),
  );

  const status = read(
    Effect.gen(function* () {
      const query = yield* searchParams;
      const missionId = missionParam(query.get("mission"));
      if (missionId === undefined) {
        return json({ ok: true, missions: yield* asks.missions() });
      }
      return json({
        ok: true,
        desk: yield* asks.desk(missionId),
        suggestionStats: yield* asks.suggestionStats(),
      });
    }),
  );

  const digest = read(
    Effect.gen(function* () {
      const query = yield* searchParams;
      const missionId = yield* requireMission(query.get("mission"));
      const now = yield* nowMs;
      const raw = query.get("since");
      const since = raw === null ? now - UNIT_MS.d : sinceMillis(raw, now);
      if (since === undefined) {
        return yield* fail("invalid_request", "since must be an ISO time, epoch ms or 30m/6h/2d.");
      }
      const sinceIso = DateTime.formatIso(DateTime.makeUnsafe(since));
      return json({ ok: true, since: sinceIso, events: yield* asks.digest(missionId, sinceIso) });
    }),
  );

  const listAsks = read(
    Effect.gen(function* () {
      const query = yield* searchParams;
      const result = yield* asks.asks({
        missionId: missionParam(query.get("mission")),
        status: listParam(query.get("status")),
      });
      return json({ ok: true, asks: result });
    }),
  );

  const getAsk = read(
    Effect.gen(function* () {
      const askId = AskId.make(yield* param("askId"));
      return json({ ok: true, ask: yield* asks.ask(askId) });
    }),
  );

  const answer = write(
    Effect.gen(function* () {
      const askId = AskId.make(yield* param("askId"));
      const body = yield* decodeBody(decodeAnswerBody);
      const result = yield* asks.answerAsk(
        {
          askId,
          optionId: body.optionId ?? null,
          text: body.text ?? "",
          inboundId: body.inboundId,
        },
        CONTROL_PROVENANCE,
      );
      return json({ ok: true, ask: result.ask, released: result.released });
    }),
  );

  const listDrafts = read(
    Effect.gen(function* () {
      const query = yield* searchParams;
      const result = yield* asks.drafts({
        missionId: missionParam(query.get("mission")),
        status: listParam(query.get("status")),
      });
      return json({ ok: true, drafts: result });
    }),
  );

  const decide = write(
    Effect.gen(function* () {
      const draftId = DraftId.make(yield* param("draftId"));
      const body = yield* decodeBody(decodeDecideBody);
      const result = yield* asks.decideDraft(
        {
          draftId,
          action: body.action,
          inboundId: body.inboundId,
          ...(body.editedText === undefined ? {} : { editedText: body.editedText }),
          ...(body.rewriteNote === undefined ? {} : { rewriteNote: body.rewriteNote }),
        },
        CONTROL_PROVENANCE,
      );
      return json({ ok: true, draft: result.draft, suggestions: result.suggestions });
    }),
  );

  const events = read(
    Effect.gen(function* () {
      const query = yield* searchParams;
      const missionId = yield* requireMission(query.get("mission"));
      const after = nonNegativeInt(query.get("after"), 0);
      const limit = Math.min(Math.max(nonNegativeInt(query.get("limit"), 100), 1), 500);
      return json({ ok: true, events: yield* asks.events(missionId, after, limit) });
    }),
  );

  // One call per robob-watch tick: events matching the kinds after `after`,
  // and the seq to store as the next cursor. Without `after` it only returns
  // the current seq, so a new watcher starts from now instead of history.
  const watch = read(
    Effect.gen(function* () {
      const query = yield* searchParams;
      const missionId = yield* requireMission(query.get("mission"));
      const requested = listParam(query.get("on")) ?? [];
      const unknown = requested.filter((kind) => !isWatchKind(kind));
      const kinds: ReadonlyArray<WatchKind> = requested.filter(isWatchKind);
      if (kinds.length === 0 || unknown.length > 0) {
        return yield* fail(
          "invalid_request",
          unknown.length > 0
            ? `Unknown watch kinds: ${unknown.join(", ")}.`
            : "on must name at least one watch kind.",
        );
      }
      const desk = yield* asks.desk(missionId);
      const afterRaw = query.get("after");
      if (afterRaw === null || afterRaw.trim() === "") {
        const interval = nonNegativeInt(query.get("interval"), 120);
        return json({
          ok: true,
          matches: [],
          latestSeq: desk.latestSeq,
          check: watchCheckCommand({ cli: MISSION_CLI, missionId, kinds }),
          add: watchAddCommand({
            cli: MISSION_CLI,
            missionId,
            kinds,
            intervalSeconds: Math.min(Math.max(interval, 30), 3600),
          }),
        });
      }
      let cursor = nonNegativeInt(afterRaw, desk.latestSeq);
      const seen: MissionEvent[] = [];
      while (seen.length < WATCH_MAX_EVENTS) {
        const page = yield* asks.events(missionId, cursor, WATCH_PAGE);
        seen.push(...page);
        const last = page.at(-1);
        if (last === undefined || page.length < WATCH_PAGE) break;
        cursor = last.seq;
      }
      return json({
        ok: true,
        matches: watchMatches(seen, kinds),
        // A cursor past the log (store reset) snaps back to the current seq.
        latestSeq: seen.at(-1)?.seq ?? Math.min(cursor, desk.latestSeq),
      });
    }),
  );

  const handle = <R>(
    effect: Effect.Effect<HttpServerResponse.HttpServerResponse, DeskError | MissionError, R>,
  ) =>
    effect.pipe(
      Effect.catchTags({
        DeskError: (error) => Effect.succeed(errorResponse(error)),
        MissionError: (error) => Effect.succeed(errorResponse(fromMissionError(error))),
      }),
      Effect.catchCause((cause) =>
        Effect.logWarning("ardud missions desk request failed", { cause }).pipe(
          Effect.as(errorResponse(fail("internal", "Internal error."))),
        ),
      ),
    );

  const p = MISSIONS_DESK_PREFIX;
  return [
    HttpRouter.route("GET", `${p}/missions`, handle(listMissions)),
    HttpRouter.route("GET", `${p}/status`, handle(status)),
    HttpRouter.route("GET", `${p}/digest`, handle(digest)),
    HttpRouter.route("GET", `${p}/asks`, handle(listAsks)),
    HttpRouter.route("GET", `${p}/asks/:askId`, handle(getAsk)),
    HttpRouter.route("POST", `${p}/asks/:askId/answer`, handle(answer)),
    HttpRouter.route("GET", `${p}/drafts`, handle(listDrafts)),
    HttpRouter.route("POST", `${p}/drafts/:draftId/decide`, handle(decide)),
    HttpRouter.route("GET", `${p}/events`, handle(events)),
    HttpRouter.route("GET", `${p}/watch`, handle(watch)),
  ] as const;
});

export const missionsDeskRouteLayer = HttpRouter.addAll(makeRoutes);
