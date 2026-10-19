/**
 * The owner's requests over the missions desk, for the iMessage assistant and
 * the `mission` CLI:
 *
 * - `GET  /api/ardud/missions/desk/requests?mission&status`
 * - `POST /api/ardud/missions/desk/requests`                     `{ missionId, text, subMissionId?, inboundId }`
 * - `POST /api/ardud/missions/desk/requests/:requestId/reply`    `{ text, inboundId }`
 *
 * Writes speak for the owner only with a verified inbound id: a real iMessage
 * from the owner's or Moni's chat that says exactly the text sent (the same
 * check asks use). The credential's own identity never stands in for him.
 */
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  MissionId,
  OwnerRequestId,
  OwnerRequestStatus,
  OwnerRequestText,
  SubMissionId,
  TrimmedNonEmptyString,
  type MissionError,
  type MissionProvenance,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import { CONTROL_PROVENANCE, MISSIONS_DESK_PREFIX } from "../asks/http.ts";
import * as Inbound from "../asks/inbound.ts";
import { answerCheck, verifyInbound } from "../asks/provenance.ts";
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
  inboundId: TrimmedNonEmptyString,
});

const ReplyBody = Schema.Struct({
  text: OwnerRequestText,
  inboundId: TrimmedNonEmptyString,
});

const decodeJsonText = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeOpen = Schema.decodeUnknownEffect(OpenBody);
const decodeReply = Schema.decodeUnknownEffect(ReplyBody);
const decodeMission = Schema.decodeUnknownEffect(MissionId);
const decodeStatus = Schema.decodeUnknownEffect(OwnerRequestStatus);
const decodeRequestId = Schema.decodeUnknownEffect(OwnerRequestId);

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
  const inbound = yield* Inbound.InboundLookup;

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
    });

  /** The owner's voice from an iMessage he sent, checked against the text we were given. */
  const ownerByIMessage = (inboundId: string, text: string, notBefore: string, what: string) =>
    Effect.gen(function* () {
      const message = yield* inbound.find(inboundId, notBefore);
      const verified = verifyInbound({
        inboundId,
        inbound: message,
        check: answerCheck({ options: [], optionId: null, text }),
        notBefore,
        what,
      });
      if (verified._tag === "Failure") return yield* verified.failure;
      return verified.success as MissionProvenance;
    });

  const list = authenticate(AuthOrchestrationReadScope).pipe(
    Effect.andThen(
      Effect.gen(function* () {
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
        const requests = yield* router.ownerRequests(
          { missionId, ...(status === undefined ? {} : { status }) },
          CONTROL_PROVENANCE,
        );
        return json({ ok: true, ...requests });
      }),
    ),
  );

  const open = authenticate(AuthOrchestrationOperateScope).pipe(
    Effect.andThen(
      Effect.gen(function* () {
        const body = yield* decodeBody(decodeOpen);
        const now = yield* DateTime.now;
        const notBefore = DateTime.formatIso(
          DateTime.subtract(now, { milliseconds: OPEN_WINDOW_MS }),
        );
        const owner = yield* ownerByIMessage(body.inboundId, body.text, notBefore, "A request");
        const request = yield* router.openRequest(
          {
            missionId: body.missionId,
            text: body.text,
            ...(body.subMissionId === undefined ? {} : { subMissionId: body.subMissionId }),
            // The same iMessage opens the same request, however often it is retried.
            key: `imessage:${body.inboundId}`,
          },
          owner,
        );
        return json({ ok: true, request });
      }),
    ),
  );

  const reply = authenticate(AuthOrchestrationOperateScope).pipe(
    Effect.andThen(
      Effect.gen(function* () {
        const params = yield* HttpRouter.params;
        const requestId = yield* decodeRequestId(params["requestId"] ?? "").pipe(
          Effect.mapError(() => deskError("invalid_request", "Missing request id.")),
        );
        const body = yield* decodeBody(decodeReply);
        const request = Option.getOrNull(yield* store.get("owner-request", requestId));
        if (request === null) return yield* deskError("not_found", `No request ${requestId}.`);
        // A reply must come after the request it answers was opened.
        const owner = yield* ownerByIMessage(
          body.inboundId,
          body.text,
          request.createdAt,
          "A reply",
        );
        const next = yield* router.replyRequest(
          { requestId, text: body.text, key: `imessage:${body.inboundId}` },
          owner,
        );
        return json({ ok: true, request: next });
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
  ] as const;
});

export const requestsRoutes = HttpRouter.addAll(makeRoutes);

/** The desk's request routes with the real iMessage lookup. */
export const requestsDeskRouteLayer = requestsRoutes.pipe(Layer.provide(Inbound.layer));
