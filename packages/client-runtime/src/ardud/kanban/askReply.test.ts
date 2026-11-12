import type { KanbanBlock, KanbanOwnerAsk } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { ASK_REPLY_LIMITS, askReplyProblem, askRequiresSecret } from "./askReply.ts";

const md = (text: string) => ({ _tag: "md", text }) as unknown as KanbanBlock;
const file = (id: number) =>
  ({
    _tag: "attachment",
    attachment: {
      type: "file",
      id: `a${id}`,
      name: `f${id}.txt`,
      mimeType: "text/plain",
      sizeBytes: 1,
    },
  }) as unknown as KanbanBlock;
const html = (bytes: number) =>
  ({ _tag: "html", html: "x".repeat(bytes), title: null, height: null }) as unknown as KanbanBlock;
const many = (count: number, make: (index: number) => KanbanBlock) =>
  Array.from({ length: count }, (_, index) => make(index));

describe("askReplyProblem", () => {
  it("passes a reply inside every limit", () => {
    expect(askReplyProblem([md("Which page is this for?"), ...many(8, file)])).toBeNull();
    expect(askReplyProblem([md("a".repeat(ASK_REPLY_LIMITS.textChars))])).toBeNull();
    expect(askReplyProblem([html(ASK_REPLY_LIMITS.htmlBytes)])).toBeNull();
  });

  it("counts text one block at a time, like the server", () => {
    expect(askReplyProblem([md("a".repeat(12_000)), md("b".repeat(12_000))])).toBeNull();
  });

  it("refuses an empty reply", () => {
    expect(askReplyProblem([])).toBe("Write something first.");
  });

  it("names the limit that was passed, with the count", () => {
    expect(askReplyProblem([md("see these"), ...many(9, file)])).toBe(
      "A reply takes up to 8 pictures and files. This one has 9.",
    );
    expect(askReplyProblem(many(13, (index) => md(`part ${index}`)))).toBe(
      "A reply takes up to 12 parts (text, pictures, files). This one has 13.",
    );
    expect(askReplyProblem([md("ok"), md("b".repeat(20_001))])).toBe(
      "Keep a reply under 20,000 characters. This one has 20,001.",
    );
    expect(askReplyProblem([html(ASK_REPLY_LIMITS.htmlBytes + 1)])).toBe(
      "A page in a reply can be up to 256 KB.",
    );
  });

  it("counts a page by bytes, not characters", () => {
    const wide = { _tag: "html", html: "é".repeat(140_000), title: null, height: null };
    expect(askReplyProblem([wide as unknown as KanbanBlock])).toBe(
      "A page in a reply can be up to 256 KB.",
    );
  });
});

describe("askRequiresSecret", () => {
  const ask = (fields: unknown[]) =>
    ({
      id: "q1",
      text: "Token",
      blocking: true,
      by: { _tag: "owner" },
      at: "2026-11-10T10:00:00.000Z",
      seq: null,
      closedAt: null,
      kind: "input",
      respond: { fields },
    }) as unknown as KanbanOwnerAsk;

  it("is true only for a secret he has to give", () => {
    expect(
      askRequiresSecret(ask([{ id: "t", label: "Token", type: "secret", required: true }])),
    ).toBe(true);
    expect(askRequiresSecret(ask([{ id: "t", label: "Token", type: "secret" }]))).toBe(false);
    expect(askRequiresSecret(ask([{ id: "n", label: "Name", type: "text", required: true }]))).toBe(
      false,
    );
  });
});
