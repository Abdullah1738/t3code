import { describe, expect, it } from "@effect/vitest";

import type { Approval, Ask, Call, Note, WorkItem } from "@t3tools/contracts";

import { lane, mission, MISSION_ID, LANE_THREAD } from "./testFixtures.ts";
import { buildDaily, buildUpdate, type ReportInput, resolveOpenItem } from "./reports.ts";

type Loose<T> = { readonly [K in keyof T]?: unknown };

const note = (overrides: Loose<Note> & Pick<Note, "type" | "summary"> & { id: string }): Note =>
  ({
    missionId: MISSION_ID,
    subMissionId: null,
    laneId: "lane-money",
    sources: [{ threadId: LANE_THREAD, quote: "rewards #223 is merged", fromEvent: 1, toEvent: 2 }],
    basis: "observed",
    severity: "medium",
    confidence: 0.8,
    author: "scribe",
    citation: "verified",
    evidence: "not-applicable",
    evidenceLinks: [],
    replacesNoteId: null,
    ackedBy: [],
    createdAt: "2026-10-17T06:00:00.000Z",
    ...overrides,
  }) as unknown as Note;

const openAsk = {
  id: "ask-kafka",
  missionId: MISSION_ID,
  subMissionId: null,
  askedBy: { _tag: "lane", laneId: "lane-money" },
  question: "Run Kafka phase 2 today?",
  context: "",
  options: [
    { id: "yes", label: "Yes, at 11:00", detail: "" },
    { id: "no", label: "Wait for Monday", detail: "" },
  ],
  recommendation: { optionId: "yes", reason: "the fix is merged" },
  blocks: [{ kind: "work-item", id: "work-kafka" }],
  costOfWaiting: "",
  urgency: "normal",
  status: "open",
  answer: null,
  createdAt: "2026-10-17T05:00:00.000Z",
  updatedAt: "2026-10-17T05:00:00.000Z",
} as unknown as Ask;

const answeredAsk = {
  ...openAsk,
  id: "ask-wording",
  question: "Approve the failed-withdrawal wording?",
  status: "answered",
  answer: {
    optionId: "yes",
    text: "keep it",
    provenance: { _tag: "owner-app", surface: "web", sessionId: null },
    answeredAt: "2026-10-17T05:06:00.000Z",
  },
} as unknown as Ask;

const masterCall = {
  id: "call-split",
  missionId: MISSION_ID,
  subMissionId: null,
  decidedBy: { _tag: "role", roleId: "role-master" },
  title: "Split rewards #223",
  decision: "Ship without the redelivery step",
  reason: "Monday target",
  alternatives: [],
  reversible: true,
  subject: null,
  ownerReaction: null,
  createdAt: "2026-10-17T06:30:00.000Z",
} as unknown as Call;

const approval = {
  id: "approval-risk",
  missionId: MISSION_ID,
  kind: "deploy",
  title: "Risk startup fix",
  detail: "",
  requestedBy: "crw",
  links: [],
  status: "pending",
  staleReason: null,
  decidedBy: null,
  decidedAt: null,
  createdAt: "2026-10-17T07:00:00.000Z",
} as unknown as Approval;

const work = (overrides: Loose<WorkItem> & { id: string; title: string }): WorkItem =>
  ({
    missionId: MISSION_ID,
    subMissionId: null,
    laneId: "lane-money",
    milestoneId: null,
    kind: "pr",
    stage: "review",
    heldBy: null,
    blockedBy: [],
    dependsOn: [],
    pullRequest: null,
    links: [],
    facts: { mergedAtHead: null, deployedReadback: null, exercised: null },
    createdAt: "2026-10-17T01:00:00.000Z",
    updatedAt: "2026-10-17T06:00:00.000Z",
    ...overrides,
  }) as unknown as WorkItem;

