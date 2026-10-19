/**
 * The owner's requests over the missions desk, for the iMessage assistant and
 * the `mission` CLI:
 *
 * - `GET  /api/ardud/missions/desk/requests?mission&status&request&discussions&about&unread`
 * - `POST /api/ardud/missions/desk/requests`                     `{ missionId, text, subMissionId?, subject?, inboundId }`
 * - `POST /api/ardud/missions/desk/requests/:requestId/reply`    `{ text, inboundId }`
 * - `POST /api/ardud/missions/desk/requests/:requestId/settle`   `{ note?, inboundId }`
 * - `POST /api/ardud/missions/desk/requests/:requestId/reopen`   `{ note?, inboundId }`
 *
 * A `subject` is Discuss: the request is about that record (one open per record).
 * `discussions=false` lists his requests about no record, `discussions=true`
 * only discussions, `about=<kind>:<id>` the discussions on one record, and
 * `unread=true` only those the master answered that he has not read.
 *
 * Writes speak for the owner only with the inbound id of the iMessage in which
 * he asked for it, redeemed once through the shared inbound ledger. Only the
 * iMessage bridge and the mission CLI credentials may redeem one; every other
 * caller is refused before the lookup. The text is the agent's reading of his
 * words; his words themselves ride along as the provenance quote.
 *
 * Reads carry the conversations (bodies with `request=<id>`) only for an owner
 * session or the iMessage bridge's credential; other read tokens get the list
 * without anyone's words.
 */
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  MissionId,
  MissionRecordRef,
  OwnerRequestId,
  OwnerRequestStatus,
  OwnerRequestText,
  SubMissionId,
  TrimmedNonEmptyString,
  type MissionError,
  type OwnerRequest,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import { deskCaller, MISSIONS_DESK_PREFIX, ownerView } from "../asks/http.ts";
import * as Inbound from "../asks/inbound.ts";
import { inboundLedger } from "../guard/inboundActions.ts";
import * as MissionStore from "../store/MissionStore.ts";
import { MissionRouter } from "./MissionRouter.ts";

/** How far back an iMessage may be when it opens a request. */
const OPEN_WINDOW_MS = 24 * 60 * 60 * 1000;

type DeskCode = "unauthorized" | "forbidden" | "invalid_request" | "not_found" | "conflict";

class RequestDeskError extends Data.TaggedError("RequestDeskError")<{
  readonly code: DeskCode;
  readonly message: string;
}> {}

const STATUS: Record<DeskCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  invalid_request: 400,
  not_found: 404,
  conflict: 409,
};

const deskError = (code: DeskCode, message: string) => new RequestDeskError({ code, message });

const fromMissionError = (error: MissionError): RequestDeskError => {
  switch (error.code) {
    case "not-found":
      return deskError("not_found", error.detail);
    case "conflict":
    case "fence-mismatch":
    case "pool-full":
      return deskError("conflict", error.detail);
    case "forbidden":
    case "locked":
    case "provenance-required":
    case "provenance-invalid":
      return deskError("forbidden", error.detail);
    case "invalid":
      return deskError("invalid_request", error.detail);
  }
};

const NO_STORE = { "cache-control": "no-store" } as const;

const json = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: NO_STORE });

const OpenBody = Schema.Struct({
  missionId: MissionId,
  text: OwnerRequestText,
  subMissionId: Schema.optional(SubMissionId),
  /** Discuss: the record this request is about. */
  subject: Schema.optional(MissionRecordRef),
  inboundId: TrimmedNonEmptyString,
});

const ReplyBody = Schema.Struct({
  text: OwnerRequestText,
  inboundId: TrimmedNonEmptyString,
});

const NoteBody = Schema.Struct({
  note: Schema.optional(OwnerRequestText),
  inboundId: TrimmedNonEmptyString,
});

const decodeJsonText = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeOpen = Schema.decodeUnknownEffect(OpenBody);
const decodeReply = Schema.decodeUnknownEffect(ReplyBody);
const decodeNote = Schema.decodeUnknownEffect(NoteBody);
const decodeMission = Schema.decodeUnknownEffect(MissionId);
const decodeStatus = Schema.decodeUnknownEffect(OwnerRequestStatus);
const decodeRequestId = Schema.decodeUnknownEffect(OwnerRequestId);
const decodeRef = Schema.decodeUnknownEffect(MissionRecordRef);

/** `true`/`false`, or undefined when absent. */
const flagParam = (raw: string | null, name: string) => {
  const value = raw?.trim() ?? "";
  if (value === "") return Effect.succeed(undefined);
  if (value === "true" || value === "false") return Effect.succeed(value === "true");
  return Effect.fail(deskError("invalid_request", `${name} is true or false.`));
};

