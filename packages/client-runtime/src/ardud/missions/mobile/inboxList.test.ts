import type { MissionId, MissionListSnapshot, OwnerRequestId, RoomId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createFixtureMissionsSource, FIXTURE_NOW } from "../fixture/index.ts";
import type { MissionInboxSnapshot } from "../source.ts";
import {
  discussionsNeedingYou,
  entriesForMission,
  entrySubject,
  filteredEntries,
  findEntry,
  inboxChips,
  inboxRow,
  resolveInboxFilter,
} from "./inboxList.ts";
import type { RequestThread } from "./requests.ts";

const CRPKO = "crpko-engineering" as MissionId;
const NOW = Date.parse(FIXTURE_NOW) + 60_000;

function first<T>(subscribe: (listener: (value: T) => void) => () => void): T {
  let value: T | undefined;
  const close = subscribe((next) => {
    value = next;
  });
  close();
  if (value === undefined) throw new Error("source did not emit");
  return value;
}

function load() {
  const source = createFixtureMissionsSource({ now: () => NOW });
  const inbox = first<MissionInboxSnapshot>((listener) => source.subscribeInbox(null, listener));
  const list = first<MissionListSnapshot>((listener) => source.subscribeList(listener));
  return { inbox, list };
}

function thread(subject: RequestThread["subject"], unread: boolean): RequestThread {
  return {
    id: `request-${subject?.id ?? "own"}` as OwnerRequestId,
    missionId: CRPKO,
    roomId: "room-request" as RoomId,
    title: "About it",
    status: "answered",
    subject,
    unread,
    messages: [],
    hasOlder: false,
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
  };
}

describe("phone inbox list", () => {
  it("leads with All and only lists tabs that have something", () => {
    const { inbox } = load();
    const chips = inboxChips(inbox);
    expect(chips[0]).toMatchObject({ value: "all", label: "All" });
    expect(chips[0]!.count).toBe(filteredEntries(inbox, "all").length);
    expect(chips.slice(1).every((chip) => chip.count > 0)).toBe(true);
    expect(resolveInboxFilter("nope", inbox)).toBe("all");
    expect(resolveInboxFilter(chips[1]?.value, inbox)).toBe(chips[1]?.value ?? "all");
  });

  it("rows carry a kind tag and an age, and asks never name who asked", () => {
    const { inbox, list } = load();
    const asks = filteredEntries(inbox, "decide");
    expect(asks.length).toBeGreaterThan(0);
    for (const entry of asks) {
      const row = inboxRow(entry, list, NOW);
      expect(row.tag).toMatch(/Decision/);
      expect(row.age).not.toBeNull();
      if (row.place) expect(row.place.rank).not.toBeNull();
    }
  });

  it("finds any item by key and scopes to one mission", () => {
    const { inbox } = load();
    const all = filteredEntries(inbox, "all");
    const entry = all[0]!;
    expect(findEntry(inbox, entry.key)?.key).toBe(entry.key);
    expect(findEntry(inbox, "ask:missing")).toBeNull();
    expect(entriesForMission(all, CRPKO).every((item) => item.record.missionId === CRPKO)).toBe(
      true,
    );
    expect(entriesForMission(all, null)).toHaveLength(all.length);
  });

  it("marks rows with an unread discussion and counts answered ones that left the inbox", () => {
    const { inbox, list } = load();
    const waiting = filteredEntries(inbox, "all");
    const entry = waiting[0]!;
    const about = entrySubject(entry);
    expect(about).toMatchObject({ kind: entry.kind, id: entry.record.id });
    const onItem = thread(about, true);
    expect(inboxRow(entry, list, NOW, [onItem]).unreadDiscussion).toBe(true);
    expect(inboxRow(entry, list, NOW, [thread(about, false)]).unreadDiscussion).toBe(false);
    const gone = thread({ kind: "ask", id: "ask-decided-already" } as never, true);
    const own = thread(null, true);
    expect(discussionsNeedingYou(waiting, [onItem, gone, own])).toBe(1);
  });
});
