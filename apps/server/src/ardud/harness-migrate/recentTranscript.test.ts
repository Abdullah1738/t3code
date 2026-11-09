import { assert, it } from "@effect/vitest";
import {
  MessageId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import {
  compactTranscriptItems,
  recentTranscriptEnabled,
  recentTranscriptRunIds,
  TRANSCRIPT_MESSAGE_BYTES,
} from "./recentTranscript.ts";

it("keeps the feature off on old settings and never applies it to OpenCode", () => {
  assert.isFalse(recentTranscriptEnabled({}, "codex"));
  const settings = { ardudHarnessMigration: { transcript: { enabled: true } } };
  assert.isFalse(recentTranscriptEnabled(settings, "opencode"));
  for (const id of ["codex", "claudeAgent", "codex-cu"]) {
    assert.isTrue(recentTranscriptEnabled(settings, id));
  }
});

it("selects only the newest eligible runs in ordinal order", () => {
  const runs = [3, 1, 4, 2].map((ordinal) => ({
    id: RunId.make(`run:${ordinal}`),
    ordinal,
    status: "completed" as const,
  }));
  assert.deepEqual(recentTranscriptRunIds(runs, undefined, 2), [runs[0]!.id, runs[2]!.id]);
  assert.deepEqual(recentTranscriptRunIds(runs, [runs[1]!.id, runs[3]!.id], 1), [runs[3]!.id]);
  assert.deepEqual(recentTranscriptRunIds([], [null]), [null]);
  assert.deepEqual(recentTranscriptRunIds(runs, []), []);
});

it("does not let a queued future request evict the active run's transcript", () => {
  const running = { id: RunId.make("run:active"), ordinal: 1, status: "running" as const };
  const queued = { id: RunId.make("run:queued"), ordinal: 2, status: "queued" as const };
  assert.deepEqual(recentTranscriptRunIds([running, queued], undefined, 1), [running.id]);
});

it("clips oversized messages at a UTF-8 boundary and retains the latest text", () => {
  const now = DateTime.makeUnsafe("2026-11-05T00:00:00Z");
  const item: OrchestrationV2TurnItem = {
    id: TurnItemId.make("item:one"),
    threadId: ThreadId.make("thread:one"),
    runId: RunId.make("run:one"),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    messageId: MessageId.make("message:one"),
    type: "assistant_message",
    streaming: false,
    text: "🧪".repeat(10_000) + "LATEST",
  };
  const clipped = compactTranscriptItems([item])[0]!;
  assert.equal(clipped.id, item.id);
  assert.equal(clipped.type, "assistant_message");
  if (clipped.type !== "assistant_message") return;
  assert.include(clipped.text, "[Earlier text omitted]");
  assert.isTrue(clipped.text.endsWith("LATEST"));
  assert.notInclude(clipped.text, "\ufffd");
  assert.isAtMost(Buffer.byteLength(clipped.text), TRANSCRIPT_MESSAGE_BYTES + 24);
  const short = { ...item, text: "short answer" };
  assert.strictEqual(compactTranscriptItems([short])[0], short);
});
