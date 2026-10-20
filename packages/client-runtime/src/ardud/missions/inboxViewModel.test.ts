// @effect-diagnostics globalDate:off - Tests build times on the local calendar.
import {
  approverOf,
  type Approver,
  Ask,
  Draft,
  DraftNote,
  type InboxMark,
  MissionInbox,
  Note,
  Suggestion,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  addDraftNoteInput,
  answerAskInput,
  askView,
  blocksLine,
  commentInput,
  commentsOf,
  decideDraftInput,
  decideKnockInput,
  decideSuggestionInput,
  defaultInboxTab,
  draftNotesFor,
  draftOwnerEdit,
  fyiView,
  groupDraftNotes,
  INITIAL_INBOX_UI,
  inboxEntries,
  inboxKeyAction,
  inboxTabCounts,
  inboxUiReducer,
  isSnoozed,
  keepSelection,
  markOf,
  moveSelection,
  recommendationLine,
  snoozeChoices,
  snoozedEntries,
  snoozeLabel,
  snoozeUntilFromLocal,
  suggestionTrackRecord,
  waitingLabel,
} from "./inboxViewModel.ts";
import type { MissionInboxSnapshot } from "./source.ts";

const T0 = "2026-10-17T08:00:00.000Z";
const NOW = Date.parse("2026-10-17T08:33:00.000Z");
const MASTER = "crpko-master";

const decodeAsk = Schema.decodeUnknownSync(Ask);
const decodeDraft = Schema.decodeUnknownSync(Draft);
const decodeNote = Schema.decodeUnknownSync(DraftNote);
const decodeFyi = Schema.decodeUnknownSync(Note);
const decodeSuggestion = Schema.decodeUnknownSync(Suggestion);
const decodeInbox = Schema.decodeUnknownSync(MissionInbox);

const ask = (overrides: Record<string, unknown> = {}) =>
  decodeAsk({
    id: "ask-1",
    missionId: "m",
    subMissionId: null,
    askedBy: { _tag: "role", roleId: MASTER },
    question: "Stamp r004 now?",
    context: "",
    options: [
      { id: "stamp-now", label: "Stamp r004 now", detail: "" },
      { id: "hold", label: "Hold", detail: "" },
    ],
    recommendation: { optionId: "hold", reason: "Not needed for Monday." },
    blocks: [{ kind: "work-item", id: "CRP-13215" }],
    costOfWaiting: "",
    urgency: "normal",
    status: "open",
    answer: null,
    createdAt: "2026-10-15T18:40:00.000Z",
    updatedAt: T0,
    ...overrides,
  });

const draft = (overrides: Record<string, unknown> = {}) =>
  decodeDraft({
    id: "draft-1",
    missionId: "m",
    audience: "Pavan",
    channel: "github",
    target: { kind: "pull-request", label: "risk#124", url: null, ref: null },
    text: "Hi Pavan, please rebase #124.",
    approvedText: null,
    writerRoleId: MASTER,
    source: { kind: "master", ref: null },
    appliedNoteIds: [],
    status: "pending",
    rewriteNote: null,
    decidedBy: null,
    decidedAt: null,
    sentAt: null,
    createdAt: T0,
    ...overrides,
  });

const draftNote = (id: string, scope: Record<string, unknown>, active = true) =>
  decodeNote({
    id,
    missionId: null,
    scope,
    text: `note ${id}`,
    source: "owner",
    active,
    createdAt: T0,
    updatedAt: T0,
  });

const suggestion = (overrides: Record<string, unknown> = {}) =>
  decodeSuggestion({
    id: "s-1",
    missionId: null,
    targetKind: "schedule",
    target: null,
    title: "Restart sweeps",
    before: null,
    after: { everyMinutes: 30, running: true },
    diffText: "- stopped\n+ every 30 min",
    why: "",
    evidence: [],
    author: "scribe",
    acceptor: "master",
    status: "open",
    dismissReason: null,
    outcome: null,
    decidedBy: null,
    decidedAt: null,
    createdAt: T0,
    ...overrides,
  });

const approval = (id: string, createdAt: string) => ({
  id,
  missionId: "m",
  kind: "merge",
  title: `Merge ${id}`,
  detail: "",
  requestedBy: "crw",
  links: [],
  status: "pending",
  staleReason: null,
  decidedBy: null,
  decidedAt: null,
  createdAt,
});

