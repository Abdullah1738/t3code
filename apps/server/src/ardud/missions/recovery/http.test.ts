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

const READ_OPERATE: ReadonlyArray<AuthEnvironmentScope> = [
  "orchestration:read",
  "orchestration:operate",
];

const TOKENS: Record<string, ReadonlyArray<AuthEnvironmentScope>> = {
  "Bearer reader": ["orchestration:read"],
  "Bearer operator": READ_OPERATE,
  "Bearer recovery": READ_OPERATE,
  "Bearer scribe": READ_OPERATE,
};

/** Component credentials carry their origin; the shared operate token has none. */
const ORIGINS: Record<string, { readonly _tag: "component"; readonly component: string }> = {
  "Bearer recovery": { _tag: "component", component: "stream-recovery" },
  "Bearer scribe": { _tag: "component", component: "scribe" },
};

const makeHandler = () => {
  const { layer } = harness();
  const services = Layer.effectDiscard(world()).pipe(Layer.provideMerge(layer));
  return HttpRouter.toWebHandler(
    recoveryRouteLayer.pipe(
      Layer.provide(
        Layer.mock(EnvironmentAuth.EnvironmentAuth)({
          authenticateHttpRequest: (request) => {
            const token = request.headers.authorization ?? "";
            const scopes = TOKENS[token];
            const origin = ORIGINS[token];
            return scopes === undefined
              ? Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError({}))
              : Effect.succeed({
                  sessionId: AuthSessionId.make("test-session"),
                  subject: "test",
                  method: "bearer-access-token" as const,
                  scopes,
                  ...(origin === undefined ? {} : { origin }),
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
  it("takes restart reports only from stream-recovery's own credential", async () => {
    const { handler, dispose } = makeHandler();
    try {
      expect((await handler(request("/incident", { body: report }))).status).toBe(401);
      expect(
        (await handler(request("/incident", { token: "Bearer reader", body: report }))).status,
      ).toBe(403);
      // The shared operate token used to be labelled stream-recovery.
      const shared = await handler(
        request("/incident", { token: "Bearer operator", body: report }),
      );
      expect(shared.status).toBe(403);
      expect(JSON.stringify(await shared.json())).toContain(
        "t3 ardud component-token issue stream-recovery",
      );
      const other = await handler(request("/incident", { token: "Bearer scribe", body: report }));
      expect(other.status).toBe(403);

      const posted = await handler(
        request("/incident", { token: "Bearer recovery", body: report }),
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
        request("/incident", { token: "Bearer recovery", body: { ...report, cause: "reboot" } }),
      );
      expect(bad.status).toBe(400);
    } finally {
      await dispose();
    }
  });

  it("never takes resume or settings over HTTP, whatever thread the headers claim", async () => {
    const { handler, dispose } = makeHandler();
    try {
      const claim = { "x-t3-thread-id": masterThread };
      expect(
        (await handler(request("/settings", { body: { missionId, resumePerMinute: 2 } }))).status,
      ).toBe(401);
      for (const token of ["Bearer operator", "Bearer recovery"]) {
        const settings = await handler(
          request("/settings", {
            token,
            headers: claim,
            body: { missionId, resumePerMinute: 2 },
          }),
        );
        expect(settings.status).toBe(403);
        expect(JSON.stringify(await settings.json())).toContain("mission_recovery_settings");
        const resume = await handler(
          request("/resume", {
            token,
            headers: claim,
            body: { missionId, mode: "now", threadId: laneThread, instruction: "Deploy prod." },
          }),
        );
        expect(resume.status).toBe(403);
        expect(JSON.stringify(await resume.json())).toContain("mission_recovery_resume");
      }

      const status = await handler(
        request(`/status?missionId=${missionId}`, { token: "Bearer reader" }),
      );
      const body = (await status.json()) as {
        status: { settings: { resumePerMinute: number }; state: unknown; incident: unknown };
      };
      expect(body.status.settings.resumePerMinute).toBe(4);
      expect(body.status.state).toBeNull();
      expect(body.status.incident).toBeNull();
    } finally {
      await dispose();
    }
  });
});
