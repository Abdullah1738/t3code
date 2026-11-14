import { expect, it } from "@effect/vitest";
import type { AnalyticsEvent } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as StartupPhaseLog from "../observability/StartupPhaseLog.ts";
import * as Analytics from "./Analytics.ts";
import * as McpAvailability from "./McpAvailability.ts";

it.effect(
  "counts boot refusals in ten-second windows and flushes the tail when routes are ready",
  () =>
    Effect.gen(function* () {
      const rows: AnalyticsEvent[] = [];
      const recorded = yield* Deferred.make<void>();
      const startup = Layer.succeed(StartupPhaseLog.StartupPhaseLog, {
        start: () => 0,
        end: () => {},
        snapshot: () => ({
          bootId: "boot-test",
          pid: 1,
          droppedRecords: 0,
          persistenceFailed: false,
          phases: [
            {
              id: 0,
              phase: "sqlite.archive-shell-counts",
              startedAt: "2026-11-13T00:00:00.000Z",
              endedAt: null,
              durationMs: null,
              outcome: "running",
            },
          ],
        }),
      });
      const layer = McpAvailability.layer.pipe(
        Layer.provide(startup),
        Layer.provide(
          Layer.mock(Analytics.Analytics)({
            record: (event) =>
              Effect.sync(() => {
                rows.push(event);
              }).pipe(Effect.andThen(Deferred.succeed(recorded, undefined)), Effect.asVoid),
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const availability = yield* McpAvailability.McpAvailability;
        for (let index = 0; index < 23; index++) {
          expect(availability.reject()).toEqual({
            bootId: "boot-test",
            phase: "sqlite.archive-shell-counts",
          });
        }
        expect(rows).toEqual([]);
        yield* TestClock.adjust("10 seconds");
        yield* Deferred.await(recorded);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          kind: "mcp.unavailable",
          bootId: "boot-test",
          props: { reason: "server_starting", phase: "sqlite.archive-shell-counts", count: 23 },
        });
        availability.reject();
        availability.reject();
        yield* availability.ready;
        yield* availability.ready;
        expect(rows).toHaveLength(2);
        expect(rows[1]!.props!.count).toBe(2);
      }).pipe(Effect.provide(layer));
    }),
);
