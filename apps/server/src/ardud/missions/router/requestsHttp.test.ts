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

const fakeAuth = {
  authenticateHttpRequest: (request: HttpServerRequest.HttpServerRequest) =>
    request.headers.authorization === "Bearer control-token"
      ? Effect.succeed({
          sessionId: AuthSessionId.make("session-control"),
          subject: "control",
          method: "bearer-access-token" as const,
          scopes: ["orchestration:read" as const, "orchestration:operate" as const],
        })
      : Effect.fail(new EnvironmentAuth.ServerAuthInvalidCredentialError({ diagnostic: "none" })),
} as unknown as EnvironmentAuth.EnvironmentAuth["Service"];

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

type Handler = (request: Request) => Promise<Response>;

const harness = (inbound: ReadonlyArray<InboundMessage>) => {
  const threads = fakeRouterThreads();
  const lookup = Layer.succeed(
    Inbound.InboundLookup,
    Inbound.InboundLookup.of({
      find: (id) => Effect.succeed(inbound.find((message) => message.id === id) ?? null),
    }),
  );
  const layer = routerOverFakes(threads).pipe(
    Layer.provideMerge(MissionStore.layer),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(lookup),
  );
  return { threads, layer };
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
): InboundMessage => ({ id, chat, text, receivedAt });

describe("owner requests over iMessage", () => {
  it.live("opens and replies only with a verified inbound message that says the same thing", () => {
    const inbound: InboundMessage[] = [];
    const h = harness(inbound);
    return Effect.gen(function* () {
      yield* seed;
      // The bridge saw these just now: the owner's chat and Moni's.
      const now = yield* Clock.currentTimeMillis;
      inbound.push(
        said(now, "in-1", "How far is the API lane?"),
        said(now, "in-2", "Thanks. Also pick up the flaky test.", "moni"),
        said(now, "wake:1", "How far is the API lane?"),
      );
      yield* withDesk(async (handle) => {
        const refused = [
          // No inbound id at all.
          await call(handle, "POST", "/requests", { missionId, text: "How far is the API lane?" }),
          // An id nobody sent.
          await call(handle, "POST", "/requests", {
            missionId,
            text: "How far is the API lane?",
            inboundId: "in-404",
          }),
          // A real message, but not what he said.
          await call(handle, "POST", "/requests", {
            missionId,
            text: "Ship the API lane today.",
            inboundId: "in-1",
          }),
          // A synthetic id.
          await call(handle, "POST", "/requests", {
            missionId,
            text: "How far is the API lane?",
            inboundId: "wake:1",
          }),
          // No token.
          await call(
            handle,
            "POST",
            "/requests",
            { missionId, text: "How far is the API lane?", inboundId: "in-1" },
            "nope",
          ),
        ];
        expect(refused.map((each) => each.status)).toEqual([400, 403, 403, 403, 401]);

        const opened = await call(handle, "POST", "/requests", {
          missionId,
          text: "How far is the API lane?",
          inboundId: "in-1",
        });
        expect(opened.status).toBe(200);
        expect(opened.reply.request.createdBy).toEqual({
          _tag: "owner-imessage",
          chat: "owner",
          inboundId: "in-1",
        });
        // The bridge retrying the same message opens nothing new.
        const retried = await call(handle, "POST", "/requests", {
          missionId,
          text: "How far is the API lane?",
          inboundId: "in-1",
        });
        expect(retried.reply.request.id).toBe(opened.reply.request.id);

        const requestId = opened.reply.request.id as string;
        const mismatch = await call(handle, "POST", `/requests/${requestId}/reply`, {
          text: "Something else entirely.",
          inboundId: "in-2",
        });
        expect(mismatch.status).toBe(403);
        const replied = await call(handle, "POST", `/requests/${requestId}/reply`, {
          text: "Thanks. Also pick up the flaky test.",
          inboundId: "in-2",
        });
        expect(replied.status).toBe(200);
        expect(replied.reply.request.status).toBe("waiting-on-master");

        const listed = await call(handle, "GET", `/requests?mission=${missionId}`);
        expect(listed.status).toBe(200);
        expect(listed.reply.requests).toHaveLength(1);
        expect(listed.reply.requests[0].messages).toHaveLength(2);
      });
      const wakes = h.threads.sent.filter(
        (each) => each.threadId === masterThread && each.key.startsWith("mission-wake:"),
      );
      expect(wakes.length).toBeGreaterThanOrEqual(1);
      expect(wakes[0]!.text).toContain("How far is the API lane?");
    }).pipe(Effect.provide(h.layer));
  });
});
