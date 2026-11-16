import { assert, it } from "@effect/vitest";
import {
  KanbanWait,
  MessageId,
  RunId,
  type KanbanCard,
  type ModelSelection,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as KanbanStore from "../store/KanbanStore.ts";
import { makeFake, owner, testLayer, workingCard } from "./askFlows.testkit.ts";
import { KanbanThreads } from "./threads.ts";

type Boundary = {
  read:
    | "card"
    | "threadLink"
    | "cardEvents"
    | "board"
    | "cardsByThread"
    | "queuedRuns"
    | "threadCards"
    | "view";
  occurrence: number;
};
type Scenario = "clear" | "findings" | "late" | "replay" | "refused" | "merged" | "open";
const decodeWait = Schema.decodeUnknownEffect(KanbanWait);

const review = Effect.fn("test.reviewResult")(function* (
  boundary: Boundary | undefined,
  scenario: Scenario,
  change: "other" | "target" | "leave" = "other",
) {
  const fake = yield* makeFake;
  const entered = yield* Deferred.make<void>();
  const resume = yield* Deferred.make<void>();
  let target: KanbanCard["id"] | undefined;
  let reviewer: ThreadId | undefined;
  let workThread: ThreadId | undefined;
  let reads = 0;
  let armed = false;
  let recordingFiber: number | undefined;
  let writing = false;
  let cardReads = 0;
  const latch = <A, E, R>(name: Boundary["read"], matches: boolean, read: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      if ((yield* Effect.fiberId) === recordingFiber) {
        assert.isFalse(writing, `Reader ${name} ran after event persistence started`);
        if (name === "card" && matches) cardReads += 1;
      }
      const snapshot = yield* read;
      if (armed && matches && name === boundary?.read && ++reads === boundary.occurrence) {
        armed = false;
        yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(resume);
      }
      return snapshot;
    });
  const slowStore = Layer.effect(
    KanbanStore.KanbanStore,
    Effect.map(KanbanStore.KanbanStore, (real) => ({
      ...real,
      board: (id) => latch("board", true, real.board(id)),
      cardsByThread: (id) => latch("cardsByThread", true, real.cardsByThread(id)),
      threadCards: (id) => latch("threadCards", id === workThread, real.threadCards(id)),
      addCardEvent: (...args: Parameters<typeof real.addCardEvent>) =>
        Effect.gen(function* () {
          if ((yield* Effect.fiberId) === recordingFiber) writing = true;
          return yield* real.addCardEvent(...args);
        }),
      card: (id: KanbanCard["id"]) => latch("card", id === target, real.card(id)),
      threadLink: (id: string) => latch("threadLink", id === reviewer, real.threadLink(id)),
      cardEvents: (id: KanbanCard["id"]) => latch("cardEvents", id === target, real.cardEvents(id)),
    })),
  ).pipe(Layer.provide(KanbanStore.layer));
  const threads = yield* KanbanThreads.pipe(Effect.provide(fake.layer));
  const slowThreads = Layer.succeed(KanbanThreads, {
    ...threads,
    queuedRuns: (id) => latch("queuedRuns", id === reviewer, threads.queuedRuns(id)),
    view: (id) =>
      latch("view", id === workThread, threads.view(id)).pipe(
        Effect.map((view) =>
          view && id === workThread && (scenario === "merged" || scenario === "open")
            ? {
                ...view,
                prs: [{ url: "https://github.com/o/r/pull/1663", title: "Fix", state: scenario }],
              }
            : view,
        ),
      ),
  });
  return yield* Effect.gen(function* () {
    const { kanban, board, card, worker, threadId } = yield* workingCard();
    yield* kanban.editCard(card.id, { subtasks: [{ text: "Review", owner: "review" }] }, owner);
    yield* kanban.moveCard(card.id, "needs_review", "cardThread", worker);
    yield* kanban.turnEnded(threadId);
    yield* kanban.dispatchNow;
    target = card.id;
    reviewer = (yield* kanban.card(card.id)).card.activeThreadId!;
    assert.equal((yield* kanban.card(card.id)).card.stage, "in_review");
    if (scenario === "late")
      yield* kanban.flagCard(card.id, "Review interrupted", { _tag: "thread", threadId: reviewer });
    if (scenario === "replay") yield* kanban.reviewResult(reviewer, "clear", [], "abc1234");
    const other = yield* kanban.createCard(board.id, { title: "Other", prompt: "Other" }, owner);
    workThread = threadId;
    if (scenario === "merged") {
      const store = yield* KanbanStore.KanbanStore;
      const current = (yield* store.card(card.id))!;
      yield* store.putCard({
        ...current,
        wait: yield* decodeWait({
          on: "card",
          card: other.id,
          note: "Evaluator read-back",
          by: owner,
          at: current.updatedAt,
        }),
      });
    }
    const edit =
      change === "leave"
        ? kanban.moveCard(card.id, "todo", "owner", owner)
        : kanban.editCard(
            change === "target" ? card.id : other.id,
            { description: "Concurrent edit" },
            owner,
          );
    if (!boundary) yield* edit;
    armed = boundary !== undefined;
    const reviewThread = reviewer;
    const recording = yield* Effect.forkChild(
      Effect.gen(function* () {
        recordingFiber = yield* Effect.fiberId;
        return yield* Effect.result(
          kanban.reviewResult(
            reviewThread,
            scenario === "findings" ? "findings" : "clear",
            scenario === "findings" ? ["Fix queue ordering"] : [],
            scenario === "refused" ? "invalid head" : " ABC1234 ",
          ),
        );
      }),
    );
    if (boundary) {
      yield* Deferred.await(entered);
      // The old implementation deadlocks here until the runner deadline: the
      // same-board edit must finish while the snapshot read remains latched.
      yield* edit;
      assert.isUndefined(recording.pollUnsafe());
      yield* Deferred.succeed(resume, undefined);
    }
    const result = yield* Fiber.join(recording);
    if (scenario === "clear" && change !== "leave") {
      assert.isAtLeast(cardReads, 1);
      assert.isAtMost(
        cardReads,
        boundary ? 2 : 1,
        "event insertion and saveCard must reuse the checked card",
      );
    }
    const detail = yield* kanban.card(card.id);
    const reviews = detail.events.filter((event) => event.kind === "review");
    const refused = detail.events.filter((event) =>
      event.body?.startsWith("Review verdict refused:"),
    );
    if (scenario === "refused" || change === "leave") {
      assert.equal(result._tag, "Failure");
      assert.lengthOf(reviews, 0);
    } else {
      assert.equal(result._tag, "Success");
      if (result._tag === "Success") assert.equal(result.success.recorded, scenario !== "replay");
      assert.lengthOf(reviews, 1);
      assert.equal(reviews[0]!.head, "abc1234");
      assert.equal(
        detail.card.stage,
        scenario === "findings" ? "todo" : scenario === "open" ? "in_review" : "completed",
      );
      assert.equal(detail.card.subtasks[0]!.state, scenario === "findings" ? "open" : "done");
    }
    if (scenario === "merged" || scenario === "open") {
      assert.equal(detail.card.links[0]?.state, scenario);
      assert.equal(
        detail.events.some((event) => event.body === "review clear and PRs merged"),
        scenario === "merged",
      );
    }
    if (scenario === "merged") assert.equal(detail.card.wait?.card, other.id);
    if (change !== "leave")
      assert.equal(
        (yield* kanban.card(change === "target" ? card.id : other.id)).card.description,
        "Concurrent edit",
      );
    return {
      stage: detail.card.stage,
      subtasks: detail.card.subtasks.map(({ state }) => state),
      reviews: reviews.map(({ kind, fromStage, toStage, head, body }) => ({
        kind,
        fromStage,
        toStage,
        head,
        body,
      })),
      refusals: refused.map(({ body, head }) => ({ body, head })),
      result: result._tag === "Success" ? result.success.recorded : result.failure.detail,
      reads,
    };
  }).pipe(
    Effect.provide(testLayer(slowThreads, slowStore)),
    Effect.ensuring(Deferred.succeed(resume, undefined)),
  );
});

