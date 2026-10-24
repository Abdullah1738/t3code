import type { MissionId, MissionListSnapshot, SubMissionId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  cardSubMission,
  dayOnePlan,
  draftKicker,
  draftTitle,
  entryHeadline,
  entryRow,
  groupEntriesByMission,
  inboxLead,
  masterRoutedEntries,
  noteFlags,
  ownerWaitingEntries,
  replyContextView,
} from "./cardViewModel.ts";
import type { InboxEntry } from "./inboxViewModel.ts";
import { formatDayLabel } from "./viewModel.ts";

const MISSION = "crpko-engineering" as MissionId;
const SUB = "sub-release" as SubMissionId;

const list = {
  revision: 1,
  missions: [
    {
      id: MISSION,
      subMissions: [{ id: SUB, title: "Releases and dev environment", order: 2 }],
    },
  ],
} as unknown as MissionListSnapshot;

describe("card wording", () => {
  it("ranks the sub-mission from its order and drops unknown ones", () => {
    expect(cardSubMission(list, MISSION, SUB)).toEqual({
      missionId: MISSION,
      subMissionId: SUB,
      rank: 3,
      title: "Releases and dev environment",
    });
    expect(cardSubMission(list, MISSION, "sub-gone" as SubMissionId)).toBeNull();
    expect(cardSubMission(list, MISSION, null)).toBeNull();
    expect(cardSubMission(undefined, MISSION, SUB)).toBeNull();
  });

  it("titles drafts by summary, else by audience", () => {
    expect(draftTitle({ summary: " Ask for a rebase ", audience: "Dylan" })).toBe(
      "Ask for a rebase",
    );
    expect(draftTitle({ summary: null, audience: "Dylan" })).toBe("To Dylan");
    expect(draftKicker({ requestedBy: "crw" })).toBe("Review feedback");
    expect(draftKicker({})).toBe("Draft");
  });

  it("shows what a draft replies to, or the situation it is about", () => {
    const nowMs = Date.parse("2026-10-24T12:00:00.000Z");
    const link = { kind: "url" as const, label: "Cliq", url: "https://cliq.example/m", ref: null };
    expect(
      replyContextView(
        {
          inReplyTo: {
            summary: " Asks if dev is up. ",
            quote: " is dev back? ",
            author: "Sam",
            at: "2026-10-24T09:00:00.000Z",
            link,
          },
        },
        nowMs,
      ),
    ).toEqual({
      label: "Replying to",
      author: "Sam",
      when: "3h ago",
      at: "2026-10-24T09:00:00.000Z",
      quote: "is dev back?",
      summary: "Asks if dev is up.",
      link,
    });
    expect(replyContextView({ inReplyTo: { summary: "Dev was down." } }, nowMs)).toMatchObject({
      label: "About",
      author: null,
      when: null,
      quote: null,
    });
    expect(replyContextView({ inReplyTo: { summary: "x", at: "nope" } }, nowMs)?.when).toBeNull();
    expect(replyContextView({}, nowMs)).toBeNull();
    expect(replyContextView({ inReplyTo: null }, nowMs)).toBeNull();
  });

  it("flags only the loud parts of a note", () => {
    expect(
      noteFlags({ severity: "low", basis: "observed", evidence: "matched", citation: "verified" }),
    ).toEqual([]);
    expect(
      noteFlags({ severity: "high", basis: "claimed", evidence: "missing", citation: "failed" }),
    ).toEqual([
      { label: "High", tone: "warning" },
      { label: "Claimed", tone: "neutral" },
      { label: "No evidence", tone: "warning" },
      { label: "Quote differs", tone: "error" },
    ]);
  });
});

describe("inbox rows", () => {
  const OTHER = "juno-ops" as MissionId;
  const entry = (kind: string, id: string, record: Record<string, unknown>) =>
    ({
      kind,
      key: `${kind}:${id}`,
      record: { id, createdAt: "2026-10-19T08:00:00.000Z", ...record },
    }) as unknown as InboxEntry;

  const ask = entry("ask", "a1", {
    missionId: MISSION,
    subMissionId: SUB,
    question: "Ship it?",
    urgency: "p1",
  });
  const draft = entry("draft", "d1", {
    missionId: MISSION,
    audience: "Dylan",
    summary: null,
    target: { kind: "pull-request", label: " backoffice-core#212 ", url: null, ref: null },
  });
  const knock = entry("knock", "k1", { missionId: OTHER, summary: "Need a key", fromTitle: "" });
  const suggestion = entry("suggestion", "s1", {
    missionId: null,
    targetKind: "rule",
    title: "Tighten the rule",
    target: { kind: "rule", id: "rule-9" },
  });

  it("puts the sub-mission or the subject on the second line", () => {
    expect(entryRow(ask, list)).toMatchObject({
      key: "ask:a1",
      kicker: "Decision",
      title: "Ship it?",
      sub: { rank: 3, title: "Releases and dev environment" },
      about: null,
    });
    expect(entryRow(draft, list)).toMatchObject({
      title: "To Dylan",
      sub: null,
      about: "backoffice-core#212",
    });
    expect(entryRow(knock, list).about).toBeNull();
    expect(entryRow(suggestion, list).about).toBe("rule-9");
  });

  it("groups by mission in list order, unknown missions next, unowned last", () => {
    const groups = groupEntriesByMission([suggestion, knock, ask, draft], {
      ...list,
      missions: list.missions.map((mission) => ({
        ...mission,
        title: "Crpko engineering",
        health: "amber",
        status: "paused",
      })),
    } as unknown as MissionListSnapshot);
    expect(groups.map((group) => [group.missionId, group.entries.map((e) => e.key)])).toEqual([
      [MISSION, ["ask:a1", "draft:d1"]],
      [OTHER, ["knock:k1"]],
      [null, ["suggestion:s1"]],
    ]);
    expect(groups[0]).toMatchObject({ title: "Crpko engineering", health: "amber", paused: true });
    expect(groups[1]).toMatchObject({ title: null, health: null, paused: false });
    expect(groupEntriesByMission([], list)).toEqual([]);
  });
});

