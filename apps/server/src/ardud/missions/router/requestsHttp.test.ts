import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthSessionId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { HttpServerRequest } from "effect/http";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";

import * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import { masterThread, missionId, seed } from "../asks/AsksService.testkit.ts";
import * as Inbound from "../asks/inbound.ts";
import type { InboundMessage } from "../asks/provenance.ts";
import * as MissionStore from "../store/MissionStore.ts";
import * as MissionRouter from "./MissionRouter.ts";
import { fakeRouterThreads, routerOverFakes } from "./MissionRouter.testkit.ts";
import { requestsRoutes } from "./requestsHttp.ts";

const SCOPES = ["orchestration:read" as const, "orchestration:operate" as const];

/** Tokens by who they were minted for; the origin is what the desk trusts. */
const SESSIONS: Record<string, object> = {
  "Bearer control-token": { sessionId: "session-control", subject: "control" },
  "Bearer bridge-token": {
    sessionId: "session-bridge",
    subject: "bridge",
    origin: { _tag: "component", component: "spectrum-bridge" },
  },
  "Bearer owner-token": {
    sessionId: "session-owner",
    subject: "owner",
    origin: { _tag: "owner", source: "desktop" },
  },
  "Bearer cli-token": {
    sessionId: "session-cli",
    subject: "cli",
    origin: { _tag: "component", component: "mission-cli" },
  },
  "Bearer telegram-token": {
    sessionId: "session-telegram",
    subject: "telegram",
    origin: { _tag: "component", component: "telegram-bridge" },
  },
  "Bearer crw-token": {
    sessionId: "session-crw",
    subject: "crw",
    origin: { _tag: "component", component: "crw" },
  },
};

const fakeAuth = {
  authenticateHttpRequest: (request: HttpServerRequest.HttpServerRequest) => {
    const session = SESSIONS[request.headers.authorization ?? ""];
    return session === undefined
      ? Effect.fail(new EnvironmentAuth.ServerAuthInvalidCredentialError({ diagnostic: "none" }))
      : Effect.succeed({
          ...session,
          sessionId: AuthSessionId.make((session as { sessionId: string }).sessionId),
          method: "bearer-access-token" as const,
          scopes: SCOPES,
        });
  },
} as unknown as EnvironmentAuth.EnvironmentAuth["Service"];

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

type Handler = (request: Request) => Promise<Response>;

const harness = (inbound: ReadonlyArray<InboundMessage>) => {
  const threads = fakeRouterThreads();
  /** Every inbound id the desk looked up. */
  const lookedUp: string[] = [];
  const lookup = Layer.succeed(
    Inbound.InboundLookup,
    Inbound.InboundLookup.of({
      find: (id) => {
        lookedUp.push(id);
        return Effect.succeed(inbound.find((message) => message.id === id) ?? null);
      },
    }),
  );
  const layer = routerOverFakes(threads).pipe(
    Layer.provideMerge(MissionStore.layer),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(lookup),
  );
  return { threads, layer, lookedUp };
};

