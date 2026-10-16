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

// ---------- Robob restarts ----------
// Startup recovery marks every native subagent Robob still had open as
// cancelled with no result (ProviderRuntimeRecoveryService). A user Stop marks
// them interrupted, and a task_cancel or OpenCode interrupt cancels one at a
// time, so a cross-thread burst or a cancel right at a server start is a restart.

export const restartIncidentId = (startMs) =>
  "rs-" + new Date(startMs).toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";

// start: {pid, readyMs, procStartMs, prevSeenMs}. readyMs is
// server-runtime.json's startedAt, published once startup recovery is done;
// procStartMs is the process start from ps; prevSeenMs is the last scan that
// saw the previous server alive, so a graceful shutdown's cancels count too.
export function serverStartWindow(start, { marginMs = 60_000, startupMs = 5 * 60_000, maxDownMs = 30 * 60_000 } = {}) {
  const ready = toMs(start?.readyMs);
  if (!Number.isFinite(ready)) return null;
  const proc = toMs(start?.procStartMs);
  const launched = Number.isFinite(proc) && proc <= ready ? proc : ready - startupMs;
  const prev = toMs(start?.prevSeenMs);
  const from = Math.max(Math.min(launched - marginMs, Number.isFinite(prev) ? prev : Infinity), launched - maxDownMs);
  return { from, to: ready + marginMs, start };
}

// servers: [{pid, readyMs, procStartMs, firstSeenMs, lastSeenMs, prevSeenMs}]
// as seen by earlier scans; current: io.serverRuntime(). Returns a new list.
export function trackServer(servers, current, now, { keep = 20 } = {}) {
  const list = (servers ?? []).map((s) => ({ ...s }));
  if (!current) return list;
  const service = current.service ?? 'robob';
  const known = list.find((s) => (s.service ?? 'robob') === service && s.pid === current.pid && s.readyMs === current.readyMs);
  if (known) {
    known.lastSeenMs = now;
    return list;
  }
  const prev = list.findLast((s) => (s.service ?? 'robob') === service);
  list.push({ ...current, firstSeenMs: now, lastSeenMs: now, prevSeenMs: prev?.lastSeenMs ?? null });
  return list.slice(-keep);
}

// subs: cancelled subagent rows {completed_at, result, thread_id,
// parentThreadId, rootThreadId}. Clusters the result-less ones (gap <= gapMs).
// A cluster is a restart when it spans >= minThreads root threads with >=
// minBurst rows, or when any row falls in a server start window. A burst in
// one thread tree alone is a Stop (or task_cancel), not a restart.
export function findRestartIncidents(subs, { runs = [], serverStarts = [], gapMs = 10_000, minBurst = 3, minThreads = 2 } = {}) {
  const windows = serverStarts.map((s) => serverStartWindow(s)).filter(Boolean);
  const rows = subs
    .filter((s) => s.result == null)
    .map((s) => ({ ...s, ms: toMs(s.completed_at) }))
    .filter((s) => Number.isFinite(s.ms))
    .sort((a, b) => a.ms - b.ms);
  const clusters = [];
  for (const s of rows) {
    const last = clusters.at(-1);
    if (last && s.ms - last.at(-1).ms <= gapMs) last.push(s);
    else clusters.push([s]);
  }
  const incidents = clusters
    .map((cluster) => {
      const roots = new Set(cluster.map((s) => s.rootThreadId ?? s.parentThreadId ?? s.thread_id));
      const burst = cluster.length >= minBurst && roots.size >= minThreads;
      const win = windows.find((w) => cluster.some((s) => s.ms >= w.from && s.ms <= w.to));
      if (!burst && !win) return null;
      return {
        kind: "restart",
        id: win?.start.incidentId ?? restartIncidentId(cluster[0].ms),
        startMs: cluster[0].ms,
        endMs: cluster.at(-1).ms,
        failAllMs: cluster[0].ms,
        reason: win ? "server start" : "burst",
        serverStart: win?.start ?? null,
        windowFrom: win?.from ?? cluster[0].ms - 60_000,
        windowTo: win?.to ?? cluster.at(-1).ms + 60_000,
        runs: [],
        subagents: cluster.map(({ ms, ...s }) => ({ ...s, parentThreadId: s.parentThreadId ?? s.thread_id })),
      };
    })
    .filter(Boolean);
  // A slow startup can cancel separate thread trees more than ten seconds
  // apart. They still belong to one restart, with one note per thread.
  const merged = [];
  for (const incident of incidents) {
    const same = incident.serverStart && merged.find((i) => i.serverStart === incident.serverStart);
    if (same) {
      same.endMs = Math.max(same.endMs, incident.endMs);
      same.subagents.push(...incident.subagents);
    } else merged.push(incident);
  }
  for (const run of runs) {
    if (!['cancelled', 'failed'].includes(run.status) || isNestedThreadId(run.thread_id)) continue;
    if (run.status === 'cancelled' && !run.started_at && !run.dispatched) continue;
    const ms = toMs(run.completed_at);
    let incident = merged.find((i) => ms >= i.windowFrom && ms <= i.windowTo);
    if (!incident) {
      const win = windows.find((w) => ms >= w.from && ms <= w.to);
      if (!win) continue;
      incident = {
        kind: 'restart', id: win.start.incidentId ?? restartIncidentId(win.start.readyMs), startMs: ms, endMs: ms,
        failAllMs: ms, reason: 'server start', serverStart: win.start,
        windowFrom: win.from, windowTo: win.to, runs: [], subagents: [],
      };
      merged.push(incident);
    }
    incident.runs.push(run);
    incident.startMs = Math.min(incident.startMs, ms);
    incident.endMs = Math.max(incident.endMs, ms);
  }
  return merged;
}

