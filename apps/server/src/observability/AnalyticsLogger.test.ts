import { finishRollup, makeAccumulator } from "../ardud/analytics/rollup.ts";
import { expect, it } from "@effect/vitest";
import type { AnalyticsEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Logger from "effect/Logger";
import * as Analytics from "../ardud/analytics/Analytics.ts";
import { makeAnalyticsLogger } from "./AnalyticsLogger.ts";

it.effect("records safe server error context without exception or log text", () =>
  Effect.gen(function* () {
    const recorded = yield* Deferred.make<AnalyticsEvent>();
    const analytics = Analytics.Analytics.of({
      record: (event) => Deferred.succeed(recorded, event).pipe(Effect.asVoid),
      ingest: () => Effect.void,
      read: () =>
        Effect.succeed({
          rollup: finishRollup(makeAccumulator(), "2026-11-13", "2026-11-13T00:00:00.000Z"),
          samples: [],
        }),
    });
    yield* Effect.logError("private prompt text", {
      _tag: "QueryTimeoutError",
      message: "token=private-secret",
    }).pipe(
      Effect.annotateLogs({
        "thread.id": "thread-1",
        "kanban.board_id": "board-robob",
        private: "secret",
      }),
      Effect.withSpan("worker.run"),
      Effect.provide(Logger.layer([makeAnalyticsLogger(analytics)], { mergeWithExisting: false })),
    );
    const event = yield* Deferred.await(recorded);
    expect(event).toMatchObject({
      kind: "server.error",
      surface: "server",
      boardId: "board-robob",
      threadId: "thread-1",
      props: { span: "worker.run", errorTag: "QueryTimeoutError" },
    });
    expect(JSON.stringify(event)).not.toMatch(/private|secret|token=/);
  }),
);
