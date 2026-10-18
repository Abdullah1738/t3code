import { describe, expect, it } from "vite-plus/test";

import {
  approvalRepository,
  pendingRouted,
  previewRouting,
  removeRouteInput,
  reroute,
  routeApproval,
  routeDraft,
  routeLine,
  routingRows,
  setApprovalRouteInput,
  setDraftRouteInput,
} from "./routingViewModel.ts";
import type { ApprovalRoutingTable, Routed } from "./source.ts";

const MASTER = "crpko-master";
const T0 = "2026-10-17T08:00:00.000Z";

const table: ApprovalRoutingTable = {
  missionId: "m" as ApprovalRoutingTable["missionId"],
  version: 3,
  draftRules: [
    { id: "r-github", match: { _tag: "channel", channel: "github" }, approver: "master" },
    { id: "r-pavan", match: { _tag: "person", name: "Pavan" }, approver: "owner" },
  ],
  approvalRules: [
    { id: "r-merge", match: { _tag: "kind", kind: "merge" }, approver: "master" },
    { id: "r-devops", match: { _tag: "repo", repository: "crpko-devops" }, approver: "owner" },
  ],
  updatedAt: T0,
  changes: [],
};

const pr = (label: string) => ({
  kind: "pull-request" as const,
  label,
  url: null,
  ref: label,
});

describe("routing a new record", () => {
  it("lets a person rule beat a channel rule for drafts", () => {
    expect(routeDraft(table, { audience: "pavan ", channel: "github" })).toEqual({
      approver: "owner",
      route: { _tag: "rule", ruleId: "r-pavan", label: "drafts to Pavan" },
    });
    expect(routeDraft(table, { audience: "Dylan", channel: "github" }).approver).toBe("master");
  });

  it("lets a repo rule beat a kind rule for approvals", () => {
    expect(routeApproval(table, { kind: "merge", links: [pr("crpko-devops#759")] })).toEqual({
      approver: "owner",
      route: { _tag: "rule", ruleId: "r-devops", label: "approvals in crpko-devops" },
    });
    expect(routeApproval(table, { kind: "merge", links: [pr("backoffice-core#334")] })).toEqual({
      approver: "master",
      route: { _tag: "rule", ruleId: "r-merge", label: "merge approvals" },
    });
  });

  it("falls back to the owner when nothing matches or there is no table", () => {
    expect(routeDraft(table, { audience: "Sharath", channel: "cliq" })).toEqual({
      approver: "owner",
      route: { _tag: "fallback" },
    });
    expect(routeApproval(null, { kind: "deploy", links: [] }).approver).toBe("owner");
  });

  it("reads the repository from an owner/repo#n link", () => {
    expect(approvalRepository({ links: [pr("Equicom-Crypto/edge-api#316")] })).toBe("edge-api");
    expect(approvalRepository({ links: [] })).toBeNull();
  });
});

describe("re-routing one record", () => {
  const record: Routed & { readonly id: string; readonly createdAt: string } = {
    id: "d-1",
    createdAt: T0,
    approver: "owner",
    route: { _tag: "fallback" },
  };

  it("needs a reason and logs who moved it", () => {
    expect(reroute(record, "master", { _tag: "role", roleId: MASTER as never }, " ", T0).ok).toBe(
      false,
    );
    const moved = reroute(
      record,
      "master",
      { _tag: "role", roleId: MASTER as never },
      "Routine rebase nudge",
      T0,
    );
    expect(moved.ok && moved.value.approver).toBe("master");
    expect(moved.ok && routeLine(moved.value, MASTER)).toBe(
      "Moved to master by master: Routine rebase nudge",
    );
  });

  it("refuses a move to where it already is", () => {
    expect(reroute(record, "owner", { _tag: "owner" }, "why", T0)).toEqual({
      ok: false,
      error: "It is already routed to you.",
    });
  });
});

describe("editing the table", () => {
  let next = 0;
  const newId = () => `r-new-${++next}`;

  it("changes an existing rule in place and adds new ones at the end", () => {
    const changed = setDraftRouteInput(
      table,
      { _tag: "channel", channel: "github" },
      "owner",
      newId,
    );
    expect(changed.ok && changed.value.draftRules.map((r) => [r.id, r.approver])).toEqual([
      ["r-github", "owner"],
      ["r-pavan", "owner"],
    ]);
    expect(changed.ok && changed.value.expectedVersion).toBe(3);
    const added = setApprovalRouteInput(
      table,
      { _tag: "repo", repository: " edge-api " },
      "master",
      newId,
    );
    expect(added.ok && added.value.approvalRules.at(-1)).toEqual({
      id: "r-new-1",
      match: { _tag: "repo", repository: "edge-api" },
      approver: "master",
    });
    expect(setDraftRouteInput(table, { _tag: "person", name: " " }, "owner", newId).ok).toBe(false);
  });

  it("removes a rule and rejects one that is not there", () => {
    const removed = removeRouteInput(table, "r-merge");
    expect(removed.ok && removed.value.approvalRules.map((r) => r.id)).toEqual(["r-devops"]);
    expect(removeRouteInput(table, "nope").ok).toBe(false);
  });

  it("lists rules in the order they apply", () => {
    expect(routingRows(table).map((row) => row.label)).toEqual([
      "drafts to Pavan",
      "drafts on GitHub",
      "approvals in crpko-devops",
      "merge approvals",
    ]);
  });

  it("previews a table without moving anything", () => {
    expect(
      previewRouting(
        table,
        [
          { audience: "Pavan", channel: "github" },
          { audience: "Dylan", channel: "github" },
        ],
        [{ kind: "merge", links: [pr("crpko-devops#759")] }],
      ),
    ).toEqual({ owner: 2, master: 1 });
  });

  it("merges pending drafts and approvals newest first", () => {
    const draft = { id: "d", createdAt: "2026-10-17T07:00:00.000Z" } as never;
    const approval = { id: "a", createdAt: "2026-10-17T08:00:00.000Z" } as never;
    expect(pendingRouted([draft], [approval]).map((entry) => entry.kind)).toEqual([
      "approval",
      "draft",
    ]);
  });
});
