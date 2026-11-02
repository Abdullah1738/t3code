import { describe, expect, it } from "@effect/vitest";

import { buildSourceSnapshot, UnsupportedContextRecord } from "./SourceSnapshot.ts";

const SENTINEL = "RECENT_ONLY_SENTINEL_4C1D";
const T = 1_793_000_000_000;

const completedCompaction = (overrides: Record<string, unknown> = {}) => ({
  id: "msg_compact_1",
  type: "compaction",
  status: "completed",
  reason: "auto",
  time: { created: T },
  summary: "Summary of the earlier work.",
  recent: `Latest turns. The fact that only lives here: ${SENTINEL}.`,
  ...overrides,
});

const user = (id: string, text: string) => ({ id, type: "user", text, files: [], time: { created: T + 1 } });
const assistant = (id: string, text: string) => ({
  id,
  type: "assistant",
  content: [{ type: "text", text }],
  time: { created: T + 2 },
});

describe("buildSourceSnapshot", () => {
  it("keeps the summary AND the recent text of a completed compaction, exactly once each", () => {
    const snapshot = buildSourceSnapshot({ records: [completedCompaction(), user("msg_u1", "later question")] });
    const joined = snapshot.turns.map((turn) => turn.text).join("\n");
    expect(joined.split(SENTINEL).length - 1).toBe(1);
    expect(joined).toContain("Summary of the earlier work.");
    expect(joined).toContain("later question");
    const kinds = snapshot.manifest.map((entry) => entry.kind);
    expect(kinds).toContain("compaction-summary");
    expect(kinds).toContain("compaction-recent");
  });

  it("keeps the later records in source order after the compaction", () => {
    const snapshot = buildSourceSnapshot({
      records: [completedCompaction(), user("msg_u1", "first after"), assistant("msg_a1", "answer after")],
    });
    const texts = snapshot.turns.map((turn) => turn.text);
    const after = texts.indexOf("first after");
    expect(after).toBeGreaterThan(texts.findIndex((text) => text.includes(SENTINEL)));
    expect(texts.indexOf("answer after")).toBeGreaterThan(after);
  });

  it("ignores a newer failed compaction and records it as excluded", () => {
    const snapshot = buildSourceSnapshot({
      records: [
        completedCompaction(),
        completedCompaction({ id: "msg_compact_2", status: "failed", error: { name: "x" } }),
      ],
    });
    expect(snapshot.excludedKinds["compaction-not-completed"]).toBe(1);
    expect(snapshot.turns.some((turn) => turn.text.includes("failed"))).toBe(false);
  });

  it("refuses an unknown record type rather than dropping it", () => {
    expect(() =>
      buildSourceSnapshot({ records: [{ id: "msg_x", type: "mystery-kind", time: { created: T } }] }),
    ).toThrow(UnsupportedContextRecord);
  });

  it("changes the digest when a record is added", () => {
    const base = buildSourceSnapshot({ records: [user("msg_u1", "one")] });
    const more = buildSourceSnapshot({ records: [user("msg_u1", "one"), user("msg_u2", "two")] });
    expect(more.digest).not.toBe(base.digest);
  });

  it("keeps the same digest for the same records", () => {
    const records = [user("msg_u1", "one"), assistant("msg_a1", "answer")];
    expect(buildSourceSnapshot({ records }).digest).toBe(buildSourceSnapshot({ records }).digest);
  });

  it("labels history so the target reads it as history, not a live instruction", () => {
    const snapshot = buildSourceSnapshot({ records: [user("msg_u1", "do the thing")] });
    expect(snapshot.turns[0]?.label).toBe("[User]");
  });

  it("writes no tool_use ids into the portable turns", () => {
    const snapshot = buildSourceSnapshot({ records: [user("msg_u1", "hi"), assistant("msg_a1", "ok")] });
    expect(JSON.stringify(snapshot.turns)).not.toContain("tool_use");
  });
});
