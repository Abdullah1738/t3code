// Restart watch: Robob's startup recovery cancels every native subagent it
// still had open, with no result and no wake-up for the parent. Spot those
// cancels, tell each parent thread what it lost (once), and send one Telegram
// summary per restart. The caller loads and saves state.
import * as realIo from "./io.mjs";
import {
  buildRestartNote, buildRestartSummary, childOutcome, findRedispatch, findRestartIncidents, hhmm,
  isNestedThreadId, planRestartThread, providerThreadFor, resultInHistory, sessionFromProviderThread, toMs,
  trackServer, truncate, RESTART_BUSY_REASON,
} from "./detect.mjs";

// Long enough for a thread that resumes on its own (or gets the installer's
// resume message) to re-dispatch first, so the note can say so.
export const RESTART_SETTLE_MS = 180_000;
export const INSTALLER_WAIT_MS = 30 * 60_000;
export const STALE_PULSE_MS = 2 * 3_600_000;
// How long a busy thread is held back. Past this, a thread that is still busy
// or has run again since its cut counts as resumed and gets no note.
export const RESTART_RESUME_WINDOW_MS = 30 * 60_000;
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

// The window runs from when Robob was back (ready), not from the shutdown
// cancels, so a long outage does not use it up. It does not wait for the
// installer: its own resume message is what resumes those threads.
const resumeWindowStart = (incident) => Math.max(incident.endMs, toMs(incident.serverStart?.readyMs) || 0);

const threadBusy = (thread, active) => Boolean(thread.activeRunId || thread.pendingRequest
  || ['preparing', 'starting', 'running', 'waiting'].includes(thread.status)
  || active.has(thread.nativeSessionId));

// Robob's mission recovery owns notes for mission members: it sends one
// notice per thread, master first and paced. Report every restart to it and
// leave its members' notes alone. An older Robob without the route owns none.
const missionCause = (incident) =>
  incident.serverStart && (incident.serverStart.service ?? 'robob') === 'robob' ? 'server-restart' : 'opencode-restart';

async function missionReport({ io, incident, byThread, prev, dryRun }) {
  if (!dryRun && prev?.missionReport) return prev.missionReport;
  const threads = [...byThread].map(([threadId, list]) => ({
    threadId,
    runIds: incident.runs.filter((r) => r.thread_id === threadId).map((r) => r.run_id),
    childIds: list.map((s) => s.subagent_id),
  }));
  try {
    const res = await io.missionRecoveryReport({
      reportId: incident.id, cause: missionCause(incident), startAt: isoOf(incident.startMs), endAt: isoOf(incident.endMs),
      threads, ...(dryRun ? { dryRun: true } : {}),
    });
    return { incidentId: res.incidentId ?? null, members: (res.members ?? []).map((m) => m.threadId), missions: res.missions ?? [] };
  } catch (err) {
    // Refused for lack of stream-recovery's own credential: mission recovery
    // still resumes its members from its own boot check and scans, so only
    // ask which threads those are and leave them alone.
    if (err?.status === 403) return missionMembersOnly({ io, threads, prev });
    if ([401, 404].includes(err?.status)) return { incidentId: null, members: [], missions: [], unavailable: true };
    const failures = (prev?.missionFailures ?? 0) + 1;
    // Never hold a restart back for good: past the retries this scan notes everyone.
    if (failures >= MAX_ATTEMPTS) return { incidentId: null, members: [], missions: [], error: errText(err) };
    return { retry: true, failures, error: errText(err) };
  }
}

async function missionMembersOnly({ io, threads, prev }) {
  try {
    const members = await io.missionRecoveryMembers(threads.map((t) => t.threadId));
    return { incidentId: null, members: members.map((m) => m.threadId), missions: [], unrecorded: true };
  } catch (err) {
    if ([401, 403, 404].includes(err?.status)) return { incidentId: null, members: [], missions: [], unavailable: true };
    const failures = (prev?.missionFailures ?? 0) + 1;
    if (failures >= MAX_ATTEMPTS) return { incidentId: null, members: [], missions: [], error: errText(err) };
    return { retry: true, failures, error: errText(err) };
  }
}