it.effect.each([
  ...(["card", "board", "cardsByThread", "queuedRuns"] as const).map((read) => ({
    boundary: { read, occurrence: 1 },
    scenario: "clear" as const,
  })),
  { boundary: { read: "threadLink", occurrence: 2 } as Boundary, scenario: "findings" as const },
  { boundary: { read: "threadCards", occurrence: 1 } as Boundary, scenario: "merged" as const },
  { boundary: { read: "view", occurrence: 1 } as Boundary, scenario: "open" as const },
  ...(["late", "replay", "refused"] as const).map((scenario) => ({
    boundary: { read: "cardEvents", occurrence: 1 } as Boundary,
    scenario,
  })),
])("reviewResult releases $boundary for card_update ($scenario)", ({ boundary, scenario }) =>
  Effect.gen(function* () {
    const baseline = yield* review(undefined, scenario);
    const concurrent = yield* review(boundary, scenario);
    assert.deepEqual({ ...concurrent, reads: 0 }, baseline);
  }),
);

it.effect.each(["target", "leave"] as const)(
  "reviewResult rereads its snapshot after a concurrent %s change",
  (change) =>
    Effect.gen(function* () {
      const baseline = yield* review(undefined, "clear", change);
      const concurrent = yield* review({ read: "card", occurrence: 1 }, "clear", change);
      assert.deepEqual({ ...concurrent, reads: 0 }, baseline);
    }),
);

