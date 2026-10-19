import type {
  ContextGauge,
  Lane,
  LaneId,
  LaneStatus,
  MergeLanesInput,
  ModelSelection,
  Role,
  RoleBinding,
  SplitLaneInput,
  SubMission,
  SubMissionId,
  WorkItem,
} from "@t3tools/contracts";

import type {
  HandOffLaneInput,
  MoveLaneInput,
  NudgeLaneInput,
  SetLaneParkedInput,
} from "./source.ts";
import { formatPercent, sortLanesProblemsFirst, splitQuietLanes } from "./viewModel.ts";

// Lanes tab: one row per lane with its lead role, model, context gauge, the
// item it is on, its last evidence and who led it before. Problems first;
// idle and parked lanes fold behind a count.

type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const err = <T>(error: string): Result<T> => ({ ok: false, error });

/** "opus/claude-opus-5-5 xhigh": the model plus its variant option when set. */
export function modelLabel(selection: ModelSelection | null): string | null {
  if (selection === null) return null;
  const options = Array.isArray(selection.options) ? selection.options : [];
  const variant = options.find((option) => option.id === "variant")?.value;
  return typeof variant === "string" ? `${selection.model} ${variant}` : selection.model;
}

/** "212K", "1M", "1.2M". */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = Math.round(tokens / 100_000) / 10;
    return `${Number.isInteger(millions) ? millions.toFixed(0) : millions.toFixed(1)}M`;
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

export type ContextTone = "ok" | "tight" | "full";

/** Context fill at which a lane reads as tight, and as due for a handoff. UI thresholds. */
export const CONTEXT_TIGHT_SHARE = 0.6;
export const CONTEXT_FULL_SHARE = 0.85;

export interface ContextView {
  readonly share: number;
  readonly tone: ContextTone;
  /** "212K of 1M (21%)" */
  readonly label: string;
  /** "1 handoff so far", or null before the first one. */
  readonly successionLine: string | null;
}

export function contextView(context: ContextGauge | null): ContextView | null {
  if (context === null) return null;
  const share = Math.min(1, context.promptTokens / context.limitTokens);
  const tone: ContextTone =
    share >= CONTEXT_FULL_SHARE ? "full" : share >= CONTEXT_TIGHT_SHARE ? "tight" : "ok";
  const label = `${formatTokens(context.promptTokens)} of ${formatTokens(context.limitTokens)} (${formatPercent(share)})`;
  const successionLine =
    context.successions === 0
      ? null
      : `${context.successions} ${context.successions === 1 ? "handoff" : "handoffs"} so far`;
  return { share, tone, label, successionLine };
}

export interface LaneRow {
  readonly lane: Lane;
  readonly subMissionTitle: string | null;
  readonly role: Role | null;
  readonly model: string | null;
  /** The model the lead switches to on its next turn, when a change is pending. */
  readonly pendingModel: string | null;
  readonly context: ContextView | null;
  readonly currentItem: WorkItem | null;
  /** Earlier lead threads, newest first. */
  readonly successions: ReadonlyArray<RoleBinding>;
}

export interface LaneRowSources {
  readonly roles: ReadonlyArray<Role>;
  readonly bindings: ReadonlyArray<RoleBinding>;
  readonly workItems: ReadonlyArray<WorkItem>;
  readonly subMissions: ReadonlyArray<Pick<SubMission, "id" | "title">>;
}

/** Ended lead bindings of a role, newest first. */
export function successionHistory(
  roleId: string | null,
  bindings: ReadonlyArray<RoleBinding>,
): RoleBinding[] {
  if (roleId === null) return [];
  return bindings
    .filter((binding) => binding.roleId === roleId && binding.endedAt !== null)
    .sort((left, right) => (right.endedAt ?? "").localeCompare(left.endedAt ?? ""));
}

export function laneRows(lanes: ReadonlyArray<Lane>, sources: LaneRowSources): LaneRow[] {
  const roles = new Map(sources.roles.map((role) => [role.id as string, role]));
  const items = new Map(sources.workItems.map((item) => [item.id as string, item]));
  const titles = new Map(sources.subMissions.map((sub) => [sub.id as string, sub.title]));
  return lanes.map((lane) => {
    const role = lane.leadRoleId ? (roles.get(lane.leadRoleId) ?? null) : null;
    return {
      lane,
      subMissionTitle: lane.subMissionId ? (titles.get(lane.subMissionId) ?? null) : null,
      role,
      model: modelLabel(role?.modelSelection ?? null),
      pendingModel: modelLabel(role?.pendingModelSelection ?? null),
      context: contextView(lane.context),
      currentItem: lane.currentItemId ? (items.get(lane.currentItemId) ?? null) : null,
      successions: successionHistory(role?.id ?? null, sources.bindings),
    };
  });
}

export const LANE_STATUS_LABEL: Record<LaneStatus, string> = {
  stuck: "Stuck",
  waiting: "Waiting",
  working: "Working",
  idle: "Idle",
  parked: "Parked",
  retired: "Retired",
};

export interface LaneGroup {
  readonly status: LaneStatus;
  readonly label: string;
  readonly rows: ReadonlyArray<LaneRow>;
}

export interface LaneGroups {
  /** Stuck, waiting, working, in that order; empty groups dropped. */
  readonly shown: ReadonlyArray<LaneGroup>;
  /** Idle then parked, folded behind `quietLine`. */
  readonly quiet: ReadonlyArray<LaneGroup>;
  /** "14 quiet lanes: 9 idle, 5 parked", or null when there are none. */
  readonly quietLine: string | null;
}