const base: ReportInput = {
  kind: "update",
  from: "2026-10-17T04:00:00.000Z",
  to: "2026-10-17T08:00:00.000Z",
  mission,
  subMissions: [],
  milestones: [],
  lanes: [lane],
  asks: [openAsk, answeredAsk],
  calls: [masterCall],
  approvals: [approval],
  workItems: [
    work({
      id: "work-bo",
      title: "Back office campaign checks",
      stage: "readback",
      updatedAt: "2026-10-17T07:07:00.000Z",
      facts: { mergedAtHead: "abc", deployedReadback: "docs119-dev.3", exercised: null },
    }),
    work({
      id: "work-rewards",
      title: "Rewards #223",
      stage: "merge",
      updatedAt: "2026-10-17T04:45:00.000Z",
      facts: { mergedAtHead: "def", deployedReadback: null, exercised: null },
    }),
    work({
      id: "work-kafka",
      title: "Kafka phase 2",
      stage: "deploy",
      heldBy: { _tag: "owner" },
      blockedBy: [{ kind: "ask", id: "ask-kafka", label: "your Kafka answer" }],
    }),
  ],
  notes: [
    note({
      id: "note-owner",
      type: "owner-must-know",
      summary: "The ingestor release was rolled back after max query size errors",
      severity: "high",
    }),
    note({
      id: "note-claim",
      type: "claim-of-done",
      summary: "Lane says rewards #223 is deployed",
      basis: "claimed",
      evidence: "mismatch",
      evidenceLinks: [{ kind: "pull-request", label: "rewards#223 open", url: null, ref: null }],
    }),
    note({
      id: "note-low",
      type: "assumption",
      summary: "Assumes dev data is fresh",
      severity: "low",
    }),
    note({
      id: "note-failed",
      type: "risk",
      summary: "Paraphrased risk",
      citation: "failed",
    }),
    note({
      id: "note-old",
      type: "blocker",
      summary: "Old note outside the window",
      createdAt: "2026-10-16T20:00:00.000Z",
    }),
  ],
  suggestions: [],
  events: [],
  previous: {
    coversTo: "2026-10-17T04:00:00.000Z",
    open: [
      { ref: "ask:ask-wording", label: "Withdrawal wording", since: "2026-10-17T03:00:00.000Z" },
      { ref: "ask:ask-kafka", label: "Kafka phase 2 go", since: "2026-10-17T03:00:00.000Z" },
      { ref: "note:note-gone", label: "Something removed.", since: "2026-10-17T03:00:00.000Z" },
    ],
  },
  updates: [],
  bottomLine: null,
  usage: {
    batches: 3,
    notes: 6,
    verified: 5,
    failed: 1,
    citationPassRate: 5 / 6,
    mismatch: 1,
    inputTokens: 40_000,
    outputTokens: 6_000,
  },
};

const headings = (text: string, pattern: RegExp) =>
  text
    .split("\n")
    .filter((line) => pattern.test(line))
    .map((line) => line.match(pattern)?.[1] ?? line);

describe("4h owner update", () => {
  const report = buildUpdate(base);

  it("has the OWNER-UPDATES sections in order", () => {
    expect(
      report.text.startsWith("### 2026-10-17 08:00 UTC\n\n_Covers 04:00 to 08:00 UTC (17 Oct)."),
    ).toBe(true);
    expect(headings(report.text, /^\*\*([^*]+)\*\*/)).toEqual([
      "Short version:",
      "Your decisions since 04:00:",
      "Shipped since 04:00:",
      "Merged since 04:00 (1):",
      "Worth knowing (from the lanes):",
      "Left hanging from 04:00:",
      "Needs you:",
      "Every lane:",
      "Doesn't add up:",
    ]);
    expect(report.text).toContain("#### Usage");
    expect(report.text).toContain("citation pass rate 83%");
  });

  it("fills sections from records and verified notes only", () => {
    const text = report.text;
    expect(text).toContain("- Approve the failed-withdrawal wording? Yes, at 11:00: keep it.");
    expect(text).toContain("- 07:07 Back office campaign checks (Money, readback).");
    expect(text).toContain("- 04:45 Rewards #223 (Money).");
    expect(text).toContain("The ingestor release was rolled back after max query size errors.");
    expect(text).not.toContain("Paraphrased risk");
    expect(text).not.toContain("Old note outside the window");
    expect(text).toContain("1 scribe note(s) failed their citation check");
    expect(text).toContain(
      '**Money:** says "rewards #223 is merged" but the record shows otherwise (rewards#223 open).',
    );
    // Needs you: oldest first, with wait age.
    const needs = text.slice(text.indexOf("**Needs you:**"), text.indexOf("**Every lane:**"));
    expect(needs.indexOf("Run Kafka phase 2 today?")).toBeLessThan(
      needs.indexOf("Risk startup fix"),
    );
    expect(needs).toContain("Waiting 3h, holds 1 item(s). Recommended: Yes, at 11:00.");
    expect(text).toContain("Waiting on others: you (Kafka phase 2).");
  });

  it("closes out what the previous update left open", () => {
    expect(report.text).toContain("- **Withdrawal wording:** **Done.** Answered: keep it.");
    expect(report.text).toContain("- **Kafka phase 2 go:** **Still open** (waiting 5h).");
    expect(report.text).toContain("- **Something removed:** **Gone from the records.**");
  });

  it("leaves open the items the next update must close", () => {
    expect(report.open.map((item) => item.ref)).toEqual([
      "ask:ask-kafka",
      "approval:approval-risk",
      "note:note-owner",
      "note:note-claim",
      "note:note-old",
      "work-item:work-kafka",
    ]);
  });

  it("uses the editor's bottom line when it was written in the window", () => {
    const withEditor = buildUpdate({
      ...base,
      bottomLine: { text: "Quiet morning, one rollback", at: "2026-10-17T07:30:00.000Z" },
    });
    expect(withEditor.text).toContain("**Short version:** Quiet morning, one rollback.");
    expect(report.text).toContain(
      "**Short version:** 1 shipped, 1 of your decisions recorded, 2 waiting on you, 1 blocked.",
    );
  });

  it("resolves a note replaced by a newer one as updated", () => {
    const replaced = {
      ...base,
      notes: [
        ...base.notes,
        note({
          id: "note-new",
          type: "blocker",
          summary: "Now unblocked",
          replacesNoteId: "note-old",
        }),
      ],
    } as ReportInput;
    expect(resolveOpenItem(replaced, { ref: "note:note-old", label: "x", since: base.from })).toBe(
      "**Updated.** Now unblocked.",
    );
  });
});

