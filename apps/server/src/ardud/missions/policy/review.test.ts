import {
  type CriticalityVerdict,
  MissionId,
  type MissionActor,
  type PullRequestKey,
  type ReviewPolicy,
  type ReviewRecord,
  ReviewLadderId,
  ReviewRecordId,
  ReviewStageId,
  type Role,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "@effect/vitest";

import { ASTRA_XHIGH, SOL_XHIGH, sameModel } from "./models.ts";
import {
  CRITICAL_LADDER_ID,
  FINAL_STAGE_ID,
  NORMAL_LADDER_ID,
  REVIEWER_STAGE_ID,
  crpkoRule89Guide,
  defaultReviewPolicy,
  editPolicy,
  mayJudge,
  newVerdict,
  reviewPlan,
  validatePolicy,
  validateRecord,
} from "./review.ts";
import { defaultMissionRoles, defaultRoleId, newRole } from "./roles.ts";

const missionId = MissionId.make("crpko");
const pr: PullRequestKey = { repository: "crpko/trading-core", number: 412 };
const master: MissionActor = { _tag: "role", roleId: defaultRoleId(missionId, "master") };
const owner: MissionActor = { _tag: "owner" };
const roles = defaultMissionRoles(missionId, "2026-10-17T00:00:00.000Z");

let clock = 0;
const tick = () =>
  DateTime.formatIso(
    DateTime.add(DateTime.makeUnsafe("2026-10-17T01:00:00.000Z"), { seconds: clock++ }),
  );

function record(
  stageId: ReviewRecord["stageId"],
  headSha: string,
  verdict: ReviewRecord["verdict"],
  findings = verdict === "clear" ? 0 : 2,
): ReviewRecord {
  const at = tick();
  return {
    id: ReviewRecordId.make(`r-${at}`),
    missionId,
    pullRequest: pr,
    stageId,
    headSha,
    roleId: defaultRoleId(missionId, stageId === FINAL_STAGE_ID ? "final-reviewer" : "reviewer"),
    model: "test",
    verdict,
    findings,
    severeFindings: 0,
    links: [],
    createdAt: at,
  };
}

function verdict(
  policy: ReviewPolicy,
  critical: boolean,
  decidedBy: MissionActor,
  previous: CriticalityVerdict | null,
): CriticalityVerdict {
  return newVerdict({
    missionId,
    pullRequest: pr,
    critical,
    reason: critical ? "moves real funds" : "copy change",
    guide: policy.guide,
    decidedBy,
    previous,
    now: tick(),
  });
}

function plan(
  policy: ReviewPolicy,
  headSha: string,
  verdicts: ReadonlyArray<CriticalityVerdict>,
  records: ReadonlyArray<ReviewRecord>,
  facts?: { changedLines?: number; paths?: ReadonlyArray<string>; labels?: ReadonlyArray<string> },
) {
  return reviewPlan({
    policy,
    pullRequest: pr,
    headSha,
    verdicts,
    records,
    roles,
    facts,
    now: tick(),
  });
}

describe("review policy defaults", () => {
  it("a new mission has no guide and every PR is normal", () => {
    const policy = defaultReviewPolicy(missionId, tick());
    validatePolicy(policy, roles);
    const result = plan(policy, "aaa", [], []);
    expect(result.plan.ladderId).toBe(NORMAL_LADDER_ID);
    expect(result.plan.stages.map((stage) => stage.stageId)).toEqual([REVIEWER_STAGE_ID]);
    expect(result.plan.next?.stageId).toBe(REVIEWER_STAGE_ID);
    expect(sameModel(result.plan.next!.modelSelection, SOL_XHIGH)).toBe(true);
    expect(result.plan.mergeAllowed).toBe(false);
  });

  it("a normal PR merges once the reviewer is CLEAR at the exact head", () => {
    const policy = defaultReviewPolicy(missionId, tick());
    const result = plan(policy, "aaa", [], [record(REVIEWER_STAGE_ID, "aaa", "clear")]);
    expect(result.plan.stages[0]?.state).toBe("done-at-head");
    expect(result.plan.next).toBeNull();
    expect(result.plan.mergeAllowed).toBe(true);
  });
});

describe("critical ladder", () => {
  it("runs the Sol reviewer until CLEAR, then the Astra final at the same head", () => {
    const policy = defaultReviewPolicy(missionId, tick());
    const v = verdict(policy, true, master, null);

    const first = plan(policy, "h1", [v], []);
    expect(first.plan.ladderId).toBe(CRITICAL_LADDER_ID);
    expect(first.plan.next?.stageId).toBe(REVIEWER_STAGE_ID);
    expect(sameModel(first.plan.next!.modelSelection, SOL_XHIGH)).toBe(true);

    const records = [record(REVIEWER_STAGE_ID, "h1", "findings")];
    const waiting = plan(policy, "h1", [v], records);
    expect(waiting.plan.next).toBeNull();
    expect(waiting.plan.stages[0]?.state).toBe("needs-rerun");
    expect(waiting.plan.reason).toContain("after the fix is pushed");

    const afterFix = plan(policy, "h2", [v], records);
    expect(afterFix.plan.next?.stageId).toBe(REVIEWER_STAGE_ID);
    expect(afterFix.plan.stages[0]?.state).toBe("needs-rerun");

    records.push(record(REVIEWER_STAGE_ID, "h2", "clear"));
    const final = plan(policy, "h2", [v], records);
    expect(final.plan.stages.map((stage) => stage.state)).toEqual(["done-at-head", "pending"]);
    expect(final.plan.next?.stageId).toBe(FINAL_STAGE_ID);
    expect(sameModel(final.plan.next!.modelSelection, ASTRA_XHIGH)).toBe(true);
    expect(final.plan.mergeAllowed).toBe(false);

    records.push(record(FINAL_STAGE_ID, "h2", "clear"));
    const done = plan(policy, "h2", [v], records);
    expect(done.plan.mergeAllowed).toBe(true);
    expect(done.plan.next).toBeNull();
  });

  it("final findings send the PR back through the reviewer at the new head", () => {
    const policy = defaultReviewPolicy(missionId, tick());
    const v = verdict(policy, true, master, null);
    const records = [
      record(REVIEWER_STAGE_ID, "h1", "clear"),
      record(FINAL_STAGE_ID, "h1", "findings"),
    ];
    const waiting = plan(policy, "h1", [v], records);
    expect(waiting.plan.next).toBeNull();
    expect(waiting.plan.mergeAllowed).toBe(false);

    const pushed = plan(policy, "h2", [v], records);
    expect(pushed.plan.stages.map((stage) => stage.state)).toEqual([
      "done-at-older-head",
      "needs-rerun",
    ]);
    expect(pushed.plan.next?.stageId).toBe(REVIEWER_STAGE_ID);

    records.push(record(REVIEWER_STAGE_ID, "h2", "clear"));
    const again = plan(policy, "h2", [v], records);
    expect(again.plan.next?.stageId).toBe(FINAL_STAGE_ID);
  });

  it("a blocked run can go again at the same head", () => {
    const policy = defaultReviewPolicy(missionId, tick());
    const result = plan(policy, "h1", [], [record(REVIEWER_STAGE_ID, "h1", "blocked", 0)]);
    expect(result.plan.next?.stageId).toBe(REVIEWER_STAGE_ID);
    expect(result.plan.stages[0]?.state).toBe("needs-rerun");
  });
});

describe("new heads", () => {
  it("marks CLEAR records at older heads done-at-older-head and blocks the merge", () => {
    const policy = defaultReviewPolicy(missionId, tick());
    const v = verdict(policy, true, master, null);
    const records = [
      record(REVIEWER_STAGE_ID, "h1", "clear"),
      record(FINAL_STAGE_ID, "h1", "clear"),
    ];
    expect(plan(policy, "h1", [v], records).plan.mergeAllowed).toBe(true);

    const moved = plan(policy, "h2", [v], records);
    expect(moved.plan.stages.map((stage) => stage.state)).toEqual([
      "done-at-older-head",
      "done-at-older-head",
    ]);
    expect(moved.plan.stages[0]?.lastRecordId).toBe(records[0]!.id);
    expect(moved.plan.mergeAllowed).toBe(false);
    expect(moved.plan.next?.stageId).toBe(REVIEWER_STAGE_ID);
  });

  it("ignores records for other PRs and other missions", () => {
    const policy = defaultReviewPolicy(missionId, tick());
    const other = {
      ...record(REVIEWER_STAGE_ID, "h1", "clear"),
      pullRequest: { ...pr, number: 9 },
    };
    const elsewhere = {
      ...record(REVIEWER_STAGE_ID, "h1", "clear"),
      missionId: MissionId.make("juno"),
    };
    expect(plan(policy, "h1", [], [other, elsewhere]).plan.mergeAllowed).toBe(false);
  });
});

describe("verdicts", () => {
  it("the owner's reclassification wins over the master's guide verdict", () => {
    const policy = defaultReviewPolicy(missionId, tick());
    const byMaster = verdict(policy, true, master, null);
    const byOwner = verdict(policy, false, owner, byMaster);
    expect(byOwner.source).toBe("owner");
    expect(byOwner.supersedesId).toBe(byMaster.id);

    const result = plan(
      policy,
      "h1",
      [byMaster, byOwner],
      [record(REVIEWER_STAGE_ID, "h1", "clear")],
    );
    expect(result.plan.ladderId).toBe(NORMAL_LADDER_ID);
    expect(result.plan.verdict?.id).toBe(byOwner.id);
    expect(result.plan.mergeAllowed).toBe(true);

    // A later master reclassification does not undo the owner's word.
    const later = verdict(policy, true, master, byOwner);
    expect(later.source).toBe("reclassified");
    const still = plan(policy, "h1", [byMaster, byOwner, later], []);
    expect(still.plan.ladderId).toBe(NORMAL_LADDER_ID);
  });

  it("a master reclassification replaces the earlier master verdict", () => {
    const policy = defaultReviewPolicy(missionId, tick());
    const first = verdict(policy, false, master, null);
    const second = verdict(policy, true, master, first);
    expect(first.source).toBe("guide");
    expect(second.source).toBe("reclassified");
    expect(plan(policy, "h1", [first, second], []).plan.ladderId).toBe(CRITICAL_LADDER_ID);
  });

  it("a hard trigger forces critical without asking and hands back the verdict to store", () => {
    const policy = editPolicy(
      defaultReviewPolicy(missionId, tick()),
      { guide: crpkoRule89Guide(tick(), master) },
      { by: master, byOwner: false, now: tick() },
    );
    const normal = verdict(policy, false, master, null);
    const result = plan(policy, "h1", [normal], [record(REVIEWER_STAGE_ID, "h1", "clear")], {
      changedLines: 1800,
    });
    expect(result.plan.ladderId).toBe(CRITICAL_LADDER_ID);
    expect(result.unrecordedTrigger?.source).toBe("hard-trigger");
    expect(result.unrecordedTrigger?.critical).toBe(true);
    expect(result.unrecordedTrigger?.reason).toContain("1500+ changed lines");
    expect(result.plan.next?.stageId).toBe(FINAL_STAGE_ID);

    // Once stored, the trigger keeps the PR critical even without facts.
    const stored = result.unrecordedTrigger!;
    const later = plan(policy, "h1", [normal, stored], []);
    expect(later.plan.ladderId).toBe(CRITICAL_LADDER_ID);
    expect(later.unrecordedTrigger).toBeNull();

    // Only the owner can turn a triggered PR back to normal.
    const ownerCall = verdict(policy, false, owner, stored);
    expect(plan(policy, "h1", [normal, stored, ownerCall], []).plan.ladderId).toBe(
      NORMAL_LADDER_ID,
    );
  });

  it("path and label triggers fire too", () => {
    const policy = editPolicy(
      defaultReviewPolicy(missionId, tick()),
      {
        guide: {
          text: "custody code is critical",
          hardTriggers: [
            { _tag: "path", pattern: "services/custody/**" },
            { _tag: "label", label: "critical" },
          ],
        },
      },
      { by: master, byOwner: false, now: tick() },
    );
    expect(plan(policy, "h1", [], [], { paths: ["services/custody/sign.go"] }).plan.ladderId).toBe(
      CRITICAL_LADDER_ID,
    );
    expect(plan(policy, "h1", [], [], { labels: ["Critical"] }).plan.ladderId).toBe(
      CRITICAL_LADDER_ID,
    );
    expect(plan(policy, "h1", [], [], { paths: ["web/app.tsx"] }).plan.ladderId).toBe(
      NORMAL_LADDER_ID,
    );
  });

  it("with a guide, a PR needs a verdict before it can merge", () => {
    const policy = editPolicy(
      defaultReviewPolicy(missionId, tick()),
      { guide: { text: "real funds are critical" } },
      { by: master, byOwner: false, now: tick() },
    );
    expect(policy.guide.version).toBe(1);
    const result = plan(policy, "h1", [], [record(REVIEWER_STAGE_ID, "h1", "clear")]);
    expect(result.plan.mergeAllowed).toBe(false);
    expect(result.plan.reason).toContain("criticality verdict");
  });

  it("lane leads judge only when the policy delegates it", () => {
    const policy = defaultReviewPolicy(missionId, tick());
    const lead = newRole({ missionId, kind: "lane-lead" }, tick());
    const masterRole = roles.find((role) => role.kind === "master") as Role;
    expect(mayJudge(policy, masterRole, false)).toBe(true);
    expect(mayJudge(policy, lead, false)).toBe(false);
    expect(mayJudge({ ...policy, judgedBy: "lane-leads" }, lead, false)).toBe(true);
    expect(mayJudge(policy, null, true)).toBe(true);
  });
});

describe("policy edits", () => {
  it("owner locks refuse master edits but not owner edits", () => {
    const policy = { ...defaultReviewPolicy(missionId, tick()), lockedFields: ["guide"] };
    expect(() =>
      editPolicy(policy, { guide: { text: "x" } }, { by: master, byOwner: false, now: tick() }),
    ).toThrow(/locked/);
    const edited = editPolicy(
      policy,
      { guide: { text: "x" } },
      { by: owner, byOwner: true, now: tick() },
    );
    expect(edited.guide.text).toBe("x");
    expect(edited.version).toBe(2);
    // Other fields stay editable.
    expect(
      editPolicy(policy, { commonRules: ["a"] }, { by: master, byOwner: false, now: tick() })
        .commonRules,
    ).toEqual(["a"]);
  });

  it("custom ladders add their stages after the base ladder", () => {
    const base = defaultReviewPolicy(missionId, tick());
    const mobileStage = ReviewStageId.make("mobile-untested");
    const mobileLadder = ReviewLadderId.make("mobile");
    const policy = editPolicy(
      base,
      {
        stages: [
          ...base.stages,
          {
            id: mobileStage,
            label: "Mobile untested gate",
            roleId: defaultRoleId(missionId, "verifier"),
          },
        ],
        ladders: [
          ...base.ladders,
          {
            id: mobileLadder,
            name: "Mobile",
            appliesTo: "custom",
            condition: "PR touches the mobile app",
            stageIds: [mobileStage],
          },
        ],
      },
      { by: master, byOwner: false, now: tick() },
    );
    validatePolicy(policy, roles);
    const result = reviewPlan({
      policy,
      pullRequest: pr,
      headSha: "h1",
      verdicts: [],
      records: [record(REVIEWER_STAGE_ID, "h1", "clear")],
      roles,
      customLadderIds: [mobileLadder],
      now: tick(),
    });
    expect(result.plan.stages.map((stage) => stage.stageId)).toEqual([
      REVIEWER_STAGE_ID,
      mobileStage,
    ]);
    expect(result.plan.next?.stageId).toBe(mobileStage);
  });

  it("rejects ladders without the standard pair or with unknown stages", () => {
    const policy = defaultReviewPolicy(missionId, tick());
    expect(() => validatePolicy({ ...policy, ladders: policy.ladders.slice(0, 1) }, roles)).toThrow(
      /critical ladder/,
    );
    expect(() =>
      validatePolicy(
        {
          ...policy,
          ladders: [
            ...policy.ladders,
            {
              id: ReviewLadderId.make("x"),
              name: "X",
              appliesTo: "custom",
              condition: "always",
              stageIds: [ReviewStageId.make("nope")],
            },
          ],
        },
        roles,
      ),
    ).toThrow(/unknown stage/);
  });

  it("rejects review records that contradict themselves", () => {
    const policy = defaultReviewPolicy(missionId, tick());
    expect(() => validateRecord(policy, record(REVIEWER_STAGE_ID, "h1", "clear", 3))).toThrow(
      /CLEAR/,
    );
    expect(() =>
      validateRecord(policy, { ...record(ReviewStageId.make("x"), "h1", "clear") }),
    ).toThrow(/unknown review stage/);
  });
});

describe("role models in the plan", () => {
  it("next stage uses the reviewer role's pending model right away", () => {
    const policy = defaultReviewPolicy(missionId, tick());
    const swapped = roles.map((role) =>
      role.kind === "reviewer" ? { ...role, pendingModelSelection: ASTRA_XHIGH } : role,
    );
    const result = reviewPlan({
      policy,
      pullRequest: pr,
      headSha: "h1",
      verdicts: [],
      records: [],
      roles: swapped,
      now: tick(),
    });
    expect(sameModel(result.plan.next!.modelSelection, ASTRA_XHIGH)).toBe(true);
  });
});
