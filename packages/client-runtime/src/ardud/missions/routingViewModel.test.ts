import { describe, expect, it } from "vite-plus/test";

import type { Approval, Draft } from "@t3tools/contracts";

import {
  approvalRepository,
  decideLine,
  emptyRoutingTable,
  flipRouteInput,
  pendingRouted,
  previewRouting,
  removeRouteInput,
  rerouteRecordInput,
  routeApproval,
  routeDraft,
  routeLine,
  routeMatchLabel,
  routedTo,
  routingRows,
  setRouteInput,
} from "./routingViewModel.ts";
import type { ApprovalRoutingTable } from "./source.ts";

const T0 = "2026-10-17T08:00:00.000Z";

// First matching row wins, like the server: the narrow rows sit on top.
const table: ApprovalRoutingTable = {
  missionId: "m" as ApprovalRoutingTable["missionId"],
  routes: [
    { id: "r-pavan", match: { _tag: "draft", person: "Pavan" }, approver: "owner" },
    { id: "r-github", match: { _tag: "draft", channel: "github" }, approver: "master" },
    {
      id: "r-devops",
      match: { _tag: "approval", repository: "Equicom-Crypto/crpko-devops" },
      approver: "owner",
    },
    { id: "r-merge", match: { _tag: "approval", kind: "merge" }, approver: "master" },
  ],
  updatedAt: T0,
  changes: [],
};

const pr = (label: string, url: string | null = null) => ({
  kind: "pull-request" as const,
  label,
  url,
  ref: label,
});

let ids = 0;
const newId = () => `new-${ids++}`;

describe("routing a new record", () => {
  it("takes the first matching row, case-insensitively", () => {
    expect(routeDraft(table, { audience: "pavan ", channel: "github" })).toEqual({
      approver: "owner",
      routeId: "r-pavan",
    });
    expect(routeDraft(table, { audience: "Dylan", channel: "github" }).approver).toBe("master");
    expect(
      routeApproval(table, {
        kind: "merge",
        links: [pr("equicom-crypto/crpko-devops#759")],
      }),
    ).toEqual({ approver: "owner", routeId: "r-devops" });
    expect(routeApproval(table, { kind: "merge", links: [pr("risk#124")] }).approver).toBe(
      "master",
    );
  });

  it("sends anything no row matches to the owner", () => {
    expect(routeDraft(table, { audience: "Dylan", channel: "cliq" })).toEqual({
      approver: "owner",
      routeId: null,
    });
    expect(routeApproval(null, { kind: "deploy", links: [] }).approver).toBe("owner");
  });

  it("reads owner/repo from the label or the GitHub URL", () => {
    expect(approvalRepository({ links: [pr("Equicom-Crypto/edge-api#316")] })).toBe(
      "Equicom-Crypto/edge-api",
    );
    expect(
      approvalRepository({
        links: [pr("risk#124", "https://github.com/Equicom-Crypto/risk/pull/124")],
      }),
    ).toBe("Equicom-Crypto/risk");
    expect(approvalRepository({ links: [pr("risk#124")] })).toBeNull();
  });
});

describe("routed records", () => {
  const draft = { id: "d1", approver: "master" as const, routeNote: " Rebase first " };

  it("filters by approver, treating a missing approver as the owner", () => {
    const records: ReadonlyArray<{ readonly id: string; readonly approver?: "owner" | "master" }> =
      [draft, { id: "d2" }];
    expect(routedTo(records, "owner").map((r) => r.id)).toEqual(["d2"]);
    expect(decideLine(draft)).toBe("Waiting on master. You can still decide it.");
    expect(decideLine({})).toBe("Waiting on you");
  });

  it("shows the move reason only when someone moved the record", () => {
    expect(routeLine(draft)).toBe("Rebase first");
    expect(routeLine({ routeNote: null })).toBeNull();
  });

  it("needs a reason and the other inbox to move a record", () => {
    expect(rerouteRecordInput("draft", draft, "owner", "  ")).toEqual({
      ok: false,
      error: "Say why it should move.",
    });
    expect(rerouteRecordInput("draft", draft, "master", "why")).toEqual({
      ok: false,
      error: "It is already routed to master.",
    });
    expect(rerouteRecordInput("draft", draft, "owner", " back to me ")).toEqual({
      ok: true,
      value: { kind: "draft", id: "d1", approver: "owner", reason: "back to me" },
    });
  });
});

describe("editing the table", () => {
  it("labels rows in the order they apply", () => {
    expect(routingRows(table).map((row) => row.label)).toEqual([
      "drafts to Pavan",
      "drafts on GitHub",
      "approvals in Equicom-Crypto/crpko-devops",
      "merge approvals",
    ]);
    expect(routeMatchLabel({ _tag: "draft", person: "Nik", channel: "cliq" })).toBe(
      "drafts to Nik on Cliq",
    );
    expect(routeMatchLabel({ _tag: "approval" })).toBe("all approvals");
  });

  it("changes the matching row, or adds narrow rows on top and broad ones last", () => {
    const changed = setRouteInput(table, { _tag: "draft", channel: "github" }, "owner", newId);
    expect(changed.ok && changed.value.routes.map((r) => [r.id, r.approver])).toEqual([
      ["r-pavan", "owner"],
      ["r-github", "owner"],
      ["r-devops", "owner"],
      ["r-merge", "master"],
    ]);
    const person = setRouteInput(table, { _tag: "draft", person: " Nik " }, "master", newId);
    expect(person.ok && person.value.routes[0]).toEqual({
      id: "new-0",
      match: { _tag: "draft", person: "Nik" },
      approver: "master",
    });
    const kind = setRouteInput(table, { _tag: "approval", kind: "deploy" }, "master", newId);
    expect(kind.ok && kind.value.routes.at(-1)?.match).toEqual({
      _tag: "approval",
      kind: "deploy",
    });
    expect(setRouteInput(table, { _tag: "draft", person: " " }, "owner", newId)).toEqual({
      ok: false,
      error: "Name the person.",
    });
  });

  it("flips and removes rows, and starts from an empty table", () => {
    const flipped = flipRouteInput(table, "r-merge");
    expect(flipped.ok && flipped.value.routes.at(-1)?.approver).toBe("owner");
    const removed = removeRouteInput(table, "r-merge");
    expect(removed.ok && removed.value.routes.map((r) => r.id)).toEqual([
      "r-pavan",
      "r-github",
      "r-devops",
    ]);
    expect(removeRouteInput(table, "nope").ok).toBe(false);
    const first = setRouteInput(
      emptyRoutingTable(table.missionId),
      { _tag: "approval", kind: "merge" },
      "master",
      newId,
    );
    expect(first.ok && first.value).toMatchObject({
      missionId: "m",
      routes: [{ approver: "master" }],
    });
  });

  it("previews a table without moving existing records", () => {
    expect(
      previewRouting(
        table,
        [
          { audience: "Pavan", channel: "github" },
          { audience: "Dylan", channel: "github" },
        ],
        [{ kind: "deploy", links: [] }],
      ),
    ).toEqual({ owner: 2, master: 1 });
  });

  it("lists pending records newest first", () => {
    const draft = { id: "d", createdAt: "2026-10-17T09:00:00.000Z" } as Draft;
    const approval = { id: "a", createdAt: "2026-10-17T10:00:00.000Z" } as Approval;
    expect(pendingRouted([draft], [approval]).map((entry) => entry.record.id)).toEqual(["a", "d"]);
  });
});
