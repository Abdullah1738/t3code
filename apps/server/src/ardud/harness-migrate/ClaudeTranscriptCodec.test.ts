import { describe, expect, it } from "@effect/vitest";

import { encodeClaudeTranscript, type PortableTurn } from "./ClaudeTranscriptCodec.ts";

const SENTINEL = "SENTINEL_RECENT_7F3A";
const SESSION = "11111111-2222-4333-8444-555555555555";
const CWD = "/Users/ardud/.robob/worktrees/example";

const turns: ReadonlyArray<PortableTurn> = [
  { role: "user", text: "Summary of the deploy plan.", timestamp: "2026-11-02T10:00:00.000Z" },
  {
    role: "assistant",
    text: `Recent answer, the only place ${SENTINEL} appears.`,
    timestamp: "2026-11-02T10:00:05.000Z",
  },
  { role: "user", text: "Follow-up question.", timestamp: "2026-11-02T10:01:00.000Z" },
];

const sequentialUuids = () => {
  let n = 0;
  return () => {
    n += 1;
    return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  };
};

const encode = () =>
  encodeClaudeTranscript({
    sessionId: SESSION,
    cwd: CWD,
    version: "2.1.316",
    turns,
    newUuid: sequentialUuids(),
  });

const parse = (content: string) =>
  content
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe("encodeClaudeTranscript", () => {
  it("writes one native record per turn, as JSONL", () => {
    const encoded = encode();
    const records = parse(encoded.content);
    expect(records).toHaveLength(3);
    for (const record of records) {
      expect(["user", "assistant"]).toContain(record.type);
      expect(record.sessionId).toBe(SESSION);
      expect(record.cwd).toBe(CWD);
      expect(record.isSidechain).toBe(false);
    }
    expect(encoded.content.endsWith("\n")).toBe(true);
  });

  it("chains parentUuid from the first record and ends at the head", () => {
    const encoded = encode();
    const records = parse(encoded.content);
    expect(records[0]?.parentUuid).toBeNull();
    for (let i = 1; i < records.length; i += 1) {
      expect(records[i]?.parentUuid).toBe(records[i - 1]?.uuid);
    }
    expect(encoded.headUuid).toBe(encoded.recordUuids[encoded.recordUuids.length - 1]);
    expect(records[records.length - 1]?.uuid).toBe(encoded.headUuid);
  });

  it("keeps the recent-only sentinel exactly once, in order", () => {
    const content = encode().content;
    expect(content.split(SENTINEL).length - 1).toBe(1);
    const messages = parse(content).map((record) => JSON.stringify(record.message));
    expect(messages.findIndex((text) => text.includes(SENTINEL))).toBe(1);
  });

  it("writes no tool_use blocks, so no live tool id can be waited on", () => {
    expect(encode().content).not.toContain("tool_use");
  });

  it("refuses an empty history instead of writing a file that cannot resume", () => {
    expect(() =>
      encodeClaudeTranscript({
        sessionId: SESSION,
        cwd: CWD,
        version: "2.1.316",
        turns: [],
        newUuid: sequentialUuids(),
      }),
    ).toThrow();
  });
});
