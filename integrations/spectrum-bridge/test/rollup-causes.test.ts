import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolLog } from "../src/toollog.ts";
import cases from "./fixtures/rollup-causes.json";
import { summarizeLog } from "../src/log-rollup.ts";
import type { LogLine } from "../src/toollog.ts";

test("probe causes show repeated attempts concentrated on fourteen rows without recounting failures", async () => {
  async function* lines(): AsyncGenerator<LogLine> {
    for (let attempt = 0; attempt < 4; attempt++) for (let row = 0; row < 14; row++) {
      const inboundId = `row_${row.toString(16).padStart(16, "0")}`;
      yield { ts: "2026-11-17T12:00:00Z", tool: "imessage", component: "router", kind: "error", name: "bridge.catch", alreadyLogged: true,
        ids: { inboundId }, error: { tag: "router.catch1", name: "ControlError", status: 503, message: "[redacted]" } };
      yield { ts: "2026-11-17T12:00:00Z", tool: "imessage", component: "router", kind: "event", name: "router.probe_backoff", ids: { inboundId } };
    }
  }
  const result = await summarizeLog(lines());
  expect(result.errorRate).toBe(0);
  for (const tag of ["router.catch1", "router.probe_backoff"]) {
    expect(result.topCauses).toContainEqual({ tag, causeKey: "admission_read_failed", count: 56, distinctInboundIds: 14,
      topInboundIds: Array.from({ length: 14 }, (_, row) => ({ inboundId: `row_${row.toString(16).padStart(16, "0")}`, count: 4 })) });
  }
});

test.each(cases)("replayed cause: $name", async fixture => {
  const root = mkdtempSync(join(tmpdir(), "rollup-causes-"));
  try {
    const tag = fixture.request ? "control.request_failed" : fixture.tag ?? "fixture.catch";
    const row = { ts: "2026-11-16T12:00:00Z", component: fixture.request ? "robob" : "router",
      kind: fixture.request ? "perf" : "error", name: fixture.request ? "turn.robob_call" : "bridge.catch", ok: false,
      props: { ...fixture.props, ...(fixture.single ? { failureFormat: "single" } : {}) }, error: { tag, ...fixture.error }, ...fixture.row };
    const input = Object.fromEntries(Object.entries(row).filter(([key]) => !fixture.omit?.some(omitted => omitted === key)));
    writeFileSync(join(root, "2026-11-16.ndjson"), JSON.stringify(input) + "\n");
    const result = await createToolLog({ root }).rollup("2026-11-16");
    expect(result?.topCauses ?? []).toEqual(fixture.expected ? [{ tag: fixture.expectedTag ?? tag, causeKey: fixture.expected, count: 1 }] : []);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
