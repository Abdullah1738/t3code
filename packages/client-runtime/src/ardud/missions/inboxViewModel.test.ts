import { Ask, Draft, DraftNote, MissionInbox, Note, Suggestion } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  addDraftNoteInput,
  answerAskInput,
  askView,
  blocksLine,
  decideDraftInput,
  decideKnockInput,
  decideSuggestionInput,
  defaultInboxTab,
  draftNotesFor,
  draftOwnerEdit,
  fyiView,
  groupDraftNotes,
  inboxEntries,
  keepSelection,
  moveSelection,
  openForkFor,
  recommendationLine,
  suggestionTrackRecord,
  waitingLabel,
} from "./inboxViewModel.ts";
import type { MissionForkEntry } from "./source.ts";

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

const emptyInbox = (overrides: Record<string, unknown> = {}) =>
  decodeInbox({
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

describe("Decide", () => {
  it("shows the recommendation as advice and never preselects it", () => {
    const view = askView(ask(), NOW, MASTER);
    expect(view.askedBy).toBe("master");
    expect(view.waiting).toBe("waiting 38h");
    expect(view.recommendation).toBe("Master recommends “Hold” because not needed for Monday.");
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
    expect(recommendationLine(ask({ recommendation: null }), MASTER)).toBeNull();
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
      approvals: [
        {
          id: "a-new",
          missionId: "m",
          kind: "merge",
          title: "Merge #1",
          detail: "",
          requestedBy: "crw",
          links: [],
          status: "pending",
          staleReason: null,
          decidedBy: null,
          decidedAt: null,
          createdAt: "2026-10-17T08:00:00.000Z",
        },
      ],
    });
    expect(inboxEntries(inbox, "approve").map((entry) => entry.key)).toEqual([
      "approval:a-new",
      "draft:d-old",
    ]);
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

describe("forks and FYI", () => {
  it("finds the open fork about a record", () => {
    const fork = (id: string, status: string, origin: unknown): MissionForkEntry =>
      ({ fork: { id, status, kind: "discuss", origin }, question: null }) as never;
    const forks = [
      fork("closed", "archived", { kind: "call", id: "call-1" }),
      fork("open", "open", { kind: "call", id: "call-1" }),
      fork("link", "open", { kind: "url", label: "x", url: null, ref: null }),
    ];
    expect(openForkFor(forks, { kind: "call", id: "call-1" })?.fork.id).toBe("open");
    expect(openForkFor(forks, { kind: "call", id: "call-2" })).toBeNull();
  });

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
