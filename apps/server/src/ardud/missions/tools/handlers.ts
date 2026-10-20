import {
  MissionError,
  OrchestratorMcpFailure,
  type MissionId,
  type MissionProvenance,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import * as AsksService from "../asks/AsksService.ts";
import { keepWorkItemHolds, laneHoldConflict } from "../asks/holds.ts";
import * as MasterControls from "../core/MasterControls.ts";
import { nudgeLane } from "../core/nudge.ts";
import * as RuleService from "../core/RuleService.ts";
import { watchAddCommand, watchCheckCommand } from "../asks/watch.ts";
import * as MissionService from "../MissionService.ts";
import { MissionRouter } from "../router/MissionRouter.ts";
import * as MissionStore from "../store/MissionStore.ts";
import { MissionsToolkit } from "./tools.ts";

/** The `mission` CLI as robob-watch checks call it (on PATH once installed). */
const MISSION_CLI = "mission";

const REFUSALS: ReadonlySet<MissionError["code"]> = new Set([
  "forbidden",
  "provenance-required",
  "provenance-invalid",
]);

/** Mission errors reach the agent as tool errors carrying the mission's own wording. */
const toolFailure = (error: MissionError) =>
  new OrchestratorMcpFailure({
    code: REFUSALS.has(error.code) ? "capability_denied" : "invalid_request",
    message: error.message,
  });

const invalid = (message: string) =>
  Effect.fail(new OrchestratorMcpFailure({ code: "invalid_request", message }));

/**
 * Who is calling, from the MCP invocation context only. A T3 thread is an
 * agent (the service resolves its roles and lanes); a signed-in MCP
 * client is a system component named after its label.
 */
export const callerProvenance = (
  scope: McpInvocationContext.McpInvocationScope,
): MissionProvenance => {
  if (scope.thread !== undefined) {
    return { _tag: "agent", threadId: scope.thread.threadId, roleId: null };
  }
  return {
    _tag: "system",
    component: scope.client === undefined ? "mcp" : `mcp-client:${scope.client.label}`,
  };
};

const withCaller = <A, R = never>(
  run: (
    asks: AsksService.AsksService["Service"],
    provenance: MissionProvenance,
  ) => Effect.Effect<A, MissionError | OrchestratorMcpFailure, R>,
) =>
  Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const asks = yield* AsksService.AsksService;
    return yield* run(asks, callerProvenance(scope));
  }).pipe(Effect.catchTags({ MissionError: (error) => Effect.fail(toolFailure(error)) }));

/**
 * Plan writes are the master's: the calling thread must hold the mission's
 * master role, and core records the write as that role.
 */
const asMaster = <A>(
  missionId: MissionId,
  run: (
    missions: MissionService.MissionService["Service"],
    asks: AsksService.AsksService["Service"],
    provenance: MissionProvenance,
  ) => Effect.Effect<A, MissionError>,
) =>
  withCaller((asks, provenance) =>
    Effect.gen(function* () {
      const standing = yield* asks.standing(missionId, provenance);
      if (!standing.isMaster) {
        return yield* new MissionError({
          code: "forbidden",
          detail: `Only mission ${missionId}'s master changes its plan.`,
        });
      }
      const missions = yield* MissionService.MissionService;
      return yield* run(missions, asks, standing.caller.provenance);
    }),
  );

const openAsks = (asks: AsksService.AsksService["Service"], missionId: MissionId) =>
  asks.asks({ missionId, status: ["open"] });

/**
 * New missions belong to no mission yet: any mission's master may create one.
 * ardud missions: core - looked up from the complete thread index, never a
 * capped mission list.
 */
