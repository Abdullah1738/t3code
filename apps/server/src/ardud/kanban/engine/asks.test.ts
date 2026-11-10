import {
  KanbanCardId,
  KanbanOwnerAsk,
  ThreadId,
  kanbanAskKind,
  kanbanAskRevision,
  kanbanAskWaitsOn,
  type KanbanActor,
  type KanbanBlock,
  type KanbanCard,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { assert, describe, it } from "vite-plus/test";

import * as Asks from "./asks.ts";

const owner: KanbanActor = { _tag: "owner" };
const worker: KanbanActor = { _tag: "thread", threadId: ThreadId.make("thread-1") };
const evaluator: KanbanActor = { _tag: "evaluator", threadId: ThreadId.make("evaluator-1") };
const AT = "2026-11-10T10:00:00.000Z";
const LATER = "2026-11-10T11:00:00.000Z";

/** The ask as it is stored: what addAsk gives, plus the typed fields. */
const ask = (fields: Asks.AskFieldsInput = {}, text = "Ship it?"): KanbanOwnerAsk => {
  const typed = Asks.askFields(fields);
  if (Asks.isAskProblem(typed)) throw new Error(typed.detail);
  return {
    id: "q1",
    text,
    blocking: true,
    by: worker,
    at: AT as never,
    seq: 3,
    closedAt: null,
    ...typed,
  };
};

const card = (asks: ReadonlyArray<KanbanOwnerAsk>) =>
  ({
    id: KanbanCardId.make("card-1"),
    number: 12,
    stage: "needs_owner",
    asks,
  }) as unknown as KanbanCard;

const problem = (value: unknown) => {
  if (!Asks.isAskProblem(value)) throw new Error("expected a problem");
  return value;
};

describe("stored asks", () => {
  const decode = Schema.decodeUnknownSync(KanbanOwnerAsk);
  const encode = Schema.encodeSync(KanbanOwnerAsk);
  const old = {
    id: "q1",
    text: "Deploy?",
    blocking: true,
    by: { _tag: "owner" },
    at: AT,
    seq: 4,
    closedAt: null,
  };

  it("an ask stored before typed asks decodes unchanged and reads as a question at revision 0", () => {
    const decoded = decode(old);
    assert.deepStrictEqual(encode(decoded) as unknown, old);
    assert.strictEqual(kanbanAskKind(decoded), "question");
    assert.strictEqual(kanbanAskRevision(decoded), 0);
    assert.strictEqual(kanbanAskWaitsOn(decoded), "owner");
    assert.isUndefined(decoded.blocks);
    assert.isUndefined(decoded.answer);
  });

  it("a typed ask round-trips with every field", () => {
    const full = {
      ...old,
      kind: "draft",
      title: "PR comment",
      context: "Why",
      options: [{ id: "a", label: "A", detail: "leads to A", recommended: true }],
      multi: false,
      draft: { text: "Hello", format: "markdown", target: "comment on PR #512" },
      basis: "head abc123",
      expiresAt: LATER,
      batchKey: "deploy-go",
      revision: 2,
      revisedAt: LATER,
      revisionNote: "clearer",
      clarifyAskedAt: LATER,
      blocks: [
        { _tag: "md", text: "caption" },
        { _tag: "html", html: "<p>x</p>", title: "Chart", height: 240 },
        { _tag: "image", url: "https://example.com/a.png", alt: "A chart" },
      ],
      answer: {
        verdict: "approved",
        note: "go",
        finalDraft: "Hello!",
        draftEdited: true,
        by: { _tag: "owner" },
        at: LATER,
      },
    };
    assert.deepStrictEqual(encode(decode(full)) as unknown, full);
  });

  it("an ask can't hold a pick block", () => {
    const withPick = {
      ...old,
      blocks: [
        { _tag: "choice", id: "c1", style: "pick", question: "?", options: [], multi: false },
      ],
    };
    assert.throws(() => decode(withPick));
  });
});

describe("askFields", () => {
  it("takes the kind from what the ask carries", () => {
    const kind = (input: Asks.AskFieldsInput) => {
      const fields = Asks.askFields(input);
      return Asks.isAskProblem(fields) ? fields.detail : fields.kind;
    };
    assert.strictEqual(kind({}), "question");
    assert.strictEqual(kind({ options: ["Yes"] }), "question");
    assert.strictEqual(kind({ options: ["Yes", "No"] }), "decision");
    assert.strictEqual(kind({ draft: { text: "Hi" } }), "draft");
    assert.strictEqual(kind({ action: { summary: "Deploy" } }), "action");
    assert.strictEqual(kind({ change: { label: "Rule", before: "a", after: "b" } }), "change");
  });

  it("checks each kind for what it needs", () => {
    assert.include(
      problem(Asks.askFields({ kind: "decision", options: ["Only"] })).detail,
      "two options",
    );
    assert.include(problem(Asks.askFields({ kind: "draft" })).detail, "draft: { text }");
    assert.include(
      problem(Asks.askFields({ kind: "draft", draft: { text: "  " } })).detail,
      "draft",
    );
    assert.include(problem(Asks.askFields({ kind: "action" })).detail, "action: { summary }");
    assert.include(
      problem(Asks.askFields({ kind: "change" })).detail,
      "change: { label, before, after }",
    );
    assert.include(
      problem(Asks.askFields({ change: { label: "Rule", before: "same", after: "same" } })).detail,
      "differ",
    );
    // One thing per ask.
    const mixed = problem(
      Asks.askFields({ kind: "draft", draft: { text: "Hi" }, action: { summary: "Deploy" } }),
    );
    assert.strictEqual(mixed.code, "invalid");
    assert.include(mixed.detail, "can't carry action");
    // A kind is a label: one exhibit under any other label is fine, two never are.
    assert.isFalse(Asks.isAskProblem(Asks.askFields({ kind: "question", draft: { text: "Hi" } })));
    assert.include(
      problem(
        Asks.askFields({ kind: "release", draft: { text: "Hi" }, action: { summary: "Deploy" } }),
      ).detail,
      "can't carry draft and action: ask one thing per ask",
    );
  });

  it("numbers options like the pick block always did and keeps given ids", () => {
    const fields = Asks.askFields({
      options: [
        "Yes",
        "  ",
        { id: "later", label: " Later ", detail: "Waits a day", recommended: true },
      ],
      multi: true,
    });
    if (Asks.isAskProblem(fields)) throw new Error(fields.detail);
    assert.deepStrictEqual(fields.options, [
      { id: "o1", label: "Yes" },
      { id: "later", label: "Later", detail: "Waits a day", recommended: true },
    ]);
    assert.strictEqual(fields.multi, true);
    assert.include(
      problem(
        Asks.askFields({
          options: [
            { id: "x", label: "A" },
            { id: "x", label: "B" },
          ],
        }),
      ).detail,
      'option id "x" is used twice',
    );
  });

  it("caps sizes with a clear error", () => {
    const tooLong = (input: Asks.AskFieldsInput) => problem(Asks.askFields(input)).detail;
    assert.include(
      tooLong({ context: "x".repeat(4_001) }),
      "context is at most 4000 characters (got 4001)",
    );
    assert.include(tooLong({ title: "x".repeat(201) }), "title is at most 200");
    assert.include(tooLong({ draft: { text: "x".repeat(20_001) } }), "draft text is at most 20000");
    assert.include(
      tooLong({ change: { label: "Rule", before: "x".repeat(20_001), after: "b" } }),
      "change before is at most 20000",
    );
    assert.include(
      tooLong({ options: Array.from({ length: 13 }, (_, i) => `o${i}`) }),
      "at most 12 options",
    );
    assert.include(tooLong({ expiresAt: "tomorrow" }), "expiresAt is not a time");
  });

  it("stores nothing for what was left out", () => {
    const fields = Asks.askFields({ title: "  ", context: "", options: [] });
    assert.deepStrictEqual(fields, { kind: "question" });
  });
});

describe("ask blocks", () => {
  const html = (bytes: number): KanbanBlock => ({
    _tag: "html",
    html: "x".repeat(bytes),
    title: "Chart",
    height: null,
  });
  const file = (name: string): KanbanBlock => ({
    _tag: "attachment",
    attachment: {
      type: "file",
      id: `kept-${name}`,
      name,
      mimeType: "application/pdf",
      sizeBytes: 10,
    },
  });

  it("takes every block type but a pick", () => {
    const blocks: ReadonlyArray<KanbanBlock> = [
      { _tag: "md", text: "caption" },
      { _tag: "collapse", title: "Log" as never, text: "lines" },
      html(100),
      { _tag: "card", cardId: KanbanCardId.make("card-2") },
      { _tag: "image", url: "https://example.com/a.png" as never, alt: "A chart" },
      file("report.pdf"),
    ];
    assert.isUndefined(Asks.askBlocksProblem(blocks));
    const pick: KanbanBlock = {
      _tag: "choice",
      id: "c1" as never,
      style: "pick",
      question: "Which?" as never,
      options: [],
      multi: false,
    };
    assert.include(Asks.askBlocksProblem([pick])!.detail, "put the answers in options");
  });

  it("refuses an oversized page, too many files and an image with no alt text", () => {
    assert.include(
      Asks.askBlocksProblem([html(256 * 1024 + 1)])!.detail,
      "at most 256 KB (got 257 KB)",
    );
    assert.isUndefined(Asks.askBlocksProblem([html(256 * 1024)]));
    const files = Array.from({ length: 9 }, (_, i) => file(`f${i}.pdf`));
    assert.include(Asks.askBlocksProblem(files)!.detail, "at most 8 images and files (got 9)");
    assert.include(
      Asks.askBlocksProblem(
        Array.from({ length: 13 }, () => ({ _tag: "md", text: "x" }) as KanbanBlock),
      )!.detail,
      "at most 12 blocks",
    );
    assert.include(
      Asks.askBlocksProblem([
        { _tag: "image", url: "https://example.com/a.png" as never, alt: null },
      ])!.detail,
      "needs alt text",
    );
    assert.include(
      Asks.askBlocksProblem([{ _tag: "md", text: "x".repeat(20_001) }])!.detail,
      "at most 20000 characters",
    );
  });

  it("keeps a small block whole on the card and a big one as a stub", () => {
    const [small, big, attached] = Asks.inlineBlocks([html(100), html(5_000), file("a.pdf")]);
    assert.deepStrictEqual(small, html(100));
    assert.strictEqual(big?._tag === "html" && big.truncated, true);
    assert.strictEqual(big?._tag === "html" && big.fullBytes, 5_000);
    assert.isBelow(big?._tag === "html" ? big.html.length : 0, 200);
    assert.deepStrictEqual(attached, file("a.pdf"));
    assert.deepStrictEqual(Asks.storedBlocks([html(100)], 0), {});
  });
});

describe("askBlocks", () => {
  it("a plain question is one md block and a pick keeps the ask's option ids", () => {
    assert.deepStrictEqual(Asks.askBlocks(ask()), [{ _tag: "md", text: "Ship it?" }]);
    const pick = Asks.askBlocks(ask({ options: ["Yes", { id: "no", label: "No" }], multi: true }));
    assert.deepStrictEqual(pick, [
      {
        _tag: "choice",
        id: "q1",
        style: "pick",
        question: "Ship it?",
        options: [
          { id: "o1", label: "Yes" },
          { id: "no", label: "No" },
        ],
        multi: true,
      },
    ]);
    // Plain labels still work for an ask that carries no options of its own.
    const legacy = Asks.askBlocks(ask(), ["A", " ", "B"], true);
    assert.deepStrictEqual(
      legacy.map((block) => (block._tag === "choice" ? [block.options, block.multi] : null)),
      [
        [
          [
            { id: "o1", label: "A" },
            { id: "o2", label: "B" },
          ],
          true,
        ],
      ],
    );
  });

  it("an approval with no options gets an Approve / Reject pick an old client can answer", () => {
    const blocks = Asks.askBlocks(
      ask({
        title: "PR comment",
        context: "The reviewer asked why.",
        draft: { text: "Because.", target: "comment on PR #512" },
        basis: "head abc123",
      }),
    );
    assert.strictEqual(blocks.length, 2);
    const [detail, pick] = blocks;
    assert.strictEqual(detail?._tag, "md");
    const text = detail?._tag === "md" ? detail.text : "";
    for (const part of [
      "**PR comment**",
      "The reviewer asked why.",
      "comment on PR #512",
      "Because.",
      "head abc123",
    ]) {
      assert.include(text, part);
    }
    assert.deepStrictEqual(pick?._tag === "choice" ? pick.options : [], [
      { id: "approve", label: "Approve" },
      { id: "reject", label: "Reject" },
    ]);
  });
});

describe("answerFor and answerText", () => {
  const draftAsk = ask(
    {
      title: "PR comment",
      draft: { text: "Thanks, fixed in abc123.", target: "comment on PR #512" },
    },
    "Post this reply?",
  );

  it("a note and an edited draft give the exact wake text, in order", () => {
    const answer = Asks.answerFor(
      card([draftAsk]),
      draftAsk,
      {
        verdict: "approved",
        note: "Tag Sam too. From now on always thank the reviewer.",
        finalDraft: "Thanks Sam, fixed in abc123.",
      },
      owner,
      LATER,
    );
    if (Asks.isAskProblem(answer)) throw new Error(answer.detail);
    assert.deepStrictEqual(answer, {
      verdict: "approved",
      note: "Tag Sam too. From now on always thank the reviewer.",
      finalDraft: "Thanks Sam, fixed in abc123.",
      draftEdited: true,
      by: owner,
      at: LATER,
    });
    assert.strictEqual(
      Asks.answerText(card([draftAsk]), draftAsk, answer),
      [
        'The owner APPROVED q1 on card #12: "PR comment".',
        "Owner's note, read this before you act:\nTag Sam too. From now on always thank the reviewer.",
        "Post exactly this text (the owner edited your draft):\nThanks Sam, fixed in abc123.",
      ].join("\n\n"),
    );
  });

  it("an untouched draft says so, and trailing whitespace is not an edit", () => {
    for (const finalDraft of [undefined, "Thanks, fixed in abc123.\n"]) {
      const answer = Asks.answerFor(
        card([draftAsk]),
        draftAsk,
        { verdict: "approved", finalDraft },
        owner,
        LATER,
      );
      if (Asks.isAskProblem(answer)) throw new Error(answer.detail);
      assert.strictEqual(answer.draftEdited, false);
      assert.strictEqual(
        Asks.answerText(card([draftAsk]), draftAsk, answer),
        'The owner APPROVED q1 on card #12: "PR comment".\n\nThe draft is approved as you wrote it. Post exactly that text.',
      );
    }
  });

  it("a rejection says not to go ahead and never carries a text to post", () => {
    const answer = Asks.answerFor(
      card([draftAsk]),
      draftAsk,
      { verdict: "rejected", note: "Too curt." },
      owner,
      LATER,
    );
    if (Asks.isAskProblem(answer)) throw new Error(answer.detail);
    const text = Asks.answerText(card([draftAsk]), draftAsk, answer);
    assert.strictEqual(
      text,
      'The owner REJECTED q1 on card #12: "PR comment".\n\nDo not go ahead with it as asked.\n\nOwner\'s note, read this before you act:\nToo curt.',
    );
  });

  it("a pick names the labels after the note, and his own words come first", () => {
    const pickAsk = ask(
      {
        options: [
          { id: "a", label: "Tonight" },
          { id: "b", label: "Tomorrow" },
        ],
        multi: true,
      },
      "When?",
    );
    const answer = Asks.answerFor(
      card([pickAsk]),
      pickAsk,
      {
        verdict: "picked",
        optionIds: ["b", "a"],
        text: "Either works.",
        note: "Not during the demo.",
      },
      owner,
      LATER,
    );
    if (Asks.isAskProblem(answer)) throw new Error(answer.detail);
    assert.strictEqual(
      Asks.answerText(card([pickAsk]), pickAsk, answer),
      [
        'The owner PICKED an answer to q1 on card #12: "When?".',
        "His answer:\nEither works.",
        "Owner's note, read this before you act:\nNot during the demo.",
        "Picked: Tomorrow; Tonight",
      ].join("\n\n"),
    );
  });

  it("checks the verdict against the ask", () => {
    const pickAsk = ask({ options: ["A", "B"] });
    const detail = (input: Asks.AskAnswerInput, on = pickAsk) =>
      problem(Asks.answerFor(card([on]), on, input, owner, LATER)).detail;
    assert.include(detail({ verdict: "picked" }), "needs optionIds");
    assert.include(
      detail({ verdict: "picked", optionIds: ["zz"] }),
      'no option "zz" (it has o1, o2)',
    );
    assert.include(detail({ verdict: "picked", optionIds: ["o1", "o2"] }), "takes one option");
    assert.include(detail({ verdict: "answered" }), "needs text");
    assert.include(detail({ verdict: "approved" }), 'takes picked, answered (got "approved")');
    assert.include(detail({ verdict: "maybe" }, draftAsk), "takes approved, rejected, answered");
    assert.include(
      detail({ verdict: "picked", optionIds: ["o1"], finalDraft: "x" }),
      "has no draft",
    );
    assert.include(
      detail({ verdict: "approved", finalDraft: "  " }, draftAsk),
      "reject the draft instead",
    );
    assert.include(
      detail({ verdict: "approved", note: "x".repeat(4_001) }, draftAsk),
      "note is at most 4000",
    );
  });

  it("a stale ask conflicts: revised since it was read, or past its expiry", () => {
    const revised = Asks.reviseAsk(pickable(), { context: "More detail." }, LATER);
    if (Asks.isAskProblem(revised)) throw new Error(revised.detail);
    const stale = problem(
      Asks.answerFor(
        card([revised]),
        revised,
        { verdict: "picked", optionIds: ["o1"], revision: 0 },
        owner,
        LATER,
      ),
    );
    assert.strictEqual(stale.code, "conflict");
    assert.include(
      stale.detail,
      "was updated since you read it (revision 1, you answered revision 0)",
    );
    assert.isFalse(
      Asks.isAskProblem(
        Asks.answerFor(
          card([revised]),
          revised,
          { verdict: "picked", optionIds: ["o1"], revision: 1 },
          owner,
          LATER,
        ),
      ),
    );

    const expiring = ask({ action: { summary: "Deploy" }, basis: "head abc123", expiresAt: LATER });
    const before = Asks.answerFor(card([expiring]), expiring, { verdict: "approved" }, owner, AT);
    assert.isFalse(Asks.isAskProblem(before));
    const expired = problem(
      Asks.answerFor(card([expiring]), expiring, { verdict: "approved" }, owner, LATER),
    );
    assert.strictEqual(expired.code, "conflict");
    assert.include(expired.detail, "expired at 2026-11-10T11:00:00.000Z");
    assert.include(expired.detail, "head abc123");

    const closed = { ...expiring, closedAt: AT as never };
    assert.strictEqual(
      problem(Asks.answerFor(card([closed]), closed, { verdict: "approved" }, owner, AT)).code,
      "conflict",
    );
  });

  it("an evaluator's decision on a handed ask is recorded as handed, with what it decided", () => {
    const handed = { ...pickable(), handedAt: AT as never };
    const answer = Asks.answerFor(
      card([handed]),
      handed,
      { verdict: "picked", optionIds: ["o2"], note: "Cheaper." },
      evaluator,
      LATER,
    );
    if (Asks.isAskProblem(answer)) throw new Error(answer.detail);
    assert.strictEqual(answer.verdict, "handed");
    assert.strictEqual(answer.decision, "picked");
    assert.deepStrictEqual(answer.by, evaluator);
    const text = Asks.answerText(card([handed]), handed, answer);
    assert.strictEqual(
      text,
      [
        'The evaluator, deciding for the owner (he handed it over), PICKED an answer to q1 on card #12: "Ship it?".',
        "Evaluator's note, read this before you act:\nCheaper.",
        "Picked: B",
      ].join("\n\n"),
    );
  });

  it("shows the answer on the pick block for clients that only read the discussion", () => {
    const approve = Asks.answerFor(
      card([draftAsk]),
      draftAsk,
      { verdict: "approved", note: "ok" },
      owner,
      LATER,
    );
    if (Asks.isAskProblem(approve)) throw new Error(approve.detail);
    assert.deepStrictEqual(Asks.blockAnswer(draftAsk, approve), {
      choice: ["approve"],
      text: "ok",
    });
    const plain = ask();
    const words = Asks.answerFor(
      card([plain]),
      plain,
      { verdict: "answered", text: "Friday" },
      owner,
      LATER,
    );
    if (Asks.isAskProblem(words)) throw new Error(words.detail);
    assert.deepStrictEqual(Asks.blockAnswer(plain, words), { choice: [], text: "Friday" });
  });

  const pickable = () => ask({ options: ["A", "B"] });
});

describe("reviseAsk", () => {
  it("bumps the revision, records the note and gives the owner the turn back", () => {
    const waiting = {
      ...ask({ options: ["A", "B"], context: "Old" }),
      clarifyAskedAt: AT as never,
    };
    const revised = Asks.reviseAsk(
      waiting,
      { question: "Ship tonight?", context: "Clearer.", revisionNote: "Said what tonight means" },
      LATER,
    );
    if (Asks.isAskProblem(revised)) throw new Error(revised.detail);
    assert.strictEqual(revised.revision, 1);
    assert.strictEqual(revised.revisedAt, LATER);
    assert.strictEqual(revised.revisionNote, "Said what tonight means");
    assert.strictEqual(revised.text, "Ship tonight?");
    assert.strictEqual(revised.context, "Clearer.");
    assert.isUndefined(revised.clarifyAskedAt);
    // What the edit didn't name stays.
    assert.deepStrictEqual(
      revised.options?.map((option) => option.label),
      ["A", "B"],
    );
    assert.strictEqual(
      Asks.revisedLine(revised),
      "Updated q1 (revision 1): Said what tonight means",
    );
    const again = Asks.reviseAsk(revised, { title: "Tonight" }, LATER);
    if (Asks.isAskProblem(again)) throw new Error(again.detail);
    assert.strictEqual(again.revision, 2);
    assert.isUndefined(again.revisionNote);
  });

  it("checks the edited ask for its kind, and a new body changes the kind", () => {
    const decision = ask({ options: ["A", "B"] });
    assert.include(
      problem(Asks.reviseAsk(decision, { options: ["Only"] }, LATER)).detail,
      "two options",
    );
    assert.include(
      problem(Asks.reviseAsk(decision, { question: "  " }, LATER)).detail,
      "needs the question",
    );
    const drafted = Asks.reviseAsk(
      ask({ action: { summary: "Deploy" } }),
      { draft: { text: "Hi" } },
      LATER,
    );
    if (Asks.isAskProblem(drafted)) throw new Error(drafted.detail);
    assert.strictEqual(drafted.kind, "draft");
    assert.isUndefined(drafted.action);
  });

  it("new blocks replace the old ones, an empty list clears them, none keeps them", () => {
    const shown = { ...ask(), blocks: [{ _tag: "md" as const, text: "old" }] };
    const kept = Asks.reviseAsk(shown, { title: "T" }, LATER);
    if (Asks.isAskProblem(kept)) throw new Error(kept.detail);
    assert.deepStrictEqual(kept.blocks, [{ _tag: "md", text: "old" }]);
    const swapped = Asks.reviseAsk(shown, { blocks: [{ _tag: "md", text: "new" }] }, LATER);
    if (Asks.isAskProblem(swapped)) throw new Error(swapped.detail);
    assert.deepStrictEqual(swapped.blocks, [{ _tag: "md", text: "new" }]);
    assert.strictEqual(swapped.revision, 1);
    const cleared = Asks.reviseAsk(shown, { blocks: [] }, LATER);
    if (Asks.isAskProblem(cleared)) throw new Error(cleared.detail);
    assert.isUndefined(cleared.blocks);
  });
});

describe("turns and closing", () => {
  it("a clarifying question, a hand-over and their undo move the turn", () => {
    const open = card([ask()]);
    const asked = Asks.markClarify(open, "q1", LATER);
    assert.strictEqual(kanbanAskWaitsOn(asked.asks[0]!), "agent");
    assert.strictEqual(kanbanAskWaitsOn(Asks.clearClarify(asked, "q1").asks[0]!), "owner");
    // Nothing waited: the same card comes back, so nothing is saved.
    assert.strictEqual(Asks.clearClarify(open, "q1"), open);
    const handed = Asks.markHanded(asked, "q1", LATER);
    assert.strictEqual(kanbanAskWaitsOn(handed.asks[0]!), "evaluator");
    assert.isUndefined(handed.asks[0]!.clarifyAskedAt);
    assert.strictEqual(kanbanAskWaitsOn(Asks.clearHanded(handed, "q1").asks[0]!), "owner");
  });

  it("closing stores the answer and ends anyone's turn", () => {
    const waiting = Asks.markClarify(card([ask()]), "q1", AT);
    const record = Asks.plainAnswer(owner, LATER, false);
    const closed = Asks.closeAsks(
      waiting,
      LATER,
      () => true,
      () => record,
    ).asks[0]!;
    assert.strictEqual(closed.closedAt, LATER);
    assert.deepStrictEqual(closed.answer, { verdict: "answered", by: owner, at: LATER });
    assert.isUndefined(closed.clarifyAskedAt);
    assert.isNull(kanbanAskWaitsOn(closed));
    assert.strictEqual(Asks.plainAnswer(worker, LATER, true).verdict, "dropped");
    // The old call shape still closes without an answer.
    assert.isUndefined(Asks.closeAsks(card([ask()]), LATER).asks[0]!.answer);
  });

  it("a clarifying reply tells the asker to reply and fix the ask, not to treat it as the answer", () => {
    const text = Asks.clarifyText(
      card([ask({ title: "Go live" })]),
      ask({ title: "Go live" }),
      "Which env?",
      false,
    );
    assert.include(text, 'The owner replied on q1 on card #12 ("Go live") without answering it.');
    assert.include(text, "still holds the card");
    assert.include(text, "His message:\nWhich env?");
    assert.include(text, 'discussion_post (card #12, ask "q1")');
    assert.include(text, "card_ask_change");
    assert.include(text, "Don't treat his message as the answer.");
    const passed = Asks.clarifyText(
      card([ask()]),
      ask({ options: ["A", "B"] }),
      "Which env?",
      true,
    );
    assert.include(passed, "can't hear this");
    assert.include(passed, "Options: o1 = A; o2 = B");
  });

  it("a tool reply is a summary, never the card", () => {
    const shown = {
      ...ask({ draft: { text: "Hi" } }),
      blocks: [{ _tag: "md" as const, text: "x" }],
    };
    assert.deepStrictEqual(Asks.askSummary(card([shown]), "q1"), {
      card: 12,
      stage: "needs_owner",
      ask: { id: "q1", kind: "draft", revision: 0, blocking: true, open: true, blocks: 1 },
    });
  });
});
