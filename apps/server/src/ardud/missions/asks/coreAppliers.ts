/**
 * Applies accepted suggestions core owns (rules, sub-mission order, lanes,
 * schedules) through the same service methods an owner or master edit uses,
 * so the change lands on the timeline with the decider's actor and
 * provenance. Asks provides the decision as the cause of every event these
 * commit (see `MissionCause`).
 *
 * The `after` shapes each kind reads:
 * - rule: `{ title?, quote?, scope?, activation?, status?, masterReading? }`,
 *   targeting a rule to edit it or nothing to add one (title and quote needed).
 * - sub-mission-order: `{ order: SubMissionId[] }` or the bare array.
 * - lane (target the lane): `{ split: { name, purpose?, newLaneId?,
 *   subMissionId?, workItemIds? } }`, `{ mergeInto: LaneId }`, or a patch
 *   `{ name?, purpose?, status?, statusReason?, leadRoleId?, subMissionId? }`.
 * - schedule: `{ taskId, enabled?, title?, prompt?, schedule? }`.
 *
 * A change written only in words (`{ change: "..." }`, as the editor writes
 * them) applies nothing and says so.
 */
import {
  isOwnerProvenance,
  LaneId,
  LaneStatus,
  MissionError,
  MissionId,
  RoleId,
  RuleId,
  RuleScope,
  RuleStatus,
  ScheduledTaskId,
  ScheduledTaskUpsertInput,
  ScheduledTaskUpsertSchedule,
  SubMissionId,
  TrimmedNonEmptyString,
  WorkItemId,
  type MissionProvenance,
  type ScheduledTaskError,
  type SuggestionTargetKind,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import { isMasterOf } from "../core/master.ts";
import type * as RuleService from "../core/RuleService.ts";
import type * as MissionService from "../MissionService.ts";
import { CurrentPrincipal, provenancePrincipal } from "../guard/principal.ts";
import type * as MissionStore from "../store/MissionStore.ts";
import type { SuggestionApply } from "./ports.ts";
import type { SuggestionApplication } from "./suggestionModel.ts";

export const CORE_SUGGESTION_KINDS: ReadonlyArray<SuggestionTargetKind> = [
  "rule",
  "sub-mission-order",
  "lane",
  "schedule",
];

const RuleAfter = Schema.Struct({
  title: Schema.optional(TrimmedNonEmptyString),
  quote: Schema.optional(TrimmedNonEmptyString),
  scope: Schema.optional(RuleScope),
  activation: Schema.optional(Schema.String),
  status: Schema.optional(RuleStatus),
  masterReading: Schema.optional(Schema.String),
});
const OrderAfter = Schema.Union([
  Schema.Array(SubMissionId),
  Schema.Struct({ order: Schema.Array(SubMissionId) }),
]);
const LaneSplitAfter = Schema.Struct({
  split: Schema.Struct({
    name: TrimmedNonEmptyString,
    purpose: Schema.optional(Schema.String),
    newLaneId: Schema.optional(LaneId),
    subMissionId: Schema.optional(Schema.NullOr(SubMissionId)),
    workItemIds: Schema.optional(Schema.Array(WorkItemId)),
  }),
});
const LaneMergeAfter = Schema.Struct({ mergeInto: LaneId });
const LanePatchAfter = Schema.Struct({
  name: Schema.optional(TrimmedNonEmptyString),
  purpose: Schema.optional(Schema.String),
  status: Schema.optional(LaneStatus),
  statusReason: Schema.optional(Schema.NullOr(Schema.String)),
  leadRoleId: Schema.optional(Schema.NullOr(RoleId)),
  subMissionId: Schema.optional(Schema.NullOr(SubMissionId)),
});
const ScheduleAfter = Schema.Struct({
  taskId: ScheduledTaskId,
  enabled: Schema.optional(Schema.Boolean),
  title: Schema.optional(TrimmedNonEmptyString),
  prompt: Schema.optional(TrimmedNonEmptyString),
  schedule: Schema.optional(ScheduledTaskUpsertSchedule),
});
const ProseAfter = Schema.Struct({ change: Schema.String });

const decodeRule = Schema.decodeUnknownOption(RuleAfter);
const decodeOrder = Schema.decodeUnknownOption(OrderAfter);
const decodeLaneSplit = Schema.decodeUnknownOption(LaneSplitAfter);
const decodeLaneMerge = Schema.decodeUnknownOption(LaneMergeAfter);
const decodeLanePatch = Schema.decodeUnknownOption(LanePatchAfter);
const decodeSchedule = Schema.decodeUnknownOption(ScheduleAfter);
const decodeProse = Schema.decodeUnknownOption(ProseAfter);
const decodeScheduleUpsert = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);

const refuse = (code: MissionError["code"], detail: string) =>
  Effect.fail(new MissionError({ code, detail }));
const invalid = (detail: string) => refuse("invalid", detail);

