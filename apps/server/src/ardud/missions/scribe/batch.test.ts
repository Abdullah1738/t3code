import { describe, expect, it } from "@effect/vitest";

import { assembleBatch, type ScribeBatchInput, type ScribeNoteDraft } from "./batch.ts";
import { transcriptEvent } from "./transcriptText.ts";

const THREAD = "thread-lane-a";
const NOW = "2026-10-17T10:00:00.000Z";

const events = [
  transcriptEvent({
    threadId: THREAD,
    ordinal: 20,
    type: "assistant_message",
    payload: { text: "Merged rewards#216 at head; the deploy is next once CI is green." },
  }),
  transcriptEvent({
    threadId: THREAD,
    ordinal: 21,
    type: "command_execution",
    payload: {
      input: "gh pr view 216 --repo equicom-crypto/rewards --json state",
      output: '{"state":"OPEN"}',
      exitCode: 0,
    },
  }),
  transcriptEvent({
    threadId: THREAD,
    ordinal: 22,
    type: "assistant_message",
    payload: { text: "Assuming the ledger table is empty on dev, so no backfill needed." },
  }),
];

const draft = (overrides: Partial<ScribeNoteDraft>): ScribeNoteDraft => ({
  type: "assumption",
  summary: "Lane assumes the dev ledger table is empty.",
  quote: "Assuming the ledger table is empty on dev",
  event: 22,
  fromEvent: 22,
  toEvent: 22,
  basis: "claimed",
  severity: "medium",
  confidence: 0.7,
  replaces: null,
  ...overrides,
});

const input = (notes: ReadonlyArray<ScribeNoteDraft>): ScribeBatchInput => ({
  missionId: "mission-crpko",
  laneId: "lane-money",
  subMissionId: null,
  threadId: THREAD,
  fromEvent: 20,
  toEvent: 22,
  notes,
  candidates: [],
  droppedCount: 0,
  usage: { input: 0, output: 0 },
  model: "test",
});

const context = {
  events,
  pullRequests: [
    {
      repository: "equicom-crypto/rewards",
      number: 216,
      url: null,
      state: "open",
      checksState: null,
    },
  ],
  knownNotes: new Map(),
  now: NOW,
};

describe("assembleBatch", () => {
  it("verifies quotes in code and gives the same note the same id", () => {
    const first = assembleBatch(input([draft({})]), context);
    const again = assembleBatch(
      input([draft({ quote: "Assuming  the ledger table\nis empty on dev" })]),
      context,
    );
    expect(first.notes[0]?.citation).toBe("verified");
    expect(first.notes[0]?.evidence).toBe("not-applicable");
    expect(again.notes[0]?.id).toBe(first.notes[0]?.id);
    expect(first.stats).toMatchObject({ notes: 1, verified: 1, failed: 0 });
  });

  it("keeps a paraphrased note but marks the citation failed", () => {
    const result = assembleBatch(
      input([draft({ quote: "The lane assumes dev ledger is empty" })]),
      context,
    );
    expect(result.notes[0]?.citation).toBe("failed");
    expect(result.stats.failures).toEqual({ "quote-not-found": 1 });
  });

  it("flags a claim of done that the PR state contradicts", () => {
    const result = assembleBatch(
      input([
        draft({
          type: "claim-of-done",
          summary: "Lane says rewards#216 is merged.",
          quote: "Merged rewards#216 at head",
          event: 20,
          fromEvent: 20,
          toEvent: 20,
        }),
      ]),
      context,
    );
    expect(result.notes[0]?.citation).toBe("verified");
    expect(result.notes[0]?.evidence).toBe("mismatch");
    expect(result.stats.mismatch).toBe(1);
  });

  it("downgrades observed to claimed unless the quote sits in tool output", () => {
    const result = assembleBatch(input([draft({ basis: "observed" })]), context);
    expect(result.notes[0]?.basis).toBe("claimed");
    const tool = assembleBatch(
      input([
        draft({
          type: "risk",
          quote: '{"state":"OPEN"}',
          summary: "The PR is still open.",
          event: 21,
          fromEvent: 21,
          toEvent: 21,
          basis: "observed",
        }),
      ]),
      context,
    );
    expect(tool.notes[0]?.basis).toBe("observed");
  });

  it("drops a replaces link to an unknown note and keeps a valid one", () => {
    const old = assembleBatch(input([draft({})]), context).notes[0]!;
    const known = new Map([[old.id, old]]);
    const result = assembleBatch(
      input([
        draft({
          type: "risk",
          summary: "Ledger may not be empty after all.",
          quote: "no backfill needed",
          replaces: old.id,
        }),
        draft({
          type: "blocker",
          summary: "x",
          quote: "the deploy is next once CI is green",
          event: 20,
          fromEvent: 20,
          toEvent: 20,
          replaces: "note-missing",
        }),
      ]),
      { ...context, knownNotes: known },
    );
    expect(result.notes[0]?.replacesNoteId).toBe(old.id);
    expect(result.notes[1]?.replacesNoteId).toBeNull();
    expect(result.stats.replaceRejected).toBe(1);
  });

  it("never lets a note with a failed quote replace a verified one", () => {
    const old = assembleBatch(input([draft({})]), context).notes[0]!;
    const result = assembleBatch(
      input([
        draft({
          type: "risk",
          summary: "Made-up follow-up.",
          quote: "the ledger turned out to be full",
          replaces: old.id,
        }),
      ]),
      { ...context, knownNotes: new Map([[old.id, old]]) },
    );
    expect(result.notes[0]?.citation).toBe("failed");
    expect(result.notes[0]?.replacesNoteId).toBeNull();
    expect(result.stats.replaceRejected).toBe(1);
  });
});
