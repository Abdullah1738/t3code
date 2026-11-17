import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolLog } from "../src/toollog.ts";
import cases from "./fixtures/rollup-causes.json";

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