/** `about=<kind>:<id>`: the discussions on that record. */
const aboutParam = (raw: string | null) => {
  const value = raw?.trim() ?? "";
  if (value === "") return Effect.succeed(undefined);
  const colon = value.indexOf(":");
  const ref = colon < 0 ? {} : { kind: value.slice(0, colon), id: value.slice(colon + 1) };
  return decodeRef(ref).pipe(
    Effect.mapError(() => deskError("invalid_request", "about is <record kind>:<id>.")),
  );
};

const decodeBody = <A>(decode: (input: unknown) => Effect.Effect<A, Schema.SchemaError>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const text = yield* request.text.pipe(
      Effect.mapError(() => deskError("invalid_request", "Unable to read the request body.")),
    );
    const raw = yield* decodeJsonText(text).pipe(
      Effect.mapError(() => deskError("invalid_request", "The request body is not valid JSON.")),
    );
    return yield* decode(raw).pipe(
      Effect.mapError((error) => deskError("invalid_request", error.message)),
    );
  });

const searchParams = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  return Option.isSome(url) ? url.value.searchParams : new URLSearchParams();
});

const makeRoutes = Effect.gen(function* () {
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const router = yield* MissionRouter;
  const store = yield* MissionStore.MissionStore;
  const ledger = yield* inboundLedger;

  const authenticate = (
    scope: typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope,
  ) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const session = yield* auth.authenticateHttpRequest(request).pipe(
        Effect.catchIf(
          (error) => !EnvironmentAuth.isServerAuthCredentialError(error),
          (error) => Effect.die(error),
        ),
        Effect.mapError(() => deskError("unauthorized", "Authentication required.")),
      );
      if (!session.scopes.includes(scope)) {
        return yield* deskError("forbidden", `This token lacks the ${scope} scope.`);
      }
      return session;
    });

  const requestParam = Effect.gen(function* () {
    const params = yield* HttpRouter.params;
    return yield* decodeRequestId(params["requestId"] ?? "").pipe(
      Effect.mapError(() => deskError("invalid_request", "Missing request id.")),
    );
  });

  const requestById = (requestId: OwnerRequestId) =>
    Effect.gen(function* () {
      const request = Option.getOrNull(yield* store.get("owner-request", requestId));
      if (request === null) return yield* deskError("not_found", `No request ${requestId}.`);
      return request;
    });

  const atCreation = (request: OwnerRequest) => Effect.succeed({ at: request.createdAt });

  const list = authenticate(AuthOrchestrationReadScope).pipe(
    Effect.andThen((session) =>
      Effect.gen(function* () {
        // Who reads the words: an owner-paired session and the credentials his
        // iMessage agent acts through (the bridge, the mission CLI); the master
        // reads them through its own tools. Any other read token sees that
        // requests exist, not what they say.
        const reader = deskCaller(session);
        const params = yield* searchParams;
        const missionId = yield* decodeMission(params.get("mission") ?? "").pipe(
          Effect.mapError(() => deskError("invalid_request", "mission is required.")),
        );
        const rawStatus = params.get("status");
        const status =
          rawStatus === null || rawStatus.trim() === ""
            ? undefined
            : yield* decodeStatus(rawStatus.trim()).pipe(
                Effect.mapError(() =>
                  deskError("invalid_request", "status is waiting-on-master, answered or settled."),
                ),
              );
        const rawRequest = params.get("request");
        const requestId =
          rawRequest === null || rawRequest.trim() === ""
            ? undefined
            : yield* decodeRequestId(rawRequest.trim()).pipe(
                Effect.mapError(() => deskError("invalid_request", "request is a request id.")),
              );
        const discussions = yield* flagParam(params.get("discussions"), "discussions");
        const unread = yield* flagParam(params.get("unread"), "unread");
        const subject = yield* aboutParam(params.get("about"));
        const requests = yield* router.ownerRequests(
          {
            missionId,
            ...(status === undefined ? {} : { status }),
            ...(requestId === undefined ? {} : { requestId }),
            ...(discussions === undefined ? {} : { discussions }),
            ...(unread === undefined ? {} : { unread }),
            ...(subject === undefined ? {} : { subject }),
          },
          reader,
          ownerView(session),
        );
        return json({ ok: true, ...requests });
      }),
    ),
  );

  const open = authenticate(AuthOrchestrationOperateScope).pipe(
    Effect.andThen((session) =>
      Effect.gen(function* () {
        const body = yield* decodeBody(decodeOpen);
        const result = yield* ledger.once(
          {
            caller: deskCaller(session),
            inboundId: body.inboundId,
            subject:
              body.subject === undefined
                ? `mission:${body.missionId}`
                : `${body.subject.kind}:${body.subject.id}`,
            action: body.subject === undefined ? "request-open" : "discuss",
            payload: {
              missionId: body.missionId,
              text: body.text,
              subMissionId: body.subMissionId ?? null,
            },
            what: body.subject === undefined ? "A request" : "Discussing a record",
            notBefore: () =>
              DateTime.now.pipe(
                Effect.map((now) => ({
                  at: DateTime.formatIso(DateTime.subtract(now, { milliseconds: OPEN_WINDOW_MS })),
                })),
              ),
          },
          (owner) =>
            router
              .openRequest(
                {
                  missionId: body.missionId,
                  text: body.text,
                  ...(body.subMissionId === undefined ? {} : { subMissionId: body.subMissionId }),
                  ...(body.subject === undefined ? {} : { subject: body.subject }),
                },
                owner,
              )
              .pipe(Effect.map((request) => ({ ok: true, request }))),
        );
        return json(result);
      }),
    ),
  );

  const reply = authenticate(AuthOrchestrationOperateScope).pipe(
    Effect.andThen((session) =>
      Effect.gen(function* () {
        const requestId = yield* requestParam;
        const body = yield* decodeBody(decodeReply);
        const request = yield* requestById(requestId);
        const result = yield* ledger.once(
          {
            caller: deskCaller(session),
            inboundId: body.inboundId,
            subject: `owner-request:${requestId}`,
            action: "reply",
            payload: { text: body.text },
            what: "A reply",
            // A reply must come after the request it answers was opened.
            notBefore: () => atCreation(request),
          },
          (owner) =>
            router
              .replyRequest({ requestId, text: body.text }, owner)
              .pipe(Effect.map((next) => ({ ok: true, request: next }))),
        );
        return json(result);
      }),
    ),
  );

  /** Settle or reopen: his word on a request, with an optional note. */
  const settleOrReopen = (action: "settle" | "reopen") =>
    authenticate(AuthOrchestrationOperateScope).pipe(
      Effect.andThen((session) =>
        Effect.gen(function* () {
          const requestId = yield* requestParam;
          const body = yield* decodeBody(decodeNote);
          const request = yield* requestById(requestId);
          const input = { requestId, ...(body.note === undefined ? {} : { note: body.note }) };
          const result = yield* ledger.once(
            {
              caller: deskCaller(session),
              inboundId: body.inboundId,
              subject: `owner-request:${requestId}`,
              action,
              payload: { note: body.note ?? null },
              what: action === "settle" ? "Settling a request" : "Reopening a request",
              // Reopening answers the settle, so it must come after it, with no slack.
              notBefore: () =>
                Effect.succeed(
                  action === "reopen" && request.settledAt !== null
                    ? { at: request.settledAt, skewMs: 0 }
                    : { at: request.createdAt },
                ),
            },
            (owner) =>
              (action === "settle"
                ? router.settleRequest(input, owner)
                : router.reopenRequest(input, owner)
              ).pipe(Effect.map((next) => ({ ok: true, request: next }))),
          );
          return json(result);
        }),
      ),
    );

  const handle = <R>(
    effect: Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      RequestDeskError | MissionError,
      R
    >,
  ) =>
    effect.pipe(
      Effect.catchTags({
        RequestDeskError: (error) =>
          Effect.succeed(
            json(
              { ok: false, error: { code: error.code, message: error.message } },
              STATUS[error.code],
            ),
          ),
        MissionError: (error) => {
          const desk = fromMissionError(error);
          return Effect.succeed(
            json(
              { ok: false, error: { code: desk.code, message: desk.message } },
              STATUS[desk.code],
            ),
          );
        },
      }),
      Effect.catchCause((cause) =>
        Effect.logWarning("ardud missions request desk failed", { cause }).pipe(
          Effect.as(
            json(
              {
                ok: false,
                error: { code: "internal", message: "Robob could not take this request." },
              },
              500,
            ),
          ),
        ),
      ),
    );

  const p = `${MISSIONS_DESK_PREFIX}/requests`;
  return [
    HttpRouter.route("GET", p, handle(list)),
    HttpRouter.route("POST", p, handle(open)),
    HttpRouter.route("POST", `${p}/:requestId/reply`, handle(reply)),
    HttpRouter.route("POST", `${p}/:requestId/settle`, handle(settleOrReopen("settle"))),
    HttpRouter.route("POST", `${p}/:requestId/reopen`, handle(settleOrReopen("reopen"))),
  ] as const;
});

export const requestsRoutes = HttpRouter.addAll(makeRoutes);

/** The desk's request routes with the real iMessage lookup. */
export const requestsDeskRouteLayer = requestsRoutes.pipe(Layer.provide(Inbound.layer));
