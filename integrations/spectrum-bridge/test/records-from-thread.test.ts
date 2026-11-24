import { expect, test } from "bun:test";
import { epoch, type ControlMessage, type RunSummary, type ThreadDetail } from "../src/control.ts";
import { isCompletionNoticeText, subagentNoticeState, type MessageRecord } from "../src/openchamber.ts";
import { GUIDANCE_START, GUIDANCE_END, recordsFromThread as optimizedRecordsFromThread, SELECTED_MODEL_ISSUE, sentMessagePrefix, withoutGuidance } from "../src/robob.ts";
import { toolError } from "../src/toollog.ts";

// The pre-optimization implementation is kept verbatim as an independent oracle.
const TERMINAL = new Set(["completed", "waiting", "failed", "cancelled", "interrupted", "rolled_back"]);
const outcome = (status: string): "succeeded" | "failed" | "interrupted" =>
  status === "completed" || status === "waiting" ? "succeeded" : status === "failed" ? "failed" : "interrupted";
function runFailure(thread: Pick<ThreadDetail, "lastError">, run: RunSummary, messages: ControlMessage[], latest: boolean): string | undefined {
  if (!TERMINAL.has(run.status)) return;
  const complaint = messages.find(message => message.runId === run.runId && message.role === "assistant" && SELECTED_MODEL_ISSUE.test(message.text))?.text;
  return (latest && (run.status === "failed" || run.ordinal === 1 || complaint) && thread.lastError) || complaint || (run.status === "failed" ? "Run failed without error details" : undefined);
}

function promptId(threadId: string, message: ControlMessage): string {
  const prefix = sentMessagePrefix(threadId);
  if (!message.messageId.startsWith(prefix)) return message.messageId;
  try { return decodeURIComponent(message.messageId.slice(prefix.length)); } catch (caughtError) { toolError("robob", "robob.catch1", caughtError); return message.messageId; }
}

/** The router's prompt ids (`msg_` plus a sha256), which it sends as `clientRequestId`. */
const BRIDGE_PROMPT = /^msg_[0-9a-f]{64}$/;
const runOrdinal = (runId: string) => Number(/:ordinal:(\d+)$/.exec(runId)?.[1] ?? 0);

export function recordsFromThread(thread: Pick<ThreadDetail, "threadId" | "recentRuns" | "run" | "lastError">, messages: ControlMessage[]): MessageRecord[] {
  const runs = new Map<string, RunSummary>();
  for (const run of [...thread.recentRuns ?? [], ...(thread.run ? [thread.run] : [])]) runs.set(run.runId, run);
  const ordinal = (runId: string) => runs.get(runId)?.ordinal ?? runOrdinal(runId);
  const byRun = new Map<string, ControlMessage[]>();
  for (const message of messages) {
    if (message.runId === null || message.role === "system") continue;
    byRun.set(message.runId, [...byRun.get(message.runId) ?? [], message]);
  }
  const latest = [...runs.values()].sort((a, b) => b.ordinal - a.ordinal)[0]?.runId;
  const records: MessageRecord[] = [];
  for (const [runId, group] of [...byRun].sort((a, b) => ordinal(a[0]) - ordinal(b[0]))) {
    group.sort((a, b) => epoch(a.createdAt) - epoch(b.createdAt) || a.messageId.localeCompare(b.messageId, undefined, { numeric: true }));
    const run = runs.get(runId);
    const settled = run !== undefined && TERMINAL.has(run.status);
    let last: Extract<MessageRecord, { type: "assistant" }> | undefined;
    for (const message of group) {
      const created = epoch(message.createdAt);
      if (message.role === "user") {
        const id = promptId(thread.threadId, message);
        const bridgeSent = id !== message.messageId && BRIDGE_PROMPT.test(id);
        const notice = isCompletionNoticeText(message.text) || subagentNoticeState(message.text) !== undefined;
        if (message.createdBy !== undefined && message.createdBy !== "user" && !bridgeSent && !notice) continue;
        records.push({ id, type: "user", text: withoutGuidance(message.text), time: { created },
          ...(notice && message.createdBy !== undefined ? { createdBy: message.createdBy } : {}) });
        continue;
      }
      const done = settled || !message.streaming;
      // Robob's own phase says whether this text was the reply. It is never a made-up OpenCode finish:
      // `unknown` stays unmarked, so the router treats it as neither an answer nor proof of a tool.
      last = {
        id: message.messageId, type: "assistant", content: [{ type: "text", text: message.text }], runId,
        ...(message.phase === "answer" ? { answer: true } : message.phase === "narration" ? { answer: false } : {}),
        time: { created, ...(done ? { completed: epoch(message.updatedAt, created) } : {}) },
      };
      records.push(last);
    }
    if (!settled || !run) continue;
    const failure = runFailure(thread, run, group, runId === latest);
    const result = failure ? "failed" : outcome(run.status);
    if (failure) {
      // Carries the provider's error text, which is how a refusal is recognised.
      const error = { type: "provider", message: failure };
      if (last) last.error = error;
      else records.push({ id: `${runId}:error`, type: "assistant", content: [], runId, finish: "error", error, time: { created: epoch(group.at(-1)?.updatedAt ?? null), completed: epoch(group.at(-1)?.updatedAt ?? null) } });
    }
    records.push({ id: `idle:${runId}`, type: "idle", outcome: result,
      ...(run.completedAt ? { completedAt: epoch(run.completedAt) } : {}),
      ...(failure && run.ordinal === 1 ? { firstTurnFailure: true } : {}),
      ...(group.some(message => message.role === "assistant" && SELECTED_MODEL_ISSUE.test(message.text)) ? { modelError: true } : {}),
      time: { created: epoch(group.at(-1)?.updatedAt ?? null) } });
  }
  return records;
}