const REDO_SUFFIX = /\s*\((?:resume|resumed|retry|re-?run|re-?launch|continue|continued|finish|restart|restarted)\b[^)]*\)\s*$/;
export const normTitle = (title) => String(title ?? "").toLowerCase().replace(REDO_SUFFIX, "").replace(/\s+/g, " ").trim();

// later: subagent rows started on the same thread after the cancel. The parent
// re-dispatched the lost one if it resumed the same session or relaunched it
// under the same title (optionally with a "(resume)"-style suffix).
export function findRedispatch(lost, later) {
  const title = normTitle(lost.title);
  const cutMs = toMs(lost.completed_at);
  return (
    later.find((s) => {
      if (s.subagent_id === lost.subagent_id || !(toMs(s.started_at) >= cutMs - 1_000)) return false;
      const ses = sessionFromProviderThread(s.provider_thread_id);
      if (lost.sessionId && ses === lost.sessionId) return true;
      return title.length >= 6 && normTitle(s.title) === title;
    }) ?? null
  );
}

// messages: newest-first OpenCode messages of the child session. Returns
// {status: finished | cut | stale, lastMs, finishedMs, excerpt, model}.
export function childOutcome(messages, { incidentMs, staleMs = 6 * 3_600_000 } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  let lastMs = 0;
  for (const m of list) {
    for (const v of Object.values(m?.time ?? {})) {
      const ms = toMs(v);
      if (Number.isFinite(ms) && ms > lastMs) lastMs = ms;
    }
  }
  const assistant = list.find((m) => m?.type === "assistant" && m.model);
  const model = assistant ? [assistant.model.providerID, assistant.model.id].filter(Boolean).join("/") : null;
  const base = { lastMs: lastMs || null, finishedMs: null, excerpt: null, model };
  if (lastMs && lastMs < incidentMs - staleMs) return { ...base, status: "stale" };
  const head = list.find((m) => m?.type !== "idle" && m?.type !== "system");
  if (head?.type === "assistant" && head.finish === "stop" && !head.error) {
    const text = assistantText(head);
    return {
      ...base,
      status: "finished",
      finishedMs: toMs(head.time?.completed ?? head.time?.created) || null,
      excerpt: text ? truncate(text, 600) : null,
    };
  }
  return { ...base, status: "cut" };
}

// OpenCode hands a finished background subagent's result to its parent as a
// synthetic "<subagent sessionID=...>" message, even when Robob drops the wake.
export const resultInHistory = (messages, ses) =>
  (messages ?? []).some((m) => String(m?.text ?? "").startsWith(`<subagent sessionID="${ses}"`));

export const RESTART_STALE_REASON = "only stale subagents (idle for hours before the restart)";
export const RESTART_BUSY_REASON = "fresh turn is running";
export const RESTART_RESUMED_REASON = "resumed by itself";
const NEEDS = new Set(["cut", "running", "finished"]);
const HANDLED = new Set(["redispatched", "delivered"]);