/** A routed inbox; every draft and approval goes to the owner unless `routes` says master. */
const emptyInbox = (
  overrides: Record<string, unknown> = {},
  routes: Record<string, Approver> = {},
): MissionInboxSnapshot => {
  const inbox = decodeInbox({
    revision: 1,
    counts: { decide: 0, approve: 0, knocks: 0, suggestions: 0, fyi: 0 },
    asks: [],
    drafts: [],
    approvals: [],
    knocks: [],
    suggestions: [],
    fyi: [],
    ...overrides,
  });
  const routed = <T extends { readonly id: string }>(record: T) => ({
    ...record,
    approver: routes[record.id] ?? ("owner" as const),
  });
  const drafts = inbox.drafts.map(routed);
  const approvals = inbox.approvals.map(routed);
  return {
    ...inbox,
    drafts,
    approvals,
    masterCounts: {
      approve: [...drafts, ...approvals].filter((r) => approverOf(r) === "master").length,
      suggestions: inbox.suggestions.filter((s) => s.acceptor === "master").length,
    },
  };
};

describe("Decide", () => {
  it("shows the recommendation as advice, never says who asked and never preselects it", () => {
    const view = askView(ask(), NOW);
    expect(view.waiting).toBe("waiting 38h");
    expect(view.recommendation).toBe("“Hold” is recommended because not needed for Monday.");
    expect(Object.keys(view)).not.toContain("askedBy");
    expect(view.options.map((option) => [option.shortcut, option.recommended])).toEqual([
      [1, false],
      [2, true],
    ]);
    // No field anywhere implies a default or deadline.
    expect(Object.keys(view)).not.toContain("defaultOptionId");
    expect(Object.keys(view)).not.toContain("deadline");
  });

  it("says what waits on the answer and that the rest keeps running", () => {
    expect(blocksLine([{ kind: "work-item", id: "CRP-13215" }])).toBe(
      "Blocks CRP-13215 only. Everything else keeps running.",
    );
    expect(blocksLine([])).toBe("Blocks nothing. The mission keeps running.");
    expect(recommendationLine(ask({ recommendation: null }))).toBeNull();
  });

  it("needs an option or text to answer", () => {
    expect(answerAskInput(ask(), { optionId: null, text: "  " }).ok).toBe(false);
    expect(answerAskInput(ask(), { optionId: "gone", text: "" }).ok).toBe(false);
    expect(answerAskInput(ask(), { optionId: null, text: " hold it " })).toEqual({
      ok: true,
      value: { askId: "ask-1", optionId: null, text: "hold it" },
    });
    expect(answerAskInput(ask(), { optionId: "hold", text: "" }).ok).toBe(true);
  });

  it("formats the wait in minutes, hours, then days", () => {
    expect(waitingLabel("2026-10-17T08:21:00.000Z", NOW)).toBe("waiting 12m");
    expect(waitingLabel("2026-10-14T08:33:00.000Z", NOW)).toBe("waiting 3d");
  });
});

