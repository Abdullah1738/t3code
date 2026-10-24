import {
  DraftId,
  DraftNoteId,
  MissionId,
  RoleId,
  SuggestionId,
  ThreadId,
  type Draft,
  type DraftNote,
  type MissionLink,
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
  draftDecisionNotice,
  draftExamples,
  draftWriter,
  notesFor,
  recordDraftSent,
  reopenDraft,
  reviseDraft,
  saveDraftNote,
  submitDraft,
  withdrawDraft,
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
    source: { kind: "master", ref: null },
    writerRoleId: writerRole,
    caller: writer,
    notes,
    existing: [],
    route: { approver: "owner", routeId: null },
    writtenBy: { roleId: writerRole, model: null },
    now,
    ...overrides,
  });

const pending = () => Result.getOrThrow(submit()).record;

const approveEdited = (draft: Draft, editedText: string, at: string) =>
  Result.getOrThrow(
    decideDraft({
      draft,
      input: { draftId: draft.id, action: "approve", editedText, revision: draft.revision ?? 0 },
      provenance: ownerApp,
      callerIsMaster: false,
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
      callerIsMaster: false,
      now,
    });
    expect(Result.isFailure(agentTry) && agentTry.failure.code).toBe("provenance-required");
    // In the app an approval names the revision the owner read.
    const blind = decideDraft({
      draft,
      input: { draftId: draft.id, action: "approve" },
      provenance: ownerApp,
      callerIsMaster: false,
      now,
    });
    expect(Result.isFailure(blind) && blind.failure.code).toBe("invalid");
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
      callerIsMaster: false,
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
      callerIsMaster: false,
      now,
    });
    expect(Result.isFailure(mismatch) && mismatch.failure.code).toBe("provenance-invalid");
    const okDecision = decideDraft({
      draft,
      input: { draftId: draft.id, action: "approve", inboundId: "guid-1" },
      provenance,
      callerIsMaster: false,
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
      callerIsMaster: false,
      now,
    });
    expect(Result.isFailure(noNote) && noNote.failure.code).toBe("invalid");
    const rewrite = Result.getOrThrow(
      decideDraft({
        draft,
        input: { draftId: draft.id, action: "rewrite", rewriteNote: "Mention the PR" },
        provenance: ownerApp,
        callerIsMaster: false,
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
      reviseDraft({
        draft: rewrite.record,
        text: "Merged in #12.",
        caller: writer,
        notes,
        now,
      }),
    );
    expect(revised.record.status).toBe("pending");
    expect(revised.record.previousText).toBe(rewrite.record.text);
    const approved = approveEdited(revised.record, "Merged in #12.", now).record;
    expect(approved.approvedText).toBeNull();
    const reopened = Result.getOrThrow(reopenDraft(approved, ownerApp, false, now));
    expect(reopened.record.status).toBe("pending");
    expect(Result.isFailure(reopenDraft(approved, writer.provenance, false, now))).toBe(true);
  });

  it("M3: the master reopens a draft the owner decided; approving it again still needs him", () => {
    const master: MissionProvenance = {
      _tag: "agent",
      threadId: ThreadId.make("t-master"),
      roleId: null,
    };
    const approved = approveEdited(pending(), "The fix is merged.", now).record;
    expect(approved.approver).toBe("owner");
    const reopened = Result.getOrThrow(reopenDraft(approved, master, true, now));
    expect(reopened.record.status).toBe("pending");
    expect(reopened.record.revision).toBe(1);
    expect(reopened.events[0]?.actor).toEqual({ _tag: "thread", threadId: "t-master" });

    const again = decideDraft({
      draft: reopened.record,
      input: { draftId: approved.id, action: "approve", revision: 1 },
      provenance: master,
      callerIsMaster: true,
      now,
    });
    expect(Result.isFailure(again) && again.failure.code).toBe("provenance-required");

    const strangerReopen = reopenDraft(approved, writer.provenance, false, now);
    expect(Result.isFailure(strangerReopen) && strangerReopen.failure.code).toBe("forbidden");
  });

  it("the master withdraws an owner-routed draft with a note; reopening clears it", () => {
    const master: MissionProvenance = {
      _tag: "agent",
      threadId: ThreadId.make("t-master"),
      roleId: null,
    };
    const draft = pending();
    expect(draft.approver).toBe("owner");
    const byWriter = withdrawDraft({
      draft,
      provenance: writer.provenance,
      callerIsMaster: false,
      note: "Old news",
      now,
    });
    expect(Result.isFailure(byWriter) && byWriter.failure.code).toBe("forbidden");

    const withdrawn = Result.getOrThrow(
      withdrawDraft({
        draft,
        provenance: master,
        callerIsMaster: true,
        note: "Sami already knows",
        now,
      }),
    );
    expect(withdrawn.record).toMatchObject({
      status: "dropped",
      withdrawNote: "Sami already knows",
      decidedBy: master,
    });
    expect(withdrawn.events[0]).toMatchObject({
      kind: "draft.decided",
      summary: "Withdrawn: Sami already knows: draft for Sami (cliq)",
      payload: { action: "withdraw", note: "Sami already knows", previousStatus: "pending" },
    });
    expect(draftDecisionNotice(withdrawn.record)?.body).toContain("Sami already knows");

    const twice = withdrawDraft({
      draft: withdrawn.record,
      provenance: master,
      callerIsMaster: true,
      note: "again",
      now,
    });
    expect(Result.isFailure(twice) && twice.failure.code).toBe("conflict");

    const reopened = Result.getOrThrow(reopenDraft(withdrawn.record, master, true, now)).record;
    expect(reopened.status).toBe("pending");
    expect(reopened.withdrawNote).toBeNull();
  });

  it("the writer hears the approved text, posts it and records it sent once", () => {
    const master: MissionCaller = {
      provenance: { _tag: "agent", threadId: ThreadId.make("t-master"), roleId: null },
      actors: [{ _tag: "thread", threadId: ThreadId.make("t-master") }],
    };
    const draft = pending();
    expect(draftWriter(draft)).toEqual({ _tag: "role", roleId: writerRole });
    expect(draftDecisionNotice(draft)).toBeNull();
    const send = (on: Draft, caller: MissionCaller, isMaster: boolean, link: MissionLink | null) =>
      recordDraftSent({ draft: on, caller, callerIsMaster: isMaster, link, now });

    const early = send(draft, writer, false, null);
    expect(Result.isFailure(early) && early.failure.code).toBe("conflict");

    const approved = approveEdited(draft, "The fix is merged.", now).record;
    const notice = draftDecisionNotice(approved);
    expect(notice?.summary).toBe("Approved: draft for Sami (cliq)");
    expect(notice?.body).toContain("mission_draft_sent");
    expect(notice?.body.endsWith("\nThe fix is merged.")).toBe(true);

    const byStranger = send(approved, stranger, false, null);
    expect(Result.isFailure(byStranger) && byStranger.failure.code).toBe("forbidden");

    const link: MissionLink = {
      kind: "url",
      label: "Cliq message",
      url: "https://cliq.example/m/1",
      ref: null,
    };
    const sent = Result.getOrThrow(send(approved, writer, false, link));
    expect(sent.record).toMatchObject({ status: "sent", sentAt: now, sentLink: link });
    expect(sent.events[0]).toMatchObject({
      kind: "draft.sent",
      summary: "Sent: draft for Sami (cliq) at Cliq message",
    });

    // The same report again changes nothing; a different post is refused.
    const again = Result.getOrThrow(send(sent.record, master, true, link));
    expect(again.events).toEqual([]);
    const other = send(sent.record, writer, false, { ...link, url: "https://cliq.example/m/2" });
    expect(Result.isFailure(other) && other.failure.code).toBe("conflict");

    // A system's own draft is reported by that system.
    const system = { ...approved, requestedBy: "crw" };
    expect(draftWriter(system)).toBeNull();
    const bySystem = send(system, master, true, link);
    expect(Result.isFailure(bySystem) && bySystem.failure.code).toBe("forbidden");
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

  it("R5: a master's approvals never teach writers the owner's voice", () => {
    const masterProvenance: MissionProvenance = {
      _tag: "agent",
      threadId: ThreadId.make("t-master"),
      roleId: RoleId.make("role-master"),
    };
    const draft: Draft = { ...pending(), approver: "master" };
    const byMaster = Result.getOrThrow(
      decideDraft({
        draft,
        input: {
          draftId: draft.id,
          action: "approve",
          editedText: "Merged, master style.",
          revision: 0,
        },
        provenance: masterProvenance,
        callerIsMaster: true,
        now: "2026-10-17T11:00:00.000Z",
      }),
    ).record;
    expect(byMaster.status).toBe("approved");
    expect(draftExamples({ missionId, channel: "cliq", audience: "Sami" }, [byMaster])).toEqual([]);
  });
});