// lost: [{status: cut | running | finished | stale | redispatched | delivered, ...}]
// busy: a turn, question or OpenCode session is live on the thread now.
// ranAgain: a run started on the thread since its cut.
// windowOver: the hold-back for busy threads has run out.
// noteSent: this incident's note already reached the thread.
export function planRestartThread({
  thread, lost = [], turnCut = false, held = [], busy = false, ranAgain = false, windowOver = false, noteSent = false,
}) {
  const plan = { threadId: thread.threadId, title: thread.title, origin: thread.origin ?? null, resumeQueue: false };
  if (thread.archived) return { ...plan, action: "skip", reason: "archived" };
  const needs = lost.filter((l) => NEEDS.has(l.status));
  if (thread.origin === "imessage") {
    return { ...plan, action: turnCut || lost.length || held.length ? "report" : "skip", reason: "iMessage bridge thread" };
  }
  if (noteSent) return { ...plan, action: "note", reason: "note already sent", resumeQueue: held.length > 0 };
  if (!turnCut && !held.length && !lost.some((l) => l.status !== 'stale')) {
    const reason = lost.length && lost.every((l) => l.status === "stale") ? RESTART_STALE_REASON : "already re-dispatched or delivered";
    return { ...plan, action: "skip", reason };
  }
  if (windowOver && (busy || ranAgain)) {
    return { ...plan, action: "resumed", reason: RESTART_RESUMED_REASON, resumeQueue: held.length > 0 };
  }
  if (busy) return { ...plan, action: "skip", reason: RESTART_BUSY_REASON };
  const reason = turnCut
    ? "own turn cut off by restart"
    : needs.length
      ? `${needs.length} lost subagent(s) to pick up`
      : lost.some((l) => HANDLED.has(l.status))
        ? "handled subagents listed for handoff"
        : "held queue to release";
  return { ...plan, resumeQueue: held.length > 0, action: "note", reason };
}

const PROMPT_MAX = 1_200;
const PROMPTS_TOTAL = 10_000;

export function buildRestartNote({ incident, lost = [], turnCut = false, held = [], staleHeld = [], ocUrl }) {
  const at = hhmm(incident.failAllMs ?? incident.startMs);
  const needs = lost.filter((l) => NEEDS.has(l.status));
  const done = lost.filter((l) => l.status === "redispatched" || l.status === "delivered");
  const auth = `-u "opencode:$(cat ~/.config/opencode-service/password)"`;
  const parts = [
    `[stream-recovery] ${incident.serverStart?.service === 'opencode' ? 'OpenCode' : 'Robob'} restarted at ${at}` +
      (needs.length ? ` and cancelled ${needs.length} background subagent(s) this thread had running. Robob will not deliver their results, so nothing will wake you for them.` : '.') +
      (turnCut ? ` Your own turn was cut off by the same restart; carry on from where you were.` : ""),
    `On every macOS boot, dirhelper -machineBoot fully wipes $TMPDIR. Scratch files under $TMPDIR/opencode are gone after a Mac reboot; reconstruct missing briefs and reports from durable files or session history before resuming work.`,
  ];
  let budget = PROMPTS_TOTAL;
  const lines = needs.map((l, i) => {
    const head = `${i + 1}. "${truncate(l.title ?? "subagent", 100)}"${l.model ? ` (${l.model})` : ""}, session ${l.sessionId ?? "unknown"}, started ${l.startedAt ? hhmm(l.startedAt) : "?"}${l.nestedUnder ? `, launched by ${l.nestedUnder}` : ""}: `;
    if (l.status === "running") return `${head}still running in OpenCode, but its wake-up won't reach you through Robob. Don't relaunch it; check its output before you finish your turn.`;
    if (l.status === "finished") {
      const quote = l.excerpt ? `:\n   > ${fence(l.excerpt).replace(/\n/g, "\n   > ")}` : ".";
      return `${head}finished at ${l.finishedMs ? hhmm(l.finishedMs) : "?"}, but its result never reached you${quote}`;
    }
    let prompt = "";
    if (l.prompt && budget > 0) {
      const text = truncate(l.prompt.trim(), Math.min(PROMPT_MAX, budget));
      budget -= text.length;
      prompt = `\n   Original prompt${text.length < l.prompt.trim().length ? " (start)" : ""}:\n   \`\`\`\n${fence(text)}\n   \`\`\``;
    } else if (l.prompt) {
      prompt = `\n   Original prompt: in your earlier subagent call.`;
    }
    return `${head}cut off by the restart.${prompt}`;
  });
  if (lines.length) parts.push(`Lost subagents:\n${lines.join("\n")}`);
  if (done.length) {
    parts.push(
      `Already handled, no action needed: ` +
        done
          .map((l) =>
            l.status === "redispatched"
               ? `"${truncate(l.title ?? "subagent", 60)}" (session ${l.sessionId ?? 'unknown'}; re-dispatched as "${truncate(l.redo?.title ?? "subagent", 60)}" at ${hhmm(l.redo?.started_at)})`
               : `"${truncate(l.title ?? "subagent", 60)}" (session ${l.sessionId ?? 'unknown'}; its result is in your history)`,
          )
          .join("; ") +
        ".",
    );
  }
  if (needs.some((l) => l.status === "cut")) {
    parts.push(
      `For each cut-off subagent you still need, resume it with your subagent tool: pass its session id as the session to continue, with a short prompt such as "Robob restarted and cut you off. Carry on from where you stopped and finish the task." It keeps its context. Re-dispatch from the original prompt only if the resume fails. Skip any you no longer need or already relaunched.`,
    );
  }
  if (staleHeld.length) parts.push(`Cancelled stale held coordination pulses (over 2h old):\n` + staleHeld.map((r) =>
    `- ${r.run_id}, queued ${hhmm(r.requested_at)}: ${fence(truncate(r.text ?? '', 240))}`).join('\n'));
  if (held.length) parts.push(`Robob had held ${held.length} queued message(s). Recovery is releasing the queue; these reach you as separate turns.`);
  parts.push(
    (lost.length ? `Read a subagent's output with: curl -s ${auth} "${ocUrl}/api/session/<ses>/message?limit=5" (newest first). ` : '') +
    `Then post a one-line status and carry on. If you already handed this lane to a newer thread, pass this recovery note, including every listed child session and result, to it and stop.`,
  );
  return parts.join("\n\n");
}

