import { AuthSessionId, type AuthEnvironmentScope } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";

import * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import { laneThread, masterThread, missionId } from "../asks/AsksService.testkit.ts";
import { RECOVERY_ROUTE_PREFIX, recoveryRouteLayer } from "./http.ts";
import { harness, world } from "./testkit.ts";

const TOKENS: Record<string, ReadonlyArray<AuthEnvironmentScope>> = {
  "Bearer reader": ["orchestration:read"],
  "Bearer operator": ["orchestration:read", "orchestration:operate"],
};

const makeHandler = () => {
  const { layer } = harness();
  const services = Layer.effectDiscard(world()).pipe(Layer.provideMerge(layer));
  return HttpRouter.toWebHandler(
    recoveryRouteLayer.pipe(
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
};

const request = (
  path: string,
  init: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
) => {
  const url = `http://env.local${RECOVERY_ROUTE_PREFIX}${path}`;
  const headers: Record<string, string> = {
    ...(init.token ? { authorization: init.token } : {}),
    ...init.headers,
  };
  if (init.body === undefined) return new Request(url, { headers });
  headers["content-type"] = "application/json";
  return new Request(url, { method: "POST", headers, body: JSON.stringify(init.body) });
};

const report = {
  reportId: "rs-20261017T090500Z",
  cause: "opencode-restart",
  startAt: "2026-10-17T09:04:00.000Z",
  endAt: "2026-10-17T09:05:00.000Z",
  threads: [
    { threadId: laneThread, runIds: [], childIds: [] },
    { threadId: "t-stranger", runIds: [], childIds: [] },
  ],
  dryRun: true,
};

describe("mission recovery routes", () => {
  it("lets stream-recovery report with the control token and answers which threads are members", async () => {
    const { handler, dispose } = makeHandler();
    try {
      expect((await handler(request("/incident", { body: report }))).status).toBe(401);
      expect(
        (await handler(request("/incident", { token: "Bearer reader", body: report }))).status,
      ).toBe(403);

      const posted = await handler(
        request("/incident", { token: "Bearer operator", body: report }),
      );
      expect(posted.status).toBe(200);
      expect(await posted.json()).toEqual({
        ok: true,
        incidentId: null,
        members: [{ threadId: laneThread, missionIds: [missionId] }],
        missions: [],
      });

      const members = await handler(
        request(`/members?threadIds=${laneThread},${masterThread},t-stranger`, {
          token: "Bearer reader",
        }),
      );
      const body = (await members.json()) as { members: Array<{ threadId: string }> };
      expect(body.members.map((member) => member.threadId).toSorted()).toEqual(
        [laneThread, masterThread].toSorted(),
      );

      const bad = await handler(
        request("/incident", { token: "Bearer operator", body: { ...report, cause: "reboot" } }),
      );
      expect(bad.status).toBe(400);
    } finally {
      await dispose();
    }
  });

  it("takes resume and settings only from the master thread, named in the headers", async () => {
    const { handler, dispose } = makeHandler();
    try {
      const settings = { missionId, resumePerMinute: 2 };
      const anonymous = await handler(
        request("/settings", { token: "Bearer operator", body: settings }),
      );
      expect(anonymous.status).toBe(403);

      const lane = await handler(
        request("/settings", {
          token: "Bearer operator",
          headers: { "x-t3-thread-id": laneThread },
          body: settings,
        }),
      );
      expect(lane.status).toBe(403);

      const master = await handler(
        request("/settings", {
          token: "Bearer operator",
          headers: { "x-t3-thread-id": masterThread },
          body: settings,
        }),
      );
      expect(master.status).toBe(200);
      expect(await master.json()).toEqual({
        ok: true,
        settings: { missionId, resumePerMinute: 2, masterLeadSeconds: 60 },
      });

      const status = await handler(
        request(`/status?missionId=${missionId}`, { token: "Bearer reader" }),
      );
      const body = (await status.json()) as {
        status: { settings: { resumePerMinute: number }; state: unknown; incident: unknown };
      };
      expect(body.status.settings.resumePerMinute).toBe(2);
      expect(body.status.state).toBeNull();
      expect(body.status.incident).toBeNull();
    } finally {
      await dispose();
    }
  });
});