describe("reply context", () => {
  const comment: MissionLink = {
    kind: "pull-request",
    label: "acme/api#42 comment",
    url: "https://github.com/acme/api/pull/42#issuecomment-1",
    ref: null,
  };
  const replyTo = {
    summary: "  Sami asks whether the retry fix also covers the webhook path.  ",
    quote: " Does this cover webhooks too? ",
    author: " Sami ",
    at: "2026-10-17T09:30:00.000Z",
    link: comment,
  };
  const code = (outcome: { _tag: string; failure?: { code: string } }) =>
    outcome._tag === "Failure" ? outcome.failure?.code : "ok";

  it("stores a trimmed reply context on submit and refuses a bad one", () => {
    const draft = Result.getOrThrow(submit({ inReplyTo: replyTo })).record;
    expect(draft.inReplyTo).toEqual({
      summary: "Sami asks whether the retry fix also covers the webhook path.",
      quote: "Does this cover webhooks too?",
      author: "Sami",
      at: "2026-10-17T09:30:00.000Z",
      link: comment,
    });
    expect(draft.text).toBe("Hi Sami, hope you're well! The fix is merged.");
    expect(Result.getOrThrow(submit({ inReplyTo: replyTo })).events[0]?.payload).toMatchObject({
      inReplyTo: { author: "Sami" },
    });
    expect(Result.getOrThrow(submit()).record.inReplyTo).toBeUndefined();

    expect(code(submit({ inReplyTo: { summary: "   " } }))).toBe("invalid");
    expect(code(submit({ inReplyTo: { summary: "x".repeat(1501) } }))).toBe("invalid");
    expect(code(submit({ inReplyTo: { summary: "ok", quote: "q".repeat(2001) } }))).toBe("invalid");
    expect(code(submit({ inReplyTo: { summary: "ok", at: "yesterday" } }))).toBe("invalid");
    // A time with no zone would read as the reader's local time.
    expect(code(submit({ inReplyTo: { summary: "ok", at: "2026-10-24T09:00" } }))).toBe("invalid");
    expect(code(submit({ inReplyTo: { summary: "ok", at: "2026-10-24T09:00+04:00" } }))).toBe("ok");
    expect(
      code(submit({ inReplyTo: { summary: "x".repeat(1500), quote: "q".repeat(2000) } })),
    ).toBe("ok");
  });

  it("keeps the reply context across revisions unless the writer replaces it", () => {
    const draft = Result.getOrThrow(submit({ inReplyTo: replyTo })).record;
    const revise = (on: Draft, text: string, inReplyTo?: typeof replyTo | { summary: string }) =>
      reviseDraft({
        draft: on,
        text,
        caller: writer,
        notes,
        now: "2026-10-17T11:00:00.000Z",
        ...(inReplyTo === undefined ? {} : { inReplyTo }),
      });

    const kept = Result.getOrThrow(revise(draft, "Yes, webhooks too.")).record;
    expect(kept.text).toBe("Yes, webhooks too.");
    expect(kept.inReplyTo).toEqual(draft.inReplyTo);

    const replaced = Result.getOrThrow(
      revise(kept, "Yes, both paths.", { summary: "Sami asks about both retry paths." }),
    ).record;
    expect(replaced.inReplyTo).toEqual({ summary: "Sami asks about both retry paths." });
    expect(replaced.revision).toBe(2);

    // Same text with a new context only swaps the context and starts a new epoch.
    const contextOnly = Result.getOrThrow(
      revise(replaced, "Yes, both paths.", { summary: "Sami asks about the webhook path." }),
    );
    expect(contextOnly.record).toMatchObject({
      text: "Yes, both paths.",
      status: "pending",
      revision: 3,
      inReplyTo: { summary: "Sami asks about the webhook path." },
      textRevisedAt: replaced.textRevisedAt,
    });
    expect(contextOnly.record.previousText).toBe(replaced.previousText);
    expect(contextOnly.events[0]?.payload).toMatchObject({ replyContextOnly: true });

    // Nothing new at all is still refused.
    expect(code(revise(contextOnly.record, "Yes, both paths."))).toBe("conflict");
    expect(
      code(
        revise(contextOnly.record, "Yes, both paths.", {
          summary: "Sami asks about the webhook path.",
        }),
      ),
    ).toBe("conflict");
    expect(code(revise(contextOnly.record, "Again.", { summary: " " }))).toBe("invalid");
  });

  it("never reaches the writer's posting notice or the approved text", () => {
    const draft = Result.getOrThrow(submit({ inReplyTo: replyTo })).record;
    const approved = approveEdited(draft, draft.text, now).record;
    const notice = draftDecisionNotice(approved);
    expect(notice?.body).not.toContain("webhooks");
    expect(notice?.body).not.toContain("Sami asks");
    expect(approved.approvedText).toBeNull();
    expect(approved.inReplyTo).toEqual(draft.inReplyTo);
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
      callerIsMaster: false,
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
        callerIsMaster: false,
        suggestionMissionId: open.missionId,
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
      callerIsMaster: false,
      suggestionMissionId: open.missionId,
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
