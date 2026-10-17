import { describe, expect, it } from "@effect/vitest";
import { AskId, LaneId, MissionId, type Ask, type Lane } from "@t3tools/contracts";

import { heldLane, heldRecords } from "./holds.ts";

const at = "2026-10-17T08:00:00.000Z";
const missionId = MissionId.make("m-1");

const ask = (id: string, blocks: Ask["blocks"], status: Ask["status"] = "open"): Ask => ({
  id: AskId.make(id),
  missionId,
  subMissionId: null,
  askedBy: { _tag: "owner" },
  question: `Question ${id}`,
  context: "",
  options: [],
  recommendation: null,
  blocks,
  costOfWaiting: "",
  urgency: "normal",
  status,
  answer: null,
  createdAt: at,
  updatedAt: at,
});

const lane = (overrides: Partial<Lane> = {}): Lane => ({
  id: LaneId.make("lane-1"),
  missionId,
  subMissionId: null,
  name: "Lane",
  purpose: "",
  status: "working",
  statusReason: null,
  leadRoleId: null,
  threadId: null,
  currentItemId: null,
  lastEvidence: null,
  context: null,
  lastActiveAt: null,
  createdAt: at,
  updatedAt: at,
  ...overrides,
});

describe("holds", () => {
  it("lists only records named in open asks", () => {
    const held = heldRecords([
      ask("a1", [{ kind: "lane", id: "lane-1" }]),
      ask("a2", [
        { kind: "lane", id: "lane-1" },
        { kind: "work-item", id: "w1" },
      ]),
      ask("a3", [{ kind: "work-item", id: "w2" }], "answered"),
    ]);
    expect(held.map((entry) => [entry.ref.id, entry.askIds])).toEqual([
      ["lane-1", ["a1", "a2"]],
      ["w1", ["a2"]],
    ]);
  });

  it("waits a lane on its asks and only undoes its own wait", () => {
    const holding = [ask("a1", [{ kind: "lane", id: "lane-1" }])];
    const waiting = heldLane(lane(), holding, at);
    expect(waiting).toMatchObject({
      status: "waiting",
      statusReason: "waiting on ask a1: Question a1",
    });
    expect(heldLane(waiting!, [], at)).toMatchObject({ status: "idle", statusReason: null });

    const otherWait = lane({ status: "waiting", statusReason: "waiting on CI" });
    expect(heldLane(otherWait, holding, at)).toBeNull();
    expect(heldLane(otherWait, [], at)).toBeNull();
    expect(heldLane(lane({ status: "parked" }), holding, at)).toBeNull();
  });
});
