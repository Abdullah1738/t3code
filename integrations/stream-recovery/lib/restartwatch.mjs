// Restart watch: Robob's startup recovery cancels every native subagent it
// still had open, with no result and no wake-up for the parent. Spot those
// cancels, tell each parent thread what it lost (once), and send one Telegram
// summary per restart. The caller loads and saves state.
import * as realIo from "./io.mjs";
import {
  buildRestartNote, buildRestartSummary, childOutcome, findRedispatch, findRestartIncidents, hhmm,
  isNestedThreadId, planRestartThread, providerThreadFor, resultInHistory, sessionFromProviderThread, toMs,
  trackServer, truncate,
} from "./detect.mjs";

// Long enough for a thread that resumes on its own (or gets the installer's
// resume message) to re-dispatch first, so the note can say so.
export const RESTART_SETTLE_MS = 180_000;
export const INSTALLER_WAIT_MS = 30 * 60_000;
const MAX_ATTEMPTS = 3;

const errText = (err) => String(err?.message || err).slice(0, 300);
const isoOf = (ms) => new Date(ms).toISOString();

async function safe(fn, fallback) {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

function topParent(io, db, threadId) {
  let t = threadId;
  for (let i = 0; i < 5 && t && isNestedThreadId(t); i++) t = io.subagentParent(db, providerThreadFor(t));
  return t && !isNestedThreadId(t) ? t : null;
}

async function lostSubagent({ io, db, sub, active, incident }) {
  const sessionId = sessionFromProviderThread(sub.provider_thread_id);
  const base = {
    subagentId: sub.subagent_id, sessionId, title: sub.title ?? null, model: sub.model ?? null,
    prompt: sub.prompt ?? null, startedAt: sub.started_at ?? null, cancelledAt: sub.completed_at,
    nestedUnder: isNestedThreadId(sub.thread_id) ? sessionFromProviderThread(sub.thread_id) : null,
  };
  const later = io.subagentsStartedSince(db, sub.thread_id, isoOf(toMs(sub.completed_at) - 1_000));
  const redo = findRedispatch({ ...sub, sessionId }, later);
  if (redo) return { ...base, status: "redispatched", redo };
  if (!sessionId) return { ...base, status: "cut" };
  if (active.has(sessionId)) return { ...base, status: "running" };
  const oc = await safe(() => io.ocMessages(sessionId, { limit: 6, maxPages: 1 }), null);
  const out = childOutcome(oc?.messages ?? [], { incidentMs: incident.startMs });
  const lost = { ...base, ...out, model: base.model ?? out.model ?? null };
  if (lost.status === "stale") return lost;
  if (io.subagentResultSeen(db, sub.thread_id, sub.started_at ?? sub.completed_at, sessionId)) return { ...lost, status: "delivered" };
  // A result OpenCode put in the parent's history only counts once the parent
  // has had a turn since; otherwise nothing has woken it to read it.
  const seenSince = isNestedThreadId(sub.thread_id)
    || io.runStartedSince(db, sub.thread_id, isoOf(lost.finishedMs ?? toMs(sub.completed_at)));
  if (lost.status === "finished" && seenSince) {
    const parent = (await safe(() => io.ocSession(sessionId), null))?.parentID;
    const startedMs = toMs(sub.started_at);
    const hist = parent
      ? await safe(() => io.ocMessages(parent, {
        type: "synthetic", stopBeforeMs: Number.isFinite(startedMs) ? startedMs : incident.startMs - 3_600_000, maxPages: 2,
      }), null)
      : null;
    if (resultInHistory(hist?.messages, sessionId)) return { ...lost, status: "delivered" };
  }
  return lost;
}

async function handleThread({ io, db, incident, threadId, subs, active, dryRun }) {
  const thread = await io.getThread(threadId);
  if (!thread) return null;
  const info = { threadId, title: thread.title, origin: thread.origin, archived: thread.archived };
  if (thread.archived || thread.origin === "crw") {
    return { plan: planRestartThread({ thread: info }), ok: true, lostSubs: subs.map((s) => ({ title: s.title, status: "skipped" })), error: null };
  }
  const lost = [];
  for (const sub of subs) lost.push(await lostSubagent({ io, db, sub, active, incident }));
  const plan = planRestartThread({ thread: info, lost });
  const held = io.queuedRuns(db, threadId).filter((r) => r.held).length;
  const res = { plan, ok: true, lostSubs: lost, held, error: null, note: null };
  if (plan.action !== "note") return res;
  const turnCut = io.turnCutAndIdle(db, threadId, isoOf(incident.startMs - 60_000), isoOf(incident.endMs + 60_000));
  res.note = buildRestartNote({ incident, lost, turnCut, ocUrl: io.OC_URL });
  if (dryRun) return res;
  try {
    await io.sendToThread(threadId, res.note, { clientRequestId: incident.id, mode: "auto" });
  } catch (err) {
    res.ok = false;
    res.error = errText(err);
  }
  return res;
}

const counts = (lost) => {
  const c = {};
  for (const l of lost) c[l.status] = (c[l.status] ?? 0) + 1;
  return Object.entries(c).map(([k, v]) => `${k} ${v}`).join(", ");
};

// Sessions the stall watch interrupted itself; their cancels are not a restart.
function stallInterrupted(state, ses, cancelMs) {
  return Object.values(state.stalls ?? {}).some(
    (s) => s.ses === ses && (s.action === "opencode" || s.action === "robob") && Math.abs(cancelMs - s.interruptedAt) < 15 * 60_000,
  );
}

export async function restartScan({ db, state, now, sinceIso, floorMs, dryRun = false, seed = false, verbose = false, log }, io = realIo) {
  state.servers = trackServer(state.servers, io.serverRuntime(), now);
  const subs = io.cancelledSubagentsSince(db, sinceIso)
    .filter((s) => !stallInterrupted(state, sessionFromProviderThread(s.provider_thread_id), toMs(s.completed_at)));
  for (const s of subs) {
    s.parentThreadId = topParent(io, db, s.thread_id) ?? s.thread_id;
    s.rootThreadId = io.threadRoot(db, s.parentThreadId) ?? s.parentThreadId;
  }
  const incidents = findRestartIncidents(subs, { serverStarts: state.servers });
  if (verbose) log(`since ${sinceIso}: ${subs.length} cancelled subagents, ${incidents.length} restart incident(s)`);

  const report = [];
  let robobUp = null;
  for (const incident of incidents) {
    const prev = state.handled[incident.id];
    if (prev?.done) {
      if (verbose) log(`${incident.id}: already handled`);
      continue;
    }
    if (now - incident.endMs < RESTART_SETTLE_MS) {
      log(`${incident.id}: still settling`);
      continue;
    }
    if (incident.endMs < floorMs) {
      if (!dryRun) state.handled[incident.id] = { at: isoOf(now), done: true, summary: "too old, skipped" };
      continue;
    }
    if (seed) {
      state.handled[incident.id] = { at: isoOf(now), done: true, summary: "seeded" };
      log(`${incident.id}: seeded (no action)`);
      continue;
    }
    // install-robob-resume.zsh sends its own "resume, including sub-agents"
    // message once Abdullah confirms the client loaded. Let that go first so
    // the note can list what the threads already relaunched.
    const installerMs = dryRun ? null : io.installerResumePendingMs();
    const installing = installerMs != null && installerMs > incident.startMs - 2 * 3_600_000 && installerMs < incident.endMs + 5 * 60_000;
    if (installing && now - incident.endMs < INSTALLER_WAIT_MS) {
      log(`${incident.id}: waiting for install-robob-resume to send its resume message`);
      continue;
    }
    robobUp ??= await io.robobHealthy();
    if (!robobUp) {
      log(`${incident.id}: Robob is not reachable, retrying next scan`);
      continue;
    }
    const active = await safe(() => io.activeSessions(), new Set());
    const byThread = new Map();
    for (const s of incident.subagents) byThread.set(s.parentThreadId, [...(byThread.get(s.parentThreadId) ?? []), s]);
    const server = incident.serverStart ? `, server pid ${incident.serverStart.pid} ready ${hhmm(incident.serverStart.readyMs)}` : "";
    log(`${incident.id}: Robob restart at ${hhmm(incident.startMs)} (${incident.reason}${server}), ${incident.subagents.length} subagents cancelled in ${byThread.size} threads${dryRun ? " (dry run)" : ""}`);

    const results = [];
    for (const [threadId, list] of byThread) {
      let res;
      try {
        res = await handleThread({ io, db, incident, threadId, subs: list, active, dryRun });
      } catch (err) {
        res = { plan: { threadId, title: threadId, action: "skip", reason: "error" }, ok: false, error: errText(err), lostSubs: [] };
      }
      if (!res) {
        if (verbose) log(`  ${threadId}: not found in Robob`);
        continue;
      }
      results.push(res);
      const p = res.plan;
      log(`  ${p.action.padEnd(7)} ${threadId} | ${truncate(p.title || "", 60)} | ${p.reason} | ${counts(res.lostSubs)}${res.error ? ` | ERROR ${res.error}` : ""}`);
      if (verbose) {
        for (const l of res.lostSubs) {
          if (!l.sessionId) continue;
          const redo = l.redo ? ` -> "${truncate(l.redo.title ?? "", 40)}" ${hhmm(l.redo.started_at)}` : "";
          log(`      ${l.status.padEnd(12)} ${l.sessionId} | ${truncate(l.title ?? "", 50)} | ${l.model ?? "?"} | started ${l.startedAt ? hhmm(l.startedAt) : "?"}${redo}`);
        }
        if (dryRun && res.note) log(`    note:\n${truncate(res.note, 1500)}`);
      }
    }
    const summary = buildRestartSummary({ incident, results });
    // Archiving several threads at once also cancels their subagents; that is
    // not worth a ping.
    const quiet = results.length > 0 && results.every((r) => r.plan.reason === "archived");
    if (dryRun) {
      log(`summary (${quiet ? "not sent, all archived" : summary.severity}):\n${summary.text}`);
    } else if (quiet) {
      state.handled[incident.id] = { at: isoOf(now), done: true, summary: "only archived threads, no action" };
    } else {
      let sent = true;
      try {
        io.telegram({ text: summary.text, severity: summary.severity, key: `stream-recovery:${incident.id}` });
      } catch (err) {
        sent = false;
        log(`telegram failed: ${errText(err)}`);
      }
      const errors = results.filter((r) => r.error).length;
      const attempts = (prev?.attempts || 0) + 1;
      state.handled[incident.id] = {
        at: isoOf(now), attempts, errors, telegram: sent,
        done: (errors === 0 && sent) || attempts >= MAX_ATTEMPTS,
        summary: summary.text.split("\n")[0],
      };
    }
    report.push({
      incident: { id: incident.id, kind: "restart", reason: incident.reason, startMs: incident.startMs, endMs: incident.endMs },
      results: results.map(({ note, ...r }) => r),
    });
  }
  return report;
}
