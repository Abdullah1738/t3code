import type { MissionId, ModelSelection, Role } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createFixtureMissionsSource, FIXTURE_NOW } from "./fixture/index.ts";
import { poolRows, recoveryBanner, recoveryView, setPoolCapacityInput } from "./poolsViewModel.ts";
import {
  newRoleInput,
  pendingModelLine,
  pullRequestReviews,
  reviewerRows,
  reviewPolicyView,
  roleHistory,
  roleModelChoices,
  roleRegistryView,
  rolesSummary,
  roleThreadLine,
  setCriticalityGuideInput,
  setRoleModelInput,
  threadCode,
} from "./rolesViewModel.ts";
import type {
  MissionPoolsSnapshot,
  MissionReviewSnapshot,
  MissionRolesSnapshot,
  RecoveryIncident,
} from "./source.ts";

const CRPKO = "crpko-engineering" as MissionId;
const MASTER = "crpko-master";

function live<T>(subscribe: (listener: (value: T) => void) => () => void) {
  let value: T | undefined;
  const close = subscribe((next) => {
    value = next;
  });
  return {
    get value(): T {
      if (value === undefined) throw new Error("no value");
      return value;
    },
    close,
  };
}

const source = () => createFixtureMissionsSource({ now: () => Date.parse(FIXTURE_NOW) + 60_000 });

const selection = (model: string): ModelSelection =>
  ({
    instanceId: "opencode",
    model,
    options: [{ id: "variant", value: "xhigh" }],
  }) as unknown as ModelSelection;

describe("roles view model", () => {
  it("lists the master first and says who changed a model and that it applies next turn", () => {
    const missions = source();
    const roles = live<MissionRolesSnapshot>((l) => missions.subscribeRoles(CRPKO, l));
    const view = roleRegistryView(roles.value, MASTER);

    expect(view.rows[0]?.role.id).toBe(MASTER);
    expect(view.rows[0]?.holders).toHaveLength(1);
    expect(view.rows[0]?.past).toHaveLength(8);
    expect(view.publicWriters.map((role) => role.id)).toEqual([MASTER]);
    expect(view.modelMix).toMatch(/^22 on claude-haiku-5-5, 16 on claude-opus-5-5/);

    const risk6 = view.rows.find((row) => row.role.id === "crpko-cell-risk6");
    expect(risk6?.pendingLine).toBe("Switches to opus/claude-opus-5-5 xhigh on its next turn");
    expect(risk6?.modelChangedBy).toBe("last changed by you");
    expect(view.rows.find((row) => row.role.id === "crpko-cell-tc2")?.modelChangedBy).toBe(
      "last changed by master",
    );
    roles.close();
  });

  it("queues a model change for the next turn, and picking the current model cancels it", async () => {
    const missions = source();
    const roles = live<MissionRolesSnapshot>((l) => missions.subscribeRoles(CRPKO, l));
    const role = (id: string) => roles.value.roles.find((entry) => entry.id === id) as Role;

    expect(
      setRoleModelInput(role("crpko-cell-tc"), selection("opus/cc/claude-haiku-5-5"), " "),
    ).toEqual({
      ok: false,
      error: "Say why the model changes.",
    });
    expect(
      setRoleModelInput(role("crpko-cell-tc"), role("crpko-cell-tc").modelSelection, "same"),
    ).toEqual({ ok: false, error: "The role already runs that model." });

    const toHaiku = setRoleModelInput(
      role("crpko-cell-tc"),
      selection("opus/cc/claude-haiku-5-5"),
      "Rule 98: Haiku under an Opus lead",
    );
    if (!toHaiku.ok) throw new Error(toHaiku.error);
    await missions.setRoleModel(toHaiku.value);
    expect(role("crpko-cell-tc").modelSelection.model).toBe("opus/claude-opus-5-5");
    expect(pendingModelLine(role("crpko-cell-tc"))).toMatch(/haiku.*next turn/);
    expect(
      setRoleModelInput(role("crpko-cell-tc"), selection("opus/cc/claude-haiku-5-5"), "again"),
    ).toEqual({ ok: false, error: "That change is already pending." });

    const cancel = setRoleModelInput(
      role("crpko-cell-tc"),
      role("crpko-cell-tc").modelSelection,
      "Keep Opus",
    );
    if (!cancel.ok) throw new Error(cancel.error);
    await missions.setRoleModel(cancel.value);
    expect(role("crpko-cell-tc").pendingModelSelection).toBeNull();
    roles.close();
  });

  it("offers every model the registry runs as a choice, once each", () => {
    const missions = source();
    const roles = live<MissionRolesSnapshot>((l) => missions.subscribeRoles(CRPKO, l));
    expect(roleModelChoices(roles.value.roles).map((choice) => choice.label)).toEqual([
      "opus/cc/claude-haiku-5-5 xhigh",
      "opus/claude-opus-5-5 xhigh",
      "opus/cx/gpt-6.1-sol xhigh",
      "opus/gpt-6-astra xhigh",
    ]);
    roles.close();
  });

  it("shows both review ladders, the triggers and a guide edit by you", async () => {
    const missions = source();
    const review = live<MissionReviewSnapshot | null>((l) =>
      missions.subscribeReviewPolicy(CRPKO, l),
    );
    const snapshot = () => {
      if (!review.value) throw new Error("no policy");
      return review.value;
    };
    const view = reviewPolicyView(snapshot(), MASTER);
    expect(view.normal.map((ladder) => ladder.stagesLine)).toEqual([
      "Sol review → Rule-7 exact-head merge",
    ]);
    expect(view.critical[0]?.stagesLine).toBe(
      "Sol review → Astra final at exact head → Rule-7 exact-head merge",
    );
    expect(view.triggers).toContain("1500+ changed lines");
    expect(view.verdicts.at(-1)?.line).toBe("risk-liquidation-latest#68 critical (hard trigger)");
    expect(view.reviews[1]?.line).toBe("Sol review at 61025638: 19 findings");

    expect(setCriticalityGuideInput(CRPKO, "  ")).toEqual({
      ok: false,
      error: "Write what counts as critical.",
    });
    const edit = setCriticalityGuideInput(CRPKO, "Ledger settlement math is always critical.");
    if (!edit.ok) throw new Error(edit.error);
    await missions.setCriticalityGuide(edit.value);
    const after = reviewPolicyView(snapshot(), MASTER);
    expect(after.guideBy).toBe("Guide v3 by you");
    // Saving the same guide again changes nothing.
    await missions.setCriticalityGuide(edit.value);
    expect(reviewPolicyView(snapshot(), MASTER).guideBy).toBe("Guide v3 by you");
    expect(after.changedBy).toBe("last changed by you");
    expect(after.triggers).toEqual(view.triggers);
    review.close();
  });
});

