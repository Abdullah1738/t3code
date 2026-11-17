import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeFake, makeHttpAs, testLayer, workingCard } from "./askFlows.testkit.ts";

it.effect("HTTP card PATCH accepts exact edits and comments from board scripts", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const { kanban, card } = yield* workingCard("Haiku writer\nKept line");
        const http = yield* makeHttpAs({ _tag: "component", component: "t3ctl" });
        const patched = yield* http.request("PATCH", "/cards/toy:1", {
          promptEdits: [{ oldString: "Haiku", newString: "$& Sonnet" }],
          comment: "Writer updated",
        });
        assert.strictEqual(patched.status, 200);
        assert.strictEqual(patched.body.id, card.id);
        assert.strictEqual(patched.body.prompt, "$& Sonnet writer\nKept line");
        const saved = yield* kanban.card(card.id);
        assert.strictEqual(saved.card.prompt, patched.body.prompt);
        assert.strictEqual(saved.events.at(-1)?.body, "Writer updated");
        yield* kanban.editCard(
          card.id,
          { subtasks: [{ text: "old writer", owner: "work" }] },
          { _tag: "owner" },
        );
        const plan = yield* http.request("PATCH", `/cards/${card.id}`, {
          subtaskEdits: [{ oldString: "old", newString: "new" }],
        });
        assert.strictEqual(plan.status, 200);
        assert.strictEqual(plan.body.subtasks[0].text, "new writer");
        const comment = yield* http.request("PATCH", `/cards/${card.id}`, {
          comment: "Comment only",
        });
        assert.strictEqual(comment.status, 200);
        assert.strictEqual((yield* kanban.card(card.id)).events.at(-1)?.body, "Comment only");
      }),
    ).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("HTTP card PATCH refuses empty bodies, extra fields and invalid edits atomically", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const { kanban, card } = yield* workingCard("one two two");
        const http = yield* makeHttpAs({ _tag: "component", component: "t3ctl" });
        const before = yield* kanban.card(card.id);
        for (const body of [
          undefined,
          {},
          { prompt: "replacement" },
          { title: "new" },
          { subtasks: [] },
          { promptEdits: [{ oldString: "one", newString: "new" }], priority: 1 },
          { comment: "Must not save", prompt: "new" },
          { promptEdits: [] },
          { promptEdits: [{ oldString: "", newString: "new" }] },
          { promptEdits: [{ oldString: "one", newString: "new", count: 0 }] },
          { promptEdits: [{ oldString: "one", newString: "new", extra: true }] },
          {
            promptEdits: [
              { oldString: "one", newString: "new" },
              { oldString: "two", newString: "x" },
            ],
            comment: "Must not save",
          },
          {
            promptEdits: [{ oldString: "one", newString: "new" }],
            subtaskEdits: [{ oldString: "missing", newString: "x" }],
          },
        ]) {
          const result = yield* http.request("PATCH", `/cards/${card.id}`, body);
          assert.strictEqual(result.status, 400, JSON.stringify(body));
          assert.strictEqual(result.body.error.code, "invalid");
          assert.deepStrictEqual(yield* kanban.card(card.id), before);
        }
      }),
    ).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);
