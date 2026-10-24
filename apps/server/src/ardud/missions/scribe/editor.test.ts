import { describe, expect, it } from "@effect/vitest";

import type { Lane, Note, Rule, Suggestion } from "@t3tools/contracts";

import type { ScribeCandidate } from "./batch.ts";
import {
  buildEditorInput,
  checkEditorOutput,
  EDITOR_LIMITS,
  type EditorSource,
  readEditorState,
} from "./editor.ts";
import { LANE_THREAD, lane, mission, MISSION_ID } from "./testFixtures.ts";

const NOW = "2026-10-17T12:00:00.000Z";
const SINCE = "2026-10-17T11:00:00.000Z";

const note = (id: string, overrides: Record<string, unknown> = {}): Note =>
  ({
    id,
    missionId: MISSION_ID,
    subMissionId: null,
    laneId: "lane-money",
    type: "risk",
    summary: `Note ${id}`,
    sources: [{ threadId: LANE_THREAD, quote: `quote for ${id}`, fromEvent: 1, toEvent: 1 }],
    basis: "claimed",
    severity: "medium",
    confidence: 0.7,
    author: "scribe",
    citation: "verified",
    evidence: "not-applicable",
    evidenceLinks: [],
    replacesNoteId: null,
    ackedBy: [],
    createdAt: "2026-10-17T11:30:00.000Z",
    ...overrides,
  }) as unknown as Note;

const candidate = (id: string, overrides: Partial<ScribeCandidate> = {}): ScribeCandidate => ({
  id,
  missionId: MISSION_ID,
  laneId: "lane-money",
  threadId: LANE_THREAD,
  targetKind: "rule",
  title: "Say which env a deploy targets",
  proposal: "Every deploy request names the env.",
  why: "The owner corrected an unnamed deploy twice.",
  quote: "which env did you mean, dev or staging?",
  event: 2000003,
  citation: "verified",
  createdAt: "2026-10-17T11:40:00.000Z",
  ...overrides,
});

const rule = {
  id: "rule-12",
  missionId: MISSION_ID,
  number: 12,
  title: "Deploys need a claim",
  status: "active",
  updatedAt: "2026-10-10T00:00:00.000Z",
} as unknown as Rule;

const dismissed = {
  id: "sugg-old",
  missionId: MISSION_ID,
  targetKind: "lane",
  target: { kind: "lane", id: "lane-money" },
  title: "Split the money lane into rewards and balances",
  status: "dismissed",
  dismissReason: "one lead is enough",
  acceptor: "master",
} as unknown as Suggestion;

const source = (overrides: Partial<EditorSource> = {}): EditorSource => ({
  mission,
  now: NOW,
  since: SINCE,
  previousBottomLine: null,
  lanes: [lane as unknown as Lane],
  asks: [],
  approvals: [],
  calls: [],
  workItems: [],
  milestones: [],
  notes: [
    note("note-a"),
    note("note-b", { type: "owner-must-know", severity: "high" }),
    // Older than the window and a failed citation: neither is shown.
    note("note-old", { createdAt: "2026-10-17T09:00:00.000Z" }),
    note("note-bad", { citation: "failed" }),
  ],
  candidates: [
    candidate("cand-env"),
    candidate("cand-split", { targetKind: "lane", title: "Split money lane" }),
  ],
  suggestions: [dismissed],
  rules: [rule],
  roles: [],
  ...overrides,
});

describe("editor input", () => {
  it("shows only current verified notes from the window, strongest first", () => {
    const input = buildEditorInput(source());
    expect(input.notes.map((shown) => shown.id)).toEqual(["note-b", "note-a"]);
    expect(input.candidates.map((shown) => shown.source)).toEqual([
      `${LANE_THREAD}#2000003`,
      `${LANE_THREAD}#2000003`,
    ]);
    expect(input.targets.map((target) => target.ref)).toEqual([
      `mission:${MISSION_ID}`,
      "rule:rule-12",
      "lane:lane-money",
    ]);
    expect(input.suggestions.map((shown) => shown.status)).toEqual(["dismissed"]);
  });

  it("leaves out notes the master or the owner acked as handled", () => {
    const roles = [{ id: "crpko:master", kind: "master" }] as unknown as EditorSource["roles"];
    const input = buildEditorInput(
      source({
        mission: { ...mission, masterRoleId: "crpko:master" } as EditorSource["mission"],
        roles,
        notes: [
          note("note-open"),
          note("note-master", {
            type: "owner-must-know",
            severity: "critical",
            ackedBy: [{ _tag: "role", roleId: "crpko:master" }],
          }),
          note("note-owner", { severity: "high", ackedBy: [{ _tag: "owner" }] }),
          // A lane role's ack (not possible today) doesn't count as handled.
          note("note-lane", { ackedBy: [{ _tag: "role", roleId: "crpko:lane-lead" }] }),
        ],
      }),
    );
    expect(input.notes.map((shown) => shown.id)).toEqual(["note-open", "note-lane"]);

    // The editor can't bring an acked note back: fyiOrder and the feed drop it.
    const plan = checkEditorOutput(
      {
        bottomLine: "One risk is open.",
        fyiOrder: ["note-master", "note-owner", "note-open"],
        feed: [
          { kind: "note", summary: "Handled already", ref: "note:note-master" },
          { kind: "note", summary: "Still open", ref: "note:note-open" },
        ],
        suggestions: [],
      },
      input,
    );
    expect(plan.fyiOrder).toEqual(["note-open"]);
    expect(plan.feed.map((item) => item.ref?.id)).toEqual(["note-open"]);
  });
});