const SUMMARY =
  "40 roles: the master, 1 final reviewer, 1 reviewer and 37 lane leads. 22 on Haiku, 16 on Opus, 1 on gpt-6-astra, 1 on gpt-6.1-sol.";
const REVIEWERS: Array<[string, string]> = [
  ["Sol review", "Sol reviewer"],
  ["Astra final at exact head", "Astra final"],
  ["Rule-7 exact-head merge", "Crpko master"],
];

describe("roles page", () => {
  const text = (parts: ReadonlyArray<string | { figure: string }>) =>
    parts.map((part) => (typeof part === "string" ? part : part.figure)).join("");

  it("sums up the roles by kind and model family, and reads each thread by its short code", () => {
    const missions = source();
    const roles = live<MissionRolesSnapshot>((l) => missions.subscribeRoles(CRPKO, l));
    const view = roleRegistryView(roles.value, MASTER);

    expect(text(rolesSummary(view))).toBe(SUMMARY);
    const master = view.rows[0];
    if (!master) throw new Error("no master");
    expect(master.family).toBe("Opus");
    expect(roleThreadLine(master)).toBe("9d5f1360");
    const risk6 = view.rows.find((row) => row.role.id === "crpko-cell-risk6");
    if (!risk6) throw new Error("no cell-risk6");
    expect([risk6.family, risk6.pendingFamily]).toEqual(["Haiku", "Opus"]);
    expect(roleThreadLine(risk6)).toBe("Moves to Opus at the next idle turn");
    expect(threadCode("mcp:271cfc0f")).toBe("271cfc0f");
    expect(threadCode("ses_0882e368")).toBe("ses_0882e368");
    roles.close();
  });

  it("lists the master's threads newest first with the note each one handed on", () => {
    const missions = source();
    const roles = live<MissionRolesSnapshot>((l) => missions.subscribeRoles(CRPKO, l));
    const master = roleRegistryView(roles.value, MASTER).rows[0];
    if (!master) throw new Error("no master");
    const history = roleHistory(master, "UTC");
    expect(history).toHaveLength(9);
    expect(history[0]).toMatchObject({ code: "9d5f1360", at: null });
    expect(history[0]?.note).toBe("Current, since Wed 14 Oct 21:25");
    expect(history[1]).toMatchObject({
      code: "ses_0882e368",
      note: "Handed off: Context handoff: MASTER-STATE.md is current.",
      at: "Wed 14 Oct",
    });
    expect(history.at(-1)?.note).toBe("Handed off: Context handoff: MASTER-STATE.md is current.");
    expect(roleHistory(master, "Asia/Dubai")[0]?.note).toBe("Current, since Thu 15 Oct 01:25");
    roles.close();
  });

  it("names who runs each review stage and keeps each ladder's stages apart", () => {
    const missions = source();
    const roles = live<MissionRolesSnapshot>((l) => missions.subscribeRoles(CRPKO, l));
    const review = live<MissionReviewSnapshot | null>((l) =>
      missions.subscribeReviewPolicy(CRPKO, l),
    );
    if (!review.value) throw new Error("no policy");
    const view = reviewPolicyView(review.value, MASTER);
    expect(view.critical[0]?.stages).toEqual([
      "Sol review",
      "Astra final at exact head",
      "Rule-7 exact-head merge",
    ]);
    expect(view.verdicts.at(-1)?.ref).toBe("risk-liquidation-latest#68");
    const risk = pullRequestReviews(view, {
      repository: "risk-liquidation-latest",
      number: 68,
    } as never);
    expect(risk.verdict?.verdict.critical).toBe(true);
    expect(risk.rounds.length).toBeGreaterThan(0);
    expect(risk.rounds[0]?.chip).toMatch(/ r1: /);
    expect(risk.rounds.map((row) => row.review.createdAt)).toEqual(
      risk.rounds.map((row) => row.review.createdAt).toSorted(),
    );
    expect(pullRequestReviews(view, { repository: "x/y", number: 1 } as never)).toEqual({
      verdict: null,
      rounds: [],
    });
    expect(
      reviewerRows(review.value.policy, roles.value.roles).map((row) => [row.stage, row.name]),
    ).toEqual(REVIEWERS);
    roles.close();
    review.close();
  });

  it("shows each pool as an amount, a share and its rule", () => {
    const missions = source();
    const pools = live<MissionPoolsSnapshot>((l) => missions.subscribePools(CRPKO, l));
    const byId = new Map(poolRows(pools.value, MASTER).map((row) => [row.pool.id as string, row]));
    expect(byId.get("pool-offbox")).toMatchObject({
      amountLine: "$61.69 of $500",
      ruleLine: "A month, enforced",
    });
    expect(byId.get("pool-claude")).toMatchObject({
      amountLine: "10 of 30",
      ruleLine: "5h window, advisory",
    });
    expect(byId.get("pool-dev-env")?.ruleLine).toBe("Enforced");
    expect(byId.get("pool-arch-broker")?.share).toBe(1);
    pools.close();
  });
});