async function handleThread({ io, db, incident, threadId, subs, active, dryRun, now, windowStart, progress, save, missionMember = false }) {
  const thread = await io.getThread(threadId);
  if (!thread) return null;
  const info = { threadId, title: thread.title, origin: thread.origin, archived: thread.archived };
  if (thread.archived) {
    return { plan: planRestartThread({ thread: info }), ok: true, lostSubs: subs.map((s) => ({ title: s.title, status: "skipped" })), error: null };
  }
  if (io.stoppedSince(db, threadId, isoOf(incident.startMs))) {
    return { plan: { ...planRestartThread({ thread: info }), action: 'skip', reason: 'stopped after the restart' }, ok: true, lostSubs: [], error: null };
  }
  const noteRun = io.restartNoteRun(db, threadId, incident.id);
  const alreadySent = progress.noteSent || noteRun != null;
  const ownRecovery = noteRun != null && thread.activeRunId === noteRun;
  const cuts = incident.runs.filter((r) => r.thread_id === threadId);
  const turnCut = cuts.length > 0;
  const queued = io.queuedRuns(db, threadId).filter((r) => r.held)
    .map((r) => ({ ...r, text: io.messageText(db, r.user_message_id) }));
  const lost = [];
  for (const sub of subs) lost.push(await lostSubagent({ io, db, sub, active, incident }));
  // Past the hold-back window a thread that is busy, or ran again after its
  // cut, has moved on; a late "carry on" note would only confuse it.
  const windowOver = now - windowStart >= RESTART_RESUME_WINDOW_MS;
  const cutMs = Math.min(...[...cuts, ...subs].map((r) => toMs(r.completed_at)).filter(Number.isFinite), incident.endMs);
  const ranAgain = windowOver && !alreadySent && io.runStartedSince(db, threadId, isoOf(cutMs));
  let plan = planRestartThread({ thread: info, lost, turnCut, held: queued, ranAgain, windowOver, noteSent: alreadySent,
    busy: !ownRecovery && threadBusy(thread, active) });
  // Mission recovery waits for the thread to go idle itself, so a busy member
  // needs no hold-back here; its held queue is still released.
  if (missionMember && ((plan.action === "note" && !alreadySent) || plan.reason === RESTART_BUSY_REASON)) {
    plan = { ...plan, action: "mission", reason: "mission recovery notes it" };
  }
  const staleHeld = [...(progress.staleHeld ?? [])];
  for (const r of queued) {
    // Keep real owner messages, regardless of age. These pulses only ask the
    // lane to re-read its durable inbox, so replaying hours of them adds noise.
    const automated = r.user_message_id?.startsWith(`ardud-control:send:${threadId}:coord%3A`) && /^\[coord[\] ]/.test(r.text ?? '');
    if (toMs(r.requested_at) < now - STALE_PULSE_MS && automated
      && !staleHeld.some((s) => s.run_id === r.run_id)) staleHeld.push(r);
  }
  const held = queued.filter((r) => !staleHeld.some((s) => s.run_id === r.run_id));
  const res = { plan, ok: true, lostSubs: lost, held: queued.length, staleHeld, queueOk: progress.queueOk ?? null, turnCut, error: null, note: null };
  if (plan.reason === RESTART_BUSY_REASON) res.deferred = true;
  const sending = plan.action === "note" && !alreadySent;
  // Resumed and already-noted threads still get their held queue released:
  // queue.resume never interrupts a running turn, the queue just starts after it.
  const releasing = ["note", "resumed", "mission"].includes(plan.action) && queued.length > 0 && !progress.queueOk;
  if (sending) res.note = buildRestartNote({ incident, lost, turnCut, held, staleHeld, ocUrl: io.OC_URL });
  if (!sending && !releasing) return res;
  if (dryRun) return res;
  try {
    // Child history reads may have taken seconds. Recheck immediately before
    // mutations, and don't steer a new turn that arrived while gathering.
    const fresh = await io.getThread(threadId);
    if (!fresh || fresh.archived) {
      res.plan = { ...plan, action: 'skip', resumeQueue: false, reason: 'thread changed during recovery' };
      res.deferred = true;
      return res;
    }
    const freshActive = sending ? await io.activeSessions() : null;
    if (sending && ((!(noteRun && fresh.activeRunId === noteRun) && threadBusy(fresh, freshActive))
      || fresh.latestRunId !== thread.latestRunId)) {
      res.plan = { ...plan, action: 'skip', resumeQueue: false, reason: 'thread changed during recovery' };
      res.deferred = true;
      return res;
    }
    if (io.stoppedSince(db, threadId, isoOf(incident.startMs))) {
      res.plan = { ...plan, action: 'skip', resumeQueue: false, reason: 'stopped after the restart' };
      return res;
    }
    progress.staleHeld = staleHeld;
    save();
    for (const r of staleHeld.filter((s) => queued.some((q) => q.run_id === s.run_id))) {
      await io.dispatchCommand({ type: 'queued-run.cancel', commandId: `${incident.id}:cancel:${r.run_id}`, threadId, runId: r.run_id });
    }
    if (sending) {
      // queue is also safe if a turn starts between the read and the send:
      // unlike auto it cannot steer or interrupt that turn.
      await io.sendToThread(threadId, res.note, { clientRequestId: incident.id, mode: 'queue' });
      progress.noteSent = true;
      save();
    }
    if (queued.length && !progress.queueOk) {
      await io.dispatchCommand({ type: 'queue.resume', commandId: `${incident.id}:resume:${threadId}`, threadId });
      progress.queueOk = res.queueOk = true;
      save();
    }
  } catch (err) {
    res.ok = false;
    res.error = errText(err);
  }
  return res;
}

