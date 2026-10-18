import { AuthSessionId, PoolId, type AuthEnvironmentScope } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";

import * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import * as AsksService from "../asks/AsksService.ts";
import { missionsDeskRouteLayer } from "../asks/http.ts";
import * as Inbound from "../asks/inbound.ts";
import * as AsksPorts from "../asks/ports.ts";
import { MISSIONS_ROUTE_PREFIX, missionsRouteLayer } from "../http.ts";
import * as MissionService from "../MissionService.ts";
import { policyRouteLayer } from "../policy/http.ts";
import { PolicyService } from "../policy/PolicyService.ts";
import { CRPKO, OWNER, SYSTEM, makePorts, testLayer } from "../policy/testing.ts";
import fixture from "./crwContract.fixture.json" with { type: "json" };

// crw's missions adapter (crw repo, lib/missions.mjs) sends exactly the
// requests in crwContract.fixture.json; crw's own suite asserts that, and this
// file replays them against the real core and policy route layers. A copy, not
// a link: refresh it from crw's test/fixtures/missions-contract.json (then
// `vp fmt` it) when the adapter changes, and a drift on either side fails one
// of the two suites.

interface FixtureRequest {
  readonly name: string;
  readonly route?: string;
  readonly method: string;
  readonly path: string;
  readonly body?: Record<string, unknown>;
  readonly expect: { readonly status: number; readonly keys: ReadonlyArray<string> };
  readonly repeat?: { readonly status: number };
}

const requests = fixture.requests as ReadonlyArray<FixtureRequest>;
const TOKEN = "Bearer control";
const TOKENS: Record<string, ReadonlyArray<AuthEnvironmentScope>> = {
  [TOKEN]: ["orchestration:read", "orchestration:operate"],
};

// Mission Crpko and its review pool, as the import and the master set them up.
const seeded = Layer.effectDiscard(
  Effect.gen(function* () {
    const missions = yield* MissionService.MissionService;
    const policy = yield* PolicyService;
    yield* missions.createMission(OWNER, { missionId: CRPKO, slug: "crpko", title: "Crpko" });
    yield* policy.createPool(SYSTEM, {
      poolId: PoolId.make(fixture.pool),
      name: "Crpko review slots",
      unit: "review",
      capacity: 6,
      scope: { _tag: "mission", missionId: CRPKO },
      kind: "lease",
      backend: "native",
    });
  }),
);

// The asks desk serves crw's drafts; nothing here forks threads or reads iMessage.
const asksPorts = Layer.mergeAll(
  Layer.succeed(
    AsksPorts.AsksThreads,
    AsksPorts.AsksThreads.of({
      fork: () => Effect.die("crw never forks a thread"),
      deliver: () => Effect.void,
    }),
  ),
  Layer.succeed(
    Inbound.InboundLookup,
    Inbound.InboundLookup.of({ find: () => Effect.succeed(null) }),
  ),
  AsksPorts.signalsNoop,
  AsksPorts.roomsPending,
  AsksPorts.applierRegistry,
  NodeServices.layer,
);

