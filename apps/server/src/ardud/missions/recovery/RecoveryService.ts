// Restart detection for missions. Finds mission threads whose run was cut or
// whose background children were lost (server restart, OpenCode restart,
// interrupted runs, role handoffs), plans what each one does next, and sends
// one notice per thread: the master first, then lanes in sub-mission order at a
// paced rate. A busy thread gets its notice queued behind the running turn.
import {
  isOwnerProvenance,
  MissionError,
  NoteId,
  type Lane,
  type Mission,
  type MissionActor,
  type MissionId,
  type MissionProvenance,
  type MissionRecoverySettings,
  type MissionRecoveryState,
  type MissionRecoveryStatus,
  type Note,
  type PoolHold,
  type RecoveryAction,
  type RecoveryCause,
  type RecoveryHeldHold,
  type RecoveryIncident,
  type RecoveryMember,
  type RecoveryReportInput,
  type RecoveryReportMission,
  type RecoveryReportResult,
  type RecoveryResumeInput,
  type RecoverySettingsInput,
  type RecoveryThread,
  type Role,
  type RoleBinding,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";

import { standingOf, threadOfActor, type MissionCast } from "../asks/standing.ts";
import { buildCriticalPath } from "../core/snapshots.ts";
import * as PolicyService from "../policy/PolicyService.ts";
import * as MissionStore from "../store/MissionStore.ts";
import type { SystemNoticeOutcome } from "../router/MissionRouter.ts";
import type { MissionStoreRecord } from "../store/recordIndex.ts";
import * as Model from "./model.ts";
import * as RecoveryDelivery from "./RecoveryDelivery.ts";
import * as RecoveryStore from "./RecoveryStore.ts";

const COMPONENT = "missions-recovery";
const SYSTEM: MissionProvenance = { _tag: "system", component: COMPONENT };
const SYSTEM_ACTOR: MissionActor = { _tag: "system", component: COMPONENT };

const MINUTE = 60_000;
/** First boot ever: look this far back for cut runs. */
const FIRST_BOOT_WINDOW_MS = 10 * MINUTE;
/** Before the last heartbeat: runs cut then were not scanned yet (scan settles first). */
const BOOT_SLACK_MS = 10 * MINUTE;
const SCAN_LOOKBACK_MS = 60 * MINUTE;
/** A run must have ended this long ago before the scan judges it. */
const SCAN_SETTLE_MS = 5 * MINUTE;
/**
 * A busy master gets its note queued behind its turn, so lanes wait this long
 * from detection (or the usual lead, if later) to give it time to read and steer.
 */
const MASTER_WAIT_MS = 10 * MINUTE;
/** stateReason of a notice queued behind a running turn. */
const QUEUED_REASON = "queued behind its running turn";
/** Threads still undelivered after this (failing sends) get skipped so the incident can close. */
const GIVE_UP_MS = 12 * 60 * MINUTE;
const HANDOFF_LOOKBACK_MS = 30 * MINUTE;

const LIVE_MISSIONS = ["active", "paused", "draining"];
const OPEN_HOLDS = ["queued", "active", "reconcile-required"];
const WAITING_ASK = /waiting on ask ([^:;]+): ([^;]*)/;

type SeenEntry = { readonly key: string; readonly threadId: string };

/** Who decided a recovery change, as it is recorded. */
interface Decider {
  readonly by: "owner" | "master";
  readonly actor: MissionActor;
  readonly provenance: MissionProvenance;
}

interface MissionView {
  readonly mission: Mission;
  readonly cast: MissionCast;
  readonly members: ReadonlyArray<Model.MemberInfo>;
  readonly holdsByThread: ReadonlyMap<string, ReadonlyArray<RecoveryHeldHold>>;
}

interface Planned {
  readonly view: MissionView;
  readonly member: Model.MemberInfo;
  readonly cut: RecoveryStore.CutRunRow | null;
  readonly lost: ReadonlyArray<Model.ChildFacts>;
  readonly holds: ReadonlyArray<RecoveryHeldHold>;
  readonly action: RecoveryAction;
  readonly reason: string;
  /** Boots in a row that cut this thread's turn, counting this one; 0 outside boots. */
  readonly bootCuts?: number;
}

interface CollectInput {
  readonly cause: RecoveryCause;
  readonly id: string;
  readonly source: string;
  readonly window: { readonly from: string; readonly to: string };
  /** When the interruption happened; defaults to the latest cut run. */
  readonly windowEnd: string | null;
  readonly downSeconds: number | null;
  /** Reported runs only; otherwise every cut member run in the window. */
  readonly runIds: ReadonlyArray<string> | null;
  /** Child ids a reporter saw lost, counted regardless of the window. */
  readonly named: ReadonlySet<string>;
  readonly extraSeen: ReadonlyArray<SeenEntry>;
  /** The boot a server-restart incident belongs to; counts boot-after-boot cuts. */
  readonly bootId: string | null;
}

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const nowIso = Effect.map(Clock.currentTimeMillis, iso);
const minus = (at: string, ms: number) => iso(Date.parse(at) - ms);
const compact = (at: string) => at.replace(/[-:.]/g, "");

const notFound = (detail: string) => new MissionError({ code: "not-found", detail });
const conflict = (detail: string) => new MissionError({ code: "conflict", detail });
const invalid = (detail: string) => new MissionError({ code: "invalid", detail });

const threadRef = (thread: RecoveryThread) => ({
  kind: "thread" as const,
  id: thread.threadId,
  label: thread.title,
});

const who = (thread: RecoveryThread) =>
  thread.laneName !== null ? `lane "${thread.laneName}"` : (thread.roleKind ?? "thread");

const patchThread = (
  incident: RecoveryIncident,
  target: RecoveryThread,
  patch: Partial<RecoveryThread>,
): RecoveryIncident => ({
  ...incident,
  threads: incident.threads.map((thread) =>
    thread.missionId === target.missionId && thread.threadId === target.threadId
      ? { ...thread, ...patch }
      : thread,
  ),
});

const missionThreads = (incident: RecoveryIncident, missionId: MissionId) =>
  incident.threads
    .filter((thread) => thread.missionId === missionId)
    .toSorted((left, right) => left.position - right.position);

const sendable = (thread: RecoveryThread) =>
  thread.state === "pending" || thread.state === "failed";

export class RecoveryService extends Context.Service<
  RecoveryService,
  {
    /** Once per boot: open an incident for member runs the restart cut. */
    readonly detectBoot: Effect.Effect<RecoveryIncident | null, MissionError>;
    /** Liveness heartbeat (also records this boot on first call). */
    readonly beat: Effect.Effect<void>;
    /** Member runs interrupted while the server stayed up (stall watch, provider errors). */
    readonly scan: Effect.Effect<RecoveryIncident | null, MissionError>;
    /** Sends due notices; returns how many went out. */
    readonly tick: Effect.Effect<number>;
    /** stream-recovery's findings (OpenCode or Robob restarts it saw). */
    readonly report: (
      provenance: MissionProvenance,
      input: RecoveryReportInput,
    ) => Effect.Effect<RecoveryReportResult, MissionError>;
    readonly members: (
      threadIds: ReadonlyArray<ThreadId>,
    ) => Effect.Effect<ReadonlyArray<RecoveryMember>, MissionError>;
    readonly status: (missionId: MissionId) => Effect.Effect<MissionRecoveryStatus, MissionError>;
    // --- policy additions ---
    /** Incidents that touched the mission, newest first, each narrowed to its threads. */
    readonly incidents: (
      missionId: MissionId,
    ) => Effect.Effect<ReadonlyArray<RecoveryIncident>, MissionError>;
    // --- end policy additions ---
    /** Owner or master: resume now, hold, release, skip, reorder, add an instruction. */
    readonly resume: (
      provenance: MissionProvenance,
      input: RecoveryResumeInput,
    ) => Effect.Effect<MissionRecoveryStatus, MissionError>;
    readonly setSettings: (
      provenance: MissionProvenance,
      input: RecoverySettingsInput,
    ) => Effect.Effect<MissionRecoverySettings, MissionError>;
    /** A role moved to a new thread: hand the old thread's children to the new holder. */
    readonly onSuccession: (
      binding: RoleBinding,
      missionId: MissionId,
    ) => Effect.Effect<RecoveryIncident | null, MissionError>;
    /** Overview badge. */
    readonly state: (missionId: MissionId) => Effect.Effect<MissionRecoveryState | null>;
  }
>()("t3/ardud/missions/recovery/RecoveryService") {}

export const make = Effect.gen(function* () {
  const store = yield* MissionStore.MissionStore;
  const recovery = yield* RecoveryStore.RecoveryStore;
  const delivery = yield* RecoveryDelivery.RecoveryDelivery;
  // Optional so recovery still runs where the policy track is not built.
  const policy = yield* Effect.serviceOption(PolicyService.PolicyService);
  const lock = yield* Semaphore.make(1);
  const bootRef = yield* Ref.make<RecoveryStore.BootInfo | null>(null);
  const bootChecked = yield* Ref.make(false);

  // --- reading the missions ---

  const settingsOf = (missionId: MissionId) =>
    recovery
      .settings(missionId)
      .pipe(
        Effect.map(
          (stored): MissionRecoverySettings => stored ?? { missionId, ...Model.DEFAULT_SETTINGS },
        ),
      );

  const castOf = (missionId: MissionId) =>
    Effect.gen(function* () {
      const mission = yield* store.get("mission", missionId);
      if (Option.isNone(mission)) return yield* notFound(`No mission ${missionId}.`);
      // Complete reads: a capped list could leave out the master's binding.
      const [roles, bindings, lanes] = yield* Effect.all([
        store.listAllInMission("role", missionId),
        store.listAllInMission("role-binding", missionId, ["bound"]),
        store.listAllInMission("lane", missionId),
      ]);
      return {
        missionId,
        mission: mission.value,
        roles,
        bindings,
        lanes,
      } satisfies MissionCast;
    });

  const viewOf = (mission: Mission, now: string) =>
    Effect.gen(function* () {
      const missionId = mission.id;
      const [subMissions, roles, bindings, lanes, milestones, workItems, storeHolds, policyHolds] =
        yield* Effect.all([
          store.listAllInMission("sub-mission", missionId),
          store.listAllInMission("role", missionId),
          store.listAllInMission("role-binding", missionId, ["bound"]),
          store.listAllInMission("lane", missionId),
          store.listAllInMission("milestone", missionId),
          store.listAllInMission("work-item", missionId),
          store.listAllInMission("pool-hold", missionId, OPEN_HOLDS),
          recovery.policyHolds([missionId]),
        ]);
      const masterRole =
        roles.find((role) => role.id === mission.masterRoleId) ??
        roles.find((role) => role.kind === "master") ??
        null;
      const critical = new Set<string>(
        buildCriticalPath(milestones, workItems).map((ref) => ref.id),
      );
      const focus =
        mission.focusSubMissionId === null
          ? null
          : (subMissions.find((sub) => sub.id === mission.focusSubMissionId) ?? null);

      const memberOf = (
        threadId: ThreadId,
        role: Role | null,
        lane: Lane | null,
      ): Model.MemberInfo => {
        const isMaster = role !== null && masterRole !== null && role.id === masterRole.id;
        const subMission =
          lane !== null && lane.subMissionId !== null
            ? subMissions.find((sub) => sub.id === lane.subMissionId)
            : role === null
              ? undefined
              : subMissions.find((sub) => sub.coordinatorRoleId === role.id);
        const inFocus =
          focus === null ||
          isMaster ||
          (subMission === undefined ? lane === null : subMission.id === focus.id);
        const waiting =
          lane !== null && lane.status === "waiting" && lane.statusReason !== null
            ? WAITING_ASK.exec(lane.statusReason)
            : null;
        return {
          missionId,
          missionTitle: mission.title,
          missionStatus: mission.status,
          threadId,
          roleId: role?.id ?? null,
          roleKind: isMaster ? "master" : (role?.kind ?? null),
          roleName: role?.name ?? null,
          laneId: lane?.id ?? null,
          laneName: lane?.name ?? null,
          laneStatus: lane?.status ?? null,
          laneStatusReason: lane?.statusReason ?? null,
          subMissionId: subMission?.id ?? null,
          subMissionTitle: subMission?.title ?? null,
          subMissionOrder: subMission?.order ?? 1_000,
          subMissionPaused: subMission?.status === "paused",
          focusHeldBy: focus !== null && !inFocus ? focus.title : null,
          onCriticalPath:
            lane !== null &&
            ((lane.currentItemId !== null && critical.has(lane.currentItemId)) ||
              workItems.some((item) => item.laneId === lane.id && critical.has(item.id))),
          waitingOnAsk: waiting === null ? null : `${waiting[1]}: ${waiting[2]}`.trim(),
          lastActiveAt: lane?.lastActiveAt ?? null,
        };
      };

      // One entry per thread: the master role wins, then a role with a lane.
      const members = new Map<string, Model.MemberInfo>();
      const better = (next: Model.MemberInfo, current: Model.MemberInfo | undefined) =>
        current === undefined ||
        (current.roleKind !== "master" &&
          (next.roleKind === "master" || (current.laneId === null && next.laneId !== null)));
      for (const binding of bindings) {
        if (binding.endedAt !== null) continue;
        const role = roles.find((candidate) => candidate.id === binding.roleId) ?? null;
        const lane =
          (role?.laneId ? lanes.find((candidate) => candidate.id === role.laneId) : undefined) ??
          lanes.find((candidate) => candidate.threadId === binding.threadId) ??
          null;
        const next = memberOf(binding.threadId, role, lane);
        if (better(next, members.get(binding.threadId))) members.set(binding.threadId, next);
      }
      for (const lane of lanes) {
        if (lane.threadId === null || members.has(lane.threadId)) continue;
        const role =
          lane.leadRoleId === null ? null : (roles.find((r) => r.id === lane.leadRoleId) ?? null);
        members.set(lane.threadId, memberOf(lane.threadId, role, lane));
      }

      const cast: MissionCast = { missionId, mission, roles, bindings, lanes };
      const holds = new Map<string, PoolHold>(storeHolds.map((hold) => [hold.id, hold]));
      for (const hold of policyHolds) if (hold.missionId === missionId) holds.set(hold.id, hold);
      const nowMs = Date.parse(now);
      const holdsByThread = new Map<string, Array<RecoveryHeldHold>>();
      for (const hold of holds.values()) {
        if (!OPEN_HOLDS.includes(hold.status)) continue;
        const threadId = threadOfActor(cast, hold.holder);
        if (threadId === null) continue;
        const list = holdsByThread.get(threadId) ?? [];
        list.push({
          holdId: hold.id,
          poolId: hold.poolId,
          purpose: hold.purpose,
          status: hold.status,
          leaseExpiresAt: hold.leaseExpiresAt,
          reconcileRequired:
            hold.status === "reconcile-required" ||
            (hold.status === "active" &&
              hold.leaseExpiresAt !== null &&
              Date.parse(hold.leaseExpiresAt) < nowMs),
        });
        holdsByThread.set(threadId, list);
      }
      return { mission, cast, members: [...members.values()], holdsByThread } satisfies MissionView;
    });

  // Every live mission, uncapped: a capped list drops missions once there are many.
  const loadViews = (now: string) =>
    store
      .listAll("mission", LIVE_MISSIONS)
      .pipe(
        Effect.flatMap((missions) => Effect.forEach(missions, (mission) => viewOf(mission, now))),
      );

  // The store's thread index names every mission with a record for the
  // thread (complete, no limit); each candidate is then checked against its
  // full current cast, so an ended binding or a closed mission does not count.
  const membersOf = (threadIds: ReadonlyArray<ThreadId>) =>
    Effect.gen(function* () {
      const castThreads = new Map<string, ReadonlySet<string> | null>();
      const threadsOf = (missionId: MissionId) =>
        Effect.gen(function* () {
          const cached = castThreads.get(missionId);
          if (cached !== undefined) return cached;
          const mission = yield* store.get("mission", missionId);
          let threads: ReadonlySet<string> | null = null;
          if (Option.isSome(mission) && LIVE_MISSIONS.includes(mission.value.status)) {
            const [bindings, lanes] = yield* Effect.all([
              store.listAllInMission("role-binding", missionId, ["bound"]),
              store.listAllInMission("lane", missionId),
            ]);
            threads = new Set<string>([
              ...bindings
                .filter((binding) => binding.endedAt === null)
                .map((binding) => binding.threadId),
              ...lanes.flatMap((lane) => (lane.threadId === null ? [] : [lane.threadId])),
            ]);
          }
          castThreads.set(missionId, threads);
          return threads;
        });
      const members: Array<RecoveryMember> = [];
      for (const threadId of new Set(threadIds)) {
        const missionIds: Array<MissionId> = [];
        for (const missionId of yield* store.missionsOfThread(threadId)) {
          const threads = yield* threadsOf(missionId);
          if (threads !== null && threads.has(threadId)) missionIds.push(missionId);
        }
        if (missionIds.length > 0) members.push({ threadId, missionIds });
      }
      return members;
    });

  // --- opening incidents ---

  const persistOpened = (
    incident: RecoveryIncident,
    seen: ReadonlyArray<SeenEntry>,
    now: string,
    ownerNote: boolean,
    chains: ReadonlyArray<RecoveryStore.BootChain> = [],
  ) =>
    Effect.gen(function* () {
      const label = Model.stateLabel(incident.cause, incident.windowEnd, delivery.timeZone);
      for (const [index, missionId] of incident.missionIds.entries()) {
        const threads = missionThreads(incident, missionId);
        const settings = yield* settingsOf(missionId);
        const summary = Model.incidentSummary(threads, label, settings);
        const reconcile = threads.some(
          (thread) =>
            thread.action === "reconcile-first" ||
            thread.holds.some((hold) => hold.reconcileRequired),
        );
        const stopped = threads.some(Model.isBootStopped);
        const upserts: Array<MissionStoreRecord> = [];
        if (ownerNote || reconcile || stopped) {
          const note: Note = {
            id: NoteId.make(`recovery-${incident.id}-${missionId}`),
            missionId,
            subMissionId: null,
            laneId: null,
            type: "owner-must-know",
            summary,
            sources: [],
            basis: "observed",
            severity: reconcile || stopped ? "high" : "medium",
            confidence: 1,
            author: "code-check",
            citation: "verified",
            evidence: "not-applicable",
            evidenceLinks: [],
            replacesNoteId: null,
            ackedBy: [],
            createdAt: now,
          };
          upserts.push({ _tag: "note", record: note });
        }
        yield* store.commit({
          event: {
            missionId,
            kind: "recovery.incident-opened",
            actor: SYSTEM_ACTOR,
            provenance: SYSTEM,
            summary,
            subject: null,
            payload: {
              incidentId: incident.id,
              cause: incident.cause,
              label,
              threads: threads.map((thread) => ({
                threadId: thread.threadId,
                title: thread.title,
                lane: thread.laneName,
                position: thread.position,
                action: thread.action,
                reason: thread.reason,
                lostChildren: thread.lostChildren.length,
                ...(thread.bootCuts === undefined ? {} : { bootCuts: thread.bootCuts }),
              })),
            },
          },
          upserts,
          ...(index === 0
            ? {
                alongside: recovery
                  .saveIncident(incident, now)
                  .pipe(
                    Effect.andThen(recovery.markSeen(seen, incident.id, now)),
                    Effect.andThen(recovery.saveChains(chains, incident.id, now)),
                  ),
              }
            : {}),
        });
      }
      return incident;
    });

  const toThread = (
    planned: Planned,
    position: number,
    titles: ReadonlyMap<string, RecoveryStore.ThreadRow>,
  ): RecoveryThread => {
    const { member, cut } = planned;
    const bootCuts = planned.bootCuts ?? 0;
    // The master still gets its summary; its notice says not to rerun its own turn.
    const stopped =
      bootCuts >= Model.MAX_BOOT_CUTS &&
      member.roleKind !== "master" &&
      (planned.action === "resume" || planned.action === "reconcile-first");
    return {
      missionId: member.missionId,
      threadId: member.threadId,
      title: titles.get(member.threadId)?.title ?? member.threadId,
      roleId: member.roleId,
      roleKind: member.roleKind,
      laneId: member.laneId,
      laneName: member.laneName,
      subMissionId: member.subMissionId,
      position,
      cutRunId: cut?.runId ?? null,
      lastActivity: cut === null ? null : Model.activityOf(cut.items),
      lastActivityAt: cut?.completedAt ?? null,
      serverContinued: cut?.serverContinued ?? false,
      interruptReason: cut === null ? null : (cut.interruptMessage ?? cut.errorMessage),
      handoffFrom: null,
      lostChildren: planned.lost.map(Model.describeChild),
      holds: planned.holds,
      action: planned.action,
      reason: planned.reason,
      state: planned.action === "skip" ? "skipped" : stopped ? "held" : "pending",
      stateReason:
        planned.action === "skip"
          ? planned.reason
          : stopped
            ? Model.bootStopReason(bootCuts)
            : null,
      instruction: null,
      noticeAt: null,
      decidedBy: null,
      ...(bootCuts > 0 ? { bootCuts } : {}),
    };
  };

  const collect = (input: CollectInput) =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      const restart = input.cause !== "run-interrupted";
      const views = yield* loadViews(now);
      const threadIds = [...new Set(views.flatMap((view) => view.members.map((m) => m.threadId)))];
      if (threadIds.length === 0) {
        yield* recovery.markSeen(input.extraSeen, null, now);
        return null;
      }
      const memberSet = new Set<string>(threadIds);
      const rows =
        input.runIds === null
          ? yield* recovery.cutRuns({ threadIds, from: input.window.from, to: input.window.to })
          : yield* recovery.cutRunsById(input.runIds);
      const candidates = rows.filter((row) => memberSet.has(row.threadId) && Model.isCut(row));
      const runSeen = yield* recovery.seenKeys(candidates.map((row) => `run:${row.runId}`));
      const cuts = new Map<string, RecoveryStore.CutRunRow>();
      for (const row of candidates) {
        if (runSeen.has(`run:${row.runId}`)) continue;
        const previous = cuts.get(row.threadId);
        if (previous === undefined || row.ordinal > previous.ordinal) cuts.set(row.threadId, row);
      }

      // Boots in a row that cut the same turn: a cut continues the chain when
      // the previous boot cut it too and no run of the thread completed since.
      // Each boot counts once, whether a restart report or the boot check saw it.
      const chainUpdates: Array<RecoveryStore.BootChain> = [];
      const bootCuts = new Map<string, number>();
      const bootId = input.cause === "server-restart" ? input.bootId : null;
      if (bootId !== null) {
        const prior = yield* recovery.chains(threadIds);
        // The whole-window boot check ends the chain of a thread this boot did not cut.
        if (input.runIds === null) {
          for (const chain of prior.values()) {
            if (chain.bootId !== bootId && !cuts.has(chain.threadId)) {
              chainUpdates.push({ ...chain, cuts: 0 });
            }
          }
        }
        for (const cut of cuts.values()) {
          const before = prior.get(cut.threadId);
          if (Model.isOwnerStop(cut)) {
            if (before !== undefined) chainUpdates.push({ ...before, cuts: 0 });
            continue;
          }
          let count = 1;
          if (before !== undefined && before.bootId === bootId) {
            count = before.cuts;
          } else if (before !== undefined && before.ordinal < cut.ordinal) {
            const completed = yield* recovery.lastCompleted(cut.threadId, cut.ordinal);
            if (completed === null || completed < before.ordinal) count = before.cuts + 1;
          }
          bootCuts.set(cut.threadId, count);
          chainUpdates.push({
            threadId: cut.threadId,
            runId: cut.runId,
            ordinal: cut.ordinal,
            cuts: count,
            bootId,
          });
        }
      }

      const children = yield* recovery.children({ threadIds, since: input.window.from });
      const childSeen = yield* recovery.seenKeys(children.map((child) => `child:${child.id}`));
      const childWindow = { from: input.window.from, to: now };
      const lostOf = (threadId: string, cut: RecoveryStore.CutRunRow | null) => {
        const own = children.filter(
          (child) => child.threadId === threadId && !childSeen.has(`child:${child.id}`),
        );
        if (restart) return Model.pickLost(own, childWindow, cut?.runId ?? null, input.named);
        // Outside a restart only the cut run's own children went down with it.
        return cut === null
          ? []
          : Model.pickLost(
              own.filter((child) => child.runId === cut.runId),
              childWindow,
              cut.runId,
            );
      };
      const holdSeen = yield* recovery.seenKeys(
        views.flatMap((view) =>
          [...view.holdsByThread.values()]
            .flat()
            .filter((hold) => hold.reconcileRequired)
            .map((hold) => `hold:${hold.holdId}`),
        ),
      );
      const interrupts = restart
        ? new Map<string, number>()
        : yield* recovery.interruptCounts({ threadIds, since: minus(now, 60 * MINUTE) });
      const titles = new Map(
        (yield* recovery.threads(threadIds)).map((row) => [row.threadId as string, row]),
      );

      const seen: Array<SeenEntry> = [
        ...input.extraSeen,
        ...candidates.map((row) => ({ key: `run:${row.runId}`, threadId: row.threadId })),
      ];
      const planned: Array<Planned> = [];
      for (const view of views) {
        for (const member of view.members) {
          const thread = titles.get(member.threadId);
          if (thread === undefined || thread.gone) continue;
          const cut = cuts.get(member.threadId) ?? null;
          const lost = lostOf(member.threadId, cut);
          const allHolds = view.holdsByThread.get(member.threadId) ?? [];
          const freshReconcile =
            restart &&
            allHolds.some((hold) => hold.reconcileRequired && !holdSeen.has(`hold:${hold.holdId}`));
          if (cut === null && lost.length === 0 && !freshReconcile) continue;
          const holds = allHolds.filter(
            (hold) => hold.reconcileRequired || (cut !== null && hold.status === "active"),
          );
          const plan = Model.planThread({
            member,
            cut,
            lost: lost.map(Model.describeChild),
            holds,
            recentInterrupts: interrupts.get(member.threadId) ?? 0,
            cause: input.cause,
          });
          planned.push({
            view,
            member,
            cut,
            lost,
            holds,
            action: plan.action,
            reason: plan.reason,
            bootCuts: bootCuts.get(member.threadId) ?? 0,
          });
          seen.push(
            ...lost.map((child) => ({ key: `child:${child.id}`, threadId: member.threadId })),
            ...holds
              .filter((hold) => hold.reconcileRequired)
              .map((hold) => ({ key: `hold:${hold.holdId}`, threadId: member.threadId })),
          );
        }
      }

      const threads: Array<RecoveryThread> = [];
      const missionIds: Array<MissionId> = [];
      for (const view of views) {
        const mine = planned.filter((entry) => entry.view === view);
        const acting = mine.filter(
          (entry) => entry.member.roleKind !== "master" && entry.action !== "skip",
        );
        const masterEntry = mine.find((entry) => entry.member.roleKind === "master");
        if (acting.length === 0 && (masterEntry === undefined || masterEntry.action === "skip"))
          continue;
        // One lane failing on its own doesn't need the master; a restart or several do.
        const needsMaster =
          restart ||
          acting.length >= 2 ||
          acting.some((entry) => entry.action === "reconcile-first");
        const masterMember = view.members.find((member) => member.roleKind === "master");
        const withMaster =
          masterEntry === undefined &&
          needsMaster &&
          masterMember !== undefined &&
          titles.get(masterMember.threadId)?.gone === false
            ? [
                ...mine,
                {
                  view,
                  member: masterMember,
                  cut: null,
                  lost: [],
                  holds: [],
                  ...Model.planThread({
                    member: masterMember,
                    cut: null,
                    lost: [],
                    holds: [],
                    recentInterrupts: 0,
                    cause: input.cause,
                  }),
                },
              ]
            : mine;
        Model.orderThreads(withMaster).forEach((entry, position) =>
          threads.push(toThread(entry, position, titles)),
        );
        missionIds.push(view.mission.id);
      }

      if (missionIds.length === 0) {
        yield* recovery.atomic(
          recovery
            .markSeen(seen, null, now)
            .pipe(Effect.andThen(recovery.saveChains(chainUpdates, null, now))),
        );
        return null;
      }
      const latestCut = [...cuts.values()]
        .flatMap((row) => (row.completedAt === null ? [] : [row.completedAt]))
        .toSorted()
        .at(-1);
      const incident: RecoveryIncident = {
        id: input.id,
        cause: input.cause,
        source: input.source,
        detectedAt: now,
        windowStart: input.window.from,
        windowEnd: input.windowEnd ?? latestCut ?? input.window.to,
        downSeconds: input.downSeconds,
        missionIds,
        threads,
        clearedAt: null,
      };
      return yield* persistOpened(incident, seen, now, restart, chainUpdates);
    });

  const start = Effect.gen(function* () {
    const current = yield* Ref.get(bootRef);
    if (current !== null) return current;
    const at = yield* nowIso;
    const info = yield* recovery.recordBoot({
      bootId: `boot-${compact(at)}-${process.pid}`,
      pid: process.pid,
      at,
    });
    yield* Ref.set(bootRef, info);
    return info;
  });

  /**
   * Leases that ran out while the server was down become reconcile-required
   * first. Best effort: a failure here never costs the boot incident.
   */
  const expireHolds = Option.match(policy, {
    onNone: () => Effect.void,
    onSome: (service) =>
      service.expireHolds.pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("missions recovery: expiring pool holds failed", {
              cause: Cause.pretty(cause),
            }),
        ),
      ),
  });

  const detectBoot = lock.withPermit(
    Effect.gen(function* () {
      const info = yield* start;
      yield* Ref.set(bootChecked, true);
      yield* expireHolds;
      const key = `boot:${info.bootId}`;
      if ((yield* recovery.seenKeys([key])).size > 0) return null;
      const now = yield* nowIso;
      const from =
        info.previousBeatAt === null
          ? minus(info.startedAt, FIRST_BOOT_WINDOW_MS)
          : minus(info.previousBeatAt, BOOT_SLACK_MS);
      const downSeconds =
        info.previousBeatAt === null
          ? null
          : Math.max(
              0,
              Math.round((Date.parse(info.startedAt) - Date.parse(info.previousBeatAt)) / 1000),
            );
      return yield* collect({
        cause: "server-restart",
        id: `rcv-${info.bootId}`,
        source: COMPONENT,
        window: { from, to: now },
        windowEnd: info.startedAt,
        downSeconds,
        runIds: null,
        named: new Set(),
        extraSeen: [{ key, threadId: "" }],
        bootId: info.bootId,
      });
    }),
  );

  const beat = lock.withPermit(
    Effect.gen(function* () {
      const info = yield* start;
      yield* recovery.beat(info.bootId, yield* nowIso);
    }),
  );

  const scan = lock.withPermit(
    Effect.gen(function* () {
      // Runs cut by the restart itself belong to the boot incident.
      if (!(yield* Ref.get(bootChecked))) return null;
      const info = yield* start;
      const now = yield* nowIso;
      const lookback = minus(now, SCAN_LOOKBACK_MS);
      const from = lookback > info.startedAt ? lookback : info.startedAt;
      const to = minus(now, SCAN_SETTLE_MS);
      if (to <= from) return null;
      return yield* collect({
        cause: "run-interrupted",
        id: `rcv-run-${compact(now)}`,
        source: COMPONENT,
        window: { from, to },
        windowEnd: null,
        downSeconds: null,
        runIds: null,
        named: new Set(),
        extraSeen: [],
        bootId: null,
      });
    }),
  );

  // --- sending notices ---

  const noticeFor = Effect.fn("RecoveryService.noticeFor")(function* (
    incident: RecoveryIncident,
    thread: RecoveryThread,
    queue: boolean,
    now: string,
  ) {
    const at = Model.clockLabel(
      incident.cause === "run-interrupted"
        ? (thread.lastActivityAt ?? incident.windowEnd)
        : incident.windowEnd,
      delivery.timeZone,
    );
    const context = { cause: incident.cause, at };
    if (incident.cause === "succession" || thread.roleKind !== "master") {
      return Model.threadNotice(context, thread);
    }
    const mission = yield* store.get("mission", thread.missionId);
    const settings = yield* settingsOf(thread.missionId);
    return Model.masterNotice({
      context,
      missionTitle: Option.isSome(mission) ? mission.value.title : thread.missionId,
      downSeconds: incident.downSeconds,
      master: thread,
      others: missionThreads(incident, thread.missionId).filter(
        (other) => other.threadId !== thread.threadId,
      ),
      settings,
      lanesStartAt: queue
        ? Model.clockLabel(
            iso(lanesStartAfter(incident, true, Date.parse(now), settings)),
            delivery.timeZone,
          )
        : null,
    });
  });

  /**
   * When lanes may start after the master's note: its lead, or, for a note
   * queued behind a busy master's turn, no earlier than MASTER_WAIT_MS after
   * detection, so the master can still read the plan and steer.
   */
  const lanesStartAfter = (
    incident: RecoveryIncident,
    queued: boolean,
    noticeAtMs: number,
    settings: MissionRecoverySettings,
  ) => {
    const lead = noticeAtMs + settings.masterLeadSeconds * 1000;
    return queued ? Math.max(lead, Date.parse(incident.detectedAt) + MASTER_WAIT_MS) : lead;
  };

  /** One notice per incident, mission and thread, whatever route the router picks. */
  const noticeKey = (incident: RecoveryIncident, thread: RecoveryThread) =>
    `${incident.id}:${thread.missionId}:${thread.threadId}`;

  /**
   * Sends one thread's notice. An idle thread gets it through its doorbell; a
   * running one gets it queued, so it lands after the current turn (lanes a
   * boot wake already restarted would otherwise never hear about their lost
   * children). The router keeps a retry to one delivery only on the same route,
   * and the route follows membership and readiness at call time, so recovery
   * records each notice itself: claimed before the router is asked, settled
   * when it answers. A claim left unsettled (the server stopped mid-send) is
   * held for the owner or master.
   */
  const deliver = (start: RecoveryIncident, target: RecoveryThread, now: string) =>
    Effect.gen(function* () {
      const readiness = yield* delivery.readiness(target.threadId);
      const queue = readiness === "busy";
      const settle = (patch: Parameters<typeof patchThread>[2]) =>
        Effect.gen(function* () {
          const next = patchThread(start, target, patch);
          yield* recovery.saveIncident(next, now);
          return { incident: next, sent: false };
        });
      if (readiness === "gone") {
        return yield* settle({ state: "skipped", stateReason: "thread archived or deleted" });
      }
      const key = noticeKey(start, target);
      const claim = yield* recovery.noticeClaim(key);
      if (claim?.state === "sending") {
        const reason =
          "the last send stopped before it was confirmed; release it or resume it now to send again";
        const next = patchThread(start, target, { state: "held", stateReason: reason });
        yield* store.commit({
          event: {
            missionId: target.missionId,
            kind: "recovery.thread-decided",
            actor: SYSTEM_ACTOR,
            provenance: SYSTEM,
            summary: `Recovery notice to ${who(target)} held: ${reason}.`,
            subject: threadRef(target),
            payload: {
              incidentId: start.id,
              mode: "held-unconfirmed",
              threadIds: [target.threadId],
            },
          },
          alongside: recovery.saveIncident(next, now),
        });
        return { incident: next, sent: false };
      }
      let outcome: SystemNoticeOutcome | null = null;
      if (claim?.state !== "sent") {
        const text = yield* noticeFor(start, target, queue, now);
        yield* recovery.claimNotice({
          key,
          incidentId: start.id,
          missionId: target.missionId,
          threadId: target.threadId,
          at: now,
        });
        // A human-approved resend gets a fresh router key: its text may differ.
        const attempt = claim?.attempt ?? 0;
        const result = yield* delivery
          .notify({
            missionId: target.missionId,
            threadId: target.threadId,
            text,
            key: attempt === 0 ? key : `${key}#${attempt}`,
            queue,
          })
          .pipe(Effect.result);
        if (Result.isFailure(result)) {
          // The router refused it: nothing went out, so a later round may send it.
          yield* recovery.unclaimNotice(key, now);
          return yield* settle(
            result.failure.code === "not-found"
              ? { state: "skipped", stateReason: "thread no longer exists" }
              : { state: "failed", stateReason: result.failure.detail },
          );
        }
        outcome = result.success;
        yield* recovery.settleNotice(key, outcome, now);
      }
      // A retry follows the first attempt's route, which may have been the room.
      const queued = queue && outcome?._tag === "sent";
      const next = patchThread(start, target, {
        state: "sent",
        stateReason: queued ? QUEUED_REASON : null,
        noticeAt: now,
      });
      const title = Model.truncate(target.title, 80);
      yield* store.commit({
        event: {
          missionId: target.missionId,
          kind: "recovery.notice-sent",
          actor: SYSTEM_ACTOR,
          provenance: SYSTEM,
          summary: queued
            ? `Recovery notice queued for ${who(target)} (${title}) behind its running turn: ${target.action}.`
            : `Recovery notice sent to ${who(target)} (${title}): ${target.action}.`,
          subject: threadRef(target),
          payload: {
            incidentId: start.id,
            action: target.action,
            position: target.position,
            route: outcome === null ? "already-sent" : outcome._tag,
            queued,
            ...(outcome?._tag === "posted"
              ? { roomId: outcome.roomId, messageId: outcome.messageId }
              : {}),
          },
        },
        alongside: recovery.saveIncident(next, now),
      });
      return { incident: next, sent: outcome !== null };
    });

  const pumpMission = (start: RecoveryIncident, missionId: MissionId, now: string) =>
    Effect.gen(function* () {
      let incident = start;
      let sent = 0;
      const nowMs = Date.parse(now);
      if (nowMs - Date.parse(incident.detectedAt) > GIVE_UP_MS) {
        for (const thread of missionThreads(incident, missionId).filter(sendable)) {
          incident = patchThread(incident, thread, {
            state: "skipped",
            stateReason: "not delivered within 12 hours",
          });
        }
        if (incident !== start) yield* recovery.saveIncident(incident, now);
      }
      const settings = yield* settingsOf(missionId);
      const master =
        incident.cause === "succession"
          ? undefined
          : missionThreads(incident, missionId).find(
              (thread) => thread.roleKind === "master" && thread.action !== "skip",
            );
      if (master !== undefined && sendable(master)) {
        const out = yield* deliver(incident, master, now);
        incident = out.incident;
        if (out.sent) sent += 1;
      }
      const masterNow =
        master === undefined
          ? undefined
          : missionThreads(incident, missionId).find(
              (thread) => thread.threadId === master.threadId,
            );
      const lanesOpenAt =
        masterNow === undefined
          ? 0
          : masterNow.noticeAt !== null
            ? lanesStartAfter(
                incident,
                masterNow.stateReason === QUEUED_REASON,
                Date.parse(masterNow.noticeAt),
                settings,
              )
            : sendable(masterNow)
              ? Date.parse(incident.detectedAt) + MASTER_WAIT_MS
              : 0;
      if (nowMs < lanesOpenAt) return { incident, sent };
      const lanes = missionThreads(incident, missionId).filter(
        (thread) => thread.threadId !== master?.threadId,
      );
      let budget =
        settings.resumePerMinute -
        lanes.filter(
          (thread) => thread.noticeAt !== null && nowMs - Date.parse(thread.noticeAt) < MINUTE,
        ).length;
      for (const thread of lanes) {
        if (budget <= 0) break;
        if (!sendable(thread)) continue;
        const out = yield* deliver(incident, thread, now);
        incident = out.incident;
        if (out.sent) {
          budget -= 1;
          sent += 1;
        }
      }
      return { incident, sent };
    });

  const maybeClear = (incident: RecoveryIncident, now: string) =>
    Effect.gen(function* () {
      if (incident.clearedAt !== null || incident.threads.some(Model.isOpen)) return incident;
      const next = { ...incident, clearedAt: now };
      const label = Model.stateLabel(incident.cause, incident.windowEnd, delivery.timeZone);
      for (const [index, missionId] of incident.missionIds.entries()) {
        const threads = missionThreads(incident, missionId);
        yield* store.commit({
          event: {
            missionId,
            kind: "recovery.incident-cleared",
            actor: SYSTEM_ACTOR,
            provenance: SYSTEM,
            summary: `${label}: done. ${threads.filter((t) => t.state === "sent").length} notice(s) sent, ${threads.filter((t) => t.state !== "sent").length} skipped or decided.`,
            subject: null,
            payload: { incidentId: incident.id },
          },
          ...(index === 0 ? { alongside: recovery.saveIncident(next, now) } : {}),
        });
      }
      if (incident.missionIds.length === 0) yield* recovery.saveIncident(next, now);
      return next;
    });

  const tick = lock.withPermit(
    Effect.gen(function* () {
      // A planned install resumes threads itself; mission notices wait for it.
      if (yield* delivery.installerPending) return 0;
      const now = yield* nowIso;
      let sent = 0;
      for (const open of yield* recovery.openIncidents) {
        let incident = open;
        for (const missionId of open.missionIds) {
          const out = yield* pumpMission(incident, missionId, now).pipe(
            Effect.catchTags({
              MissionError: (error) =>
                Effect.logWarning("missions recovery: notice round failed", {
                  incidentId: open.id,
                  missionId,
                  error: error.message,
                }).pipe(Effect.as({ incident, sent: 0 })),
            }),
          );
          incident = out.incident;
          sent += out.sent;
        }
        yield* maybeClear(incident, now).pipe(
          Effect.catchTags({
            MissionError: (error) =>
              Effect.logWarning("missions recovery: clearing failed", {
                incidentId: open.id,
                error: error.message,
              }),
          }),
        );
      }
      return sent;
    }),
  );

  // --- reads ---

  const openIncidentFor = (missionId: MissionId) =>
    recovery.openIncidents.pipe(
      Effect.map(
        (incidents) =>
          incidents.findLast((incident) => incident.missionIds.includes(missionId)) ?? null,
      ),
    );

  const state = (missionId: MissionId) =>
    recovery.openIncidents.pipe(
      Effect.map(
        (incidents) =>
          incidents
            .map((incident) =>
              incident.missionIds.includes(missionId)
                ? Model.missionState(incident, missionId, delivery.timeZone)
                : null,
            )
            .findLast((entry) => entry !== null) ?? null,
      ),
    );

  const status = (missionId: MissionId) =>
    Effect.gen(function* () {
      const mission = yield* store.get("mission", missionId);
      if (Option.isNone(mission)) return yield* notFound(`No mission ${missionId}.`);
      const settings = yield* settingsOf(missionId);
      const incident =
        (yield* openIncidentFor(missionId)) ??
        (yield* recovery.recentIncidents).find((entry) => entry.missionIds.includes(missionId)) ??
        null;
      return {
        missionId,
        settings,
        state:
          incident === null ? null : Model.missionState(incident, missionId, delivery.timeZone),
        incident:
          incident === null
            ? null
            : {
                ...incident,
                missionIds: [missionId],
                threads: missionThreads(incident, missionId),
              },
      } satisfies MissionRecoveryStatus;
    });

  // --- policy additions ---
  const incidents = (missionId: MissionId) =>
    Effect.gen(function* () {
      const mission = yield* store.get("mission", missionId);
      if (Option.isNone(mission)) return yield* notFound(`No mission ${missionId}.`);
      const touched = yield* recovery.incidentsOf(missionId);
      return touched.map((incident): RecoveryIncident => ({
        ...incident,
        missionIds: [missionId],
        threads: missionThreads(incident, missionId),
      }));
    });
  // --- end policy additions ---

  // --- owner and master controls ---

  /**
   * The principal deciding a recovery change, as recorded on the thread and
   * its event: the owner, or the master role held by the calling thread. The
   * caller comes from the transport (MCP invocation, owner's app session).
   */
  const authorize = (missionId: MissionId, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const cast = yield* castOf(missionId);
      if (isOwnerProvenance(provenance)) {
        return { by: "owner", actor: { _tag: "owner" }, provenance } as const satisfies Decider;
      }
      if (provenance._tag === "agent") {
        const standing = standingOf(cast, provenance);
        const caller = standing.caller.provenance;
        if (standing.isMaster && caller._tag === "agent" && caller.roleId !== null) {
          return {
            by: "master",
            actor: { _tag: "role", roleId: caller.roleId },
            provenance: caller,
          } as const satisfies Decider;
        }
      }
      return yield* new MissionError({
        code: "forbidden",
        detail: `Only the owner or mission ${missionId}'s master changes its recovery.`,
      });
    });

  const resume = (caller: MissionProvenance, input: RecoveryResumeInput) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          const { by, actor, provenance } = yield* authorize(input.missionId, caller);
          const now = yield* nowIso;
          const targeted = input.threadId !== undefined || input.laneId !== undefined;
          const isTarget = (thread: RecoveryThread) =>
            (input.threadId !== undefined && thread.threadId === input.threadId) ||
            (input.laneId !== undefined && thread.laneId === input.laneId);
          // A thread held in an older incident stays reachable after a newer one opens:
          // prefer the newest incident where the target still waits, then any naming it.
          const incidents = (yield* recovery.openIncidents).filter((entry) =>
            entry.missionIds.includes(input.missionId),
          );
          const naming = (waiting: boolean) =>
            incidents.findLast((entry) =>
              missionThreads(entry, input.missionId).some(
                (thread) => isTarget(thread) && (!waiting || Model.isOpen(thread)),
              ),
            );
          const open =
            (targeted ? (naming(true) ?? naming(false)) : undefined) ?? incidents.at(-1) ?? null;
          if (open === null)
            return yield* notFound(`Mission ${input.missionId} has no open recovery.`);
          const mine = missionThreads(open, input.missionId);
          const targets = mine.filter(isTarget);
          // Threads a human sends again; an unconfirmed earlier send is reopened for them.
          let resent: ReadonlyArray<RecoveryThread> = [];
          if (targeted && targets.length === 0) {
            return yield* notFound(
              `Recovery ${open.id} has no thread ${input.threadId ?? `for lane ${input.laneId}`}.`,
            );
          }
          if (!targeted && input.mode !== "order" && input.mode !== "release") {
            return yield* invalid(`Mode ${input.mode} needs a threadId or laneId.`);
          }
          let incident = open;
          let summary: string;
          switch (input.mode) {
            case "order": {
              const order = input.order ?? [];
              if (order.length === 0) return yield* invalid("Mode order needs the thread order.");
              const master = mine.find(
                (thread) =>
                  thread.position === 0 &&
                  thread.roleKind === "master" &&
                  open.cause !== "succession",
              );
              const listed = order.flatMap((threadId) => {
                const found = mine.find(
                  (thread) => thread.threadId === threadId && thread !== master,
                );
                return found === undefined ? [] : [found];
              });
              const rest = mine.filter((thread) => thread !== master && !listed.includes(thread));
              const ordered = [...(master === undefined ? [] : [master]), ...listed, ...rest];
              ordered.forEach((thread, position) => {
                incident = patchThread(incident, thread, { position });
              });
              summary = `Recovery order set by ${by}: ${listed.map(who).join(", ")} first.`;
              break;
            }
            case "hold": {
              const open = targets.filter(sendable);
              if (open.length === 0)
                return yield* conflict("Those threads already got their notice or were decided.");
              for (const thread of open) {
                incident = patchThread(incident, thread, {
                  state: "held",
                  stateReason: `held by the ${by}`,
                  decidedBy: actor,
                });
              }
              summary = `Recovery held by ${by}: ${open.map(who).join(", ")}.`;
              break;
            }
            case "release": {
              const held = (targeted ? targets : mine).filter((thread) => thread.state === "held");
              resent = held;
              for (const thread of held) {
                incident = patchThread(incident, thread, {
                  state: "pending",
                  stateReason: null,
                  decidedBy: actor,
                });
              }
              summary =
                held.length === 0
                  ? `Recovery release by ${by}: nothing was held.`
                  : `Recovery released by ${by}: ${held.map(who).join(", ")}.`;
              break;
            }
            case "skip": {
              const open = targets.filter((thread) => sendable(thread) || thread.state === "held");
              if (open.length === 0)
                return yield* conflict("Those threads already got their notice or were decided.");
              for (const thread of open) {
                incident = patchThread(incident, thread, {
                  state: "decided",
                  stateReason: `skipped by the ${by}`,
                  decidedBy: actor,
                });
              }
              summary = `Recovery skipped by ${by}: ${open.map(who).join(", ")}.`;
              break;
            }
            case "now": {
              const open = targets.filter((thread) => sendable(thread) || thread.state === "held");
              if (open.length === 0)
                return yield* conflict("Those threads already got their notice or were decided.");
              const front = mine.filter(
                (thread) => thread.roleKind === "master" && thread.position === 0,
              );
              const ordered = [
                ...front,
                ...open.filter((thread) => !front.includes(thread)),
                ...mine.filter((thread) => !front.includes(thread) && !open.includes(thread)),
              ];
              ordered.forEach((thread, position) => {
                incident = patchThread(incident, thread, { position });
              });
              resent = open;
              for (const thread of open) {
                incident = patchThread(incident, thread, {
                  state: "pending",
                  stateReason: null,
                  decidedBy: actor,
                });
              }
              summary = `Recovery resume now by ${by}: ${open.map(who).join(", ")}.`;
              break;
            }
          }
          if (input.instruction !== undefined) {
            if (!targeted) return yield* invalid("An instruction needs a threadId or laneId.");
            const late = targets.filter((thread) => thread.state === "sent");
            if (late.length > 0) {
              return yield* conflict(
                `${late.map(who).join(", ")} already got the notice; send the instruction directly.`,
              );
            }
            for (const thread of targets) {
              incident = patchThread(incident, thread, {
                instruction: input.instruction,
                instructionBy: actor,
                decidedBy: actor,
              });
            }
            summary = `${summary} Instruction: ${input.instruction}`;
          }
          const decided = incident;
          // Sending again after an unconfirmed send is a human's call; this is it.
          const resend = resent.map((thread) => noticeKey(decided, thread));
          yield* store.commit({
            event: {
              missionId: input.missionId,
              kind: "recovery.thread-decided",
              actor,
              provenance,
              summary,
              subject:
                targets.length === 1 && targets[0] !== undefined ? threadRef(targets[0]) : null,
              payload: {
                incidentId: open.id,
                mode: input.mode,
                threadIds: targets.map((thread) => thread.threadId),
                order: input.order ?? null,
                instruction: input.instruction ?? null,
              },
            },
            alongside: recovery
              .saveIncident(decided, now)
              .pipe(Effect.andThen(recovery.reopenNotices(resend, now))),
          });
          if (input.mode === "now") {
            for (const thread of targets) {
              const current = missionThreads(incident, input.missionId).find(
                (entry) => entry.threadId === thread.threadId,
              );
              if (current === undefined || !sendable(current)) continue;
              incident = (yield* deliver(incident, current, now)).incident;
            }
          }
          yield* maybeClear(incident, now);
        }),
      )
      .pipe(Effect.andThen(status(input.missionId)));

  const setSettings = (caller: MissionProvenance, input: RecoverySettingsInput) =>
    lock.withPermit(
      Effect.gen(function* () {
        const { by, actor, provenance } = yield* authorize(input.missionId, caller);
        const now = yield* nowIso;
        const current = yield* settingsOf(input.missionId);
        const next: MissionRecoverySettings = {
          missionId: input.missionId,
          resumePerMinute: input.resumePerMinute ?? current.resumePerMinute,
          masterLeadSeconds: input.masterLeadSeconds ?? current.masterLeadSeconds,
        };
        yield* store.commit({
          event: {
            missionId: input.missionId,
            kind: "recovery.settings-changed",
            actor,
            provenance,
            summary: `Recovery pace set by ${by}: ${next.resumePerMinute} per minute, lanes start ${next.masterLeadSeconds}s after the master's note.`,
            subject: null,
            payload: { before: current, after: next },
          },
          alongside: recovery.saveSettings(next, now),
        });
        return next;
      }),
    );

  // --- stream-recovery reports ---

  const summarize = (incident: RecoveryIncident) =>
    Effect.forEach(incident.missionIds, (missionId) =>
      Effect.gen(function* () {
        const mission = yield* store.get("mission", missionId);
        const threads = missionThreads(incident, missionId);
        const stopped = threads.filter(Model.isBootStopped);
        const count = (action: RecoveryAction) =>
          threads.filter((thread) => thread.action === action && !stopped.includes(thread)).length;
        return {
          missionId,
          title: Option.isSome(mission) ? mission.value.title : missionId,
          threads: threads.length,
          resume: count("resume"),
          reconcile: count("reconcile-first"),
          noticeOnly: count("notice-only"),
          ...(stopped.length === 0
            ? {}
            : {
                stopped: stopped.map((thread) => ({
                  threadId: thread.threadId,
                  title: thread.title,
                  bootCuts: thread.bootCuts ?? Model.MAX_BOOT_CUTS,
                  ...(thread.roleKind === "master" ? { master: true } : {}),
                })),
              }),
        } satisfies RecoveryReportMission;
      }),
    );

  const report = (provenance: MissionProvenance, input: RecoveryReportInput) =>
    lock.withPermit(
      Effect.gen(function* () {
        if (provenance._tag !== "system") {
          return yield* new MissionError({
            code: "provenance-invalid",
            detail: "Restart reports come from a system component's own credential.",
          });
        }
        const members = yield* membersOf(input.threads.map((thread) => thread.threadId));
        if (input.dryRun === true || members.length === 0) {
          return { incidentId: null, members, missions: [] } satisfies RecoveryReportResult;
        }
        const memberSet = new Set<string>(members.map((member) => member.threadId));
        const reportKey = `report:${input.reportId}`;
        const runIds = input.threads
          .filter((thread) => memberSet.has(thread.threadId))
          .flatMap((thread) => thread.runIds);
        const known = [
          ...(yield* recovery.seenIncidents([reportKey, ...runIds.map((id) => `run:${id}`)])),
        ];
        let incident = known[0] === undefined ? null : yield* recovery.incident(known[0]);
        if (incident === null && known.length === 0) {
          const now = yield* nowIso;
          // A reported server restart is this boot; it counts once with the boot check.
          const bootId = input.cause === "server-restart" ? (yield* start).bootId : null;
          incident = yield* collect({
            bootId,
            cause: input.cause,
            id: `rcv-${input.reportId}`,
            source: provenance.component,
            window: { from: input.startAt, to: input.endAt > now ? input.endAt : now },
            windowEnd: input.endAt,
            downSeconds: null,
            runIds,
            named: new Set(input.threads.flatMap((thread) => thread.childIds)),
            extraSeen: [{ key: reportKey, threadId: members[0]?.threadId ?? "" }],
          });
        }
        return {
          incidentId: incident?.id ?? null,
          members,
          missions: incident === null ? [] : yield* summarize(incident),
        } satisfies RecoveryReportResult;
      }),
    );

  // --- role handoffs ---

  const onSuccession = (binding: RoleBinding, missionId: MissionId) =>
    lock.withPermit(
      Effect.gen(function* () {
        if (binding.reason !== "succession" || binding.endedAt !== null) return null;
        const key = `handoff:${binding.id}`;
        if ((yield* recovery.seenKeys([key])).size > 0) return null;
        const now = yield* nowIso;
        const seen: Array<SeenEntry> = [{ key, threadId: binding.threadId }];
        const ended = yield* store.listAllInMission("role-binding", missionId, ["ended"]);
        const previous = ended
          .filter(
            (entry) =>
              entry.roleId === binding.roleId &&
              entry.threadId !== binding.threadId &&
              entry.endedAt !== null,
          )
          .toSorted((left, right) => (right.endedAt ?? "").localeCompare(left.endedAt ?? ""))[0];
        const mission = yield* store.get("mission", missionId);
        if (previous === undefined || Option.isNone(mission)) {
          yield* recovery.markSeen(seen, null, now);
          return null;
        }
        const since = minus(previous.endedAt ?? binding.boundAt, HANDOFF_LOOKBACK_MS);
        const children = Model.handoffChildren(
          yield* recovery.children({ threadIds: [previous.threadId], since }),
          since,
        );
        const view = yield* viewOf(mission.value, now);
        const member = view.members.find((entry) => entry.threadId === binding.threadId);
        if (children.length === 0 || member === undefined) {
          yield* recovery.markSeen(seen, null, now);
          return null;
        }
        const titles = new Map(
          (yield* recovery.threads([binding.threadId, previous.threadId])).map((row) => [
            row.threadId as string,
            row,
          ]),
        );
        const held = Model.holdReason(member);
        const old = titles.get(previous.threadId);
        const thread: RecoveryThread = {
          ...toThread(
            {
              view,
              member,
              cut: null,
              lost: children,
              holds: [],
              action: held === null ? "resume" : "notice-only",
              reason: held ?? `took over from ${old?.title ?? previous.threadId}`,
            },
            0,
            titles,
          ),
          lastActivityAt: binding.boundAt,
          handoffFrom: { threadId: previous.threadId, title: old?.title ?? previous.threadId },
        };
        seen.push(
          ...children.map((child) => ({ key: `child:${child.id}`, threadId: binding.threadId })),
        );
        const incident: RecoveryIncident = {
          id: `rcv-handoff-${binding.id}`,
          cause: "succession",
          source: COMPONENT,
          detectedAt: now,
          windowStart: since,
          windowEnd: binding.boundAt,
          downSeconds: null,
          missionIds: [missionId],
          threads: [thread],
          clearedAt: null,
        };
        return yield* persistOpened(incident, seen, now, false);
      }),
    );

  return RecoveryService.of({
    detectBoot,
    beat,
    scan,
    tick,
    report,
    members: membersOf,
    status,
    incidents,
    resume,
    setSettings,
    onSuccession,
    state,
  });
});

export const layer = Layer.effect(RecoveryService, make);
