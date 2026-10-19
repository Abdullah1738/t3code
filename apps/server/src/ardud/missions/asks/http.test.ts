import * as NodeServices from "@effect/platform-node/NodeServices";
import { ApprovalId, AuthSessionId, DraftId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { HttpServerRequest } from "effect/http";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";

import * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import * as MissionService from "../MissionService.ts";
import * as MissionStore from "../store/MissionStore.ts";
import * as AsksService from "./AsksService.ts";
import {
  agent,
  askInput,
  harness,
  masterThread,
  missionId,
  ownerApp,
  seed,
  typedInbound,
  writerThread,
} from "./AsksService.testkit.ts";
import { MISSIONS_DESK_PREFIX, missionsDeskRouteLayer, sinceMillis } from "./http.ts";
import type { InboundMessage } from "./provenance.ts";

const READ = ["orchestration:read" as const];
const OPERATE = ["orchestration:read" as const, "orchestration:operate" as const];
const SCOPES = {
  "Bearer read": READ,
  "Bearer operate": OPERATE,
  // Component credentials (`t3 ardud component-token issue <name>`).
  "Bearer crw-read": READ,
  "Bearer crw": OPERATE,
  "Bearer scribe": OPERATE,
  "Bearer imessage": OPERATE,
  "Bearer cli": OPERATE,
  "Bearer telegram": OPERATE,
};
const COMPONENT: Partial<Record<keyof typeof SCOPES, string>> = {
  "Bearer crw-read": "crw",
  "Bearer crw": "crw",
  "Bearer scribe": "scribe",
  "Bearer imessage": "spectrum-bridge",
  "Bearer cli": "mission-cli",
  "Bearer telegram": "telegram-bridge",
};

const fakeAuth = {
  authenticateHttpRequest: (request: HttpServerRequest.HttpServerRequest) => {
    const token = request.headers.authorization as keyof typeof SCOPES;
    const scopes = SCOPES[token];
    const component = COMPONENT[token];
    return scopes === undefined
      ? Effect.fail(new EnvironmentAuth.ServerAuthInvalidCredentialError({ diagnostic: "none" }))
      : Effect.succeed({
          sessionId: AuthSessionId.make("session-1"),
          subject: component === undefined ? "mission-cli" : `component:${component}`,
          method: "bearer-access-token" as const,
          scopes,
          ...(component === undefined ? {} : { origin: { _tag: "component" as const, component } }),
        });
  },
} as unknown as EnvironmentAuth.EnvironmentAuth["Service"];

// Live clock tests: an iMessage that arrives after the ask or draft opened.
const LATER = Date.parse("2999-01-01T00:00:00.000Z");

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const request = (path: string, token: keyof typeof SCOPES | null, body?: unknown): Request =>
  new Request(`http://127.0.0.1${MISSIONS_DESK_PREFIX}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(token === null ? {} : { authorization: token }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: encodeJson(body) }),
  });

type Handler = (request: Request) => Promise<Response>;

/** Serves the desk routes over the test's own AsksService instance. */
const withDesk = <A>(use: (handler: Handler) => Promise<A>) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<
      AsksService.AsksService | MissionService.MissionService | MissionStore.MissionStore
    >();
    const routes = missionsDeskRouteLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeedContext(context),
          Layer.succeed(EnvironmentAuth.EnvironmentAuth, fakeAuth),
        ),
      ),
      Layer.provideMerge(
        HttpPlatform.layer.pipe(
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(Etag.layerWeak),
        ),
      ),
      Layer.provide(NodeServices.layer),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
      ({ handler }) => Effect.tryPromise(() => use((input) => handler(input))),
      ({ dispose }) => Effect.promise(dispose),
    );
  });

const body = async (response: Response) => (await response.json()) as Record<string, any>;

describe("missions desk HTTP", () => {
  it.live("answers only with an iMessage the bridge or mission CLI redeems, once", () => {
    const inbox: Array<InboundMessage> = [];
    const { deliveries, layer } = harness(inbox);
    return Effect.gen(function* () {
      yield* seed;
      const asks = yield* AsksService.AsksService;
      const ask = yield* asks.openAsk(askInput("Which way?"), agent(masterThread));
      // His words, as he typed them: no handle and no option grammar.
      inbox.push(typedInbound("spc-msg-1", "lets go with the first one", LATER));
      const answer = (token: keyof typeof SCOPES, extra: Record<string, unknown>) =>
        request(`/asks/${ask.id}/answer`, token, { optionId: "a", ...extra });

      const result = yield* withDesk(async (handle) => {
        const anonymous = await handle(request(`/status?mission=${missionId}`, null));
        const status = await body(
          await handle(request(`/status?mission=${missionId}`, "Bearer read")),
        );
        const readOnly = await handle(answer("Bearer read", { inboundId: "spc-msg-1" }));
        const noInbound = await handle(answer("Bearer cli", {}));
        const forged = await body(await handle(answer("Bearer cli", { inboundId: "wake:x" })));
        // Sol r4 Q1: other credentials never lift a genuine typed message.
        const telegram = await body(
          await handle(answer("Bearer telegram", { inboundId: "spc-msg-1" })),
        );
        const control = await body(
          await handle(answer("Bearer operate", { inboundId: "spc-msg-1" })),
        );
        const answered = await body(await handle(answer("Bearer cli", { inboundId: "spc-msg-1" })));
        const replay = await body(
          await handle(answer("Bearer imessage", { inboundId: "spc-msg-1" })),
        );
        const otherOption = await body(
          await handle(answer("Bearer cli", { optionId: "b", inboundId: "spc-msg-1" })),
        );
        const missing = await handle(request("/asks/ask-none", "Bearer read"));
        return {
          anonymous,
          status,
          readOnly,
          noInbound,
          forged,
          telegram,
          control,
          answered,
          replay,
          otherOption,
          missing,
        };
      });

      expect(result.anonymous.status).toBe(401);
      expect(result.status.ok).toBe(true);
      expect(result.status.desk.openAsks.map((open: { id: string }) => open.id)).toEqual([ask.id]);
      expect(result.readOnly.status).toBe(403);
      expect(result.noInbound.status).toBe(400);
      expect(result.forged).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(result.telegram).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(result.control).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(result.answered.ok).toBe(true);
      expect(result.answered.ask.answer.provenance).toEqual({
        _tag: "owner-imessage",
        chat: "owner",
        inboundId: "spc-msg-1",
        quote: "lets go with the first one",
      });
      expect(result.answered.released.map((ref: { id: string }) => ref.id)).toEqual([
        "wi-held",
        "lane-api",
      ]);
      expect(result.replay).toEqual(result.answered);
      expect(result.otherOption).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(result.missing.status).toBe(404);
      expect(deliveries.filter((delivery) => delivery.threadId === masterThread).length).toBe(1);
    }).pipe(Effect.provide(layer));
  });

  it.live("decides drafts only with the owner's redeemed iMessage", () => {
    const inbox: Array<InboundMessage> = [];
    const { layer } = harness(inbox);
    return Effect.gen(function* () {
      yield* seed;
      const asks = yield* AsksService.AsksService;
      const draft = yield* asks.submitDraft(
        {
          missionId,
          audience: "Sara",
          channel: "linear",
          target: { kind: "ticket", label: "API-1", url: null, ref: "API-1" },
          text: "Fixed in the latest deploy.",
        },
        agent(writerThread),
      );
      inbox.push(typedInbound("spc-msg-5", "the sara one is fine", LATER, "moni"));
      const result = yield* withDesk(async (handle) => {
        const pending = await body(await handle(request("/drafts?status=pending", "Bearer read")));
        const noInbound = await handle(
          request(`/drafts/${draft.id}/decide`, "Bearer cli", { action: "approve" }),
        );
        const telegram = await body(
          await handle(
            request(`/drafts/${draft.id}/decide`, "Bearer telegram", {
              action: "approve",
              inboundId: "spc-msg-5",
            }),
          ),
        );
        const approved = await body(
          await handle(
            request(`/drafts/${draft.id}/decide`, "Bearer imessage", {
              action: "approve",
              inboundId: "spc-msg-5",
            }),
          ),
        );
        return { pending, noInbound, telegram, approved };
      });
      expect(result.pending.drafts.map((open: { id: string }) => open.id)).toEqual([draft.id]);
      expect(result.noInbound.status).toBe(400);
      expect(result.telegram).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(result.approved.draft.status).toBe("approved");
      expect(result.approved.draft.decidedBy).toMatchObject({
        _tag: "owner-imessage",
        chat: "moni",
        quote: "the sara one is fine",
      });
    }).pipe(Effect.provide(layer));
  });

  it.live("gives his iMessage agent the owner's full view and his approvals and calls", () => {
    const inbox: Array<InboundMessage> = [];
    const { layer } = harness(inbox);
    return Effect.gen(function* () {
      yield* seed;
      const asks = yield* AsksService.AsksService;
      const missions = yield* MissionService.MissionService;
      const approvalId = ApprovalId.make("approval-merge-8");
      yield* missions.openApproval(
        { _tag: "system", component: "crw" },
        {
          missionId,
          approvalId,
          kind: "merge",
          title: "Good to merge: acme/api#8",
          detail: "Decide in the review thread.",
          requestedBy: "crw",
          links: [],
        },
      );
      const call = yield* asks.makeCall(
        {
          missionId,
          title: "Postgres over SQLite",
          decision: "Use Postgres for the ledger.",
          reason: "Concurrent writers.",
        },
        agent(masterThread),
      );
      const draft = yield* asks.submitDraft(
        {
          missionId,
          audience: "Sara",
          channel: "linear",
          target: { kind: "file", label: "Mobile designs", url: null, ref: "designs/mobile.png" },
          text: "New mobile designs attached.",
        },
        agent(writerThread),
      );
      inbox.push(typedInbound("spc-msg-7", "approve both of those", LATER));

      const result = yield* withDesk(async (handle) => {
        const get = async (path: string, token: keyof typeof SCOPES = "Bearer cli") =>
          body(await handle(request(path, token)));
        const view = {
          needs: await get(`/needs?mission=${missionId}`),
          approvals: await get(`/approvals?mission=${missionId}`),
          calls: await get(`/calls?mission=${missionId}`),
          draft: await get(`/drafts/${draft.id}`, "Bearer imessage"),
          work: await get(`/work?mission=${missionId}&stage=ticket,pr&limit=1`),
          timeline: await get(`/timeline?mission=${missionId}&limit=2`),
          progress: await get(`/progress?mission=${missionId}`),
          badStage: await get(`/work?mission=${missionId}&stage=shipped`),
        };
        // Other tokens keep the narrower reads.
        const narrow = {
          telegram: await get(`/needs?mission=${missionId}`, "Bearer telegram"),
          control: await get(`/drafts/${draft.id}`, "Bearer read"),
          crw: await get(`/progress?mission=${missionId}`, "Bearer crw-read"),
        };
        const decide = (token: keyof typeof SCOPES, inboundId: string) =>
          handle(
            request(`/approvals/${approvalId}/decide`, token, {
              action: "approve",
              inboundId,
            }),
          );
        const react = (token: keyof typeof SCOPES, reaction: string) =>
          handle(request(`/calls/${call.id}/react`, token, { reaction, inboundId: "spc-msg-7" }));
        const actions = {
          telegram: await body(await decide("Bearer telegram", "spc-msg-7")),
          noInbound: await handle(
            request(`/approvals/${approvalId}/decide`, "Bearer cli", {
              action: "approve",
            }),
          ),
          approved: await body(await decide("Bearer cli", "spc-msg-7")),
          replay: await body(await decide("Bearer imessage", "spc-msg-7")),
          // One message, two records: "approve both".
          reacted: await body(await react("Bearer cli", "ok")),
          reactedAgain: await body(await react("Bearer cli", "ok")),
          changed: await body(await react("Bearer cli", "discuss")),
        };
        return { view, narrow, actions };
      });

      const { view, narrow, actions } = result;
      expect(view.needs.ok).toBe(true);
      expect(view.needs.inbox.approvals.map((a: { id: string }) => a.id)).toContain(approvalId);
      expect(view.approvals.approvals.map((a: { id: string }) => a.id)).toEqual([approvalId]);
      expect(view.calls.calls.map((c: { id: string }) => c.id)).toEqual([call.id]);
      expect(view.draft.draft.text).toBe("New mobile designs attached.");
      expect(view.draft.attachments).toEqual([
        {
          kind: "file",
          label: "Mobile designs",
          url: null,
          path: "designs/mobile.png",
          from: "target",
        },
      ]);
      expect(view.work.items).toHaveLength(1);
      expect(view.work.total).toBe(2);
      expect(view.work.hasMore).toBe(true);
      expect(view.timeline.entries.length).toBeGreaterThan(0);
      expect(view.progress.progress.items.total).toBe(2);
      expect(view.progress.progress.items.done).toBe(0);
      expect(view.badStage).toMatchObject({ ok: false, error: { code: "invalid_request" } });
      expect(narrow.telegram).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(narrow.control).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(narrow.crw).toMatchObject({ ok: false, error: { code: "forbidden" } });

      expect(actions.telegram).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(actions.noInbound.status).toBe(400);
      expect(actions.approved.approval.status).toBe("approved");
      expect(actions.approved.approval.decidedBy).toEqual({
        _tag: "owner-imessage",
        chat: "owner",
        inboundId: "spc-msg-7",
        quote: "approve both of those",
      });
      expect(actions.replay).toEqual(actions.approved);
      expect(actions.reacted.call.ownerReaction).toBe("ok");
      expect(actions.reactedAgain).toEqual(actions.reacted);
      expect(actions.changed).toMatchObject({ ok: false, error: { code: "conflict" } });
    }).pipe(Effect.provide(layer));
  });

  it.live("lets crw open a draft per head and read only that head's decision", () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      const asks = yield* AsksService.AsksService;
      const open = (head: string, draftId: string) => ({
        missionId,
        draftId,
        requestedBy: "crw",
        audience: "PR author",
        channel: "github",
        target: { kind: "pull-request", label: "crpko/api#7", url: null, ref: "crpko/api#7" },
        head,
        text: "Feedback required: the retry loop never backs off.",
        flags: ["core change"],
      });
      const result = yield* withDesk(async (handle) => {
        const readOnly = await handle(
          request("/drafts/open", "Bearer crw-read", open("aaa111", "crw-1")),
        );
        const stranger = await handle(
          request("/drafts/open", "Bearer crw", {
            ...open("aaa111", "crw-1"),
            requestedBy: "bot",
          }),
        );
        // N5: naming crw in the body is not crw's credential.
        const controlToken = await handle(
          request("/drafts/open", "Bearer operate", open("aaa111", "crw-1")),
        );
        const otherComponent = await handle(
          request("/drafts/open", "Bearer scribe", open("aaa111", "crw-1")),
        );
        const opened = await body(
          await handle(request("/drafts/open", "Bearer crw", open("aaa111", "crw-1"))),
        );
        const noHead = await handle(
          request("/drafts/crw-1/decision?requestedBy=crw", "Bearer crw-read"),
        );
        const controlRead = await handle(
          request("/drafts/crw-1/decision?head=aaa111&requestedBy=crw", "Bearer read"),
        );
        // Identity headers count for nothing, so they are refused even when they agree.
        const named = request("/drafts/crw-1/decision?head=aaa111", "Bearer crw-read");
        named.headers.set("x-t3-component", "crw");
        const namedHeader = await handle(named);
        const role = request("/drafts/crw-1/decision?head=aaa111", "Bearer crw-read");
        role.headers.set("x-t3-role-id", "role-master");
        const roleHeader = await handle(role);
        const waiting = await body(
          await handle(request("/drafts/crw-1/decision?head=aaa111", "Bearer crw-read")),
        );
        return {
          readOnly,
          stranger,
          controlToken,
          otherComponent,
          opened,
          noHead,
          controlRead,
          namedHeader,
          roleHeader,
          waiting,
        };
      });
      expect(result.namedHeader.status).toBe(403);
      expect(result.roleHeader.status).toBe(400);
      expect(result.readOnly.status).toBe(403);
      expect(result.stranger.status).toBe(403);
      expect(result.controlToken.status).toBe(403);
      expect(result.otherComponent.status).toBe(403);
      expect(result.controlRead.status).toBe(403);
      expect(result.opened.draft).toMatchObject({
        requestedBy: "crw",
        head: "aaa111",
        flags: ["core change"],
      });
      expect(result.noHead.status).toBe(400);
      expect(result.waiting.decision.state).toBe("pending");

      yield* asks.decideDraft(
        {
          draftId: result.opened.draft.id,
          action: "approve",
          editedText: "Please add a backoff.",
          revision: 0,
        },
        ownerApp,
      );
      const after = yield* withDesk(async (handle) => {
        const decided = await body(
          await handle(
            request("/drafts/crw-1/decision?head=aaa111&requestedBy=crw", "Bearer crw-read"),
          ),
        );
        const otherHead = await body(
          await handle(
            request("/drafts/crw-1/decision?head=bbb222&requestedBy=crw", "Bearer crw-read"),
          ),
        );
        const controlStale = await handle(
          request("/drafts/stale", "Bearer operate", {
            draftId: "crw-1",
            requestedBy: "crw",
            reason: "head moved",
          }),
        );
        const stale = await handle(
          request("/drafts/stale", "Bearer crw", {
            draftId: "crw-1",
            requestedBy: "crw",
            reason: "head moved",
          }),
        );
        return { decided, otherHead, controlStale, stale };
      });
      expect(after.controlStale.status).toBe(403);
      expect(after.decided.decision).toMatchObject({
        state: "approved",
        text: "Please add a backoff.",
        edited: true,
      });
      expect(after.otherHead.decision.state).toBe("stale");
      expect(after.stale.status).toBe(409);
    }).pipe(Effect.provide(layer));
  });

  it.live("takes crw's send report only for an approved draft at the revision it read", () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      const asks = yield* AsksService.AsksService;
      const target = { kind: "pull-request", label: "crpko/api#8", url: null, ref: "crpko/api#8" };
      const comment = (n: number) => ({
        kind: "url",
        label: `comment ${n}`,
        url: `https://github.com/crpko/api/pull/8#issuecomment-${n}`,
        ref: null,
      });
      const report = (
        revision: number,
        outcome: Record<string, unknown>,
        extra = {},
        token: keyof typeof SCOPES = "Bearer crw",
      ) =>
        request("/drafts/sent", token, {
          draftId: "crw-8",
          requestedBy: "crw",
          revision,
          outcome,
          ...extra,
        });
      const early = yield* withDesk(async (handle) => {
        await handle(
          request("/drafts/open", "Bearer crw", {
            missionId,
            draftId: "crw-8",
            requestedBy: "crw",
            audience: "PR author",
            channel: "github",
            target,
            head: "ccc333",
            text: "Feedback required: add a test.",
          }),
        );
        return {
          pending: await handle(report(0, { _tag: "sent", link: comment(1) })),
        };
      });
      expect(early.pending.status).toBe(409);

      // The owner reopens once, so the approval is at revision 1.
      const first = yield* asks.decideDraft(
        { draftId: DraftId.make("crw-8"), action: "drop" },
        ownerApp,
      );
      yield* asks.reopenDraft({ draftId: first.draft.id }, ownerApp);
      yield* asks.decideDraft(
        { draftId: first.draft.id, action: "approve", revision: 1 },
        ownerApp,
      );

      const result = yield* withDesk(async (handle) => {
        const readOnly = await handle(
          request("/drafts/sent", "Bearer crw-read", {
            draftId: "crw-8",
            requestedBy: "crw",
            revision: 1,
            outcome: { _tag: "sent", link: comment(1) },
          }),
        );
        const stranger = await handle(
          report(1, { _tag: "sent", link: comment(1) }, { requestedBy: "bot" }),
        );
        const controlToken = await handle(
          report(1, { _tag: "sent", link: comment(1) }, {}, "Bearer operate"),
        );
        const oldRevision = await handle(report(0, { _tag: "sent", link: comment(1) }));
        const failed = await body(await handle(report(1, { _tag: "send-failed", reason: "403" })));
        const failedAgain = await body(
          await handle(report(1, { _tag: "send-failed", reason: "403" })),
        );
        const decision = await body(
          await handle(
            request("/drafts/crw-8/decision?head=ccc333&requestedBy=crw", "Bearer crw-read"),
          ),
        );
        const sent = await body(await handle(report(1, { _tag: "sent", link: comment(1) })));
        const sentAgain = await body(await handle(report(1, { _tag: "sent", link: comment(1) })));
        const otherLink = await handle(report(1, { _tag: "sent", link: comment(2) }));
        const failAfter = await handle(report(1, { _tag: "send-failed", reason: "late" }));
        const afterSent = await body(
          await handle(
            request("/drafts/crw-8/decision?head=ccc333&requestedBy=crw", "Bearer crw-read"),
          ),
        );
        return {
          readOnly,
          stranger,
          controlToken,
          oldRevision,
          failed,
          failedAgain,
          decision,
          sent,
          sentAgain,
          otherLink,
          failAfter,
          afterSent,
        };
      });
      expect(result.readOnly.status).toBe(403);
      expect(result.stranger.status).toBe(403);
      expect(result.controlToken.status).toBe(403);
      expect(result.oldRevision.status).toBe(409);
      expect(result.failed.draft).toMatchObject({ status: "send-failed", sendError: "403" });
      expect(result.failedAgain.draft).toMatchObject({ status: "send-failed", sendError: "403" });
      expect(result.decision.decision).toMatchObject({
        state: "approved",
        revision: 1,
        delivery: "send-failed",
      });
      expect(result.sent.draft).toMatchObject({
        status: "sent",
        sentLink: comment(1),
        sendError: null,
      });
      expect(result.sent.draft.sentAt).not.toBeNull();
      expect(result.sentAgain.draft.sentAt).toBe(result.sent.draft.sentAt);
      expect(result.otherLink.status).toBe(409);
      expect(result.failAfter.status).toBe(409);
      expect(result.afterSent.decision).toMatchObject({ state: "approved", delivery: "sent" });

      // One event per real change: failed once, sent once.
      const store = yield* MissionStore.MissionStore;
      const kinds = (yield* store.recentEvents(missionId, 50))
        .filter((event) => event.subject?.id === "crw-8")
        .map((event) => event.kind);
      expect(kinds.filter((kind) => kind === "draft.sent")).toHaveLength(1);
      expect(kinds.filter((kind) => kind === "draft.send-failed")).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.live("watch returns matches after a cursor and starts new watchers at now", () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      const store = yield* MissionStore.MissionStore;
      const before = yield* store.latestSeq(missionId);
      const asks = yield* AsksService.AsksService;
      const ask = yield* asks.openAsk(askInput("Which way?"), agent(masterThread));
      const result = yield* withDesk(async (handle) => {
        const fresh = await body(
          await handle(request(`/watch?mission=${missionId}&on=ask-opened`, "Bearer read")),
        );
        const since = await body(
          await handle(
            request(
              `/watch?mission=${missionId}&on=ask-opened,lane-stalled&after=${before}`,
              "Bearer read",
            ),
          ),
        );
        const quiet = await body(
          await handle(
            request(`/watch?mission=${missionId}&on=ask-answered&after=${before}`, "Bearer read"),
          ),
        );
        const unknown = await handle(
          request(`/watch?mission=${missionId}&on=ask-opened,bogus&after=0`, "Bearer read"),
        );
        const digest = await body(
          await handle(request(`/digest?mission=${missionId}&since=1h`, "Bearer read")),
        );
        const badSince = await handle(
          request(`/digest?mission=${missionId}&since=yesterday-ish`, "Bearer read"),
        );
        return { fresh, since, quiet, unknown, digest, badSince };
      });
      expect(result.fresh.matches).toEqual([]);
      expect(result.fresh.check).toBe(
        `mission watch-check 'm-1' --on ask-opened --cursor "$WATCH_DIR/mission-cursor"`,
      );
      expect(result.fresh.add).toContain("robob-watch add --id 'mission-m-1-ask-opened'");
      expect(result.fresh.latestSeq).toBeGreaterThan(before);
      expect(
        result.since.matches.map((event: { subject: { id: string } }) => event.subject.id),
      ).toEqual([ask.id]);
      expect(result.since.latestSeq).toBe(result.fresh.latestSeq);
      expect(result.quiet.matches).toEqual([]);
      expect(result.quiet.latestSeq).toBe(result.fresh.latestSeq);
      expect(result.unknown.status).toBe(400);
      expect(
        result.digest.events.some((event: { kind: string }) => event.kind === "ask.opened"),
      ).toBe(true);
      expect(result.badSince.status).toBe(400);
    }).pipe(Effect.provide(layer));
  });

  it("reads relative since values", () => {
    const now = Date.parse("2026-10-17T08:00:00.000Z");
    expect(sinceMillis("30m", now)).toBe(now - 30 * 60_000);
    expect(sinceMillis("6h", now)).toBe(now - 6 * 3_600_000);
    expect(sinceMillis("2026-10-17T07:00:00.000Z", now)).toBe(now - 3_600_000);
    expect(sinceMillis("soon", now)).toBeUndefined();
  });
});