describe("pools and recovery view model", () => {
  it("puts the exhausted pool first with its holder and fence", () => {
    const missions = source();
    const pools = live<MissionPoolsSnapshot>((l) => missions.subscribePools(CRPKO, l));
    const rows = poolRows(pools.value, MASTER, new Map([[CRPKO as string, "Crpko engineering"]]));
    expect(rows.map((row) => [row.pool.id, row.pressure])).toEqual([
      ["pool-arch-broker", "exhausted"],
      ["pool-codex-reviews", "tight"],
      ["pool-claude", "ok"],
      ["pool-dev-env", "ok"],
      ["pool-offbox", "ok"],
    ]);
    expect(rows[0]?.holders.map((hold) => [hold.holder, hold.fence])).toEqual([["arch", 48]]);
    expect(rows[0]?.scopeLine).toBe("Only Crpko engineering");
    expect(rows[1]?.usageLine).toBe("5 of 6 account in use");
    expect(rows[1]?.capacityChangedBy).toBe("last changed by master");
    pools.close();
  });

  it("changes a pool's capacity with a reason and credits you", async () => {
    const missions = source();
    const pools = live<MissionPoolsSnapshot>((l) => missions.subscribePools(CRPKO, l));
    const codex = "pool-codex-reviews" as never;
    expect(setPoolCapacityInput(codex, "-1", "x")).toEqual({
      ok: false,
      error: "Capacity is a number, zero or more.",
    });
    expect(setPoolCapacityInput(codex, "8", " ")).toEqual({
      ok: false,
      error: "Say why the capacity changes.",
    });
    const input = setPoolCapacityInput(codex, "8", "Two more Codex accounts added");
    if (!input.ok) throw new Error(input.error);
    await missions.setPoolCapacity(input.value);
    const row = poolRows(pools.value, MASTER).find((entry) => entry.pool.id === codex);
    expect(row?.usageLine).toBe("5 of 8 account in use");
    expect(row?.capacityChangedBy).toBe("last changed by you");
    pools.close();
  });

  it("reads the 4 Oct restart as the Last restart panel, in the reader's zone", () => {
    const missions = source();
    const incidents = live<ReadonlyArray<RecoveryIncident>>((l) =>
      missions.subscribeRecovery(CRPKO, l),
    );
    const incident = incidents.value[0];
    if (!incident) throw new Error("no incident");
    const view = recoveryView(incident, "UTC");
    expect(view.dayLabel).toBe("Sun 4 Oct");
    expect(view.downLine).toBe("15:35 to 15:37, found 15:41");
    expect(view.groups).toEqual([
      { label: "Resumed", names: ["cell-tc2", "cell-md", "cell-devops2", "cell-bo"] },
      { label: "Reconciled", names: ["arch"] },
      { label: "Told only", names: ["cell-risk", "cell-edge"] },
      { label: "Skipped", names: ["cell-tc", "cell-ws"] },
    ]);
    expect(recoveryView(incident, "Asia/Dubai").downLine).toBe("19:35 to 19:37, found 19:41");

    const open: RecoveryIncident = {
      ...incident,
      clearedAt: null,
      threads: incident.threads.map((thread, index) =>
        index < 2 ? { ...thread, state: "pending", noticeAt: null } : thread,
      ),
    };
    expect(recoveryView(open, "UTC").groups[0]).toEqual({
      label: "Waiting",
      names: ["cell-tc2", "cell-md"],
    });
    incidents.close();
  });

  it("writes the restart banner in the reader's zone, not the server's label", () => {
    const state = {
      incidentId: "recovery-2026-10-04",
      cause: "server-restart" as const,
      at: "2026-10-04T15:37:00.000Z",
      // The server formats its label in the owner's zone.
      label: "Recovered from restart at 19:37",
      total: 9,
      pending: 2,
      reconcile: 1,
    };
    expect(recoveryBanner(state, "UTC")).toBe(
      "Recovered from restart at 15:37: 2 of 9 threads still to resume or decide, 1 to reconcile first",
    );
    expect(recoveryBanner({ ...state, pending: 0 }, "UTC")).toBeNull();
    expect(recoveryBanner(null)).toBeNull();
  });
});

describe("new role", () => {
  it("builds the create input and adds the role to the registry", async () => {
    expect(newRoleInput(CRPKO, "master", "")).toEqual({ ok: false, error: "Pick a role kind." });
    expect(newRoleInput(CRPKO, "lane-lead", "")).toEqual({ ok: false, error: "Pick a role kind." });
    expect(newRoleInput(CRPKO, "scribe", "  ")).toEqual({
      ok: true,
      value: { missionId: CRPKO, kind: "scribe" },
    });
    const built = newRoleInput(CRPKO, "verifier", " Second verifier ");
    expect(built).toEqual({
      ok: true,
      value: { missionId: CRPKO, kind: "verifier", name: "Second verifier" },
    });
    if (!built.ok) return;

    const fixture = source();
    const roles = live<MissionRolesSnapshot>((l) => fixture.subscribeRoles(CRPKO, l));
    const before = roles.value.roles.length;
    await fixture.createRole(built.value);
    expect(roles.value.roles).toHaveLength(before + 1);
    expect(roles.value.roles.at(-1)).toMatchObject({ kind: "verifier", name: "Second verifier" });
    roles.close();
  });
});
