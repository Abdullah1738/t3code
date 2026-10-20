// Schemas for the shapes the fixture seeds that the contracts do not carry as
// records (routing history, rule audit, timeline). Decoding the
// seed through them keeps the data honest.
import {
  ApprovalRoute,
  Approver,
  MissionActor,
  MissionEvent,
  MissionEventKind,
  MissionId,
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
