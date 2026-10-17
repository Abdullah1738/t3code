import {
  LaneId,
  PoolId,
  ReviewStageId,
  RoleId,
  ThreadId,
  type MissionEvent,
  type MissionId,
  type PoolHoldId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import * as MissionService from "../MissionService.ts";
import * as MissionStore from "../store/MissionStore.ts";
import { ASTRA_XHIGH, HAIKU, OPUS_XHIGH, SOL_XHIGH, modelKey } from "./models.ts";
import * as PolicyService from "./PolicyService.ts";
import { CRPKO, JUNO, OWNER, SYSTEM, agent, makePorts, testLayer } from "./testing.ts";

const ports = makePorts();
const MASTER = agent("thread-master");
const STRANGER = agent("thread-stranger");
const pr = { repository: "crpko/trading-core", number: 412 };

const kinds = (events: ReadonlyArray<MissionEvent>) => events.map((event) => event.kind);

const setup = Effect.gen(function* () {
  const missions = yield* MissionService.MissionService;
  const policy = yield* PolicyService.PolicyService;
  const store = yield* MissionStore.MissionStore;
  const existing = yield* store.get("mission", CRPKO);
  if (existing._tag === "None") {
    yield* missions.createMission(OWNER, { missionId: CRPKO, slug: "crpko", title: "Crpko" });
    yield* missions.createMission(OWNER, { missionId: JUNO, slug: "juno", title: "Juno" });
    ports.threads.set("thread-master", { exists: true, idle: true, modelSelection: OPUS_XHIGH });
    ports.threads.set("thread-stranger", { exists: true, idle: true, modelSelection: OPUS_XHIGH });
    yield* policy.bindRole(OWNER, {
      roleId: RoleId.make("crpko:master"),
      threadId: ThreadId.make("thread-master"),
    });
  }
  return { missions, policy };
});

const events = (missionId: MissionId) =>
  Effect.gen(function* () {
    const store = yield* MissionStore.MissionStore;
    return yield* store.eventsSince(missionId, 0, 500);
  });

const lane = (laneId: LaneId) =>
  Effect.gen(function* () {
    const store = yield* MissionStore.MissionStore;
    return yield* store.get("lane", laneId);
  });

it.layer(testLayer(ports.layer))("PolicyService", (it) => {
  it.effect("lists registry roles without storing them and binds the master", () =>
    Effect.gen(function* () {
      const { policy } = yield* setup;
      const snapshot = yield* policy.roles(CRPKO);
      const reviewer = snapshot.roles.find((role) => role.kind === "reviewer");
      assert.strictEqual(reviewer?.id, "crpko:reviewer");
      assert.strictEqual(modelKey(reviewer!.modelSelection), modelKey(SOL_XHIGH));
      const defaults = snapshot.defaults.map(String);
      assert.include(defaults, "crpko:reviewer");
      assert.notInclude(defaults, "crpko:master");
      const master = snapshot.bindings.find((binding) => binding.roleId === "crpko:master");
      assert.strictEqual(master?.threadId, "thread-master");
      assert.strictEqual(master?.observedModel, modelKey(OPUS_XHIGH));
    }),
  );

  it.effect("applies a model change at each holder's next turn, never mid-turn", () =>
    Effect.gen(function* () {
      const { policy } = yield* setup;
      ports.threads.set("thread-worker", { exists: true, idle: false, modelSelection: HAIKU });
      const worker = RoleId.make("crpko:writer");
      yield* policy.bindRole(MASTER, { roleId: worker, threadId: ThreadId.make("thread-worker") });
      ports.setModelCalls.length = 0;

      yield* policy.setRoleModel(MASTER, {
        roleId: worker,
        modelSelection: OPUS_XHIGH,
        reason: "needs longer drafts",
      });
      // The holder is mid-turn: nothing switches yet, the change waits.
      assert.deepStrictEqual(ports.setModelCalls, []);
      let role = (yield* policy.roles(CRPKO)).roles.find((r) => r.id === worker)!;
      assert.strictEqual(modelKey(role.pendingModelSelection!), modelKey(OPUS_XHIGH));

      yield* policy.sweep;
      assert.deepStrictEqual(ports.setModelCalls, []);

      // The turn ends; the next sweep sets the model for the next turn.
      ports.threads.get("thread-worker")!.idle = true;
      yield* policy.sweep;
      assert.deepStrictEqual(ports.setModelCalls, [
        { threadId: "thread-worker", model: modelKey(OPUS_XHIGH) },
      ]);
      role = (yield* policy.roles(CRPKO)).roles.find((r) => r.id === worker)!;
      assert.strictEqual(role.pendingModelSelection, null);
      assert.strictEqual(modelKey(role.modelSelection), modelKey(OPUS_XHIGH));

      const changes = (yield* events(CRPKO)).filter((e) => e.kind === "role.model-changed");
      const phases = changes.map((e) => (e.payload as { phase: string }).phase);
      assert.deepStrictEqual(phases, ["requested", "applied"]);
      assert.deepStrictEqual(changes[0]!.actor, {
        _tag: "role",
        roleId: RoleId.make("crpko:master"),
      });
      assert.deepStrictEqual(changes[0]!.provenance, MASTER);
    }),
  );

  it.effect("shows a hand switch as drift instead of switching it back", () =>
    Effect.gen(function* () {
      const { policy } = yield* setup;
      ports.threads.set("thread-scribe", { exists: true, idle: true, modelSelection: HAIKU });
      yield* policy.bindRole(MASTER, {
        roleId: RoleId.make("crpko:scribe"),
        threadId: ThreadId.make("thread-scribe"),
      });
      ports.threads.get("thread-scribe")!.modelSelection = OPUS_XHIGH;
      ports.setModelCalls.length = 0;
      yield* policy.sweep;
      assert.deepStrictEqual(ports.setModelCalls, []);
      const drift = (yield* policy.roles(CRPKO)).drift.find((d) => d.roleId === "crpko:scribe");
      assert.strictEqual(drift?.observed, modelKey(OPUS_XHIGH));
      assert.strictEqual(drift?.expected, modelKey(HAIKU));
    }),
  );

  it.effect("hands a role to a successor with its handoff note and schedules", () =>
    Effect.gen(function* () {
      const { policy } = yield* setup;
      ports.threads.set("thread-editor-1", {
        exists: true,
        idle: true,
        modelSelection: OPUS_XHIGH,
      });
      ports.threads.set("thread-editor-2", { exists: true, idle: true, modelSelection: HAIKU });
      const editor = RoleId.make("crpko:editor");
      yield* policy.bindRole(MASTER, {
        roleId: editor,
        threadId: ThreadId.make("thread-editor-1"),
      });
      ports.setModelCalls.length = 0;
      // The old holder hands over itself.
      const result = yield* policy.succeedRole(agent("thread-editor-1"), {
        roleId: editor,
        threadId: ThreadId.make("thread-editor-2"),
        handoffNote: "brief is half written, see notes/editor.md",
      });
      assert.strictEqual(result.ended.threadId, "thread-editor-1");
      assert.isNotNull(result.ended.endedAt);
      assert.strictEqual(result.binding.reason, "succession");
      assert.strictEqual(result.binding.handoffNote, "brief is half written, see notes/editor.md");
      assert.deepStrictEqual(result.moves, ports.moves);
      // The successor runs the role's model from its next turn.
      assert.deepStrictEqual(ports.setModelCalls, [
        { threadId: "thread-editor-2", model: modelKey(OPUS_XHIGH) },
      ]);
      assert.include(kinds(yield* events(CRPKO)), "role.succession");
    }),
  );

  it.effect("refuses role changes from threads that are not the master", () =>
    Effect.gen(function* () {
      const { policy } = yield* setup;
      const error = yield* Effect.flip(
        policy.setRoleModel(STRANGER, {
          roleId: RoleId.make("crpko:reviewer"),
          modelSelection: HAIKU,
          reason: "",
        }),
      );
      assert.strictEqual(error.code, "forbidden");
      // The Juno master is not Crpko's master either.
      const other = yield* Effect.flip(
        policy.createRole(MASTER, { missionId: JUNO, kind: "writer" }),
      );
      assert.strictEqual(other.code, "forbidden");
    }),
  );

  it.effect("lets the master change any role model; nothing refuses on locks", () =>
    Effect.gen(function* () {
      const { policy } = yield* setup;
      const reviewer = RoleId.make("crpko:verifier");
      yield* policy.updateRole(MASTER, { roleId: reviewer, description: "checks the build" });
      yield* policy.setRoleModel(MASTER, { roleId: reviewer, modelSelection: HAIKU, reason: "" });
      const role = (yield* policy.roles(CRPKO)).roles.find((r) => r.id === reviewer)!;
      assert.strictEqual(modelKey(role.modelSelection), modelKey(HAIKU));
    }),
  );

  it.effect("creates and retires custom roles", () =>
    Effect.gen(function* () {
      const { policy } = yield* setup;
      const created = yield* policy.createRole(MASTER, {
        missionId: CRPKO,
        kind: "custom",
        name: "Mobile tester",
        modelSelection: HAIKU,
      });
      const roleId = RoleId.make(created.ref.id);
      assert.isDefined((yield* policy.roles(CRPKO)).roles.find((r) => r.id === roleId));
      yield* policy.retireRole(MASTER, { roleId });
      assert.isUndefined((yield* policy.roles(CRPKO)).roles.find((r) => r.id === roleId));
      const refused = yield* Effect.flip(
        policy.retireRole(MASTER, { roleId: RoleId.make("crpko:reviewer") }),
      );
      assert.strictEqual(refused.code, "invalid");
      assert.includeMembers(kinds(yield* events(CRPKO)), ["role.created", "role.retired"]);
    }),
  );

  it.effect("runs a critical PR on Sol until clear, then Astra at the exact head", () =>
    Effect.gen(function* () {
      const { policy } = yield* setup;
      const reviewer = ReviewStageId.make("reviewer");
      const final = ReviewStageId.make("final");
      yield* policy.setCriticalityGuide(MASTER, {
        missionId: CRPKO,
        text: "Real-fund movement and custody signing are critical.",
      });
      // With a guide, merging needs a verdict first.
      const unjudged = yield* policy.reviewPlan({
        missionId: CRPKO,
        pullRequest: pr,
        headSha: "h1",
      });
      assert.isFalse(unjudged.mergeAllowed);

      yield* policy.recordCriticality(MASTER, {
        missionId: CRPKO,
        pullRequest: pr,
        critical: true,
        reason: "moves real funds",
      });
      let plan = yield* policy.reviewPlan({ missionId: CRPKO, pullRequest: pr, headSha: "h1" });
      assert.strictEqual(plan.ladderId, "critical");
      assert.strictEqual(plan.next?.stageId, "reviewer");
      assert.strictEqual(modelKey(plan.next!.modelSelection), modelKey(SOL_XHIGH));

      const record = (stageId: typeof reviewer, headSha: string, verdict: "clear" | "findings") =>
        policy.recordReview(SYSTEM, {
          missionId: CRPKO,
          pullRequest: pr,
          stageId,
          headSha,
          verdict,
          findings: verdict === "clear" ? 0 : 2,
        });

      yield* record(reviewer, "h1", "findings");
      plan = yield* policy.reviewPlan({ missionId: CRPKO, pullRequest: pr, headSha: "h1" });
      assert.isNull(plan.next);
      assert.isFalse(plan.mergeAllowed);

      yield* record(reviewer, "h2", "clear");
      plan = yield* policy.reviewPlan({ missionId: CRPKO, pullRequest: pr, headSha: "h2" });
      assert.strictEqual(plan.next?.stageId, "final");
      assert.strictEqual(modelKey(plan.next!.modelSelection), modelKey(ASTRA_XHIGH));

      // The final finds issues; the fix is a new head, so Sol runs again first.
      yield* record(final, "h2", "findings");
      plan = yield* policy.reviewPlan({ missionId: CRPKO, pullRequest: pr, headSha: "h3" });
      assert.deepStrictEqual(
        plan.stages.map((stage) => stage.state),
        ["done-at-older-head", "needs-rerun"],
      );
      assert.strictEqual(plan.next?.stageId, "reviewer");
      assert.isFalse(plan.mergeAllowed);

      yield* record(reviewer, "h3", "clear");
      yield* record(final, "h3", "clear");
      plan = yield* policy.reviewPlan({ missionId: CRPKO, pullRequest: pr, headSha: "h3" });
      assert.isTrue(plan.mergeAllowed);
      assert.isNull(plan.next);

      // A newer head marks every record as older and blocks the merge again.
      plan = yield* policy.reviewPlan({ missionId: CRPKO, pullRequest: pr, headSha: "h4" });
      assert.deepStrictEqual(
        plan.stages.map((stage) => stage.state),
        ["done-at-older-head", "done-at-older-head"],
      );
      assert.isFalse(plan.mergeAllowed);
    }),
  );

  it.effect("records a fired hard trigger and lets the master reclassify it", () =>
    Effect.gen(function* () {
      const { policy } = yield* setup;
      const big = { repository: "crpko/ledger", number: 77 };
      yield* policy.setCriticalityGuide(MASTER, {
        missionId: CRPKO,
        text: "XL diffs are critical.",
        hardTriggers: [{ _tag: "changed-lines", atLeast: 1500 }],
      });
      let plan = yield* policy.reviewPlan({
        missionId: CRPKO,
        pullRequest: big,
        headSha: "a1",
        facts: { changedLines: 2400 },
      });
      assert.strictEqual(plan.verdict?.source, "hard-trigger");
      assert.isTrue(plan.verdict?.critical);
      // Stored: the plan without facts still sees it.
      plan = yield* policy.reviewPlan({ missionId: CRPKO, pullRequest: big, headSha: "a1" });
      assert.strictEqual(plan.ladderId, "critical");

      yield* policy.recordCriticality(MASTER, {
        missionId: CRPKO,
        pullRequest: big,
        critical: false,
        reason: "generated fixtures only",
      });
      plan = yield* policy.reviewPlan({
        missionId: CRPKO,
        pullRequest: big,
        headSha: "a1",
        facts: { changedLines: 2400 },
      });
      assert.strictEqual(plan.ladderId, "normal");
      assert.strictEqual(plan.verdict?.source, "reclassified");

      // The owner's later word wins over the master's.
      yield* policy.recordCriticality(OWNER, {
        missionId: CRPKO,
        pullRequest: big,
        critical: true,
        reason: "touches settlement math",
      });
      plan = yield* policy.reviewPlan({ missionId: CRPKO, pullRequest: big, headSha: "a1" });
      assert.strictEqual(plan.verdict?.source, "owner");
      assert.strictEqual(plan.ladderId, "critical");
      const forbidden = yield* Effect.flip(
        policy.recordCriticality(STRANGER, {
          missionId: CRPKO,
          pullRequest: big,
          critical: false,
          reason: "x",
        }),
      );
      assert.strictEqual(forbidden.code, "forbidden");
    }),
  );

  it.effect("enforces fences, queues by priority and never frees an expired hold", () =>
    Effect.gen(function* () {
      const { policy } = yield* setup;
      const created = yield* policy.createPool(MASTER, {
        poolId: PoolId.make("crpko-dev-env"),
        name: "Crpko dev env",
        unit: "slot",
        capacity: 1,
        scope: { _tag: "mission", missionId: CRPKO },
        kind: "lease",
        backend: "native",
      });
      const poolId = PoolId.make(created.ref.id);
      const first = yield* policy.takeHold(MASTER, {
        poolId,
        missionId: CRPKO,
        purpose: "deploy trading-core",
        ttlSeconds: 600,
      });
      assert.strictEqual(first.hold.status, "active");
      assert.strictEqual(first.hold.fence, 1);

      // Juno's lanes cannot use Crpko's dev env.
      const juno = yield* Effect.flip(
        policy.takeHold(SYSTEM, { poolId, missionId: JUNO, purpose: "x", ttlSeconds: 60 }),
      );
      assert.strictEqual(juno.code, "forbidden");

      const full = yield* Effect.flip(
        policy.takeHold(STRANGER, { poolId, missionId: CRPKO, purpose: "qa", ttlSeconds: 60 }),
      );
      assert.strictEqual(full.code, "pool-full");
      const queued = yield* policy.takeHold(STRANGER, {
        poolId,
        missionId: CRPKO,
        purpose: "qa run",
        ttlSeconds: 60,
        queue: true,
      });
      assert.strictEqual(queued.hold.status, "queued");
      assert.strictEqual(queued.queuePosition, 1);

      const wrong = yield* Effect.flip(
        policy.releaseHold(MASTER, { holdId: first.hold.id, fence: 7, note: "" }),
      );
      assert.strictEqual(wrong.code, "fence-mismatch");

      yield* policy.releaseHold(MASTER, { holdId: first.hold.id, fence: 1, note: "deployed" });
      let view = (yield* policy.pools({ missionId: CRPKO })).pools.find(
        (p) => p.pool.id === poolId,
      )!;
      const admitted = view.holds.find((hold) => hold.id === queued.hold.id)!;
      assert.strictEqual(admitted.status, "active");
      assert.strictEqual(admitted.fence, 2);

      // The lease runs out: the hold needs reconciling and keeps the slot.
      yield* TestClock.adjust("2 minutes");
      yield* policy.sweep;
      view = (yield* policy.pools({ missionId: CRPKO })).pools.find((p) => p.pool.id === poolId)!;
      assert.strictEqual(view.holds[0]?.status, "reconcile-required");
      assert.strictEqual(view.inUse, 1);
      const late = yield* Effect.flip(
        policy.releaseHold(STRANGER, { holdId: admitted.id, fence: 2, note: "" }),
      );
      assert.strictEqual(late.code, "conflict");
      assert.match(late.detail, /^reconcile-required/);
      const blocked = yield* Effect.flip(
        policy.takeHold(MASTER, { poolId, missionId: CRPKO, purpose: "next", ttlSeconds: 60 }),
      );
      assert.strictEqual(blocked.code, "pool-full");

      const notMaster = yield* Effect.flip(
        policy.reconcileHold(STRANGER, {
          holdId: admitted.id,
          fence: 2,
          outcome: "not-started",
          evidence: "qa never ran",
        }),
      );
      assert.strictEqual(notMaster.code, "forbidden");
      yield* policy.reconcileHold(MASTER, {
        holdId: admitted.id,
        fence: 2,
        outcome: "not-started",
        evidence: "qa never ran",
      });
      const next = yield* policy.takeHold(MASTER, {
        poolId,
        missionId: CRPKO,
        purpose: "next",
        ttlSeconds: 60,
      });
      assert.strictEqual(next.hold.fence, 3);
      assert.includeMembers(kinds(yield* events(CRPKO)), [
        "pool.created",
        "pool.hold-taken",
        "pool.hold-queued",
        "pool.hold-released",
        "pool.hold-expired",
        "pool.hold-reconciled",
      ]);
      yield* policy.releaseHold(MASTER, { holdId: next.hold.id as PoolHoldId, fence: 3, note: "" });
    }),
  );

  it.effect("lets the master create a global pool and change its capacity mid-hold", () =>
    Effect.gen(function* () {
      const { policy } = yield* setup;
      const created = yield* policy.createPool(MASTER, {
        poolId: PoolId.make("mac-slots"),
        name: "Mac local slots",
        unit: "slot",
        capacity: 1,
        scope: { _tag: "global" },
        kind: "lease",
        backend: "native",
      });
      const poolId = PoolId.make(created.ref.id);
      const held = yield* policy.takeHold(MASTER, {
        poolId,
        missionId: CRPKO,
        purpose: "xcode build",
        ttlSeconds: 600,
      });
      const waiting = yield* policy.takeHold(SYSTEM, {
        poolId,
        missionId: JUNO,
        purpose: "node build",
        ttlSeconds: 600,
        queue: true,
      });
      assert.strictEqual(waiting.hold.status, "queued");
      yield* policy.setPoolCapacity(MASTER, { poolId, capacity: 2 });
      const view = (yield* policy.pools({})).pools.find((p) => p.pool.id === poolId)!;
      assert.strictEqual(view.pool.capacity, 2);
      assert.deepStrictEqual(
        view.holds.map((hold) => hold.status),
        ["active", "active"],
      );
      // Lowering it never evicts a holder.
      yield* policy.setPoolCapacity(MASTER, { poolId, capacity: 0 });
      const lowered = (yield* policy.pools({})).pools.find((p) => p.pool.id === poolId)!;
      assert.strictEqual(lowered.holds.filter((hold) => hold.status === "active").length, 2);
      const refused = yield* Effect.flip(policy.setPoolCapacity(STRANGER, { poolId, capacity: 5 }));
      assert.strictEqual(refused.code, "forbidden");
      yield* policy.releaseHold(MASTER, { holdId: held.hold.id, fence: held.hold.fence, note: "" });
      yield* policy.releaseHold(SYSTEM, {
        holdId: waiting.hold.id,
        fence: waiting.hold.fence,
        note: "",
      });
    }),
  );

  it.effect("parks an idle lane when a watched pool runs tight and resumes it after", () =>
    Effect.gen(function* () {
      const { missions, policy } = yield* setup;
      const docs = yield* missions.upsertLane(OWNER, { missionId: JUNO, name: "docs" });
      const laneId = LaneId.make(docs.ref.id);
      const created = yield* policy.createPool(OWNER, {
        poolId: PoolId.make("review-budget"),
        name: "Review budget",
        unit: "review",
        capacity: 10,
        scope: { _tag: "global" },
        kind: "budget",
        backend: "native",
      });
      const poolId = PoolId.make(created.ref.id);
      const burst = yield* policy.takeHold(SYSTEM, {
        poolId,
        missionId: JUNO,
        amount: 9,
        purpose: "review burst",
        ttlSeconds: 3600,
      });
      const decision = yield* policy.runGovernor("apply");
      assert.deepStrictEqual(
        decision.actions.map((action) => [action._tag, action.laneId]),
        [["park", laneId]],
      );
      let stored = yield* lane(laneId);
      assert.strictEqual(stored._tag === "Some" && stored.value.status, "parked");

      yield* policy.releaseHold(SYSTEM, {
        holdId: burst.hold.id,
        fence: burst.hold.fence,
        note: "",
      });
      yield* policy.runGovernor("apply");
      stored = yield* lane(laneId);
      assert.strictEqual(stored._tag === "Some" && stored.value.status, "idle");
      const laneEvents = kinds(yield* events(JUNO));
      assert.includeMembers(laneEvents, ["lane.parked", "lane.resumed"]);
      // The governor never touches models.
      assert.notInclude(laneEvents, "role.model-changed");
    }),
  );
});