it.effect("card_update appends its event while the old logEvent card reader is latched", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    const entered = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    let armed = false;
    const blocked = Layer.effect(
      KanbanStore.KanbanStore,
      Effect.map(KanbanStore.KanbanStore, (real) => ({
        ...real,
        card: (id: KanbanCard["id"]) =>
          Effect.gen(function* () {
            const span = yield* Effect.currentSpan.pipe(Effect.orElseSucceed(() => null));
            if (armed && span?.name === "KanbanService.logEvent") {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(resume);
            }
            return yield* real.card(id);
          }),
      })),
    ).pipe(Layer.provide(KanbanStore.layer));
    yield* Effect.gen(function* () {
      const { kanban, board, card } = yield* workingCard();
      const other = yield* kanban.createCard(board.id, { title: "Other", prompt: "Other" }, owner);
      armed = true;
      const saved = yield* kanban.editCard(
        card.id,
        { description: "Updated", comment: "Event with known card" },
        owner,
      );
      assert.equal(saved.description, "Updated");
      yield* kanban.editCard(other.id, { description: "Also committed" }, owner);
      assert.isFalse(yield* Deferred.isDone(entered));
      yield* Deferred.succeed(resume, undefined);
      const after = yield* kanban.card(card.id);
      assert.lengthOf(
        after.events.filter((event) => event.body === "Event with known card"),
        1,
      );
    }).pipe(
      Effect.provide(testLayer(fake.layer, blocked)),
      Effect.ensuring(Deferred.succeed(resume, undefined)),
    );
  }),
);

it.effect.each(
  (["status before cancel", "status after cancel"] as const).flatMap((status) =>
    (["other", "leave", "timeout"] as const).flatMap((change) =>
      (["clear", "findings"] as const).map((verdict) => ({ status, change, verdict })),
    ),
  ),
)("reviewResult releases the gate for $status ($verdict, $change)", ({ status, change, verdict }) =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    const threads = yield* KanbanThreads.pipe(Effect.provide(fake.layer));
    const entered = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    let reviewer: ThreadId | undefined;
    let model: ModelSelection | undefined;
    let cancelled = false;
    const cancelledIds: string[] = [];
    const slow = Layer.succeed(KanbanThreads, {
      ...threads,
      queuedRuns: (id) =>
        Effect.succeed(
          id === reviewer && !cancelled
            ? [
                {
                  id: RunId.make("old-wake"),
                  threadId: id,
                  ordinal: 1,
                  providerInstanceId: model!.instanceId,
                  modelSelection: model!,
                  providerThreadId: null,
                  userMessageId: MessageId.make("kanban:wake:nudge:old"),
                  rootNodeId: null,
                  activeAttemptId: null,
                  status: "queued" as const,
                  requestedAt: DateTime.makeUnsafe("2026-11-15T00:00:00.000Z"),
                  startedAt: null,
                  completedAt: null,
                  checkpointId: null,
                  contextHandoffId: null,
                },
              ]
            : [],
        ),
      cancelQueued: (_id, runId) =>
        Effect.gen(function* () {
          cancelledIds.push(runId);
          if (status === "status after cancel") cancelled = true;
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(resume);
          cancelled = true;
          return true;
        }).pipe(Effect.uninterruptible),
    });
    yield* Effect.gen(function* () {
      const { kanban, board, card, worker, threadId } = yield* workingCard();
      if (change !== "leave")
        yield* kanban.editCard(card.id, { subtasks: [{ text: "Review", owner: "review" }] }, owner);
      yield* kanban.moveCard(card.id, "needs_review", "cardThread", worker);
      yield* kanban.turnEnded(threadId);
      yield* kanban.dispatchNow;
      const other = yield* kanban.createCard(board.id, { title: "Other", prompt: "Other" }, owner);
      reviewer = (yield* kanban.card(card.id)).card.activeThreadId!;
      model = board.defaultCardModel;
      const recording = yield* Effect.forkChild(
        Effect.result(
          kanban.reviewResult(
            reviewer,
            verdict,
            verdict === "findings" ? ["Fix queue ordering"] : [],
            "abc1234",
          ),
        ),
      );
      yield* Deferred.await(entered);
      if (change !== "timeout") {
        const edit = yield* kanban.editCard(
          other.id,
          { description: "Committed during cancellation read" },
          owner,
        );
        assert.equal(edit.description, "Committed during cancellation read");
      }
      assert.isUndefined(recording.pollUnsafe());
      if (change === "timeout") {
        yield* TestClock.adjust("5 seconds");
        const result = yield* Fiber.join(recording);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") assert.equal(result.failure.code, "failed");
        const unchanged = yield* kanban.card(card.id);
        assert.equal(unchanged.card.stage, "in_review");
        assert.lengthOf(
          unchanged.events.filter((event) => event.kind === "review"),
          0,
        );
        assert.equal(unchanged.card.subtasks[0]!.state, "open");
        yield* kanban.editCard(
          other.id,
          { description: "Committed after cleanup deadline" },
          owner,
        );
        yield* Deferred.succeed(resume, undefined);
        cancelled = true;
        const retried = yield* kanban.reviewResult(
          reviewer,
          verdict,
          verdict === "findings" ? ["Fix queue ordering"] : [],
          "abc1234",
        );
        assert.isTrue(retried.recorded);
        assert.deepEqual(cancelledIds, ["old-wake"]);
        return;
      }
      // Retire the specific queued run so a concurrent move doesn't perform a
      // second cleanup; the blocked cancellation still has to acknowledge it.
      cancelled = true;
      if (change === "leave") yield* kanban.moveCard(card.id, "todo", "owner", owner);
      yield* Deferred.succeed(resume, undefined);
      const result = yield* Fiber.join(recording);
      const after = yield* kanban.card(card.id);
      assert.deepEqual(cancelledIds, ["old-wake"]);
      if (change === "leave") {
        assert.equal(result._tag, "Failure");
        assert.equal(after.card.stage, "todo");
        assert.lengthOf(
          after.events.filter((event) => event.kind === "review"),
          0,
        );
        // The winning move superseded the old review nudge. Fresh dispatch is
        // driven by persisted todo state, with no dependency on that run ID.
        yield* kanban.dispatchNow;
        const resumed = (yield* kanban.card(card.id)).card;
        assert.equal(resumed.stage, "working");
        assert.equal(resumed.activeRole, "work");
        assert.isNotNull(resumed.activeThreadId);
        assert.notEqual(resumed.activeThreadId, reviewer);
      } else {
        assert.equal(result._tag, "Success");
        assert.equal(after.card.stage, verdict === "clear" ? "completed" : "todo");
        assert.equal(after.card.subtasks[0]!.state, verdict === "clear" ? "done" : "open");
        const events = after.events.filter((event) => event.kind === "review");
        assert.lengthOf(events, 1);
        assert.equal(events[0]!.head, "abc1234");
      }
    }).pipe(Effect.ensuring(Deferred.succeed(resume, undefined)), Effect.provide(testLayer(slow)));
  }),
);

