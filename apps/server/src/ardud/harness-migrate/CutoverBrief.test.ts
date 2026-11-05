import { assert, describe, it } from "@effect/vitest";
import { CUTOVER_BRIEF_BYTE_LIMIT, renderCutoverBrief } from "./CutoverBrief.ts";

const input = {
  threadId: "thread:same-robob-thread",
  sourceSession: "ses_old-opencode",
  targetInstance: "claudeAgent" as const,
  recentTranscript: "User: fix the failing test\nAssistant: fixed the first failure",
  summary: "The parser fix is done; the retry regression remains.",
  ownerAsks: ["Keep the existing branch."],
};

describe("cutover brief", () => {
  it("keeps the same thread, old native id, activity pagination and pending context", () => {
    const brief = renderCutoverBrief(input);
    assert.include(brief, "Robob moved this same thread from OpenCode to Claude Code.");
    assert.include(brief, "OpenCode session ses_old-opencode");
    assert.include(brief, 't3_thread_read({threadId:"thread:same-robob-thread",view:"activity"})');
    assert.include(brief, "afterPosition=nextPosition");
    assert.include(brief, "textOffset=nextTextOffset");
    assert.include(brief, "Don't redo finished work or repeat messages you already sent.");
    assert.include(brief, input.summary);
    assert.include(brief, input.ownerAsks[0]!);
    assert.include(brief, input.recentTranscript);
  });

  it("does not wake idle work or send a switch announcement", () => {
    const brief = renderCutoverBrief(input);
    assert.include(brief, "current actual request; do not resume idle work");
    assert.include(
      brief,
      "Do not announce the switch or send a message because of it, including in iMessage.",
    );
    assert.notInclude(brief, "Carry on exactly");
  });

  it.each(["codex", "codex-cu"] as const)(
    "resumes running work on %s without inventing an OpenCode id",
    (targetInstance) => {
      const brief = renderCutoverBrief({
        ...input,
        targetInstance,
        sourceSession: null,
        mode: "resume",
      });
      assert.include(brief, "from OpenCode to Codex.");
      assert.include(brief, "Carry on exactly where you left off.");
      assert.notInclude(brief, "OpenCode session");
    },
  );

  it.each([1_500, 4_000, CUTOVER_BRIEF_BYTE_LIMIT, 64_000])(
    "bounds the whole escaped UTF-8 brief to %s bytes",
    (maxBytes) => {
      const brief = renderCutoverBrief({
        ...input,
        summary: `${'界🧪\u0000\\"'.repeat(20_000)}LATEST_SUMMARY`,
        ownerAsks: [`KEEP_THIS_ASK ${"界🧪".repeat(20_000)}`],
        recentTranscript: `${'界🧪\u0000\\"'.repeat(20_000)}LATEST_TURN`,
        maxBytes,
      });
      assert.isAtMost(
        Buffer.byteLength(JSON.stringify(brief)),
        Math.min(maxBytes, CUTOVER_BRIEF_BYTE_LIMIT),
      );
      assert.include(brief, "afterPosition=nextPosition");
      assert.include(brief, "KEEP_THIS_ASK");
      assert.include(brief, "LATEST_SUMMARY");
      assert.include(brief, "LATEST_TURN");
      assert.notInclude(brief, "\ufffd");
      assert.equal(JSON.parse(JSON.stringify(brief)), brief);
      assert.equal(Buffer.from(brief).toString("utf8"), brief);
    },
  );

  it("refuses a budget too small for the required instructions", () => {
    assert.throws(() => renderCutoverBrief({ ...input, maxBytes: 40 }), RangeError);
  });
});
