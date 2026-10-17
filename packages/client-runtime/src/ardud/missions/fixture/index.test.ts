import {
  type DraftNote,
  type MissionId,
  type MissionInbox,
  type MissionListSnapshot,
  type MissionOverview,
  MissionError,
  type NoteId,
  type RoomId,
  type RoomPage,
  type Rule,
  type SubMissionId,
  type SuggestionStats,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type {
  MissionForkEntry,
  MissionInboxHistory,
  MissionOverviewSnapshot,
  MissionRoomEntry,
} from "../source.ts";
import { createSnapshotStore } from "../store.ts";
import { foldLaneCounts } from "../viewModel.ts";
import { createFixtureMissionsSource, FIXTURE_NOW } from "./index.ts";

const CRPKO = "crpko-engineering" as MissionId;
const JUNO = "juno-intents" as MissionId;
const now = () => Date.parse(FIXTURE_NOW) + 60_000;
const CONTROL = "room-control" as RoomId;

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
    // One open ask, two pending drafts, four crw approvals (one more closed as stale), one knock.
    expect(crpko?.needsYou).toBe(8);
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

  it("answers post into the ask's room with owner provenance and only wake the asker", async () => {
    const source = createFixtureMissionsSource({ now });
    const inbox = latest<MissionInbox>((l) => source.subscribeInbox(CRPKO, l));
    const release = latest<RoomPage | null>((l) =>
      source.subscribeRoom("room-release" as RoomId, l),
    );
    const history = latest<MissionInboxHistory>((l) => source.subscribeInboxHistory(CRPKO, l));
    const ask = inbox.value.asks[0]!;
    await expect(source.answerAsk({ askId: ask.id, optionId: null, text: "  " })).rejects.toThrow(
      "Pick an option",
    );
    await source.answerAsk({ askId: ask.id, optionId: null, text: "Hold it, ask me Monday." });
    const posted = release.value!.messages.at(-1)!;
    expect(posted.author).toEqual({ _tag: "owner" });
    expect(posted.provenance._tag).toBe("owner-app");
    expect(posted.to).toEqual([ask.askedBy]);
    expect(posted.summary).toContain("Hold it, ask me Monday.");
    expect(release.value!.ownerReadSeq).toBe(posted.seq);
    expect(history.value.asks.map((a) => a.id)).toEqual([ask.id]);
  });

  it("keeps the edited text on an approved draft and refuses an empty rewrite note", async () => {
    const source = createFixtureMissionsSource({ now });
    const inbox = latest<MissionInbox>((l) => source.subscribeInbox(CRPKO, l));
    const history = latest<MissionInboxHistory>((l) => source.subscribeInboxHistory(CRPKO, l));
    const [first, second] = inbox.value.drafts;
    await expect(
      source.decideDraft({ draftId: second!.id, action: "rewrite", rewriteNote: " " }),
    ).rejects.toBeInstanceOf(MissionError);
    await source.decideDraft({ draftId: first!.id, action: "approve", editedText: " Rebase. " });
    expect(inbox.value.drafts.map((d) => d.id)).toEqual([second!.id]);
    const approved = history.value.drafts.find((d) => d.id === first!.id)!;
    expect(approved.approvedText).toBe("Rebase.");
    expect(approved.text).toBe(first!.text);
  });

  it("shows crw approvals pending and the moved head as closed stale", () => {
    const source = createFixtureMissionsSource({ now });
    const inbox = latest<MissionInbox>((l) => source.subscribeInbox(CRPKO, l));
    const history = latest<MissionInboxHistory>((l) => source.subscribeInboxHistory(CRPKO, l));
    expect(inbox.value.approvals).toHaveLength(4);
    expect(inbox.value.counts.approve).toBe(6);
    expect(history.value.approvals.map((a) => a.status)).toEqual(["stale-closed"]);
  });

  it("adds, turns off and lists draft notes", async () => {
    const source = createFixtureMissionsSource({ now });
    const notes = latest<ReadonlyArray<DraftNote>>((l) => source.subscribeDraftNotes(CRPKO, l));
    const before = notes.value.length;
    const added = await source.addDraftNote({
      missionId: CRPKO,
      scope: { _tag: "person", name: "Pavan" },
      text: "Link the PR, not the ticket.",
    });
    expect(notes.value).toHaveLength(before + 1);
    await source.setDraftNoteActive({ draftNoteId: added.id, active: false });
    expect(notes.value.find((n) => n.id === added.id)?.active).toBe(false);
    await expect(
      source.addDraftNote({ missionId: CRPKO, scope: { _tag: "all" }, text: " " }),
    ).rejects.toBeInstanceOf(MissionError);
  });

  it("counts decided suggestions into their author's acceptance record", async () => {
    const source = createFixtureMissionsSource({ now });
    const inbox = latest<MissionInbox>((l) => source.subscribeInbox(CRPKO, l));
    const stats = latest<ReadonlyArray<SuggestionStats>>((l) => source.subscribeSuggestionStats(l));
    const scribe = () =>
      stats.value.find((row) => row.author === "scribe" && row.targetKind === "schedule")!;
    const before = scribe();
    const suggestion = inbox.value.suggestions.find((s) => s.author === "scribe")!;
    await source.decideSuggestion({
      suggestionId: suggestion.id,
      action: "dismiss",
      dismissReason: "Triage is paused on purpose this weekend.",
    });
    expect(scribe().dismissed).toBe(before.dismissed + 1);
    expect(inbox.value.suggestions.some((s) => s.id === suggestion.id)).toBe(false);
  });

  it("acks an FYI note out of the inbox", async () => {
    const source = createFixtureMissionsSource({ now });
    const inbox = latest<MissionInbox>((l) => source.subscribeInbox(CRPKO, l));
    const first = inbox.value.fyi[0]!;
    await source.ackNote({ noteId: first.id as NoteId });
    expect(inbox.value.fyi.some((n) => n.id === first.id)).toBe(false);
    expect(inbox.value.counts.fyi).toBe(inbox.value.fyi.length);
  });

  it("a Discuss on a call opens one fork, and Ask the mission opens another", async () => {
    const source = createFixtureMissionsSource({ now });
    const forks = latest<ReadonlyArray<MissionForkEntry>>((l) => source.subscribeForks(CRPKO, l));
    const callId = "call-10211" as never;
    await source.reactToCall({ missionId: CRPKO, callId, reaction: "discuss" });
    const discuss = forks.value.find((entry) => entry.fork.kind === "discuss")!;
    expect(discuss.fork.status).toBe("open");
    expect(discuss.fork.origin).toMatchObject({ kind: "call", id: "call-10211" });
    // Asking again on the same call reuses the open fork.
    const again = await source.openFork({
      missionId: CRPKO,
      kind: "discuss",
      origin: { kind: "call", id: callId, label: "x" },
    });
    expect(again.fork.id).toBe(discuss.fork.id);
    await expect(
      source.openFork({ missionId: CRPKO, kind: "owner-question", origin: null, question: "" }),
    ).rejects.toBeInstanceOf(MissionError);
    const asked = await source.openFork({
      missionId: CRPKO,
      kind: "owner-question",
      origin: null,
      question: "Why is risk#68 still the Monday risk?",
    });
    expect(forks.value[0]?.fork.id).toBe(asked.fork.id);
    await source.archiveFork({ forkId: asked.fork.id });
    expect(forks.value[0]?.fork.status).toBe("archived");
  });

  it("an owner edit of intended effort locks the field; handing back restores the proposal", async () => {
    const source = createFixtureMissionsSource({ now });
    const overview = latest<MissionOverviewSnapshot | null>((l) =>
      source.subscribeOverview(CRPKO, l),
    );
    const wave = () => overview.value!.subMissions.find((s) => s.id === "crpko-arch-wave")!;
    const proposed = wave().intendedEffort;
    await source.setIntendedEffort({ subMissionId: wave().id, share: 0.6 });
    expect(wave().intendedEffort).toBe(0.6);
    expect(wave().lockedFields).toContain("intendedEffort");
    await expect(
      source.setIntendedEffort({ subMissionId: wave().id, share: 1.4 }),
    ).rejects.toBeInstanceOf(MissionError);
    await source.setIntendedEffort({ subMissionId: wave().id, share: null });
    expect(wave().intendedEffort).toBe(proposed);
    expect(wave().lockedFields).not.toContain("intendedEffort");
  });

  it("carries the pool usage line on the overview", () => {
    const source = createFixtureMissionsSource({ now });
    const overview = latest<MissionOverviewSnapshot | null>((l) =>
      source.subscribeOverview(CRPKO, l),
    );
    expect(overview.value!.poolUsage.map((pool) => pool._tag)).toEqual([
      "accounts",
      "accounts",
      "budget",
      "lock",
    ]);
  });

  it("opens a room at the owner's read position and pages older messages", async () => {
    const source = createFixtureMissionsSource({ now });
    const rooms = latest<ReadonlyArray<MissionRoomEntry>>((l) => source.subscribeRooms(CRPKO, l));
    const delivery = latest<RoomPage | null>((l) =>
      source.subscribeRoom("room-delivery" as RoomId, l),
    );
    const page = delivery.value!;
    const unread = rooms.value.find((entry) => entry.room.id === "room-delivery")!.unread;
    expect(unread).toBeGreaterThan(100);
    // One read message above the first unread, so the marker has a line to sit under.
    expect(page.messages.filter((m) => m.seq <= page.ownerReadSeq)).toHaveLength(1);
    expect(page.hasOlder).toBe(true);
    const older = await source.loadRoomPage({
      roomId: page.room.id,
      beforeSeq: page.messages[0]!.seq,
      limit: 10,
    });
    expect(older.messages.every((m) => m.seq < page.messages[0]!.seq)).toBe(true);
    expect(older.messages.length).toBeLessThanOrEqual(10);
  });

  it("moves the read position forward only", async () => {
    const source = createFixtureMissionsSource({ now });
    const control = latest<RoomPage | null>((l) => source.subscribeRoom(CONTROL, l));
    const rooms = latest<ReadonlyArray<MissionRoomEntry>>((l) => source.subscribeRooms(CRPKO, l));
    const last = control.value!.messages.at(-1)!.seq;
    await source.markRoomRead({ roomId: CONTROL, seq: last });
    expect(control.value!.ownerReadSeq).toBe(last);
    await source.markRoomRead({ roomId: CONTROL, seq: 1 });
    expect(control.value!.ownerReadSeq).toBe(last);
    expect(rooms.value.find((entry) => entry.room.id === CONTROL)?.unread).toBe(0);
  });

  it("posts a correction to the master and saves it as a rule", async () => {
    const source = createFixtureMissionsSource({ now });
    const control = latest<RoomPage | null>((l) => source.subscribeRoom(CONTROL, l));
    const rules = latest<ReadonlyArray<Rule>>((l) => source.subscribeRules(CRPKO, l));
    const message = await source.postRoomMessage({
      missionId: CRPKO,
      roomId: CONTROL,
      kind: "control",
      summary: "Do not merge non-Monday PRs before the Codex reset.",
      isCorrection: true,
    });
    expect(message.isCorrection).toBe(true);
    expect(message.to).toEqual([{ _tag: "role", roleId: "crpko-master" }]);
    expect(control.value!.messages.at(-1)?.id).toBe(message.id);
    const before = rules.value.length;
    const rule = await source.upsertRule({
      missionId: CRPKO,
      title: "No non-Monday merges before the Codex reset",
      quote: message.summary,
    });
    expect(rules.value).toHaveLength(before + 1);
    expect(rule.provenance._tag).toBe("owner-app");
    await expect(
      source.postRoomMessage({
        missionId: CRPKO,
        roomId: CONTROL,
        kind: "status",
        summary: "x".repeat(401),
      }),
    ).rejects.toBeInstanceOf(MissionError);
  });
});
