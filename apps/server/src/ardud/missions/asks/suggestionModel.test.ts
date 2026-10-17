import {
  MissionId,
  RoleId,
  SuggestionId,
  ThreadId,
  type MissionProvenance,
  type Suggestion,
  type SuggestionAuthor,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Result from "effect/Result";

import {
  barFor,
  decideSuggestion,
  proposeSuggestion,
  reopenSuggestion,
  suggestionStats,
  type ProposeSuggestionCommand,
  type SuggestionProposal,
} from "./suggestionModel.ts";
import type { MissionCaller } from "./shared.ts";

const now = "2026-10-17T10:00:00.000Z";
const ownerApp: MissionProvenance = { _tag: "owner-app", surface: "web", sessionId: "s" };
const owner: MissionCaller = { provenance: ownerApp, actors: [{ _tag: "owner" }] };
const masterRole = RoleId.make("role-master");
const master: MissionCaller = {
  provenance: { _tag: "agent", threadId: ThreadId.make("t-master"), roleId: masterRole },
  actors: [{ _tag: "role", roleId: masterRole }],
};
const editor: MissionCaller = {
  provenance: { _tag: "system", component: "editor" },
  actors: [{ _tag: "system", component: "editor" }],
};

const proposal = (overrides: Partial<SuggestionProposal> = {}): SuggestionProposal => ({
  missionId: MissionId.make("m1"),
  targetKind: "rule",
  target: { kind: "rule", id: "rule-1" },
  title: "Tighten the review rule",
  before: { quote: "review PRs" },
  after: { quote: "review PRs before merge" },
  diffText: "- review PRs\n+ review PRs before merge",
  why: "Two merges skipped review",
  evidence: [{ kind: "note", id: "note-1" }],
  acceptor: "owner",
  ...overrides,
});

let counter = 0;
const propose = (overrides: Partial<ProposeSuggestionCommand> = {}) =>
  proposeSuggestion({
    id: SuggestionId.make(`s-${++counter}`),
    proposal: proposal(),
    author: "editor",
    caller: editor,
    existing: [],
    now,
    ...overrides,
  });

const decided = (
  author: SuggestionAuthor,
  status: Suggestion["status"],
  index: number,
): Suggestion => ({
  ...Result.getOrThrow(propose({ author, proposal: proposal({ after: { n: index } }) })).record,
  status,
});

const code = (outcome: Result.Result<unknown, { readonly code: string }>) =>
  Result.isFailure(outcome) ? outcome.failure.code : "ok";

describe("suggestion stats and bar", () => {
  it("keeps the bar normal until enough are decided, then raises it on low acceptance", () => {
    expect(barFor(0, 4)).toBe("normal");
    expect(barFor(0, 5)).toBe("high");
    expect(barFor(1, 4)).toBe("raised");
    expect(barFor(2, 3)).toBe("normal");
  });

  it("counts per author and target kind, edits as accepted", () => {
    const records = [
      decided("editor", "accepted", 1),
      decided("editor", "edited", 2),
      decided("editor", "dismissed", 3),
      decided("editor", "open", 4),
      decided("scribe", "dismissed", 5),
    ];
    expect(suggestionStats(records)).toEqual([
      { author: "editor", targetKind: "rule", shown: 4, accepted: 2, dismissed: 1, bar: "normal" },
      { author: "scribe", targetKind: "rule", shown: 1, accepted: 0, dismissed: 1, bar: "normal" },
    ]);
  });

  it("an author with mostly dismissed suggestions must bring more evidence and gets fewer open", () => {
    const history = [1, 2, 3, 4, 5, 6].map((index) => decided("editor", "dismissed", index));
    const thin = propose({ existing: history });
    expect(code(thin)).toBe("invalid");
    const strong = propose({
      existing: history,
      proposal: proposal({
        evidence: [
          { kind: "note", id: "n1" },
          { kind: "note", id: "n2" },
          { kind: "note", id: "n3" },
        ],
      }),
    });
    const first = Result.getOrThrow(strong).record;
    const second = propose({
      existing: [...history, first],
      proposal: proposal({
        after: { other: true },
        evidence: [
          { kind: "note", id: "n1" },
          { kind: "note", id: "n2" },
          { kind: "note", id: "n3" },
        ],
      }),
    });
    expect(code(second)).toBe("conflict");
    // Another author is unaffected by the editor's record.
    expect(code(propose({ author: "scribe", existing: history }))).toBe("ok");
  });

  it("refuses an identical open suggestion", () => {
    const first = Result.getOrThrow(propose()).record;
    expect(code(propose({ existing: [first], author: "scribe" }))).toBe("conflict");
  });
});

describe("deciding suggestions", () => {
  const open = (acceptor: Suggestion["acceptor"], author: SuggestionAuthor = "editor") =>
    Result.getOrThrow(propose({ author, proposal: proposal({ acceptor, after: { a: counter } }) }))
      .record;

  it("nothing self-applies: proposing produces no application", () => {
    const outcome = Result.getOrThrow(propose());
    expect(outcome.record.status).toBe("open");
    expect(outcome.events.map((event) => event.kind)).toEqual(["suggestion.opened"]);
  });

  it("owner accepts; the decision carries the change for the owning service", () => {
    const suggestion = open("owner");
    const outcome = Result.getOrThrow(
      decideSuggestion({
        suggestion,
        input: { suggestionId: suggestion.id, action: "accept" },
        caller: owner,
        callerIsMaster: false,
        now,
      }),
    );
    expect(outcome.record.status).toBe("accepted");
    expect(outcome.apply?.after).toEqual(suggestion.after);
    expect(outcome.record.decidedBy).toEqual(ownerApp);
  });

  it("accept edited applies the edit and keeps the original in the event", () => {
    const suggestion = open("owner");
    const outcome = Result.getOrThrow(
      decideSuggestion({
        suggestion,
        input: {
          suggestionId: suggestion.id,
          action: "accept-edited",
          editedAfter: { quote: "x" },
        },
        caller: owner,
        callerIsMaster: false,
        now,
      }),
    );
    expect(outcome.record.status).toBe("edited");
    expect(outcome.apply?.after).toEqual({ quote: "x" });
    expect(outcome.events[0]?.payload).toMatchObject({ proposedAfter: suggestion.after });
    expect(
      code(
        decideSuggestion({
          suggestion,
          input: { suggestionId: suggestion.id, action: "accept-edited" },
          caller: owner,
          callerIsMaster: false,
          now,
        }),
      ),
    ).toBe("invalid");
  });

  it("agents cannot decide owner suggestions; the master decides master ones but never its own", () => {
    const ownerOnly = open("owner");
    expect(
      code(
        decideSuggestion({
          suggestion: ownerOnly,
          input: { suggestionId: ownerOnly.id, action: "accept" },
          caller: master,
          callerIsMaster: true,
          now,
        }),
      ),
    ).toBe("provenance-required");
    const forMaster = open("master", "governor");
    expect(
      code(
        decideSuggestion({
          suggestion: forMaster,
          input: { suggestionId: forMaster.id, action: "accept" },
          caller: master,
          callerIsMaster: true,
          now,
        }),
      ),
    ).toBe("ok");
    expect(
      code(
        decideSuggestion({
          suggestion: forMaster,
          input: { suggestionId: forMaster.id, action: "accept" },
          caller: editor,
          callerIsMaster: false,
          now,
        }),
      ),
    ).toBe("forbidden");
    expect(
      code(
        propose({
          author: "master",
          caller: master,
          proposal: proposal({ acceptor: "master" }),
        }),
      ),
    ).toBe("invalid");
  });

  it("dismissal records the reason; the owner can reopen it", () => {
    const suggestion = open("owner");
    const dismissed = Result.getOrThrow(
      decideSuggestion({
        suggestion,
        input: { suggestionId: suggestion.id, action: "dismiss", dismissReason: "Not now" },
        caller: owner,
        callerIsMaster: false,
        now,
      }),
    );
    expect(dismissed.apply).toBeNull();
    expect(dismissed.record.dismissReason).toBe("Not now");
    expect(code(reopenSuggestion(dismissed.record, master.provenance, now))).toBe(
      "provenance-required",
    );
    expect(Result.getOrThrow(reopenSuggestion(dismissed.record, ownerApp, now)).record.status).toBe(
      "open",
    );
  });
});
