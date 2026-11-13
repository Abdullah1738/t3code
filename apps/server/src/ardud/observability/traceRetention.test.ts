import { assert, it } from "@effect/vitest";
import {
  boundedTraceRetention,
  DEFAULT_TRACE_MAX_BYTES,
  DEFAULT_TRACE_MAX_FILES,
  DEFAULT_TRACE_FILE_MIN_DURATION_MS,
  TRACE_RETENTION_MAX_BYTES,
} from "./traceRetention.ts";

it("budgets raw active/compression sizes separately from compressed backup counts", () => {
  const defaults = boundedTraceRetention(DEFAULT_TRACE_MAX_BYTES, DEFAULT_TRACE_MAX_FILES);
  assert.deepEqual(defaults, {
    maxBytes: 64 * 1024 * 1024,
    maxFiles: 128,
    maxTotalBytes: 1_000_000_000,
  });
  assert.equal(DEFAULT_TRACE_FILE_MIN_DURATION_MS, 2);
  // Higher of the two copied windows, plus active, plain source and worst-case gzip scratch.
  const sixHours = 6 * 97_936_067 + defaults.maxBytes * 3.01 + 1024;
  assert.isAtMost(sixHours, TRACE_RETENTION_MAX_BYTES * 0.8);
  assert.isAtLeast((defaults.maxBytes * defaults.maxFiles) / 925_019_985, 7.5);
  for (const [bytes, files] of [
    [1e12, 1e12],
    [0, -1],
    [NaN, Infinity],
    [1, 1e12],
  ]) {
    const bounded = boundedTraceRetention(bytes!, files!);
    assert.isAtLeast(bounded.maxBytes, 1);
    assert.isAtLeast(bounded.maxFiles, 1);
    assert.isAtMost(bounded.maxFiles, 256);
    assert.isAtMost(bounded.maxBytes * 3.01 + 1024, bounded.maxTotalBytes);
  }
});