it.effect.each(
  (["prompt", "subtasks"] as const).flatMap((field) =>
    (["none", "new", "changed"] as const).flatMap((prs) =>
      (["clear", "findings"] as const).map((verdict) => ({ field, prs, verdict })),
    ),
  ),
)(
  "reviewResult preserves the $field edit base ($prs PR metadata, $verdict)",
  ({ field, prs, verdict }) =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      const threads = yield* KanbanThreads.pipe(Effect.provide(fake.layer));
      let work: ThreadId | undefined;
      const prView = Layer.succeed(KanbanThreads, {
        ...threads,
        view: (id) =>
          threads.view(id).pipe(
            Effect.map((view) =>
              view && id === work && prs !== "none"
                ? {
                    ...view,
                    prs: [
                      {
                        url: "https://github.com/o/r/pull/1663",
                        title: "Fix",
                        state: "open" as const,
                      },
                    ],
                  }
                : view,
            ),
          ),
      });
      yield* Effect.gen(function* () {
        const at = Date.parse("2026-11-16T08:00:00.000Z");
        yield* TestClock.setTime(at);
        const { kanban, card, worker, threadId } = yield* workingCard();
        yield* kanban.moveCard(card.id, "needs_review", "cardThread", worker);
        yield* kanban.turnEnded(threadId);
        yield* kanban.dispatchNow;
        const reviewer = (yield* kanban.card(card.id)).card.activeThreadId!;
        if (prs === "changed")
          yield* kanban.editCard(
            card.id,
            {
              links: [
                {
                  url: "https://github.com/o/r/pull/1663",
                  label: "Fix",
                  kind: "pr",
                },
              ],
            },
            owner,
          );
        const patch =
          field === "prompt"
            ? { prompt: "Protected prompt" }
            : { subtasks: [{ text: "Review", owner: "review" as const }] };
        yield* kanban.editCard(card.id, patch, owner);
        const before = (yield* kanban.card(card.id)).card;
        assert.isAbove(Date.parse(before.updatedAt), at);
        work = threadId;
        const result = yield* kanban.reviewResult(
          reviewer,
          verdict,
          verdict === "clear" ? [] : ["Fix ordering"],
          "abc1234",
        );
        assert.isTrue(result.recorded);
        const after = (yield* kanban.card(card.id)).card;
        assert.isAtLeast(Date.parse(after.updatedAt), Date.parse(before.updatedAt));
        if (prs !== "none") assert.equal(after.links[0]?.state, "open");
        const edited = yield* kanban.editCard(
          card.id,
          {
            ...(field === "prompt"
              ? { prompt: "Merged prompt" }
              : { subtasks: [{ text: "Follow-up", owner: "work" as const }] }),
            basedOn: before.updatedAt,
          },
          owner,
        );
        assert.isAbove(Date.parse(edited.updatedAt), Date.parse(before.updatedAt));
      }).pipe(Effect.provide(testLayer(prView)));
    }),
);

