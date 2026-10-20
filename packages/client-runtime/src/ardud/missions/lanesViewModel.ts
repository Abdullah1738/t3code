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
import type { SummaryPart } from "./portfolioViewModel.ts";
import { formatPercent, sortLanesProblemsFirst } from "./viewModel.ts";

// Lanes tab: one row per lane with its lead role, model, context gauge, the
// item it is on, its last evidence and who led it before, grouped into the
// Desk board's panels.

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
  /** The handoff note the current lead thread started from. */
  readonly resumeNote: string | null;
  /** Who the lane answers to: its sub-mission's coordinator, else the master. */
  readonly leadName: string;
}

export interface LaneRowSources {
  readonly roles: ReadonlyArray<Role>;
  readonly bindings: ReadonlyArray<RoleBinding>;
  readonly workItems: ReadonlyArray<WorkItem>;
  readonly subMissions: ReadonlyArray<
    Pick<SubMission, "id" | "title"> & Partial<Pick<SubMission, "coordinatorRoleId">>
  >;
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
  const subs = new Map(sources.subMissions.map((sub) => [sub.id as string, sub]));
  const titles = new Map(sources.subMissions.map((sub) => [sub.id as string, sub.title]));
  const leadOf = (lane: Lane): string => {
    const coordinator = lane.subMissionId
      ? (subs.get(lane.subMissionId)?.coordinatorRoleId ?? null)
      : null;
    const role = coordinator ? roles.get(coordinator) : undefined;
    return role && role.kind !== "master" ? role.name : "Master";
  };
  return lanes.map((lane) => {
    const role = lane.leadRoleId ? (roles.get(lane.leadRoleId) ?? null) : null;
    const current = role
      ? sources.bindings.find((binding) => binding.roleId === role.id && binding.endedAt === null)
      : undefined;
    return {
      resumeNote: current?.handoffNote?.trim() || null,
      leadName: leadOf(lane),
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

// --- Desk board ---

/** "Opus", "Haiku", "Sonnet"; other models keep their own name. */
export function modelFamily(selection: ModelSelection | null): string | null {
  if (selection === null) return null;
  const name = selection.model.split("/").at(-1) ?? selection.model;
  const family = /opus|sonnet|haiku/i.exec(name)?.[0];
  return family ? family[0]!.toUpperCase() + family.slice(1).toLowerCase() : name;
}

export type LaneGrouping = "state" | "sub-mission" | "lead";

export interface LanePanel {
  readonly key: string;
  readonly title: string;
  readonly rows: ReadonlyArray<LaneRow>;
  /** Rows shown before the fold. */
  readonly shown: number;
  /** "28 more parked, 9 retired"; null uses the plain "N more". */
  readonly restLabel: string | null;
}

export interface LaneBoard {
  /** "79 live: 7 waiting, 17 working, 25 idle. 30 parked, 9 retired." */
  readonly summary: ReadonlyArray<SummaryPart>;
  readonly panels: ReadonlyArray<LanePanel>;
}

const activeAt = (row: LaneRow): string => row.lane.lastActiveAt ?? row.lane.updatedAt;
const longestFirst = (rows: LaneRow[]): LaneRow[] =>
  rows.sort((left, right) => activeAt(left).localeCompare(activeAt(right)));
const latestFirst = (rows: LaneRow[]): LaneRow[] =>
  rows.sort((left, right) => activeAt(right).localeCompare(activeAt(left)));

function laneSummary(rows: ReadonlyArray<LaneRow>): SummaryPart[] {
  const count = (status: LaneStatus) => rows.filter((row) => row.lane.status === status).length;
  const live = rows.filter((row) => row.lane.status !== "parked" && row.lane.status !== "retired");
  const parts: SummaryPart[] = [{ key: "live", figure: String(live.length) }, " live"];
  const liveParts = (["stuck", "waiting", "working", "idle"] as const).filter((s) => count(s) > 0);
  liveParts.forEach((status, index) => {
    parts.push(index === 0 ? ": " : ", ", { key: status, figure: String(count(status)) });
    parts.push(` ${LANE_STATUS_LABEL[status].toLowerCase()}`);
  });
  parts.push(".");
  const restParts = (["parked", "retired"] as const).filter((s) => count(s) > 0);
  restParts.forEach((status, index) => {
    parts.push(index === 0 ? " " : ", ", { key: status, figure: String(count(status)) });
    parts.push(
      ` ${LANE_STATUS_LABEL[status].toLowerCase()}${index === restParts.length - 1 ? "." : ""}`,
    );
  });
  return parts;
}

function byState(rows: ReadonlyArray<LaneRow>): LanePanel[] {
  const of = (status: LaneStatus) => rows.filter((row) => row.lane.status === status);
  const parked = latestFirst(of("parked"));
  const retired = latestFirst(of("retired"));
  const parkedShown = Math.min(parked.length, 2);
  const restParts = [
    parked.length > parkedShown ? `${parked.length - parkedShown} more parked` : null,
    retired.length > 0 ? `${retired.length} retired` : null,
  ].filter((part): part is string => part !== null);
  const panels: LanePanel[] = [
    {
      key: "stuck",
      title: "Stuck",
      rows: longestFirst(of("stuck")),
      shown: Infinity,
      restLabel: null,
    },
    {
      key: "waiting",
      title: "Waiting",
      rows: longestFirst(of("waiting")),
      shown: Infinity,
      restLabel: null,
    },
    {
      key: "working",
      title: "Working",
      rows: latestFirst(of("working")),
      shown: 10,
      restLabel: null,
    },
    { key: "idle", title: "Idle", rows: latestFirst(of("idle")), shown: 4, restLabel: null },
    {
      key: "parked",
      title: retired.length > 0 ? "Parked and retired" : "Parked",
      rows: [...parked, ...retired],
      shown: parkedShown,
      restLabel: restParts.length > 0 ? restParts.join(", ") : null,
    },
  ];
  return panels.filter((panel) => panel.rows.length > 0);
}

/** Problems first inside a panel; retired lanes gather in one folded panel at the end. */
function byKey(
  rows: ReadonlyArray<LaneRow>,
  keyOf: (row: LaneRow) => { key: string; title: string },
  order: (left: LanePanel, right: LanePanel) => number,
): LanePanel[] {
  const live = sortLanesProblemsFirst(
    rows.filter((row) => row.lane.status !== "retired").map((row) => ({ ...row.lane, row })),
  ).map((entry) => entry.row);
  const groups = new Map<string, { title: string; rows: LaneRow[] }>();
  for (const row of live) {
    const { key, title } = keyOf(row);
    const group = groups.get(key);
    if (group) group.rows.push(row);
    else groups.set(key, { title, rows: [row] });
  }
  const panels = [...groups].map(([key, group]) => ({
    key,
    title: group.title,
    rows: group.rows,
    shown: 8,
    restLabel: null,
  }));
  panels.sort(order);
  const retired = latestFirst(rows.filter((row) => row.lane.status === "retired"));
  return retired.length > 0
    ? [...panels, { key: "retired", title: "Retired", rows: retired, shown: 0, restLabel: null }]
    : panels;
}

/** The Lanes page: a page line and one panel per group. */
export function laneBoard(
  rows: ReadonlyArray<LaneRow>,
  grouping: LaneGrouping,
  subMissionOrder: ReadonlyArray<string> = [],
): LaneBoard {
  const summary = laneSummary(rows);
  if (grouping === "state") return { summary, panels: byState(rows) };
  if (grouping === "lead") {
    return {
      summary,
      panels: byKey(
        rows,
        (row) => ({ key: row.leadName, title: row.leadName }),
        (left, right) =>
          right.rows.length - left.rows.length || left.title.localeCompare(right.title),
      ),
    };
  }
  const rank = (key: string) => {
    const index = subMissionOrder.indexOf(key);
    return index === -1 ? subMissionOrder.length : index;
  };
  return {
    summary,
    panels: byKey(
      rows,
      (row) =>
        row.lane.subMissionId && row.subMissionTitle
          ? { key: row.lane.subMissionId, title: row.subMissionTitle }
          : { key: "", title: "No sub-mission" },
      (left, right) => rank(left.key) - rank(right.key),
    ),
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
