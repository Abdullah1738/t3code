import { assert, it } from "@effect/vitest";
import {
  continuationReport,
  markContinuationDeclined,
  markContinuationDispatched,
  recordContinuationDecision,
} from "./report.ts";

it("keeps a successful continuation when a separate queue wake is deferred", () => {
  const threadId = "report:active-and-queued";
  recordContinuationDecision({ threadId, continued: true });
  markContinuationDispatched(threadId);
  markContinuationDeclined(threadId, "queue_admission_deferred");
  const thread = continuationReport().threads.find((entry) => entry.threadId === threadId);
  assert.equal(thread?.continued, true);
  assert.equal(thread?.dispatched, true);
  assert.isUndefined(thread?.reason);
});

it("reports a queue that could not start when no continuation was dispatched", () => {
  const threadId = "report:only-queued";
  recordContinuationDecision({ threadId, continued: true });
  markContinuationDeclined(threadId, "queue_held");
  const thread = continuationReport().threads.find((entry) => entry.threadId === threadId);
  assert.equal(thread?.continued, false);
  assert.equal(thread?.reason, "queue_held");
});
