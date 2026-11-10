/**
 * Typed owner asks end to end on the board service and its HTTP routes:
 * asking with a template and blocks, answering, replying without answering,
 * editing, handing one to the evaluator, and the Needs-you feed.
 */
import { assert, it } from "@effect/vitest";
import {
  ThreadId,
  kanbanAskWaitsOn,
  type KanbanActor,
  type KanbanAskFeed,
  type KanbanBlock,
  type KanbanCard,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as SqlClient from "effect/sql/SqlClient";

import { resolveAttachmentPath } from "../../../attachmentStore.ts";
import * as ServerConfig from "../../../config.ts";
import {
  askOf,
  makeFake,
  makeHttp,
  owner,
  testLayer,
  toyBoard,
  workingCard,
  writePending,
} from "./askFlows.testkit.ts";

it.effect(
  "a draft ask stores its template, posts a pick an old client can answer, and keeps its blocks",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.gen(function* () {
        const { kanban, card, worker } = yield* workingCard();
        const shot = yield* writePending("before.png", "image/png", "png-bytes");
        const clip = yield* writePending("demo.mp4", "video/mp4", "mp4-bytes");
        const page = `<main>${"x".repeat(6_000)}</main>`;
        const asked = yield* kanban.askOwner(
          card.id,
          {
            question: "Post this reply on the PR?",
            blocking: false,
            title: "Reply to the reviewer",
            context: "They asked why the retry was removed.",
            draft: { text: "It was masking a real timeout.", target: "comment on PR #512" },
            basis: "head abc123",
            batchKey: "pr-replies",
            blocks: [
              { _tag: "md", text: "Latency before and after" },
              { _tag: "html", html: page, title: "Latency", height: 320 },
              { _tag: "image", url: "https://example.com/chart.png", alt: "p95 latency chart" },
              { _tag: "attachment", attachment: { ...shot, type: "file" } },
              { _tag: "attachment", attachment: clip },
            ] as ReadonlyArray<KanbanBlock>,
          },
          worker,
          "cardThread",
        );
        const ask = askOf(asked);
        assert.strictEqual(ask.kind, "draft");
        assert.strictEqual(ask.title, "Reply to the reviewer");
        assert.strictEqual(ask.context, "They asked why the retry was removed.");
        assert.deepStrictEqual(ask.draft, {
          text: "It was masking a real timeout.",
          format: "markdown",
          target: "comment on PR #512",
        });
        assert.strictEqual(ask.basis, "head abc123");
        assert.strictEqual(ask.batchKey, "pr-replies");
        assert.isUndefined(ask.revision);
        assert.strictEqual(asked.stage, "working");

        // On the card: small blocks whole, the page as a stub, the files under board ids.
        const blocks = ask.blocks!;
        assert.deepStrictEqual(
          blocks.map((block) => block._tag),
          ["md", "html", "image", "attachment", "attachment"],
        );
        const stub = blocks[1]!;
        assert.strictEqual(stub._tag === "html" && stub.truncated, true);
        assert.strictEqual(stub._tag === "html" && stub.fullBytes, page.length);
        const kept = blocks[4]!;
        if (kept._tag !== "attachment") return assert.fail("expected the video");
        assert.notStrictEqual(kept.attachment.id, clip.id);
        assert.strictEqual(kept.attachment.mimeType, "video/mp4");
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        assert.isTrue(
          yield* fs.exists(
            resolveAttachmentPath({
              attachmentsDir: config.attachmentsDir,
              attachment: kept.attachment,
            })!,
          ),
        );

        // In the discussion: the blocks whole, then the ask, then an Approve / Reject pick.
        const talk = yield* kanban.cardDiscussion(card.id);
        const message = yield* kanban.message(talk.id, ask.seq!);
        assert.strictEqual(message.askId, "q1");
        assert.deepStrictEqual(
          message.blocks.map((block) => block._tag),
          ["md", "html", "image", "attachment", "attachment", "md", "choice"],
        );
        const whole = message.blocks[1]!;
        assert.strictEqual(whole._tag === "html" ? whole.html : "", page);
        const pick = message.blocks[6]!;
        assert.deepStrictEqual(pick._tag === "choice" ? [pick.id, pick.options] : [], [
          "q1",
          [
            { id: "approve", label: "Approve" },
            { id: "reject", label: "Reject" },
          ],
        ]);

        // The single-ask read gives the page back whole; the card and the feed stay small.
        const detail = yield* kanban.askDetail(card.id, "q1");
        const full = detail.ask.blocks![1]!;
        assert.strictEqual(full._tag === "html" ? full.html : "", page);
        assert.strictEqual(full._tag === "html" && full.truncated, undefined);
        const feed = yield* kanban.askFeed({});
        assert.isBelow(JSON.stringify(feed).length, page.length);
        // The board feed the web client already gets carries the ask with its new fields.
        const snapshot = yield* kanban.snapshot(asked.boardId);
        const fed = snapshot.cards.find((entry) => entry.id === card.id)!.asks[0]!;
        assert.deepStrictEqual(
          [fed.kind, fed.title, fed.draft?.target, fed.batchKey, fed.blocks?.length],
          ["draft", "Reply to the reviewer", "comment on PR #512", "pr-replies", 5],
        );
        assert.isBelow(JSON.stringify(snapshot.cards).length, page.length);
        assert.isTrue(
          feed.open[0]!.messages[0]!.blocks.some(
            (block) => block._tag === "html" && block.truncated,
          ),
        );
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect("an ask with a file the board can't keep changes nothing", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, card, worker } = yield* workingCard();
      const missing: KanbanBlock = {
        _tag: "attachment",
        attachment: {
          type: "file",
          id: "not-uploaded.pdf",
          name: "x.pdf",
          mimeType: "application/pdf",
          sizeBytes: 5,
        },
      };
      const refused = yield* kanban
        .askOwner(
          card.id,
          { question: "Ok?", blocking: true, blocks: [missing] },
          worker,
          "cardThread",
        )
        .pipe(Effect.flip);
      assert.strictEqual(refused.code, "invalid");
      assert.include(refused.detail, "can't be posted here");
      const after = (yield* kanban.card(card.id)).card;
      assert.deepStrictEqual(after.asks, []);
      assert.strictEqual(after.stage, "working");

      const tooBig = yield* kanban
        .askOwner(
          card.id,
          {
            question: "Ok?",
            blocking: false,
            blocks: [{ _tag: "html", html: "x".repeat(256 * 1024 + 1), title: null, height: null }],
          },
          worker,
          "cardThread",
        )
        .pipe(Effect.flip);
      assert.include(tooBig.detail, "at most 256 KB");
      const wrongKind = yield* kanban
        .askOwner(
          card.id,
          { question: "Ok?", blocking: false, kind: "change" },
          worker,
          "cardThread",
        )
        .pipe(Effect.flip);
      assert.include(wrongKind.detail, "change: { label, before, after }");
      assert.deepStrictEqual((yield* kanban.card(card.id)).card.asks, []);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect(
  "the owner's answer with a note and an edited draft wakes the asker with the exact text",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.gen(function* () {
        const { kanban, card, threadId, worker } = yield* workingCard();
        const asked = yield* kanban.askOwner(
          card.id,
          { question: "Post this?", blocking: false, title: "PR reply", draft: { text: "Fixed." } },
          worker,
          "cardThread",
        );
        const result = yield* kanban.answerAsk(
          card.id,
          "q1",
          {
            verdict: "approved",
            note: "Thank Sam by name.",
            finalDraft: "Fixed. Thanks Sam.",
            revision: 0,
          },
          owner,
        );
        assert.isTrue(result.heard);
        const closed = askOf(result.card);
        assert.isNotNull(closed.closedAt);
        assert.deepStrictEqual(
          { ...closed.answer, at: null },
          {
            verdict: "approved",
            note: "Thank Sam by name.",
            finalDraft: "Fixed. Thanks Sam.",
            draftEdited: true,
            by: owner,
            at: null,
          },
        );
        assert.strictEqual(result.card.stage, "working");
        const expected = [
          'The owner APPROVED q1 on card #1: "PR reply".',
          "Owner's note, read this before you act:\nThank Sam by name.",
          "Post exactly this text (the owner edited your draft):\nFixed. Thanks Sam.",
        ].join("\n\n");
        assert.deepStrictEqual(
          (yield* fake.heard(threadId)).filter((text) => text.includes("APPROVED")),
          [expected],
        );
        // The pick in the discussion shows it too, for a client that only reads the discussion.
        const talk = yield* kanban.cardDiscussion(card.id);
        const message = yield* kanban.message(talk.id, askOf(asked).seq!);
        assert.deepStrictEqual(
          message.answers.map((answer) => [answer.blockId, answer.choice, answer.text]),
          [["q1", ["approve"], "Thank Sam by name."]],
        );
        // Answering it again conflicts.
        const again = yield* kanban
          .answerAsk(card.id, "q1", { verdict: "approved" }, owner)
          .pipe(Effect.flip);
        assert.strictEqual(again.code, "conflict");
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect(
  "answering a blocking ask sends the card back to its worker with the answer as the wake note",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.gen(function* () {
        const { kanban, card, threadId, worker } = yield* workingCard();
        const asked = yield* kanban.askOwner(
          card.id,
          {
            question: "Which database?",
            blocking: true,
            options: [
              {
                id: "pg",
                label: "Postgres",
                detail: "Managed, slower to set up",
                recommended: true,
              },
              { id: "lite", label: "SQLite", detail: "Ships today" },
            ],
          },
          worker,
          "cardThread",
        );
        assert.strictEqual(asked.stage, "needs_owner");
        assert.strictEqual(askOf(asked).kind, "decision");
        const result = yield* kanban.answerAsk(
          card.id,
          "q1",
          { verdict: "picked", optionIds: ["lite"] },
          owner,
        );
        assert.strictEqual(result.card.stage, "todo");
        assert.strictEqual(
          result.card.wakeNote,
          'The owner PICKED an answer to q1 on card #1: "Which database?".\n\nPicked: SQLite',
        );
        const events = (yield* kanban.card(card.id)).events;
        assert.strictEqual(
          events.findLast((event) => event.kind === "moved")?.body,
          "Owner picked q1",
        );
        yield* kanban.dispatchNow;
        assert.strictEqual((yield* kanban.card(card.id)).card.activeThreadId, threadId);
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect("a stale ask refuses the answer: revised since it was read, or expired", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, card, worker } = yield* workingCard();
      yield* kanban.askOwner(
        card.id,
        { question: "Deploy?", blocking: false, action: { summary: "Deploy build 41" } },
        worker,
        "cardThread",
      );
      yield* kanban.editAsk(
        card.id,
        "q1",
        { action: { summary: "Deploy build 42" }, basis: "build 42", revisionNote: "Newer build" },
        worker,
        "cardThread",
      );
      const stale = yield* kanban
        .answerAsk(card.id, "q1", { verdict: "approved", revision: 0 }, owner)
        .pipe(Effect.flip);
      assert.strictEqual(stale.code, "conflict");
      assert.include(stale.detail, "revision 1, you answered revision 0");
      assert.isNull(askOf((yield* kanban.card(card.id)).card).closedAt);

      yield* kanban.askOwner(
        card.id,
        {
          question: "Merge?",
          blocking: false,
          action: { summary: "Merge PR 9" },
          // The test clock starts at the epoch, so this is already past.
          expiresAt: "1969-12-31T00:00:00.000Z",
        },
        worker,
        "cardThread",
      );
      const expired = yield* kanban
        .answerAsk(card.id, "q2", { verdict: "approved" }, owner)
        .pipe(Effect.flip);
      assert.strictEqual(expired.code, "conflict");
      assert.include(expired.detail, "expired at 1969-12-31T00:00:00.000Z");
      const feed = yield* kanban.askFeed({});
      assert.deepStrictEqual(
        feed.open.map((item) => [item.ask.id, item.expired, item.revision]),
        [
          ["q1", false, 1],
          ["q2", true, 0],
        ],
      );
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect(
  "a reply on an ask keeps it open and blocking, and the agent's reply or edit gives the turn back",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.gen(function* () {
        const { kanban, card, threadId, worker } = yield* workingCard();
        yield* kanban.askOwner(
          card.id,
          { question: "Ship tonight?", blocking: true, options: ["Yes", "No"] },
          worker,
          "cardThread",
        );
        // A second ask on the same card, from someone else.
        yield* kanban.askOwner(
          card.id,
          { question: "And the logo?", blocking: false },
          { _tag: "evaluator", threadId: ThreadId.make("evaluator-other") },
          "evaluator",
        );
        const shot = yield* writePending("screen.png", "image/png", "png-bytes");

        // The owner asks about q1 with a screenshot instead of answering.
        const reply = yield* kanban.replyOnAsk(
          card.id,
          "q1",
          owner,
          [
            { _tag: "md", text: "I don't understand: tonight where?" },
            { _tag: "attachment", attachment: shot },
          ],
          "owner",
        );
        assert.strictEqual(reply.askId, "q1");
        assert.deepStrictEqual(
          reply.blocks.map((block) => block._tag),
          ["md", "attachment"],
        );
        const waiting = (yield* kanban.card(card.id)).card;
        assert.strictEqual(waiting.stage, "needs_owner");
        assert.isNull(askOf(waiting).closedAt);
        assert.isTrue(askOf(waiting).blocking);
        assert.strictEqual(kanbanAskWaitsOn(askOf(waiting)), "agent");
        // The other ask on the card is untouched: a reply on one ask answers none.
        assert.isNull(askOf(waiting, "q2").closedAt);
        assert.strictEqual(kanbanAskWaitsOn(askOf(waiting, "q2")), "owner");

        // Its worker is parked, so the card's evaluator is woken with the message and what to do.
        const [evaluator] = yield* fake.evaluators;
        assert.isDefined(evaluator);
        const told = evaluator!.messages.find((text) => text.includes("without answering it"))!;
        assert.include(told, "I don't understand: tonight where?");
        assert.include(told, "still holds the card");
        assert.include(told, "can't hear this");
        assert.include(told, 'discussion_post (card #1, ask "q1")');
        assert.include(told, "card_ask_change");
        assert.strictEqual(
          (yield* fake.heard(threadId)).filter((text) => text.includes("without answering")).length,
          0,
        );

        // The agent replies with a picture: the ask stays open, and it is the owner's turn again.
        const evaluatorActor: KanbanActor = { _tag: "evaluator", threadId: evaluator!.threadId };
        const answerShot = yield* writePending("staging.png", "image/png", "png-bytes-2");
        const agentReply = yield* kanban.replyOnAsk(
          card.id,
          "q1",
          evaluatorActor,
          [
            { _tag: "md", text: "Tonight on staging only." },
            { _tag: "attachment", attachment: answerShot },
            { _tag: "html", html: "<p>plan</p>", title: "Plan", height: null },
          ],
          "evaluator",
        );
        assert.strictEqual(agentReply.askId, "q1");
        const back = (yield* kanban.card(card.id)).card;
        assert.strictEqual(kanbanAskWaitsOn(askOf(back)), "owner");
        assert.isNull(askOf(back).closedAt);
        assert.strictEqual(back.stage, "needs_owner");

        // He asks again; this time the agent fixes the ask itself.
        yield* kanban.replyOnAsk(
          card.id,
          "q1",
          owner,
          [{ _tag: "md", text: "Still unclear." }],
          "owner",
        );
        assert.strictEqual(kanbanAskWaitsOn(askOf((yield* kanban.card(card.id)).card)), "agent");
        const edited = yield* kanban.editAsk(
          card.id,
          "q1",
          { question: "Ship to staging tonight?", revisionNote: "Said where" },
          evaluatorActor,
          "evaluator",
        );
        const revised = askOf(edited);
        assert.strictEqual(kanbanAskWaitsOn(revised), "owner");
        assert.strictEqual(revised.revision, 1);
        assert.strictEqual(revised.revisionNote, "Said where");
        assert.strictEqual(edited.question, "Ship to staging tonight?");
        assert.strictEqual(edited.stage, "needs_owner");
        const events = (yield* kanban.card(card.id)).events;
        assert.strictEqual(events.at(-1)?.body, "Updated q1 (revision 1): Said where");

        // The ask's thread in the feed: the ask, both replies, and the new version, in order.
        const feed = yield* kanban.askFeed({});
        const item = feed.open.find((entry) => entry.ask.id === "q1")!;
        assert.deepStrictEqual(
          item.messages.map((message) => [
            message.author._tag,
            message.blocks.map((block) => block._tag),
          ]),
          [
            ["thread", ["choice"]],
            ["owner", ["md", "attachment"]],
            ["evaluator", ["md", "attachment", "html"]],
            ["owner", ["md"]],
            ["evaluator", ["md", "choice"]],
          ],
        );
        assert.strictEqual(item.waitsOn, "owner");

        // An old client's pick on the new version still answers it and wakes the card: it is
        // stored as the pick it is, checked like one sent to the ask.
        const talk = yield* kanban.cardDiscussion(card.id);
        yield* kanban.answer(talk.id, revised.seq!, "q1", ["o1"], owner);
        const answered = (yield* kanban.card(card.id)).card;
        assert.isNotNull(askOf(answered).closedAt);
        assert.deepStrictEqual(
          [askOf(answered).answer?.verdict, askOf(answered).answer?.optionIds],
          ["picked", ["o1"]],
        );
        assert.strictEqual(answered.stage, "todo");
        assert.include(answered.wakeNote ?? "", "Yes");
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect(
  "a live asker hears the owner's reply on its ask itself, and a plain reply still answers",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.gen(function* () {
        const { kanban, card, threadId, worker } = yield* workingCard();
        yield* kanban.askOwner(
          card.id,
          { question: "Which fee?", blocking: false },
          worker,
          "cardThread",
        );
        yield* kanban.replyOnAsk(
          card.id,
          "q1",
          owner,
          [{ _tag: "md", text: "Fee on what?" }],
          "owner",
        );
        const told = (yield* fake.heard(threadId)).filter((text) =>
          text.includes("without answering it"),
        );
        assert.strictEqual(told.length, 1);
        assert.include(told[0]!, "His message:\nFee on what?");
        assert.notInclude(told[0]!, "can't hear this");
        assert.deepStrictEqual(yield* fake.evaluators, []);

        // The asker replies on the ask through the same call: its turn is over, the ask stays open.
        yield* kanban.replyOnAsk(
          card.id,
          "q1",
          worker,
          [{ _tag: "md", text: "On withdrawals." }],
          "cardThread",
        );
        const open = askOf((yield* kanban.card(card.id)).card);
        assert.isNull(open.closedAt);
        assert.strictEqual(kanbanAskWaitsOn(open), "owner");

        // A reply typed in the card discussion (an old client) answers the open asks as before.
        const talk = yield* kanban.cardDiscussion(card.id);
        yield* kanban.post(talk.id, owner, [{ _tag: "md", text: "Use 2%" }]);
        const closed = askOf((yield* kanban.card(card.id)).card);
        assert.isNotNull(closed.closedAt);
        assert.deepStrictEqual(closed.answer?.verdict, "answered");
        assert.strictEqual(
          (yield* fake.heard(threadId)).filter((text) => text.includes("Use 2%")).length,
          1,
        );

        // A closed ask takes no more replies.
        const late = yield* kanban
          .replyOnAsk(card.id, "q1", owner, [{ _tag: "md", text: "?" }], "owner")
          .pipe(Effect.flip);
        assert.strictEqual(late.code, "not-found");
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect(
  "an edit that swaps the blocks bumps the revision, and one that doesn't carries them along whole",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.gen(function* () {
        const { kanban, card, worker } = yield* workingCard();
        const page = `<main>${"y".repeat(6_000)}</main>`;
        yield* kanban.askOwner(
          card.id,
          {
            question: "Approve the chart?",
            blocking: false,
            blocks: [{ _tag: "html", html: page, title: "Chart", height: null }],
          },
          worker,
          "cardThread",
        );
        // No blocks in the edit: the page comes along whole into the new version's message.
        const retitled = yield* kanban.editAsk(
          card.id,
          "q1",
          { title: "Chart" },
          worker,
          "cardThread",
        );
        assert.strictEqual(askOf(retitled).revision, 1);
        assert.strictEqual(askOf(retitled).blocks?.length, 1);
        const carried = (yield* kanban.askDetail(card.id, "q1")).ask.blocks![0]!;
        assert.strictEqual(carried._tag === "html" ? carried.html : "", page);

        const clip = yield* writePending("walkthrough.webm", "video/webm", "webm-bytes");
        const swapped = yield* kanban.editAsk(
          card.id,
          "q1",
          {
            blocks: [
              { _tag: "md", text: "A recording instead" },
              { _tag: "attachment", attachment: clip },
            ],
            revisionNote: "Recording instead of the chart",
          },
          worker,
          "cardThread",
        );
        const ask = askOf(swapped);
        assert.strictEqual(ask.revision, 2);
        assert.deepStrictEqual(
          ask.blocks?.map((block) => block._tag),
          ["md", "attachment"],
        );
        const talk = yield* kanban.cardDiscussion(card.id);
        const message = yield* kanban.message(talk.id, ask.seq!);
        assert.deepStrictEqual(
          message.blocks.map((block) => block._tag),
          ["md", "attachment", "md", "md"],
        );
        assert.strictEqual(message.askId, "q1");

        const cleared = yield* kanban.editAsk(card.id, "q1", { blocks: [] }, worker, "cardThread");
        assert.strictEqual(askOf(cleared).revision, 3);
        assert.isUndefined(askOf(cleared).blocks);
        const tooMany = yield* kanban
          .editAsk(
            card.id,
            "q1",
            {
              blocks: Array.from({ length: 13 }, () => ({ _tag: "md", text: "x" }) as KanbanBlock),
            },
            worker,
            "cardThread",
          )
          .pipe(Effect.flip);
        assert.include(tooMany.detail, "at most 12 blocks");
        assert.strictEqual(askOf((yield* kanban.card(card.id)).card).revision, 3);
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect("the owner hands one ask to the evaluator, which decides it for him", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, card, threadId, worker } = yield* workingCard();
      yield* kanban.askOwner(
        card.id,
        {
          question: "Which queue?",
          blocking: true,
          options: ["SQS", "Kafka"],
          context: "Both work.",
        },
        worker,
        "cardThread",
      );
      // Not handed yet: an evaluator can't answer it.
      const stranger: KanbanActor = { _tag: "evaluator", threadId: ThreadId.make("evaluator-x") };
      const denied = yield* kanban
        .answerAsk(card.id, "q1", { verdict: "picked", optionIds: ["o1"] }, stranger)
        .pipe(Effect.flip);
      assert.strictEqual(denied.code, "denied");

      const handed = yield* kanban.handAsk(card.id, "q1", "hand", owner);
      assert.strictEqual(kanbanAskWaitsOn(askOf(handed)), "evaluator");
      assert.strictEqual(handed.stage, "needs_owner");
      const [evaluator] = yield* fake.evaluators;
      const told = evaluator!.messages.find((text) => text.includes("handed you q1"))!;
      assert.include(told, "Question (decision): Which queue?");
      assert.include(told, "Both work.");
      assert.include(told, "Options: o1 = SQS; o2 = Kafka");
      assert.include(told, "card_ask_answer");
      const twice = yield* kanban.handAsk(card.id, "q1", "hand", owner).pipe(Effect.flip);
      assert.include(twice.detail, "already with the evaluator");

      // He takes it back, hands it again, and the evaluator decides.
      const back = yield* kanban.handAsk(card.id, "q1", "take_back", owner);
      assert.strictEqual(kanbanAskWaitsOn(askOf(back)), "owner");
      yield* kanban.handAsk(card.id, "q1", "hand", owner);
      const evaluatorActor: KanbanActor = { _tag: "evaluator", threadId: evaluator!.threadId };
      const wrongWay = yield* kanban.handAsk(card.id, "q1", "return", owner).pipe(Effect.flip);
      assert.strictEqual(wrongWay.code, "denied");
      const result = yield* kanban.answerAsk(
        card.id,
        "q1",
        { verdict: "picked", optionIds: ["o1"], note: "We already run SQS." },
        evaluatorActor,
      );
      const closed = askOf(result.card);
      assert.strictEqual(closed.answer?.verdict, "handed");
      assert.strictEqual(closed.answer?.decision, "picked");
      assert.deepStrictEqual(closed.answer?.optionIds, ["o1"]);
      assert.deepStrictEqual(closed.answer?.by, evaluatorActor);
      assert.isUndefined(closed.handedAt);
      // The card goes back to its worker with the decision, marked as the evaluator's.
      assert.strictEqual(result.card.stage, "todo");
      assert.strictEqual(
        result.card.wakeNote,
        [
          'The evaluator, deciding for the owner (he handed it over), PICKED an answer to q1 on card #1: "Which queue?".',
          "Evaluator's note, read this before you act:\nWe already run SQS.",
          "Picked: SQS",
        ].join("\n\n"),
      );
      assert.isTrue(result.heard);
      const events = (yield* kanban.card(card.id)).events.map((event) => event.body);
      assert.include(events, "Owner handed q1 to the evaluator");
      assert.include(events, "Owner took q1 back");
      assert.include(events, "Evaluator, for the owner, picked q1");
      yield* kanban.dispatchNow;
      assert.strictEqual((yield* kanban.card(card.id)).card.activeThreadId, threadId);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("an evaluator gives a handed ask back to the owner", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, card, worker } = yield* workingCard();
      yield* kanban.askOwner(
        card.id,
        { question: "Budget?", blocking: false },
        worker,
        "cardThread",
      );
      yield* kanban.handAsk(card.id, "q1", "hand", owner);
      const [evaluator] = yield* fake.evaluators;
      const evaluatorActor: KanbanActor = { _tag: "evaluator", threadId: evaluator!.threadId };
      const returned = yield* kanban.handAsk(card.id, "q1", "return", evaluatorActor);
      assert.strictEqual(kanbanAskWaitsOn(askOf(returned)), "owner");
      assert.isNull(askOf(returned).closedAt);
      const notHanded = yield* kanban
        .handAsk(card.id, "q1", "return", evaluatorActor)
        .pipe(Effect.flip);
      assert.include(notHanded.detail, "not with the evaluator");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("an edited ask from before messages carried askId keeps its first message", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard();
      const sql = yield* SqlClient.SqlClient;
      const asker: KanbanActor = { _tag: "evaluator", threadId: ThreadId.make("evaluator-main") };
      const card = yield* kanban.createCard(board.id, { prompt: "Ship", title: "Ship" }, owner);
      const asked = yield* kanban.askOwner(
        card.id,
        { question: "Ship tonight?", blocking: false },
        asker,
        "evaluator",
      );
      const firstSeq = askOf(asked).seq!;
      // The way asks were stored before this branch: no askId on the message that asked.
      yield* sql`UPDATE ardud_kanban_messages SET json = json_remove(json, '$.askId')`;
      const before = (yield* kanban.askFeed({})).open[0]!;
      assert.deepStrictEqual(
        before.messages.map((message) => [message.seq, message.askId]),
        [[firstSeq, undefined]],
      );

      const edited = yield* kanban.editAsk(
        card.id,
        "q1",
        { question: "Ship to staging tonight?", revisionNote: "Said where" },
        asker,
        "evaluator",
      );
      const ask = askOf(edited);
      assert.strictEqual(ask.firstSeq, firstSeq);
      assert.isAbove(ask.seq!, firstSeq);
      const after = (yield* kanban.askFeed({})).open[0]!;
      assert.deepStrictEqual(
        after.messages.map((message) => [message.seq, message.askId]),
        [
          [firstSeq, undefined],
          [ask.seq!, "q1"],
        ],
      );

      // A second edit keeps pointing at the first message, not at the version in between.
      const again = yield* kanban.editAsk(
        card.id,
        "q1",
        { title: "Staging go", revisionNote: "Titled" },
        asker,
        "evaluator",
      );
      assert.strictEqual(askOf(again).firstSeq, firstSeq);
      assert.strictEqual((yield* kanban.askFeed({})).open[0]!.messages.length, 3);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect(
  "a batch answer with a note tells each card once, and a stale item doesn't hold the rest",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { kanban, board } = yield* toyBoard();
          yield* kanban.setPool(board.id, board.defaultCardModel, 3);
          const http = yield* makeHttp;
          const note = "After 6pm only.";
          const workers: Array<{ id: KanbanCard["id"]; threadId: ThreadId }> = [];
          for (const title of ["Deploy A", "Deploy B", "Deploy C"]) {
            const card = yield* kanban.createCard(board.id, { prompt: title, title }, owner);
            yield* kanban.dispatchNow;
            const threadId = (yield* kanban.card(card.id)).card.activeThreadId!;
            yield* kanban.askOwner(
              card.id,
              {
                question: `Deploy ${title}?`,
                blocking: true,
                action: { summary: `Deploy ${title}`, command: "make deploy" },
                batchKey: "deploy-go",
              },
              { _tag: "thread", threadId },
              "cardThread",
            );
            workers.push({ id: card.id, threadId });
          }
          // The third was revised after the list the owner answers from was read.
          yield* kanban.editAsk(
            workers[2]!.id,
            "q1",
            { action: { summary: "Deploy C, build 42" }, revisionNote: "Newer build" },
            { _tag: "evaluator", threadId: ThreadId.make("evaluator-main") },
            "evaluator",
          );

          const batch = yield* http.post("/asks/answer", {
            verdict: "approved",
            note,
            items: [
              { card: "toy:1", askId: "q1", revision: 0 },
              { card: "toy:3", askId: "q1", revision: 0 },
              { card: "toy:2", askId: "q1", revision: 0 },
            ],
          });
          assert.strictEqual(batch.status, 200);
          assert.strictEqual(batch.body.answered, 2);
          assert.deepStrictEqual(
            batch.body.results.map((result: Record<string, any>) => [
              result.card,
              result.ok,
              result.stage,
              result.error?.code,
            ]),
            [
              ["toy:1", true, "todo", undefined],
              ["toy:3", false, undefined, "conflict"],
              ["toy:2", true, "todo", undefined],
            ],
          );
          assert.include(
            batch.body.results[1].error.message,
            "revision 1, you answered revision 0",
          );

          // Each answered card carries the verdict and the note once, for its own ask.
          const occurrences = (text: string, part: string) => text.split(part).length - 1;
          for (const [index, title] of [
            [0, "Deploy A"],
            [1, "Deploy B"],
          ] as const) {
            const card = (yield* kanban.card(workers[index]!.id)).card;
            assert.strictEqual(
              card.wakeNote,
              `The owner APPROVED q1 on card #${card.number}: "Deploy ${title}?".\n\n` +
                `Owner's note, read this before you act:\n${note}`,
            );
            assert.strictEqual(askOf(card).answer?.note, note);
          }
          // The stale one is untouched: still open, still holding its card.
          const stale = (yield* kanban.card(workers[2]!.id)).card;
          assert.strictEqual(stale.stage, "needs_owner");
          assert.isNull(askOf(stale).closedAt);
          assert.isNull(stale.wakeNote);

          // Each worker is woken with its own card's note, once, and the third hears nothing.
          yield* kanban.dispatchNow;
          for (const index of [0, 1]) {
            const heard = (yield* fake.heard(workers[index]!.threadId)).join("\n---\n");
            assert.strictEqual(occurrences(heard, note), 1, heard);
            assert.strictEqual(occurrences(heard, "The owner APPROVED q1"), 1, heard);
          }
          const quiet = (yield* fake.heard(workers[2]!.threadId)).join("\n");
          assert.strictEqual(occurrences(quiet, note), 0);
        }),
      ).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect("the HTTP routes: feed shape, single answer, batch answer, reply and hand", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const { kanban, board } = yield* toyBoard();
        const http = yield* makeHttp;
        const asker: KanbanActor = { _tag: "evaluator", threadId: ThreadId.make("evaluator-main") };
        const deploy = yield* kanban.createCard(
          board.id,
          { prompt: "Deploy", title: "Deploy A" },
          owner,
        );
        const other = yield* kanban.createCard(
          board.id,
          { prompt: "Deploy", title: "Deploy B" },
          owner,
        );
        const waiter = yield* kanban.createCard(
          board.id,
          { prompt: "After", title: "After A" },
          owner,
        );
        yield* kanban.editCard(waiter.id, { blockedBy: [deploy.id] }, owner);
        for (const card of [deploy, other]) {
          yield* kanban.askOwner(
            card.id,
            {
              question: "Go?",
              blocking: true,
              title: `Deploy go for ${card.title}`,
              action: {
                summary: "Deploy",
                command: "make deploy",
                undo: "make rollback",
                evidence: ["CI green"],
              },
              batchKey: "deploy-go",
            },
            asker,
            "evaluator",
          );
        }
        yield* kanban.askOwner(
          other.id,
          { question: "Name?", blocking: false },
          asker,
          "evaluator",
        );

        const feed = yield* http.get("/asks");
        assert.strictEqual(feed.status, 200);
        const body = feed.body as unknown as KanbanAskFeed;
        assert.deepStrictEqual(
          body.open.map((item) => [
            item.cardRef,
            item.ask.id,
            item.kind,
            item.blocks,
            item.waitsOn,
          ]),
          [
            ["toy:1", "q1", "action", 1, "owner"],
            ["toy:2", "q1", "action", 0, "owner"],
            ["toy:2", "q2", "question", 0, "owner"],
          ],
        );
        const first = body.open[0]!;
        assert.deepStrictEqual(
          {
            boardId: first.boardId,
            boardSlug: first.boardSlug,
            boardName: first.boardName,
            cardId: first.cardId,
            cardNumber: first.cardNumber,
            cardTitle: first.cardTitle,
            stage: first.stage,
            priority: first.priority,
            revision: first.revision,
            expired: first.expired,
          },
          {
            boardId: board.id,
            boardSlug: "toy",
            boardName: "Toy",
            cardId: deploy.id,
            cardNumber: 1,
            cardTitle: "Deploy A",
            stage: "needs_owner",
            priority: deploy.priority,
            revision: 0,
            expired: false,
          },
        );
        assert.strictEqual(first.ask.batchKey, "deploy-go");
        assert.deepStrictEqual(first.ask.action, {
          summary: "Deploy",
          command: "make deploy",
          evidence: ["CI green"],
          undo: "make rollback",
        });
        assert.strictEqual(first.messages.length, 1);
        assert.strictEqual(first.messages[0]!.askId, "q1");
        assert.deepStrictEqual(body.closed, []);
        assert.strictEqual((yield* http.get("/asks?board=toy")).body.open.length, 3);
        assert.strictEqual((yield* http.get("/asks?board=nope")).status, 404);
        assert.strictEqual((yield* http.get("/asks?closed=soon")).status, 400);

        // One answer: a stale revision is a 409, the right one closes it.
        const stale = yield* http.post("/cards/toy:2/asks/q2/answer", {
          verdict: "answered",
          text: "Orion",
          revision: 3,
        });
        assert.strictEqual(stale.status, 409);
        assert.strictEqual(stale.body.error.code, "conflict");
        const single = yield* http.post("/cards/toy:2/asks/q2/answer", {
          verdict: "answered",
          text: "Orion",
          note: "Keep it lowercase in code.",
          revision: 0,
        });
        assert.strictEqual(single.status, 200);
        assert.strictEqual(single.body.ask.answer.verdict, "answered");
        assert.strictEqual(single.body.ask.answer.text, "Orion");
        assert.strictEqual(single.body.card.stage, "needs_owner");
        assert.strictEqual(
          (yield* http.post("/cards/toy:2/asks/q9/answer", { verdict: "approved" })).status,
          404,
        );
        assert.strictEqual(
          (yield* http.post("/cards/toy:2/asks/q1/answer", { verdict: "maybe" })).status,
          400,
        );

        // A batch: both deploy asks with one verdict and note; a bad item doesn't hold the rest.
        const batch = yield* http.post("/asks/answer", {
          verdict: "approved",
          note: "After 6pm only.",
          items: [
            { card: "toy:1", askId: "q1", revision: 0 },
            { card: "toy:2", askId: "q1" },
            { card: "toy:2", askId: "q2" },
          ],
        });
        assert.strictEqual(batch.status, 200);
        assert.strictEqual(batch.body.answered, 2);
        assert.deepStrictEqual(
          batch.body.results.map((result: Record<string, any>) => [
            result.card,
            result.askId,
            result.ok,
            result.error?.code,
          ]),
          [
            ["toy:1", "q1", true, undefined],
            ["toy:2", "q1", true, undefined],
            ["toy:2", "q2", false, "conflict"],
          ],
        );
        for (const id of [deploy.id, other.id]) {
          const card = (yield* kanban.card(id)).card;
          assert.strictEqual(card.stage, "todo");
          assert.strictEqual(askOf(card).answer?.note, "After 6pm only.");
        }
        assert.strictEqual(
          (yield* http.post("/asks/answer", { verdict: "approved", items: [] })).status,
          400,
        );

        // The closed window lists what was just answered, newest first, and nothing is open.
        const history = (yield* http.get("/asks?closed=1h")).body as unknown as KanbanAskFeed;
        assert.deepStrictEqual(history.open, []);
        assert.strictEqual(history.closed.length, 3);
        assert.isTrue(
          history.closed.every((item) => item.waitsOn === null && item.ask.answer !== undefined),
        );
        assert.strictEqual(
          (yield* http.get("/asks?closed=2999-01-01T00:00:00.000Z")).body.closed.length,
          0,
        );

        // Reply and hand over HTTP.
        yield* kanban.askOwner(
          other.id,
          { question: "Color?", blocking: false, options: ["Red", "Blue"] },
          asker,
          "evaluator",
        );
        const reply = yield* http.post("/cards/toy:2/asks/q3/reply", { text: "Which shade?" });
        assert.strictEqual(reply.status, 200);
        assert.strictEqual(reply.body.askId, "q3");
        assert.strictEqual(
          kanbanAskWaitsOn(askOf((yield* kanban.card(other.id)).card, "q3")),
          "agent",
        );
        const hand = yield* http.post("/cards/toy:2/asks/q3/hand", {});
        assert.strictEqual(hand.status, 200);
        assert.isString(hand.body.ask.handedAt);
        const detail = yield* http.get("/cards/toy:2/asks/q3");
        assert.strictEqual(detail.status, 200);
        assert.strictEqual(detail.body.ask.id, "q3");
        assert.strictEqual(detail.body.cardNumber, 2);
        const waiting = (yield* http.get("/asks")).body as unknown as KanbanAskFeed;
        assert.deepStrictEqual(
          waiting.open.map((item) => [item.ask.id, item.waitsOn]),
          [["q3", "evaluator"]],
        );
        const taken = yield* http.post("/cards/toy:2/asks/q3/hand", { action: "take_back" });
        assert.isUndefined(taken.body.ask.handedAt);
      }),
    ).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);
