/**
 * Missions desk over the local control API, for the `mission` CLI and
 * robob-watch checks. Same auth and `{ ok, ... }` envelope as
 * `/api/ardud/control`. Callers here are never the owner: answers, draft and
 * approval decisions and call reactions pass only with the inbound id of the
 * iMessage in which he said so, redeemed once through the shared inbound
 * ledger by the iMessage bridge or mission CLI credential (any other caller is
 * refused before the lookup). Those two credentials and his own sessions also
 * read his full view (needs, approvals, calls, draft text and links, work,
 * timeline, progress); other tokens keep the narrower reads.
 *
 * Systems in SYSTEM_DRAFT_COMPONENTS (crw) also open drafts here for one exact
 * code head, stale-close their own, read the decision for that head and report
 * the approved text as sent (or failed) for the revision they read. The caller
 * is the component named by its own credential (`t3 ardud component-token issue
 * crw`); a body `requestedBy` may only repeat it, and identity headers are refused.
 */
import {
  ApprovalId,
  ApprovalStatus,
  AskId,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CallId,
  CloseStaleDraftInput,
  DraftId,
  LaneId,
  MissionError,
  type MissionEvent,
  MissionId,
  type MissionProvenance,
  NonNegativeInt,
  OpenSystemDraftInput,
  PositiveInt,
  ReportDraftSentInput,
  TrimmedNonEmptyString,
  WorkStage,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import { parseSince } from "../../control/model.ts";
import { componentProvenance, isOwnerSession, type OriginSession } from "../core/provenance.ts";
import { inboundLedger } from "../guard/inboundActions.ts";
import { MissionService } from "../MissionService.ts";
import * as MissionStore from "../store/MissionStore.ts";
import { askEpochOf, askReopened } from "./askModel.ts";
import { AsksService } from "./AsksService.ts";
import { epochOf, revisionOf } from "./draftModel.ts";
import { draftAttachments, pendingAndRecent, progressOf } from "./ownerView.ts";
import { attachComments } from "./inboxMarks.ts"; // ardud missions: r22 comments
import { canRedeemInbound } from "./provenance.ts";
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

/** Who a desk call comes from: its credential's component, else the shared control token. */
export const deskCaller = (session: OriginSession): MissionProvenance =>
  componentProvenance(session) ?? CONTROL_PROVENANCE;

/**
 * Whether a desk caller reads what the owner would see: a paired owner
 * session, or the credentials his iMessage agent acts through (the bridge and
 * the mission CLI). Every other token keeps the narrower view.
 */
export const ownerView = (session: OriginSession) =>
  isOwnerSession(session) || canRedeemInbound(deskCaller(session));

/** Systems that open their own drafts over HTTP, in their own name. */
const SYSTEM_DRAFT_COMPONENTS: ReadonlySet<string> = new Set(["crw"]);

const systemProvenance = (component: string): MissionProvenance => ({
  _tag: "system",
  component,
});

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
  note: Schema.optional(Schema.String),
});
const decodeAnswerBody = Schema.decodeUnknownEffect(AnswerBody);

const DecideBody = Schema.Struct({
  action: Schema.Literals(["approve", "rewrite", "drop"]),
  editedText: Schema.optional(Schema.String),
  rewriteNote: Schema.optional(Schema.String),
  inboundId: TrimmedNonEmptyString,
  revision: Schema.optional(NonNegativeInt),
  note: Schema.optional(Schema.String),
});
const decodeDecideBody = Schema.decodeUnknownEffect(DecideBody);

const ApprovalDecideBody = Schema.Struct({
  action: Schema.Literals(["approve", "reject"]),
  note: Schema.optional(Schema.String),
  inboundId: TrimmedNonEmptyString,
});
const decodeApprovalDecideBody = Schema.decodeUnknownEffect(ApprovalDecideBody);

const CallReactBody = Schema.Struct({
  reaction: Schema.NullOr(Schema.Literals(["ok", "discuss", "overruled"])),
  note: Schema.optional(Schema.String),
  inboundId: TrimmedNonEmptyString,
});
const decodeCallReactBody = Schema.decodeUnknownEffect(CallReactBody);

const decodeApprovalStatuses = Schema.decodeUnknownEffect(Schema.Array(ApprovalStatus));
const decodeStages = Schema.decodeUnknownEffect(Schema.Array(WorkStage));
const decodeLaneId = Schema.decodeUnknownEffect(LaneId);
const decodePositiveInt = Schema.decodeUnknownEffect(PositiveInt);