describe("tabs and keyboard selection", () => {
  it("opens on the first tab with something in it", () => {
    expect(
      defaultInboxTab({ counts: { decide: 0, approve: 2, knocks: 1, suggestions: 0, fyi: 3 } }),
    ).toBe("approve");
    expect(
      defaultInboxTab({ counts: { decide: 0, approve: 0, knocks: 0, suggestions: 0, fyi: 0 } }),
    ).toBe("decide");
  });

  it("mixes drafts and approvals newest first on Approve", () => {
    const inbox = emptyInbox({
      drafts: [draft({ id: "d-old", createdAt: "2026-10-17T07:00:00.000Z" })],
      approvals: [approval("a-new", "2026-10-17T08:00:00.000Z")],
    });
    expect(inboxEntries(inbox, "approve").map((entry) => entry.key)).toEqual([
      "approval:a-new",
      "draft:d-old",
    ]);
  });

  it("shows what is routed to the owner by default and the master's records on the filter", () => {
    const inbox = emptyInbox(
      {
        asks: [ask()],
        drafts: [draft({ id: "d-mine" }), draft({ id: "d-master" })],
        approvals: [approval("a-master", "2026-10-17T07:00:00.000Z")],
        suggestions: [
          suggestion({ id: "s-master" }),
          suggestion({ id: "s-mine", acceptor: "owner" }),
        ],
        counts: { decide: 1, approve: 1, knocks: 0, suggestions: 1, fyi: 0 },
      },
      { "d-master": "master", "a-master": "master" },
    );
    expect(inboxEntries(inbox, "approve").map((entry) => entry.key)).toEqual(["draft:d-mine"]);
    expect(inboxEntries(inbox, "approve", "master").map((entry) => entry.key)).toEqual([
      "draft:d-master",
      "approval:a-master",
    ]);
    expect(inboxEntries(inbox, "suggestions").map((entry) => entry.key)).toEqual([
      "suggestion:s-mine",
    ]);
    expect(inboxEntries(inbox, "suggestions", "master").map((entry) => entry.key)).toEqual([
      "suggestion:s-master",
    ]);
    // Asks are always the owner's.
    expect(inboxEntries(inbox, "decide", "master")).toEqual([]);
    expect(inboxTabCounts(inbox, "master")).toEqual({
      decide: 0,
      approve: 2,
      knocks: 0,
      suggestions: 1,
      fyi: 0,
    });
    expect(defaultInboxTab(inbox, "master")).toBe("approve");
  });

  it("moves with j/k and clamps at the ends", () => {
    const keys = ["a", "b", "c"];
    expect(moveSelection(keys, null, 1)).toBe("a");
    expect(moveSelection(keys, null, -1)).toBe("c");
    expect(moveSelection(keys, "b", 1)).toBe("c");
    expect(moveSelection(keys, "c", 1)).toBe("c");
    expect(moveSelection(keys, "a", -1)).toBe("a");
    expect(moveSelection([], "a", 1)).toBeNull();
  });

  it("selects the next item when the selected one is decided", () => {
    expect(keepSelection(["a", "b", "c"], ["a", "c"], "b")).toBe("c");
    expect(keepSelection(["a", "b", "c"], ["a"], "c")).toBe("a");
    expect(keepSelection(["a", "b", "c"], ["b", "c"], "b")).toBe("b");
    expect(keepSelection(["a"], [], "a")).toBeNull();
  });
});

describe("drafts and draft notes", () => {
  it("validates each decision and treats an unchanged edit as approve", () => {
    const pending = draft();
    expect(decideDraftInput(pending, { action: "edit-approve", editedText: " " }).ok).toBe(false);
    expect(decideDraftInput(pending, { action: "rewrite", note: "" }).ok).toBe(false);
    expect(
      decideDraftInput(pending, { action: "edit-approve", editedText: `${pending.text}  ` }),
    ).toEqual({ ok: true, value: { draftId: "draft-1", action: "approve" } });
    expect(
      decideDraftInput(pending, { action: "edit-approve", editedText: "Please rebase #124." }),
    ).toEqual({
      ok: true,
      value: { draftId: "draft-1", action: "approve", editedText: "Please rebase #124." },
    });
  });

  it("shows what the owner changed once a draft is approved", () => {
    expect(draftOwnerEdit(draft())).toBeNull();
    expect(draftOwnerEdit(draft({ approvedText: "Hi Pavan, please rebase #124." }))).toBeNull();
    const edit = draftOwnerEdit(draft({ approvedText: "Please rebase #124." }))!;
    expect(edit.stats).toEqual({ addedWords: 1, removedWords: 3 });
    expect(edit.segments.filter((s) => s.kind === "removed").map((s) => s.text)).toEqual([
      "Hi Pavan, please",
    ]);
  });

  it("splits notes into applied, skipped and unknown for a draft", () => {
    const notes = [
      draftNote("all", { _tag: "all" }),
      draftNote("gh", { _tag: "channel", channel: "github" }),
      draftNote("cliq", { _tag: "channel", channel: "cliq" }),
      draftNote("pavan", { _tag: "person", name: "pavan" }),
      draftNote("off", { _tag: "all" }, false),
    ];
    const result = draftNotesFor(draft({ appliedNoteIds: ["all", "deleted"] }), notes);
    expect(result.applied.map((n) => n.id)).toEqual(["all"]);
    expect(result.skipped.map((n) => n.id)).toEqual(["gh", "pavan"]);
    expect(result.unknownIds).toEqual(["deleted"]);
  });

  it("groups notes all, channels, people with active ones first", () => {
    const groups = groupDraftNotes([
      draftNote("p", { _tag: "person", name: "Sharath" }),
      draftNote("off", { _tag: "all" }, false),
      draftNote("gh", { _tag: "channel", channel: "github" }),
      draftNote("on", { _tag: "all" }),
    ]);
    expect(groups.map((g) => g.label)).toEqual(["All drafts", "GitHub drafts", "To Sharath"]);
    expect(groups[0]?.notes.map((n) => n.id)).toEqual(["on", "off"]);
  });

  it("builds a note input per scope", () => {
    expect(addDraftNoteInput(null, { kind: "all" }, " ").ok).toBe(false);
    expect(addDraftNoteInput(null, { kind: "person", name: " " }, "No opener").ok).toBe(false);
    expect(addDraftNoteInput(null, { kind: "person", name: " Pavan " }, " No opener ")).toEqual({
      ok: true,
      value: { missionId: null, scope: { _tag: "person", name: "Pavan" }, text: "No opener" },
    });
  });
});

