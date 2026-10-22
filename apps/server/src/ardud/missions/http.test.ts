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

import type { SessionOrigin } from "../auth/SessionOrigins.ts";
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import { AttachTargets } from "./core/attachTargets.ts";
import { MISSIONS_ROUTE_PREFIX, missionsRouteLayer } from "./http.ts";
import * as MissionService from "./MissionService.ts";
import * as MissionStore from "./store/MissionStore.ts";

const TOKENS: Record<string, ReadonlyArray<AuthEnvironmentScope>> = {
  "Bearer reader": ["orchestration:read"],
  "Bearer operator": ["orchestration:read", "orchestration:operate"],
  "Bearer crw": ["orchestration:read", "orchestration:operate"],
  "Bearer scribe": ["orchestration:read", "orchestration:operate"],
};
const ORIGINS: Record<string, SessionOrigin> = {
  "Bearer crw": { _tag: "component", component: "crw" },
  "Bearer scribe": { _tag: "component", component: "scribe" },
};

const owner: MissionProvenance = { _tag: "owner-app", surface: "web", sessionId: "session-1" };
const missionId = MissionId.make("m-http");

// The owner creates the mission before any HTTP caller shows up.
const seeded = Layer.effectDiscard(
  Effect.gen(function* () {
    const missions = yield* MissionService.MissionService;
    yield* missions.createMission(owner, { missionId, slug: "http", title: "HTTP mission" });
  }),
);

// crw created the review thread; nothing else exists.
const targets = Layer.succeed(
  AttachTargets,
  AttachTargets.of({
    lookup: (threadId) =>
      Effect.succeed(threadId === "thread-review-361" ? { origin: "crw" } : null),
  }),
);

