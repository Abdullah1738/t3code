import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { makeAsyncRotatingFileSink } from "@t3tools/shared/logging";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  boundedTraceRetention,
  DEFAULT_TRACE_MAX_BYTES,
  DEFAULT_TRACE_MAX_FILES,
  TRACE_RETENTION_MAX_BYTES,
} from "./traceRetention.ts";

it.effect("bounds the active file plus all backups, including oversized overrides", () =>
  Effect.sync(() => {
    for (const [bytes, files] of [
      [DEFAULT_TRACE_MAX_BYTES, DEFAULT_TRACE_MAX_FILES],
      [1e12, 1e12],
      [0, -1],
      [NaN, Infinity],
      [1, 1e12],
    ]) {
      const retention = boundedTraceRetention(bytes!, files!);
      assert.isAtLeast(retention.maxBytes, 1);
      assert.isAtLeast(retention.maxFiles, 1);
      assert.isAtMost(retention.maxBytes * (retention.maxFiles + 1), TRACE_RETENTION_MAX_BYTES);
    }
  }),
);

it.effect("retains more than ten minutes at 1 MiB/s through repeated rotation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-trace-retention-" });
      const file = path.join(dir, "trace.ndjson");
      // Scale bytes by 1024; timestamps and the actual rotation code stay unchanged.
      const scale = 1024;
      const bytesPerSecond = (1024 * 1024) / scale;
      const sink = yield* makeAsyncRotatingFileSink({
        filePath: file,
        maxBytes: DEFAULT_TRACE_MAX_BYTES / scale,
        maxFiles: DEFAULT_TRACE_MAX_FILES,
      });
      for (let second = 0; second < 1200; second++) {
        yield* sink.write(`${String(second).padEnd(bytesPerSecond - 1, " ")}\n`);
      }
      const names = yield* fs.readDirectory(dir);
      assert.equal(names.length, DEFAULT_TRACE_MAX_FILES + 1);
      let totalBytes = 0;
      let firstSecond = Infinity;
      for (const name of names) {
        const text = yield* fs.readFileString(path.join(dir, name));
        totalBytes += text.length;
        firstSecond = Math.min(firstSecond, Number(text.split("\n")[0]?.trim()));
      }
      assert.isAtMost(firstSecond, 1199 - 600);
      assert.isAtMost(totalBytes * scale, TRACE_RETENTION_MAX_BYTES);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
