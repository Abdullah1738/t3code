import {
  MissionError,
  WS_METHODS,
  type AckNoteInput,
  type AnswerAskInput,
  type ClientSurface,
  type CloseForkInput,
  type DecideDraftInput,
  type MissionInboxInput,
  type MissionProvenance,
  type MissionSubscribeInput,
  type NudgeLaneInput,
  type SetPortfolioOrderInput,
  type StartForkInput,
  type UpdateForkInput,
  type WithdrawAskInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { SessionOrigin } from "../auth/SessionOrigins.ts";
import * as AsksService from "./asks/AsksService.ts";
import { nudgeLane } from "./core/nudge.ts";
import type { PortfolioUsage } from "./core/portfolio.ts";
import { OWNER_SESSION_REQUIRED, ownerAppProvenance } from "./core/provenance.ts";
import * as RuleService from "./core/RuleService.ts";
import * as MissionService from "./MissionService.ts";
import { PolicyService } from "./policy/PolicyService.ts";
import * as MissionStore from "./store/MissionStore.ts";
// ardud missions: router
import { MissionRouter } from "./router/MissionRouter.ts";
import { makeRouterWsHandlers } from "./router/ws.ts";

/**
 * The WS connection a handler set serves: its surface label and auth session.
 * `origin` is the session's immutable origin claim; it, not `subject`, decides
 * whether the caller is the owner.
 */
export interface MissionWsConnection {
  readonly surface: ClientSurface | undefined;
  readonly session: {
    readonly sessionId: string;
    readonly subject: string;
    readonly origin?: SessionOrigin | undefined;
  };
}

export interface MissionWsServices {
  readonly missions: MissionService.MissionService["Service"];
  readonly asks: AsksService.AsksService["Service"];
  readonly rules: RuleService.RuleService["Service"];
  readonly store: MissionStore.MissionStore["Service"];
  readonly router: MissionRouter["Service"];
  /** Pool use for the portfolio, from the policy service; null where none runs. */
  readonly usage: Effect.Effect<PortfolioUsage | null>;
}

/**
 * Missions WS handlers. Reads stream to any connection with read scope. Every
 * write is an owner action: it runs only on a Robob client session paired by
 * the owner (see `ownerAppProvenance`) and calls the same service method the master's
 * MCP tools call, with owner provenance.
 */
export const makeMissionWsHandlers = (
  { missions, asks, rules, store, router, usage }: MissionWsServices,
  connection: MissionWsConnection,
) => {
  const provenance = ownerAppProvenance(connection);
  const asOwner =
    <I, A>(write: (provenance: MissionProvenance, input: I) => Effect.Effect<A, MissionError>) =>
    (input: I): Effect.Effect<A, MissionError> =>
      provenance === null
        ? Effect.fail(
            new MissionError({
              code: "provenance-required",
              detail: OWNER_SESSION_REQUIRED,
            }),
          )
        : write(provenance, input);
  // Asks' writes take (input, provenance); flip them to the core shape.
  const flip =
    <I, A>(write: (input: I, provenance: MissionProvenance) => Effect.Effect<A, MissionError>) =>
    (provenance: MissionProvenance, input: I) =>
      write(input, provenance);

  return {
    [WS_METHODS.missionsSubscribeList]: (_input: unknown) => missions.subscribeList,
    [WS_METHODS.missionsSubscribe]: (input: MissionSubscribeInput) =>
      missions.subscribe(input.missionId),
    [WS_METHODS.missionsInbox]: (input: MissionInboxInput) =>
      missions.subscribeInbox(input.missionId ?? null),
    [WS_METHODS.missionsWorkItems]: missions.workItems,
    [WS_METHODS.missionsTimeline]: missions.timeline,
    [WS_METHODS.missionsCreate]: asOwner(missions.createMission),
    [WS_METHODS.missionsUpdate]: asOwner(missions.updateMission),
    [WS_METHODS.missionsSetStatus]: asOwner(missions.setMissionStatus),
    [WS_METHODS.missionsSetFocus]: asOwner(missions.setMissionFocus),
    [WS_METHODS.missionsSetSubMissionStatus]: asOwner(missions.setSubMissionStatus),
    [WS_METHODS.missionsReorderSubMissions]: asOwner(missions.reorderSubMissions),
    [WS_METHODS.missionsMarkSeen]: asOwner(missions.markSeen),
    [WS_METHODS.missionsUpsertSubMission]: asOwner(missions.upsertSubMission),
    [WS_METHODS.missionsMergeSubMissions]: asOwner(missions.mergeSubMissions),
    [WS_METHODS.missionsUpsertLane]: asOwner(missions.upsertLane),
    [WS_METHODS.missionsSplitLane]: asOwner(missions.splitLane),
    [WS_METHODS.missionsMergeLanes]: asOwner(missions.mergeLanes),
    [WS_METHODS.missionsDecideApproval]: asOwner(missions.decideApproval),
    [WS_METHODS.missionsRouteApproval]: asOwner(missions.routeApproval),
    [WS_METHODS.missionsSetApprovalRouting]: asOwner(missions.setApprovalRouting),
    [WS_METHODS.missionsUpsertRule]: asOwner(rules.upsertRule),
    [WS_METHODS.missionsRequestRuleChange]: asOwner(rules.requestRuleChange),
    [WS_METHODS.missionsResolveRuleChange]: asOwner(rules.resolveRuleChange),
    [WS_METHODS.missionsAnswerAsk]: asOwner(
      flip((input: AnswerAskInput, by) => Effect.map(asks.answerAsk(input, by), (r) => r.ask)),
    ),
    [WS_METHODS.missionsWithdrawAsk]: asOwner(
      flip((input: WithdrawAskInput, by) => Effect.map(asks.withdrawAsk(input, by), (r) => r.ask)),
    ),
    [WS_METHODS.missionsReopenAsk]: asOwner(flip(asks.reopenAsk)),
    [WS_METHODS.missionsReactToCall]: asOwner(flip(asks.reactToCall)),
    [WS_METHODS.missionsDecideDraft]: asOwner(
      flip((input: DecideDraftInput, by) =>
        Effect.map(asks.decideDraft(input, by), (r) => r.draft),
      ),
    ),
    [WS_METHODS.missionsReopenDraft]: asOwner(flip(asks.reopenDraft)),
    [WS_METHODS.missionsSaveDraftNote]: asOwner(flip(asks.saveDraftNote)),
    [WS_METHODS.missionsDecideSuggestion]: asOwner(flip(asks.decideSuggestion)),
    [WS_METHODS.missionsReopenSuggestion]: asOwner(flip(asks.reopenSuggestion)),
    [WS_METHODS.missionsStartFork]: asOwner(
      flip((input: StartForkInput, by) => Effect.map(asks.startFork(input, by), (r) => r.fork)),
    ),
    [WS_METHODS.missionsCloseFork]: asOwner(
      flip((input: CloseForkInput, by) => Effect.map(asks.closeFork(input, by), (r) => r.fork)),
    ),
    [WS_METHODS.missionsUpdateFork]: asOwner(
      flip((input: UpdateForkInput, by) => Effect.map(asks.updateFork(input, by), (r) => r.fork)),
    ),
    [WS_METHODS.missionsAckNote]: asOwner(
      flip((input: AckNoteInput, by) => asks.ackNote(input.noteId, by)),
    ),
    [WS_METHODS.missionsPortfolio]: (_input: unknown) =>
      Effect.flatMap(usage, (measured) => missions.portfolio(measured)),
    [WS_METHODS.missionsSetPortfolioOrder]: asOwner((by, input: SetPortfolioOrderInput) =>
      missions.setPortfolioOrder(by, input),
    ),
    [WS_METHODS.missionsNudgeLane]: asOwner((by, input: NudgeLaneInput) =>
      nudgeLane({ store, router }, by, input),
    ),
  } as const;
};

/**
 * Pool use for the portfolio. A policy read failure leaves use unknown (null)
 * rather than failing the whole portfolio.
 */
export const measuredUsage = (
  policy: Option.Option<PolicyService["Service"]>,
): Effect.Effect<PortfolioUsage | null> =>
  Option.match(policy, {
    onNone: () => Effect.succeed(null),
    onSome: (service) =>
      Effect.all({ snapshot: service.pools({}), governor: service.governor }).pipe(
        Effect.map(({ snapshot, governor }) => ({
          pools: snapshot.pools,
          shares: governor.shares,
        })),
        Effect.catch((error) =>
          Effect.as(
            Effect.logWarning("Portfolio pool use unavailable", { detail: error.detail }),
            null,
          ),
        ),
      ),
  });

/** The handlers for one WS connection, with the missions services from context. */
export const missionWsHandlers = (connection: MissionWsConnection) =>
  Effect.gen(function* () {
    const missions = yield* MissionService.MissionService;
    const asks = yield* AsksService.AsksService;
    const rules = yield* RuleService.RuleService;
    // ardud missions: router - rooms, messages and knocks
    const router = yield* MissionRouter;
    const store = yield* MissionStore.MissionStore;
    // Policy is a sibling layer of the missions services; read it when present.
    const policy = yield* Effect.serviceOption(PolicyService);
    return {
      ...makeMissionWsHandlers(
        { missions, asks, rules, store, router, usage: measuredUsage(policy) },
        connection,
      ),
      ...makeRouterWsHandlers(router, connection),
    };
  });
