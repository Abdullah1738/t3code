// Pure logic for spotting OpenCode event-stream losses in Robob's projection
// and deciding what each affected thread needs. No I/O in this file.

export const STREAM_LOST = "The OpenCode event stream was lost and could not reconnect.";
export const STREAM_CLOSED = "The provider event stream closed unexpectedly";

export const isStreamLost = (message) =>
  typeof message === "string" && message.startsWith("The OpenCode event stream was lost");
export const isStreamClosed = (message) =>
  typeof message === "string" && message.startsWith(STREAM_CLOSED);

export const toMs = (value) => (typeof value === "number" ? value : Date.parse(value));

export const hhmm = (value) => {
  const ms = toMs(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(11, 16) + "Z" : "??:??Z";
};

export const incidentId = (startMs) =>
  "sr-" + new Date(startMs).toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";

export const sessionFromProviderThread = (value) => {
  const match = /native-thread:(ses_[A-Za-z0-9]+)/.exec(value ?? "");
  return match ? match[1] : null;
};

// A nested subagent row stores its parent as the child's own thread id:
// thread:provider:opencode:provider-instance:opencode:native-thread:ses_X.
// The row that launched that child has provider_thread_id with the same tail.
export const isNestedThreadId = (threadId) => typeof threadId === "string" && threadId.startsWith("thread:provider:");
export const providerThreadFor = (nestedThreadId) => nestedThreadId.replace(/^thread:/, "provider-thread:");

export const turnPromptId = (sessionId, attemptId) => `msg_t3_turn_${sessionId}:${attemptId}`;
export const steerPromptId = (sessionId, messageId) => `msg_t3_steer_${sessionId}:${messageId}`;

export const robobNativeMessageId = (robobMessageId) => {
  const match = /native-item:(msg_[A-Za-z0-9]+)/.exec(robobMessageId ?? "");
  return match ? match[1] : null;
};

const norm = (text) => String(text ?? "").replace(/\s+/g, " ").trim();

export const truncate = (text, max) => {
  const value = String(text ?? "");
  return value.length <= max ? value : value.slice(0, max - 1).trimEnd() + "…";
};

// signals: [{kind:'run', at, error, ...} | {kind:'subagent', at, result, ...}]
// Returns clusters that look like a failAll: at least one run failed with the
// stream-lost error, or at least `minBurst` subagents failed with no result
// within `burstMs` of each other.
export function findIncidents(signals, { gapMs = 10 * 60_000, minBurst = 3, burstMs = 2_000 } = {}) {
  const relevant = signals
    .filter((s) =>
      s.kind === "run" ? isStreamLost(s.error) || isStreamClosed(s.error) : s.kind === "subagent" && s.result == null,
    )
    .map((s) => ({ ...s, ms: toMs(s.at) }))
    .filter((s) => Number.isFinite(s.ms))
    .sort((a, b) => a.ms - b.ms);

  const clusters = [];
  for (const signal of relevant) {
    const last = clusters.at(-1);
    if (last && signal.ms - last.endMs <= gapMs) {
      last.signals.push(signal);
      last.endMs = signal.ms;
    } else {
      clusters.push({ startMs: signal.ms, endMs: signal.ms, signals: [signal] });
    }
  }

  return clusters
    .filter((cluster) => {
      if (cluster.signals.some((s) => s.kind === "run" && isStreamLost(s.error))) return true;
      // A subagent burst alone is not enough (mass 400s also leave a few
      // result-less rows); it needs a stream-closed run next to it.
      if (!cluster.signals.some((s) => s.kind === "run" && isStreamClosed(s.error))) return false;
      const subs = cluster.signals.filter((s) => s.kind === "subagent");
      for (let i = 0; i < subs.length; i += 1) {
        const burst = subs.filter((s) => s.ms >= subs[i].ms && s.ms - subs[i].ms <= burstMs);
        if (burst.length >= minBurst) return true;
      }
      return false;
    })
    .map((cluster) => {
      // Stray subagent failures on their own are not part of the incident
      // unless they sit in the burst window around a run failure or another
      // subagent failure.
      const runs = cluster.signals.filter((s) => s.kind === "run");
      const subagents = cluster.signals.filter((s) => s.kind === "subagent");
      const failAllMs = earliestBurst(subagents, burstMs, minBurst) ?? cluster.startMs;
      return {
        id: incidentId(cluster.startMs),
        startMs: cluster.startMs,
        endMs: cluster.endMs,
        failAllMs,
        runs,
        subagents,
      };
    });
}

function earliestBurst(subagents, burstMs, minBurst) {
  for (let i = 0; i < subagents.length; i += 1) {
    const burst = subagents.filter((s) => s.ms >= subagents[i].ms && s.ms - subagents[i].ms <= burstMs);
    if (burst.length >= minBurst) return subagents[i].ms;
  }
  return null;
}

// robobMessages: [{messageId, text, primary, createdAt}], ocUserMessages: [{id, text}]
export function lostMessages({ sessionId, attemptId, robobMessages, ocUserMessages }) {
  const ocIds = new Set(ocUserMessages.map((m) => m.id));
  const ocTexts = ocUserMessages.map((m) => norm(m.text));
  return robobMessages.filter((message) => {
    const text = norm(message.text);
    if (!text) return false;
    const expected = message.primary
      ? attemptId
        ? turnPromptId(sessionId, attemptId)
        : null
      : steerPromptId(sessionId, message.messageId);
    if (expected && ocIds.has(expected)) return false;
    const probe = text.slice(0, 200);
    return !ocTexts.some((t) => t.includes(probe));
  });
}

// ocMessages newest first. Returns the latest assistant text OpenCode wrote
// between `sinceMs` and `untilMs` that Robob never stored, or null.
export function invisibleReply({ ocMessages, sinceMs, untilMs = Infinity, robobNativeIds }) {
  for (const message of ocMessages) {
    if (message.type !== "assistant") continue;
    const created = toMs(message.time?.created);
    if (created > untilMs) continue;
    if (!(created >= sinceMs)) break;
    const text = assistantText(message);
    if (!text) continue;
    if (robobNativeIds.has(message.id)) return null;
    return { id: message.id, at: created, text };
  }
  return null;
}

export const assistantText = (message) =>
  (Array.isArray(message.content) ? message.content : [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();

// session: {active, updatedMs} from OpenCode. Returns running | finished | stale.
export function orphanStatus({ active, updatedMs, failAllMs, recentWindowMs = 30 * 60_000 }) {
  if (active) return "running";
  if (Number.isFinite(updatedMs) && updatedMs >= failAllMs - recentWindowMs) return "finished";
  return "stale";
}

// Decide what a thread needs. Input fields:
//  thread {threadId,title,origin,archived,nativeSessionId}
//  failedRuns [...], recovered bool, session {active, updatedMs} | null,
//  lost [...], reply {text,at} | null, orphans [{status,...}], forms [...], held [...]
export function planThread(input, { staleMs = 6 * 3_600_000 } = {}) {
  const { thread, failedRuns = [], recovered = false, session = null, lost = [], reply = null } = input;
  const orphans = (input.orphans ?? []).filter((o) => o.status !== "stale");
  const forms = input.forms ?? [];
  const held = input.held ?? [];
  const failMs = failedRuns.length ? Math.min(...failedRuns.map((r) => toMs(r.completedAt))) : null;
  const plan = { threadId: thread.threadId, title: thread.title, origin: thread.origin ?? null, resumeQueue: held.length > 0 };

  if (thread.archived) return { ...plan, action: "skip", reason: "archived", resumeQueue: false };
  if (thread.origin === "crw") {
    return { ...plan, action: held.length ? "release" : "skip", reason: "crw review thread (crw handles it)" };
  }
  if (thread.origin === "imessage") {
    const report = lost.length > 0 || reply != null;
    return { ...plan, action: report ? "report" : held.length ? "release" : "skip", reason: "iMessage bridge thread" };
  }

  const actionable = lost.length + orphans.length + forms.length + held.length;
  if (failMs != null && !recovered) {
    const stale =
      session && !session.active && Number.isFinite(session.updatedMs) && session.updatedMs < failMs - staleMs;
    if (stale && actionable === 0) return { ...plan, action: "skip", reason: "stale session (idle for hours before the drop)" };
    return { ...plan, action: "note", reason: session?.active ? "OpenCode still working, Robob detached" : "turn failed, not resumed" };
  }
  if (actionable === 0) return { ...plan, action: "skip", reason: failMs == null ? "nothing pending" : "recovered on its own" };
  return { ...plan, action: "note", reason: "recovered, but has lost items" };
}

const fence = (text) => text.replace(/```/g, "'''");

export function buildNote({ incident, plan, lost = [], reply = null, orphans = [], forms = [], held = [], recovered = false, ocUrl }) {
  const at = hhmm(incident.failAllMs ?? incident.startMs);
  const parts = [
    `[stream-recovery] Robob lost the OpenCode event stream at ${at} and marked this thread's turn failed. OpenCode may have kept working, but Robob stopped showing your output and dropped the wake-ups from background subagents. This note re-attaches the thread.`,
  ];
  const auth = `-u "opencode:$(cat ~/.config/opencode-service/password)"`;

  if (lost.length) {
    parts.push(
      `Messages sent to this thread that never reached you (verbatim):\n` +
        lost
          .map((m, i) => `--- message ${i + 1} (sent ${hhmm(m.createdAt)}) ---\n${fence(truncate(m.text, 4000))}`)
          .join("\n") +
        `\n--- end ---`,
    );
  }
  if (reply) {
    parts.push(
      `Your reply at ${hhmm(reply.at)} never showed in Robob, so the owner hasn't seen it. Here it is for the record:\n> ` +
        fence(truncate(reply.text, 2500)).replace(/\n/g, "\n> "),
    );
  }
  const live = orphans.filter((o) => o.status !== "stale");
  if (live.length) {
    parts.push(
      `Background subagents Robob lost track of (their wake-ups won't arrive; don't relaunch them):\n` +
        live
          .map((o) => {
            const where = o.nestedUnder ? ` (launched by ${o.nestedUnder})` : "";
            const state =
              o.status === "running"
                ? "still running"
                : `finished ${o.updatedMs ? hhmm(o.updatedMs) : ""}${o.excerpt ? `: "${fence(truncate(o.excerpt, 400))}"` : ""}`;
            return `- ${o.sessionId} "${truncate(o.title ?? "subagent", 80)}"${where}: ${state}`;
          })
          .join("\n") +
        `\nRead a subagent's output with: curl -s ${auth} "${ocUrl}/api/session/<ses>/message?limit=5" (newest first). Check running ones again before you finish your turn.`,
    );
  }
  if (forms.length) {
    parts.push(
      `OpenCode questions Robob never showed (the session is blocked until answered):\n` +
        forms
          .map((f) => {
            const fields = (f.fields ?? [])
              .map((field) => {
                const options = (field.options ?? []).map((o) => o.label ?? o.value).filter(Boolean);
                return `  ${field.key}: ${truncate([field.title, field.description].filter(Boolean).join(" - "), 600)}${options.length ? ` [options: ${options.join(" / ")}]` : ""}`;
              })
              .join("\n");
            return `- session ${f.sessionId}, form ${f.formId}${f.title ? ` "${truncate(f.title, 120)}"` : ""}\n${fields}`;
          })
          .join("\n") +
        `\nAsk Abdullah with your question tool (don't guess), then answer: curl -s ${auth} -X POST -H 'content-type: application/json' -d '{"answer":{"<field key>":"<value>"}}' "${ocUrl}/api/session/<ses>/form/<formID>/reply" (a multiselect field takes a list of values).`,
    );
  }
  if (held.length) {
    parts.push(
      `Robob had held ${held.length} queued message(s) for this thread after the failure. They're released now and reach you as separate turns.`,
    );
  }
  if (!recovered && !lost.length && !reply && !live.length && !forms.length) {
    parts.push(`Check where you were when the stream dropped and continue. If you had already finished, post your last status in one line.`);
  }
  parts.push(
    `Then post a one-line status and carry on. If you already handed this lane to a newer thread, pass anything relevant to it and stop.`,
  );
  return parts.join("\n\n");
}

export function buildSummary({ incident, results }) {
  const runs = incident.runs.length;
  const threads = new Set(incident.runs.map((r) => r.threadId)).size;
  const lines = [
    `OpenCode stream drop at ${hhmm(incident.failAllMs ?? incident.startMs)}: ${runs} turn(s) failed in ${threads} thread(s), ${incident.subagents.length} background subagent(s) lost.`,
  ];
  const by = (action) => results.filter((r) => r.plan.action === action);
  const name = (r) => truncate(r.plan.title ?? r.plan.threadId, 40);
  const noted = by("note").filter((r) => r.ok);
  if (noted.length) lines.push(`Resumed ${noted.length}: ${noted.map(name).join("; ")}.`);
  const released = results.filter((r) => r.plan.resumeQueue && r.queueOk);
  if (released.length) lines.push(`Released held queues: ${released.map(name).join("; ")}.`);
  const skipped = results.filter((r) => r.plan.action === "skip");
  if (skipped.length) {
    const reasons = {};
    for (const r of skipped) reasons[r.plan.reason] = (reasons[r.plan.reason] ?? 0) + 1;
    lines.push(`Left alone: ${Object.entries(reasons).map(([k, v]) => `${v} ${k}`).join(", ")}.`);
  }
  for (const r of by("report")) {
    const lost = (r.lost ?? []).map((m) => `"${truncate(m.text, 80)}"`).join(", ");
    const reply = r.reply ? ` OpenCode replied "${truncate(r.reply.text, 160)}" but Robob lost it, so the bridge may not have sent it.` : "";
    lines.push(`iMessage (${name(r)}):${lost ? ` message ${lost} never reached OpenCode.` : ""}${reply}`);
  }
  for (const r of results) {
    for (const f of r.forms ?? []) {
      lines.push(`Waiting on you: ${f.sessionId} "${truncate(f.title ?? f.fields?.[0]?.title ?? "question", 80)}" (thread ${name(r)}); the thread was told to ask you.`);
    }
  }
  const failed = results.filter((r) => r.error);
  if (failed.length) lines.push(`Errors: ${failed.map((r) => `${name(r)}: ${truncate(r.error, 120)}`).join("; ")}.`);
  const attention = by("report").length > 0 || results.some((r) => (r.forms ?? []).length) || failed.length > 0;
  return { text: truncate(lines.join("\n"), 3500), severity: attention ? "attention" : "info" };
}