const services = seeded.pipe(
  Layer.provideMerge(MissionService.layer),
  Layer.provideMerge(targets),
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
                  ...(ORIGINS[request.headers.authorization ?? ""]
                    ? { origin: ORIGINS[request.headers.authorization ?? ""] }
                    : {}),
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

  it("refuses plan writes that would trust a thread header, naming the MCP tool", async () => {
    const { handler, dispose } = makeHandler();
    try {
      for (const [path, tool] of [
        ["/mission", "mission_update"],
        ["/sub-missions", "mission_sub_mission"],
        ["/sub-missions/reorder", "mission_sub_mission_reorder"],
        ["/milestones", "mission_milestone"],
        ["/lanes", "mission_lane"],
        ["/work-items", "mission_work_item"],
      ] as const) {
        const response = await handler(
          request(path, {
            token: "Bearer operator",
            headers: { "x-t3-thread-id": "thread-master" },
            body: { missionId, title: "Rails", provenance: owner },
          }),
        );
        expect(response.status).toBe(403);
        const body = (await response.json()) as {
          ok: boolean;
          error: { code: string; missionCode: string; message: string };
        };
        expect(body).toMatchObject({
          ok: false,
          error: { code: "forbidden", missionCode: "provenance-required" },
        });
        expect(body.error.message).toContain(tool);
      }

      // Nothing was written.
      const digest = await handler(
        request(`/digest?mission=${missionId}&since=1`, { token: "Bearer reader" }),
      );
      expect(((await digest.json()) as { events: unknown[] }).events).toEqual([]);
    } finally {
      await dispose();
    }
  });

  it("takes crw approvals as system writes and serves decisions back", async () => {
    const { handler, dispose } = makeHandler();
    try {
      const approvalId = "crpko:approval:crw:acme/api#7@aaaaaaaaaaaa";
      const open = {
        missionId,
        approvalId,
        kind: "merge",
        title: "Good to merge: acme/api#7 Fix the thing",
        detail: "looks right\n\nDecide in the review thread (head aaaaaaaaaaaa).",
        requestedBy: "crw",
        links: [
          {
            kind: "pull-request",
            label: "acme/api#7",
            url: "https://github.com/acme/api/pull/7",
            ref: "aaaaaaaaaaaa",
          },
        ],
      };
      const post = (path: string, body: unknown, token = "Bearer crw") =>
        handler(request(path, { token, body }));

      expect((await post("/approvals/open", open, "Bearer reader")).status).toBe(403);
      // The shared control token no longer speaks for crw by naming it in the body.
      expect((await post("/approvals/open", open, "Bearer operator")).status).toBe(403);
      const opened = await post("/approvals/open", open);
      expect(opened.status).toBe(200);
      // Opening the same id again is settled, not a second record.
      expect((await post("/approvals/open", open)).status).toBe(200);
      // Only named components open approvals.
      const stranger = await post("/approvals/open", {
        ...open,
        approvalId: `${approvalId}~2`,
        requestedBy: "someone",
      });
      expect(stranger.status).toBe(403);

      const pending = await handler(
        request(`/approvals?mission=${missionId}&status=pending`, { token: "Bearer reader" }),
      );
      const listed = (await pending.json()) as {
        approvals: Array<{ id: string; approver: string; status: string }>;
      };
      expect(listed.approvals.map((approval) => [approval.id, approval.status])).toEqual([
        [approvalId, "pending"],
      ]);
      expect(listed.approvals[0]?.approver).toBe("owner");

      const stale = await post("/approvals/stale", {
        missionId,
        approvalId,
        reason: "head moved to cccccccccccc",
      });
      expect(stale.status).toBe(200);
      const again = await post("/approvals/stale", { missionId, approvalId, reason: "again" });
      expect(again.status).toBe(200);
      const missing = await post("/approvals/stale", {
        missionId,
        approvalId: `${approvalId}~9`,
        reason: "PR closed",
      });
      expect(missing.status).toBe(404);
      // A stale-closed approval cannot be opened again under the same id.
      const reopened = await post("/approvals/open", open);
      expect(reopened.status).toBe(409);

      const read = await handler(
        request(`/approvals?mission=${missionId}&id=${encodeURIComponent(approvalId)}`, {
          token: "Bearer reader",
        }),
      );
      const closed = (await read.json()) as {
        approvals: Array<{ status: string; staleReason: string; decidedBy: unknown }>;
      };
      expect(closed.approvals).toHaveLength(1);
      expect(closed.approvals[0]).toMatchObject({
        status: "stale-closed",
        staleReason: "head moved to cccccccccccc",
      });

      const digest = await handler(
        request(`/digest?mission=${missionId}&since=1`, { token: "Bearer reader" }),
      );
      const events = (await digest.json()) as {
        events: Array<{ kind: string; provenance: MissionProvenance }>;
      };
      expect(events.events.map((event) => event.kind)).toEqual([
        "approval.opened",
        "approval.stale-closed",
      ]);
      for (const event of events.events) {
        expect(event.provenance).toEqual({ _tag: "system", component: "crw" });
      }
    } finally {
      await dispose();
    }
  });

  it("a component credential acts only for its own component on approvals", async () => {
    const { handler, dispose } = makeHandler();
    try {
      const open = (approvalId: string, requestedBy: string) => ({
        missionId,
        approvalId,
        kind: "merge",
        title: "Good to merge",
        detail: "looks right",
        requestedBy,
        links: [],
      });
      const post = (path: string, body: unknown, token: string) =>
        handler(request(path, { token, body }));
      // crw's credential opens crw's approval; scribe's cannot claim to be crw.
      expect((await post("/approvals/open", open("a-1", "crw"), "Bearer crw")).status).toBe(200);
      expect((await post("/approvals/open", open("a-2", "crw"), "Bearer scribe")).status).toBe(403);
      expect((await post("/approvals/open", open("a-3", "scribe"), "Bearer scribe")).status).toBe(
        403,
      );
      const stale = { missionId, approvalId: "a-1", reason: "head moved" };
      expect((await post("/approvals/stale", stale, "Bearer scribe")).status).toBe(403);
      expect((await post("/approvals/stale", stale, "Bearer operator")).status).toBe(403);
      expect((await post("/approvals/stale", stale, "Bearer crw")).status).toBe(200);
    } finally {
      await dispose();
    }
  });

  it("crw attaches the review threads it runs; nobody else can", async () => {
    const { handler, dispose } = makeHandler();
    try {
      const attach = (attachedBy: string, state?: string) => ({
        missionId,
        threadId: "thread-review-361",
        attachedBy,
        title: "CRPKO backoffice-core#361 | Awaiting Decision",
        pullRequest: { repository: "crpko/backoffice-core", number: 361 },
        ...(state ? { state } : {}),
      });
      const post = (body: unknown, token: string) =>
        handler(request("/threads/attach", { token, body }));
      expect((await post(attach("crw"), "Bearer scribe")).status).toBe(403);
      expect((await post(attach("scribe"), "Bearer scribe")).status).toBe(403);
      expect((await post(attach("crw"), "Bearer operator")).status).toBe(403);
      expect(
        (await post({ ...attach("crw"), threadId: "thread-elsewhere" }, "Bearer crw")).status,
      ).toBe(404);
      const first = await post(attach("crw"), "Bearer crw");
      expect(first.status).toBe(200);
      const { seq } = (await first.json()) as { seq: number };
      const again = await post(attach("crw"), "Bearer crw");
      expect(await again.json()).toMatchObject({ ok: true, seq });
      expect((await post(attach("crw", "closed"), "Bearer crw")).status).toBe(200);

      const digest = await handler(
        request(`/digest?mission=${missionId}&since=1`, { token: "Bearer reader" }),
      );
      const events = (await digest.json()) as { events: Array<{ kind: string }> };
      expect(events.events.map((event) => event.kind)).toEqual([
        "thread.attached",
        "thread.closed",
      ]);
    } finally {
      await dispose();
    }
  });

  it("maps missing records and bad queries to HTTP errors", async () => {
    const { handler, dispose } = makeHandler();
    try {
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
      const noApprovalsMission = await handler(request("/approvals", { token: "Bearer reader" }));
      expect(noApprovalsMission.status).toBe(400);
    } finally {
      await dispose();
    }
  });
});
