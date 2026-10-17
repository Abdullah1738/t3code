import { describe, expect, it } from "@effect/vitest";

import { checkCitation, checkSource } from "./citation.ts";
import { checkEvidence, extractRefs, pullRequestFacts } from "./evidence.ts";
import { transcriptEvent, type TranscriptEvent } from "./transcriptText.ts";

const THREAD = "thread-lane-a";

const events: ReadonlyArray<TranscriptEvent> = [
  transcriptEvent({
    threadId: THREAD,
    ordinal: 10,
    type: "user_message",
    payload: JSON.stringify({ text: "Master here. Ship CRP-13154 before the dev window closes." }),
  }),
  transcriptEvent({
    threadId: THREAD,
    ordinal: 11,
    type: "assistant_message",
    payload: {
      text: "I'll skip the  migration\n  check for now and merge rewards#216 after review.",
    },
  }),
  transcriptEvent({
    threadId: THREAD,
    ordinal: 12,
    type: "command_execution",
    payload: {
      input: "gh pr view 216 --repo equicom-crypto/rewards --json state",
      output: '{"state":"OPEN"}',
      exitCode: 0,
    },
  }),
  transcriptEvent({ threadId: THREAD, ordinal: 13, type: "checkpoint", payload: { files: [] } }),
];

const batch = { threadId: THREAD, fromEvent: 10, toEvent: 13 };

describe("citation checker", () => {
  it("passes an exact quote inside the cited range", () => {
    const check = checkCitation(
      [{ threadId: THREAD, quote: "skip the migration check for now", fromEvent: 11, toEvent: 11 }],
      events,
      batch,
    );
    expect(check.citation).toBe("verified");
    expect(check.sources[0]?.matchedEvent).toBe(11);
  });

  it("collapses whitespace but nothing else", () => {
    const check = checkSource(
      { threadId: THREAD, quote: "skip the\nmigration   check", fromEvent: 10, toEvent: 12 },
      events,
      batch,
    );
    expect(check.ok).toBe(true);
  });

  it("fails a paraphrase", () => {
    const check = checkCitation(
      [
        {
          threadId: THREAD,
          quote: "skipping the migration check for now",
          fromEvent: 11,
          toEvent: 11,
        },
      ],
      events,
      batch,
    );
    expect(check.citation).toBe("failed");
    expect(check.failure).toBe("quote-not-found");
  });

  it("fails a real quote cited outside its event", () => {
    const check = checkSource(
      { threadId: THREAD, quote: "skip the migration check for now", fromEvent: 12, toEvent: 13 },
      events,
      batch,
    );
    expect(check).toEqual({ ok: false, failure: "quote-not-found", matchedEvent: null });
  });

  it("fails a range outside the slice the scribe read", () => {
    const check = checkSource(
      { threadId: THREAD, quote: "skip the migration check for now", fromEvent: 9, toEvent: 11 },
      events,
      batch,
    );
    expect(check.failure).toBe("range-outside-batch");
  });

  it("fails another thread, bad ranges, short quotes and no sources", () => {
    expect(
      checkSource(
        { threadId: "other", quote: "skip the migration check", fromEvent: 11, toEvent: 11 },
        events,
        batch,
      ).failure,
    ).toBe("wrong-thread");
    expect(
      checkSource(
        { threadId: THREAD, quote: "skip the migration check", fromEvent: 12, toEvent: 11 },
        events,
        batch,
      ).failure,
    ).toBe("range-invalid");
    expect(
      checkSource({ threadId: THREAD, quote: "skip", fromEvent: 11, toEvent: 11 }, events, batch)
        .failure,
    ).toBe("quote-too-short");
    expect(checkCitation([], events, batch).failure).toBe("no-sources");
  });

  it("fails the whole note when any source fails", () => {
    const check = checkCitation(
      [
        { threadId: THREAD, quote: "skip the migration check for now", fromEvent: 11, toEvent: 11 },
        { threadId: THREAD, quote: "we never said this at all", fromEvent: 10, toEvent: 12 },
      ],
      events,
      batch,
    );
    expect(check.citation).toBe("failed");
    expect(check.sources.map((source) => source.ok)).toEqual([true, false]);
  });

  it("quotes tool output too", () => {
    const check = checkSource(
      { threadId: THREAD, quote: '{"state":"OPEN"}', fromEvent: 12, toEvent: 12 },
      events,
      batch,
    );
    expect(check.ok).toBe(true);
  });
});

describe("claim-of-done evidence", () => {
  const threadPayload = {
    pullRequests: [
      {
        repository: "equicom-crypto/rewards",
        number: 217,
        url: "https://github.com/equicom-crypto/rewards/pull/217",
        snapshot: { state: "MERGED", checksState: "success" },
      },
      {
        repository: "equicom-crypto/rewards",
        number: 218,
        url: "https://github.com/equicom-crypto/rewards/pull/218",
        snapshot: { state: "OPEN", checksState: "failure" },
      },
    ],
  };
  const facts = { pullRequests: pullRequestFacts(threadPayload), events };

  it("extracts PRs, runs, digests and commits", () => {
    const refs = extractRefs(
      "Merged rewards#217 (PR #217) at head 4d57c82f59, run 18273645501 green, digest sha256:0123456789abcdef0123.",
    );
    expect(refs.map((ref) => `${ref.kind}:${ref.key}:${ref.repository ?? "-"}`)).toEqual([
      "pull-request:217:rewards",
      "ci-run:18273645501:-",
      "deploy:sha256:0123456789abcdef0123:-",
      "commit:4d57c82f59:-",
    ]);
  });

  it("matches a merged claim against the PR snapshot", () => {
    const check = checkEvidence("rewards#217 is merged", facts);
    expect(check.evidence).toBe("matched");
    expect(check.links[0]?.url).toBe("https://github.com/equicom-crypto/rewards/pull/217");
  });

  it("flags a merged claim the PR snapshot contradicts", () => {
    expect(checkEvidence("merged equicom-crypto/rewards#218", facts).evidence).toBe("mismatch");
  });

  it("falls back to tool output the lane observed", () => {
    const check = checkEvidence("PR #216 merged", { pullRequests: [], events });
    expect(check.evidence).toBe("mismatch");
    expect(check.refs[0]?.reason).toContain("open");
  });

  it("is missing when the claim names nothing checkable", () => {
    expect(checkEvidence("all done, everything shipped", facts).evidence).toBe("missing");
    expect(checkEvidence("merged rewards#999", facts).evidence).toBe("missing");
  });
});
