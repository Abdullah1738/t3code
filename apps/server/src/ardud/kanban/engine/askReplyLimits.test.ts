/** A reply on an ask is held to the ask's sizes, from an agent and from the owner. */
import { assert, it } from "@effect/vitest";
import { kanbanAskWaitsOn, type KanbanBlock } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { ASK_LIMITS } from "./asks.ts";
import {
  askOf,
  makeFake,
  makeHttp,
  owner,
  testLayer,
  workingCard,
  writePending,
} from "./askFlows.testkit.ts";

const md = (text: string): KanbanBlock => ({ _tag: "md", text });
/** Each reply that is too much, and what the refusal says. */
const tooMuch = (
  files: ReadonlyArray<KanbanBlock>,
): ReadonlyArray<readonly [string, ReadonlyArray<KanbanBlock>, string]> => [
  [
    "more blocks than an ask shows",
    Array.from({ length: ASK_LIMITS.blocks + 1 }, (_, index) => md(`Line ${index}`)),
    `a reply on an ask takes at most ${ASK_LIMITS.blocks} blocks (got ${ASK_LIMITS.blocks + 1})`,
  ],
  [
    "more files than an ask shows",
    files,
    `a reply on an ask takes at most ${ASK_LIMITS.attachments} images and files (got ${files.length})`,
  ],
  [
    "a page over the html limit",
    [
      {
        _tag: "html",
        html: `<p>${"x".repeat(ASK_LIMITS.htmlBytes)}</p>`,
        title: "Big",
        height: null,
      },
    ],
    `an html block on a reply on an ask is at most ${ASK_LIMITS.htmlBytes / 1024} KB`,
  ],
  [
    "a text block over the text limit",
    [md("y".repeat(ASK_LIMITS.blockText + 1))],
    `a md block is at most ${ASK_LIMITS.blockText} characters`,
  ],
];

it.effect(
  "a reply on an ask over the ask's limits is refused, from an agent and from the owner",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { kanban, card, worker } = yield* workingCard();
          const http = yield* makeHttp;
          yield* kanban.askOwner(
            card.id,
            { question: "Deploy?", blocking: false, action: { summary: "Deploy build 42" } },
            worker,
            "cardThread",
          );
          const discussion = yield* kanban.cardDiscussion(card.id);
          const before = (yield* kanban.cardDiscussion(card.id)).lastSeq;

          // Real uploads, one more than an ask shows.
          const files: Array<KanbanBlock> = [];
          for (let index = 0; index <= ASK_LIMITS.attachments; index += 1) {
            files.push({
              _tag: "attachment",
              attachment: yield* writePending(`${index}.pdf`, "application/pdf", `%PDF ${index}`),
            });
          }
          for (const [name, blocks, says] of tooMuch(files)) {
            const fromAgent = yield* kanban
              .replyOnAsk(card.id, "q1", worker, blocks, "cardThread")
              .pipe(Effect.flip);
            assert.deepStrictEqual([name, fromAgent.code], [name, "invalid"]);
            assert.include(fromAgent.detail, says, name);
            const fromOwner = yield* kanban
              .replyOnAsk(card.id, "q1", owner, blocks, "owner")
              .pipe(Effect.flip);
            assert.deepStrictEqual([name, fromOwner.code], [name, "invalid"]);
            assert.include(fromOwner.detail, says, name);
            // The owner's route says the same.
            const overHttp = yield* http.post("/cards/toy:1/asks/q1/reply", { blocks });
            assert.strictEqual(overHttp.status, 400, name);
            assert.include(overHttp.body.error.message, says, name);
          }
          // Nothing was posted, and the ask is still his to answer.
          assert.strictEqual((yield* kanban.cardDiscussion(card.id)).lastSeq, before);
          assert.strictEqual(discussion.id, (yield* kanban.cardDiscussion(card.id)).id);
          assert.strictEqual(kanbanAskWaitsOn(askOf((yield* kanban.card(card.id)).card)), "owner");

          // At the limits it goes through.
          const full = [
            ...Array.from({ length: ASK_LIMITS.blocks - 1 }, (_, index) => md(`Line ${index}`)),
            {
              _tag: "html" as const,
              html: "z".repeat(ASK_LIMITS.htmlBytes),
              title: "Page",
              height: null,
            },
          ];
          const reply = yield* kanban.replyOnAsk(card.id, "q1", owner, full, "owner");
          assert.strictEqual(reply.blocks.length, ASK_LIMITS.blocks);
          assert.strictEqual(kanbanAskWaitsOn(askOf((yield* kanban.card(card.id)).card)), "agent");
        }),
      ).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);
