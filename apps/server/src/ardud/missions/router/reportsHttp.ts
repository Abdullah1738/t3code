/**
 * A chat's report to the master, for the iMessage chat agents and the
 * `mission report` CLI:
 *
 * - `POST /api/ardud/missions/desk/reports` `{ missionId, chat, text, file?, key? }`
 *
 * A bug or an idea an iMessage chat ran into lands as a request to the master
 * in the mission's quality room (the control room when there is none), written
 * by `imessage:<chat>`. It never speaks for the owner: no inbound id, no owner
 * provenance, nothing it posts answers, approves or settles anything.
 *
 * Only the mission CLI and the iMessage bridge credentials may file one; the
 * server names the chat itself from the bridge's stores, so a caller can't
 * write as a chat that does not exist.
 */
import {
  AuthOrchestrationOperateScope,
  MissionId,
  OwnerRequestText,
  RoomId,
  TrimmedNonEmptyString,
  type MissionError,
  type MissionLink,
  type PostMessageInput,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import { MISSIONS_DESK_PREFIX } from "../asks/http.ts";
import { clipSummary } from "../asks/shared.ts";
import { componentProvenance } from "../core/provenance.ts";
import * as MissionStore from "../store/MissionStore.ts";
import { masterRoleOf, readCast } from "./cast.ts";
import { postContentHash, sha256 } from "./hash.ts";
import { controlRoomId, MissionRouter } from "./MissionRouter.ts";
import * as ReportChats from "./reportChats.ts";
import { RouterStore } from "./RouterStore.ts";

/** Credentials a chat agent files reports through. */
const REPORT_COMPONENTS: ReadonlySet<string> = new Set(["mission-cli", "spectrum-bridge"]);

type DeskCode = "unauthorized" | "forbidden" | "invalid_request" | "not_found" | "conflict";

class ReportDeskError extends Data.TaggedError("ReportDeskError")<{
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

const deskError = (code: DeskCode, message: string) => new ReportDeskError({ code, message });

const fromMissionError = (error: MissionError): ReportDeskError => {
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

const ShortText = TrimmedNonEmptyString.check(Schema.isMaxLength(200));

const ReportBody = Schema.Struct({
  missionId: MissionId,
  /** The chat agent's session or the chat's slug. */
  chat: ShortText,
  text: OwnerRequestText,
  /** An absolute path on this Mac (a log, a screenshot). */
  file: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(1_000))),
  /** Makes a retry the same report; defaults to one per chat and text. */
  key: Schema.optional(ShortText),
});

const decodeJsonText = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeReport = Schema.decodeUnknownEffect(ReportBody);

const decodeBody = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const text = yield* request.text.pipe(
    Effect.mapError(() => deskError("invalid_request", "Unable to read the request body.")),
  );
  const raw = yield* decodeJsonText(text).pipe(
    Effect.mapError(() => deskError("invalid_request", "The request body is not valid JSON.")),
  );
  return yield* decodeReport(raw).pipe(
    Effect.mapError((error) => deskError("invalid_request", error.message)),
  );
});

export const qualityRoomId = (missionId: MissionId) => RoomId.make(`${missionId}:room:quality`);

