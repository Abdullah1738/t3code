import type { MissionId, WorkItem } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createFixtureMissionsSource, FIXTURE_NOW } from "./fixture/index.ts";
import type { MissionWorkSnapshot } from "./source.ts";
import {
  chainHeads,
  isBlocked,
  openDependencies,
  reviewRoundsView,
  workBoard,
  workFacts,
  workFactsLine,
} from "./workViewModel.ts";

const CRPKO = "crpko-engineering" as MissionId;

function fixtureItems(): ReadonlyArray<WorkItem> {
  const source = createFixtureMissionsSource({ now: () => Date.parse(FIXTURE_NOW) });
  let snapshot: MissionWorkSnapshot | undefined;
  source.subscribeWork(CRPKO, (next) => {
    snapshot = next;
  })();
  if (!snapshot) throw new Error("no work snapshot");
  return snapshot.items;
}

const byIdOf = (items: ReadonlyArray<WorkItem>) =>
  new Map(items.map((item) => [item.id as string, item]));

const openItems = () => fixtureItems().filter((item) => item.stage !== "done");

describe("work dependencies", () => {
  it("treats a dependency as open until it gets past the dependent's stage", () => {
    const items = fixtureItems();
    const byId = byIdOf(items);
    const deploy = byId.get("CRP-13328-deploy")!;
    expect(openDependencies(deploy, byId)).toEqual(["risk68-final"]);
    expect(isBlocked(deploy, byId)).toBe(true);
    expect(isBlocked(byId.get("codec-v4")!, byId)).toBe(false);
    expect(chainHeads(items).map((item) => item.id)).toContain("risk-release");
  });

  it("reads a dependency missing from the open feed as finished", () => {
    const items = openItems().filter((item) => item.id !== "risk68-final");
    const byId = byIdOf(items);
    const deploy = byId.get("CRP-13328-deploy")!;
    expect(isBlocked(deploy, byId)).toBe(true);
    expect(isBlocked(deploy, byId, false)).toBe(false);
  });
});

describe("work board", () => {
  it("puts the owner's items first, then blocked, then moving", () => {
    const board = workBoard(openItems(), "crpko-master");
    expect(board.withYou.map((row) => row.item.id)).toEqual(["CRP-13215"]);
    expect(board.withYou[0]).toMatchObject({ glyph: "risk", holder: { kind: "you", name: "You" } });
    const deploy = board.blocked.find((row) => row.item.id === "CRP-13328-deploy");
    expect(deploy).toMatchObject({
      glyph: "bad",
      stageLabel: "Deploy",
      holder: { kind: "master", name: "Master" },
      reason: "Waiting on risk#68 Sol r5 and Astra final",
    });
    // Blocked oldest first, moving latest first.
    const blockedAt = board.blocked.map((row) => row.item.updatedAt);
    expect(blockedAt).toEqual([...blockedAt].sort());
    const movingAt = board.moving.map((row) => row.item.updatedAt);
    expect(movingAt).toEqual([...movingAt].sort().toReversed());
    expect(board.open).toBe(board.withYou.length + board.blocked.length + board.moving.length);
    expect(board.stages.map((stage) => stage.label)).toEqual([
      "Ticket",
      "PR",
      "Review",
      "Merge",
      "Deploy",
      "Readback",
      "Exercised",
    ]);
    expect(board.stages.reduce((sum, stage) => sum + stage.count, 0)).toBe(board.open);
    expect(board.byStage.every((group) => group.rows.length > 0)).toBe(true);
  });

  it("names each chain by its sub-mission and lists its steps first to last", () => {
    const items = openItems();
    const head = items.find((item) => item.id === "risk-release")!;
    const board = workBoard(items, "crpko-master", new Map([[head.subMissionId!, "Risk"]]));
    const chain = board.chains.find((entry) => entry.id === "risk-release");
    expect(chain?.name).toBe("Risk");
    expect(chain?.steps.map((step) => step.id)).toEqual([
      "risk68-r4",
      "risk68-final",
      "CRP-13328-deploy",
      "risk-release",
    ]);
  });

  it("lists open deferred register entries apart, fired ones first", () => {
    const [base] = openItems();
    const deferred = (id: string, status: "deferred" | "fired" | "done") =>
      ({
        ...base!,
        id: `crpko:deferred:${id}`,
        title: `${id}: Retry the ingest`,
        // The server files a finished entry under done.
        stage: status === "done" ? "done" : "ticket",
        deferral: {
          registerId: id,
          status,
          what: "Retry the ingest\nwith the new codec",
          deferredBy: "master",
          why: "",
          trigger: status === "fired" ? "Codec v4 on dev" : "",
          source: "register",
          notes: [],
        },
      }) as unknown as WorkItem;
    const board = workBoard(
      [deferred("DF-1", "deferred"), deferred("DF-2", "fired"), deferred("DF-3", "done")],
      null,
    );
    expect(board.open).toBe(0);
    expect(board.register).toMatchObject([
      { registerId: "DF-2", what: "Retry the ingest", trigger: "Codec v4 on dev", fired: true },
      { registerId: "DF-1", trigger: null, fired: false },
    ]);
  });
});

describe("work facts", () => {
  it("reads the recorded facts of an item", () => {
    const byId = byIdOf(fixtureItems());
    expect(workFactsLine(byId.get("CRP-13298")!)).toMatch(/^merged /);
    expect(workFactsLine(byId.get("CRP-13361")!)).toBeNull();
    expect(workFacts(byId.get("CRP-13298")!)[0]).toMatch(/^merged /);
    expect(workFacts(byId.get("CRP-13361")!)).toEqual([]);
  });
});

describe("review rounds", () => {
  const withRounds = (
    rounds: ReadonlyArray<[verdict: "clear" | "findings", findings: number, severe: number]>,
  ) => ({
    ...fixtureItems()[0]!,
    reviewRounds: rounds.map(([verdict, findings, severe], index) => ({
      round: index + 1,
      verdict,
      findings,
      severe,
      headSha: null,
      reviewer: "Sol",
      at: FIXTURE_NOW,
    })),
  });

  it("counts an item's rounds and flags the ones past the budget", () => {
    expect(reviewRoundsView(fixtureItems()[0]!)).toBeNull();
    expect(reviewRoundsView(withRounds([["findings", 2, 1]]))).toEqual({
      label: "1 round",
      detail: "Round 1: 2 findings, 1 P0/P1",
      over: false,
    });
    expect(
      reviewRoundsView(
        withRounds([
          ["findings", 2, 1],
          ["findings", 1, 0],
          ["clear", 0, 0],
        ]),
      ),
    ).toEqual({ label: "3 rounds", detail: "Round 3 clear", over: false });
    expect(
      reviewRoundsView(
        withRounds([
          ["findings", 2, 1],
          ["findings", 1, 1],
          ["findings", 3, 1],
          ["findings", 1, 0],
        ]),
      ),
    ).toEqual({ label: "4 rounds", detail: "Round 4: 1 finding", over: true });
  });
});
