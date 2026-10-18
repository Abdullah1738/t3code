import {
  MissionId,
  MissionError,
  MissionRecoverySettings,
  MissionRecoveryStatus,
  OrchestratorMcpFailure,
  RecoveryResumeInput,
  RecoverySettingsInput,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { RecoveryService } from "../recovery/RecoveryService.ts";
import { callerProvenance } from "./handlers.ts";

/**
 * Restart recovery tools. After a restart or a cut run the master gets one
 * summary first; these let it see the plan and steer it (resume a lane now,
 * hold one, skip one, reorder, add an instruction, change the pace). The
 * owner gets the same through the service. Only the master's thread may
 * change anything; the caller comes from the invocation, never parameters.
 */
const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  RecoveryService,
];

const RecoveryStatusTool = Tool.make("mission_recovery_status", {
  description:
    "A mission's restart recovery: the latest incident (cause, window, every affected thread with its lane, cut run, lost background children, pool holds, planned action and whether its notice went out) and the resume pace.",
  parameters: Schema.Struct({ missionId: MissionId }),
  success: MissionRecoveryStatus,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
});

const RecoveryResumeTool = Tool.make("mission_recovery_resume", {
  description:
    "Master only. Steer the open recovery: mode now (send this thread's or lane's notice next, right away if idle), hold (keep it unsent), release (let held threads go; all of them without a target), skip (it needs no resume), order (resume in the given thread order). instruction adds a line to a notice not yet sent.",
  parameters: RecoveryResumeInput,
  success: MissionRecoveryStatus,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
});

const RecoverySettingsTool = Tool.make("mission_recovery_settings", {
  description:
    "Master only. Recovery pace for this mission: resumePerMinute (lane notices per minute, default 4) and masterLeadSeconds (how long lanes wait after the master's summary, default 60).",
  parameters: RecoverySettingsInput,
  success: MissionRecoverySettings,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
});

interface ToolConfig {
  readonly parameters: Schema.Constraint;
  readonly success: Schema.Constraint;
  readonly failure: Schema.Constraint;
  readonly failureMode: Tool.FailureMode;
}

const annotated = <Name extends string, Config extends ToolConfig, R>(
  tool: Tool.Tool<Name, Config, R>,
  title: string,
  readonly: boolean,
) =>
  tool
    .annotate(Tool.Title, title)
    .annotate(Tool.Readonly, readonly)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, readonly)
    .annotate(Tool.OpenWorld, false)
    .annotate(Tool.Strict, true);

export const RecoveryToolkit = Toolkit.make(
  annotated(RecoveryStatusTool, "Mission recovery status", true),
  annotated(RecoveryResumeTool, "Steer mission recovery", false),
  annotated(RecoverySettingsTool, "Mission recovery pace", false),
);

const REFUSALS: ReadonlySet<MissionError["code"]> = new Set([
  "forbidden",
  "provenance-required",
  "provenance-invalid",
  "locked",
]);

const toolFailure = (error: MissionError) =>
  new OrchestratorMcpFailure({
    code: REFUSALS.has(error.code) ? "capability_denied" : "invalid_request",
    message: error.message,
  });

const withRecovery = <A>(
  run: (
    recovery: RecoveryService["Service"],
    scope: McpInvocationContext.McpInvocationScope,
  ) => Effect.Effect<A, MissionError>,
) =>
  Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const recovery = yield* RecoveryService;
    return yield* run(recovery, scope);
  }).pipe(Effect.catchTags({ MissionError: (error) => Effect.fail(toolFailure(error)) }));

const handlers = {
  mission_recovery_status: McpToolAccess.reads((input) =>
    withRecovery((recovery) => recovery.status(input.missionId)),
  ),
  mission_recovery_resume: McpToolAccess.actsAsCaller((input) =>
    withRecovery((recovery, scope) => recovery.resume(callerProvenance(scope), input)),
  ),
  mission_recovery_settings: McpToolAccess.actsAsCaller((input) =>
    withRecovery((recovery, scope) => recovery.setSettings(callerProvenance(scope), input)),
  ),
} satisfies McpToolAccess.Handlers<typeof RecoveryToolkit.tools>;

export const layer = McpToolAccess.toLayer(RecoveryToolkit, handlers);
