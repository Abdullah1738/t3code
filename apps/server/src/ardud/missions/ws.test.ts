import {
  ApprovalId,
  AuthOrchestrationOperateScope,
  CLIENT_GUARDED_RPC_SCOPES,
  MissionId,
  MissionError,
  WS_METHODS,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { RPC_REQUIRED_SCOPES } from "../../auth/RpcAuthorization.ts";
import {
  agent,
  askInput,
  harness,
  lane,
  laneThread,
  missionId,
  seed,
} from "./asks/AsksService.testkit.ts";
import * as RuleService from "./core/RuleService.ts";
import * as AsksService from "./asks/AsksService.ts";
import * as MissionService from "./MissionService.ts";
// ardud missions: router
import { MissionRouter } from "./router/MissionRouter.ts";
import { fakeRouterThreads, routerOverFakes } from "./router/MissionRouter.testkit.ts";
import * as MissionStore from "./store/MissionStore.ts";
import type { PolicyService } from "./policy/PolicyService.ts";
import { makeMissionWsHandlers, measuredUsage, missionWsHandlers } from "./ws.ts";

const TestLayer = RuleService.layer.pipe(
  Layer.provideMerge(routerOverFakes(fakeRouterThreads())),
  Layer.provideMerge(harness().layer),
);

const paired = {
  sessionId: "session-app",
  subject: "one-time-token",
  origin: { _tag: "owner", source: "cli" },
} as const;
// Paired-looking subject, but the link was minted by a nonowner issuer.
const strangerPaired = { sessionId: "session-stranger", subject: "one-time-token" };
const cliIssued = { sessionId: "session-cli", subject: "cli-issued-session" };
const mcpClient = { sessionId: "session-mcp", subject: "mcp-client" };

/** Every missions WS method that changes something. */
const WRITE_METHODS = Object.values(WS_METHODS).filter(
  (method) =>
    method.startsWith("missions.") &&
    ![
      "missions.subscribeList",
      "missions.subscribe",
      "missions.inbox",
      "missions.workItems",
      "missions.timeline",
      "missions.portfolio",
      // ardud missions: router
      "missions.rooms",
      "missions.roomPage",
      "missions.messageBody",
      "missions.roomTuning",
      "missions.attention",
      "missions.ownerRequests",
      // ardud missions: fix-p3
      "missions.roomActivity",
    ].includes(method),
);

it("every missions write is guarded by the operate scope", () => {
  assert.isAtLeast(WRITE_METHODS.length, 30);
  const guarded: Record<string, string> = CLIENT_GUARDED_RPC_SCOPES;
  const required: Record<string, string> = RPC_REQUIRED_SCOPES;
  for (const method of WRITE_METHODS) {
    assert.equal(guarded[method], AuthOrchestrationOperateScope, method);
    assert.equal(required[method], AuthOrchestrationOperateScope, method);
  }
  assert.notProperty(WS_METHODS, "missionsLockField");
});

it.layer(TestLayer)("missions WS handlers", (it) => {
  it.effect("only a paired client session is the owner; the surface only labels it", () =>
    Effect.gen(function* () {
      const handlers = yield* Effect.all({
        cli: missionWsHandlers({ surface: "cli", session: paired }),
        none: missionWsHandlers({ surface: undefined, session: paired }),
        issued: missionWsHandlers({ surface: "web", session: cliIssued }),
        mcp: missionWsHandlers({ surface: "web", session: mcpClient }),
        stranger: missionWsHandlers({ surface: "web", session: strangerPaired }),
      });
      for (const connection of Object.values(handlers)) {
        const write = connection as unknown as Record<
          string,
          (input: unknown) => Effect.Effect<void, MissionError>
        >;
        for (const method of WRITE_METHODS) {
          const handler = write[method];
          assert.isDefined(handler, method);
          if (handler === undefined) continue;
          const refused = yield* Effect.flip(handler({}));
          assert.equal(refused.code, "provenance-required", method);
        }
      }

      const app = yield* missionWsHandlers({ surface: "desktop", session: paired });
      const input = { missionId: MissionId.make("m-ws"), slug: "ws", title: "WS mission" };
      const created = yield* app[WS_METHODS.missionsCreate](input);
      const missions = yield* MissionService.MissionService;
      const [event] = yield* missions.eventsSince(input.missionId, created.seq - 1);
      assert.deepStrictEqual(event?.provenance, {
        _tag: "owner-app",
        surface: "desktop",
        sessionId: "session-app",
      });
      assert.deepStrictEqual(event?.actor, { _tag: "owner" });
    }),
  );

  it.effect("owner actions call the same services with owner provenance", () =>
    Effect.gen(function* () {
      yield* seed;
      const missions = yield* MissionService.MissionService;
      const asks = yield* AsksService.AsksService;
      const rules = yield* RuleService.RuleService;
      const store = yield* MissionStore.MissionStore;
      const router = yield* MissionRouter;
      const app = makeMissionWsHandlers(
        { missions, asks, rules, store, router, usage: Effect.succeed(null) },
        { surface: "web", session: paired },
      );

      // Asks: answer the master's ask from the app.
      const ask = yield* asks.openAsk(askInput("Online or offline?"), agent(laneThread));
      const answered = yield* app[WS_METHODS.missionsAnswerAsk]({
        askId: ask.id,
        optionId: "a",
        text: "Online",
      });
      assert.equal(answered.status, "answered");

      // Rules: a new rule in the owner's words.
      const rule = yield* app[WS_METHODS.missionsUpsertRule]({
        missionId,
        title: "Quiet deploys",
        quote: "Never deploy on Fridays.",
      });
      assert.deepStrictEqual(rule.provenance, {
        _tag: "owner-app",
        surface: "web",
        sessionId: "session-app",
      });

      // Approvals: crw opens one; the owner rejects it with a note.
      const approvalId = ApprovalId.make("m-1:approval:crw:acme/api#7@aaaaaaaaaaaa");
      yield* missions.openApproval(
        { _tag: "system", component: "crw" },
        {
          missionId,
          approvalId,
          kind: "merge",
          title: "Good to merge: acme/api#7",
          detail: "",
          requestedBy: "crw",
          links: [],
        },
      );
      const decided = yield* app[WS_METHODS.missionsDecideApproval]({
        approvalId,
        action: "reject",
        note: "Wait for the migration",
      });
      const [event] = yield* missions.eventsSince(missionId, decided.seq - 1);
      assert.equal(event?.kind, "approval.decided");
      assert.deepStrictEqual(event?.actor, { _tag: "owner" });
      const [approval] = yield* missions.approvals({ missionId, ids: [approvalId] });
      assert.equal(approval?.status, "rejected");
      assert.equal(approval?.decisionNote, "Wait for the migration");

      // ardud missions: core - portfolio order, its read and a lane nudge
      yield* app[WS_METHODS.missionsSetPortfolioOrder]({ order: [missionId] });
      const portfolio = yield* app[WS_METHODS.missionsPortfolio]({});
      assert.equal(portfolio.order[0], missionId);
      assert.deepStrictEqual(portfolio.orderChange?.actor, { _tag: "owner" });
      const nudged = yield* app[WS_METHODS.missionsNudgeLane]({ laneId: lane.id, note: "Status?" });
      const [nudge] = yield* missions.eventsSince(missionId, nudged.seq - 1);
      assert.equal(nudge?.kind, "lane.nudged");
      assert.deepStrictEqual(nudge?.actor, { _tag: "owner" });
    }),
  );

  it.effect("the portfolio reads pool use from the policy service when one runs", () =>
    Effect.gen(function* () {
      assert.isNull(yield* measuredUsage(Option.none()));
      const policy = {
        pools: () => Effect.succeed({ pools: [], at: "2026-10-17T08:00:00.000Z" }),
        governor: Effect.succeed({ shares: [{ missionId, dominant: 0.4 }] }),
      } as unknown as PolicyService["Service"];
      assert.deepStrictEqual(yield* measuredUsage(Option.some(policy)), {
        pools: [],
        shares: [{ missionId, dominant: 0.4 }],
      });
      const broken = {
        pools: () => Effect.fail(new MissionError({ code: "conflict", detail: "down" })),
        governor: Effect.succeed({ shares: [] }),
      } as unknown as PolicyService["Service"];
      assert.isNull(
        yield* measuredUsage(Option.some(broken)),
        "a policy failure leaves use unknown",
      );
    }),
  );
});
