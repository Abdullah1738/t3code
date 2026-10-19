import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as AsksService from "../asks/AsksService.ts";
import {
  agent,
  failureCode,
  harness,
  laneThread,
  masterThread,
  missionId,
  ownerApp,
  seed,
} from "../asks/AsksService.testkit.ts";
import * as MissionStore from "../store/MissionStore.ts";
import { crowdMissions } from "./crowd.testkit.ts";
import * as RuleService from "./RuleService.ts";

const master = agent(masterThread);
const laneAgent = agent(laneThread);

const rulesLayer = () => {
  const { layer, forks } = harness();
  return { forks, layer: RuleService.layer.pipe(Layer.provideMerge(layer)) };
};

it.effect(
  "the master writes, rewords and retires rules like the owner; each is on the timeline",
  () => {
    const { layer } = rulesLayer();
    return Effect.gen(function* () {
      yield* seed;
      const rules = yield* RuleService.RuleService;
      const store = yield* MissionStore.MissionStore;
      const start = yield* store.latestSeq(missionId);

      const written = yield* rules.upsertRule(master, {
        missionId,
        title: "Quiet deploys",
        quote: "No deploys on Fridays.",
      });
      assert.equal(written.number, 1);
      assert.deepStrictEqual(written.provenance, master);

      // A lane agent cannot write rules.
      assert.equal(
        yield* failureCode(
          rules.upsertRule(laneAgent, { missionId, title: "Mine", quote: "Lanes rule." }),
        ),
        "forbidden",
      );

      // The owner rewords it: new version, owner's words.
      const reworded = yield* rules.upsertRule(ownerApp, {
        ruleId: written.id,
        missionId,
        title: "Quiet deploys",
        quote: "No deploys on Fridays or holidays.",
      });
      assert.equal(reworded.version, 2);
      assert.deepStrictEqual(reworded.provenance, ownerApp);

      // The master records it was relied on, then broken, then retires it.
      yield* rules.recordRuleUse(master, { ruleId: written.id, outcome: "applied" });
      const broken = yield* rules.recordRuleUse(master, {
        ruleId: written.id,
        outcome: "broken",
        note: "Hotfix went out Friday",
      });
      assert.equal(broken.appliedCount, 1);
      assert.equal(broken.brokenCount, 1);
      const retired = yield* rules.upsertRule(master, {
        ruleId: written.id,
        missionId,
        title: "Quiet deploys",
        quote: "No deploys on Fridays or holidays.",
        status: "retired",
      });
      assert.equal(retired.status, "retired");

      // Global rules: any mission's master or the owner; on the global timeline.
      const global = yield* rules.upsertRule(master, {
        missionId: null,
        title: "Plain words",
        quote: "Write plainly.",
      });
      assert.isNull(global.missionId);
      const globalEvents = yield* store.recentEvents(AsksService.GLOBAL_TIMELINE, 5);
      assert.include(
        globalEvents.map((event) => event.kind),
        "rule.created",
      );

      const events = yield* store.eventsSince(missionId, start);
      assert.deepStrictEqual(
        events.map((event) => [event.kind, event.actor._tag]),
        [
          ["rule.created", "thread"],
          ["rule.updated", "owner"],
          ["rule.applied", "thread"],
          ["rule.broken", "thread"],
          ["rule.retired", "thread"],
        ],
      );
    }).pipe(Effect.provide(layer));
  },
);

it.effect("anyone asks for a rule change; the owner can discuss it; the master resolves it", () => {
  const { layer, forks } = rulesLayer();
  return Effect.gen(function* () {
    yield* seed;
    const rules = yield* RuleService.RuleService;
    const rule = yield* rules.upsertRule(ownerApp, {
      missionId,
      title: "Ask with options",
      quote: "Every ask lists options.",
    });

    const fromLane = yield* rules.requestRuleChange(laneAgent, {
      ruleId: rule.id,
      request: "Allow open questions without options.",
    });
    assert.equal(fromLane.status, "open");
    assert.isNull(fromLane.forkId);

    // Missions has no forks: discuss is refused and nothing is forked.
    assert.equal(
      yield* failureCode(
        rules.requestRuleChange(ownerApp, {
          ruleId: rule.id,
          request: "Let's talk about when options don't fit.",
          discuss: true,
        }),
      ),
      "invalid",
    );
    assert.equal(forks.length, 0);
    const discussed = yield* rules.requestRuleChange(ownerApp, {
      ruleId: rule.id,
      request: "Let's talk about when options don't fit.",
    });
    assert.isNull(discussed.forkId);

    // A lane agent cannot resolve; the master can.
    assert.equal(
      yield* failureCode(
        rules.resolveRuleChange(laneAgent, {
          requestId: discussed.id,
          status: "applied",
          response: "Done",
        }),
      ),
      "forbidden",
    );
    // The asker may withdraw its own request.
    const withdrawn = yield* rules.resolveRuleChange(laneAgent, {
      requestId: fromLane.id,
      status: "withdrawn",
      response: "Never mind",
    });
    assert.equal(withdrawn.status, "withdrawn");
    const applied = yield* rules.resolveRuleChange(master, {
      requestId: discussed.id,
      status: "applied",
      response: "Reworded to allow open questions for discovery asks.",
    });
    assert.equal(applied.status, "applied");
    assert.equal(
      yield* failureCode(
        rules.resolveRuleChange(master, {
          requestId: discussed.id,
          status: "declined",
          response: "Again",
        }),
      ),
      "conflict",
    );
  }).pipe(Effect.provide(layer));
});

it.effect("N10: the master of a mission past the first page of missions keeps rule control", () => {
  const { layer } = rulesLayer();
  return Effect.gen(function* () {
    yield* seed;
    yield* crowdMissions;
    const rules = yield* RuleService.RuleService;
    const global = yield* rules.upsertRule(master, {
      missionId: null,
      title: "Plain words",
      quote: "Write plainly.",
    });
    assert.isNull(global.missionId);
    const local = yield* rules.upsertRule(master, {
      missionId,
      title: "Quiet deploys",
      quote: "No deploys on Fridays.",
    });
    assert.equal(local.missionId, missionId);
    // A member is still no master, wherever its mission sits.
    assert.equal(
      yield* failureCode(
        rules.upsertRule(laneAgent, { missionId: null, title: "Mine", quote: "Mine." }),
      ),
      "forbidden",
    );
  }).pipe(Effect.provide(layer));
});