describe("waiting entries", () => {
  it("lists what waits on the owner oldest first and what the master holds apart", async () => {
    const { createFixtureMissionsSource } = await import("./fixture/index.ts");
    const source = createFixtureMissionsSource();
    let inbox: Parameters<typeof ownerWaitingEntries>[0] | undefined;
    const stop = source.subscribeInbox(MISSION, (value) => {
      inbox = value;
    });
    stop();
    if (!inbox) throw new Error("no inbox");
    const waiting = ownerWaitingEntries(inbox);
    expect(waiting.length).toBe(inbox.counts.decide + inbox.counts.approve + inbox.counts.knocks);
    const times = waiting.map((entry) => entry.record.createdAt);
    expect(times).toEqual([...times].sort());
    const first = waiting[0];
    if (!first) throw new Error("nothing waiting");
    const headline = entryHeadline(first);
    expect(headline.kicker.length).toBeGreaterThan(0);
    expect(headline.since).toBe(first.record.createdAt);
    expect(
      masterRoutedEntries(inbox).every((entry) => !waiting.some((w) => w.key === entry.key)),
    ).toBe(true);
  });
});

describe("inbox lead", () => {
  const entry = (id: string, createdAt: string) =>
    ({ kind: "knock", key: `knock:${id}`, record: { id, createdAt } }) as unknown as InboxEntry;

  it("counts the holds and dates the oldest in the device zone", () => {
    const oldest = "2026-10-07T08:52:00.000Z";
    const day = formatDayLabel(oldest);
    expect(inboxLead([entry("a", oldest), entry("b", "2026-10-11T19:26:00.000Z")])).toEqual({
      strong: "2 holds",
      after: ` wait on you, the oldest since ${day}.`,
    });
    expect(inboxLead([entry("a", oldest)])).toEqual({
      strong: "1 hold",
      after: ` waits on you, since ${day}.`,
    });
    expect(inboxLead([])).toBeNull();
  });
});

describe("day one", () => {
  const entry = (kind: InboxEntry["kind"], id: string) =>
    ({
      kind,
      key: `${kind}:${id}`,
      record: { id, createdAt: "2026-10-17T08:30:00.000Z" },
    }) as unknown as InboxEntry;
  const noLanes = { working: 0, stuck: 0, waiting: 0, idle: 0, parked: 0 };

  it("points at the master's plan while the mission has no lanes", () => {
    const plan = entry("approval", "plan");
    expect(dayOnePlan(noLanes, [entry("knock", "k"), plan])).toBe(plan);
    expect(dayOnePlan(noLanes, [entry("ask", "first")])?.key).toBe("ask:first");
    expect(dayOnePlan(noLanes, [entry("knock", "k")])).toBeNull();
    expect(dayOnePlan({ ...noLanes, idle: 1 }, [plan])).toBeNull();
  });
});

describe("snoozed holds", () => {
  it("leave Needs you while snoozed and come back after", async () => {
    const { createFixtureMissionsSource } = await import("./fixture/index.ts");
    const source = createFixtureMissionsSource({
      now: () => Date.parse("2026-10-17T08:33:00.000Z"),
    });
    let inbox: Parameters<typeof ownerWaitingEntries>[0] | undefined;
    const stop = source.subscribeInbox(MISSION, (value) => {
      inbox = value;
    });
    const first = inbox ? ownerWaitingEntries(inbox)[0] : undefined;
    if (!inbox || !first) throw new Error("nothing waiting");
    const before = ownerWaitingEntries(inbox).length;
    await source.snoozeInboxItem({
      subject: { kind: first.kind, id: first.record.id },
      until: null,
    });
    expect(ownerWaitingEntries(inbox).length).toBe(before - 1);
    expect(ownerWaitingEntries(inbox).some((entry) => entry.key === first.key)).toBe(false);
    await source.unsnoozeInboxItem({ subject: { kind: first.kind, id: first.record.id } });
    expect(ownerWaitingEntries(inbox).length).toBe(before);
    stop();
  });
});