describe("knocks and suggestions", () => {
  it("forwards a knock as is unless the text changed", () => {
    const knock = { id: "k" as never, summary: "Wants to tell the master." };
    expect(decideKnockInput(knock, { action: "forward", editedText: knock.summary })).toEqual({
      ok: true,
      value: { knockId: "k", action: "forward" },
    });
    expect(decideKnockInput(knock, { action: "forward", editedText: "" }).ok).toBe(false);
    expect(decideKnockInput(knock, { action: "forward", editedText: "Shorter." })).toMatchObject({
      ok: true,
      value: { editedText: "Shorter." },
    });
  });

  it("requires a dismiss reason and parses an edited JSON value", () => {
    const open = suggestion();
    expect(decideSuggestionInput(open, { action: "dismiss", reason: " " }).ok).toBe(false);
    expect(decideSuggestionInput(open, { action: "accept-edited", editedText: "{nope" }).ok).toBe(
      false,
    );
    expect(
      decideSuggestionInput(open, {
        action: "accept-edited",
        editedText: '{ "everyMinutes": 30, "running": true }',
      }),
    ).toEqual({ ok: true, value: { suggestionId: "s-1", action: "accept" } });
    expect(
      decideSuggestionInput(open, {
        action: "accept-edited",
        editedText: '{ "everyMinutes": 60, "running": true }',
      }),
    ).toEqual({
      ok: true,
      value: {
        suggestionId: "s-1",
        action: "accept-edited",
        editedAfter: { everyMinutes: 60, running: true },
      },
    });
  });

  it("reports the author's acceptance rate overall and for this kind", () => {
    const stats = [
      {
        author: "scribe",
        targetKind: "schedule",
        shown: 10,
        accepted: 6,
        dismissed: 3,
        bar: "normal",
      },
      { author: "scribe", targetKind: "rule", shown: 5, accepted: 1, dismissed: 4, bar: "raised" },
      {
        author: "editor",
        targetKind: "draft-note",
        shown: 7,
        accepted: 5,
        dismissed: 1,
        bar: "normal",
      },
    ] as const;
    const record = suggestionTrackRecord(stats, { author: "scribe", targetKind: "schedule" });
    expect(record.author.label).toBe("7 of 14 accepted (50%)");
    expect(record.author.bar).toBe("raised");
    expect(record.kind?.label).toBe("6 of 9 accepted (67%)");
    expect(
      suggestionTrackRecord(stats, { author: "governor", targetKind: "pool" }).author.label,
    ).toBe("none decided yet");
  });
});

describe("FYI", () => {
  it("separates observed from claimed and shows the evidence state", () => {
    const note = decodeFyi({
      id: "n",
      missionId: "m",
      subMissionId: null,
      laneId: null,
      type: "claim-of-done",
      summary: "Kafka fix is done.",
      sources: [
        { threadId: "t", quote: " fix open at b5bf7044 ", fromEvent: 10204, toEvent: 10204 },
      ],
      basis: "claimed",
      severity: "medium",
      confidence: 0.6,
      author: "scribe",
      citation: "unchecked",
      evidence: "missing",
      evidenceLinks: [],
      replacesNoteId: null,
      ackedBy: [],
      createdAt: T0,
    });
    expect(fyiView(note)).toEqual({
      heading: "Claimed done",
      severity: "medium",
      basis: "Claimed, not observed",
      evidence: { label: "No evidence found", tone: "missing" },
      citation: null,
      quote: "fix open at b5bf7044",
      sourceEvent: 10204,
    });
  });
});

