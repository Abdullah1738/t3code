// Schemas for the shapes the fixture seeds that the contracts do not carry as
// records (routing history, rule audit, recovery, timeline). Decoding the
// seed through them keeps the data honest.
import {
  ApprovalRoute,
  Approver,
  LaneId,
  MissionActor,
  MissionEvent,
  MissionEventKind,
  MissionId,
  PoolHoldId,
  RoleId,
  RuleId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { PROPOSED_MISSION_EVENT_KINDS } from "../source.ts";

export const TimelineEventSeed = Schema.Struct({
  ...MissionEvent.fields,
  kind: Schema.Union([MissionEventKind, Schema.Literals(PROPOSED_MISSION_EVENT_KINDS)]),
});

/** A routing table as of `updatedAt`; the fixture keeps the older versions to route seeded records. */
export const RoutingTableSeed = Schema.Struct({
  missionId: MissionId,
  routes: Schema.Array(ApprovalRoute),
  updatedAt: Schema.String,
});

export const RerouteSeed = Schema.Struct({
  kind: Schema.Literals(["draft", "approval"]),
  id: Schema.String,
  approver: Approver,
  reason: Schema.String,
  at: Schema.String,
});

export const RuleAuditSeed = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["conflict", "stale"]),
  ruleIds: Schema.Array(RuleId),
  note: Schema.String,
  foundBy: MissionActor,
  at: Schema.String,
});

export const RecoveryIncidentSeed = Schema.Struct({
  id: Schema.String,
  cause: Schema.Literals(["server-restart", "opencode-restart", "run-interrupted", "succession"]),
  detectedAt: Schema.String,
  window: Schema.Struct({ from: Schema.String, to: Schema.String }),
  missionIds: Schema.Array(MissionId),
  members: Schema.Array(
    Schema.Struct({
      roleId: Schema.NullOr(RoleId),
      laneId: Schema.NullOr(LaneId),
      threadId: Schema.String,
      cutRunId: Schema.NullOr(Schema.String),
      lastActivityAt: Schema.NullOr(Schema.String),
      lostChildren: Schema.Array(
        Schema.Struct({
          title: Schema.String,
          sessionId: Schema.NullOr(Schema.String),
          kind: Schema.Literals(["native-subagent", "delegated-task"]),
          lastStatus: Schema.String,
          doing: Schema.String,
        }),
      ),
      holds: Schema.Array(PoolHoldId),
      action: Schema.Literals(["resume", "notice-only", "reconcile-first", "skip"]),
      why: Schema.String,
      state: Schema.Literals(["pending", "resumed", "decided"]),
      settledAt: Schema.NullOr(Schema.String),
    }),
  ),
  resumesPerMinute: Schema.Number,
  status: Schema.Literals(["open", "cleared"]),
});
