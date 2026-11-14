import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { makeTraceSink, type OtlpTraceRecord } from "@t3tools/shared/observability";
import { make } from "./BrowserTraceCollector.ts";

it.effect("forwarded browser spans share the local sink filter and minute counts", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const filePath = `${dir}/trace.ndjson`;
      const sink = yield* makeTraceSink({
        filePath,
        maxBytes: 1_000_000,
        maxFiles: 1,
        batchWindowMs: 1000,
        fileFilter: { minDurationMs: 2 },
      });
      const span: OtlpTraceRecord = {
        type: "otlp-span",
        name: "browser-fast",
        traceId: "trace",
        spanId: "span",
        parentSpanId: "parent",
        sampled: true,
        kind: "internal",
        startTimeUnixNano: "1",
        endTimeUnixNano: "2",
        durationMs: 0.1,
        attributes: {},
        resourceAttributes: {},
        scope: { attributes: {} },
        events: [],
        links: [],
        status: { code: "1" },
      };
      yield* make(sink).record([
        span,
        { ...span, name: "browser-error", status: { code: "2" } },
        { ...span, name: "browser-interrupt", attributes: { "effect.fiber.interrupted": true } },
      ]);
      yield* sink.close();
      const records = (yield* fs.readFileString(filePath))
        .trim()
        .split("\n")
        .map((s) => JSON.parse(s));
      expect(records.filter((r) => r.type === "otlp-span").map((r) => r.name)).toEqual([
        "browser-error",
        "browser-interrupt",
      ]);
      expect(records.find((r) => r.type === "span-summary").spans["browser-fast"]).toEqual({
        count: 1,
        totalMs: 0.1,
        maxMs: 0.1,
      });
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