const makeHandler = () => {
  const ports = makePorts();
  const services = AsksService.layer.pipe(
    Layer.provide(asksPorts),
    Layer.provideMerge(seeded.pipe(Layer.provideMerge(testLayer(ports.layer)))),
  );
  return HttpRouter.toWebHandler(
    Layer.mergeAll(policyRouteLayer, missionsRouteLayer, missionsDeskRouteLayer).pipe(
      Layer.provide(
        Layer.mock(EnvironmentAuth.EnvironmentAuth)({
          authenticateHttpRequest: (request) => {
            const scopes = TOKENS[request.headers.authorization ?? ""];
            return scopes === undefined
              ? Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError({}))
              : Effect.succeed({
                  sessionId: AuthSessionId.make("crw-control"),
                  subject: "crw",
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

type Json = Record<string, unknown>;

// crw sends the control token and names itself; it never sends x-t3-thread-id.
const crwRequest = (entry: FixtureRequest, body: Json | undefined) => {
  const url = `http://env.local${MISSIONS_ROUTE_PREFIX}${entry.path}`;
  const headers: Record<string, string> = {
    authorization: TOKEN,
    "x-t3-component": fixture.component,
  };
  if (body === undefined) return new Request(url, { method: entry.method, headers });
  headers["content-type"] = "application/json";
  return new Request(url, { method: entry.method, headers, body: JSON.stringify(body) });
};

const fill = (body: Json | undefined, hold: Json | null): Json | undefined => {
  if (body === undefined) return undefined;
  const out: Json = {};
  for (const [key, value] of Object.entries(body)) {
    out[key] = value === "$hold.id" ? hold?.id : value === "$hold.fence" ? hold?.fence : value;
  }
  return out;
};

const at = (value: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((node, key) => {
    if (node === null || node === undefined) return undefined;
    if (Array.isArray(node)) return node.length === 0 ? undefined : (node[0] as Json)[key];
    return (node as Json)[key];
  }, value);

// The response fields lib/missions.mjs reads, per request: each must be present
// (null counts). An array is checked through its first element.
const READS: Record<string, ReadonlyArray<string>> = {
  "read approvals": [
    "approvals.id",
    "approvals.status",
    "approvals.requestedBy",
    "approvals.decidedBy",
    "approvals.decidedAt",
  ],
  "review plan": ["plan.headSha", "plan.mergeAllowed", "plan.reason", "plan.next"],
  roles: ["roles.id", "roles.modelSelection.model"],
  pools: [
    "pools.pool.id",
    "pools.pool.capacity",
    "pools.pool.kind",
    "pools.pool.backend",
    "pools.inUse",
    "pools.pressure",
  ],
  "take hold": ["hold.id", "hold.fence", "hold.holder"],
};

// Drafts go to the asks desk (/desk/drafts/*), which round 2 of asks adds.
const DESK = requests.filter((entry) => entry.route === "desk");
const CORE_AND_POLICY = requests.filter((entry) => entry.route !== "desk");

describe("crw adapter contract", () => {
  it("serves every core and policy request crw sends, in crw's name", async () => {
    const { handler, dispose } = makeHandler();
    try {
      let hold: Json | null = null;
      const seen: Record<string, Json> = {};
      for (const entry of CORE_AND_POLICY) {
        const body = fill(entry.body, hold);
        const response = await handler(crwRequest(entry, body));
        const answer = (await response.json()) as Json;
        expect({ name: entry.name, status: response.status, answer }).toMatchObject({
          name: entry.name,
          status: entry.expect.status,
        });
        expect(Object.keys(answer).toSorted()).toEqual([...entry.expect.keys].toSorted());
        for (const path of READS[entry.name] ?? []) {
          expect({ name: entry.name, path, defined: at(answer, path) !== undefined }).toEqual({
            name: entry.name,
            path,
            defined: true,
          });
        }
        if (entry.repeat) {
          const again = await handler(crwRequest(entry, body));
          expect({ name: entry.name, repeat: again.status }).toEqual({
            name: entry.name,
            repeat: entry.repeat.status,
          });
        }
        if (entry.name === "take hold") hold = answer.hold as Json;
        seen[entry.name] = answer;
      }

      // The hold and the approval say crw took them, not the control API.
      expect(at(seen["take hold"], "hold.holder")).toEqual({ _tag: "system", component: "crw" });
      expect(at(seen["read approvals"], "approvals.requestedBy")).toBe("crw");
      expect(at(seen["read approvals"], "approvals.status")).toBe("pending");
      // The summary and flags crw sends with the approval are kept for the owner's card.
      const opened = requests.find((r) => r.name === "open approval")?.body;
      expect(at(seen["read approvals"], "approvals.summary")).toBe(opened?.summary);
      expect(at(seen["read approvals"], "approvals.flags")).toEqual(opened?.flags);

      // The plan answers for the exact head crw asked about.
      const asked = requests.find((r) => r.name === "review plan")?.body?.headSha;
      expect(at(seen["review plan"], "plan.headSha")).toBe(asked);
    } finally {
      await dispose();
    }
  });

  it("refuses a component it does not know and a thread posing as crw", async () => {
    const { handler, dispose } = makeHandler();
    try {
      const take = requests.find((entry) => entry.name === "take hold");
      expect(take).toBeDefined();
      if (take === undefined) return;
      const stranger = crwRequest(take, take.body);
      stranger.headers.set("x-t3-component", "someone");
      expect((await handler(stranger)).status).toBe(403);

      const both = crwRequest(take, take.body);
      both.headers.set("x-t3-thread-id", "thread-master");
      expect((await handler(both)).status).toBe(400);
    } finally {
      await dispose();
    }
  });

  it(`serves the asks desk draft routes crw sends (${DESK.map((entry) => entry.name).join(", ")})`, async () => {
    const { handler, dispose } = makeHandler();
    try {
      const seen: Record<string, Json> = {};
      for (const entry of DESK) {
        const response = await handler(crwRequest(entry, entry.body));
        const answer = (await response.json()) as Json;
        expect({ name: entry.name, status: response.status, answer }).toMatchObject({
          name: entry.name,
          status: entry.expect.status,
        });
        expect(Object.keys(answer).toSorted()).toEqual([...entry.expect.keys].toSorted());
        seen[entry.name] = answer;
      }
      const opened = DESK.find((entry) => entry.name === "open draft")?.body;
      expect(seen["open draft"]?.draft).toMatchObject({
        id: opened?.draftId,
        missionId: opened?.missionId,
        requestedBy: "crw",
        head: opened?.head,
        channel: "github",
        status: "pending",
        approver: "owner",
        summary: opened?.summary,
        flags: opened?.flags,
        revision: 0,
      });
      // Nobody decided it yet, so crw has nothing to post for that head.
      expect(seen["read draft decision"]?.decision).toMatchObject({
        draftId: opened?.draftId,
        head: opened?.head,
        state: "pending",
        text: null,
        revision: 0,
        delivery: "unsent",
      });
      expect(seen["close stale draft"]?.draft).toMatchObject({
        status: "dropped",
        staleReason: "head moved to cccccccccccc",
      });

      // Once stale, the old head never reads as decided and can't be reported sent.
      const read = DESK.find((entry) => entry.name === "read draft decision");
      if (read === undefined) return;
      const after = (await (await handler(crwRequest(read, undefined))).json()) as Json;
      expect(at(after, "decision.state")).toBe("stale");
      const sent = await handler(
        crwRequest(
          { name: "report sent", method: "POST", path: "/desk/drafts/sent", expect: read.expect },
          {
            draftId: opened?.draftId,
            requestedBy: "crw",
            revision: 0,
            outcome: {
              _tag: "sent",
              link: { kind: "url", label: "comment", url: "https://example.test/c/1", ref: null },
            },
          },
        ),
      );
      expect(sent.status).toBe(409);

      // Another component's claim never reaches crw's drafts.
      const open = DESK.find((entry) => entry.name === "open draft");
      if (open === undefined) return;
      const posing = crwRequest(open, open.body);
      posing.headers.set("x-t3-component", "someone");
      expect((await handler(posing)).status).toBe(403);
      const thread = crwRequest(open, open.body);
      thread.headers.set("x-t3-thread-id", "thread-master");
      expect((await handler(thread)).status).toBe(400);
    } finally {
      await dispose();
    }
  });
});
