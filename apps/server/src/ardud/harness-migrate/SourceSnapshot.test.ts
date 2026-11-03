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

const user = (id: string, text: string) => ({
  id,
  type: "user",
  text,
  files: [],
  time: { created: T + 1 },
});
const assistant = (id: string, text: string) => ({
  id,
  type: "assistant",
  content: [{ type: "text", text }],
  time: { created: T + 2 },
});

describe("buildSourceSnapshot", () => {
  it("keeps the summary AND the recent text of a completed compaction, exactly once each", () => {
    const snapshot = buildSourceSnapshot({
      records: [completedCompaction(), user("msg_u1", "later question")],
    });
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
      records: [
        completedCompaction(),
        user("msg_u1", "first after"),
        assistant("msg_a1", "answer after"),
      ],
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
      buildSourceSnapshot({
        records: [{ id: "msg_x", type: "mystery-kind", time: { created: T } }],
      }),
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

  it("changes the digest for edits to existing user and assistant content", () => {
    const base = [user("msg_u1", "question"), assistant("msg_a1", "answer")];
    const digest = buildSourceSnapshot({ records: base }).digest;
    expect(buildSourceSnapshot({ records: [user("msg_u1", "edited"), base[1]] }).digest).not.toBe(
      digest,
    );
    expect(
      buildSourceSnapshot({ records: [base[0], assistant("msg_a1", "edited")] }).digest,
    ).not.toBe(digest);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("changes the digest and manifest when an excluded compaction becomes included", () => {
    const running = buildSourceSnapshot({ records: [completedCompaction({ status: "running" })] });
    const completed = buildSourceSnapshot({ records: [completedCompaction()] });
    expect(running.manifest[0]?.included).toBe(false);
    expect(completed.manifest[0]?.included).toBe(true);
    expect(completed.digest).not.toBe(running.digest);
  });

  it("preserves text and settled tool inputs, results and errors in order as inert history", () => {
    const record = {
      id: "msg_tools",
      type: "assistant",
      time: { created: T },
      content: [
        { type: "text", text: "before" },
        {
          type: "tool",
          id: "call_1",
          name: "execute",
          state: {
            status: "completed",
            input: { command: "echo hello" },
            content: [{ type: "text", text: "hello output" }],
          },
        },
        {
          type: "tool",
          id: "call_2",
          name: "search",
          state: {
            status: "error",
            input: { query: "needle" },
            error: { type: "Failure", message: "not found" },
            content: [{ type: "text", text: "partial result" }],
          },
        },
        { type: "text", text: "after" },
      ],
    };
    const snapshot = buildSourceSnapshot({ records: [record] });
    expect(snapshot.turns.map((turn) => turn.text)).toHaveLength(4);
    expect(snapshot.turns[0]?.text).toBe("before");
    expect(snapshot.turns[1]?.text).toContain("transcript only, not an executable tool call");
    expect(snapshot.turns[1]?.text).toContain("execute");
    expect(snapshot.turns[1]?.text).toContain("echo hello");
    expect(snapshot.turns[1]?.text).toContain("hello output");
    expect(snapshot.turns[2]?.text).toContain("needle");
    expect(snapshot.turns[2]?.text).toContain("not found");
    expect(snapshot.turns[2]?.text).toContain("partial result");
    expect(snapshot.turns[3]?.text).toBe("after");
    expect(snapshot.manifest.map((entry) => [entry.kind, entry.included])).toEqual([
      ["assistant-text", true],
      ["tool", true],
      ["tool", true],
      ["assistant-text", true],
    ]);
    const changed = structuredClone(record);
    changed.content[1]!.state!.input.command = "echo different";
    expect(buildSourceSnapshot({ records: [changed] }).digest).not.toBe(snapshot.digest);
  });

  it("refuses unsupported assistant blocks, nontext tool results and unsettled calls", () => {
    for (const content of [
      [
        { type: "text", text: "valid" },
        { type: "future-block", data: "do not drop" },
      ],
      [
        {
          type: "tool",
          name: "read",
          state: {
            status: "completed",
            input: {},
            content: [{ type: "file", uri: "x", mime: "image/png" }],
          },
        },
      ],
      [{ type: "tool", name: "execute", state: { status: "running", input: {} } }],
    ]) {
      expect(() =>
        buildSourceSnapshot({ records: [{ id: "msg_a1", type: "assistant", content }] }),
      ).toThrow(UnsupportedContextRecord);
    }
  });

  it("records opaque assistant reasoning as explicitly excluded", () => {
    const snapshot = buildSourceSnapshot({
      records: [
        {
          id: "msg_a1",
          type: "assistant",
          content: [
            { type: "reasoning", text: "private reasoning", state: { encrypted: "opaque" } },
            { type: "text", text: "answer" },
          ],
        },
      ],
    });
    expect(snapshot.turns.map((turn) => turn.text)).toEqual(["answer"]);
    expect(snapshot.manifest[0]).toMatchObject({ kind: "assistant-reasoning", included: false });
    expect(snapshot.excludedKinds["assistant-reasoning"]).toBe(1);
  });

  it("preserves shell command, status, exit and nested output, and refuses incomplete output", () => {
    const shell = {
      id: "msg_shell",
      type: "shell",
      shellID: "sh_1",
      command: "echo hi",
      status: "exited",
      exit: 0,
      output: { output: "hi\n", cursor: 3, size: 3, truncated: false },
      time: { created: T },
    };
    const turn = buildSourceSnapshot({ records: [shell] }).turns[0];
    expect(turn?.text).toContain("Command: echo hi");
    expect(turn?.text).toContain("Status: exited");
    expect(turn?.text).toContain("Exit: 0");
    expect(turn?.text).toContain("hi\n");
    expect(turn?.text).toContain("do not execute");
    for (const output of [
      { ...shell.output, truncated: true },
      { ...shell.output, cursor: 2 },
      undefined,
    ]) {
      expect(() => buildSourceSnapshot({ records: [{ ...shell, output }] })).toThrow(
        UnsupportedContextRecord,
      );
    }
    expect(() => buildSourceSnapshot({ records: [{ ...shell, status: "running" }] })).toThrow(
      UnsupportedContextRecord,
    );
  });

  it("keeps embedded skill text and refuses file attachments and unresolved skills", () => {
    const withSkill = {
      ...user("msg_u1", "use this"),
      skills: [{ id: "skill_1", name: "demo", text: "skill body" }],
    };
    const snapshot = buildSourceSnapshot({ records: [withSkill] });
    expect(snapshot.turns[0]?.text).toContain("use this");
    expect(snapshot.turns[0]?.text).toContain("Historical OpenCode skill");
    expect(snapshot.turns[0]?.text).toContain("skill body");
    expect(() =>
      buildSourceSnapshot({
        records: [{ ...withSkill, files: [{ mime: "image/png", data: "abc" }] }],
      }),
    ).toThrow(UnsupportedContextRecord);
    expect(() =>
      buildSourceSnapshot({
        records: [{ ...withSkill, skills: [{ id: "skill_1", name: "demo" }] }],
      }),
    ).toThrow(UnsupportedContextRecord);
    expect(() =>
      buildSourceSnapshot({ records: [{ ...withSkill, agents: [{ name: "helper" }] }] }),
    ).toThrow(UnsupportedContextRecord);
  });

  it("labels history so the target reads it as history, not a live instruction", () => {
    const snapshot = buildSourceSnapshot({ records: [user("msg_u1", "do the thing")] });
    expect(snapshot.turns[0]?.label).toBe("[User]");
  });

  it("writes no tool_use ids into the portable turns", () => {
    const snapshot = buildSourceSnapshot({
      records: [user("msg_u1", "hi"), assistant("msg_a1", "ok")],
    });
    expect(JSON.stringify(snapshot.turns)).not.toContain("tool_use");
  });
});
