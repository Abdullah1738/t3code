import * as Schema from "effect/Schema";
import { GitPreparePullRequestThreadInput } from "./git.ts";
import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  type AuthEnvironmentScope,
} from "./auth.ts";
import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { WS_METHODS } from "./rpc.ts";
// ardud missions: policy
import { MISSIONS_POLICY_GUARDED_SCOPES } from "./ardud/missionsPolicyRpc.ts";
// ardud missions: asks
import { MISSIONS_ASKS_GUARDED_SCOPES } from "./ardud/missionsAsksRpc.ts";

/** Incremental client enforcement; the server still authorizes every request. */
export const CLIENT_GUARDED_RPC_SCOPES = {
  [WS_METHODS.serverRunStorageCleanup]: AuthSettingsWriteScope,
  // Endpoint checks exist to configure exports, so they need the same grant as saving them.
  [WS_METHODS.serverCheckOtlpEndpoint]: AuthSettingsWriteScope,
  [WS_METHODS.pullRequestsRunAction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdate]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdateComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSubmitReview]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsReplyToThread]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetThreadResolution]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetReaction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetFilesViewed]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsRequestReviewers]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetLabels]: AuthSourceControlWriteScope,
  // Writing a guide runs a model on this environment's providers, which reading one does not.
  [WS_METHODS.pullRequestsGenerateReviewGuide]: AuthOrchestrationOperateScope,
  [WS_METHODS.sourceControlCloneRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlPublishRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneStart]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneCancel]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneRetry]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPull]: AuthSourceControlWriteScope,
  [WS_METHODS.gitRunStackedAction]: AuthSourceControlWriteScope,
  [WS_METHODS.gitPreparePullRequestThread]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsRemoveWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsSwitchRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsInit]: AuthSourceControlWriteScope,

  [WS_METHODS.scheduledTasksUpsert]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksSetEnabled]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRunNow]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRotateWebhookToken]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.stopWorkflow]: AuthOrchestrationOperateScope,
  // ardud missions: core
  [WS_METHODS.missionsCreate]: AuthOrchestrationOperateScope,
  [WS_METHODS.missionsUpdate]: AuthOrchestrationOperateScope,
  [WS_METHODS.missionsSetStatus]: AuthOrchestrationOperateScope,
  [WS_METHODS.missionsSetFocus]: AuthOrchestrationOperateScope,
  [WS_METHODS.missionsSetSubMissionStatus]: AuthOrchestrationOperateScope,
  [WS_METHODS.missionsReorderSubMissions]: AuthOrchestrationOperateScope,
  [WS_METHODS.missionsMarkSeen]: AuthOrchestrationOperateScope,
  // ardud missions: policy
  ...MISSIONS_POLICY_GUARDED_SCOPES,
  // ardud missions: asks
  ...MISSIONS_ASKS_GUARDED_SCOPES,
  [WS_METHODS.missionsUpsertSubMission]: AuthOrchestrationOperateScope,
  [WS_METHODS.missionsMergeSubMissions]: AuthOrchestrationOperateScope,
  [WS_METHODS.missionsUpsertLane]: AuthOrchestrationOperateScope,
  [WS_METHODS.missionsSplitLane]: AuthOrchestrationOperateScope,
  [WS_METHODS.missionsMergeLanes]: AuthOrchestrationOperateScope,
  [WS_METHODS.missionsDecideApproval]: AuthOrchestrationOperateScope,
  [WS_METHODS.missionsRouteApproval]: AuthOrchestrationOperateScope,
  [WS_METHODS.missionsSetApprovalRouting]: AuthOrchestrationOperateScope,
  [WS_METHODS.missionsUpsertRule]: AuthOrchestrationOperateScope,
  [WS_METHODS.missionsRequestRuleChange]: AuthOrchestrationOperateScope,
  [WS_METHODS.missionsResolveRuleChange]: AuthOrchestrationOperateScope,
  [WS_METHODS.missionsAnswerAsk]: AuthOrchestrationOperateScope,
  [WS_METHODS.missionsWithdrawAsk]: AuthOrchestrationOperateScope,
  [WS_METHODS.missionsReopenAsk]: AuthOrchestrationOperateScope,
  [WS_METHODS.missionsReactToCall]: AuthOrchestrationOperateScope,
  [WS_METHODS.missionsDecideDraft]: AuthOrchestrationOperateScope,
  [WS_METHODS.missionsReopenDraft]: AuthOrchestrationOperateScope,
  [WS_METHODS.missionsSaveDraftNote]: AuthOrchestrationOperateScope,
  [WS_METHODS.missionsDecideSuggestion]: AuthOrchestrationOperateScope,
  [WS_METHODS.missionsReopenSuggestion]: AuthOrchestrationOperateScope,
  [WS_METHODS.missionsStartFork]: AuthOrchestrationOperateScope,
  [WS_METHODS.missionsCloseFork]: AuthOrchestrationOperateScope,
  [WS_METHODS.missionsUpdateFork]: AuthOrchestrationOperateScope,
  [WS_METHODS.missionsAckNote]: AuthOrchestrationOperateScope,
  // ardud missions: router
  [WS_METHODS.missionsPostMessage]: AuthOrchestrationOperateScope,
  [WS_METHODS.missionsMarkRead]: AuthOrchestrationOperateScope,
  [WS_METHODS.missionsSubscribeRoom]: AuthOrchestrationOperateScope,
  [WS_METHODS.missionsSetMember]: AuthOrchestrationOperateScope,
  [WS_METHODS.missionsDecideKnock]: AuthOrchestrationOperateScope,
} as const;
export type ClientGuardedRpcTag = keyof typeof CLIENT_GUARDED_RPC_SCOPES;

const decodePrepareThread = Schema.decodeUnknownSync(GitPreparePullRequestThreadInput);

export function clientRpcRequiredScopes(
  method: string,
  input: unknown,
): readonly AuthEnvironmentScope[] {
  if (method === WS_METHODS.gitPreparePullRequestThread && input !== undefined) {
    const payload = decodePrepareThread(input);
    if (payload.mode === "worktree" && payload.threadId !== undefined)
      return [AuthSourceControlWriteScope, AuthOrchestrationOperateScope];
  }
  return Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, method)
    ? [CLIENT_GUARDED_RPC_SCOPES[method as ClientGuardedRpcTag]]
    : [];
}
