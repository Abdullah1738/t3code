import type {
  MissionId,
  MissionInbox,
  MissionListSnapshot,
  MissionOverview,
  SubMissionId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createFixtureMissionsSource, FIXTURE_NOW } from "../fixture/index.ts";
import type { MissionRoomEntry, MissionsSource } from "../source.ts";
import {
  askAnswerInput,
  askView,
  draftDecisionInput,
  EMPTY_ASK_ANSWER,
  inboxSegments,
  knockDecisionInput,
  knockHeadline,
  missionErrorMessage,
  resolveInboxTab,
  suggestionAfterText,
  suggestionDecisionInput,
  toggleAskOption,
} from "./inbox.ts";
import {
  blockersView,
  criticalPathScreenView,
  feedView,
  focusChoices,
  missionListRows,
  moveSubMissionInput,
  overviewHeaderView,
  priorityStackView,
  roomRows,
  unreadTotal,
} from "./overview.ts";

const CRPKO = "crpko-engineering" as MissionId;
const NOW = Date.parse(FIXTURE_NOW) + 60_000;
const now = () => NOW;

function first<T>(subscribe: (listener: (value: T) => void) => () => void): T {
  let value: T | undefined;
  const close = subscribe((next) => {
    value = next;
  });
  close();
  if (value === undefined) throw new Error("source did not emit");
  return value;
}

function latest<T>(subscribe: (listener: (value: T) => void) => () => void) {
  let value: T | undefined;
  const close = subscribe((next) => {
    value = next;
  });
  return {
    get value(): T {
      if (value === undefined) throw new Error("source did not emit");
      return value;
    },
    close,
  };
}

function fixture(): MissionsSource {
  return createFixtureMissionsSource({ now, surface: "mobile" });
}

function inboxOf(source: MissionsSource): MissionInbox {
  return first<MissionInbox>((listener) => source.subscribeInbox(CRPKO, listener));
}

function overviewOf(source: MissionsSource): MissionOverview {
  const overview = first<MissionOverview | null>((listener) =>
    source.subscribeOverview(CRPKO, listener),
  );
  if (!overview) throw new Error("missing overview");
  return overview;
}

describe("asks", () => {
  it("never preselects an option, even the recommended one", () => {
    const ask = inboxOf(fixture()).asks[0]!;
    expect(EMPTY_ASK_ANSWER.optionId).toBeNull();
    expect(askAnswerInput(ask, EMPTY_ASK_ANSWER)).toEqual({
      ok: false,
      error: "Pick an option or write an answer.",
    });
    const view = askView(ask);
    expect(view).not.toHaveProperty("askedBy");
    expect(view).not.toHaveProperty("askedAt");
    expect(view.options.filter((option) => option.recommended).map((option) => option.id)).toEqual([
      "hold",
    ]);
    expect(view.recommendation?.label).toBe("Hold until the authorizer turn-on");
    expect(view.blocksLine).toBe("Blocks CRP-13215");
  });

  it("toggles the pick and accepts free text without an option", () => {
    const ask = inboxOf(fixture()).asks[0]!;
    const picked = toggleAskOption(EMPTY_ASK_ANSWER, "stamp-now");
    expect(picked.optionId).toBe("stamp-now");
    expect(toggleAskOption(picked, "stamp-now").optionId).toBeNull();
    expect(askAnswerInput(ask, { optionId: null, text: "  wait for Pavan  " })).toEqual({
      ok: true,
      input: { askId: ask.id, optionId: null, text: "wait for Pavan" },
    });
    expect(askAnswerInput(ask, { optionId: "nope", text: "" }).ok).toBe(false);
  });

  it("answering through the source closes the ask", async () => {
    const source = fixture();
    const inbox = latest<MissionInbox>((listener) => source.subscribeInbox(CRPKO, listener));
    const ask = inbox.value.asks[0]!;
    const result = askAnswerInput(ask, toggleAskOption(EMPTY_ASK_ANSWER, "hold"));
    if (!result.ok) throw new Error(result.error);
    await source.answerAsk(result.input);
    expect(inbox.value.asks).toEqual([]);
    expect(inbox.value.counts.decide).toBe(0);
    const again = await source.answerAsk(result.input).catch((error: unknown) => error);
    expect(missionErrorMessage(again)).toBe("This ask is already closed.");
    inbox.close();
  });
});

