import {
  RoleId,
  type BindRoleInput,
  type MissionError,
  type CreateRoleInput,
  type MissionId,
  type MissionMutationResult,
  type MissionProvenance,
  type Role,
  type RoleBinding,
  type RoleDrift,
  type RetireRoleInput,
  type RolesSnapshot,
  type SetRoleModelInput,
  type SucceedRoleInput,
  type SucceedRoleResult,
  type ThreadId,
  type UnbindRoleInput,
  type UpdateRoleInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import {
  POLICY_PROVENANCE,
  activeBindings,
  attempt,
  bindingUpsert,
  eventDraft,
  failWith,
  findRole,
  missionRoles,
  nowIso,
  requireGovern,
  requireMission,
  resolveCaller,
  roleRef,
  roleUpsert,
  shortId,
  systemCaller,
  type Caller,
  type PolicyDeps,
} from "./context.ts";
import { modelKey } from "./models.ts";
import {
  defaultRoleId,
  detectDrift,
  finishModelChange,
  holderStep,
  needsAlignment,
  newBinding,
  newRole,
  requestModelChange,
  roleTarget,
  succeed,
} from "./roles.ts";

const newestBindingFirst = (left: RoleBinding, right: RoleBinding) =>
  right.boundAt.localeCompare(left.boundAt) || right.id.localeCompare(left.id);

const modelLabel = (role: Role) => modelKey(roleTarget(role));

export const rolesSnapshot = (
  deps: PolicyDeps,
  missionId: MissionId,
): Effect.Effect<RolesSnapshot, MissionError> =>
  Effect.gen(function* () {
    yield* requireMission(deps, missionId);
    const now = yield* nowIso;
    const roles = yield* missionRoles(deps, missionId, now);
    // Every current holder, plus the most recent page of ended ones for history.
    const active = yield* activeBindings(deps, missionId);
    const ended = yield* deps.store.list("role-binding", { missionId, status: ["ended"] });
    const bindings = [...active, ...ended].toSorted(newestBindingFirst);
    const byId = new Map(roles.all.map((role) => [role.id as string, role]));
    const drift: Array<RoleDrift> = [];
    for (const binding of bindings) {
      if (binding.endedAt !== null) continue;
      const role = byId.get(binding.roleId);
      if (!role) continue;
      const holder = yield* deps.threads.view(binding.threadId);
      const found = detectDrift(role, binding, holder.exists ? holder.modelSelection : null);
      if (found) drift.push(found);
    }
    return {
      missionId,
      roles: roles.all,
      defaults: roles.defaults.map((role) => role.id),
      bindings,
      drift,
    };
  });

/** A role's active holders, from a complete read of the mission's bindings. */
const roleBindings = (deps: PolicyDeps, role: Role) =>
  activeBindings(deps, role.missionId).pipe(
    Effect.map((bindings) => bindings.filter((binding) => binding.roleId === role.id)),
  );

export interface AlignResult {
  readonly applied: ReadonlyArray<ThreadId>;
  readonly waiting: ReadonlyArray<ThreadId>;
  readonly finished: boolean;
}

/**
 * Puts the role's model on every holder that does not run it yet, but only on
 * idle threads, so the change lands at the thread's next turn. Busy holders
 * wait for a later sweep. A pending change completes once no live holder is
 * left waiting.
 */
export const alignRole = (
  deps: PolicyDeps,
  role: Role,
  options: { readonly stored: boolean; readonly caller?: Caller } = { stored: true },
): Effect.Effect<AlignResult, MissionError> =>
  Effect.gen(function* () {
    const now = yield* nowIso;
    const target = roleTarget(role);
    const key = modelKey(target);
    const active = (yield* roleBindings(deps, role)).filter((binding) => binding.endedAt === null);
    const changed: Array<RoleBinding> = [];
    const applied: Array<ThreadId> = [];
    const confirmed: Array<ThreadId> = [];
    const waiting: Array<ThreadId> = [];
    const accepted: Array<ThreadId> = [];
    for (const binding of active) {
      if (!needsAlignment(role, binding)) continue;
      // An imported holder keeps whatever it runs until someone changes the
      // role's model; a mismatch shows as drift, never as a switch.
      if (
        binding.reason === "import" &&
        binding.observedModel === null &&
        role.pendingModelSelection === null
      ) {
        changed.push({ ...binding, observedModel: key });
        accepted.push(binding.threadId);
        continue;
      }
      const step = holderStep(target, yield* deps.threads.view(binding.threadId));
      switch (step._tag) {
        case "gone":
          break;
        case "wait-for-turn":
          waiting.push(binding.threadId);
          break;
        case "applied":
          changed.push({ ...binding, observedModel: key });
          confirmed.push(binding.threadId);
          break;
        case "apply": {
          const outcome = yield* Effect.result(
            deps.threads.setModel(binding.threadId, step.modelSelection),
          );
          if (Result.isSuccess(outcome)) {
            changed.push({ ...binding, observedModel: key });
            applied.push(binding.threadId);
          } else {
            yield* Effect.logWarning("mission policy could not set a holder's model", {
              roleId: role.id,
              threadId: binding.threadId,
              detail: outcome.failure.detail,
            });
            waiting.push(binding.threadId);
          }
          break;
        }
      }
    }
    const finished = role.pendingModelSelection !== null && waiting.length === 0;
    const nextRole = finished ? finishModelChange(role, now) : role;
    const upserts = [
      ...(finished || !options.stored ? [roleUpsert(nextRole)] : []),
      ...changed.map(bindingUpsert),
    ];
    if (upserts.length === 0) return { applied, waiting, finished };
    const caller = options.caller ?? systemCaller(POLICY_PROVENANCE);
    const parts = [
      applied.length > 0 ? `set on ${applied.length} idle holder(s) for their next turn` : null,
      confirmed.length > 0 ? `already running on ${confirmed.length} holder(s)` : null,
      accepted.length > 0 ? `${accepted.length} imported holder(s) keep their model` : null,
      waiting.length > 0 ? `${waiting.length} busy holder(s) pick it up after their turn` : null,
      finished ? "every holder has it now" : null,
    ].filter((part) => part !== null);
    yield* deps.store.commit({
      event: eventDraft(
        caller,
        role.missionId,
        "role.model-changed",
        `${role.name}: ${key} ${parts.join("; ")}`,
        roleRef(nextRole),
        { phase: "applied", model: key, applied, confirmed, accepted, waiting, finished },
      ),
      upserts,
    });
    return { applied, waiting, finished };
  });

/** One sweep over every role with a holder that still has to pick up its model. */
export const alignAll = (deps: PolicyDeps) =>
  Effect.gen(function* () {
    const active = yield* deps.store.list("role-binding", { status: ["bound"] });
    const roleIds = [...new Set(active.map((binding) => binding.roleId as string))];
    if (roleIds.length === 0) return;
    const roles = yield* deps.store.list("role", { ids: roleIds });
    for (const role of roles) {
      const holders = active.filter((binding) => binding.roleId === role.id);
      const due =
        role.pendingModelSelection !== null ||
        holders.some((binding) => needsAlignment(role, binding));
      if (!due) continue;
      yield* alignRole(deps, role).pipe(
        Effect.catch((error) =>
          Effect.logWarning("mission policy role alignment failed", {
            roleId: role.id,
            detail: error.detail,
          }),
        ),
      );
    }
  });

const unchanged = (deps: PolicyDeps, missionId: MissionId, role: Role) =>
  deps.store
    .latestSeq(missionId)
    .pipe(Effect.map((seq): MissionMutationResult => ({ seq, ref: roleRef(role) })));

export const createRole = (
  deps: PolicyDeps,
  provenance: MissionProvenance,
  input: CreateRoleInput,
): Effect.Effect<MissionMutationResult, MissionError> =>
  Effect.gen(function* () {
    yield* requireMission(deps, input.missionId);
    const caller = yield* resolveCaller(deps, provenance, input.missionId);
    yield* requireGovern(caller, "add roles");
    const now = yield* nowIso;
    if (input.laneId !== undefined) {
      const lane = yield* deps.store.get("lane", input.laneId);
      if (lane._tag === "None" || lane.value.missionId !== input.missionId) {
        return yield* failWith("not-found", `No lane ${input.laneId} in ${input.missionId}.`);
      }
    }
    const roles = yield* missionRoles(deps, input.missionId, now);
    const storedIds = new Set<string>(roles.stored.map((role) => role.id));
    const preferred =
      input.kind === "custom" ? null : defaultRoleId(input.missionId, input.kind, input.laneId);
    const id =
      preferred !== null && !storedIds.has(preferred)
        ? preferred
        : RoleId.make(`${input.missionId}:${shortId(input.kind)}`);
    const role = yield* attempt(() =>
      newRole(
        {
          missionId: input.missionId,
          kind: input.kind,
          laneId: input.laneId,
          id,
          name: input.name,
          description: input.description,
          modelSelection: input.modelSelection,
        },
        now,
      ),
    );
    const committed = yield* deps.store.commit({
      event: eventDraft(
        caller,
        role.missionId,
        "role.created",
        `Role ${role.name} (${role.kind}) on ${modelLabel(role)}`,
        roleRef(role),
      ),
      upserts: [roleUpsert(role)],
    });
    return { seq: committed.seq, ref: roleRef(role) };
  });

/**
 * Changes a role's model. Holders pick it up at their next turn: idle ones
 * right away, busy ones when their run ends. Nothing switches mid-turn.
 */
export const setRoleModel = (
  deps: PolicyDeps,
  provenance: MissionProvenance,
  input: SetRoleModelInput,
): Effect.Effect<MissionMutationResult, MissionError> =>
  Effect.gen(function* () {
    const now = yield* nowIso;
    const found = yield* findRole(deps, input.roleId, now);
    const caller = yield* resolveCaller(deps, provenance, found.role.missionId);
    yield* requireGovern(caller, "change a role's model");
    const role = yield* attempt(() => requestModelChange(found.role, input.modelSelection, now));
    const before = found.role.pendingModelSelection;
    if (found.stored && before === role.pendingModelSelection) {
      return yield* unchanged(deps, role.missionId, role);
    }
    const reason = input.reason.trim();
    const committed = yield* deps.store.commit({
      event: eventDraft(
        caller,
        role.missionId,
        "role.model-changed",
        role.pendingModelSelection === null
          ? `${role.name} stays on ${modelKey(role.modelSelection)}${reason ? `: ${reason}` : ""}`
          : `${role.name} moves to ${modelLabel(role)} at each holder's next turn${reason ? `: ${reason}` : ""}`,
        roleRef(role),
        {
          phase: "requested",
          from: modelKey(found.role.modelSelection),
          to: modelLabel(role),
          reason: reason || null,
        },
      ),
      upserts: [roleUpsert(role)],
    });
    yield* alignRole(deps, role, { stored: true, caller });
    return { seq: committed.seq, ref: roleRef(role) };
  });

/** Renames a role, rewrites its description or flips whether it writes public text. */
export const updateRole = (
  deps: PolicyDeps,
  provenance: MissionProvenance,
  input: UpdateRoleInput,
): Effect.Effect<MissionMutationResult, MissionError> =>
  Effect.gen(function* () {
    const now = yield* nowIso;
    const found = yield* findRole(deps, input.roleId, now);
    const caller = yield* resolveCaller(deps, provenance, found.role.missionId);
    yield* requireGovern(caller, "change roles");
    const before = found.role;
    const role: Role = {
      ...before,
      name: input.name ?? before.name,
      description: input.description ?? before.description,
      writesPublicText: input.writesPublicText ?? before.writesPublicText,
    };
    const changed = (["name", "description", "writesPublicText"] as const).filter(
      (field) => role[field] !== before[field],
    );
    if (changed.length === 0 && found.stored) return yield* unchanged(deps, role.missionId, role);
    const next = { ...role, updatedAt: now };
    const committed = yield* deps.store.commit({
      event: eventDraft(
        caller,
        next.missionId,
        "role.updated",
        changed.length === 0
          ? `Role ${next.name} stored from the registry default`
          : `Role ${before.name}: ${changed
              .map((field) =>
                field === "writesPublicText"
                  ? next.writesPublicText
                    ? "may write public text"
                    : "no longer writes public text"
                  : `${field} -> ${String(next[field]) || "(empty)"}`,
              )
              .join("; ")}`,
        roleRef(next),
        {
          fields: changed,
          before: Object.fromEntries(changed.map((field) => [field, before[field]])),
          after: Object.fromEntries(changed.map((field) => [field, next[field]])),
        },
      ),
      upserts: [roleUpsert(next)],
    });
    return { seq: committed.seq, ref: roleRef(next) };
  });

/**
 * Retires a custom role: its holders are released and the record goes away.
 * Registry roles cannot be retired; unbind their holders instead.
 */
export const retireRole = (
  deps: PolicyDeps,
  provenance: MissionProvenance,
  input: RetireRoleInput,
): Effect.Effect<MissionMutationResult, MissionError> =>
  Effect.gen(function* () {
    const now = yield* nowIso;
    const found = yield* findRole(deps, input.roleId, now);
    const role = found.role;
    const caller = yield* resolveCaller(deps, provenance, role.missionId);
    yield* requireGovern(caller, "retire roles");
    if (!found.stored || role.kind !== "custom") {
      return yield* failWith(
        "invalid",
        `${role.id} is a registry role; unbind its holders or change its model instead.`,
      );
    }
    const ended = (yield* roleBindings(deps, role))
      .filter((binding) => binding.endedAt === null)
      .map((binding) => ({ ...binding, endedAt: now }));
    const note = input.note?.trim() ?? "";
    const committed = yield* deps.store.commit({
      event: eventDraft(
        caller,
        role.missionId,
        "role.retired",
        `Role ${role.name} retired${ended.length > 0 ? `, releasing ${ended.length} holder(s)` : ""}${note ? `: ${note}` : ""}`,
        roleRef(role),
        { ended: ended.map((binding) => binding.id), note: note || null },
      ),
      upserts: ended.map(bindingUpsert),
      removes: [roleRef(role)],
    });
    return { seq: committed.seq, ref: roleRef(role) };
  });

/** Lane leads keep the lane's thread pointer in step with their binding. Best effort. */
const pointLaneAt = (deps: PolicyDeps, role: Role, threadId: ThreadId) =>
  role.kind !== "lane-lead" || role.laneId === null
    ? Effect.void
    : deps.missions
        .upsertLane(POLICY_PROVENANCE, {
          missionId: role.missionId,
          laneId: role.laneId,
          threadId,
          leadRoleId: role.id,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("mission policy could not point the lane at its lead", {
              laneId: role.laneId,
              detail: error.detail,
            }),
          ),
        );

export const bindRole = (
  deps: PolicyDeps,
  provenance: MissionProvenance,
  input: BindRoleInput,
): Effect.Effect<MissionMutationResult, MissionError> =>
  Effect.gen(function* () {
    const now = yield* nowIso;
    const found = yield* findRole(deps, input.roleId, now);
    const role = found.role;
    const caller = yield* resolveCaller(deps, provenance, role.missionId);
    yield* requireGovern(caller, "bind roles");
    const holder = yield* deps.threads.view(input.threadId);
    if (!holder.exists) return yield* failWith("not-found", `No thread ${input.threadId}.`);
    const active = (yield* roleBindings(deps, role)).filter((binding) => binding.endedAt === null);
    if (active.some((binding) => binding.threadId === input.threadId)) {
      return yield* unchanged(deps, role.missionId, role);
    }
    const reason = input.reason ?? "initial";
    const key = modelKey(roleTarget(role));
    const onTarget =
      holder.modelSelection !== null && modelKey(holder.modelSelection) === key ? key : null;
    // An imported holder keeps whatever it runs; a mismatch shows as drift, never a switch.
    const observedModel = reason === "import" ? key : onTarget;
    const binding = newBinding({
      roleId: role.id,
      threadId: input.threadId,
      reason,
      handoffNote: input.handoffNote?.trim() || null,
      observedModel,
      now,
    });
    const ended = input.shared === true ? [] : active.map((old) => ({ ...old, endedAt: now }));
    const committed = yield* deps.store.commit({
      event: eventDraft(
        caller,
        role.missionId,
        "role.bound",
        `${role.name} bound to thread ${input.threadId}${ended.length > 0 ? `, replacing ${ended.length} holder(s)` : ""}`,
        roleRef(role),
        { bindingId: binding.id, threadId: input.threadId, reason, ended: ended.map((b) => b.id) },
      ),
      upserts: [
        ...(found.stored ? [] : [roleUpsert(role)]),
        ...ended.map(bindingUpsert),
        bindingUpsert(binding),
      ],
    });
    yield* pointLaneAt(deps, role, input.threadId);
    yield* alignRole(deps, role, { stored: true, caller });
    return { seq: committed.seq, ref: roleRef(role) };
  });

export const unbindRole = (
  deps: PolicyDeps,
  provenance: MissionProvenance,
  input: UnbindRoleInput,
): Effect.Effect<MissionMutationResult, MissionError> =>
  Effect.gen(function* () {
    const now = yield* nowIso;
    const found = yield* findRole(deps, input.roleId, now);
    const role = found.role;
    const caller = yield* resolveCaller(deps, provenance, role.missionId);
    if (caller.threadId !== input.threadId) yield* requireGovern(caller, "unbind roles");
    const current = (yield* roleBindings(deps, role)).find(
      (binding) => binding.endedAt === null && binding.threadId === input.threadId,
    );
    if (!current) {
      return yield* failWith("not-found", `Thread ${input.threadId} does not hold ${role.id}.`);
    }
    const note = input.note?.trim() ?? "";
    const committed = yield* deps.store.commit({
      event: eventDraft(
        caller,
        role.missionId,
        "role.unbound",
        `${role.name} released by thread ${input.threadId}${note ? `: ${note}` : ""}`,
        roleRef(role),
        { bindingId: current.id, threadId: input.threadId, note: note || null },
      ),
      upserts: [bindingUpsert({ ...current, endedAt: now })],
    });
    return { seq: committed.seq, ref: roleRef(role) };
  });

/**
 * Hands a role to a new thread the caller already launched or reset. The new
 * binding carries the handoff note, and schedules (plus whatever else the
 * succession port supports) move to the new thread. The new thread runs the
 * role's model from its next turn.
 */
export const succeedRole = (
  deps: PolicyDeps,
  provenance: MissionProvenance,
  input: SucceedRoleInput,
): Effect.Effect<SucceedRoleResult, MissionError> =>
  Effect.gen(function* () {
    const now = yield* nowIso;
    const found = yield* findRole(deps, input.roleId, now);
    const role = found.role;
    const caller = yield* resolveCaller(deps, provenance, role.missionId);
    const active = (yield* roleBindings(deps, role)).filter((binding) => binding.endedAt === null);
    const current =
      input.fromThreadId !== undefined
        ? active.find((binding) => binding.threadId === input.fromThreadId)
        : active.length === 1
          ? active[0]
          : undefined;
    if (!current) {
      return yield* failWith(
        active.length > 1 ? "invalid" : "not-found",
        active.length > 1
          ? `${role.id} has ${active.length} holders; say which one hands over (fromThreadId).`
          : `${role.id} has no holder${input.fromThreadId ? ` on ${input.fromThreadId}` : ""} to hand over.`,
      );
    }
    if (caller.threadId !== current.threadId) yield* requireGovern(caller, "hand a role over");
    const holder = yield* deps.threads.view(input.threadId);
    if (!holder.exists) return yield* failWith("not-found", `No thread ${input.threadId}.`);
    const succession = yield* attempt(() =>
      succeed(current, { threadId: input.threadId, handoffNote: input.handoffNote, now }),
    );
    const key = modelKey(roleTarget(role));
    const next: RoleBinding = {
      ...succession.next,
      observedModel:
        holder.modelSelection !== null && modelKey(holder.modelSelection) === key ? key : null,
    };
    const moves = yield* deps.succession.move(current.threadId, input.threadId);
    const moved = moves
      .filter((move) => move.supported && move.moved > 0)
      .map((move) => `${move.moved} ${move.what}`);
    yield* deps.store.commit({
      event: eventDraft(
        caller,
        role.missionId,
        "role.succession",
        `${role.name} handed from ${current.threadId} to ${input.threadId}${moved.length > 0 ? `; moved ${moved.join(", ")}` : ""}`,
        roleRef(role),
        {
          from: current.threadId,
          to: input.threadId,
          endedId: current.id,
          bindingId: next.id,
          moves,
        },
      ),
      upserts: [
        ...(found.stored ? [] : [roleUpsert(role)]),
        bindingUpsert(succession.ended),
        bindingUpsert(next),
      ],
    });
    yield* pointLaneAt(deps, role, input.threadId);
    yield* alignRole(deps, role, { stored: true, caller });
    return { ended: succession.ended, binding: next, moves };
  });

/** Stores a registry default (so it can carry a lock or a note like any stored role). */
export const materializeRole = (deps: PolicyDeps, roleId: RoleId) =>
  Effect.gen(function* () {
    const now = yield* nowIso;
    const found = yield* findRole(deps, roleId, now);
    if (found.stored) return found.role;
    const caller = systemCaller(POLICY_PROVENANCE);
    yield* deps.store.commit({
      event: eventDraft(
        caller,
        found.role.missionId,
        "role.created",
        `Role ${found.role.name} (${found.role.kind}) stored from the registry default`,
        roleRef(found.role),
      ),
      upserts: [roleUpsert(found.role)],
    });
    return found.role;
  });

/** The model key a review record names when the caller does not say. */
export const callerModelKey = (deps: PolicyDeps, caller: Caller, role: Role) =>
  Effect.gen(function* () {
    if (caller.threadId !== null) {
      const holder = yield* deps.threads.view(caller.threadId);
      if (holder.exists && holder.modelSelection !== null) return modelKey(holder.modelSelection);
    }
    return modelKey(role.modelSelection);
  });
