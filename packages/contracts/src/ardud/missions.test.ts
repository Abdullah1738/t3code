import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  Ask,
  Draft,
  isOwnerProvenance,
  MissionProvenance,
  MissionStreamItem,
  OpenAskInput,
  PoolHold,
  RuleChangeRequest,
} from "./missions.ts";

const decodeAsk = Schema.decodeSync(Ask);
const decodeOpenAsk = Schema.decodeUnknownSync(OpenAskInput);
const decodeProvenance = Schema.decodeUnknownSync(MissionProvenance);
const decodeHold = Schema.decodeUnknownSync(PoolHold);
const decodeStreamItem = Schema.decodeSync(MissionStreamItem);
const decodeDraft = Schema.decodeUnknownSync(Draft);
const encodeDraft = Schema.encodeSync(Draft);
const decodeRuleChange = Schema.decodeUnknownSync(RuleChangeRequest);

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

  // --- asks additions ---
  it("old fork drafts and rule requests still read", () => {
    const draft = decodeDraft({
      id: "d-1",
      missionId: "m",
      audience: "Linear",
      channel: "linear",
      target: { kind: "ticket", ref: "CRP-1", label: "CRP-1", url: null },
      text: "Fixed in #306.",
      approvedText: null,
      writerRoleId: null,
      source: { kind: "fork", ref: { kind: "fork", id: "fork-1" } },
      appliedNoteIds: [],
      status: "pending",
      rewriteNote: null,
      decidedBy: null,
      decidedAt: null,
      sentAt: null,
      createdAt: "2026-10-17T08:00:00Z",
    });
    expect(draft.source.kind).toBe("master");
    expect(encodeDraft(draft).source.kind).toBe("master");

    const request = decodeRuleChange({
      id: "rcr-1",
      ruleId: "rule-1",
      missionId: null,
      request: "Looser",
      provenance: { _tag: "owner-app", surface: "web", sessionId: null },
      status: "open",
      proposedQuote: null,
      proposedScope: null,
      masterResponse: null,
      createdAt: "2026-10-17T08:00:00Z",
      resolvedAt: null,
      forkId: null,
    });
    expect("forkId" in request).toBe(false);
  });
  // --- end asks additions ---

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
