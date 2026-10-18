import {
  PoolId,
  RoleId,
  SuggestionId,
  ThreadId,
  type MissionProvenance,
  type Suggestion,
  type SuggestionTargetKind,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as MissionService from "../MissionService.ts";
import * as MissionStore from "../store/MissionStore.ts";
import type { SuggestionApplication } from "../asks/suggestionModel.ts";
import { appliersFor } from "./appliers.ts";
import { HAIKU, OPUS_XHIGH, SOL_XHIGH, modelKey } from "./models.ts";
import * as PolicyService from "./PolicyService.ts";
import { newBinding, newRole } from "./roles.ts";
import { CRPKO, OWNER, agent, makePorts, testLayer } from "./testing.ts";

const ports = makePorts();
const MASTER = agent("thread-master");
const IMPORT: MissionProvenance = { _tag: "import", source: "lane-roster" };
const NOW = "2026-10-18T08:00:00.000Z";

const setup = Effect.gen(function* () {
  const missions = yield* MissionService.MissionService;
  const policy = yield* PolicyService.PolicyService;
  const store = yield* MissionStore.MissionStore;
  if ((yield* store.get("mission", CRPKO))._tag === "None") {
    yield* missions.createMission(OWNER, { missionId: CRPKO, slug: "crpko", title: "Crpko" });
    ports.threads.set("thread-master", { exists: true, idle: true, modelSelection: OPUS_XHIGH });
    yield* policy.bindRole(OWNER, {
      roleId: RoleId.make("crpko:master"),
      threadId: ThreadId.make("thread-master"),
    });
  }
  return { policy, store, appliers: appliersFor(policy) };
});

const accepted = (
  targetKind: SuggestionTargetKind,
  target: Suggestion["target"],
  after: unknown,
): SuggestionApplication => ({
  suggestion: {
    id: SuggestionId.make(`suggestion-${targetKind}`),
    missionId: CRPKO,
    targetKind,
    target,
    title: `Change the ${targetKind}`,
    before: null,
    after,
    diffText: "",
    why: "evidence says so",
    evidence: [],
    author: "governor",
    acceptor: "master",
    status: "accepted",
    dismissReason: null,
    outcome: null,
    decidedBy: MASTER,
    decidedAt: NOW,
    createdAt: NOW,
  },
  targetKind,
  target,
  after,
});

it.layer(testLayer(ports.layer))("policy suggestion appliers", (it) => {
  it.effect("applies accepted policy suggestions through the same service calls", () =>
    Effect.gen(function* () {
      const { policy, appliers } = yield* setup;
      const reviewer = { kind: "role" as const, id: "crpko:reviewer" };

      const model = yield* appliers.apply(
        accepted("role-model", reviewer, { modelSelection: HAIKU }),
        MASTER,
      );
      assert.include(model, "Applied");
      let role = (yield* policy.roles(CRPKO)).roles.find((r) => r.id === "crpko:reviewer")!;
      // No holders, so the change completes at once.
      assert.strictEqual(modelKey(role.modelSelection), modelKey(HAIKU));

      yield* appliers.apply(accepted("role", reviewer, { writesPublicText: true }), MASTER);
      role = (yield* policy.roles(CRPKO)).roles.find((r) => r.id === "crpko:reviewer")!;
      assert.isTrue(role.writesPublicText);

      yield* appliers.apply(
        accepted(
          "criticality-guide",
          { kind: "review-policy", id: CRPKO },
          {
            text: "Settlement math is critical.",
            hardTriggers: [{ _tag: "changed-lines", atLeast: 1500 }],
          },
        ),
        MASTER,
      );
      yield* appliers.apply(
        accepted(
          "review-policy",
          { kind: "review-policy", id: CRPKO },
          {
            commonRules: ["No round cap."],
          },
        ),
        MASTER,
      );
      const review = yield* policy.reviewPolicy(CRPKO);
      assert.strictEqual(review.policy.guide.text, "Settlement math is critical.");
      assert.deepStrictEqual(review.policy.commonRules, ["No round cap."]);

      yield* policy.createPool(OWNER, {
        poolId: PoolId.make("crpko-review-slots"),
        name: "Crpko review slots",
        unit: "review",
        capacity: 2,
        scope: { _tag: "mission", missionId: CRPKO },
        kind: "lease",
        backend: "native",
      });
      const pool = yield* appliers.apply(
        accepted("pool", { kind: "pool", id: "crpko-review-slots" }, { capacity: 4 }),
        MASTER,
      );
      assert.include(pool, "capacity 4");
      const view = (yield* policy.pools({ missionId: CRPKO })).pools.find(
        (p) => p.pool.id === PoolId.make("crpko-review-slots"),
      )!;
      assert.strictEqual(view.pool.capacity, 4);

      // Every change is on the timeline with the decider's provenance.
      const store = yield* MissionStore.MissionStore;
      const recent = yield* store.eventsSince(CRPKO, 0, 500);
      for (const kind of ["role.model-changed", "role.updated", "review-policy.updated"]) {
        const event = recent.find((e) => e.kind === kind);
        assert.deepStrictEqual(event?.provenance, MASTER, kind);
      }

      // Kinds other tracks own keep the pending line; bad payloads are refused.
      const lane = yield* appliers.apply(
        accepted("lane", { kind: "lane", id: "lane-1" }, { status: "parked" }),
        MASTER,
      );
      assert.include(lane, "not applied yet");
      const bad = yield* Effect.flip(
        appliers.apply(accepted("pool", { kind: "pool", id: "crpko-review-slots" }, {}), MASTER),
      );
      assert.strictEqual(bad.code, "invalid");
      const stranger = yield* Effect.flip(
        appliers.apply(
          accepted("role-model", reviewer, { modelSelection: SOL_XHIGH }),
          agent("thread-stranger"),
        ),
      );
      assert.strictEqual(stranger.code, "forbidden");
    }),
  );

  it.effect("lets imported holders keep their model and shows the mismatch as drift", () =>
    Effect.gen(function* () {
      const { policy, store } = yield* setup;
      // The import track writes roles and bindings directly, observedModel unknown.
      const lead = newRole({ missionId: CRPKO, kind: "editor", modelSelection: OPUS_XHIGH }, NOW);
      ports.threads.set("thread-imported", { exists: true, idle: true, modelSelection: HAIKU });
      const binding = newBinding({
        roleId: lead.id,
        threadId: ThreadId.make("thread-imported"),
        reason: "import",
        observedModel: null,
        now: NOW,
      });
      yield* store.commit({
        event: {
          missionId: CRPKO,
          kind: "import.applied",
          actor: { _tag: "system", component: "import:lane-roster" },
          provenance: IMPORT,
          summary: "Imported the editor",
          subject: null,
        },
        upserts: [
          { _tag: "role", record: lead },
          { _tag: "role-binding", record: binding },
        ],
      });
      ports.setModelCalls.length = 0;
      yield* policy.sweep;
      assert.deepStrictEqual(ports.setModelCalls, []);
      const snapshot = yield* policy.roles(CRPKO);
      const drift = snapshot.drift.find((d) => d.roleId === lead.id);
      assert.strictEqual(drift?.observed, modelKey(HAIKU));
      assert.strictEqual(drift?.expected, modelKey(OPUS_XHIGH));

      // A later model change on the role does reach the imported holder.
      yield* policy.setRoleModel(MASTER, {
        roleId: lead.id,
        modelSelection: SOL_XHIGH,
        reason: "try Sol",
      });
      assert.deepStrictEqual(ports.setModelCalls, [
        { threadId: "thread-imported", model: modelKey(SOL_XHIGH) },
      ]);
    }),
  );
});
