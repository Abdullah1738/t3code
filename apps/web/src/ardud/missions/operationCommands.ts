import type {
  CriticalityTrigger,
  Lane,
  MissionId,
  ModelSelection,
  PoolId,
  Role,
  Rule,
  RuleChangeRequestId,
  RuleScope,
  SubMissionId,
} from "@t3tools/contracts";
import {
  editRuleInput,
  handOffLaneInput,
  mergeLanesInput,
  moveLaneInput,
  newRuleInput,
  nudgeLaneInput,
  removeRouteInput,
  reorderPortfolioInput,
  resolveRuleChangeInput,
  setApprovalRouteInput,
  setCriticalityGuideInput,
  setDraftRouteInput,
  setLaneParkedInput,
  setPoolCapacityInput,
  setRoleModelInput,
  setRuleStatusInput,
  splitLaneInput,
  type ApprovalRouteMatch,
  type ApprovalRoutingTable,
  type Approver,
  type DraftRouteMatch,
  type RerouteRecordInput,
} from "@t3tools/client-runtime/ardud/missions";

import { runMissionAction, submitMissionInput } from "./missionActions";
import { missionsSource } from "./missionsStore";

// Lanes, rules, roles, pools, routing and portfolio actions. Owner and master
// reach the same source methods; nothing here is owner-only. Each resolves
// true when the source took the change. Inputs are built and checked by the
// client-runtime view models.

export function nudgeLane(laneId: Lane["id"], note: string) {
  return submitMissionInput(
    nudgeLaneInput(laneId, note),
    (input) => missionsSource.nudgeLane(input),
    "Couldn't nudge the lane",
  );
}

export function handOffLane(laneId: Lane["id"], note: string) {
  return submitMissionInput(
    handOffLaneInput(laneId, note),
    (input) => missionsSource.handOffLane(input),
    "Couldn't hand the lane off",
  );
}

/** Pauses a running lane or resumes a parked one. */
export function setLaneParked(lane: Lane, parked: boolean, reason = "") {
  return runMissionAction(
    missionsSource.setLaneParked(setLaneParkedInput(lane, parked, reason)),
    parked ? "Couldn't pause the lane" : "Couldn't resume the lane",
  );
}

export function moveLane(lane: Lane, subMissionId: SubMissionId) {
  return submitMissionInput(
    moveLaneInput(lane, subMissionId),
    (input) => missionsSource.moveLane(input),
    "Couldn't move the lane",
  );
}

export function splitLane(
  lane: Lane,
  name: string,
  purpose: string,
  lanes: ReadonlyArray<Pick<Lane, "name">>,
) {
  return submitMissionInput(
    splitLaneInput(lane, name, purpose, lanes),
    (input) => missionsSource.splitLane(input),
    "Couldn't split the lane",
  );
}

export function mergeLanes(lane: Lane, into: Lane) {
  return submitMissionInput(
    mergeLanesInput(lane, into),
    (input) => missionsSource.mergeLanes(input),
    "Couldn't merge the lanes",
  );
}

export function editRule(
  rule: Rule,
  edit: {
    readonly title?: string;
    readonly quote?: string;
    readonly scope?: RuleScope;
    readonly activation?: string;
  },
) {
  return submitMissionInput(
    editRuleInput(rule, edit),
    (input) => missionsSource.upsertRule(input),
    "Couldn't save the rule",
  );
}

export function addRule(missionId: MissionId, title: string, quote: string) {
  return submitMissionInput(
    newRuleInput(missionId, title, quote),
    (input) => missionsSource.upsertRule(input),
    "Couldn't add the rule",
  );
}

export function toggleRuleRetired(rule: Rule) {
  return runMissionAction(
    missionsSource.upsertRule(setRuleStatusInput(rule)),
    rule.status === "active" ? "Couldn't retire the rule" : "Couldn't bring the rule back",
  );
}

export function resolveRuleChange(
  changeRequestId: RuleChangeRequestId,
  action: "apply" | "decline",
  response: string,
) {
  return submitMissionInput(
    resolveRuleChangeInput(changeRequestId, action, response),
    (input) => missionsSource.resolveRuleChange(input),
    action === "apply" ? "Couldn't apply the change" : "Couldn't decline the change",
  );
}

/** Takes effect on the role's next turn. */
export function setRoleModel(role: Role, modelSelection: ModelSelection, reason: string) {
  return submitMissionInput(
    setRoleModelInput(role, modelSelection, reason),
    (input) => missionsSource.setRoleModel(input),
    "Couldn't change the model",
  );
}

export function setCriticalityGuide(
  missionId: MissionId,
  text: string,
  hardTriggers?: ReadonlyArray<CriticalityTrigger>,
) {
  return submitMissionInput(
    setCriticalityGuideInput(missionId, text, hardTriggers),
    (input) => missionsSource.setCriticalityGuide(input),
    "Couldn't save the guide",
  );
}

export function setPoolCapacity(poolId: PoolId, capacity: string, reason: string) {
  return submitMissionInput(
    setPoolCapacityInput(poolId, capacity, reason),
    (input) => missionsSource.setPoolCapacity(input),
    "Couldn't change the capacity",
  );
}

let nextRouteId = 0;
const newRouteId = () => `route-${Date.now().toString(36)}-${nextRouteId++}`;

export function setDraftRoute(
  table: ApprovalRoutingTable,
  match: DraftRouteMatch,
  approver: Approver,
) {
  return submitMissionInput(
    setDraftRouteInput(table, match, approver, newRouteId),
    (input) => missionsSource.setApprovalRouting(input),
    "Couldn't change the routing",
  );
}

export function setApprovalRoute(
  table: ApprovalRoutingTable,
  match: ApprovalRouteMatch,
  approver: Approver,
) {
  return submitMissionInput(
    setApprovalRouteInput(table, match, approver, newRouteId),
    (input) => missionsSource.setApprovalRouting(input),
    "Couldn't change the routing",
  );
}

export function removeRoute(table: ApprovalRoutingTable, ruleId: string) {
  return submitMissionInput(
    removeRouteInput(table, ruleId),
    (input) => missionsSource.setApprovalRouting(input),
    "Couldn't remove the rule",
  );
}

export function movePortfolioMission(
  order: ReadonlyArray<MissionId>,
  missionId: MissionId,
  overId: MissionId,
) {
  return submitMissionInput(
    reorderPortfolioInput(order, missionId, overId),
    (input) => missionsSource.setPortfolioOrder(input),
    "Couldn't change the order",
  );
}

/** Moves one pending draft or approval to the other inbox. Needs a reason; it is logged. */
export function rerouteRecord(
  kind: RerouteRecordInput["kind"],
  id: string,
  approver: Approver,
  reason: string,
) {
  const trimmed = reason.trim();
  return submitMissionInput(
    trimmed
      ? { ok: true as const, value: { kind, id, approver, reason: trimmed } }
      : { ok: false as const, error: "Say why it should move." },
    (input) => missionsSource.rerouteRecord(input),
    "Couldn't move it",
  );
}