/** Rows arrive sorted, so a status's rows are contiguous; Map keeps first-seen order. */
function groupByStatus(rows: ReadonlyArray<LaneRow>): LaneGroup[] {
  const byStatus = new Map<LaneStatus, LaneRow[]>();
  for (const row of rows) {
    const group = byStatus.get(row.lane.status);
    if (group) group.push(row);
    else byStatus.set(row.lane.status, [row]);
  }
  return [...byStatus].map(([status, statusRows]) => ({
    status,
    label: LANE_STATUS_LABEL[status],
    rows: statusRows,
  }));
}

/** Problems first; within a status, the most recently active first. Retired lanes are left out. */
export function laneGroups(rows: ReadonlyArray<LaneRow>): LaneGroups {
  const sorted = sortLanesProblemsFirst(rows.map((row) => ({ ...row.lane, row }))).map(
    (entry) => entry.row,
  );
  const { active, quiet } = splitQuietLanes(
    sorted.map((row) => ({ status: row.lane.status, row })),
  );
  const quietGroups = groupByStatus(quiet.map((entry) => entry.row));
  const quietLine =
    quiet.length === 0
      ? null
      : `${quiet.length} quiet ${quiet.length === 1 ? "lane" : "lanes"}: ${quietGroups
          .map((group) => `${group.rows.length} ${group.label.toLowerCase()}`)
          .join(", ")}`;
  return {
    shown: groupByStatus(active.map((entry) => entry.row)),
    quiet: quietGroups,
    quietLine,
  };
}

export type LaneActionId = "nudge" | "hand-off" | "park" | "resume" | "move" | "split" | "merge";

export interface LaneAction {
  readonly id: LaneActionId;
  readonly label: string;
  /** Why the action can't run on this lane, or null when it can. */
  readonly unavailable: string | null;
}

/** What the owner (or the master) can do to a lane right now. */
export function laneActions(lane: Lane): LaneAction[] {
  const retired = lane.status === "retired" ? "The lane is retired." : null;
  const parked = lane.status === "parked";
  return [
    {
      id: "nudge",
      label: "Nudge",
      unavailable: retired ?? (parked ? "Resume the lane before nudging it." : null),
    },
    {
      id: "hand-off",
      label: "Hand off",
      unavailable:
        retired ??
        (lane.leadRoleId === null || lane.threadId === null
          ? "No lead thread is bound to this lane."
          : null),
    },
    parked
      ? { id: "resume", label: "Resume", unavailable: null }
      : { id: "park", label: "Pause", unavailable: retired },
    { id: "move", label: "Move to sub-mission", unavailable: retired },
    { id: "split", label: "Split", unavailable: retired },
    { id: "merge", label: "Merge into", unavailable: retired },
  ];
}

const required = (text: string, message: string): Result<string> => {
  const trimmed = text.trim();
  return trimmed ? ok(trimmed) : err(message);
};

/** A blank note is a plain nudge: the lane lead looks again at what it holds. */
export function nudgeLaneInput(laneId: LaneId, note: string): Result<NudgeLaneInput> {
  const text = note.trim();
  return ok(text.length > 0 ? { laneId, note: text } : { laneId });
}

export function handOffLaneInput(laneId: LaneId, note: string): Result<HandOffLaneInput> {
  const checked = required(note, "Write the handoff note for the fresh thread.");
  return checked.ok ? ok({ laneId, note: checked.value }) : checked;
}

/** `parked` is what the person asked for, so a lane that changed meanwhile isn't flipped back. */
export function setLaneParkedInput(
  lane: Pick<Lane, "id" | "missionId">,
  parked: boolean,
  reason: string,
): SetLaneParkedInput {
  const trimmed = reason.trim();
  return parked && trimmed
    ? { missionId: lane.missionId, laneId: lane.id, parked, reason: trimmed }
    : { missionId: lane.missionId, laneId: lane.id, parked };
}

export function moveLaneInput(lane: Lane, subMissionId: SubMissionId): Result<MoveLaneInput> {
  if (lane.subMissionId === subMissionId) return err("The lane is already in that sub-mission.");
  return ok({ missionId: lane.missionId, laneId: lane.id, subMissionId });
}

export function splitLaneInput(
  lane: Lane,
  name: string,
  purpose: string,
  lanes: ReadonlyArray<Pick<Lane, "name">>,
): Result<SplitLaneInput> {
  const trimmed = name.trim();
  if (!trimmed) return err("Name the new lane.");
  if (lanes.some((other) => other.name.toLowerCase() === trimmed.toLowerCase())) {
    return err(`There is already a lane called ${trimmed}.`);
  }
  return ok({ missionId: lane.missionId, laneId: lane.id, name: trimmed, purpose: purpose.trim() });
}

/** Lanes `lane` can merge into: same mission, not itself, not retired. */
export function mergeTargets(lane: Lane, lanes: ReadonlyArray<Lane>): Lane[] {
  return lanes.filter(
    (other) =>
      other.id !== lane.id && other.missionId === lane.missionId && other.status !== "retired",
  );
}

export function mergeLanesInput(lane: Lane, into: Lane): Result<MergeLanesInput> {
  if (into.id === lane.id) return err("Pick another lane to merge into.");
  if (into.missionId !== lane.missionId) return err("Lanes merge only within one mission.");
  if (into.status === "retired") return err(`${into.name} is retired.`);
  return ok({ missionId: lane.missionId, laneId: lane.id, intoLaneId: into.id });
}
