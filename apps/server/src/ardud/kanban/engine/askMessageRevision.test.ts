/** An ask's own messages say which revision of it they show, so a client can tell an older version without guessing. */
import { assert, it } from "@effect/vitest";
import { ThreadId, kanbanAskRevision, type KanbanActor } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { askOf, makeFake, makeHttp, owner, testLayer, workingCard } from "./askFlows.testkit.ts";

const evaluator: KanbanActor = { _tag: "evaluator", threadId: ThreadId.make("evaluator-main") };

it.effect("the ask as asked is revision 0, each edit is the next one, and replies carry none", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const { kanban, card, worker } = yield* workingCard();
        yield* kanban.askOwner(
          card.id,
          { question: "Deploy tonight?", blocking: true, action: { summary: "Deploy build 41" } },
          worker,
          "cardThread",
        );
        const discussion = yield* kanban.cardDiscussion(card.id);
        const asked = askOf((yield* kanban.card(card.id)).card);
        assert.deepInclude(yield* kanban.message(discussion.id, asked.seq!), {
          askId: "q1",
          askRevision: 0,
        });

        // Replies on the ask, his and the agent's, belong to it and are not a version of it.
        const his = yield* kanban.replyOnAsk(
          card.id,
          "q1",
          owner,
          [{ _tag: "md", text: "Which build?" }],
          "owner",
        );
        assert.strictEqual(his.askId, "q1");
        assert.notProperty(his, "askRevision");
        const reply = yield* kanban.replyOnAsk(
          card.id,
          "q1",
          evaluator,
          [{ _tag: "md", text: "Build 42 now." }],
          "evaluator",
        );
        assert.notProperty(reply, "askRevision");

        // Two edits: each new version says its revision, and the earlier ones keep theirs.
        for (const build of [42, 43]) {
          yield* kanban.editAsk(
            card.id,
            "q1",
            { action: { summary: `Deploy build ${build}` }, revisionNote: "Newer build" },
            evaluator,
            "evaluator",
          );
        }
        const ask = askOf((yield* kanban.card(card.id)).card);
        assert.strictEqual(kanbanAskRevision(ask), 2);
        const http = yield* makeHttp;
        const listed = yield* http.get(`/discussions/${discussion.id}/messages`);
        const messages = listed.body as unknown as ReadonlyArray<Record<string, any>>;
        const versions = messages.filter((message) => message.askRevision !== undefined);
        assert.deepStrictEqual(
          versions.map((message) => [message.askId, message.askRevision]),
          [
            ["q1", 0],
            ["q1", 1],
            ["q1", 2],
          ],
        );
        // The current one is the message the ask points at; the rest are superseded.
        assert.strictEqual(versions.at(-1)!.seq, ask.seq);
        assert.deepStrictEqual(
          versions
            .filter((message) => message.askRevision < kanbanAskRevision(ask))
            .map((message) => message.seq),
          [asked.seq, versions[1]!.seq],
        );

        // A message that is not on an ask has neither field.
        const plain = yield* kanban.post(discussion.id, evaluator, [
          { _tag: "md", text: "Status: waiting on him." },
        ]);
        assert.notProperty(plain, "askId");
        assert.notProperty(plain, "askRevision");
      }),
    ).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);