it.effect.each(
  (["purged", "reassigned"] as const).flatMap((change) =>
    (["none", "new", "changed"] as const).map((prs) => ({ change, prs })),
  ),
)(
  "a card $change after the outside snapshot refuses with not-found and no verdict event ($prs PR metadata)",
  ({ change, prs }) =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      let armed: KanbanCard["id"] | undefined;
      let work: ThreadId | undefined;
      const threads = yield* KanbanThreads.pipe(Effect.provide(fake.layer));
      const prView = Layer.succeed(KanbanThreads, {
        ...threads,
        view: (id) =>
          threads.view(id).pipe(
            Effect.map((view) =>
              view && id === work && prs !== "none"
                ? {
                    ...view,
                    prs: [
                      {
                        url: "https://github.com/o/r/pull/1663",
                        title: "Fix",
                        state: "merged" as const,
                      },
                    ],
                  }
                : view,
            ),
          ),
      });
      const blocked = Layer.effect(
        KanbanStore.KanbanStore,
        Effect.map(KanbanStore.KanbanStore, (real) => ({
          ...real,
          card: (id: KanbanCard["id"]) =>
            Effect.gen(function* () {
              const snapshot = yield* real.card(id);
              if (id === armed) {
                armed = undefined;
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(resume);
              }
              return snapshot;
            }),
        })),
      ).pipe(Layer.provide(KanbanStore.layer));
      yield* Effect.gen(function* () {
        const { kanban, card, worker, threadId } = yield* workingCard();
        yield* kanban.moveCard(card.id, "needs_review", "cardThread", worker);
        yield* kanban.turnEnded(threadId);
        yield* kanban.dispatchNow;
        const reviewer = (yield* kanban.card(card.id)).card.activeThreadId!;
        const store = yield* KanbanStore.KanbanStore;
        const current = (yield* store.card(card.id))!;
        if (prs === "changed")
          yield* store.putCard({
            ...current,
            links: [
              {
                kind: "pr",
                url: "https://github.com/o/r/pull/1663",
                label: "Fix",
                state: "open",
                checkedAt: null,
              },
            ],
          });
        work = threadId;
        const before = yield* store.cardEvents(card.id);
        armed = card.id;
        const recording = yield* Effect.forkChild(
          Effect.result(kanban.reviewResult(reviewer, "clear", [], "abc1234")),
        );
        yield* Deferred.await(entered);
        // Deliberately bypass generation tracking to exercise the event writer's
        // own existence and board check against a stale snapshot.
        const sql = yield* SqlClient.SqlClient;
        if (change === "purged") {
          yield* sql`DELETE FROM ardud_kanban_cards WHERE id = ${card.id}`;
        } else {
          yield* sql`UPDATE ardud_kanban_cards SET board_id = 'another-board' WHERE id = ${card.id}`;
        }
        const rows = yield* sql`SELECT * FROM ardud_kanban_cards WHERE id = ${card.id}`;
        yield* Deferred.succeed(resume, undefined);
        const result = yield* Fiber.join(recording);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.equal(result.failure.code, "not-found");
          assert.equal(result.failure.detail, `card ${card.id}`);
        }
        assert.deepEqual(yield* store.cardEvents(card.id), before);
        assert.deepEqual(yield* sql`SELECT * FROM ardud_kanban_cards WHERE id = ${card.id}`, rows);
        if (change === "purged") assert.isNull(yield* store.card(card.id));
      }).pipe(
        Effect.provide(testLayer(prView, blocked)),
        Effect.ensuring(Deferred.succeed(resume, undefined)),
      );
    }),
);
