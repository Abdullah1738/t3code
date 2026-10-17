import { MissionError, OrchestratorMcpFailure, type MissionProvenance } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import * as AsksService from "../asks/AsksService.ts";
import { watchAddCommand, watchCheckCommand } from "../asks/watch.ts";
import { MissionsToolkit } from "./tools.ts";

/** The `mission` CLI as robob-watch checks call it (on PATH once installed). */
const MISSION_CLI = "mission";

const REFUSALS: ReadonlySet<MissionError["code"]> = new Set([
  "forbidden",
  "provenance-required",
  "provenance-invalid",
  "locked",
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
 * agent (the service resolves its roles, lanes and forks); a signed-in MCP
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

const withCaller = <A>(
  run: (
    asks: AsksService.AsksService["Service"],
    provenance: MissionProvenance,
  ) => Effect.Effect<A, MissionError | OrchestratorMcpFailure>,
) =>
  Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const asks = yield* AsksService.AsksService;
    return yield* run(asks, callerProvenance(scope));
  }).pipe(Effect.catchTags({ MissionError: (error) => Effect.fail(toolFailure(error)) }));

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
          inboundId: input.inboundId,
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
          .reviseDraft({ draftId: input.draftId, text: input.text }, provenance)
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
        .submitDraft({ missionId, audience, channel, target, text: input.text }, provenance)
        .pipe(Effect.map((draft) => ({ draft })));
    }),
  ),
  mission_draft_approve: McpToolAccess.actsAsCaller((input) =>
    withCaller((asks, provenance) => asks.decideDraft(input, provenance)),
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
  mission_fork: McpToolAccess.actsAsCaller((input) =>
    withCaller((asks, provenance) =>
      asks
        .startFork(
          {
            missionId: input.missionId,
            kind: "dev-question",
            origin: input.origin ?? null,
            question: input.question,
          },
          provenance,
        )
        .pipe(Effect.map(({ fork, delivered }) => ({ fork, delivered }))),
    ),
  ),
  mission_fork_close: McpToolAccess.actsAsCaller((input) =>
    withCaller((asks, provenance) =>
      asks
        .closeFork({ forkId: input.forkId, summaryLine: input.summaryLine }, provenance)
        .pipe(Effect.map(({ fork, delivered }) => ({ fork, delivered }))),
    ),
  ),
  mission_note_ack: McpToolAccess.actsAsCaller((input) =>
    withCaller((asks, provenance) =>
      asks.ackNote(input.noteId, provenance).pipe(Effect.map((note) => ({ note }))),
    ),
  ),
} satisfies McpToolAccess.Handlers<typeof MissionsToolkit.tools>;

export const layer = McpToolAccess.toLayer(MissionsToolkit, handlers);