describe("daily summary", () => {
  const daily = buildDaily({
    ...base,
    kind: "daily",
    from: "2026-10-16T08:00:00.000Z",
    previous: null,
    updates: [
      {
        coversTo: "2026-10-17T04:00:00.000Z",
        open: [{ ref: "ask:ask-wording", label: "Withdrawal wording", since: base.from }],
      },
      {
        coversTo: "2026-10-17T08:00:00.000Z",
        open: [{ ref: "approval:approval-risk", label: "Risk startup fix", since: base.from }],
      },
    ],
  });

  it("has the brief cards, the DETAIL marker and the detail sections in order", () => {
    expect(headings(daily.text, /^## (.+)$/)).toEqual([
      "Bottom line",
      "Decide",
      "You asked",
      "Direction check",
      "Blocking the swarm",
      "Worth knowing",
      "Shareable progress",
      "Targets",
      "Safe to ignore",
      "Every lane, whole day",
      "Left hanging and how it ended",
      "Scorecards, deferred, usage",
      "Doesn't add up",
    ]);
    const [brief, detail] = daily.text.split("\n<!-- DETAIL -->\n");
    expect(brief).toContain("## Safe to ignore");
    expect(detail).toContain("## Every lane, whole day");
  });

  it("puts open asks in Decide and master calls in Direction check", () => {
    expect(daily.text).toContain(
      "- **Run Kafka phase 2 today?** Options: Yes, at 11:00; Wait for Monday. Recommended: Yes, at 11:00, the fix is merged. Holds 1 item(s) since 05:00Z. Answer in the mission inbox.",
    );
    expect(daily.text).toContain(
      "- Split rewards #223: Ship without the redelivery step. Why: Monday target. Reversible.",
    );
    expect(daily.text).toContain(
      "- **Kafka phase 2:** held by you since 06:00Z; waits on your Kafka answer.",
    );
    expect(daily.text).toContain("Assumes dev data is fresh");
    const shareable = daily.text.slice(
      daily.text.indexOf("## Shareable progress"),
      daily.text.indexOf("## Targets"),
    );
    expect(shareable).toContain("- Back office campaign checks.");
    expect(shareable).not.toContain("Money");
  });

  it("closes out every item the 4h updates left open", () => {
    expect(daily.text).toContain("- **Withdrawal wording:** **Done.** Answered: keep it.");
    expect(daily.text).toContain("- **Risk startup fix:** **Still open**");
    expect(daily.text).toContain("Behind this summary: 2 update(s) at 04:00, 08:00 UTC.");
  });
});