const withDesk = <A>(use: (handler: Handler) => Promise<A>) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<
      MissionRouter.MissionRouter | MissionStore.MissionStore | Inbound.InboundLookup
    >();
    const routes = requestsRoutes.pipe(
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

const call = async (
  handle: Handler,
  method: string,
  path: string,
  body?: unknown,
  token = "control-token",
) => {
  const response = await handle(
    new Request(`http://127.0.0.1/api/ardud/missions/desk${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: encodeJson(body) }),
    }),
  );
  return { status: response.status, reply: (await response.json()) as Record<string, any> };
};

const said = (
  receivedAt: number,
  id: string,
  text: string,
  chat: InboundMessage["chat"] = "owner",
): InboundMessage => ({ id, chat, text, receivedAt, typed: true });

const ask = "How far is the API lane?";

describe("owner requests over iMessage", () => {
  it.live(
    "opens, replies and settles only with an inbound the bridge or mission CLI redeems",
    () => {
      const inbound: InboundMessage[] = [];
      const h = harness(inbound);
      return Effect.gen(function* () {
        yield* seed;
        // The bridge saw these just now: the owner's chat and Moni's.
        const now = yield* Clock.currentTimeMillis;
        inbound.push(
          said(now - 1000, "in-1", "how far is the api lane"),
          said(now, "in-2", "Thanks. Also pick up the flaky test.", "moni"),
          said(now, "in-3", "ok thats done, close it"),
          said(now, "wake:1", ask),
        );
        yield* withDesk(async (handle) => {
          const refused = [
            // No inbound id at all.
            await call(handle, "POST", "/requests", { missionId, text: ask }, "cli-token"),
            // An id nobody sent, or one the bridge minted.
            await call(
              handle,
              "POST",
              "/requests",
              { missionId, text: ask, inboundId: "in-404" },
              "cli-token",
            ),
            await call(
              handle,
              "POST",
              "/requests",
              { missionId, text: ask, inboundId: "wake:1" },
              "cli-token",
            ),
            // No token.
            await call(
              handle,
              "POST",
              "/requests",
              { missionId, text: ask, inboundId: "in-1" },
              "nope",
            ),
          ];
          expect(refused.map((each) => each.status)).toEqual([400, 403, 403, 401]);

          const opened = await call(
            handle,
            "POST",
            "/requests",
            { missionId, text: ask, inboundId: "in-1" },
            "cli-token",
          );
          expect(opened.status).toBe(200);
          // What the agent passed is its reading; his own words ride along as the quote.
          expect(opened.reply.request.createdBy).toEqual({
            _tag: "owner-imessage",
            chat: "owner",
            inboundId: "in-1",
            quote: "how far is the api lane",
          });
          // A retry of the same write, from either credential, opens nothing new.
          const retried = await call(
            handle,
            "POST",
            "/requests",
            { missionId, text: ask, inboundId: "in-1" },
            "bridge-token",
          );
          expect(retried.reply).toEqual(opened.reply);
          // The same message cannot open a second, different request.
          const other = await call(
            handle,
            "POST",
            "/requests",
            { missionId, text: "Ship the API lane today.", inboundId: "in-1" },
            "cli-token",
          );
          expect(other.status).toBe(409);

          const requestId = opened.reply.request.id as string;
          const replied = await call(
            handle,
            "POST",
            `/requests/${requestId}/reply`,
            { text: "Thanks. Also pick up the flaky test.", inboundId: "in-2" },
            "cli-token",
          );
          expect(replied.status).toBe(200);
          expect(replied.reply.request.status).toBe("waiting-on-master");

          // The bridge, the mission CLI and an owner session read the conversation.
          for (const token of ["bridge-token", "cli-token", "owner-token"]) {
            const listed = await call(
              handle,
              "GET",
              `/requests?mission=${missionId}&request=${requestId}`,
              undefined,
              token,
            );
            expect(listed.status).toBe(200);
            expect(listed.reply.requests[0].messages.map((each: any) => each.body)).toEqual([
              ask,
              "Thanks. Also pick up the flaky test.",
            ]);
          }
          // Any other read token sees that requests exist, not what they say.
          for (const token of ["control-token", "telegram-token"]) {
            const bare = await call(
              handle,
              "GET",
              `/requests?mission=${missionId}&request=${requestId}`,
              undefined,
              token,
            );
            expect(bare.status).toBe(200);
            expect(bare.reply.requests[0].messages).toEqual([]);
            expect(JSON.stringify(bare.reply)).not.toContain("flaky test");
          }
          // His requests about no record, discussions, one record's discussions.
          const filtered = async (query: string) => {
            const listed = await call(
              handle,
              "GET",
              `/requests?mission=${missionId}&${query}`,
              undefined,
              "cli-token",
            );
            return listed.status === 200
              ? listed.reply.requests.map((each: any) => each.request.id)
              : listed.status;
          };
          expect(await filtered("discussions=false")).toEqual([requestId]);
          expect(await filtered("discussions=true")).toEqual([]);
          expect(await filtered("about=work-item:wi-free")).toEqual([]);
          expect(await filtered("unread=true")).toEqual([]);
          expect(await filtered("discussions=maybe")).toBe(400);
          expect(await filtered("about=wi-free")).toBe(400);

          // He settles it from iMessage; a retry replays and he can reopen it later.
          const settled = await call(
            handle,
            "POST",
            `/requests/${requestId}/settle`,
            { inboundId: "in-3" },
            "cli-token",
          );
          expect(settled.status).toBe(200);
          expect(settled.reply.request.status).toBe("settled");
          const again = await call(
            handle,
            "POST",
            `/requests/${requestId}/settle`,
            { inboundId: "in-3" },
            "bridge-token",
          );
          expect(again.reply).toEqual(settled.reply);
          // Typed before the settle, so it cannot be what reopens it.
          const early = await call(
            handle,
            "POST",
            `/requests/${requestId}/reopen`,
            { inboundId: "in-1" },
            "cli-token",
          );
          expect(early.status).toBe(403);
        });
        const wakes = h.threads.sent.filter(
          (each) => each.threadId === masterThread && each.key.startsWith("mission-wake:"),
        );
        expect(wakes.length).toBeGreaterThanOrEqual(1);
        expect(wakes[0]!.text).toContain(ask);
      }).pipe(Effect.provide(h.layer));
    },
  );

  // Sol boundary 4, Q1: a Telegram session opened a request with a real typed
  // inbound and was recorded as the owner. Now no credential but the iMessage
  // bridge's and the mission CLI's redeems an inbound, and it is refused
  // before anything is looked up or written.
  it.live("refuses every other credential before it looks the inbound up", () => {
    const inbound: InboundMessage[] = [];
    const h = harness(inbound);
    return Effect.gen(function* () {
      yield* seed;
      const now = yield* Clock.currentTimeMillis;
      inbound.push(said(now, "in-1", ask));
      yield* withDesk(async (handle) => {
        for (const token of ["telegram-token", "crw-token", "control-token", "owner-token"]) {
          const opened = await call(
            handle,
            "POST",
            "/requests",
            { missionId, text: ask, inboundId: "in-1" },
            token,
          );
          expect(opened.status, token).toBe(403);
          expect(opened.reply.error.code, token).toBe("forbidden");
        }
        expect(h.lookedUp).toEqual([]);
        const listed = await call(
          handle,
          "GET",
          `/requests?mission=${missionId}`,
          undefined,
          "owner-token",
        );
        expect(listed.reply.requests).toEqual([]);
      });
      expect(h.threads.sent.filter((each) => each.threadId === masterThread)).toEqual([]);
    }).pipe(Effect.provide(h.layer));
  });
});
