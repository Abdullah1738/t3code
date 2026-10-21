import type { MissionListSnapshot, ThreadAttachment } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { attachedThreadGroups, missionThreadIds, withoutMissionThreads } from "./missionThreads.ts";

const list = (threadIds: ReadonlyArray<ReadonlyArray<string>>) =>
  ({
    revision: 1,
    missions: threadIds.map((ids) => ({ threadIds: ids })),
  }) as unknown as MissionListSnapshot;

describe("mission threads", () => {
  it("leaves every mission's threads out of the thread list", () => {
    const threads = [{ id: "a" }, { id: "lane" }, { id: "b" }, { id: "master" }];
    const ids = missionThreadIds(list([["lane"], ["master", "lane"]]));
    expect(withoutMissionThreads(threads, ids).map((thread) => thread.id)).toEqual(["a", "b"]);
  });

  it("keeps the same list when no mission claims a thread", () => {
    const threads = [{ id: "a" }];
    expect(withoutMissionThreads(threads, missionThreadIds(undefined))).toBe(threads);
    expect(withoutMissionThreads(threads, missionThreadIds(list([[]])))).toBe(threads);
    expect(withoutMissionThreads(threads, missionThreadIds(list([["other"]])))).toBe(threads);
  });
});

describe("attached threads", () => {
  const attachment = (threadId: string, state: ThreadAttachment["state"], updatedAt: string) =>
    ({
      threadId,
      missionId: "crpko",
      attachedBy: "crw",
      title: `CRPKO ${threadId}`,
      pullRequest: { repository: "Equicom-Crypto/backoffice-core", number: 361 },
      state,
      createdAt: updatedAt,
      updatedAt,
    }) as ThreadAttachment;

  it("splits live reviews from settled ones, newest first", () => {
    const groups = attachedThreadGroups([
      attachment("a", "closed", "2026-10-20T10:00:00.000Z"),
      attachment("b", "open", "2026-10-20T09:00:00.000Z"),
      attachment("c", "closed", "2026-10-21T10:00:00.000Z"),
      attachment("d", "detached", "2026-10-21T11:00:00.000Z"),
    ]);
    expect(groups.open.map((row) => row.threadId)).toEqual(["b"]);
    expect(groups.closed.map((row) => row.threadId)).toEqual(["c", "a"]);
    expect(groups.open[0]?.pullRequest).toBe("backoffice-core#361");
    expect(attachedThreadGroups(undefined)).toEqual({ open: [], closed: [] });
  });
});
