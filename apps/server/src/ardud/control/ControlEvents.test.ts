import { assert, it } from "@effect/vitest";
import { AnalyticsEvent, OrchestrationV2StoredEvent } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Analytics from "../analytics/Analytics.ts";
import { accumulate, finishRollup, makeAccumulator } from "../analytics/rollup.ts";
import { ControlStoreError } from "./ControlStore.ts";
import { LiveStreamBufferError } from "../../orchestration-v2/LiveStreamBudget.ts";
import {
  ControlHistoryCompactedError,
  failureCode,
  makeBody,
  streamStart,
} from "./ControlEvents.ts";

const decodeAnalyticsEvent = Schema.decodeUnknownSync(AnalyticsEvent, {
  onExcessProperty: "error",
});

const event = (sequence: number) =>
  ({
    sequence,
    event: {
      type: "thread.archived",
      threadId: "thread:test",
      payload: {},
    },
  }) as unknown as OrchestrationV2StoredEvent;
const options = {
  afterSequence: 4,
  resumed: true,
  threadFilter: null,
  originFilter: null,
  accepts: () => true,
  originOf: () => Effect.succeed(null),
  analytics: undefined,
};
const text = (frames: ReadonlyArray<Uint8Array>) =>
  frames.map((frame) => new TextDecoder().decode(frame));

it.effect("classifies wrapped failures and keeps interruption distinct from mixed failure", () =>
  Effect.sync(() => {
    const buffer = new LiveStreamBufferError({ message: "full" });
    assert.equal(
      failureCode(Cause.fail({ _tag: "OrchestratorDomainEventStreamError", cause: buffer })),
      "buffer_overflow",
    );
    assert.equal(
      failureCode(Cause.fail({ _tag: "OrchestratorDomainEventStreamError", cause: {} })),
      "event_read_failed",
    );
    assert.equal(failureCode(Cause.die({ _tag: "SqlError" })), "event_read_failed");
    assert.equal(failureCode(Cause.fail(new ControlHistoryCompactedError())), "history_compacted");
    assert.equal(failureCode(Cause.die("unknown")), "unknown");
    assert.equal(failureCode(Cause.interrupt()), "interrupted");
    assert.equal(
      failureCode(Cause.combine(Cause.interrupt(), Cause.fail(buffer))),
      "buffer_overflow",
    );
  }),
);

it.effect("compacted cursors restart at the head", () =>
  Effect.sync(() => {
    assert.deepEqual(streamStart("4", null, 9, true), { afterSequence: 9, resumed: false });
  }),
);

it.effect("ready distinguishes fresh, invalid, future and honoured cursors", () =>
  Effect.gen(function* () {
    for (const [resume, resumed, sequence] of [
      [Number.NaN, false, 9],
      [-1, false, 9],
      [1.5, false, 9],
      [10, false, 9],
      [0, true, 0],
      [4, true, 4],
      [9, true, 9],
    ] as const) {
      const start = streamStart(String(resume), null, 9);
      const body = yield* makeBody({ ...options, ...start, source: Stream.empty });
      const frames = text(yield* body.pipe(Stream.take(1), Stream.runCollect));
      assert.include(frames[0]!, JSON.stringify({ type: "ready", sequence, resumed }));
    }
  }),
);

