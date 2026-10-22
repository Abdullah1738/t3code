import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthSessionId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { HttpServerRequest } from "effect/http";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";

import * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import { laneThread, masterThread, seed, strayThread } from "../asks/AsksService.testkit.ts";
import * as MissionStore from "../store/MissionStore.ts";
import { leadRoutedRouteLayer } from "./leadRoutedHttp.ts";
import * as MissionRouter from "./MissionRouter.ts";
import { fakeRouterThreads, routerOverFakes } from "./MissionRouter.testkit.ts";

const SCOPES: Record<string, ReadonlyArray<"orchestration:read">> = {
  "Bearer control-token": ["orchestration:read"],
  "Bearer scopeless-token": [],
};

const fakeAuth = {
  authenticateHttpRequest: (request: HttpServerRequest.HttpServerRequest) => {
    const scopes = SCOPES[request.headers.authorization ?? ""];
    return scopes === undefined
      ? Effect.fail(new EnvironmentAuth.ServerAuthInvalidCredentialError({ diagnostic: "none" }))
      : Effect.succeed({
          sessionId: AuthSessionId.make("session-control"),
          subject: "control",
          method: "bearer-access-token" as const,
          scopes,
        });
  },
} as unknown as EnvironmentAuth.EnvironmentAuth["Service"];

const reviewChild = ThreadId.make("t-sol-review");

const harness = () => {
  const threads = fakeRouterThreads();
  // The lane delegated a review: the lane is its parent and its recorded creator.
  threads.parents.set(reviewChild, laneThread);
  threads.creators.set(reviewChild, { _tag: "thread", threadId: laneThread, title: "Lane" });
  return {
    threads,
    layer: routerOverFakes(threads).pipe(
      Layer.provideMerge(MissionStore.layer),
      Layer.provideMerge(Sqlite.layerMemory),
    ),
  };
};

const read = (threadId: string | null, token = "control-token") =>
  Effect.gen(function* () {
    const context = yield* Effect.context<MissionRouter.MissionRouter>();
    const routes = leadRoutedRouteLayer.pipe(
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
    const query = threadId === null ? "" : `?threadId=${encodeURIComponent(threadId)}`;
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
      ({ handler }) =>
        Effect.promise(async () => {
          const response = await handler(
            new Request(`http://127.0.0.1/api/ardud/missions/lead-routed${query}`, {
              headers: { authorization: `Bearer ${token}` },
            }),
          );
          return { status: response.status, body: (await response.json()) as Record<string, any> };
        }),
      ({ dispose }) => Effect.promise(dispose),
    );
  });

describe("lead-routed read (r22)", () => {
  it.effect("says which threads' requests go to a lead", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      expect(yield* read(reviewChild)).toEqual({ status: 200, body: { ok: true, routed: true } });
      expect((yield* read(laneThread)).body.routed).toBe(true);
      expect((yield* read(masterThread)).body.routed).toBe(false);
      expect((yield* read(strayThread)).body.routed).toBe(false);
      expect((yield* read(null)).status).toBe(400);
      expect((yield* read(reviewChild, "wrong-token")).status).toBe(401);
      expect((yield* read(reviewChild, "scopeless-token")).status).toBe(403);
      // A thread store that can't answer is a 500, which the bridge reads as "not routed".
      h.threads.unreadable.add(reviewChild);
      expect((yield* read(reviewChild)).status).toBe(500);
    }).pipe(Effect.provide(h.layer));
  });
});
