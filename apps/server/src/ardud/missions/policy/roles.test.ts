import { LaneId, MissionId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { ASTRA_XHIGH, HAIKU, OPUS_XHIGH, SOL_XHIGH, modelKey, sameModel } from "./models.ts";
import {
  defaultLaneRoles,
  defaultMissionRoles,
  defaultRoleId,
  detectDrift,
  finishModelChange,
  newBinding,
  newRole,
  planModelApply,
  requestModelChange,
  succeed,
} from "./roles.ts";

const missionId = MissionId.make("crpko");
const now = "2026-10-17T00:00:00.000Z";
const later = "2026-10-17T01:00:00.000Z";
const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");

describe("role defaults", () => {
  it("seeds the design defaults with stable ids", () => {
    const roles = defaultMissionRoles(missionId, now);
    const byKind = new Map(roles.map((role) => [role.kind, role]));
    expect(sameModel(byKind.get("master")!.modelSelection, OPUS_XHIGH)).toBe(true);
    expect(sameModel(byKind.get("reviewer")!.modelSelection, SOL_XHIGH)).toBe(true);
    expect(sameModel(byKind.get("final-reviewer")!.modelSelection, ASTRA_XHIGH)).toBe(true);
    expect(sameModel(byKind.get("scribe")!.modelSelection, HAIKU)).toBe(true);
    expect(byKind.get("reviewer")!.writesPublicText).toBe(false);
    expect(byKind.get("final-reviewer")!.writesPublicText).toBe(false);
    expect(byKind.get("master")!.id).toBe(defaultRoleId(missionId, "master"));
    expect(defaultMissionRoles(missionId, later).map((role) => role.id)).toEqual(
      roles.map((role) => role.id),
    );

    const lane = defaultLaneRoles(missionId, LaneId.make("harness"), now);
    expect(lane.map((role) => role.id)).toEqual([
      "crpko:lane-lead:harness",
      "crpko:lane-worker:harness",
    ]);
    expect(sameModel(lane[1]!.modelSelection, HAIKU)).toBe(true);
  });

  it("no default role is described as a fork", () => {
    for (const role of defaultMissionRoles(missionId, now)) {
      expect(role.description.toLowerCase()).not.toContain("fork");
    }
  });

  it("custom roles need a name and model", () => {
    expect(() => newRole({ missionId, kind: "custom" }, now)).toThrow(/name and a model/);
    const role = newRole(
      { missionId, kind: "custom", name: "Mobile tester", modelSelection: HAIKU },
      now,
    );
    expect(role.name).toBe("Mobile tester");
  });
});

describe("model changes", () => {
  const master = newRole({ missionId, kind: "master" }, now);

  it("waits for a busy holder's next turn and never switches it mid-turn", () => {
    const pending = requestModelChange(master, HAIKU, later);
    expect(sameModel(pending.modelSelection, OPUS_XHIGH)).toBe(true);
    expect(sameModel(pending.pendingModelSelection!, HAIKU)).toBe(true);

    const busy = planModelApply(pending, [
      { threadId: threadA, exists: true, idle: false, modelSelection: OPUS_XHIGH },
    ]);
    expect(busy.steps).toEqual([{ _tag: "wait-for-turn", threadId: threadA }]);
    expect(busy.complete).toBe(false);

    const idle = planModelApply(pending, [
      { threadId: threadA, exists: true, idle: true, modelSelection: OPUS_XHIGH },
    ]);
    expect(idle.steps[0]?._tag).toBe("apply");
    expect(idle.complete).toBe(true);

    const done = finishModelChange(pending, later);
    expect(sameModel(done.modelSelection, HAIKU)).toBe(true);
    expect(done.pendingModelSelection).toBeNull();
  });

  it("treats a holder already on the new model as applied and gone threads as done", () => {
    const pending = requestModelChange(master, HAIKU, later);
    const plan = planModelApply(pending, [
      { threadId: threadA, exists: true, idle: false, modelSelection: HAIKU },
      { threadId: threadB, exists: false, idle: false, modelSelection: null },
    ]);
    expect(plan.steps.map((step) => step._tag)).toEqual(["applied", "gone"]);
    expect(plan.complete).toBe(true);
  });

  it("asking for the current model cancels a pending change", () => {
    const pending = requestModelChange(master, HAIKU, later);
    expect(requestModelChange(pending, OPUS_XHIGH, later).pendingModelSelection).toBeNull();
  });

  it("never refuses on a locked field", () => {
    const locked = { ...master, lockedFields: ["modelSelection"] };
    expect(requestModelChange(locked, HAIKU, later).pendingModelSelection).not.toBeNull();
  });
});

describe("drift", () => {
  const master = newRole({ missionId, kind: "master" }, now);
  const binding = newBinding({ roleId: master.id, threadId: threadA, reason: "initial", now });

  it("flags a holder running neither the bound nor the pending model", () => {
    expect(detectDrift(master, binding, OPUS_XHIGH)).toBeNull();
    const drift = detectDrift(master, binding, SOL_XHIGH);
    expect(drift?.expected).toBe(modelKey(OPUS_XHIGH));
    expect(drift?.observed).toBe(modelKey(SOL_XHIGH));
  });

  it("a holder still on the old model during a pending change is not drift", () => {
    const pending = requestModelChange(master, HAIKU, later);
    expect(detectDrift(pending, binding, OPUS_XHIGH)).toBeNull();
    expect(detectDrift(pending, binding, HAIKU)).toBeNull();
    expect(detectDrift(pending, binding, SOL_XHIGH)).not.toBeNull();
  });

  it("ended bindings never drift", () => {
    expect(detectDrift(master, { ...binding, endedAt: later }, SOL_XHIGH)).toBeNull();
  });
});

describe("succession", () => {
  const master = newRole({ missionId, kind: "master" }, now);
  const binding = newBinding({ roleId: master.id, threadId: threadA, reason: "initial", now });

  it("ends the old binding and starts the new thread from the handoff note", () => {
    const result = succeed(binding, {
      threadId: threadB,
      handoffNote: "resume from PROGRESS.md",
      now: later,
    });
    expect(result.ended.endedAt).toBe(later);
    expect(result.next.roleId).toBe(master.id);
    expect(result.next.threadId).toBe(threadB);
    expect(result.next.reason).toBe("succession");
    expect(result.next.handoffNote).toBe("resume from PROGRESS.md");
  });

  it("refuses ended bindings and same-thread succession", () => {
    expect(() =>
      succeed({ ...binding, endedAt: later }, { threadId: threadB, handoffNote: null, now }),
    ).toThrow(/already ended/);
    expect(() => succeed(binding, { threadId: threadA, handoffNote: null, now })).toThrow(
      /different thread/,
    );
  });
});