// What the final summary needs from a settled thread, kept in state across scans.
const summaryResult = (r) => ({
  plan: { threadId: r.plan.threadId, title: r.plan.title ?? null, action: r.plan.action, reason: r.plan.reason },
  ok: r.ok, error: r.error ?? null, turnCut: Boolean(r.turnCut), held: r.held ?? 0, queueOk: r.queueOk ?? null,
  staleHeld: (r.staleHeld ?? []).map((s) => ({ run_id: s.run_id })),
  lostSubs: (r.lostSubs ?? []).map((l) => ({ status: l.status, title: l.title ?? null, sessionId: l.sessionId ?? null })),
});

// A finished incident keeps only what idempotency needs (per-thread done and
// noteSent flags), not the prompts and queued texts it carried while open.
const slim = ({ incident, threads, ...rest }) => ({
  ...rest,
  threads: Object.fromEntries(Object.entries(threads ?? {}).map(([id, t]) => [id, { done: t.done, noteSent: t.noteSent, queueOk: t.queueOk }])),
});

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
  state.servers = trackServer(state.servers, io.openCodeRuntime(), now);
  const subs = io.cancelledSubagentsSince(db, sinceIso)
    .filter((s) => !stallInterrupted(state, sessionFromProviderThread(s.provider_thread_id), toMs(s.completed_at)));
  for (const s of subs) {
    s.parentThreadId = topParent(io, db, s.thread_id) ?? s.thread_id;
    s.rootThreadId = io.threadRoot(db, s.parentThreadId) ?? s.parentThreadId;
  }
  const runs = io.restartRunsSince(db, sinceIso);
  const incidents = findRestartIncidents(subs, { runs, serverStarts: state.servers });
  // Deferred fresh work can outlive the discovery lookback. Keep its original
  // rows until every affected thread is handled, without widening DB scans.
  for (const [id, entry] of Object.entries(state.handled)) {
    if (!id.startsWith('rs-') || entry.done || !entry.incident) continue;
    const current = incidents.find((i) => i.id === id);
    if (!current) incidents.push(entry.incident);
    else {
      current.runs = [...entry.incident.runs, ...current.runs.filter((r) => !entry.incident.runs.some((old) => old.run_id === r.run_id))];
      current.subagents = [...entry.incident.subagents, ...current.subagents.filter((s) => !entry.incident.subagents.some((old) => old.subagent_id === s.subagent_id))];
      current.startMs = Math.min(current.startMs, entry.incident.startMs);
      current.endMs = Math.max(current.endMs, entry.incident.endMs);
    }
  }
  if (verbose) log(`since ${sinceIso}: ${subs.length} cancelled subagents, ${runs.length} cut runs, ${incidents.length} restart incident(s)`);

  const report = [];
  // The stream-loss scan must not also recover these same failed turns,
  // including while a restart is settling or was already handled.
  report.runIds = new Set(incidents.flatMap((i) => i.runs.map((r) => r.run_id)));
  let robobUp = null;
  for (const incident of incidents) {
    if (incident.serverStart) incident.serverStart.incidentId = incident.id;
    const prev = state.handled[incident.id];
    if (prev?.done) {
      if (verbose) log(`${incident.id}: already handled`);
      continue;
    }
    if (now - incident.endMs < RESTART_SETTLE_MS) {
      log(`${incident.id}: still settling`);
      continue;
    }
    if (incident.endMs < floorMs && !prev?.incident) {
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
    // Fail closed: if OpenCode cannot tell us what's active, retry later.
    const active = await io.activeSessions();
    const byThread = new Map();
    for (const r of incident.runs) byThread.set(r.thread_id, []);
    for (const s of incident.subagents) byThread.set(s.parentThreadId, [...(byThread.get(s.parentThreadId) ?? []), s]);
    const server = incident.serverStart ? `, server pid ${incident.serverStart.pid} ready ${hhmm(incident.serverStart.readyMs)}` : "";
    log(`${incident.id}: restart at ${hhmm(incident.startMs)} (${incident.reason}${server}), ${incident.runs.length} own turns, ${incident.subagents.length} subagents cancelled in ${byThread.size} threads${dryRun ? " (dry run)" : ""}`);

    const mission = await missionReport({ io, incident, byThread, prev, dryRun });
    if (mission.retry) {
      log(`${incident.id}: mission recovery unreachable (${mission.error}), retrying next scan`);
      if (!dryRun) {
        state.handled[incident.id] = { ...prev, incident, at: isoOf(now), done: false, threads: { ...prev?.threads }, missionFailures: mission.failures };
        io.saveState(state, now);
      }
      continue;
    }
    const members = new Set(mission.members);
    if (members.size) log(`${incident.id}: ${members.size} mission member thread(s) left to mission recovery (${mission.incidentId ?? (mission.unrecorded ? "report refused: no stream-recovery credential; its own scans" : "dry run")})`);

    const results = [];
    const all = [];
    const entry = { ...prev, incident, at: isoOf(now), threads: { ...prev?.threads }, ...(dryRun ? {} : { missionReport: mission }) };
    const windowStart = resumeWindowStart(incident);
    const save = () => {
      if (!dryRun) {
        state.handled[incident.id] = entry;
        io.saveState(state, now);
      }
    };
    for (const [threadId, list] of byThread) {
      if (entry.threads[threadId]?.done) {
        // Threads settled by an older version carry no stored result.
        all.push(entry.threads[threadId].result
          ?? { plan: { threadId, title: threadId, action: "skip", reason: "handled earlier" }, ok: true, lostSubs: [], error: null });
        continue;
      }
      let res;
      const progress = entry.threads[threadId] ??= {};
      try {
        res = await handleThread({ io, db, incident, threadId, subs: list, active, dryRun, now, windowStart, progress, save, missionMember: members.has(threadId) });
        if (res?.ok && !res.deferred && !dryRun) progress.done = true;
      } catch (err) {
        res = { plan: { threadId, title: threadId, action: "skip", reason: "error" }, ok: false, error: errText(err), lostSubs: [] };
      }
      if (!res) {
        if (verbose) log(`  ${threadId}: not found in Robob`);
        res = { plan: { threadId, title: threadId, action: "skip", reason: "not found in Robob" }, ok: true, lostSubs: [], error: null };
        if (!dryRun) {
          progress.missing = (progress.missing ?? 0) + 1;
          if (progress.missing >= MAX_ATTEMPTS) progress.done = true;
        }
      }
      if (res.error && !dryRun) {
        progress.failures = (progress.failures ?? 0) + 1;
        if (progress.failures >= MAX_ATTEMPTS) progress.done = true;
      }
      if (!dryRun) {
        if (progress.done) progress.result = summaryResult(res);
        save();
      }
      results.push(res);
      all.push(res);
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
    const summary = buildRestartSummary({ incident, results: all, missions: mission.missions });
    // Archiving several threads at once also cancels their subagents; that is
    // not worth a ping.
    const quiet = all.length > 0 && all.every((r) => r.plan.reason === "archived");
    // One summary per restart, sent once every thread is settled (held-back
    // threads settle within RESTART_RESUME_WINDOW_MS), so it names them all.
    const pending = dryRun ? [] : [...byThread.keys()].filter((id) => !entry.threads[id]?.done);
    if (dryRun) {
      log(`summary (${quiet ? "not sent, all archived" : summary.severity}):\n${summary.text}`);
    } else if (quiet && !pending.length) {
      state.handled[incident.id] = { at: isoOf(now), done: true, summary: "only archived threads, no action" };
    } else if (pending.length) {
      log(`${incident.id}: ${pending.length} thread(s) not settled yet, summary waits`);
      state.handled[incident.id] = { ...entry, at: isoOf(now), done: false };
    } else {
      let sent = true;
      try {
        io.telegram({ text: summary.text, severity: summary.severity, key: `stream-recovery:${incident.id}` });
      } catch (err) {
        sent = false;
        log(`telegram failed: ${errText(err)}`);
      }
      const telegramFailures = (prev?.telegramFailures ?? 0) + (sent ? 0 : 1);
      const done = sent || telegramFailures >= MAX_ATTEMPTS;
      state.handled[incident.id] = {
        ...(done ? slim(entry) : entry), at: isoOf(now), errors: all.filter((r) => r.error).length, telegram: sent, telegramFailures,
        done, summary: summary.text.split("\n")[0],
      };
    }
    report.push({
      incident: { id: incident.id, kind: "restart", reason: incident.reason, startMs: incident.startMs, endMs: incident.endMs },
      results: results.map(({ note, ...r }) => r),
    });
  }
  return report;
}
