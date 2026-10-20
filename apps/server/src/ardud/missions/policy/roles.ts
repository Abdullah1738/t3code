/**
 * Role registry: default roles per mission, model changes that wait for the
 * holder's next turn, drift between what a role says and what its thread ran,
 * and succession from one thread to the next.
 *
 * Pure functions only. `PolicyService` persists the results and talks to
 * threads.
 */
import {
  type LaneId,
  MissionError,
  type MissionId,
  type ModelSelection,
  type Role,
  type RoleBinding,
  RoleBindingId,
  RoleId,
  type RoleKind,
  type ThreadId,
} from "@t3tools/contracts";

import {
  ASTRA_XHIGH,
  HAIKU,
  HAIKU_XHIGH,
  OPUS_XHIGH,
  SOL_XHIGH,
  modelKey,
  sameModel,
} from "./models.ts";

export interface RoleDefault {
  readonly name: string;
  readonly description: string;
  readonly modelSelection: ModelSelection;
  readonly writesPublicText: boolean;
}

/** Design section 6. Reviewers never write public text; a writer does it for them. */
export const ROLE_DEFAULTS: Record<Exclude<RoleKind, "custom">, RoleDefault> = {
  master: {
    name: "Master",
    description: "Owns priorities, product decisions and the critical path. One per mission.",
    modelSelection: OPUS_XHIGH,
    writesPublicText: true,
  },
  "sub-coordinator": {
    name: "Sub-coordinator",
    description: "Runs one sub-mission for the master.",
    modelSelection: OPUS_XHIGH,
    writesPublicText: true,
  },
  "lane-lead": {
    name: "Lane lead",
    description: "Owns one lane end to end and takes its claims.",
    modelSelection: OPUS_XHIGH,
    writesPublicText: true,
  },
  "lane-worker": {
    name: "Lane worker",
    description: "Bounded work for a lane lead.",
    modelSelection: HAIKU,
    writesPublicText: true,
  },
  reviewer: {
    name: "Reviewer",
    description: "Reviews every PR at its exact head until CLEAR. Output is findings only.",
    modelSelection: SOL_XHIGH,
    writesPublicText: false,
  },
  "final-reviewer": {
    name: "Final reviewer",
    description: "Final check at the exact head for critical PRs, after the reviewer stage clears.",
    modelSelection: ASTRA_XHIGH,
    writesPublicText: false,
  },
  writer: {
    name: "Writer",
    description: "Writes public text from findings handed over by roles that never write it.",
    modelSelection: HAIKU_XHIGH,
    writesPublicText: true,
  },
  scribe: {
    name: "Scribe",
    description: "Reads everything and notes what matters.",
    modelSelection: HAIKU,
    writesPublicText: true,
  },
  editor: {
    name: "Editor",
    description: "Writes the hourly brief for the owner.",
    modelSelection: OPUS_XHIGH,
    writesPublicText: true,
  },
  verifier: {
    name: "Verifier",
    description: "Checks claimed outcomes with code and the reviewer model.",
    modelSelection: SOL_XHIGH,
    writesPublicText: false,
  },
  answerer: {
    name: "Answerer",
    description: "Answers the owner's questions in its own thread so the master keeps working.",
    modelSelection: OPUS_XHIGH,
    writesPublicText: true,
  },
};

/** Roles every mission starts with. Lane roles come with their lane, sub-coordinators with their sub-mission. */
export const MISSION_ROLE_KINDS = [
  "master",
  "reviewer",
  "final-reviewer",
  "writer",
  "scribe",
  "editor",
  "verifier",
  "answerer",
] as const satisfies ReadonlyArray<RoleKind>;

export const LANE_ROLE_KINDS = [
  "lane-lead",
  "lane-worker",
] as const satisfies ReadonlyArray<RoleKind>;

