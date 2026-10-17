import {
  type MissionId,
  type MissionInbox,
  type MissionListSnapshot,
  type MissionOverview,
  MissionError,
  type SubMissionId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { MissionRoomEntry } from "../source.ts";
import { createSnapshotStore } from "../store.ts";
import { foldLaneCounts } from "../viewModel.ts";
import { createFixtureMissionsSource, FIXTURE_NOW } from "./index.ts";

const CRPKO = "crpko-engineering" as MissionId;
const JUNO = "juno-intents" as MissionId;
const now = () => Date.parse(FIXTURE_NOW) + 60_000;

function latest<T>(subscribe: (listener: (value: T) => void) => () => void) {
  const seen: T[] = [];
  const close = subscribe((value) => seen.push(value));
  return {
    get value(): T {
      const last = seen.at(-1);
      if (last === undefined) throw new Error("no value yet");
      return last;
    },
    get count() {
      return seen.length;
    },
    close,
  };
}

describe("fixture missions source", () => {
  it("lists the Crpko mission first with its seven sub-missions and real lanes", () => {
    const source = createFixtureMissionsSource({ now });
    const list = latest<MissionListSnapshot>((l) => source.subscribeList(l));
    const [crpko, juno] = list.value.missions;
    expect(crpko?.title).toBe("Crpko engineering");
    expect(crpko?.subMissions.map((s) => s.title)).toEqual([
      "Architecture wave delivery",
      "Architecture upkeep",
      "Releases and dev environment",
      "Dev support and human QA triage",
      "Live e2e and harness",
      "PR factory",
      "Observability",
    ]);
    expect(foldLaneCounts(crpko!.lanes).line).toBe("37 lanes: 21 working, 2 stuck, 14 idle");
    // One open ask, one pending draft, one knock.
    expect(crpko?.needsYou).toBe(3);
    expect(crpko?.subMissions.find((s) => s.id === "crpko-releases")?.needsYou).toBe(1);
    expect(juno?.status).toBe("paused");
    list.close();
  });

  it("builds an overview whose critical path is held by named people", () => {
    const source = createFixtureMissionsSource({ now });
    const overview = latest<MissionOverview | null>((l) => source.subscribeOverview(CRPKO, l));
    const value = overview.value!;
    expect(value.mission.health).toBe("amber");
    expect(value.blockers[0]?.holder._tag).toBe("owner");
    expect(value.directionCheck.length).toBeGreaterThan(0);
    expect(value.directionCheck.every((item) => item.at > value.ownerLastLookedAt!)).toBe(true);
    expect(value.criticalPath.length).toBeGreaterThan(1);
    overview.close();
  });

  it("returns null for a missing mission", () => {
    const source = createFixtureMissionsSource({ now });
    const overview = latest<MissionOverview | null>((l) =>
      source.subscribeOverview("nope" as MissionId, l),
    );
    expect(overview.value).toBeNull();
  });

  it("reorders sub-missions and pushes the change to open subscriptions", async () => {
    const source = createFixtureMissionsSource({ now });
    const list = latest<MissionListSnapshot>((l) => source.subscribeList(l));
    const overview = latest<MissionOverview | null>((l) => source.subscribeOverview(CRPKO, l));
    const before = overview.value!.subMissions.map((s) => s.id);
    const order = [before[5]!, ...before.slice(0, 5), before[6]!];
    await source.reorderSubMissions({ missionId: CRPKO, order });
    expect(overview.value!.subMissions.map((s) => s.id)).toEqual(order);
    expect(list.value.missions[0]?.subMissions[0]?.id).toBe(order[0]);
  });

  it("rejects an order that drops a sub-mission", async () => {
    const source = createFixtureMissionsSource({ now });
    const error = await source
      .reorderSubMissions({ missionId: CRPKO, order: ["crpko-arch-wave" as SubMissionId] })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(MissionError);
    expect((error as MissionError).code).toBe("invalid");
  });

  it("answering an ask clears it from needs-you and from the owner's blockers", async () => {
    const source = createFixtureMissionsSource({ now });
    const inbox = latest<MissionInbox>((l) => source.subscribeInbox(CRPKO, l));
    const overview = latest<MissionOverview | null>((l) => source.subscribeOverview(CRPKO, l));
    const ask = inbox.value.asks[0]!;
    await source.answerAsk({ askId: ask.id, optionId: ask.options[1]!.id, text: "" });
    expect(inbox.value.counts.decide).toBe(0);
    const ownerGroup = overview.value!.blockers.find((group) => group.holder._tag === "owner");
    expect(ownerGroup?.items.some((item) => item.id === ask.id)).toBe(false);
    await expect(
      source.answerAsk({ askId: ask.id, optionId: null, text: "again" }),
    ).rejects.toBeInstanceOf(MissionError);
  });

  it("marking the mission seen empties the direction check and room unread counts", async () => {
    const source = createFixtureMissionsSource({ now });
    const overview = latest<MissionOverview | null>((l) => source.subscribeOverview(CRPKO, l));
    const rooms = latest<ReadonlyArray<MissionRoomEntry>>((l) => source.subscribeRooms(CRPKO, l));
    await source.markMissionSeen({ missionId: CRPKO });
    expect(overview.value!.directionCheck).toEqual([]);
    expect(rooms.value.every((entry) => entry.unread === 0)).toBe(true);
  });

  it("pauses, resumes and focuses a mission", async () => {
    const source = createFixtureMissionsSource({ now });
    const overview = latest<MissionOverview | null>((l) => source.subscribeOverview(JUNO, l));
    await source.setMissionPaused({ missionId: JUNO, paused: false });
    expect(overview.value!.mission.status).toBe("active");
    await source.setMissionFocus({
      missionId: JUNO,
      subMissionId: "juno-deposits" as SubMissionId,
    });
    expect(overview.value!.mission.focusSubMissionId).toBe("juno-deposits");
    await expect(
      source.setMissionFocus({ missionId: JUNO, subMissionId: "crpko-arch-wave" as SubMissionId }),
    ).rejects.toBeInstanceOf(MissionError);
  });

  it("does not re-emit unchanged snapshots", async () => {
    const source = createFixtureMissionsSource({ now });
    const juno = latest<MissionOverview | null>((l) => source.subscribeOverview(JUNO, l));
    const lanes = latest((l) => source.subscribeLanes(CRPKO, l));
    await source.reactToCall({
      missionId: CRPKO,
      callId: "call-10211" as never,
      reaction: "ok",
    });
    expect(juno.count).toBe(1);
    expect(lanes.count).toBe(1);
  });

  it("works behind a snapshot store with one source subscription", () => {
    const source = createFixtureMissionsSource({ now });
    const store = createSnapshotStore<MissionListSnapshot>((emit) => source.subscribeList(emit));
    const stop = store.subscribe(() => {});
    expect(store.get()?.missions.length).toBe(2);
    stop();
  });
});