/** Decided approvals the owner's view keeps next to the pending ones. */
const RECENT_APPROVALS = 10;
// The credential names the system; a body `requestedBy` is optional and may only repeat it.
const claimedBy = { requestedBy: Schema.optional(TrimmedNonEmptyString) };
const decodeOpenSystemDraft = Schema.decodeUnknownEffect(
  Schema.Struct({ ...OpenSystemDraftInput.fields, ...claimedBy }),
);
const decodeCloseStaleDraft = Schema.decodeUnknownEffect(
  Schema.Struct({ ...CloseStaleDraftInput.fields, ...claimedBy }),
);
const decodeReportDraftSent = Schema.decodeUnknownEffect(
  Schema.Struct({ ...ReportDraftSentInput.fields, ...claimedBy }),
);

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
  const missions = yield* MissionService;
  const store = yield* MissionStore.MissionStore;
  const ledger = yield* inboundLedger;

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
  /** Reads of the owner's full view: his sessions, the bridge and the mission CLI. */
  const ownerRead = <A, R>(effect: Effect.Effect<A, DeskError | MissionError, R>) =>
    authenticate(AuthOrchestrationReadScope).pipe(
      Effect.flatMap((session) =>
        ownerView(session)
          ? effect
          : Effect.fail(
              fail(
                "forbidden",
                "This is the owner's view: only his sessions, the iMessage bridge and the mission CLI credential read it.",
              ),
            ),
      ),
    );
  /** A write that needs to know its caller (iMessage redemption checks it first). */
  const writeAs = <A, R>(
    effect: (caller: MissionProvenance) => Effect.Effect<A, DeskError | MissionError, R>,
  ) =>
    authenticate(AuthOrchestrationOperateScope).pipe(
      Effect.flatMap((session) => effect(deskCaller(session))),
    );

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
      return json({ ok: true, asks: yield* attachComments(store, "ask", result) });
    }),
  );

  const getAsk = read(
    Effect.gen(function* () {
      const askId = AskId.make(yield* param("askId"));
      const [ask] = yield* attachComments(store, "ask", [yield* asks.ask(askId)]);
      return json({ ok: true, ask });
    }),
  );

  const answer = writeAs((caller) =>
    Effect.gen(function* () {
      const askId = AskId.make(yield* param("askId"));
      const body = yield* decodeBody(decodeAnswerBody);
      const input = {
        askId,
        optionId: body.optionId ?? null,
        text: body.text ?? "",
        inboundId: body.inboundId,
        ...(body.note === undefined ? {} : { note: body.note }),
      };
      return json(
        yield* ledger.once(
          {
            caller,
            inboundId: body.inboundId,
            subject: `ask:${askId}`,
            action: "answer",
            payload: {
              optionId: input.optionId,
              text: input.text,
              ...(body.note === undefined ? {} : { note: body.note }),
            },
            what: "Answering an ask",
            notBefore: () =>
              asks.ask(askId).pipe(
                Effect.map((ask) => ({
                  at: askEpochOf(ask),
                  ...(askReopened(ask) ? { skewMs: 0 } : {}),
                })),
              ),
          },
          (owner) =>
            asks
              .answerAsk(input, owner)
              .pipe(
                Effect.map((result) => ({ ok: true, ask: result.ask, released: result.released })),
              ),
        ),
      );
    }),
  );

  const listDrafts = read(
    Effect.gen(function* () {
      const query = yield* searchParams;
      const result = yield* asks.drafts({
        missionId: missionParam(query.get("mission")),
        status: listParam(query.get("status")),
      });
      return json({ ok: true, drafts: yield* attachComments(store, "draft", result) });
    }),
  );

  const decide = writeAs((caller) =>
    Effect.gen(function* () {
      const draftId = DraftId.make(yield* param("draftId"));
      const body = yield* decodeBody(decodeDecideBody);
      const input = {
        draftId,
        action: body.action,
        inboundId: body.inboundId,
        ...(body.editedText === undefined ? {} : { editedText: body.editedText }),
        ...(body.rewriteNote === undefined ? {} : { rewriteNote: body.rewriteNote }),
        ...(body.revision === undefined ? {} : { revision: body.revision }),
        ...(body.note === undefined ? {} : { note: body.note }),
      };
      return json(
        yield* ledger.once(
          {
            caller,
            inboundId: body.inboundId,
            subject: `draft:${draftId}`,
            action: "decide",
            payload: {
              action: body.action,
              editedText: body.editedText ?? null,
              rewriteNote: body.rewriteNote ?? null,
              revision: body.revision ?? null,
              ...(body.note === undefined ? {} : { note: body.note }),
            },
            what: "Deciding a draft",
            notBefore: () =>
              store.get("draft", draftId).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () =>
                      Effect.fail(
                        new MissionError({
                          code: "not-found",
                          detail: `Draft ${draftId} not found.`,
                        }),
                      ),
                    onSome: (draft) =>
                      Effect.succeed({
                        at: epochOf(draft),
                        ...(revisionOf(draft) > 0 ? { skewMs: 0 } : {}),
                      }),
                  }),
                ),
              ),
          },
          (owner) =>
            asks.decideDraft(input, owner).pipe(
              Effect.map((result) => ({
                ok: true,
                draft: result.draft,
                suggestions: result.suggestions,
              })),
            ),
        ),
      );
    }),
  );

  // ardud missions: asks (N5)
  /**
   * The system a draft route acts for: the component its credential was minted for
   * (`t3 ardud component-token issue crw`), never a body field or a header. A body or query
   * `requestedBy` may only repeat it. Identity headers are refused outright so a caller relying on
   * them learns they count for nothing.
   */
  const systemCaller = (scope: Parameters<typeof authenticate>[0]) =>
    Effect.gen(function* () {
      const session = yield* authenticate(scope);
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (request.headers["x-t3-component"] !== undefined) {
        return yield* fail(
          "forbidden",
          "x-t3-component is not accepted. The credential says which system is calling.",
        );
      }
      for (const header of ["x-t3-thread-id", "x-t3-role-id"]) {
        if (request.headers[header] !== undefined) {
          return yield* fail(
            "invalid_request",
            `${header} is not accepted. A thread or role can't act for a system draft.`,
          );
        }
      }
      const component = session.origin?._tag === "component" ? session.origin.component : null;
      const allowed = [...SYSTEM_DRAFT_COMPONENTS].join(", ");
      if (component === null) {
        return yield* fail(
          "forbidden",
          `System drafts over HTTP need the system's own component credential (t3 ardud component-token issue ${allowed}).`,
        );
      }
      if (!SYSTEM_DRAFT_COMPONENTS.has(component)) {
        return yield* fail("forbidden", `Only ${allowed} open or read system drafts over HTTP.`);
      }
      return component;
    });

  /** A `requestedBy` claim is optional; one that names anyone but the caller is refused. */
  const sameCaller = (component: string, claimed: string | undefined) =>
    claimed === undefined || claimed === component
      ? Effect.succeed(component)
      : Effect.fail(
          fail("forbidden", `This credential is ${component}; it cannot act for ${claimed}.`),
        );

  const openSystemDraft = Effect.gen(function* () {
    const component = yield* systemCaller(AuthOrchestrationOperateScope);
    const body = yield* decodeBody(decodeOpenSystemDraft);
    const requestedBy = yield* sameCaller(component, body.requestedBy);
    const draft = yield* asks.openSystemDraft(
      { ...body, requestedBy },
      systemProvenance(requestedBy),
    );
    return json({ ok: true, draft });
  });

  const closeStaleDraft = Effect.gen(function* () {
    const component = yield* systemCaller(AuthOrchestrationOperateScope);
    const body = yield* decodeBody(decodeCloseStaleDraft);
    const requestedBy = yield* sameCaller(component, body.requestedBy);
    const draft = yield* asks.closeStaleDraft(
      { ...body, requestedBy },
      systemProvenance(requestedBy),
    );
    return json({ ok: true, draft });
  });

  /** Body `{ draftId, revision, outcome: sent{link} | send-failed{reason}, requestedBy? }`. */
  const reportDraftSent = Effect.gen(function* () {
    const component = yield* systemCaller(AuthOrchestrationOperateScope);
    const body = yield* decodeBody(decodeReportDraftSent);
    const requestedBy = yield* sameCaller(component, body.requestedBy);
    const draft = yield* asks.reportDraftSent(
      { ...body, requestedBy },
      systemProvenance(requestedBy),
    );
    return json({ ok: true, draft });
  });

  /** `?head=<sha>[&requestedBy=crw]`: only a decision on exactly that head counts. */
  const draftDecision = Effect.gen(function* () {
    const component = yield* systemCaller(AuthOrchestrationReadScope);
    const draftId = DraftId.make(yield* param("draftId"));
    const query = yield* searchParams;
    const claimed = query.get("requestedBy")?.trim();
    const requestedBy = yield* sameCaller(
      component,
      claimed === undefined || claimed.length === 0 ? undefined : claimed,
    );
    const head = query.get("head")?.trim() ?? "";
    if (head.length === 0)
      return yield* fail("invalid_request", "The head query parameter is required.");
    const decision = yield* asks.systemDraftDecision(
      { draftId, head, requestedBy },
      systemProvenance(requestedBy),
    );
    return json({ ok: true, decision });
  });
  // end ardud missions: asks (N5)

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
      const rawId = query.get("id")?.trim() ?? "";
      const id = rawId.length === 0 ? undefined : rawId;
      const about = id === undefined ? {} : { id };
      const afterRaw = query.get("after");
      if (afterRaw === null || afterRaw.trim() === "") {
        const interval = nonNegativeInt(query.get("interval"), 120);
        return json({
          ok: true,
          matches: [],
          latestSeq: desk.latestSeq,
          check: watchCheckCommand({ cli: MISSION_CLI, missionId, kinds, ...about }),
          add: watchAddCommand({
            cli: MISSION_CLI,
            missionId,
            kinds,
            ...about,
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
        matches: watchMatches(seen, kinds, id),
        // A cursor past the log (store reset) snaps back to the current seq.
        latestSeq: seen.at(-1)?.seq ?? Math.min(cursor, desk.latestSeq),
      });
    }),
  );

  // --- The owner's full view (his iMessage agent reads what the board shows him) ---

  const recordAt = (kind: "approval" | "call", id: string) =>
    store.get(kind, id).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new MissionError({ code: "not-found", detail: `No ${kind} ${id}.` })),
          onSome: (record) => Effect.succeed({ at: record.createdAt }),
        }),
      ),
    );

  // Needs you: the inbox the board counts plus answered requests he has not read.
  const needs = ownerRead(
    Effect.gen(function* () {
      const query = yield* searchParams;
      const missionId = missionParam(query.get("mission")) ?? null;
      const inbox = yield* missions.inbox(missionId);
      const answered =
        missionId === null
          ? yield* store.listAll("owner-request", ["answered"])
          : yield* store.listAllInMission("owner-request", missionId, ["answered"]);
      return json({
        ok: true,
        inbox,
        // ardud missions: router (a discussion counts on its record, not here)
        requests: answered.filter((request) => request.unreadForOwner && request.subject == null),
      });
    }),
  );

  const listApprovals = ownerRead(
    Effect.gen(function* () {
      const query = yield* searchParams;
      const missionId = yield* requireMission(query.get("mission"));
      const statuses = listParam(query.get("status"));
      if (statuses === undefined) {
        const all = yield* missions.approvals({ missionId });
        const shown = pendingAndRecent(all, RECENT_APPROVALS);
        return json({ ok: true, approvals: yield* attachComments(store, "approval", shown) });
      }
      const status = yield* decodeApprovalStatuses(statuses).pipe(
        Effect.mapError(() =>
          fail("invalid_request", "status must be pending, approved, rejected or stale-closed."),
        ),
      );
      const found = yield* missions.approvals({ missionId, status });
      return json({ ok: true, approvals: yield* attachComments(store, "approval", found) });
    }),
  );

  const listCalls = ownerRead(
    Effect.gen(function* () {
      const query = yield* searchParams;
      const missionId = yield* requireMission(query.get("mission"));
      return json({ ok: true, calls: yield* asks.calls(missionId) });
    }),
  );

  // A draft's full text and everything it links, so the agent can share it in the chat.
  const showDraft = ownerRead(
    Effect.gen(function* () {
      const draftId = yield* param("draftId");
      const found = yield* store.get("draft", draftId);
      if (Option.isNone(found)) return yield* fail("not_found", `No draft ${draftId}.`);
      const [draft] = yield* attachComments(store, "draft", [found.value]);
      return json({
        ok: true,
        draft,
        attachments: draftAttachments(found.value),
      });
    }),
  );

  const optionalParam = <A>(
    raw: string | null,
    decode: (input: unknown) => Effect.Effect<A, Schema.SchemaError>,
    message: string,
  ) =>
    raw === null || raw.trim() === ""
      ? Effect.succeed(undefined)
      : decode(raw.trim()).pipe(Effect.mapError(() => fail("invalid_request", message)));

  const work = ownerRead(
    Effect.gen(function* () {
      const query = yield* searchParams;
      const missionId = yield* requireMission(query.get("mission"));
      const laneId = yield* optionalParam(query.get("lane"), decodeLaneId, "lane is a lane id.");
      const stageList = listParam(query.get("stage"));
      const stages =
        stageList === undefined
          ? undefined
          : yield* decodeStages(stageList).pipe(
              Effect.mapError(() =>
                fail(
                  "invalid_request",
                  "stage must be ticket, pr, review, merge, deploy, readback, exercised or done.",
                ),
              ),
            );
      const limit = yield* optionalParam(
        query.get("limit"),
        (raw) => decodePositiveInt(Number(raw)),
        "limit is a positive number.",
      );
      const offset = nonNegativeInt(query.get("offset"), 0);
      const page = yield* missions.workItems({
        missionId,
        offset,
        ...(laneId === undefined ? {} : { laneId }),
        ...(stages === undefined ? {} : { stages }),
        ...(limit === undefined ? {} : { limit: Math.min(limit, 500) }),
      });
      return json({ ok: true, ...page });
    }),
  );

  const timeline = ownerRead(
    Effect.gen(function* () {
      const query = yield* searchParams;
      const missionId = yield* requireMission(query.get("mission"));
      const toPositive = (raw: unknown) => decodePositiveInt(Number(raw));
      const beforeSeq = yield* optionalParam(
        query.get("before"),
        toPositive,
        "before is an event seq.",
      );
      const limit = yield* optionalParam(
        query.get("limit"),
        toPositive,
        "limit is a positive number.",
      );
      const page = yield* missions.timeline({
        missionId,
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
        ...(limit === undefined ? {} : { limit }),
      });
      return json({ ok: true, ...page });
    }),
  );

  const progress = ownerRead(
    Effect.gen(function* () {
      const query = yield* searchParams;
      const missionId = yield* requireMission(query.get("mission"));
      const overview = yield* missions.overview(missionId);
      const items = yield* store.listAllInMission("work-item", missionId);
      return json({ ok: true, progress: progressOf(overview, items) });
    }),
  );

  const decideApproval = writeAs((caller) =>
    Effect.gen(function* () {
      const approvalId = ApprovalId.make(yield* param("approvalId"));
      const body = yield* decodeBody(decodeApprovalDecideBody);
      return json(
        yield* ledger.once(
          {
            caller,
            inboundId: body.inboundId,
            subject: `approval:${approvalId}`,
            action: "decide",
            payload: { action: body.action, note: body.note ?? null },
            what: "Deciding an approval",
            notBefore: () => recordAt("approval", approvalId),
          },
          (owner) =>
            Effect.gen(function* () {
              yield* missions.decideApproval(owner, {
                approvalId,
                action: body.action,
                inboundId: body.inboundId,
                ...(body.note === undefined ? {} : { note: body.note }),
              });
              const approval = yield* store.get("approval", approvalId);
              return { ok: true, approval: Option.getOrNull(approval) };
            }),
        ),
      );
    }),
  );

  const reactToCall = writeAs((caller) =>
    Effect.gen(function* () {
      const callId = CallId.make(yield* param("callId"));
      const body = yield* decodeBody(decodeCallReactBody);
      return json(
        yield* ledger.once(
          {
            caller,
            inboundId: body.inboundId,
            subject: `call:${callId}`,
            action: "react",
            payload: { reaction: body.reaction, note: body.note ?? null },
            what: "Reacting to a call",
            notBefore: () => recordAt("call", callId),
          },
          (owner) =>
            asks
              .reactToCall(
                {
                  callId,
                  reaction: body.reaction,
                  ...(body.note === undefined ? {} : { note: body.note }),
                },
                owner,
              )
              .pipe(Effect.map((call) => ({ ok: true, call }))),
        ),
      );
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
    HttpRouter.route("POST", `${p}/drafts/open`, handle(openSystemDraft)),
    HttpRouter.route("POST", `${p}/drafts/stale`, handle(closeStaleDraft)),
    HttpRouter.route("POST", `${p}/drafts/sent`, handle(reportDraftSent)),
    HttpRouter.route("GET", `${p}/drafts/:draftId/decision`, handle(draftDecision)),
    HttpRouter.route("GET", `${p}/events`, handle(events)),
    HttpRouter.route("GET", `${p}/watch`, handle(watch)),
    HttpRouter.route("GET", `${p}/needs`, handle(needs)),
    HttpRouter.route("GET", `${p}/approvals`, handle(listApprovals)),
    HttpRouter.route("POST", `${p}/approvals/:approvalId/decide`, handle(decideApproval)),
    HttpRouter.route("GET", `${p}/calls`, handle(listCalls)),
    HttpRouter.route("POST", `${p}/calls/:callId/react`, handle(reactToCall)),
    HttpRouter.route("GET", `${p}/drafts/:draftId`, handle(showDraft)),
    HttpRouter.route("GET", `${p}/work`, handle(work)),
    HttpRouter.route("GET", `${p}/timeline`, handle(timeline)),
    HttpRouter.route("GET", `${p}/progress`, handle(progress)),
  ] as const;
});

export const missionsDeskRouteLayer = HttpRouter.addAll(makeRoutes);
