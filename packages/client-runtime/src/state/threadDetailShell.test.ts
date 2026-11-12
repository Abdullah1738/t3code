import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import { threadDetailToShell } from "./threadDetailShell.ts";
import { v2Projection } from "./orchestrationV2TestFixtures.ts";

describe("thread detail shell", () => {
  it("presents an archived child without needing its parent or shell collection", () => {
    const parent = ThreadId.make("unloaded-parent");
    const archivedAt = DateTime.makeUnsafe("2026-11-08T00:00:00Z");
    const shell = threadDetailToShell(EnvironmentId.make("environment-1"), {
      ...v2Projection,
      thread: {
        ...v2Projection.thread,
        archivedAt,
        lineage: {
          rootThreadId: parent,
          parentThreadId: parent,
          relationshipToParent: "subagent",
        },
      },
    });
    expect(shell.id).toBe(v2Projection.thread.id);
    expect(shell.archivedAt).toEqual(DateTime.formatIso(archivedAt));
    expect(shell.source.lineage.parentThreadId).toBe(parent);
  });
});
