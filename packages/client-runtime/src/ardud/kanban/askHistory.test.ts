import type { KanbanAskFeedItem, KanbanMessage, KanbanOwnerAsk } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { askAfterAnswer, askDiscussion, askOutcome } from "./askHistory.ts";

const ask = (patch: Record<string, unknown>): KanbanOwnerAsk =>
  ({
    id: "q1",
    text: "Deploy 4.2.1?",
    blocking: true,
    by: { _tag: "evaluator", threadId: "t" },
    at: "2026-11-10T10:00:00.000Z",
    seq: 3,
    closedAt: null,
    ...patch,
  }) as unknown as KanbanOwnerAsk;

const message = (seq: number, author: string, at: string, blocks: unknown[] = []): KanbanMessage =>
  ({
    discussionId: "d",
    seq,
    author: { _tag: author },
    authorName: author,
    blocks: blocks.length > 0 ? blocks : [{ _tag: "md", text: `m${seq}` }],
    answers: [],
    createdAt: at,
    askId: "q1",
  }) as unknown as KanbanMessage;

const entry = (
  askPatch: Record<string, unknown>,
  messages: KanbanMessage[],
): Pick<KanbanAskFeedItem, "ask" | "messages"> => ({ ask: ask(askPatch), messages });

describe("askDiscussion", () => {
  it("leaves out the message that asked and every rewrite of it", () => {
    const talk = entry({ firstSeq: 1, seq: 3 }, [
      message(1, "evaluator", "2026-11-10T10:00:00.000Z"),
      message(2, "owner", "2026-11-10T10:01:00.000Z"),
      message(3, "evaluator", "2026-11-10T10:02:00.000Z"),
      message(4, "evaluator", "2026-11-10T10:03:00.000Z", [{ _tag: "choice", id: "q1" }]),
      message(5, "evaluator", "2026-11-10T10:04:00.000Z"),
    ]);
    expect(askDiscussion(talk).map((entry) => entry.seq)).toEqual([2, 5]);
  });

  it("keeps a choice that belongs to another ask", () => {
    const talk = entry({ seq: 1 }, [
      message(1, "evaluator", "2026-11-10T10:00:00.000Z"),
      message(2, "evaluator", "2026-11-10T10:01:00.000Z", [{ _tag: "choice", id: "q2" }]),
    ]);
    expect(askDiscussion(talk).map((entry) => entry.seq)).toEqual([2]);
  });
});

describe("askAfterAnswer", () => {
  it("is what the agent said once he had answered", () => {
    const talk = entry(
      {
        seq: 1,
        answer: { verdict: "approved", by: { _tag: "owner" }, at: "2026-11-10T11:00:00.000Z" },
      },
      [
        message(1, "evaluator", "2026-11-10T10:00:00.000Z"),
        message(2, "evaluator", "2026-11-10T10:30:00.000Z"),
        message(3, "owner", "2026-11-10T11:05:00.000Z"),
        message(4, "evaluator", "2026-11-10T11:10:00.000Z"),
      ],
    );
    expect(askAfterAnswer(talk).map((entry) => entry.seq)).toEqual([4]);
    expect(askAfterAnswer(entry({ seq: 1 }, talk.messages as KanbanMessage[]))).toEqual([]);
  });
});

describe("askOutcome", () => {
  const closed = (answer: Record<string, unknown>, patch: Record<string, unknown> = {}) =>
    askOutcome(
      ask({
        ...patch,
        answer: { by: { _tag: "owner" }, at: "2026-11-10T11:00:00.000Z", ...answer },
      }),
    )!;

  it("is null while the ask is open", () => {
    expect(askOutcome(ask({}))).toBeNull();
  });

  it("names a verdict, under the ask's own label when it has one", () => {
    expect(
      closed({ verdict: "approved", note: " Tell me after. " }, { kind: "action" }),
    ).toMatchObject({
      label: "Approved",
      text: null,
      note: "Tell me after.",
    });
    expect(
      closed(
        { verdict: "rejected", text: "Crops on small phones" },
        { respond: { verdict: { approve: "Passes", reject: "Fails" } } },
      ),
    ).toMatchObject({ label: "Fails", text: "Crops on small phones" });
    expect(closed({ verdict: "escalated" }).label).toBe("Escalated");
  });

  it("names picked options by their labels", () => {
    const outcome = closed(
      { verdict: "picked", optionIds: ["b"] },
      {
        kind: "decision",
        options: [
          { id: "a", label: "Redis" },
          { id: "b", label: "Postgres queue" },
        ],
      },
    );
    expect(outcome).toMatchObject({ label: "Picked", text: "Postgres queue" });
  });

  it("shows the draft both ways only when he edited it", () => {
    const draft = { text: "Thanks, all.", format: "plain" };
    expect(
      closed({ verdict: "approved", finalDraft: "Thanks, Rahul.", draftEdited: true }, { draft })
        .draft,
    ).toEqual({ before: "Thanks, all.", after: "Thanks, Rahul." });
    expect(closed({ verdict: "approved", finalDraft: "Thanks, all." }, { draft }).draft).toBeNull();
  });

  it("reads field values as text and never a secret", () => {
    const outcome = closed(
      {
        verdict: "answered",
        values: {
          token: { secret: true },
          cap: 40,
          go: true,
          order: ["b", "a"],
          proof: [
            {
              type: "file",
              id: "x",
              name: "invoice.pdf",
              mimeType: "application/pdf",
              sizeBytes: 9,
            },
          ],
          empty: "",
        },
      },
      {
        kind: "input",
        respond: {
          fields: [
            { id: "token", label: "Token", type: "secret" },
            { id: "cap", label: "Cap", type: "number", unit: "USD" },
            { id: "go", label: "Start now", type: "toggle" },
            {
              id: "order",
              label: "Order",
              type: "rank",
              options: [
                { id: "a", label: "Alpha" },
                { id: "b", label: "Beta" },
              ],
            },
            { id: "proof", label: "Proof", type: "file" },
            { id: "empty", label: "Empty", type: "text" },
          ],
        },
      },
    );
    expect(outcome.values).toEqual([
      ["Token", "Provided"],
      ["Cap", "40 USD"],
      ["Start now", "Yes"],
      ["Order", "Beta, then Alpha"],
      ["Proof", "invoice.pdf"],
    ]);
  });

  it("folds a single answer field into the text", () => {
    const outcome = closed({ verdict: "answered", values: { answer: "Keep the nightly job." } });
    expect(outcome).toMatchObject({
      label: "Answer sent",
      text: "Keep the nightly job.",
      values: [],
    });
  });

  it("carries the evaluator thread of a standing hand-over", () => {
    expect(
      closed({
        verdict: "handed",
        decision: "Approved it",
        always: true,
        evaluatorThreadId: "thread-1",
      }),
    ).toMatchObject({
      label: "Handed to the evaluator",
      text: "Approved it",
      always: true,
      evaluatorThreadId: "thread-1",
    });
  });
});
