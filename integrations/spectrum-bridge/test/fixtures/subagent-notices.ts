import type { ControlMessage } from "../../src/control.ts";
import type { MessageRecord } from "../../src/openchamber.ts";

// Captured read-only on 13 Nov from the Rufy thread's control messages and
// OpenCode session/message API (5 Nov). Identities and result text are sanitized.
const text = '<subagent sessionID="ses_child" state="completed" description="Check a cancellation (retry)">\nNothing to cancel.\n</subagent>';
export const robobSubagentNotice = {
  messageId: "message:thread:fixture:ordinal:0:notice", runId: "run:thread:fixture:ordinal:22",
  role: "user", text, phase: "unknown", streaming: false,
  createdBy: "agent", creationSource: "provider",
  createdAt: "2026-11-05T08:19:55.874Z", updatedAt: "2026-11-05T08:19:55.874Z",
} satisfies ControlMessage;
export const opencodeSubagentNotice = {
  id: "msg_notice", type: "synthetic", text,
  metadata: { source: "subagent", childID: "ses_child", agent: "General", state: "completed" },
  description: "Check a cancellation (retry)", time: { created: 1793866723517 },
} satisfies MessageRecord;
