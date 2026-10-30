// Pure logic for the stall watch: spot OpenCode sessions that stay "running"
// while nothing changes, and decide how to clear each one. No I/O in this file.

import { createHash } from "node:crypto";
import { hhmm, isNestedThreadId, toMs, truncate } from "./detect.mjs";

// Opus (our slowest silent thinker) may sit silent up to its 15 min
// chunkTimeout, so a model wait counts as dead after twice that. Providers
// without a chunkTimeout get the same bound.
export const LLM_QUIET_MS = 30 * 60_000;
// A running tool's output never reaches the message, so the only bound is the
// tool's own: a shell past its timeout plus this margin is hung. Other tools
// get TOOL_QUIET_MS, and a shell with its timeout turned off gets
// NO_TIMEOUT_MS.
export const SHELL_MARGIN_MS = 30 * 60_000;
export const SHELL_DEFAULT_TIMEOUT_MS = 120_000;
export const TOOL_QUIET_MS = 2 * 3_600_000;
export const NO_TIMEOUT_MS = 8 * 3_600_000;
// After a Robob interrupt, wait this long before interrupting OpenCode directly.
export const FALLBACK_MS = 2 * 60_000;
// Stop following an interrupted stall after this and report it as not cleared.
export const GIVE_UP_MS = 10 * 60_000;
// More stalls than this on one session in 24h are reported, not interrupted.
export const MAX_PER_DAY = 3;

const SUBAGENT_TOOLS = new Set(["subagent", "task"]);
const USER_TOOLS = new Set(["question"]);

const names = (parts) => [...new Set(parts.map((p) => p.name || "tool"))].join(", ");

// Fingerprint of the newest messages. OpenCode text and reasoning parts carry
// no timestamps, so an unchanged fingerprint across scans is what proves that
// nothing is streaming.
export const fingerprint = (messages) =>
  createHash("sha1").update(JSON.stringify(messages ?? [])).digest("hex");

// How long a running tool may stay quiet before it counts as hung.
export function toolLimit(part) {
  if (part?.name !== "shell") return TOOL_QUIET_MS;
  const timeout = part.state?.input?.timeout;
  if (timeout === 0) return NO_TIMEOUT_MS;
  return (Number(timeout) > 0 ? Number(timeout) : SHELL_DEFAULT_TIMEOUT_MS) + SHELL_MARGIN_MS;
}

// messages: newest-first OpenCode v2 messages. Returns the newest timestamp
// seen anywhere in them, what the session is waiting on and how long that may
// stay quiet (limitMs).
export function tailActivity(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let lastMs = 0;
  const bump = (value) => {
    const ms = toMs(value);
    if (Number.isFinite(ms) && ms > lastMs) lastMs = ms;
  };
  for (const m of list) {
    for (const v of Object.values(m?.time ?? {})) bump(v);
    if (m?.retry?.at != null) bump(m.retry.at);
    for (const p of Array.isArray(m?.content) ? m.content : []) {
      for (const v of Object.values(p?.time ?? {})) bump(v);
      for (const v of Object.values(p?.state?.time ?? {})) bump(v);
    }
  }
  // A steer or notice can land after an assistant message whose tool still
  // runs, so look at the tools of every message in the tail.
  const tools = list.flatMap((m) => (Array.isArray(m?.content) ? m.content : [])).filter((p) => p?.type === "tool");
  const running = tools.filter((p) => p.state?.status === "running");
  if (running.some((p) => USER_TOOLS.has(p.name))) {
    return { lastMs, kind: "user", label: "waiting on a question", limitMs: Infinity };
  }
  if (running.some((p) => SUBAGENT_TOOLS.has(p.name))) {
    return { lastMs, kind: "subagent", label: "waiting on a subagent", limitMs: TOOL_QUIET_MS };
  }
  if (running.length) {
    return { lastMs, kind: "tool", label: `running ${names(running)}`, limitMs: Math.max(...running.map(toolLimit)) };
  }
  const streaming = tools.filter((p) => p.state?.status === "streaming" || p.state?.status === "pending");
  if (streaming.length) {
    return { lastMs, kind: "llm", label: `model stream died mid tool call (${names(streaming)})`, limitMs: LLM_QUIET_MS };
  }
  return { lastMs, kind: "llm", label: "waiting on the model", limitMs: LLM_QUIET_MS };
}

// prev: {fp, since} from the last scan. The clock restarts whenever the
// fingerprint changes, and on the first sighting.
export const observe = (prev, fp, now) => (prev && prev.fp === fp ? prev : { fp, since: now });

export const quietSince = (watch, lastMs) => Math.max(watch.since, lastMs || 0);

export const stallId = (ses, sinceMs) =>
  `st-${ses}-` + new Date(sinceMs).toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";

// A Robob run that shows as running while its OpenCode session sits idle never
// reached OpenCode (#433 after the 29 Oct restart). The session tail can't show
// it, so the watch tracks these from Robob's side and acts after this long.
export const GHOST_RUN_MS = 15 * 60_000;
export const GHOST_LABEL = "Robob showed the turn running, but its OpenCode session was idle";

// threads: control-API live threads; active: Set of OpenCode active session ids.
export function ghostCandidates(threads, active) {
  return threads.filter((t) =>
    t.state === "running" && Boolean(t.activeRunId) && typeof t.nativeSessionId === "string"
    && t.nativeSessionId.startsWith("ses_") && !t.pendingRequest && !t.archived && !active.has(t.nativeSessionId));
}