describe("inbox keys", () => {
  const askEntry = () => {
    const record = ask();
    return { kind: "ask" as const, key: `ask:${record.id}`, record };
  };

  it("moves with j/k and ignores keys while typing or with modifiers", () => {
    expect(inboxKeyAction({ key: "j", modified: false, typing: false, selected: null })).toEqual({
      type: "move",
      delta: 1,
    });
    expect(inboxKeyAction({ key: "k", modified: false, typing: true, selected: null })).toBeNull();
    expect(inboxKeyAction({ key: "j", modified: true, typing: false, selected: null })).toBeNull();
  });

  it("picks an ask option by number without sending it", () => {
    const entry = askEntry();
    const first = entry.record.options[0]!;
    expect(inboxKeyAction({ key: "1", modified: false, typing: false, selected: entry })).toEqual({
      type: "pick-option",
      optionId: first.id,
    });
    expect(
      inboxKeyAction({ key: "9", modified: false, typing: false, selected: entry }),
    ).toBeNull();
    expect(
      inboxKeyAction({ key: "e", modified: false, typing: false, selected: entry }),
    ).toBeNull();
  });
});

describe("inbox screen state", () => {
  const keys = ["ask:a", "draft:b", "knock:c"];

  it("starts with nothing selected or picked", () => {
    expect(INITIAL_INBOX_UI).toEqual({ selectedKey: null, editingKey: null, picked: {} });
  });

  it("moves, picks and edits from keys", () => {
    let state = inboxUiReducer(INITIAL_INBOX_UI, {
      type: "key",
      action: { type: "move", delta: 1 },
      keys,
    });
    expect(state.selectedKey).toBe("ask:a");
    state = inboxUiReducer(state, {
      type: "key",
      action: { type: "pick-option", optionId: "hold" },
      keys,
    });
    expect(state.picked).toEqual({ "ask:a": "hold" });
    state = inboxUiReducer(state, { type: "key", action: { type: "move", delta: 1 }, keys });
    state = inboxUiReducer(state, { type: "key", action: { type: "edit" }, keys });
    expect(state).toMatchObject({ selectedKey: "draft:b", editingKey: "draft:b" });
  });

  it("ignores pick and edit keys with nothing selected", () => {
    const state = inboxUiReducer(INITIAL_INBOX_UI, {
      type: "key",
      action: { type: "edit" },
      keys,
    });
    expect(state).toBe(INITIAL_INBOX_UI);
  });

  it("clicking an option selects the ask; clicking it off clears the pick", () => {
    let state = inboxUiReducer(INITIAL_INBOX_UI, {
      type: "pick",
      key: "ask:a",
      optionId: "stamp-now",
    });
    expect(state).toMatchObject({ selectedKey: "ask:a", picked: { "ask:a": "stamp-now" } });
    state = inboxUiReducer(state, { type: "pick", key: "ask:a", optionId: null });
    expect(state.picked).toEqual({});
  });

  it("moves to the next item and closes the editor when the edited item leaves", () => {
    let state = inboxUiReducer(INITIAL_INBOX_UI, { type: "edit", key: "draft:b" });
    state = inboxUiReducer(state, {
      type: "entries-changed",
      previousKeys: keys,
      nextKeys: ["ask:a", "knock:c"],
    });
    expect(state).toMatchObject({ selectedKey: "knock:c", editingKey: null });
  });

  it("clears selection and editor on another tab but keeps picks", () => {
    let state = inboxUiReducer(INITIAL_INBOX_UI, { type: "pick", key: "ask:a", optionId: "hold" });
    state = inboxUiReducer(state, { type: "edit", key: "draft:b" });
    state = inboxUiReducer(state, { type: "scope-changed" });
    expect(state).toEqual({ selectedKey: null, editingKey: null, picked: { "ask:a": "hold" } });
  });

  it("forgets the pick and editor of a decided item", () => {
    let state = inboxUiReducer(INITIAL_INBOX_UI, { type: "pick", key: "ask:a", optionId: "hold" });
    state = inboxUiReducer(state, { type: "done", key: "ask:a" });
    expect(state.picked).toEqual({});
    expect(state.selectedKey).toBe("ask:a");
  });
});

