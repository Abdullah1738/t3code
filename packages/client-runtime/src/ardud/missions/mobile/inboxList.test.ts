import type {
  MissionId,
  MissionInboxHistory,
  MissionListSnapshot,
  MissionRecordRef,
  OwnerRequestId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createFixtureMissionsSource, FIXTURE_NOW } from "../fixture/index.ts";
import type { MissionInboxSnapshot, OwnerRequest } from "../source.ts";
import {
  decidedRows,
  entriesForMission,
  entrySubject,
  filteredEntries,
  findEntry,
  inboxChips,
  inboxRow,
  resolveInboxFilter,
} from "./inboxList.ts";

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

function thread(subject: MissionRecordRef | null, unread: boolean): OwnerRequest {
  return {
    id: `request-${subject?.id ?? "own"}`,
    missionId: CRPKO,
    title: "About it",
    status: "answered",
    messages: [
      { id: "m1", author: "owner", text: "Why?", at: FIXTURE_NOW, refs: [] },
      { id: "m2", author: "master", text: "Because.", at: FIXTURE_NOW, refs: [] },
    ],
    hasOlder: false,
    links: [],
    subject,
    unread,
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
    settledAt: null,
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

  it("puts a discussion's unread count on the item's row only", () => {
    const { inbox, list } = load();
    const waiting = filteredEntries(inbox, "all");
    const entry = waiting[0]!;
    const about = entrySubject(entry);
    expect(about).toMatchObject({ kind: entry.kind, id: entry.record.id });
    expect(inboxRow(entry, list, NOW).discussion).toBeNull();
    expect(inboxRow(entry, list, NOW, [thread(about, true)]).discussion).toEqual({ unread: 1 });
    expect(inboxRow(entry, list, NOW, [thread(about, false)]).discussion).toEqual({ unread: 0 });
    // The owner's own requests and other items' discussions leave the row alone.
    const other = thread({ kind: "ask", id: "ask-decided-already" }, true);
    expect(inboxRow(entry, list, NOW, [thread(null, true), other]).discussion).toBeNull();
  });

  it("lists what was decided today newest first with the owner's condition", () => {
    const source = createFixtureMissionsSource({ now: () => NOW });
    const history = first<MissionInboxHistory>((listener) =>
      source.subscribeInboxHistory(CRPKO, listener),
    );
    const approval = history.approvals[0];
    if (!approval) throw new Error("fixture has no decided approval");
    const conditioned = {
      ...history,
      approvals: [
        {
          ...approval,
          decidedAt: "2026-10-17T08:34:00.000Z",
          onOwnerCondition: {
            requestId: "request-1" as OwnerRequestId,
            quote: "Only after the canary is green.",
          },
        },
      ],
    };
    const rows = decidedRows(conditioned, NOW);
    expect(rows[0]).toMatchObject({
      key: `approval:${approval.id}`,
      age: "now",
      condition: "Only after the canary is green.",
    });
    const all = decidedRows(history, NOW);
    expect(all.length).toBe(
      history.asks.length +
        history.drafts.length +
        history.approvals.length +
        history.knocks.length +
        history.suggestions.length,
    );
  });
});