it.effect("reports the last emitted cursor, counts failure by code and logs its cause", () =>
  Effect.gen(function* () {
    const samples: AnalyticsEvent[] = [];
    const logs: unknown[] = [];
    const logger = Logger.make(({ message }) => {
      logs.push(message);
    });
    const analytics = yield* Analytics.Analytics.pipe(
      Effect.provide(
        Layer.mock(Analytics.Analytics)({
          record: (sample) =>
            Effect.sync(() => {
              samples.push(sample);
            }),
        }),
      ),
    );
    const body = yield* makeBody({
      ...options,
      analytics,
      source: Stream.concat(
        Stream.make(event(5)),
        Stream.fail({ _tag: "OrchestratorDomainEventStreamError" }),
      ),
    });
    const frames = text(
      yield* body.pipe(Stream.runCollect, Effect.provide(Logger.layer([logger]))),
    );
    assert.include(JSON.stringify(logs), "ardud control events stream failed");
    assert.include(JSON.stringify(logs), "OrchestratorDomainEventStreamError");
    // Merge may discard a prefetched event on failure; the error must never skip it.
    const preceding = frames
      .slice(0, -1)
      .flatMap((frame) => [...frame.matchAll(/^id: (\d+)/gm)].map((match) => Number(match[1])));
    assert.include(frames.at(-1)!, `id: ${preceding.at(-1)}\nevent: error`);
    assert.include(frames.at(-1)!, '"code":"event_read_failed"');
    const failures = samples.filter((sample) => sample.kind === "events.stream_failed");
    assert.lengthOf(failures, 1);
    assert.equal(failures[0]!.props?.code, "event_read_failed");
    const rollup = makeAccumulator();
    for (const sample of samples) {
      decodeAnalyticsEvent(sample);
      accumulate(rollup, sample);
    }
    const result = finishRollup(rollup, "2026-01-01", "2026-01-01T00:00:00.000Z");
    assert.include(JSON.stringify(result), "events.stream_failed.event_read_failed");
  }),
);

it.effect("origin lookup failures are visible rather than silently assigned no origin", () =>
  Effect.gen(function* () {
    const body = yield* makeBody({
      ...options,
      source: Stream.make(event(5)),
      originOf: () =>
        Effect.fail(new ControlStoreError({ operation: "test", cause: "origin unavailable" })),
    });
    const frames = text(yield* body.pipe(Stream.runCollect));
    assert.include(frames.at(-1)!, '"code":"origin_lookup_failed"');
    assert.include(frames.at(-1)!, "id: 4");
  }),
);

it.effect("interruption sends no error frame or failure metric", () =>
  Effect.gen(function* () {
    const samples: AnalyticsEvent[] = [];
    const analytics = yield* Analytics.Analytics.pipe(
      Effect.provide(
        Layer.mock(Analytics.Analytics)({
          record: (sample) =>
            Effect.sync(() => {
              samples.push(sample);
            }),
        }),
      ),
    );
    const body = yield* makeBody({
      ...options,
      analytics,
      source: Stream.fromEffect(Effect.interrupt),
    });
    const frames = text(yield* body.pipe(Stream.runCollect));
    assert.lengthOf(frames, 1);
    assert.notInclude(frames.join(""), "event: error");
    assert.isFalse(samples.some((sample) => sample.kind === "events.stream_failed"));
  }),
);

it.effect("analytics defects cannot replace the stream's error frame", () =>
  Effect.gen(function* () {
    const analytics = yield* Analytics.Analytics.pipe(
      Effect.provide(
        Layer.mock(Analytics.Analytics)({ record: () => Effect.die("analytics unavailable") }),
      ),
    );
    const body = yield* makeBody({ ...options, analytics, source: Stream.fail("unknown failure") });
    const frames = text(yield* body.pipe(Stream.runCollect));
    assert.include(frames.at(-1)!, '"code":"unknown"');
  }),
);

it.effect("Last-Event-ID takes precedence over after and only decimal safe cursors resume", () =>
  Effect.sync(() => {
    for (const [header, after, sequence, resumed] of [
      [undefined, null, 9, false],
      [undefined, "0", 0, true],
      [undefined, "4", 4, true],
      ["7", "4", 7, true],
      ["", "4", 9, false],
      ["bad", "4", 9, false],
      [undefined, " ", 9, false],
      [undefined, "-1", 9, false],
      [undefined, "1.5", 9, false],
      [undefined, "1e0", 9, false],
      [undefined, "Infinity", 9, false],
      [undefined, "9007199254740992", 9, false],
      [undefined, "10", 9, false],
      [undefined, "04", 4, true],
      [undefined, "9", 9, true],
    ] as const)
      assert.deepEqual(streamStart(header, after, 9), { afterSequence: sequence, resumed });
  }),
);