describe("drafts, knocks and suggestions", () => {
  it("treats an unchanged edit as a plain approval", () => {
    const draft = inboxOf(fixture()).drafts[0]!;
    expect(draftDecisionInput(draft, { action: "approve", editedText: ` ${draft.text} ` })).toEqual(
      { ok: true, input: { draftId: draft.id, action: "approve" } },
    );
    expect(draftDecisionInput(draft, { action: "approve", editedText: "Shorter." })).toEqual({
      ok: true,
      input: { draftId: draft.id, action: "approve", editedText: "Shorter." },
    });
    expect(draftDecisionInput(draft, { action: "approve", editedText: "  " }).ok).toBe(false);
    expect(draftDecisionInput(draft, { action: "rewrite", note: "" }).ok).toBe(false);
  });

  it("forwards a knock to the master, with the edit only when it changed", async () => {
    const source = fixture();
    const knock = inboxOf(source).knocks[0]!;
    expect(knockHeadline(knock, "Crpko Engineering")).toBe(
      `"${knock.fromTitle}" wants to tell the Crpko Engineering master`,
    );
    expect(knockDecisionInput(knock, { action: "forward", editedText: knock.summary })).toEqual({
      ok: true,
      input: { knockId: knock.id, action: "forward" },
    });
    const result = knockDecisionInput(knock, { action: "forward", editedText: "Short version." });
    if (!result.ok) throw new Error(result.error);
    await source.decideKnock(result.input);
    expect(inboxOf(source).knocks).toEqual([]);
  });

  it("parses an edited suggestion as JSON and rejects broken JSON", () => {
    const suggestion = inboxOf(fixture()).suggestions[0]!;
    const text = suggestionAfterText(suggestion);
    expect(JSON.parse(text)).toEqual(suggestion.after);
    expect(
      suggestionDecisionInput(suggestion, { action: "accept-edited", afterText: text }),
    ).toEqual({ ok: true, input: { suggestionId: suggestion.id, action: "accept" } });
    expect(
      suggestionDecisionInput(suggestion, {
        action: "accept-edited",
        afterText: '{ "everyMinutes": 60, "running": true }',
      }),
    ).toEqual({
      ok: true,
      input: {
        suggestionId: suggestion.id,
        action: "accept-edited",
        editedAfter: { everyMinutes: 60, running: true },
      },
    });
    expect(
      suggestionDecisionInput(suggestion, { action: "accept-edited", afterText: "{ nope" }).ok,
    ).toBe(false);
    expect(suggestionDecisionInput(suggestion, { action: "dismiss", reason: " " })).toEqual({
      ok: true,
      input: { suggestionId: suggestion.id, action: "dismiss" },
    });
  });
});

describe("inbox segments", () => {
  it("lands on the first segment with work unless the owner picked one", () => {
    const counts = { decide: 0, approve: 2, knocks: 1, suggestions: 0, fyi: 3 };
    expect(resolveInboxTab(null, { counts })).toBe("approve");
    expect(resolveInboxTab("fyi", { counts })).toBe("fyi");
    expect(resolveInboxTab(null, undefined)).toBe("decide");
    expect(
      resolveInboxTab(null, {
        counts: { decide: 0, approve: 0, knocks: 0, suggestions: 0, fyi: 0 },
      }),
    ).toBe("decide");
    expect(inboxSegments({ counts }).map((segment) => segment.count)).toEqual([0, 2, 1, 0, 3]);
  });
});