const makeRoutes = Effect.gen(function* () {
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const router = yield* MissionRouter;
  const store = yield* MissionStore.MissionStore;
  const chats = yield* ReportChats.ReportChats;
  const rooms = yield* RouterStore;

  /** The quality room while it is open, otherwise the control room. */
  const reportRoom = Effect.fn("ReportsDesk.reportRoom")(function* (missionId: MissionId) {
    const quality = yield* rooms.room(qualityRoomId(missionId));
    return quality !== null && !quality.archived ? quality.id : controlRoomId(missionId);
  });

  /** The calling component, refused unless it is one a chat agent reports through. */
  const reporter = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const session = yield* auth.authenticateHttpRequest(request).pipe(
      Effect.catchIf(
        (error) => !EnvironmentAuth.isServerAuthCredentialError(error),
        (error) => Effect.die(error),
      ),
      Effect.mapError(() => deskError("unauthorized", "Authentication required.")),
    );
    if (!session.scopes.includes(AuthOrchestrationOperateScope)) {
      return yield* deskError(
        "forbidden",
        `This token lacks the ${AuthOrchestrationOperateScope} scope.`,
      );
    }
    const caller = componentProvenance(session);
    if (caller === null || caller._tag !== "system" || !REPORT_COMPONENTS.has(caller.component)) {
      return yield* deskError(
        "forbidden",
        "Reports come from an iMessage chat through the mission CLI's credential.",
      );
    }
  });

  const report = Effect.gen(function* () {
    yield* reporter;
    const body = yield* decodeBody;
    const slug = yield* chats.resolve(body.chat);
    if (slug === null) {
      return yield* deskError(
        "invalid_request",
        `No iMessage chat ${body.chat}. Pass this chat's session or its slug (owner, moni, group-...).`,
      );
    }
    if (body.file !== undefined && !body.file.startsWith("/")) {
      return yield* deskError("invalid_request", "file is an absolute path.");
    }
    const mission = Option.getOrNull(yield* store.get("mission", body.missionId));
    if (mission === null) return yield* deskError("not_found", `No mission ${body.missionId}.`);
    const master = masterRoleOf(yield* readCast(store, body.missionId));
    if (master === null) {
      return yield* deskError("conflict", `Mission ${mission.title} has no master to report to.`);
    }
    const writer = { _tag: "system" as const, component: `imessage:${slug}` };
    const links: ReadonlyArray<MissionLink> =
      body.file === undefined
        ? []
        : [
            {
              kind: "file",
              label: body.file.slice(body.file.lastIndexOf("/") + 1) || body.file,
              url: null,
              ref: body.file,
            },
          ];
    const key = `report:${slug}:${
      body.key ?? sha256(`${slug}\n${body.file ?? ""}\n${body.text}`).slice(0, 32)
    }`;
    const input = (roomId: RoomId): PostMessageInput => ({
      missionId: body.missionId,
      roomId,
      kind: "request",
      summary: clipSummary(body.text.split("\n")[0] ?? body.text),
      body: `${body.text}\n\nFrom iMessage chat ${slug}`,
      to: [{ _tag: "role", roleId: master.id }],
      key,
      links: [...links],
    });
    // A retry stays the report it was, wherever it landed, even after the quality
    // room opens or closes; the router alone would see a different room as new text.
    const prior = yield* rooms.messageByKey(body.missionId, key);
    const message =
      prior === null
        ? yield* router.post(input(yield* reportRoom(body.missionId)), writer)
        : postContentHash(input(prior.message.roomId)) === prior.contentHash
          ? prior.message
          : yield* deskError(
              "conflict",
              `Key ${body.key ?? key} was already used for a different report (#${prior.message.seq}).`,
            );
    return json({
      ok: true,
      report: { chat: slug, messageId: message.id, roomId: message.roomId, seq: message.seq },
    });
  });

  const handle = <R>(
    effect: Effect.Effect<HttpServerResponse.HttpServerResponse, ReportDeskError | MissionError, R>,
  ) =>
    effect.pipe(
      Effect.catchTags({
        ReportDeskError: (error) =>
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
        Effect.logWarning("ardud missions report desk failed", { cause }).pipe(
          Effect.as(
            json(
              {
                ok: false,
                error: { code: "internal", message: "Robob could not take this report." },
              },
              500,
            ),
          ),
        ),
      ),
    );

  return [HttpRouter.route("POST", `${MISSIONS_DESK_PREFIX}/reports`, handle(report))] as const;
});

export const reportsRoutes = HttpRouter.addAll(makeRoutes);

/** The report route with the real bridge chat lookup. */
export const reportsDeskRouteLayer = reportsRoutes.pipe(Layer.provide(ReportChats.layer));
