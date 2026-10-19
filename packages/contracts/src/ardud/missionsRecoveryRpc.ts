/**
 * WebSocket RPCs for mission recovery in the app: the status read plus the
 * owner's resume and settings changes. Their own group so the recovery track
 * implements them in a separate handler set; `rpc.ts` adds the scope
 * middleware and merges the group into `WsRpcGroup`. The read needs
 * `orchestration:read`; writes need `orchestration:operate` and a paired owner
 * session (the master changes recovery through its MCP tools instead).
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
} from "../auth.ts";
import {
  MissionError,
  MissionId,
  MissionRecoverySettings,
  MissionRecoveryStatus,
  RecoveryResumeInput,
  RecoverySettingsInput,
} from "./missions.ts";

export const MISSIONS_RECOVERY_WS_METHODS = {
  status: "missions.recovery.status",
  resume: "missions.recovery.resume",
  settings: "missions.recovery.settings",
} as const;

type RecoveryMethod =
  (typeof MISSIONS_RECOVERY_WS_METHODS)[keyof typeof MISSIONS_RECOVERY_WS_METHODS];

const RecoveryRpcError = Schema.Union([MissionError, EnvironmentAuthorizationError]);

const call = <const Tag extends RecoveryMethod, P extends Schema.Top, S extends Schema.Top>(
  tag: Tag,
  payload: P,
  success: S,
) => Rpc.make(tag, { payload, success, error: RecoveryRpcError });

const M = MISSIONS_RECOVERY_WS_METHODS;

export const MissionsRecoveryRpcs = RpcGroup.make(
  /** Settings, overview badge and the latest incident that touched the mission. */
  call(M.status, Schema.Struct({ missionId: MissionId }), MissionRecoveryStatus),
  /** Resume now, hold, release, skip, reorder, or add an instruction. */
  call(M.resume, RecoveryResumeInput, MissionRecoveryStatus),
  call(M.settings, RecoverySettingsInput, MissionRecoverySettings),
);

/** Reads: any client allowed to read orchestration state. */
export const MISSIONS_RECOVERY_READ_SCOPES = {
  [M.status]: AuthOrchestrationReadScope,
} as const;

/** Writes: guarded on the client too (see `CLIENT_GUARDED_RPC_SCOPES`). */
export const MISSIONS_RECOVERY_GUARDED_SCOPES = {
  [M.resume]: AuthOrchestrationOperateScope,
  [M.settings]: AuthOrchestrationOperateScope,
} as const;

/** Trace aggregate label for every recovery RPC. */
export const MISSIONS_RECOVERY_AGGREGATES = Object.fromEntries(
  Object.values(MISSIONS_RECOVERY_WS_METHODS).map((method) => [method, "missions"]),
) as { readonly [K in RecoveryMethod]: "missions" };
