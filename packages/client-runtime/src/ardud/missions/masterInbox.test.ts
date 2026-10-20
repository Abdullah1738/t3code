import { MissionInbox, MissionMasterInbox } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { inboxEntries, inboxTabCounts } from "./inboxViewModel.ts";
import { withMasterInbox } from "./masterInbox.ts";

const T0 = "2026-10-17T08:00:00.000Z";

const approval = (id: string, approver: "owner" | "master") => ({
  id,
  missionId: "m",
  kind: "merge",
  title: `Merge ${id}`,
  detail: "",
  requestedBy: "crw",
  links: [],
  status: "pending",
  staleReason: null,
  decidedBy: null,
  decidedAt: null,
  createdAt: T0,
  approver,
});

const ownerInbox = Schema.decodeUnknownSync(MissionInbox)({
  revision: 1,
  counts: { decide: 0, approve: 1, knocks: 0, suggestions: 0, fyi: 0 },
  asks: [],
  drafts: [],
  approvals: [approval("a-owner", "owner")],
  knocks: [],
  suggestions: [],
  fyi: [],
});

const masterQueue = Schema.decodeUnknownSync(MissionMasterInbox)({
  revision: 1,
  // Complete counts; the lists are capped, so they can hold fewer.
  counts: { approve: 3, suggestions: 0 },
  drafts: [],
  approvals: [approval("a-master", "master"), approval("a-owner", "master")],
  suggestions: [],
});

describe("withMasterInbox", () => {
  it("fills the master queue and its counts", () => {
    const joined = withMasterInbox(ownerInbox, masterQueue);
    expect(joined.masterCounts).toEqual({ approve: 3, suggestions: 0 });
    expect(joined.counts.approve).toBe(1);
    expect(inboxEntries(joined, "approve", "master").map((entry) => entry.record.id)).toEqual([
      "a-master",
    ]);
    expect(inboxEntries(joined, "approve", "owner").map((entry) => entry.record.id)).toEqual([
      "a-owner",
    ]);
    expect(inboxTabCounts(joined, "master").approve).toBe(3);
  });

  it("keeps the owner's copy when both feeds carry a record", () => {
    const joined = withMasterInbox(ownerInbox, masterQueue);
    expect(joined.approvals.filter((record) => record.id === "a-owner")).toHaveLength(1);
  });

  it("counts nothing on the master before its queue arrives", () => {
    const joined = withMasterInbox(ownerInbox, undefined);
    expect(joined.masterCounts).toEqual({ approve: 0, suggestions: 0 });
    expect(joined.approvals).toBe(ownerInbox.approvals);
  });
});
