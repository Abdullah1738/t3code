import { assert, it } from "@effect/vitest";
import { AnalyticsEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Analytics from "../../analytics/Analytics.ts";
import { makeFake, owner, testLayer, toyBoard } from "./askFlows.testkit.ts";

it.effect.each(["direct", "inherited", "review"] as const)(
  "dispatches effective-P1 %s work through validation and records overflow takes",
  (kind) =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      const events: AnalyticsEvent[] = [];
      const analytics = Layer.mock(Analytics.Analytics)({
        record: (event) =>
          Schema.decodeUnknownEffect(AnalyticsEvent, { onExcessProperty: "error" })(event).pipe(
            Effect.orDie,
            Effect.tap((decoded) =>
              Effect.sync(() => {
                events.push(decoded);
              }),
            ),
            Effect.asVoid,
          ),
      });
      yield* Effect.gen(function* () {
        const { kanban, board } = yield* toyBoard();
        yield* kanban.setPool(board.id, board.defaultCardModel, 1);
        const running = yield* kanban.createCard(
          board.id,
          { title: "Routine", prompt: "Routine", priority: 3 },
          owner,
        );
        yield* kanban.dispatchNow;
        const first = (yield* kanban.card(running.id)).card;
        assert.isNotNull(first.activeThreadId);
        const urgent = yield* kanban.createCard(
          board.id,
          { title: "Urgent", prompt: "Urgent", priority: kind === "inherited" ? 3 : 1 },
          owner,
        );
        if (kind === "inherited")
          yield* kanban.createCard(
            board.id,
            { title: "Blocked P1", prompt: "Blocked P1", priority: 1, blockedBy: [urgent.id] },
            owner,
          );
        if (kind === "review") yield* kanban.moveCard(urgent.id, "needs_review", "owner", owner);
        const waiting = yield* kanban.createCard(
          board.id,
          { title: "P2", prompt: "P2", priority: 2 },
          owner,
        );
        yield* kanban.dispatchNow;
        const started = (yield* kanban.card(urgent.id)).card;
        assert.strictEqual(started.stage, kind === "review" ? "in_review" : "working");
        assert.isNotNull(started.activeThreadId);
        assert.notStrictEqual(started.activeThreadId, first.activeThreadId);
        assert.strictEqual((yield* kanban.card(waiting.id)).card.stage, "todo");
        assert.strictEqual(
          (yield* kanban.card(running.id)).card.activeThreadId,
          first.activeThreadId,
        );
        const overflow = events.filter((event) => event.props?.overflow === true);
        assert.deepStrictEqual(overflow.map((event) => event.kind).sort(), [
          "kanban.dispatch",
          "kanban.slot",
        ]);
        for (const event of overflow) {
          assert.strictEqual(event.cardId, urgent.id);
          assert.strictEqual(event.props?.slots, 1);
          assert.strictEqual(event.props?.used, 2);
        }
        assert.strictEqual(
          overflow.find((event) => event.kind === "kanban.slot")?.props?.slot,
          "take",
        );
      }).pipe(Effect.provide(testLayer(fake.layer).pipe(Layer.provide(analytics))));
    }),
);
