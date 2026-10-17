import {
  AuthSessionId,
  MissionId,
  type AuthEnvironmentScope,
  type MissionProvenance,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import { MISSIONS_ROUTE_PREFIX, missionsRouteLayer } from "./http.ts";
import * as MissionService from "./MissionService.ts";
import * as MissionStore from "./store/MissionStore.ts";

const TOKENS: Record<string, ReadonlyArray<AuthEnvironmentScope>> = {
  "Bearer reader": ["orchestration:read"],
  "Bearer operator": ["orchestration:read", "orchestration:operate"],
};

const owner: MissionProvenance = { _tag: "owner-app", surface: "web", sessionId: "session-1" };
const missionId = MissionId.make("m-http");

// The owner creates the mission and locks its goal before any HTTP caller shows up.
const seeded = Layer.effectDiscard(
  Effect.gen(function* () {
    const missions = yield* MissionService.MissionService;
    yield* missions.createMission(owner, { missionId, slug: "http", title: "HTTP mission" });
    yield* missions.lockField(owner, {
      ref: { kind: "mission", id: missionId },
      field: "goal",
      locked: true,
    });
  }),
);

const services = seeded.pipe(
  Layer.provideMerge(MissionService.layer),
  Layer.provideMerge(MissionStore.layer),
  Layer.provideMerge(Sqlite.layerMemory),
);

const makeHandler = () =>
  HttpRouter.toWebHandler(
    missionsRouteLayer.pipe(
      Layer.provide(
        Layer.mock(EnvironmentAuth.EnvironmentAuth)({
          authenticateHttpRequest: (request) => {
            const scopes = TOKENS[request.headers.authorization ?? ""];
            return scopes === undefined
              ? Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError({}))
              : Effect.succeed({
                  sessionId: AuthSessionId.make("test-session"),
                  subject: "test",
                  method: "bearer-access-token" as const,
                  scopes,
                });
          },
        }),
      ),
      Layer.provide(services),
      Layer.provide(
        HttpPlatform.layer.pipe(
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(Etag.layerWeak),
        ),
      ),
    ),
    { disableLogger: true },
  );

const request = (
  path: string,
  init: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
) => {
  const url = `http://env.local${MISSIONS_ROUTE_PREFIX}${path}`;
  const headers: Record<string, string> = {
    ...(init.token ? { authorization: init.token } : {}),
    ...init.headers,
  };
  if (init.body === undefined) return new Request(url, { headers });
  headers["content-type"] = "application/json";
  return new Request(url, { method: "POST", headers, body: JSON.stringify(init.body) });
};

describe("missions routes", () => {
  it("needs a token for reads and the operate scope for writes", async () => {
    const { handler, dispose } = makeHandler();
    try {
      expect((await handler(request("/status"))).status).toBe(401);

      const status = await handler(request("/status", { token: "Bearer reader" }));
      expect(status.status).toBe(200);
      const list = (await status.json()) as { ok: boolean; missions: Array<{ id: string }> };
      expect(list.ok).toBe(true);
      expect(list.missions.map((mission) => mission.id)).toEqual([missionId]);

      const overview = await handler(
        request(`/status?mission=${missionId}`, { token: "Bearer reader" }),
      );
      const body = (await overview.json()) as { overview: { mission: { title: string } } };
      expect(body.overview.mission.title).toBe("HTTP mission");

      const write = await handler(
        request("/sub-missions", {
          token: "Bearer reader",
          headers: { "x-t3-thread-id": "thread-master" },
          body: { missionId, title: "Rails" },
        }),
      );
      expect(write.status).toBe(403);
    } finally {
      await dispose();
    }
  });

  it("takes agent provenance from the headers, never from the body", async () => {
    const { handler, dispose } = makeHandler();
    try {
      const anonymous = await handler(
        request("/sub-missions", {
          token: "Bearer operator",
          body: { missionId, title: "Rails", provenance: owner },
        }),
      );
      expect(anonymous.status).toBe(403);
      expect(await anonymous.json()).toMatchObject({
        ok: false,
        error: { code: "forbidden", missionCode: "provenance-required" },
      });

      const created = await handler(
        request("/sub-missions", {
          token: "Bearer operator",
          headers: { "x-t3-thread-id": "thread-master" },
          body: { missionId, title: "Rails", provenance: owner },
        }),
      );
      expect(created.status).toBe(200);
      const result = (await created.json()) as { ok: boolean; seq: number; ref: { kind: string } };
      expect(result).toMatchObject({ ok: true, ref: { kind: "sub-mission" } });

      const digest = await handler(
        request(`/digest?mission=${missionId}&since=${result.seq - 1}`, { token: "Bearer reader" }),
      );
      const events = (await digest.json()) as {
        latestSeq: number;
        events: Array<{ kind: string; provenance: MissionProvenance }>;
      };
      expect(events.latestSeq).toBe(result.seq);
      expect(events.events.map((event) => event.kind)).toEqual(["sub-mission.created"]);
      expect(events.events[0]?.provenance).toEqual({
        _tag: "agent",
        threadId: "thread-master",
        roleId: null,
      });
    } finally {
      await dispose();
    }
  });

  it("maps owner-only, locked and missing records to HTTP errors", async () => {
    const { handler, dispose } = makeHandler();
    try {
      const asMaster = (path: string, body: unknown) =>
        handler(
          request(path, {
            token: "Bearer operator",
            headers: { "x-t3-thread-id": "thread-master" },
            body,
          }),
        );

      const tier = await asMaster("/mission", { missionId, tier: "P0" });
      expect(tier.status).toBe(403);
      expect(await tier.json()).toMatchObject({ error: { missionCode: "forbidden" } });

      const goal = await asMaster("/mission", { missionId, goal: "Agent goal" });
      expect(goal.status).toBe(403);
      expect(await goal.json()).toMatchObject({ error: { missionCode: "locked" } });

      const malformed = await asMaster("/lanes", { missionId, status: "sleeping" });
      expect(malformed.status).toBe(400);

      const noMission = await handler(request("/digest", { token: "Bearer reader" }));
      expect(noMission.status).toBe(400);
      const unknown = await handler(request("/digest?mission=m-nope", { token: "Bearer reader" }));
      expect(unknown.status).toBe(404);
      expect(await unknown.json()).toMatchObject({
        ok: false,
        error: { code: "not_found", missionCode: "not-found" },
      });
      const badSince = await handler(
        request(`/digest?mission=${missionId}&since=yesterday-ish`, { token: "Bearer reader" }),
      );
      expect(badSince.status).toBe(400);
    } finally {
      await dispose();
    }
  });
});
