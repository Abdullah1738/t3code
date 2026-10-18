import { AuthSessionId, PoolId, type AuthEnvironmentScope } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";

import type { SessionOrigin } from "../../auth/SessionOrigins.ts";
import * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import { MISSIONS_ROUTE_PREFIX } from "../http.ts";
import * as MissionService from "../MissionService.ts";
import { policyRouteLayer } from "./http.ts";
import { PolicyService } from "./PolicyService.ts";
import { CRPKO, OWNER, makePorts, testLayer } from "./testing.ts";

const TOKENS: Record<string, ReadonlyArray<AuthEnvironmentScope>> = {
  "Bearer reader": ["orchestration:read"],
  "Bearer operator": ["orchestration:read", "orchestration:operate"],
  "Bearer crw": ["orchestration:read", "orchestration:operate"],
  "Bearer scribe": ["orchestration:read", "orchestration:operate"],
};

/** Component credentials: the server knows who they are from the session, not a header. */
const ORIGINS: Record<string, SessionOrigin> = {
  "Bearer crw": { _tag: "component", component: "crw" },
  "Bearer scribe": { _tag: "component", component: "scribe" },
};

const REVIEW_POOL = PoolId.make("crpko-review-slots");
const pr = { repository: "crpko/trading-core", number: 412 };

// The owner creates Crpko with a one-slot review pool, and optionally a hard trigger.
const seeded = (trigger: boolean) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const missions = yield* MissionService.MissionService;
      const policy = yield* PolicyService;
      yield* missions.createMission(OWNER, { missionId: CRPKO, slug: "crpko", title: "Crpko" });
      yield* policy.createPool(OWNER, {
        poolId: REVIEW_POOL,
        name: "Crpko review slots",
        unit: "review",
        capacity: 1,
        scope: { _tag: "mission", missionId: CRPKO },
        kind: "lease",
        backend: "native",
      });
      if (!trigger) return;
      yield* policy.setCriticalityGuide(OWNER, {
        missionId: CRPKO,
        text: "XL diffs are critical.",
        hardTriggers: [{ _tag: "changed-lines", atLeast: 1500 }],
      });
    }),
  );

const makeHandler = (options: { readonly trigger?: boolean } = {}) => {
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
                  ...(ORIGINS[request.headers.authorization ?? ""]
                    ? { origin: ORIGINS[request.headers.authorization ?? ""] }
                    : {}),
                });
          },
        }),
      ),
      Layer.provide(
        seeded(options.trigger ?? false).pipe(Layer.provideMerge(testLayer(ports.layer))),
      ),
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

  it("H3: a header never names the caller, and HTTP does not govern", async () => {
    const { handler, dispose } = makeHandler();
    try {
      const take = {
        poolId: REVIEW_POOL,
        missionId: "crpko",
        amount: 1,
        purpose: "x",
        ttlSeconds: 60,
      };
      // Any identity header is refused outright, with or without a token that could act.
      for (const headers of [
        { "x-t3-thread-id": "thread-master" },
        { "x-t3-thread-id": "thread-master", "x-t3-role-id": "crpko:master" },
        { "x-t3-component": "crw" },
      ]) {
        for (const token of ["Bearer operator", "Bearer crw"]) {
          const spoofed = await handler(request("/pools/holds", { token, headers, body: take }));
          expect(spoofed.status).toBe(400);
        }
      }

      // Governance is not an HTTP operation for anyone: not the control token, not crw.
      const governance: Array<[string, unknown]> = [
        ["/pools/capacity", { poolId: REVIEW_POOL, capacity: 4 }],
        ["/pools", { name: "x", unit: "y", capacity: 1, scope: { _tag: "global" } }],
        [
          "/roles/model",
          {
            roleId: "crpko:reviewer",
            modelSelection: { provider: "opencode", model: "x" },
            reason: "x",
          },
        ],
        ["/criticality", { missionId: "crpko", pullRequest: pr, critical: false, reason: "x" }],
        ["/review-policy/guide", { missionId: "crpko", text: "" }],
        ["/pools/holds/reconcile", { holdId: "x", fence: 1, outcome: "released" }],
      ];
      for (const [path, payload] of governance) {
        for (const token of ["Bearer operator", "Bearer crw"]) {
          const refused = await handler(request(path, { token, body: payload }));
          expect(refused.status).toBe(403);
          expect((await body(refused)).error?.missionCode).toBe("provenance-required");
        }
      }
      const pools = await body(
        await handler(request("/pools?missionId=crpko", { token: "Bearer reader" })),
      );
      expect((pools.pools as Array<{ pool: { capacity: number } }>)[0]?.pool.capacity).toBe(1);

      const governor = await body(await handler(request("/governor", { token: "Bearer reader" })));
      expect(governor.ok).toBe(true);
    } finally {
      await dispose();
    }
  });

  it("crw's own credential acts as crw; another component's credential does not write policy", async () => {
    const { handler, dispose } = makeHandler();
    try {
      const taken = await body(
        await handler(
          request("/pools/holds", {
            token: "Bearer crw",
            body: {
              poolId: REVIEW_POOL,
              missionId: "crpko",
              amount: 1,
              purpose: "review",
              ttlSeconds: 60,
            },
          }),
        ),
      );
      expect((taken.hold as { holder: unknown }).holder).toEqual({
        _tag: "system",
        component: "crw",
      });

      const scribe = await handler(
        request("/reviews", {
          token: "Bearer scribe",
          body: {
            missionId: "crpko",
            pullRequest: pr,
            stageId: "reviewer",
            headSha: "abc",
            verdict: "clear",
          },
        }),
      );
      expect(scribe.status).toBe(403);
    } finally {
      await dispose();
    }
  });

  it("M2: the plan is a pure read; only a vouched reporter records trigger facts", async () => {
    const { handler, dispose } = makeHandler({ trigger: true });
    try {
      const big = { repository: "crpko/ledger", number: 9 };
      const plan = async (token: string, facts?: unknown) =>
        (
          await body(
            await handler(
              request("/review-plan", {
                token,
                body: {
                  missionId: "crpko",
                  pullRequest: big,
                  headSha: "h1",
                  ...(facts ? { facts } : {}),
                },
              }),
            ),
          )
        ).plan as { verdict: { source: string; decidedBy: unknown } | null; ladderId: string };

      // Invented facts on a read: the answer previews the trigger, nothing is stored.
      expect((await plan("Bearer reader", { changedLines: 99_999 })).verdict?.source).toBe(
        "hard-trigger",
      );
      expect((await plan("Bearer reader")).verdict).toBeNull();

      // Neither a reader nor the shared control token vouches for facts.
      const facts = { missionId: "crpko", pullRequest: big, facts: { changedLines: 2400 } };
      for (const token of ["Bearer reader", "Bearer operator"]) {
        const refused = await handler(request("/criticality/facts", { token, body: facts }));
        expect(refused.status).toBe(403);
      }
      expect((await plan("Bearer reader")).verdict).toBeNull();

      // crw's own credential records it, in crw's name.
      const reported = await body(
        await handler(request("/criticality/facts", { token: "Bearer crw", body: facts })),
      );
      expect(reported.recorded).toBe(true);
      const stored = await plan("Bearer reader");
      expect(stored.ladderId).toBe("critical");
      expect(stored.verdict?.decidedBy).toEqual({ _tag: "system", component: "crw" });
    } finally {
      await dispose();
    }
  });
});
