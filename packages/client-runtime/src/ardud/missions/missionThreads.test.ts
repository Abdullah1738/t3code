import type { MissionListSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { missionThreadIds, withoutMissionThreads } from "./missionThreads.ts";

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
