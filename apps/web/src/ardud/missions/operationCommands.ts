import type {
  ApprovalRouteMatch,
  Approver,
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
  ThreadAttachmentState,
  ThreadId,
} from "@t3tools/contracts";
import {
  editRuleInput,
  handOffLaneInput,
  mergeLanesInput,
  moveLaneInput,
  newRuleInput,
  nudgeLaneInput,
  flipRouteInput,
  removeRouteInput,
  reorderPortfolioInput,
  rerouteRecordInput,
  resolveRuleChangeInput,
  setCriticalityGuideInput,
  setLaneParkedInput,
  setRouteInput,
  setPoolCapacityInput,
  setRoleModelInput,
  setRuleStatusInput,
  splitLaneInput,
  type ApprovalRoutingTable,
  type RerouteRecordInput,
} from "@t3tools/client-runtime/ardud/missions";

import { toastManager } from "../../components/ui/toast";
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

/** Sets who one match goes to: changes the row that matches it or adds one. */
export function setRoute(
  table: ApprovalRoutingTable,
  match: ApprovalRouteMatch,
  approver: Approver,
) {
  return submitMissionInput(
    setRouteInput(table, match, approver, newRouteId),
    (input) => missionsSource.setApprovalRouting(input),
    "Couldn't change the routing",
  );
}

export function flipRoute(table: ApprovalRoutingTable, routeId: string) {
  return submitMissionInput(
    flipRouteInput(table, routeId),
    (input) => missionsSource.setApprovalRouting(input),
    "Couldn't change the routing",
  );
}

export function removeRoute(table: ApprovalRoutingTable, routeId: string) {
  return submitMissionInput(
    removeRouteInput(table, routeId),
    (input) => missionsSource.setApprovalRouting(input),
    "Couldn't remove the row",
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
  record: { readonly id: string; readonly approver?: Approver | undefined },
  approver: Approver,
  reason: string,
) {
  return submitMissionInput(
    rerouteRecordInput(kind, record, approver, reason),
    (input) => missionsSource.rerouteRecord(input),
    "Couldn't move it",
  );
}

/**
 * Sends a wrong attachment back to the ordinary thread list. The toast puts it
 * back the way it was; the component that attached it can also attach it again.
 */
export async function detachThread(
  missionId: MissionId,
  thread: { readonly threadId: ThreadId; readonly title: string },
  restore: Exclude<ThreadAttachmentState, "detached">,
) {
  const move = (state: ThreadAttachmentState) =>
    missionsSource.setThreadAttachment({ missionId, threadId: thread.threadId, state });
  const done = await runMissionAction(move("detached"), "Couldn't detach the thread");
  if (!done) return false;
  const id = toastManager.add({
    type: "info",
    title: `Detached ${thread.title}`,
    actionProps: {
      children: "Undo",
      onClick: () => {
        toastManager.close(id);
        void runMissionAction(move(restore), "Couldn't put the thread back");
      },
    },
  });
  return true;
}