/** A change only described in words is the decider's to make by hand. */
const proseCheck = (after: unknown) =>
  Option.match(decodeProse(after), {
    onNone: () => Effect.void,
    onSome: ({ change }) =>
      invalid(`The suggestion describes the change in words ("${change}"); make it by hand.`),
  });

const decoded = <A>(value: Option.Option<A>, what: string) =>
  Option.match(value, {
    onNone: () => invalid(`The accepted ${what} suggestion has a change asks cannot read.`),
    onSome: (after: A) => Effect.succeed(after),
  });

const definedOnly = <A extends object>(value: A) =>
  Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as {
    [K in keyof A]?: Exclude<A[K], undefined>;
  };

const fromSchedules = (error: ScheduledTaskError) =>
  new MissionError({ code: "invalid", detail: `Schedules: ${error.message}` });

export interface CoreApplierServices {
  readonly store: MissionStore.MissionStore["Service"];
  readonly missions: MissionService.MissionService["Service"];
  readonly rules: RuleService.RuleService["Service"];
  readonly schedules: Pick<
    ScheduledTaskService.ScheduledTaskService["Service"],
    "list" | "upsert" | "setEnabled"
  >;
}

export const makeCoreAppliers = ({
  store,
  missions,
  rules,
  schedules,
}: CoreApplierServices): SuggestionApply => {
  const missionOf = (application: SuggestionApplication) => {
    if (application.suggestion.missionId !== null) {
      return Effect.succeed(application.suggestion.missionId);
    }
    const target = application.target;
    return target !== null && target.kind === "mission"
      ? Effect.succeed(MissionId.make(target.id))
      : invalid("The accepted suggestion names no mission.");
  };

  /**
   * Core's structure writes trust their caller, so the applier checks what the
   * transports check: the change lands on the suggestion's own mission, and
   * the decider is the owner or that mission's master. A global suggestion
   * reaches only the missions its decider runs.
   */
  const guard = (
    application: SuggestionApplication,
    missionId: MissionId,
    provenance: MissionProvenance,
  ) =>
    Effect.gen(function* () {
      const own = application.suggestion.missionId;
      if (own !== null && own !== missionId) {
        return yield* invalid(
          `The suggestion belongs to ${own} but changes ${missionId}; suggest it there.`,
        );
      }
      if (isOwnerProvenance(provenance)) return;
      if (yield* isMasterOf(store, missionId, provenance)) return;
      return yield* refuse(
        "forbidden",
        `Only the owner or the master of ${missionId} changes its structure.`,
      );
    });

  const applyRule = (application: SuggestionApplication, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const after = yield* decoded(decodeRule(application.after), "rule");
      const ruleId =
        application.target !== null && application.target.kind === "rule"
          ? RuleId.make(application.target.id)
          : undefined;
      const existing =
        ruleId === undefined ? null : Option.getOrNull(yield* store.get("rule", ruleId));
      if (ruleId !== undefined && existing === null) {
        return yield* refuse("not-found", `Rule ${ruleId} is gone.`);
      }
      const title = after.title ?? existing?.title;
      const quote = after.quote ?? existing?.quote;
      if (title === undefined || quote === undefined) {
        return yield* invalid("A new rule needs a title and the owner's words as its quote.");
      }
      const rule = yield* rules.upsertRule(provenance, {
        ...(ruleId !== undefined ? { ruleId } : {}),
        missionId: existing === null ? application.suggestion.missionId : existing.missionId,
        title,
        quote,
        ...definedOnly({
          scope: after.scope,
          activation: after.activation,
          status: after.status,
          masterReading: after.masterReading,
        }),
      });
      return `Applied: rule ${rule.number ?? rule.id} ${existing === null ? "added" : "updated"} (${rule.title}).`;
    });

  const applyOrder = (application: SuggestionApplication, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const missionId = yield* missionOf(application);
      yield* guard(application, missionId, provenance);
      const after = yield* decoded(decodeOrder(application.after), "sub-mission order");
      const order = "order" in after ? after.order : after;
      const result = yield* missions.reorderSubMissions(provenance, { missionId, order });
      return `Applied: sub-missions of ${missionId} reordered (seq ${result.seq}).`;
    });

  const applyLane = (application: SuggestionApplication, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const target = application.target;
      if (target === null || target.kind !== "lane") {
        return yield* invalid("The accepted suggestion does not point at a lane.");
      }
      const laneId = LaneId.make(target.id);
      const lane = Option.getOrNull(yield* store.get("lane", laneId));
      if (lane === null) return yield* refuse("not-found", `Lane ${laneId} is gone.`);
      const missionId = lane.missionId;
      yield* guard(application, missionId, provenance);

      const split = decodeLaneSplit(application.after);
      if (Option.isSome(split)) {
        const result = yield* missions.splitLane(provenance, {
          missionId,
          laneId,
          name: split.value.split.name,
          ...definedOnly({
            purpose: split.value.split.purpose,
            newLaneId: split.value.split.newLaneId,
            subMissionId: split.value.split.subMissionId,
            workItemIds: split.value.split.workItemIds,
          }),
        });
        return `Applied: ${lane.name} split, new lane ${split.value.split.name} (seq ${result.seq}).`;
      }
      const merge = decodeLaneMerge(application.after);
      if (Option.isSome(merge)) {
        const result = yield* missions.mergeLanes(provenance, {
          missionId,
          laneId,
          intoLaneId: merge.value.mergeInto,
        });
        return `Applied: ${lane.name} merged into ${merge.value.mergeInto} (seq ${result.seq}).`;
      }
      const patch = definedOnly(yield* decoded(decodeLanePatch(application.after), "lane"));
      if (Object.keys(patch).length === 0) {
        return yield* invalid("The accepted lane suggestion changes nothing.");
      }
      const result = yield* missions.upsertLane(provenance, { missionId, laneId, ...patch });
      return `Applied: lane ${lane.name} updated (${Object.keys(patch).join(", ")}; seq ${result.seq}).`;
    });

  /**
   * Threads working on a mission: role holders, lanes and open forks. Uncapped
   * reads, since a thread missing here refuses a schedule that is the mission's.
   */
  const missionThreads = (missionId: MissionId) =>
    Effect.gen(function* () {
      const bindings = yield* store.listAllInMission("role-binding", missionId, ["bound"]);
      const lanes = yield* store.listAllInMission("lane", missionId);
      const forks = yield* store.listAllInMission("fork", missionId, ["open"]);
      return new Set<string>([
        ...bindings.map((binding) => binding.threadId),
        ...lanes.flatMap((lane) => (lane.threadId === null ? [] : [lane.threadId])),
        ...forks.map((fork) => fork.forkThreadId),
      ]);
    });

  const applySchedule = (application: SuggestionApplication, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const after = yield* decoded(decodeSchedule(application.after), "schedule");
      const { tasks } = yield* schedules.list().pipe(Effect.mapError(fromSchedules));
      const task = tasks.find((candidate) => candidate.id === after.taskId);
      if (task === undefined) {
        return yield* refuse("not-found", `Scheduled task ${after.taskId} is gone.`);
      }
      // Schedules have no mission of their own: a master changes the ones its
      // mission's threads run, the owner any.
      if (!isOwnerProvenance(provenance)) {
        const missionId = application.suggestion.missionId;
        const threads = missionId === null ? new Set<string>() : yield* missionThreads(missionId);
        if (task.threadId === null || !threads.has(task.threadId)) {
          return yield* refuse(
            "forbidden",
            `Schedule ${task.title} does not run on this mission's threads; the owner changes it.`,
          );
        }
      }
      // The change runs with the decider's authority, the way the same edit
      // made directly would: the schedule guard checks it, and the task's
      // recorded authority becomes the decider rather than staying as it was.
      const asDecider = Effect.provideService(CurrentPrincipal, provenancePrincipal(provenance));
      const onlyEnabled =
        after.title === undefined && after.prompt === undefined && after.schedule === undefined;
      if (onlyEnabled) {
        if (after.enabled === undefined) {
          return yield* invalid("The accepted schedule suggestion changes nothing.");
        }
        yield* schedules
          .setEnabled({ id: task.id, enabled: after.enabled })
          .pipe(asDecider, Effect.mapError(fromSchedules));
        return `Applied: schedule ${task.title} ${after.enabled ? "enabled" : "paused"}.`;
      }
      const input = yield* decodeScheduleUpsert({
        id: task.id,
        requireExisting: true,
        title: after.title ?? task.title,
        prompt: after.prompt ?? task.prompt,
        enabled: after.enabled ?? task.enabled,
        schedule: after.schedule ?? task.schedule,
        projectId: task.projectId,
        threadId: task.threadId,
        workspaceStrategy: task.workspaceStrategy,
        modelSelection: task.modelSelection,
        runtimeMode: task.runtimeMode,
        interactionMode: task.interactionMode,
      }).pipe(
        Effect.mapError(
          (cause) => new MissionError({ code: "invalid", detail: `Schedule: ${cause.message}` }),
        ),
      );
      yield* schedules.upsert(input).pipe(asDecider, Effect.mapError(fromSchedules));
      return `Applied: schedule ${input.title} updated.`;
    });

  return (application, provenance) =>
    Effect.gen(function* () {
      yield* proseCheck(application.after);
      switch (application.targetKind) {
        case "rule":
          return yield* applyRule(application, provenance);
        case "sub-mission-order":
          return yield* applyOrder(application, provenance);
        case "lane":
          return yield* applyLane(application, provenance);
        case "schedule":
          return yield* applySchedule(application, provenance);
        default:
          return yield* invalid(`Core does not apply ${application.targetKind} suggestions.`);
      }
    });
};