describe("Comments and snoozes", () => {
  const mark = (
    kind: InboxMark["subject"]["kind"],
    id: string,
    snooze: InboxMark["snooze"],
    comments: InboxMark["comments"] = [],
  ): InboxMark => ({
    id: `${kind}:${id}`,
    missionId: "m" as InboxMark["missionId"],
    subject: { kind, id },
    comments,
    snooze,
    updatedAt: T0,
  });
  const until = (iso: string | null) => ({ at: T0, until: iso, stamp: "x" });
  const inbox = (marks: ReadonlyArray<InboxMark>) => ({
    ...emptyInbox(
      {
        counts: { decide: 2, approve: 1, knocks: 0, suggestions: 0, fyi: 0 },
        asks: [ask(), ask({ id: "ask-2", createdAt: T0 })],
        drafts: [draft({ id: "draft-1" })],
      },
      { "draft-1": "master" },
    ),
    marks,
  });

  it("moves a snoozed item out of the owner's inbox and its count, never the master's", () => {
    const snoozed = inbox([
      mark("ask", "ask-1", until(null)),
      mark("draft", "draft-1", until(null)),
    ]);
    expect(inboxEntries(snoozed, "decide", "owner", NOW).map((e) => e.key)).toEqual(["ask:ask-2"]);
    expect(inboxTabCounts(snoozed, "owner", NOW).decide).toBe(1);
    // The master's view keeps the snoozed draft.
    expect(inboxEntries(snoozed, "approve", "master", NOW).map((e) => e.key)).toEqual([
      "draft:draft-1",
    ]);
    expect(snoozedEntries(snoozed, NOW).map((e) => e.key)).toEqual(["ask:ask-1"]);
    expect(snoozedEntries(snoozed, NOW, ["approve"])).toEqual([]);
  });

  it("brings an item back when its time passes on the device clock", () => {
    const later = new Date(NOW + 3_600_000).toISOString();
    const snoozed = inbox([mark("ask", "ask-1", until(later))]);
    expect(isSnoozed(markOf(snoozed, "ask:ask-1"), NOW)).toBe(true);
    expect(inboxEntries(snoozed, "decide", "owner", NOW)).toHaveLength(1);
    expect(inboxEntries(snoozed, "decide", "owner", NOW + 3_600_000)).toHaveLength(2);
    expect(snoozedEntries(snoozed, NOW + 3_600_000)).toEqual([]);
    // A comment alone hides nothing.
    const commented = inbox([
      mark("ask", "ask-1", null, [{ id: "c-1", body: "Leaning hold", at: T0 }]),
    ]);
    expect(inboxEntries(commented, "decide", "owner", NOW)).toHaveLength(2);
    expect(commentsOf(commented, "ask:ask-1").map((c) => c.body)).toEqual(["Leaning hold"]);
  });

  it("labels the snooze and offers choices in the device zone", () => {
    expect(snoozeLabel(mark("ask", "a", until(null)), NOW)).toBe("Until it changes");
    expect(snoozeLabel(mark("ask", "a", null), NOW)).toBeNull();
    const choices = snoozeChoices(NOW);
    expect(choices.map((choice) => choice.key)).toEqual(["change", "hour", "tomorrow", "monday"]);
    expect(choices[0]?.until).toBeNull();
    expect(Date.parse(choices[1]?.until ?? "")).toBe(NOW + 3_600_000);
    const tomorrow = new Date(choices[2]?.until ?? "");
    expect([tomorrow.getHours(), tomorrow.getMinutes()]).toEqual([9, 0]);
    const monday = new Date(choices[3]?.until ?? "");
    expect(monday.getDay()).toBe(1);
    expect(monday.getTime()).toBeGreaterThan(NOW);
    expect(snoozeUntilFromLocal("2020-01-01T09:00", NOW)).toBeNull();
    const local = snoozeUntilFromLocal("2030-01-02T09:30", NOW);
    expect(local && new Date(local).getHours()).toBe(9);
  });

  it("checks a comment before it is sent", () => {
    const entry = { kind: "ask" as const, record: ask() };
    expect(commentInput(entry, "  ")).toEqual({ ok: false, error: "Write a comment first." });
    expect(commentInput(entry, " Leaning hold ")).toEqual({
      ok: true,
      value: { subject: { kind: "ask", id: "ask-1" }, body: "Leaning hold" },
    });
  });
});