/** Deterministic id so seeding twice finds the same role. */
export function defaultRoleId(
  missionId: MissionId,
  kind: RoleKind,
  laneId?: LaneId | null,
): RoleId {
  return RoleId.make(laneId ? `${missionId}:${kind}:${laneId}` : `${missionId}:${kind}`);
}

export interface NewRoleInput {
  readonly missionId: MissionId;
  readonly kind: RoleKind;
  readonly laneId?: LaneId | null | undefined;
  readonly id?: RoleId | undefined;
  readonly name?: string | undefined;
  readonly description?: string | undefined;
  readonly modelSelection?: ModelSelection | undefined;
  readonly writesPublicText?: boolean | undefined;
}

export function newRole(input: NewRoleInput, now: string): Role {
  const base = input.kind === "custom" ? undefined : ROLE_DEFAULTS[input.kind];
  const modelSelection = input.modelSelection ?? base?.modelSelection;
  const name = input.name ?? base?.name;
  if (!modelSelection || !name) {
    throw new MissionError({ code: "invalid", detail: "custom roles need a name and a model" });
  }
  return {
    id: input.id ?? defaultRoleId(input.missionId, input.kind, input.laneId),
    missionId: input.missionId,
    kind: input.kind,
    name: name as Role["name"],
    description: input.description ?? base?.description ?? "",
    modelSelection,
    pendingModelSelection: null,
    laneId: input.laneId ?? null,
    writesPublicText: input.writesPublicText ?? base?.writesPublicText ?? true,
    lockedFields: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function defaultMissionRoles(missionId: MissionId, now: string): ReadonlyArray<Role> {
  return MISSION_ROLE_KINDS.map((kind) => newRole({ missionId, kind }, now));
}

export function defaultLaneRoles(
  missionId: MissionId,
  laneId: LaneId,
  now: string,
): ReadonlyArray<Role> {
  return LANE_ROLE_KINDS.map((kind) => newRole({ missionId, kind, laneId }, now));
}

/**
 * Asks for a model change. The role keeps running its current model until
 * every holder picks the new one up at its next turn (see `planModelApply`).
 * Asking for the current model cancels a pending change. Nothing refuses on
 * `lockedFields`: the owner and the master can always change a role's model.
 */
export function requestModelChange(role: Role, modelSelection: ModelSelection, now: string): Role {
  const pending = sameModel(role.modelSelection, modelSelection) ? null : modelSelection;
  return { ...role, pendingModelSelection: pending, updatedAt: now };
}

/** What a bound thread looks like right now, read from its thread shell. */
export interface HolderThread {
  readonly threadId: ThreadId;
  readonly exists: boolean;
  /** True only when no run is active, queued or waiting on input. */
  readonly idle: boolean;
  readonly modelSelection: ModelSelection | null;
}

export type HolderStep =
  | { readonly _tag: "applied"; readonly threadId: ThreadId }
  | { readonly _tag: "apply"; readonly threadId: ThreadId; readonly modelSelection: ModelSelection }
  | { readonly _tag: "wait-for-turn"; readonly threadId: ThreadId }
  | { readonly _tag: "gone"; readonly threadId: ThreadId };

export interface ModelApplyPlan {
  readonly steps: ReadonlyArray<HolderStep>;
  /** Every live holder runs the pending model once the `apply` steps land. */
  readonly complete: boolean;
}

/**
 * Plans how a pending model change reaches the role's holders. Busy threads
 * are never switched mid-turn: they keep their model and are retried on the
 * next sweep.
 */
export function planModelApply(role: Role, holders: ReadonlyArray<HolderThread>): ModelApplyPlan {
  const target = role.pendingModelSelection;
  if (!target) return { steps: [], complete: true };
  const steps = holders.map((holder) => holderStep(target, holder));
  return { steps, complete: steps.every((step) => step._tag !== "wait-for-turn") };
}

/** One holder's step towards `target`: never a switch while a run is active. */
export function holderStep(target: ModelSelection, holder: HolderThread): HolderStep {
  if (!holder.exists) return { _tag: "gone", threadId: holder.threadId };
  if (holder.modelSelection && sameModel(holder.modelSelection, target)) {
    return { _tag: "applied", threadId: holder.threadId };
  }
  if (!holder.idle) return { _tag: "wait-for-turn", threadId: holder.threadId };
  return { _tag: "apply", threadId: holder.threadId, modelSelection: target };
}

/** The model a role's holders should run: the pending change once asked for. */
export function roleTarget(role: Role): ModelSelection {
  return role.pendingModelSelection ?? role.modelSelection;
}

/**
 * Whether a holder still has to pick up the role's model. `observedModel` is
 * the model the policy last put on (or accepted for) the binding: a fresh
 * binding (null), a model change and a cancelled change all move it, while a
 * thread someone switched by hand keeps the policy's key and shows as drift
 * rather than being switched back.
 */
export function needsAlignment(role: Role, binding: RoleBinding): boolean {
  return binding.endedAt === null && binding.observedModel !== modelKey(roleTarget(role));
}

/** Moves the pending model into place once every holder has it. */
export function finishModelChange(role: Role, now: string): Role {
  if (!role.pendingModelSelection) return role;
  return {
    ...role,
    modelSelection: role.pendingModelSelection,
    pendingModelSelection: null,
    updatedAt: now,
  };
}

export interface Drift {
  readonly roleId: RoleId;
  readonly bindingId: RoleBinding["id"];
  readonly threadId: ThreadId;
  readonly expected: string;
  readonly observed: string;
}

/**
 * A holder drifts when its thread runs neither the role's model nor the
 * pending one. A thread that is still on the old model during a pending
 * change is just waiting for its next turn.
 */
export function detectDrift(
  role: Role,
  binding: RoleBinding,
  observed: ModelSelection | null,
): Drift | null {
  if (!observed || binding.endedAt !== null) return null;
  if (sameModel(observed, role.modelSelection)) return null;
  if (role.pendingModelSelection && sameModel(observed, role.pendingModelSelection)) return null;
  return {
    roleId: role.id,
    bindingId: binding.id,
    threadId: binding.threadId,
    expected: modelKey(role.pendingModelSelection ?? role.modelSelection),
    observed: modelKey(observed),
  };
}

export function bindingId(roleId: RoleId, threadId: ThreadId, boundAt: string): RoleBinding["id"] {
  return RoleBindingId.make(`${roleId}@${threadId}@${boundAt}`);
}

export function newBinding(input: {
  readonly roleId: RoleId;
  readonly threadId: ThreadId;
  readonly reason: RoleBinding["reason"];
  readonly handoffNote?: string | null;
  readonly observedModel?: string | null;
  readonly now: string;
}): RoleBinding {
  return {
    id: bindingId(input.roleId, input.threadId, input.now),
    roleId: input.roleId,
    threadId: input.threadId,
    reason: input.reason,
    handoffNote: input.handoffNote ?? null,
    observedModel: input.observedModel ?? null,
    boundAt: input.now,
    endedAt: null,
  };
}

export interface Succession {
  readonly ended: RoleBinding;
  readonly next: RoleBinding;
}

/**
 * Hands a role from one thread to the next. The old binding ends and the new
 * thread starts from the handoff note. Moving rooms, schedules and children
 * is the caller's job (`SuccessionPort`).
 */
export function succeed(
  current: RoleBinding,
  input: { readonly threadId: ThreadId; readonly handoffNote: string | null; readonly now: string },
): Succession {
  if (current.endedAt !== null) {
    throw new MissionError({ code: "conflict", detail: `binding ${current.id} already ended` });
  }
  if (current.threadId === input.threadId) {
    throw new MissionError({ code: "invalid", detail: "succession needs a different thread" });
  }
  return {
    ended: { ...current, endedAt: input.now },
    next: newBinding({
      roleId: current.roleId,
      threadId: input.threadId,
      reason: "succession",
      handoffNote: input.handoffNote,
      now: input.now,
    }),
  };
}
