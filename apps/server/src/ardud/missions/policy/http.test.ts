import { AuthSessionId, PoolId, type AuthEnvironmentScope } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";

import * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import { MISSIONS_ROUTE_PREFIX } from "../http.ts";
import * as MissionService from "../MissionService.ts";
import { policyRouteLayer } from "./http.ts";
import { PolicyService } from "./PolicyService.ts";
import { CRPKO, OWNER, SYSTEM, makePorts, testLayer } from "./testing.ts";

const TOKENS: Record<string, ReadonlyArray<AuthEnvironmentScope>> = {
  "Bearer reader": ["orchestration:read"],
  "Bearer operator": ["orchestration:read", "orchestration:operate"],
};

const REVIEW_POOL = PoolId.make("crpko-review-slots");
const pr = { repository: "crpko/trading-core", number: 412 };

// The owner creates Crpko; a server component sets up a one-slot review pool.
const seeded = Layer.effectDiscard(
  Effect.gen(function* () {
    const missions = yield* MissionService.MissionService;
    const policy = yield* PolicyService;
    yield* missions.createMission(OWNER, { missionId: CRPKO, slug: "crpko", title: "Crpko" });
    yield* policy.createPool(SYSTEM, {
      poolId: REVIEW_POOL,
      name: "Crpko review slots",
      unit: "review",
      capacity: 1,
      scope: { _tag: "mission", missionId: CRPKO },
      kind: "lease",
      backend: "native",
    });
  }),
);

const makeHandler = () => {
  const ports = makePorts();
  ports.threads.set("thread-stranger", { exists: true, idle: true, modelSelection: null });
  return HttpRouter.toWebHandler(
    policyRouteLayer.pipe(
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
      Layer.provide(seeded.pipe(Layer.provideMerge(testLayer(ports.layer)))),
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
  const url = `http://env.local${MISSIONS_ROUTE_PREFIX}${path}`;
  const headers: Record<string, string> = {
    ...(init.token ? { authorization: init.token } : {}),
    ...init.headers,
  };
  if (init.body === undefined) return new Request(url, { headers });
  headers["content-type"] = "application/json";
  return new Request(url, { method: "POST", headers, body: JSON.stringify(init.body) });
};

interface Envelope {
  readonly ok: boolean;
  readonly error?: { readonly code: string; readonly missionCode?: string };
  readonly [key: string]: unknown;
}

const body = async (response: Response) => (await response.json()) as Envelope;

describe("mission policy routes", () => {
  it("serves the reads crw makes and refuses writes without the operate scope", async () => {
    const { handler, dispose } = makeHandler();
    try {
      expect((await handler(request("/roles?missionId=crpko"))).status).toBe(401);

      const roles = await body(
        await handler(request("/roles?missionId=crpko", { token: "Bearer reader" })),
      );
      const reviewer = (
        roles.roles as Array<{ id: string; modelSelection: { model: string } }>
      ).find((role) => role.id === "crpko:reviewer");
      expect(reviewer?.modelSelection.model).toBe("opus/cx/gpt-6.1-sol");

      const pools = await body(
        await handler(request("/pools?missionId=crpko", { token: "Bearer reader" })),
      );
      const view = (
        pools.pools as Array<{ pool: { id: string; capacity: number }; inUse: number }>
      )[0];
      expect(view?.pool.id).toBe(REVIEW_POOL);
      expect(view?.inUse).toBe(0);

      const refused = await handler(
        request("/pools/capacity", {
          token: "Bearer reader",
          body: { poolId: REVIEW_POOL, capacity: 3 },
        }),
      );
      expect(refused.status).toBe(403);

      expect((await handler(request("/roles", { token: "Bearer reader" }))).status).toBe(400);
    } finally {
      await dispose();
    }
  });

  it("answers the review plan, takes a review record and opens the merge gate", async () => {
    const { handler, dispose } = makeHandler();
    try {
      const before = await body(
        await handler(
          request("/review-plan", {
            token: "Bearer reader",
            body: { missionId: "crpko", pullRequest: pr, headSha: "abc123" },
          }),
        ),
      );
      const plan = before.plan as {
        mergeAllowed: boolean;
        next: { stageId: string; modelSelection: { model: string } } | null;
      };
      expect(plan.mergeAllowed).toBe(false);
      expect(plan.next?.stageId).toBe("reviewer");

      const recorded = await handler(
        request("/reviews", {
          token: "Bearer operator",
          body: {
            missionId: "crpko",
            pullRequest: pr,
            stageId: "reviewer",
            headSha: "abc123",
            verdict: "clear",
            links: [
              { kind: "pull-request", label: "crpko/trading-core#412", url: null, ref: "abc123" },
            ],
          },
        }),
      );
      expect(recorded.status).toBe(200);

      const after = await body(
        await handler(
          request("/review-plan", {
            token: "Bearer reader",
            body: { missionId: "crpko", pullRequest: pr, headSha: "abc123" },
          }),
        ),
      );
      expect((after.plan as { mergeAllowed: boolean }).mergeAllowed).toBe(true);

      const moved = await body(
        await handler(
          request("/review-plan", {
            token: "Bearer reader",
            body: { missionId: "crpko", pullRequest: pr, headSha: "def456" },
          }),
        ),
      );
      expect((moved.plan as { mergeAllowed: boolean }).mergeAllowed).toBe(false);
    } finally {
      await dispose();
    }
  });

  it("takes and releases review holds with fences and reports a full pool as a conflict", async () => {
    const { handler, dispose } = makeHandler();
    try {
      const take = (purpose: string) =>
        handler(
          request("/pools/holds", {
            token: "Bearer operator",
            body: { poolId: REVIEW_POOL, missionId: "crpko", amount: 1, purpose, ttlSeconds: 3600 },
          }),
        );
      const first = await body(await take("crw review crpko/trading-core#412"));
      const hold = first.hold as { id: string; fence: number; status: string };
      expect(hold.status).toBe("active");
      expect(hold.fence).toBe(1);

      const full = await take("crw review crpko/trading-core#413");
      expect(full.status).toBe(409);
      expect((await body(full)).error?.missionCode).toBe("pool-full");

      const wrongFence = await handler(
        request("/pools/holds/release", {
          token: "Bearer operator",
          body: { holdId: hold.id, fence: 7, note: "done" },
        }),
      );
      expect(wrongFence.status).toBe(409);
      expect((await body(wrongFence)).error?.missionCode).toBe("fence-mismatch");

      const released = await handler(
        request("/pools/holds/release", {
          token: "Bearer operator",
          body: { holdId: hold.id, fence: hold.fence, note: "review delivered" },
        }),
      );
      expect(released.status).toBe(200);

      const second = await body(await take("crw review crpko/trading-core#413"));
      expect((second.hold as { fence: number }).fence).toBe(2);
    } finally {
      await dispose();
    }
  });

  it("acts as the named agent thread when one is given", async () => {
    const { handler, dispose } = makeHandler();
    try {
      const stranger = await handler(
        request("/pools/capacity", {
          token: "Bearer operator",
          headers: { "x-t3-thread-id": "thread-stranger" },
          body: { poolId: REVIEW_POOL, capacity: 4 },
        }),
      );
      expect(stranger.status).toBe(403);

      const control = await handler(
        request("/pools/capacity", {
          token: "Bearer operator",
          body: { poolId: REVIEW_POOL, capacity: 4 },
        }),
      );
      expect(control.status).toBe(200);

      const governor = await body(await handler(request("/governor", { token: "Bearer reader" })));
      expect(governor.ok).toBe(true);
    } finally {
      await dispose();
    }
  });
});