describe("mission list and overview", () => {
  it("renders the lane fold once, without doubled counts", () => {
    const snapshot = first<MissionListSnapshot>((listener) => fixture().subscribeList(listener));
    const rows = missionListRows(snapshot.missions);
    const crpko = rows.find((row) => row.id === CRPKO)!;
    expect(crpko.lanesLine).toBe("37 lanes: 21 working, 2 stuck, 14 idle");
    expect(crpko.subMissions.map((sub) => sub.position)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(crpko.subMissions[0]!.title).toBe("Architecture wave delivery");
    expect(rows.find((row) => row.id !== CRPKO)?.toneLabel).toBe("Paused");
  });

  it("builds the overview sections from one snapshot", () => {
    const overview = overviewOf(fixture());
    const header = overviewHeaderView(overview, NOW);
    expect(header.lanesLine).toBe("37 lanes: 21 working, 2 stuck, 14 idle");
    expect(header.stats.lanes).toEqual({ stuck: 2, waiting: overview.lanes.waiting, total: 37 });
    if (header.stats.milestones) {
      expect(header.stats.timeLeft).not.toBeNull();
      expect(header.stats.milestones.total).toBeGreaterThan(0);
    }
    const blockers = blockersView(overview);
    expect(blockers.groups.length).toBeGreaterThan(0);
    expect(blockers.caption).not.toBeNull();
    const ownerGroups = blockers.groups.filter((group) => group.isOwner);
    if (ownerGroups.length > 0) expect(blockers.groups[0]!.isOwner).toBe(true);
    const path = criticalPathScreenView(overview, NOW);
    expect(path.title.startsWith("Critical path")).toBe(true);
    expect(path.steps.length).toBe(overview.criticalPath.length);
    const feed = feedView(overview, NOW);
    expect(feed.fresh.length + feed.earlier.length).toBe(overview.feed.length);
    expect(feed.canMarkSeen).toBe(feed.fresh.length > 0);
  });

  it("moves a sub-mission one step and refuses to fall off the ends", async () => {
    const source = fixture();
    const overview = overviewOf(source);
    const rows = priorityStackView(overview).rows;
    const top = rows[0]!.id;
    const bottom = rows[rows.length - 1]!.id;
    expect(moveSubMissionInput(overview, top, "up")).toBeNull();
    expect(moveSubMissionInput(overview, bottom, "down")).toBeNull();
    expect(moveSubMissionInput(overview, "missing" as SubMissionId, "up")).toBeNull();
    const input = moveSubMissionInput(overview, top, "down");
    expect(input?.order.slice(0, 2)).toEqual([rows[1]!.id, top]);
    await source.reorderSubMissions(input!);
    expect(priorityStackView(overviewOf(source)).rows[1]!.id).toBe(top);
  });

  it("offers no focus plus active sub-missions, marking the current focus", async () => {
    const source = fixture();
    const overview = overviewOf(source);
    const choices = focusChoices(overview);
    expect(choices[0]).toEqual({
      id: null,
      title: "No focus",
      selected: overview.mission.focusSubMissionId === null,
    });
    const active = overview.subMissions.filter((sub) => sub.status === "active");
    expect(choices).toHaveLength(active.length + 1);
    expect(choices[1]!.title).toMatch(/^1\. /);
    const target = choices[2]!.id!;
    await source.setMissionFocus({ missionId: CRPKO, subMissionId: target });
    const selected = focusChoices(overviewOf(source)).filter((choice) => choice.selected);
    expect(selected.map((choice) => choice.id)).toEqual([target]);
  });
});

describe("rooms", () => {
  it("puts unread rooms first and totals unread", () => {
    const entries = first<ReadonlyArray<MissionRoomEntry>>((listener) =>
      fixture().subscribeRooms(CRPKO, listener),
    );
    const rows = roomRows(entries);
    expect(rows.length).toBe(entries.length);
    const firstRead = rows.findIndex((row) => row.unread === 0);
    if (firstRead >= 0) expect(rows.slice(firstRead).every((row) => row.unread === 0)).toBe(true);
    expect(unreadTotal(entries)).toBe(entries.reduce((sum, entry) => sum + entry.unread, 0));
    expect(rows.find((row) => row.title === "delivery")?.unreadBadge).toBe("99+");
  });

  it("leaves request rooms to Your requests and ranks rooms by sub-mission", () => {
    const entries = first<ReadonlyArray<MissionRoomEntry>>((listener) =>
      fixture().subscribeRooms(CRPKO, listener),
    );
    const sample = entries.find((entry) => entry.room.subMissionId !== null)!;
    const requestRoom: MissionRoomEntry = {
      room: { ...sample.room, id: `${sample.room.id}-request` as never, kind: "owner-request" },
      unread: 4,
    };
    const subMissions = [
      { id: sample.room.subMissionId!, title: "Risk snapshot", order: 2 },
    ] as const;
    const rows = roomRows([...entries, requestRoom], subMissions);
    expect(rows.some((row) => row.id === requestRoom.room.id)).toBe(false);
    expect(unreadTotal([...entries, requestRoom])).toBe(unreadTotal(entries));
    expect(rows.find((row) => row.id === sample.room.id)?.place).toEqual({
      rank: 3,
      title: "Risk snapshot",
    });
    expect(rows.every((row) => row.rate === null || row.rate.endsWith("/h"))).toBe(true);
  });
});