const asAnyMaster = <A>(
  actingFor: MissionId | undefined,
  refusal: string,
  run: (
    missions: MissionService.MissionService["Service"],
    provenance: MissionProvenance,
  ) => Effect.Effect<A, MissionError>,
) =>
  withCaller((_asks, provenance) =>
    Effect.gen(function* () {
      const controls = yield* MasterControls.MasterControls;
      const master = yield* controls.asAnyMaster(provenance, actingFor);
      if (master === null) {
        return yield* new MissionError({ code: "forbidden", detail: refusal });
      }
      const missions = yield* MissionService.MissionService;
      return yield* run(missions, master);
    }),
  );

/** Rules carry their own owner-or-master check; the caller is passed as it stands. */
const withRules = <A>(
  run: (
    rules: RuleService.RuleService["Service"],
    provenance: MissionProvenance,
  ) => Effect.Effect<A, MissionError>,
) =>
  withCaller((_asks, provenance) =>
    Effect.gen(function* () {
      const rules = yield* RuleService.RuleService;
      return yield* run(rules, provenance);
    }),
  );

const handlers = {
  mission_status: McpToolAccess.reads((input) =>
    withCaller((asks) =>
      Effect.gen(function* () {
        const missions = yield* asks.missions();
        const desk = input.missionId === undefined ? null : yield* asks.desk(input.missionId);
        const suggestionStats = yield* asks.suggestionStats();
        return { missions, desk, suggestionStats };
      }),
    ),
  ),
  mission_digest: McpToolAccess.reads((input) =>
    withCaller((asks) =>
      asks.digest(input.missionId, input.since).pipe(Effect.map((events) => ({ events }))),
    ),
  ),
  mission_asks: McpToolAccess.reads((input) =>
    withCaller((asks) =>
      input.askId !== undefined
        ? asks.ask(input.askId).pipe(Effect.map((ask) => ({ asks: [ask] })))
        : asks
            .asks({ missionId: input.missionId, status: input.status })
            .pipe(Effect.map((found) => ({ asks: found }))),
    ),
  ),
  mission_drafts: McpToolAccess.reads((input) =>
    withCaller((asks) =>
      Effect.gen(function* () {
        if (input.guideFor !== undefined && input.missionId === undefined) {
          return yield* invalid("guideFor needs missionId.");
        }
        const drafts = yield* asks.drafts({ missionId: input.missionId, status: input.status });
        const guide =
          input.guideFor === undefined || input.missionId === undefined
            ? null
            : yield* asks.draftGuide({ missionId: input.missionId, ...input.guideFor });
        return { drafts, guide };
      }),
    ),
  ),
  mission_note: McpToolAccess.reads((input) =>
    withCaller((asks) => asks.notes(input.missionId).pipe(Effect.map((notes) => ({ notes })))),
  ),
  mission_watch: McpToolAccess.reads((input) =>
    withCaller((asks) =>
      Effect.gen(function* () {
        // Fails with not-found for an unknown mission.
        yield* asks.desk(input.missionId);
        const kinds = [...new Set(input.on)];
        const watch = {
          cli: MISSION_CLI,
          missionId: input.missionId,
          kinds,
          ...(input.intervalSeconds === undefined
            ? {}
            : { intervalSeconds: input.intervalSeconds }),
        };
        return { check: watchCheckCommand(watch), add: watchAddCommand(watch), kinds };
      }),
    ),
  ),
  mission_ask: McpToolAccess.actsAsCaller((input) =>
    withCaller((asks, provenance) =>
      asks.openAsk(input, provenance).pipe(Effect.map((ask) => ({ ask }))),
    ),
  ),
  mission_ask_withdraw: McpToolAccess.actsAsCaller((input) =>
    withCaller((asks, provenance) => asks.withdrawAsk(input, provenance)),
  ),
  mission_ask_answer: McpToolAccess.actsAsCaller((input) =>
    withCaller((asks, provenance) =>
      asks.answerAsk(
        {
          askId: input.askId,
          optionId: input.optionId ?? null,
          text: input.text,
          ...(input.onOwnerCondition === undefined
            ? {}
            : { onOwnerCondition: input.onOwnerCondition }),
        },
        provenance,
      ),
    ),
  ),
  mission_call: McpToolAccess.actsAsCaller((input) =>
    withCaller((asks, provenance) =>
      asks.makeCall(input, provenance).pipe(Effect.map((call) => ({ call }))),
    ),
  ),
  mission_draft: McpToolAccess.actsAsCaller((input) =>
    withCaller((asks, provenance) => {
      if (input.draftId !== undefined) {
        return asks
          .reviseDraft(
            {
              draftId: input.draftId,
              text: input.text,
              ...(input.view === undefined ? {} : { view: input.view }),
            },
            provenance,
          )
          .pipe(Effect.map((draft) => ({ draft })));
      }
      const { missionId, audience, channel, target } = input;
      if (
        missionId === undefined ||
        audience === undefined ||
        channel === undefined ||
        target === undefined
      ) {
        return invalid("A new draft needs missionId, audience, channel and target.");
      }
      return asks
        .submitDraft(
          {
            missionId,
            audience,
            channel,
            target,
            text: input.text,
            ...(input.subMissionId === undefined ? {} : { subMissionId: input.subMissionId }),
            ...(input.workItemId === undefined ? {} : { workItemId: input.workItemId }),
            ...(input.view === undefined ? {} : { view: input.view }),
          },
          provenance,
        )
        .pipe(Effect.map((draft) => ({ draft })));
    }),
  ),
  mission_draft_approve: McpToolAccess.actsAsCaller((input) =>
    withCaller((asks, provenance) => asks.decideDraft(input, provenance)),
  ),
  mission_draft_route: McpToolAccess.actsAsCaller((input) =>
    withCaller((asks, provenance) =>
      asks.routeDraft(input, provenance).pipe(Effect.map((draft) => ({ draft }))),
    ),
  ),
  mission_draft_annotate: McpToolAccess.actsAsCaller((input) =>
    withCaller((asks, provenance) =>
      asks.annotateDraft(input, provenance).pipe(Effect.map((draft) => ({ draft }))),
    ),
  ),
  mission_draft_note: McpToolAccess.actsAsCaller((input) =>
    withCaller((asks, provenance) =>
      asks.saveDraftNote(input, provenance).pipe(Effect.map((note) => ({ note }))),
    ),
  ),
  mission_post: McpToolAccess.actsAsCaller((input) =>
    withCaller((asks, provenance) =>
      asks.post(input, provenance).pipe(Effect.map((message) => ({ message }))),
    ),
  ),
  mission_suggest: McpToolAccess.actsAsCaller((input) =>
    withCaller((asks, provenance) =>
      asks.proposeSuggestion(input, provenance).pipe(Effect.map((suggestion) => ({ suggestion }))),
    ),
  ),
  mission_suggestion_decide: McpToolAccess.actsAsCaller((input) =>
    withCaller((asks, provenance) =>
      asks.decideSuggestion(input, provenance).pipe(Effect.map((suggestion) => ({ suggestion }))),
    ),
  ),
  mission_draft_reopen: McpToolAccess.actsAsCaller((input) =>
    withCaller((asks, provenance) =>
      asks.reopenDraft(input, provenance).pipe(Effect.map((draft) => ({ draft }))),
    ),
  ),
  mission_draft_sent: McpToolAccess.actsAsCaller((input) =>
    withCaller((asks, provenance) =>
      asks.recordDraftSent(input, provenance).pipe(Effect.map((draft) => ({ draft }))),
    ),
  ),
  mission_draft_withdraw: McpToolAccess.actsAsCaller((input) =>
    withCaller((asks, provenance) =>
      asks.withdrawDraft(input, provenance).pipe(Effect.map((draft) => ({ draft }))),
    ),
  ),
  mission_suggestion_reopen: McpToolAccess.actsAsCaller((input) =>
    withCaller((asks, provenance) =>
      asks.reopenSuggestion(input, provenance).pipe(Effect.map((suggestion) => ({ suggestion }))),
    ),
  ),
  mission_note_ack: McpToolAccess.actsAsCaller((input) =>
    withCaller((asks, provenance) =>
      asks.ackNote(input.noteId, provenance).pipe(Effect.map((note) => ({ note }))),
    ),
  ),
  mission_sub_mission: McpToolAccess.actsAsCaller((input) =>
    asMaster(input.missionId, (missions, _asks, provenance) =>
      missions.upsertSubMission(provenance, input),
    ),
  ),
  mission_milestone: McpToolAccess.actsAsCaller((input) =>
    asMaster(input.missionId, (missions, _asks, provenance) =>
      missions.upsertMilestone(provenance, input),
    ),
  ),
  mission_lane: McpToolAccess.actsAsCaller((input) =>
    asMaster(input.missionId, (missions, asks, provenance) =>
      Effect.gen(function* () {
        const conflict = laneHoldConflict(
          input.laneId,
          input,
          yield* openAsks(asks, input.missionId),
        );
        if (conflict !== null) {
          return yield* new MissionError({ code: "conflict", detail: conflict });
        }
        return yield* missions.upsertLane(provenance, input);
      }),
    ),
  ),
  mission_work_item: McpToolAccess.actsAsCaller((input) =>
    asMaster(input.missionId, (missions, asks, provenance) =>
      Effect.gen(function* () {
        const held = keepWorkItemHolds(
          input.workItemId,
          input,
          yield* openAsks(asks, input.missionId),
        );
        return yield* missions.upsertWorkItem(provenance, held);
      }),
    ),
  ),
  mission_create: McpToolAccess.actsAsCaller(({ actingFor, ...input }) =>
    asAnyMaster(actingFor, "Only a mission's master creates missions.", (missions, provenance) =>
      missions.createMission(provenance, input),
    ),
  ),
  mission_update: McpToolAccess.actsAsCaller((input) =>
    asMaster(input.missionId, (missions, _asks, provenance) =>
      missions.updateMission(provenance, input),
    ),
  ),
  mission_set_status: McpToolAccess.actsAsCaller((input) =>
    asMaster(input.missionId, (missions, _asks, provenance) =>
      missions.setMissionStatus(provenance, input),
    ),
  ),
  mission_focus: McpToolAccess.actsAsCaller((input) =>
    asMaster(input.missionId, (missions, _asks, provenance) =>
      missions.setMissionFocus(provenance, input),
    ),
  ),
  mission_sub_mission_reorder: McpToolAccess.actsAsCaller((input) =>
    asMaster(input.missionId, (missions, _asks, provenance) =>
      missions.reorderSubMissions(provenance, input),
    ),
  ),
  mission_sub_mission_merge: McpToolAccess.actsAsCaller((input) =>
    asMaster(input.missionId, (missions, _asks, provenance) =>
      missions.mergeSubMissions(provenance, input),
    ),
  ),
  mission_lane_split: McpToolAccess.actsAsCaller((input) =>
    asMaster(input.missionId, (missions, _asks, provenance) =>
      missions.splitLane(provenance, input),
    ),
  ),
  mission_lane_merge: McpToolAccess.actsAsCaller((input) =>
    asMaster(input.missionId, (missions, asks, provenance) =>
      Effect.gen(function* () {
        const conflict = laneHoldConflict(
          input.laneId,
          { status: "retired" },
          yield* openAsks(asks, input.missionId),
        );
        if (conflict !== null) {
          return yield* new MissionError({ code: "conflict", detail: conflict });
        }
        return yield* missions.mergeLanes(provenance, input);
      }),
    ),
  ),
  mission_approvals: McpToolAccess.reads((input) =>
    withCaller(() =>
      Effect.gen(function* () {
        const missions = yield* MissionService.MissionService;
        const approvals = yield* missions.approvals({
          missionId: input.missionId,
          ...(input.status === undefined ? {} : { status: input.status }),
        });
        return { approvals };
      }),
    ),
  ),
  mission_approval_decide: McpToolAccess.actsAsCaller((input) =>
    asMaster(input.missionId, (missions, _asks, provenance) =>
      missions.decideApproval(provenance, {
        approvalId: input.approvalId,
        action: input.action,
        ...(input.note === undefined ? {} : { note: input.note }),
        ...(input.onOwnerCondition === undefined
          ? {}
          : { onOwnerCondition: input.onOwnerCondition }),
      }),
    ),
  ),
  // ardud missions: core
  mission_call_revise: McpToolAccess.actsAsCaller(({ missionId, ...input }) =>
    asMaster(missionId, (missions, _asks, provenance) => missions.reviseCall(provenance, input)),
  ),
  // ardud missions: core - portfolio order and lane nudges
  mission_portfolio_reorder: McpToolAccess.actsAsCaller(({ actingFor, order }) =>
    asAnyMaster(
      actingFor,
      "Only the owner or a mission's master sets the portfolio order.",
      (missions, provenance) => missions.setPortfolioOrder(provenance, { order }),
    ),
  ),
  mission_lane_nudge: McpToolAccess.actsAsCaller(({ missionId, laneId, note }) =>
    Effect.gen(function* () {
      const store = yield* MissionStore.MissionStore;
      const router = yield* MissionRouter;
      return yield* asMaster(missionId, (_missions, _asks, provenance) =>
        nudgeLane(
          { store, router },
          provenance,
          { laneId, ...(note === undefined ? {} : { note }) },
          missionId,
        ),
      );
    }),
  ),
  mission_approval_route: McpToolAccess.actsAsCaller((input) =>
    asMaster(input.missionId, (missions, _asks, provenance) =>
      missions.routeApproval(provenance, {
        approvalId: input.approvalId,
        approver: input.approver,
        reason: input.reason,
      }),
    ),
  ),
  mission_approval_annotate: McpToolAccess.actsAsCaller((input) =>
    asMaster(input.missionId, (missions, _asks, provenance) =>
      missions.annotateApproval(provenance, {
        approvalId: input.approvalId,
        ...(input.summary === undefined ? {} : { summary: input.summary }),
        ...(input.flags === undefined ? {} : { flags: input.flags }),
      }),
    ),
  ),
  mission_approval_routing: McpToolAccess.actsAsCaller((input) =>
    asMaster(input.missionId, (missions, _asks, provenance) =>
      missions.setApprovalRouting(provenance, input),
    ),
  ),
  mission_rule: McpToolAccess.actsAsCaller((input) =>
    withRules((rules, provenance) =>
      rules.upsertRule(provenance, input).pipe(Effect.map((rule) => ({ rule }))),
    ),
  ),
  mission_rule_use: McpToolAccess.actsAsCaller((input) =>
    withRules((rules, provenance) =>
      rules.recordRuleUse(provenance, input).pipe(Effect.map((rule) => ({ rule }))),
    ),
  ),
  mission_rule_change: McpToolAccess.actsAsCaller((input) =>
    withRules((rules, provenance) =>
      rules.requestRuleChange(provenance, input).pipe(Effect.map((request) => ({ request }))),
    ),
  ),
  mission_rule_change_resolve: McpToolAccess.actsAsCaller((input) =>
    withRules((rules, provenance) =>
      rules.resolveRuleChange(provenance, input).pipe(Effect.map((request) => ({ request }))),
    ),
  ),
  // ardud missions: core - the master declines or withdraws a member's secret card
  mission_secret_request_close: McpToolAccess.actsAsCaller((input) =>
    withCaller((_asks, provenance) =>
      Effect.gen(function* () {
        const controls = yield* MasterControls.MasterControls;
        return yield* controls.closeSecretRequest(provenance, input);
      }),
    ),
  ),
} satisfies McpToolAccess.Handlers<typeof MissionsToolkit.tools>;

export const layer = McpToolAccess.toLayer(MissionsToolkit, handlers);
