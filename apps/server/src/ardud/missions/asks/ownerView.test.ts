import { DraftId, MissionId, type Draft } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { draftAttachments, replyingToText, withReplyingTo } from "./ownerView.ts";

const draft = (overrides: Partial<Draft> = {}): Draft => ({
  id: DraftId.make("draft-1"),
  missionId: MissionId.make("m1"),
  audience: "Sami",
  channel: "github",
  target: { kind: "pull-request", label: "acme/api#42", url: null, ref: "acme/api#42" },
  text: "Yes, webhooks too.",
  approvedText: null,
  writerRoleId: null,
  source: { kind: "lane", ref: null },
  appliedNoteIds: [],
  status: "pending",
  rewriteNote: null,
  decidedBy: null,
  decidedAt: null,
  sentAt: null,
  createdAt: "2026-10-24T08:00:00.000Z",
  ...overrides,
});

const comment = {
  kind: "pull-request" as const,
  label: "acme/api#42 comment",
  url: "https://github.com/acme/api/pull/42#issuecomment-1",
  ref: null,
};

describe("owner view of a draft's reply context", () => {
  it("prints who, when, the quote and the summary for his chat", () => {
    const text = replyingToText(
      draft({
        inReplyTo: {
          summary: "Sami asks whether the retry fix covers webhooks.",
          quote: "Does this cover webhooks too?\nOr only the queue?",
          author: "Sami",
          at: "2026-10-24T05:30:00.000Z",
          link: comment,
        },
      }),
    );
    expect(text).toBe(
      [
        "Replying to Sami, Sat 24 Oct 09:30:",
        "> Does this cover webhooks too?",
        "> Or only the queue?",
        "Sami asks whether the retry fix covers webhooks.",
        "https://github.com/acme/api/pull/42#issuecomment-1",
      ].join("\n"),
    );
  });

  it("prints a situation summary as About, and nothing when the writer gave none", () => {
    expect(replyingToText(draft({ inReplyTo: { summary: "Dev was down for an hour." } }))).toBe(
      "About:\nDev was down for an hour.",
    );
    expect(
      replyingToText(draft({ inReplyTo: { summary: "Asks for an ETA.", author: "Lee" } })),
    ).toBe("Replying to Lee:\nAsks for an ETA.");
    expect(replyingToText(draft())).toBeNull();
    expect(replyingToText(draft({ inReplyTo: null }))).toBeNull();
  });

  it("adds replyingTo to listed drafts and the reply link to the attachments", () => {
    const withContext = draft({ inReplyTo: { summary: "About the outage.", link: comment } });
    const [first, second] = withReplyingTo([withContext, draft({ id: DraftId.make("d2") })]);
    expect(first?.replyingTo).toBe(
      "Replying to:\nAbout the outage.\nhttps://github.com/acme/api/pull/42#issuecomment-1",
    );
    expect(second).not.toHaveProperty("replyingTo");
    expect(draftAttachments(withContext)).toEqual([
      {
        kind: "pull-request",
        label: "acme/api#42",
        url: null,
        path: "acme/api#42",
        from: "target",
      },
      {
        kind: "pull-request",
        label: "acme/api#42 comment",
        url: comment.url,
        path: null,
        from: "reply",
      },
    ]);
  });
});