// One line per bucket, every thread named: noted, resumed by itself, queue
// released, skipped (with reason), iMessage reports, queues still held, errors.
export function buildRestartSummary({ incident, results }) {
  const runs = incident.runs ?? [];
  const threads = new Set([...incident.subagents.map((s) => s.parentThreadId ?? s.thread_id), ...runs.map((r) => r.thread_id)]);
  for (const r of results) threads.add(r.plan.threadId);
  const turnThreads = new Set(runs.map((r) => r.thread_id));
  const lines = [
    `Robob restart at ${hhmm(incident.failAllMs ?? incident.startMs)} hit ${threads.size} thread(s): ${turnThreads.size} with their own turn cut off, ${incident.subagents.length} background subagent(s) cancelled.`,
  ];
  const name = (r) => truncate(r.plan.title || r.plan.threadId, 40);
  const what = (r) => {
    const parts = [];
    if (r.turnCut) parts.push("turn cut");
    const need = (r.lostSubs ?? []).filter((l) => NEEDS.has(l.status)).length;
    const done = (r.lostSubs ?? []).filter((l) => HANDLED.has(l.status)).length;
    if (need) parts.push(`${need} subagent(s) to pick up`);
    if (done) parts.push(`${done} handled subagent(s) listed`);
    return parts.length ? ` (${parts.join(", ")})` : "";
  };
  // Capped per bucket so a big restart still fits one Telegram message.
  const list = (rs, fmt) => rs.slice(0, SUMMARY_NAMES).map(fmt).join("; ") + (rs.length > SUMMARY_NAMES ? `; +${rs.length - SUMMARY_NAMES} more` : "");
  const noted = results.filter((r) => r.plan.action === "note" && r.ok && !r.error);
  if (noted.length) lines.push(`Noted: ${list(noted, (r) => `${name(r)}${what(r)}`)}.`);
  const resumed = results.filter((r) => r.plan.action === "resumed");
  if (resumed.length) lines.push(`Resumed by themselves (no note): ${list(resumed, (r) => `${name(r)}${what(r)}`)}.`);
  const released = results.filter((r) => r.queueOk);
  if (released.length) {
    lines.push(`Queue released: ${list(released, (r) => `${name(r)} (${r.held}${r.staleHeld?.length ? `, ${r.staleHeld.length} stale pulse(s) cancelled` : ""})`)}.`);
  }
  const skipped = results.filter((r) => r.plan.action === "skip" && !r.error);
  if (skipped.length) lines.push(`Skipped: ${list(skipped, (r) => `${name(r)} (${r.plan.reason})`)}.`);
  for (const r of results.filter((x) => x.plan.action === "report")) {
    const lost = (r.lostSubs ?? []).filter((l) => NEEDS.has(l.status)).map((l) => `"${truncate(l.title ?? l.sessionId, 60)}" (${l.sessionId})`);
    const bits = [r.turnCut ? "turn cut" : null, lost.length ? `lost ${lost.join(", ")}` : null].filter(Boolean);
    lines.push(`iMessage (${name(r)}): ${bits.join("; ") || "affected"}; the thread was not told.`);
  }
  const held = results.filter((r) => r.held > 0 && !r.queueOk && r.plan.reason !== "archived");
  if (held.length) lines.push(`Queues still held: ${list(held, (r) => `${name(r)} (${r.held})`)}.`);
  const failed = results.filter((r) => r.error);
  if (failed.length) lines.push(`Errors: ${list(failed, (r) => `${name(r)}: ${truncate(r.error, 120)}`)}.`);
  // A thread that moved on without being told about cut subagents may need a look.
  const unpicked = resumed.some((r) => (r.lostSubs ?? []).some((l) => NEEDS.has(l.status)));
  const attention = results.some((r) => r.plan.action === "report") || failed.length > 0 || unpicked;
  return { text: truncate(lines.join("\n"), 3500), severity: attention ? "attention" : "info" };
}

const SUMMARY_NAMES = 12;

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