// Keeps `since` while the same run and session stay a candidate.
export function observeGhosts(prev, candidates, now) {
  const next = {};
  for (const t of candidates) {
    const old = prev?.[t.threadId];
    next[t.threadId] = old && old.runId === t.activeRunId && old.ses === t.nativeSessionId
      ? old
      : { runId: t.activeRunId, ses: t.nativeSessionId, since: now };
  }
  return next;
}

export function planGhost({ thread, recent = 0 }) {
  if (recent >= MAX_PER_DAY) return { action: "report", note: false, reason: `already interrupted ${recent} times in 24h` };
  const quiet = thread.origin === "crw" || thread.origin === "imessage";
  return { action: "robob", note: !quiet, reason: quiet ? `${thread.origin} thread, run never reached OpenCode` : "run never reached OpenCode" };
}

// input: {ses, kind, limitMs, quietMs, waiting, childActive, parentID, thread, recent}
//  waiting: the session or Robob thread has a pending question/permission
//  thread: Robob thread from /threads/by-native, or null when unmapped
//  recent: stalls already acted on for this session in the last 24h
// action: skip | report | robob (interrupt the Robob thread) | opencode
// (interrupt the OpenCode session directly; subagent child sessions).
export function planStall(input) {
  const { ses, kind, limitMs, quietMs, thread = null, recent = 0 } = input;
  if (kind === "user" || input.waiting || thread?.pendingRequests?.length) {
    return { action: "skip", reason: "waiting on a user answer" };
  }
  if (kind === "subagent" && input.childActive) return { action: "skip", reason: "waiting on an active subagent" };
  if (!(quietMs >= limitMs)) return { action: "skip", reason: "not quiet long enough" };
  if (recent >= MAX_PER_DAY) return { action: "report", reason: `already interrupted ${recent} times in 24h` };
  if (input.parentID || (thread && isNestedThreadId(thread.threadId))) {
    return { action: "opencode", note: false, reason: "subagent session" };
  }
  if (!thread) return { action: "opencode", note: false, reason: "no Robob thread for this session" };
  // The thread moved on to a newer session; interrupting Robob would stop that
  // one instead.
  if (thread.nativeSessionId && thread.nativeSessionId !== ses) {
    return { action: "opencode", note: false, reason: "old session of a thread that moved on" };
  }
  const note = !thread.archived && thread.origin !== "crw" && thread.origin !== "imessage";
  const reason = thread.archived
    ? "archived thread"
    : thread.origin === "crw"
      ? "crw thread (crw nudges it once idle)"
      : thread.origin === "imessage"
        ? "iMessage bridge thread"
        : "hung turn";
  return { action: "robob", note, reason };
}

// After an interrupt: is the stall gone? stall.runId is the Robob run that hung
// (null when Robob had none to stop).
export function stallCleared({ stall, active, fp, thread }) {
  const robobDone = !stall.runId || !thread || thread.activeRunId !== stall.runId;
  const ocDone = sessionLetGo({ stall, active, fp });
  return { robobDone, ocDone, cleared: robobDone && ocDone };
}

// OpenCode let go once the session is no longer active or its tail changed.
export function sessionLetGo({ stall, active, fp }) {
  return !active || (fp != null && fp !== stall.fp);
}

export function buildStallNote(stall) {
  const mins = Math.round(stall.quietMs / 60_000);
  if (stall.kind === "ghost") {
    return `[stream-recovery] This thread hung: Robob showed a turn running since ${hhmm(stall.quietSince)}, but its OpenCode session sat idle for ${mins} min, so the stall watch interrupted it. That turn's message may never have reached you. Check where you were and carry on with the task.`;
  }
  const detail =
    stall.kind === "tool"
      ? `The tool that was running (${stall.label.replace(/^running /, "")}) was stopped, so its result may be missing or partial.`
      : stall.kind === "subagent"
        ? "The subagent call it was waiting on was stopped, so its result may be missing."
        : "Any tool call the model was still writing never ran.";
  return [
    `[stream-recovery] This thread hung: OpenCode stopped making progress at ${hhmm(stall.quietSince)} (${stall.label}) and nothing changed for ${mins} min, so the stall watch interrupted the turn.`,
    `${detail} Check where you were and carry on with the task.`,
  ].join(" ");
}

export function buildStallSummary(stall) {
  const mins = Math.round(stall.quietMs / 60_000);
  const who = `"${truncate(stall.title || stall.ses, 80)}"${stall.origin ? ` (${stall.origin})` : ""}`;
  const head = `Stall watch: ${who} sat ${mins} min with no progress since ${hhmm(stall.quietSince)}: ${stall.label}.`;
  const lines = [head];
  if (stall.parentTitle) lines.push(`Subagent of "${truncate(stall.parentTitle, 80)}".`);
  if (stall.outcome === "cleared") {
    lines.push(
      stall.action === "opencode"
        ? stall.reason === "subagent session"
          ? "Interrupted the OpenCode session; the parent gets the subagent result and carries on."
          : `Interrupted the OpenCode session (${stall.reason}).`
        : stall.note
          ? "Interrupted and told the thread to carry on."
          : `Interrupted (${stall.reason}).`,
    );
  } else if (stall.outcome === "report") {
    lines.push(`Not interrupted: ${stall.reason}. Session ${stall.ses}.`);
  } else {
    lines.push(`Could not clear it: ${stall.detail || "still stuck"}. Session ${stall.ses}.`);
  }
  if (stall.errors?.length) lines.push(`Errors: ${truncate(stall.errors.join("; "), 400)}`);
  const severity = stall.outcome === "cleared" ? "info" : stall.outcome === "report" ? "attention" : "error";
  return { text: truncate(lines.join("\n"), 3500), severity };
}