describe("editor output check", () => {
  const input = buildEditorInput(source());

  it("keeps known notes and refs, drops anything the editor wasn't shown", () => {
    const plan = checkEditorOutput(
      {
        bottomLine: "Money lane is close; one deploy question is open.",
        fyiOrder: ["note-a", "note-ghost", "note-a", "note-old"],
        feed: [
          { kind: "note", summary: "Risk on the money lane", ref: "note:note-a" },
          { kind: "shipped", summary: "Shipped something", ref: "work-item:nope" },
        ],
        suggestions: [],
      },
      input,
    );
    expect(plan.bottomLine).toBe("Money lane is close; one deploy question is open.");
    expect(plan.fyiOrder).toEqual(["note-a"]);
    expect(plan.feed).toEqual([
      {
        kind: "note",
        summary: "Risk on the money lane",
        ref: { kind: "note", id: "note-a" },
        at: "2026-10-17T11:30:00.000Z",
      },
    ]);
    expect(plan.rejected).toEqual([
      "fyi: unknown note note-ghost",
      "fyi: unknown note note-old",
      "feed: work-item:nope not shown to the editor",
    ]);
  });

  it("routes suggestions by target kind, cites evidence and refuses repeats", () => {
    const plan = checkEditorOutput(
      {
        bottomLine: "ok",
        suggestions: [
          {
            targetKind: "rule",
            target: "rule:rule-12",
            title: "Deploy requests name the env",
            change: "Add: every deploy request says dev or staging.",
            why: "Two corrections from the owner today.",
            fromCandidates: ["cand-env"],
            evidenceNoteIds: ["note-b", "note-ghost"],
          },
          {
            targetKind: "lane",
            target: "lane:lane-money",
            title: "Split the money lane into rewards and balances lanes",
            change: "Two lanes.",
            why: "Busy.",
            fromCandidates: ["cand-split"],
          },
          {
            targetKind: "role",
            title: "Give the reviewer more context",
            change: "Attach the brief.",
            why: "Reviewer asked twice.",
          },
          { targetKind: "pool", title: "", change: "x", why: "y", fromCandidates: ["cand-env"] },
        ],
      },
      input,
    );
    expect(plan.suggestions).toHaveLength(1);
    const [rulePlan] = plan.suggestions;
    expect(rulePlan?.acceptor).toBe("owner");
    expect(rulePlan?.target).toEqual({ kind: "rule", id: "rule-12" });
    expect(rulePlan?.candidateIds).toEqual(["cand-env"]);
    expect(rulePlan?.evidence).toEqual([
      { kind: "note", id: "note-b" },
      {
        kind: "transcript",
        label: "which env did you mean, dev or staging?",
        url: null,
        ref: `${LANE_THREAD}#2000003`,
      },
    ]);
    // The split repeats a dismissed suggestion: refused, and its candidate is dropped.
    expect(plan.droppedCandidates).toEqual([
      { id: "cand-split", reason: "repeats a dismissed suggestion" },
    ]);
    expect(plan.rejected).toEqual([
      "suggestion: Split the money lane into rewards and balances lanes repeats a dismissed suggestion",
      "suggestion: Give the reviewer more context cites no candidate or note it was shown",
      "suggestion: (untitled) is missing target kind, change or why",
    ]);
  });

  it("caps new suggestions per pass and holds owner ones when the owner has enough open", () => {
    const many = [
      "Reviewer reads the brief first",
      "Writer drafts Linear comments",
      "Verifier checks deploy digests",
      "Answerer handles dev questions",
      "Scribe skips heartbeat runs",
    ].map((title) => ({
      targetKind: "role",
      title,
      change: "c",
      why: "w",
      evidenceNoteIds: ["note-a"],
    }));
    const capped = checkEditorOutput({ bottomLine: "ok", suggestions: many }, input);
    expect(capped.suggestions).toHaveLength(EDITOR_LIMITS.suggestions);
    expect(capped.suggestions.every((planned) => planned.acceptor === "master")).toBe(true);

    const full = checkEditorOutput(
      {
        bottomLine: "ok",
        suggestions: [
          {
            targetKind: "rule",
            title: "New rule",
            change: "c",
            why: "w",
            evidenceNoteIds: ["note-a"],
          },
        ],
      },
      { ...input, ownerOpenSuggestions: EDITOR_LIMITS.ownerOpen },
    );
    expect(full.suggestions).toEqual([]);
    expect(full.rejected).toEqual([
      `suggestion: New rule waits, owner already has ${EDITOR_LIMITS.ownerOpen} open`,
    ]);
  });

  it("a missing bottom line is reported, and stored state reads back defensively", () => {
    const plan = checkEditorOutput({ fyiOrder: ["note-b"] }, input);
    expect(plan.bottomLine).toBeNull();
    expect(plan.rejected).toContain("bottom line missing");

    expect(readEditorState(null)).toEqual({
      bottomLine: null,
      bottomLineAt: null,
      fyiOrder: [],
      feed: [],
      since: null,
      model: null,
      rejected: [],
    });
    expect(
      readEditorState({ bottomLine: "x", fyiOrder: ["a", 3], feed: [{ kind: "bogus" }] }),
    ).toMatchObject({ bottomLine: "x", fyiOrder: ["a"], feed: [] });
  });
});