// Run diagnostics for the log (#137) came after the optimization; the oracle predates them.
const withoutDiag = (records: MessageRecord[]) => records.map(record => {
  if (record.type !== "idle" || !("diag" in record)) return record;
  const { diag: _diag, ...rest } = record;
  return rest;
});

test("recordsFromThread matches the original on 512 seeded mixed histories", () => {
  let seed = 0x93b0d6e7;
  const random = (limit: number) => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return (seed >>> 0) % limit;
  };
  const pick = <T,>(values: readonly T[]): T => values[random(values.length)]!;
  const statuses = ["running", "queued", "needs-input", "completed", "waiting", "failed", "cancelled", "interrupted", "rolled_back"];
  const dates = [null, "", "invalid", "1970-01-01T00:00:00Z", "2026-11-15T09:30:00.000Z", "2026-11-15T10:30:00+01:00", "2026-11-15T09:30:01Z"];
  const texts = ["hello", "", "working", "There's an issue with the selected model (test).", "there is an issue with the selected model (x): unavailable",
    `${GUIDANCE_START}\nprivate\n${GUIDANCE_END}\n\nowner words`, `${GUIDANCE_START} incomplete`,
    'Delegated task node:delegated-task:child (work) [completed]:\nresult',
    '<subagent sessionID="child" state="running" description="work">progress</subagent>',
    '<subagent sessionID="child" state="completed" description="work">done</subagent>',
    '<subagent state="failed">error</subagent>'];
  for (let caseIndex = 0; caseIndex < 512; caseIndex++) {
    const recentRuns: RunSummary[] = Array.from({ length: 1 + random(6) }, (_, i) => ({
      runId: `run:thread:t:ordinal:${i + 1}`, ordinal: random(4), status: statuses[(i + caseIndex) % statuses.length]!, completedAt: pick(dates),
    }));
    const thread: Pick<ThreadDetail, "threadId" | "recentRuns" | "run" | "lastError"> = {
      threadId: "t", recentRuns, run: caseIndex % 3 ? { ...pick(recentRuns), status: pick(statuses), ordinal: random(5) } : null,
      lastError: pick([null, "", "Provider blocked the response", "connection failed"]),
    };
    const ids = [...recentRuns.map(run => run.runId), "run:thread:t:ordinal:17", "unknown", null];
    const messages: ControlMessage[] = Array.from({ length: caseIndex % 32 === 0 ? 1_500 : random(120) }, (_, i) => ({
      messageId: pick([`message-${random(12)}`, `message-0${random(12)}`, `${sentMessagePrefix("t")}${encodeURIComponent(`msg_${"a".repeat(64)}`)}`, `${sentMessagePrefix("t")}notice%20id`]),
      runId: pick(ids), role: pick(["user", "assistant", "system"] as const), text: texts[(i + caseIndex) % texts.length]!,
      streaming: !!random(2), phase: pick([undefined, "answer", "narration", "unknown"] as const),
      createdBy: pick([undefined, "user", "system", "agent"]), createdAt: pick(dates), updatedAt: pick(dates),
    }));
    // Duplicate references exercise stable sorting without mutating the input array.
    if (messages.length) messages.push(pick(messages));
    const original = structuredClone({ thread, messages });
    expect(withoutDiag(optimizedRecordsFromThread(thread, messages))).toEqual(recordsFromThread(thread, messages));
    expect({ thread, messages }).toEqual(original);
    if (messages.length) {
      messages[0]!.createdAt = pick(dates); messages[0]!.text = pick(texts);
      expect(withoutDiag(optimizedRecordsFromThread(thread, messages))).toEqual(recordsFromThread(thread, messages));
    }
  }
});
