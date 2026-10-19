import { describe, expect, it } from "@effect/vitest";
import {
  PoolId,
  ProjectId,
  ScheduledTaskId,
  SubMissionId,
  ThreadId,
  type MissionEvent,
  type MissionProvenance,
  type ScheduledTask,
  type Suggestion,
  type SuggestionTargetKind,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as RuleService from "../core/RuleService.ts";
import { CurrentPrincipal, type GuardPrincipal } from "../guard/principal.ts";
import * as MissionService from "../MissionService.ts";
import { HAIKU, modelKey } from "../policy/models.ts";
import * as PolicyService from "../policy/PolicyService.ts";
import * as PolicyStore from "../policy/PolicyStore.ts";
import { makePorts, OWNER } from "../policy/testing.ts";
import * as MissionStore from "../store/MissionStore.ts";
import * as AsksService from "./AsksService.ts";
import {
  agent,
  governor,
  harness,
  lane,
  laneThread,
  masterThread,
  missionId,
  otherLane,
  otherMissionId,
  ownerApp,
  role,
  seed,
  seedOther,
} from "./AsksService.testkit.ts";
import { registerSuggestionAppliers } from "./wiring.ts";

const master = agent(masterThread);
const evidence = [{ kind: "lane" as const, id: "lane-api" }];

const task = (id: string, threadId: string): ScheduledTask =>
  ({
    id: ScheduledTaskId.make(id),
    title: `Task ${id}`,
    prompt: "Check the queue.",
    enabled: true,
    schedule: { type: "interval", everyMs: 3_600_000 },
    projectId: ProjectId.make("project-1"),
    threadId: ThreadId.make(threadId),
    workspaceStrategy: { type: "root" },
    modelSelection: HAIKU,
    runtimeMode: "full-access",
    interactionMode: "default",
  }) as unknown as ScheduledTask;

const testLayer = () => {
  const tasks = [task("on-lane", laneThread), task("elsewhere", "thread-elsewhere")];
  const enabledCalls: Array<{ readonly id: string; readonly enabled: boolean }> = [];
  // Who the schedule service saw acting: the guard reads this to check and
  // record the change's authority.
  const principals: Array<GuardPrincipal | undefined> = [];
  const unused = () => Effect.die("not used in these tests");
  const schedules = Layer.succeed(
    ScheduledTaskService.ScheduledTaskService,
    ScheduledTaskService.ScheduledTaskService.of({
      list: () => Effect.succeed({ tasks }),
      subscribeList: () => Stream.succeed({ tasks }),
      upsert: (input) =>
        Effect.gen(function* () {
          principals.push(yield* CurrentPrincipal);
          const found = tasks.find((candidate) => candidate.id === input.id)!;
          return { task: { ...found, title: input.title } };
        }),
      setEnabled: (input) =>
        Effect.gen(function* () {
          principals.push(yield* CurrentPrincipal);
          enabledCalls.push(input);
          const found = tasks.find((candidate) => candidate.id === input.id)!;
          return { task: { ...found, enabled: input.enabled } };
        }),
      delete: unused,
      runNow: unused,
      rotateWebhookToken: unused,
      listWebhookDeliveries: unused,
      getWebhookDelivery: unused,
      triggerWebhook: unused,
    }),
  );
  const policy = PolicyService.layer.pipe(
    Layer.provideMerge(PolicyStore.layer),
    Layer.provideMerge(makePorts().layer),
  );
  const layer = Layer.mergeAll(RuleService.layer, policy, schedules).pipe(
    Layer.provideMerge(harness().layer),
  );
  return { enabledCalls, principals, layer };
};

/** Proposes as the governor, then decides; returns the suggestion and its decision event. */
const acceptThrough = (
  targetKind: SuggestionTargetKind,
  target: Suggestion["target"],
  after: unknown,
  decider: MissionProvenance,
) =>
  Effect.gen(function* () {
    const asks = yield* AsksService.AsksService;
    const store = yield* MissionStore.MissionStore;
    const proposed = yield* asks.proposeSuggestion(
      {
        missionId,
        targetKind,
        target,
        title: `Change the ${targetKind}`,
        after,
        diffText: `${targetKind} changes`,
        why: "The evidence says so.",
        evidence,
      },
      governor,
    );
    const decided = yield* asks.decideSuggestion(
      { suggestionId: proposed.id, action: "accept" },
      decider,
    );
    const events = yield* store.eventsSince(missionId, 0, 1000);
    const decision = events.find(
      (event) => event.kind === "suggestion.decided" && event.subject?.id === proposed.id,
    )!;
    const caused = events.filter((event) => event.causedBy === decision.id);
    return { proposed, decided, decision, caused };
  });

const kinds = (events: ReadonlyArray<MissionEvent>) => events.map((event) => event.kind);

describe("suggestion appliers", () => {
  it.effect("every kind applies through its owning service, caused by the decision", () => {
    const { enabledCalls, principals, layer } = testLayer();
    return Effect.gen(function* () {
      yield* seed;
      const store = yield* MissionStore.MissionStore;
      const missions = yield* MissionService.MissionService;
      const rules = yield* RuleService.RuleService;
      const policy = yield* PolicyService.PolicyService;
      const asks = yield* AsksService.AsksService;

      // Before anything registers, the outcome says nothing applies the kind.
      const early = yield* acceptThrough(
        "lane",
        { kind: "lane", id: lane.id },
        { purpose: "Ship the API" },
        master,
      );
      expect(early.decided.outcome).toContain("nothing applies lane suggestions");
      expect(kinds(early.caused)).toEqual(["suggestion.applied"]);

      yield* registerSuggestionAppliers;
      yield* store.commit({
        event: {
          missionId,
          kind: "role.created",
          actor: { _tag: "system", component: "test" },
          provenance: { _tag: "system", component: "test" },
          summary: "reviewer",
          subject: null,
        },
        upserts: [{ _tag: "role", record: role("role-reviewer", "reviewer") }],
      });
      const reviewer = { kind: "role" as const, id: "role-reviewer" };

      // Policy kinds.
      const model = yield* acceptThrough("role-model", reviewer, { modelSelection: HAIKU }, master);
      expect(model.proposed.acceptor).toBe("master");
      expect(model.decided.outcome).toContain("Applied");
      expect(kinds(model.caused)).toContain("role.model-changed");
      expect(kinds(model.caused)).toContain("suggestion.applied");
      const roles = (yield* policy.roles(missionId)).roles;
      expect(modelKey(roles.find((r) => r.id === "role-reviewer")!.modelSelection)).toBe(
        modelKey(HAIKU),
      );

      const publicText = yield* acceptThrough(
        "role",
        reviewer,
        { writesPublicText: false },
        master,
      );
      expect(kinds(publicText.caused)).toContain("role.updated");

      const guide = yield* acceptThrough(
        "criticality-guide",
        { kind: "review-policy", id: missionId },
        { text: "Settlement math is critical." },
        master,
      );
      expect(guide.decided.outcome).toContain("Applied");
      const review = yield* acceptThrough(
        "review-policy",
        { kind: "review-policy", id: missionId },
        { commonRules: ["No round cap."] },
        master,
      );
      expect(review.decided.outcome).toContain("Applied");
      const snapshot = yield* policy.reviewPolicy(missionId);
      expect(snapshot.policy.guide.text).toBe("Settlement math is critical.");
      expect(snapshot.policy.commonRules).toEqual(["No round cap."]);

      yield* policy.createPool(OWNER, {
        poolId: PoolId.make("m-1-review-slots"),
        name: "Review slots",
        unit: "review",
        capacity: 2,
        scope: { _tag: "mission", missionId },
        kind: "lease",
        backend: "native",
      });
      const pool = yield* acceptThrough(
        "pool",
        { kind: "pool", id: "m-1-review-slots" },
        { capacity: 4 },
        master,
      );
      expect(pool.decided.outcome).toContain("capacity 4");

      // Core kinds. Rules quote the owner, so they wait for him.
      const rule = yield* acceptThrough(
        "rule",
        null,
        { title: "Small PRs", quote: "Keep PRs under 400 lines." },
        ownerApp,
      );
      expect(rule.proposed.acceptor).toBe("owner");
      expect(kinds(rule.caused)).toContain("rule.created");
      expect((yield* rules.rules(missionId)).map((r) => r.title)).toContain("Small PRs");

      const first = yield* missions.upsertSubMission(master, { missionId, title: "Backend" });
      const second = yield* missions.upsertSubMission(master, { missionId, title: "Frontend" });
      const order = [SubMissionId.make(second.ref.id), SubMissionId.make(first.ref.id)];
      const reordered = yield* acceptThrough(
        "sub-mission-order",
        { kind: "mission", id: missionId },
        { order },
        master,
      );
      expect(kinds(reordered.caused)).toContain("sub-mission.reordered");

      const renamed = yield* acceptThrough(
        "lane",
        { kind: "lane", id: lane.id },
        { name: "API v2" },
        master,
      );
      expect(renamed.decided.outcome).toContain("Applied");
      const laneNow = yield* store.get("lane", lane.id);
      expect(laneNow._tag === "Some" && laneNow.value.name).toBe("API v2");
      expect(renamed.caused.length).toBeGreaterThanOrEqual(2);

      const paused = yield* acceptThrough(
        "schedule",
        null,
        { taskId: "on-lane", enabled: false },
        master,
      );
      expect(paused.decided.outcome).toBe("Applied: schedule Task on-lane paused.");
      expect(enabledCalls).toEqual([{ id: "on-lane", enabled: false }]);
      const elsewhere = yield* acceptThrough(
        "schedule",
        null,
        { taskId: "elsewhere", enabled: false },
        master,
      );
      expect(elsewhere.decided.outcome).toContain("Not applied");
      expect(elsewhere.decided.outcome).toContain("does not run on this mission's threads");
      expect(enabledCalls).toHaveLength(1);
      // The change ran as the master that decided it, not as an unchecked
      // in-process caller that would leave the task's old authority in place.
      expect(principals).toEqual([{ _tag: "thread", threadId: masterThread, title: masterThread }]);
      const retitled = yield* acceptThrough(
        "schedule",
        null,
        { taskId: "on-lane", title: "Check the queue twice" },
        ownerApp,
      );
      expect(retitled.decided.outcome).toBe("Applied: schedule Check the queue twice updated.");
      expect(principals.at(-1)).toEqual({ _tag: "owner", provenance: ownerApp });

      // Draft notes are the owner's and apply inside asks.
      const note = yield* acceptThrough(
        "draft-note",
        null,
        { missionId, scope: { _tag: "all" }, text: "Lead with the outcome." },
        ownerApp,
      );
      expect(note.proposed.acceptor).toBe("owner");
      expect(note.decided.outcome).toContain("Saved draft note");
      expect((yield* asks.draftNotes(missionId)).map((n) => n.text)).toContain(
        "Lead with the outcome.",
      );

      // A change described only in words is the decider's to make by hand.
      const prose = yield* acceptThrough(
        "lane",
        { kind: "lane", id: lane.id },
        { change: "Split the lane in two" },
        master,
      );
      expect(prose.decided.outcome).toContain("make it by hand");
    }).pipe(Effect.provide(layer));
  });

  it.effect("R1: an accepted suggestion can't reach into another mission", () => {
    const { layer } = testLayer();
    return Effect.gen(function* () {
      yield* seed;
      yield* seedOther;
      yield* registerSuggestionAppliers;
      const asks = yield* AsksService.AsksService;
      const store = yield* MissionStore.MissionStore;
      const propose = (
        suggestionMission: typeof missionId | null,
        targetKind: SuggestionTargetKind,
        target: Suggestion["target"],
        after: unknown,
      ) =>
        asks.proposeSuggestion(
          {
            missionId: suggestionMission,
            targetKind,
            target,
            title: `Change ${targetKind} elsewhere`,
            after,
            diffText: "change",
            why: "The evidence says so.",
            evidence,
          },
          governor,
        );

      // This mission's suggestion pointing at the other mission's lane.
      const parkTheirs = yield* propose(
        missionId,
        "lane",
        { kind: "lane", id: otherLane.id },
        { status: "parked" },
      );
      const decided = yield* asks.decideSuggestion(
        { suggestionId: parkTheirs.id, action: "accept" },
        master,
      );
      expect(decided.outcome).toContain("Not applied");
      expect(decided.outcome).toContain("suggest it there");
      expect(Option.getOrThrow(yield* store.get("lane", otherLane.id)).status).toBe(
        otherLane.status,
      );

      // A global suggestion decided by this master can't reorder the other mission.
      const reorder = yield* propose(
        null,
        "sub-mission-order",
        { kind: "mission", id: otherMissionId },
        [],
      );
      const global = yield* asks.decideSuggestion(
        { suggestionId: reorder.id, action: "accept" },
        master,
      );
      expect(global.outcome).toContain("Not applied");
      expect(global.outcome).toContain(`master of ${otherMissionId}`);
    }).pipe(Effect.provide(layer));
  });
});
