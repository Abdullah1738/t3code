import {
  DraftId,
  DraftNoteId,
  MissionId,
  RoleId,
  SuggestionId,
  ThreadId,
  type Draft,
  type DraftNote,
  type MissionProvenance,
  type Suggestion,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Result from "effect/Result";

import {
  draftNoteFromSuggestion,
  editPatterns,
  learnFromEdits,
  renderWordDiff,
  wordDiff,
} from "./draftLearning.ts";
import {
  decideDraft,
  draftExamples,
  notesFor,
  reopenDraft,
  reviseDraft,
  saveDraftNote,
  submitDraft,
  type SubmitDraftCommand,
} from "./draftModel.ts";
import type { MissionCaller } from "./shared.ts";
import { decideSuggestion, proposeSuggestion } from "./suggestionModel.ts";

const now = "2026-10-17T10:00:00.000Z";
const missionId = MissionId.make("m1");
const ownerApp: MissionProvenance = { _tag: "owner-app", surface: "web", sessionId: "s" };
const owner: MissionCaller = { provenance: ownerApp, actors: [{ _tag: "owner" }] };
const writerRole = RoleId.make("role-writer");
const writer: MissionCaller = {
  provenance: { _tag: "agent", threadId: ThreadId.make("t-writer"), roleId: writerRole },
  actors: [{ _tag: "role", roleId: writerRole }],
};
const stranger: MissionCaller = {
  provenance: { _tag: "agent", threadId: ThreadId.make("t-x"), roleId: null },
  actors: [{ _tag: "thread", threadId: ThreadId.make("t-x") }],
};
const editorCaller: MissionCaller = {
  provenance: { _tag: "system", component: "editor" },
  actors: [{ _tag: "system", component: "editor" }],
};

const note = (overrides: Partial<DraftNote> & Pick<DraftNote, "id" | "scope">): DraftNote => ({
  missionId: null,
  text: "Be brief.",
  source: "owner",
  active: true,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

const notes: DraftNote[] = [
  note({ id: DraftNoteId.make("n-person"), scope: { _tag: "person", name: "Sami" } }),
  note({ id: DraftNoteId.make("n-all"), scope: { _tag: "all" } }),
  note({ id: DraftNoteId.make("n-cliq"), scope: { _tag: "channel", channel: "cliq" } }),
  note({ id: DraftNoteId.make("n-linear"), scope: { _tag: "channel", channel: "linear" } }),
  note({ id: DraftNoteId.make("n-off"), scope: { _tag: "all" }, active: false }),
  note({
    id: DraftNoteId.make("n-other-mission"),
    scope: { _tag: "all" },
    missionId: MissionId.make("m2"),
  }),
];

let counter = 0;
const submit = (overrides: Partial<SubmitDraftCommand> = {}) =>
  submitDraft({
    id: DraftId.make(`d-${++counter}`),
    missionId,
    audience: "Sami",
    channel: "cliq",
    target: { kind: "url", label: "Sami DM", url: "https://cliq.example/sami", ref: null },
    text: "Hi Sami, hope you're well! The fix is merged.",
    source: { kind: "fork", ref: null },
    writerRoleId: writerRole,
    caller: writer,
    notes,
    existing: [],
    now,
    ...overrides,
  });

const pending = () => Result.getOrThrow(submit()).record;

const approveEdited = (draft: Draft, editedText: string, at: string) =>
  Result.getOrThrow(
    decideDraft({
      draft,
      input: { draftId: draft.id, action: "approve", editedText },
      provenance: ownerApp,
      now: at,
    }),
  );

describe("drafts", () => {
  it("applies matching active notes, broadest first, ignoring other channels and missions", () => {
    const draft = pending();
    expect(draft.status).toBe("pending");
    expect(draft.appliedNoteIds).toEqual(["n-all", "n-cliq", "n-person"]);
    expect(
      notesFor({ missionId, channel: "email", audience: "Lee" }, notes).map((n) => n.id),
    ).toEqual(["n-all"]);
  });

  it("only writers submit, as a role they hold, and the same draft is not queued twice", () => {
    const code = (outcome: ReturnType<typeof submit>) =>
      Result.isFailure(outcome) ? outcome.failure.code : "ok";
    expect(code(submit({ caller: owner }))).toBe("forbidden");
    expect(code(submit({ caller: stranger }))).toBe("forbidden");
    expect(code(submit({ caller: stranger, writerRoleId: null }))).toBe("ok");
    expect(code(submit({ existing: [pending()] }))).toBe("conflict");
  });

  it("only the owner decides; approving with edits records the edit and stops at approved", () => {
    const draft = pending();
    const agentTry = decideDraft({
      draft,
      input: { draftId: draft.id, action: "approve" },
      provenance: writer.provenance,
      now,
    });
    expect(Result.isFailure(agentTry) && agentTry.failure.code).toBe("provenance-required");
    const decision = approveEdited(draft, "The fix is merged.", now);
    expect(decision.record.status).toBe("approved");
    expect(decision.record.approvedText).toBe("The fix is merged.");
    expect(decision.record.sentAt).toBeNull();
    expect(decision.edit).toEqual({
      draftId: draft.id,
      before: draft.text,
      after: "The fix is merged.",
    });
    const again = decideDraft({
      draft: decision.record,
      input: { draftId: draft.id, action: "drop" },
      provenance: ownerApp,
      now,
    });
    expect(Result.isFailure(again) && again.failure.code).toBe("conflict");
  });

  it("an iMessage decision must carry the inbound it was verified from", () => {
    const draft = pending();
    const provenance: MissionProvenance = {
      _tag: "owner-imessage",
      chat: "owner",
      inboundId: "guid-1",
    };
    const mismatch = decideDraft({
      draft,
      input: { draftId: draft.id, action: "approve", inboundId: "guid-2" },
      provenance,
      now,
    });
    expect(Result.isFailure(mismatch) && mismatch.failure.code).toBe("provenance-invalid");
    const okDecision = decideDraft({
      draft,
      input: { draftId: draft.id, action: "approve", inboundId: "guid-1" },
      provenance,
      now,
    });
    expect(Result.isSuccess(okDecision)).toBe(true);
  });

  it("rewrite needs a note, the writer revises, and the owner can reopen an approval", () => {
    const draft = pending();
    const noNote = decideDraft({
      draft,
      input: { draftId: draft.id, action: "rewrite" },
      provenance: ownerApp,
      now,
    });
    expect(Result.isFailure(noNote) && noNote.failure.code).toBe("invalid");
    const rewrite = Result.getOrThrow(
      decideDraft({
        draft,
        input: { draftId: draft.id, action: "rewrite", rewriteNote: "Mention the PR" },
        provenance: ownerApp,
        now,
      }),
    );
    expect(rewrite.record.status).toBe("rewrite-requested");
    const strangerRevision = reviseDraft({
      draft: rewrite.record,
      text: "Merged in #12.",
      caller: stranger,
      notes,
      now,
    });
    expect(Result.isFailure(strangerRevision)).toBe(true);
    const revised = Result.getOrThrow(
      reviseDraft({ draft: rewrite.record, text: "Merged in #12.", caller: writer, notes, now }),
    );
    expect(revised.record.status).toBe("pending");
    const approved = approveEdited(revised.record, "Merged in #12.", now).record;
    expect(approved.approvedText).toBeNull();
    const reopened = Result.getOrThrow(reopenDraft(approved, ownerApp, now));
    expect(reopened.record.status).toBe("pending");
    expect(Result.isFailure(reopenDraft(approved, writer.provenance, now))).toBe(true);
  });

  it("examples prefer the same person and use the approved text", () => {
    const first = approveEdited(pending(), "Merged.", "2026-10-17T11:00:00.000Z").record;
    const other = approveEdited(
      Result.getOrThrow(submit({ audience: "Lee", text: "Hello Lee, all done" })).record,
      "Done.",
      "2026-10-17T12:00:00.000Z",
    ).record;
    const examples = draftExamples({ missionId, channel: "cliq", audience: "Sami" }, [
      other,
      first,
    ]);
    expect(examples.map((example) => example.text)).toEqual(["Merged.", "Done."]);
    expect(examples[0]?.edited).toBe(true);
  });
});

describe("draft notes", () => {
  it("only the owner writes notes and duplicates are refused", () => {
    const base = {
      id: DraftNoteId.make("n-new"),
      existing: null,
      missionId: null,
      scope: { _tag: "channel", channel: "cliq" } as const,
      text: "No opener.",
      active: true,
      source: "owner" as const,
      notes,
      now,
    };
    expect(Result.isFailure(saveDraftNote({ ...base, provenance: writer.provenance }))).toBe(true);
    const saved = Result.getOrThrow(saveDraftNote({ ...base, provenance: ownerApp }));
    expect(saved.events[0]?.kind).toBe("draft-note.updated");
    expect(saved.events[0]?.payload).toMatchObject({ action: "created" });
    const dup = saveDraftNote({
      ...base,
      id: DraftNoteId.make("n-dup"),
      notes: [...notes, saved.record],
      provenance: ownerApp,
    });
    expect(Result.isFailure(dup) && dup.failure.code).toBe("conflict");
    const retired = Result.getOrThrow(
      saveDraftNote({ ...base, existing: saved.record, active: false, provenance: ownerApp }),
    );
    expect(retired.events[0]?.payload).toMatchObject({ action: "retired" });
  });
});

describe("edit learning", () => {
  it("diffs words and names the edit patterns", () => {
    const before = "Hi Sami, hope you're well! The fix is merged. Thanks!";
    const after = "The fix is merged.";
    expect(renderWordDiff(wordDiff("a b c", "a c d"))).toBe("a [-b-] c {+d+}");
    expect(editPatterns(before, after)).toEqual(
      expect.arrayContaining(["removed-opener", "removed-exclamations"]),
    );
    expect(editPatterns("The fix is merged.", "The fix is merged in #12.")).toEqual([]);
  });

  const editedDrafts = (count: number, channel: Draft["channel"] = "cliq") =>
    Array.from(
      { length: count },
      (_, index) =>
        approveEdited(
          Result.getOrThrow(
            submit({
              channel,
              text: `Hi Sami, hope you're well. Update ${index}: the fix is merged.`,
              notes: [],
            }),
          ).record,
          `Update ${index}: the fix is merged.`,
          `2026-10-17T1${index}:00:00.000Z`,
        ).record,
    );

  it("waits for the pattern to repeat, then proposes a channel note as an owner-corrections suggestion", () => {
    const base = { missionId, notes: [], suggestions: [] };
    expect(learnFromEdits({ ...base, drafts: editedDrafts(2) })).toEqual([]);
    const proposals = learnFromEdits({ ...base, drafts: editedDrafts(3) });
    const opener = proposals.find((proposal) => proposal.title.includes("No opener"));
    expect(opener).toMatchObject({
      targetKind: "draft-note",
      target: null,
      acceptor: "owner",
      after: { scope: { _tag: "channel", channel: "cliq" }, text: EDIT_NOTE },
    });
    expect(opener?.evidence).toHaveLength(3);
    expect(opener?.why).toContain("3");
  });

  it("skips patterns an active note already covers or an open suggestion already proposes", () => {
    const drafts = editedDrafts(3);
    const covering = note({
      id: DraftNoteId.make("n-opener"),
      scope: { _tag: "channel", channel: "cliq" },
      text: EDIT_NOTE,
    });
    expect(
      learnFromEdits({ missionId, drafts, notes: [covering], suggestions: [] }).some((p) =>
        p.title.includes("No opener"),
      ),
    ).toBe(false);
    const open = openSuggestion(drafts);
    expect(
      learnFromEdits({ missionId, drafts, notes: [], suggestions: [open] }).some((p) =>
        p.title.includes("No opener"),
      ),
    ).toBe(false);
  });

  it("accepting the suggestion writes the note with the owner's provenance; nothing self-applies", () => {
    const open = openSuggestion(editedDrafts(3));
    expect(open.status).toBe("open");
    const decision = Result.getOrThrow(
      decideSuggestion({
        suggestion: open,
        input: { suggestionId: open.id, action: "accept" },
        caller: owner,
        callerIsMaster: false,
        now,
      }),
    );
    const applied = Result.getOrThrow(
      draftNoteFromSuggestion({
        id: DraftNoteId.make("n-learned"),
        after: decision.apply?.after,
        target: decision.apply?.target ?? null,
        provenance: ownerApp,
        notes: [],
        now,
      }),
    );
    expect(applied.record).toMatchObject({ text: EDIT_NOTE, source: "suggestion", active: true });
    const agentApply = draftNoteFromSuggestion({
      id: DraftNoteId.make("n-agent"),
      after: decision.apply?.after,
      target: null,
      provenance: editorCaller.provenance,
      notes: [],
      now,
    });
    expect(Result.isFailure(agentApply)).toBe(true);
  });
});

const EDIT_NOTE = "No opener or pleasantry; start with the point.";

const openSuggestion = (drafts: ReadonlyArray<Draft>): Suggestion => {
  const proposal = learnFromEdits({ missionId, drafts, notes: [], suggestions: [] }).find((p) =>
    p.title.includes("No opener"),
  );
  if (proposal === undefined) throw new Error("expected an opener proposal");
  return Result.getOrThrow(
    proposeSuggestion({
      id: SuggestionId.make(`s-${++counter}`),
      proposal,
      author: "owner-corrections",
      caller: editorCaller,
      existing: [],
      now,
    }),
  ).record;
};
