import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  Ask,
  isOwnerProvenance,
  MissionProvenance,
  MissionStreamItem,
  OpenAskInput,
  PoolHold,
} from "./missions.ts";

const decodeAsk = Schema.decodeSync(Ask);
const decodeOpenAsk = Schema.decodeUnknownSync(OpenAskInput);
const decodeProvenance = Schema.decodeUnknownSync(MissionProvenance);
const decodeHold = Schema.decodeUnknownSync(PoolHold);
const decodeStreamItem = Schema.decodeSync(MissionStreamItem);

describe("missions contracts", () => {
  it("only app-typed and verified iMessage provenance counts as the owner", () => {
    const decode = decodeProvenance;
    expect(isOwnerProvenance(decode({ _tag: "owner-app", surface: "web", sessionId: null }))).toBe(
      true,
    );
    expect(
      isOwnerProvenance(decode({ _tag: "owner-imessage", chat: "moni", inboundId: "in-1" })),
    ).toBe(true);
    expect(isOwnerProvenance(decode({ _tag: "agent", threadId: "t-1", roleId: null }))).toBe(false);
    expect(isOwnerProvenance(decode({ _tag: "import", source: "coord.db" }))).toBe(false);
    expect(() =>
      decode({ _tag: "owner-imessage", chat: "someone-else", inboundId: "x" }),
    ).toThrow();
  });

  it("asks carry what they block and no default", () => {
    const ask = decodeAsk({
      id: "ask-1",
      missionId: "m-crpko",
      subMissionId: null,
      askedBy: { _tag: "role", roleId: "role-master" },
      question: "Merge #306 before CRP-12568?",
      context: "",
      options: [{ id: "a", label: "Yes", detail: "" }],
      recommendation: { optionId: "a", reason: "smaller blast radius" },
      blocks: [{ kind: "work-item", id: "wi-306" }],
      costOfWaiting: "release slips a day",
      urgency: "normal",
      status: "open",
      answer: null,
      createdAt: "2026-10-17T08:00:00Z",
      updatedAt: "2026-10-17T08:00:00Z",
    });
    expect(ask.blocks).toHaveLength(1);
    expect("default" in ask).toBe(false);
    expect(() =>
      decodeOpenAsk({
        missionId: "m",
        question: "  ",
        context: "",
        options: [],
        blocks: [],
        costOfWaiting: "",
      }),
    ).toThrow();
  });

  it("holds need a positive fence", () => {
    const decode = decodeHold;
    const base = {
      id: "h-1",
      poolId: "pool-dev",
      missionId: "m",
      holder: { _tag: "lane", laneId: "lane-a" },
      amount: 1,
      purpose: "deploy",
      status: "active",
      leaseExpiresAt: null,
      takenAt: null,
      releasedAt: null,
      releaseNote: null,
      createdAt: "2026-10-17T08:00:00Z",
    };
    expect(decode({ ...base, fence: 3 }).fence).toBe(3);
    expect(() => decode({ ...base, fence: 0 })).toThrow();
  });

  it("stream deltas carry records by kind", () => {
    const item = decodeStreamItem({
      _tag: "remove",
      missionId: "m",
      seq: 4,
      ref: { kind: "knock", id: "k-1" },
    });
    expect(item._tag).toBe("remove");
  });
});
