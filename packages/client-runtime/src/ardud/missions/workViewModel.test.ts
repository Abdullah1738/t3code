import type { MissionId, WorkItem } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createFixtureMissionsSource, FIXTURE_NOW } from "./fixture/index.ts";
import type { MissionWorkSnapshot } from "./source.ts";
import {
  blockedWork,
  chainHeads,
  isBlocked,
  openDependencies,
  workEdges,
  workFacts,
  workFactsLine,
  workPipeline,
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

describe("work pipeline", () => {
  it("keeps every stage, in order, even when empty", () => {
    const columns = workPipeline(fixtureItems());
    expect(columns.map((column) => column.stage)).toEqual([
      "ticket",
      "pr",
      "review",
      "merge",
      "deploy",
      "readback",
      "exercised",
      "done",
    ]);
    expect(columns.find((column) => column.stage === "readback")?.items).toEqual([]);
    expect(columns.find((column) => column.stage === "done")?.items.map((item) => item.id)).toEqual(
      ["codec-v4"],
    );
  });

  it("treats a dependency as open until it gets past the dependent's stage", () => {
    const items = fixtureItems();
    const byId = byIdOf(items);
    const deploy = byId.get("CRP-13328-deploy")!;
    expect(openDependencies(deploy, byId)).toEqual(["risk68-final"]);
    expect(isBlocked(deploy, byId)).toBe(true);
    expect(isBlocked(byId.get("codec-v4")!, byId)).toBe(false);
    const edges = workEdges(items);
    expect(edges).toContainEqual({ from: "risk68-final", to: "CRP-13328-deploy", open: true });
    expect(chainHeads(items).map((item) => item.id)).toContain("risk-release");
  });
});

describe("blocked work", () => {
  it("groups blocked items by who holds the ball, the owner first", () => {
    const groups = blockedWork(fixtureItems(), "crpko-master");
    expect(groups[0]?.holder).toBe("you");
    expect(groups[0]?.items.map((entry) => entry.item.id)).toEqual(["CRP-13215"]);
    expect(groups[0]?.items[0]?.waitingOn).toMatch(/^Waiting on /);
    const master = groups.find((group) => group.holder === "master");
    expect(master?.items.map((entry) => entry.item.id)).toEqual([
      "CRP-13328-deploy",
      "kafka-d2",
      "ingestor-dev2",
    ]);
  });

  it("reads the recorded facts of an item", () => {
    const byId = byIdOf(fixtureItems());
    expect(workFactsLine(byId.get("CRP-13298")!)).toMatch(/^merged /);
    expect(workFactsLine(byId.get("CRP-13361")!)).toBeNull();
    expect(workFacts(byId.get("CRP-13298")!)[0]).toMatch(/^merged /);
    expect(workFacts(byId.get("CRP-13361")!)).toEqual([]);
  });
});
