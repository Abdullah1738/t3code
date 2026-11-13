// Restart watch: spot interrupted native subagents, delegated tasks and turns,
// tell each parent thread what it lost (once), and send one summary per restart.
// The caller loads and saves state.
import { assertRecoveryActive, guardRecoveryIo, isRecoveryPaused, recoveryElapsed } from './pause.mjs';
import * as realIo from "./io.mjs";
import { createHash } from 'node:crypto';
import { cutoverOwns, openCodeSession, recoveryOwned } from './harness.mjs';
import {
  buildRestartNote, buildRestartSummary, childOutcome, findRedispatch, findRestartIncidents, hhmm,
  isNestedThreadId, planRestartThread, providerThreadFor, resultInHistory, sessionFromProviderThread, toMs,
  trackServer, truncate, RESTART_BUSY_REASON,
} from "./detect.mjs";

// Owner, 1 Nov: resumes after a restart must be fast and automatic. Wait only
// until the shutdown/startup cancels stop landing; Robob's own continuation
// starts within seconds and those threads are skipped as busy. The installer is
// no longer waited for: this watch is the resume path.
export const RESTART_SETTLE_MS = 20_000;
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
  const seen = new Set();
  while (t && isNestedThreadId(t) && !seen.has(t)) {
    seen.add(t);
    t = io.subagentParent(db, providerThreadFor(t));
  }
  return t && !isNestedThreadId(t) ? t : null;
}

async function lostSubagent({ io, db, sub, active, incident }) {
  if (sub.kind === 'delegated') {
    const base = {
      kind: 'delegated', subagentId: sub.subagent_id, title: sub.title ?? null, model: sub.model ?? null,
      prompt: sub.prompt ?? null, startedAt: sub.started_at ?? null, cancelledAt: sub.completed_at,
      childThreadId: sub.childThreadId, taskRef: sub.taskRef,
    };
    const outcome = io.childRunOutcomeSince(db, sub.childThreadId, sub.taskRef, sub.completed_at);
    if (!outcome) return { ...base, status: 'cut' };
    if (outcome.status === 'running') return { ...base, status: 'running' };
    const messages = await safe(() => io.runMessages(db, outcome.run_id), []);
    const text = messages.findLast((m) => m.role === 'assistant' && m.text)?.text;
    return { ...base, status: 'finished', finishedMs: toMs(outcome.completed_at), excerpt: text ? truncate(text, 600) : null };
  }
  const sessionId = sessionFromProviderThread(sub.provider_thread_id);
  const base = {
    subagentId: sub.subagent_id, sessionId, title: sub.title ?? null, model: sub.model ?? null,
    prompt: sub.prompt ?? null, startedAt: sub.started_at ?? null, cancelledAt: sub.completed_at,
    nestedUnder: isNestedThreadId(sub.thread_id) ? sessionFromProviderThread(sub.thread_id) : null,
  };
  const later = io.subagentsStartedSince(db, sub.thread_id, isoOf(toMs(sub.completed_at) - 1_000));
  const redo = findRedispatch({ ...sub, sessionId }, later);
  if (redo) return { ...base, status: "redispatched", redo };
  if (!sessionId) return { ...base, childThreadId: sub.child_thread_id ?? null, status: 'unknown' };
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
  || active.has(openCodeSession(thread)));

const cutRunIds = (incident, threadId, subs = []) => [
  ...incident.runs.filter((r) => r.thread_id === threadId).map((r) => r.run_id),
  ...subs.map((s) => s.run_id),
].filter(Boolean);

const ownedResult = (threadId, thread = {}) => ({
  plan: { threadId, title: thread.title ?? threadId, action: 'skip', resumeQueue: false, reason: 'harness cutover owns continuation' },
  ok: true, lostSubs: [], error: null,
});

const incrementalId = (incidentId, taskId) =>
  `${incidentId}:delegated:${createHash('sha256').update(taskId).digest('hex')}`;

// One stable receipt per task avoids duplicates if a send succeeds but state
// saving fails, or more task rows arrive before the retry.
async function handleLateDelegated({ io, db, incident, threadId, sub, dryRun, progress, save }) {
  if (await recoveryOwned(io, threadId, cutRunIds(incident, threadId, [sub]))) return;
  const active = new Set();
  const requestId = incrementalId(incident.id, sub.subagent_id);
  const delivered = [...(progress.deliveredDelegated ?? [])];
  const previous = progress.result
    ? { ...progress.result, lostSubs: [...(progress.result.lostSubs ?? [])] }
    : { plan: { threadId, title: threadId, action: 'skip', reason: 'handled earlier' }, ok: true, lostSubs: [] };
  const mark = (lost) => {
    if (!delivered.includes(sub.subagent_id)) delivered.push(sub.subagent_id);
    if (lost && !(previous.lostSubs ?? []).some((s) => s.subagentId === sub.subagent_id)) {
      previous.lostSubs = [...(previous.lostSubs ?? []), { ...lost, prompt: undefined }];
    }
    if (!dryRun) { progress.deliveredDelegated = delivered; progress.result = previous; save(); }
  };
  if (io.restartNoteRun(db, threadId, requestId) != null) {
    const lost = io.delegatedStoppedSince(db, sub) ? null : await lostSubagent({ io, db, sub, active, incident });
    mark(lost);
    return;
  }
  const thread = await io.getThread(threadId);
  if (thread?.origin === 'imessage' && !thread.archived && !io.stoppedSince(db, threadId, isoOf(incident.startMs))
    && !io.delegatedStoppedSince(db, sub)) {
    mark(await lostSubagent({ io, db, sub, active, incident }));
    return;
  }
  if (!thread || thread.archived || thread.origin === 'imessage'
    || io.stoppedSince(db, threadId, isoOf(incident.startMs)) || io.delegatedStoppedSince(db, sub)) {
    mark(null);
    return;
  }
  const lost = await lostSubagent({ io, db, sub, active, incident });
  const note = buildRestartNote({ incident, lost: [lost], ocUrl: io.OC_URL, incremental: true });
  if (dryRun) return;
  io.assertReplicaFresh(db);
  const fresh = await io.getThread(threadId);
  if (!fresh || fresh.archived || fresh.origin === 'imessage'
    || io.stoppedSince(db, threadId, isoOf(incident.startMs)) || io.delegatedStoppedSince(db, sub)) {
    mark(null);
    return;
  }
  io.assertThreadInReplica(db, fresh);
  if (sub.childThreadId) {
    const child = await io.getThread(sub.childThreadId);
    if (child) io.assertThreadInReplica(db, child);
  }
  if (await recoveryOwned(io, threadId, cutRunIds(incident, threadId, [sub]))) return;
  io.assertReplicaFresh(db);
  await io.sendToThread(threadId, note, { clientRequestId: requestId, mode: 'queue' });
  mark(lost);
}

async function handleThread({ io, db, incident, threadId, subs, getActive, dryRun, now, windowStart, progress, save }) {
  const sourceRuns = cutRunIds(incident, threadId, subs);
  if (await recoveryOwned(io, threadId, sourceRuns)) return ownedResult(threadId);
  const thread = await io.getThread(threadId);
  if (!thread) return null;
  const info = { threadId, title: thread.title, origin: thread.origin, archived: thread.archived };
  if (thread.archived) {
    return { plan: planRestartThread({ thread: info }), ok: true, lostSubs: subs.map((s) => ({ title: s.title, status: "skipped" })), error: null };
  }
  if (io.stoppedSince(db, threadId, isoOf(incident.startMs))) {
    return { plan: { ...planRestartThread({ thread: info }), action: 'skip', reason: 'stopped after the restart' }, ok: true, lostSubs: [], error: null };
  }
  const active = openCodeSession(thread) || subs.some((s) => sessionFromProviderThread(s.provider_thread_id))
    ? await getActive() : new Set();
  const noteRun = io.restartNoteRun(db, threadId, incident.id);
  const alreadySent = progress.noteSent || noteRun != null;
  const ownRecovery = noteRun != null && thread.activeRunId === noteRun;
  const cuts = incident.runs.filter((r) => r.thread_id === threadId);
  const turnCut = cuts.length > 0;
  const queued = io.queuedRuns(db, threadId).filter((r) => r.held)
    .map((r) => ({ ...r, text: io.messageText(db, r.user_message_id) }));
  const candidates = subs.filter((sub) => sub.kind !== 'delegated' || !io.delegatedStoppedSince(db, sub));
  const lost = [];
  for (const sub of candidates) lost.push(await lostSubagent({ io, db, sub, active, incident }));
  // Past the hold-back window a thread that is busy, or ran again after its
  // cut, has moved on; a late "carry on" note would only confuse it.
  const windowOver = recoveryElapsed(io, windowStart, now) >= RESTART_RESUME_WINDOW_MS;
  const cutMs = Math.min(...[...cuts, ...subs].map((r) => toMs(r.completed_at)).filter(Number.isFinite), incident.endMs);
  const ranAgain = windowOver && !alreadySent && io.runStartedSince(db, threadId, isoOf(cutMs));
  const plan = planRestartThread({ thread: info, lost, turnCut, held: queued, ranAgain, windowOver, noteSent: alreadySent,
    busy: !ownRecovery && threadBusy(thread, active) });
  const staleHeld = [...(progress.staleHeld ?? [])];
  for (const r of queued) {
    // Keep real owner messages, regardless of age. These pulses only ask the
    // lane to re-read its durable inbox, so replaying hours of them adds noise.
    const automated = r.user_message_id?.startsWith(`ardud-control:send:${threadId}:coord%3A`) && /^\[coord[\] ]/.test(r.text ?? '');
    if (recoveryElapsed(io, toMs(r.requested_at), now) > STALE_PULSE_MS && automated
      && !staleHeld.some((s) => s.run_id === r.run_id)) staleHeld.push(r);
  }
  const held = queued.filter((r) => !staleHeld.some((s) => s.run_id === r.run_id));
  io.assertReplicaFresh(db);
  const res = { plan, ok: true, lostSubs: lost, held: queued.length, staleHeld, queueOk: progress.queueOk ?? null, turnCut, error: null, note: null };
  if (plan.reason === RESTART_BUSY_REASON) res.deferred = true;
  const sending = plan.action === "note" && !alreadySent;
  // Resumed and already-noted threads still get their held queue released:
  // queue.resume never interrupts a running turn, the queue just starts after it.
  const releasing = ["note", "resumed"].includes(plan.action) && queued.length > 0 && !progress.queueOk;
  if (sending) res.note = buildRestartNote({ incident, lost, turnCut, held, staleHeld, ocUrl: io.OC_URL });
  if (!sending && !releasing) return res;
  if (dryRun) return res;
  try {
    io.assertReplicaFresh(db);
    // Child history reads may have taken seconds. Recheck immediately before
    // mutations, and don't steer a new turn that arrived while gathering.
    const fresh = await io.getThread(threadId);
    if (!fresh || fresh.archived) {
      res.plan = { ...plan, action: 'skip', resumeQueue: false, reason: 'thread changed during recovery' };
      res.deferred = true;
      return res;
    }
    io.assertThreadInReplica(db, fresh);
    for (const sub of candidates.filter((s) => s.kind === 'delegated' && s.childThreadId)) {
      const child = await io.getThread(sub.childThreadId);
      if (child) io.assertThreadInReplica(db, child);
    }
    const freshActive = sending && openCodeSession(fresh) ? await io.activeSessions() : new Set();
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
    if (sending && candidates.some((s) => s.kind === 'delegated' && io.delegatedStoppedSince(db, s))) {
      res.plan = { ...plan, action: 'skip', resumeQueue: false, reason: 'delegated task stopped during recovery' };
      res.deferred = true;
      return res;
    }
    if (await recoveryOwned(io, threadId, sourceRuns)) return ownedResult(threadId, fresh);
    progress.staleHeld = staleHeld;
    if (sending) progress.initialDelegated = lost.filter((l) => l.kind === 'delegated').map((l) => l.subagentId);
    save();
    for (const r of staleHeld.filter((s) => queued.some((q) => q.run_id === s.run_id))) {
      io.assertReplicaFresh(db);
      await io.dispatchCommand({ type: 'queued-run.cancel', commandId: `${incident.id}:cancel:${r.run_id}`, threadId, runId: r.run_id });
    }
    if (sending) {
      // queue is also safe if a turn starts between the read and the send:
      // unlike auto it cannot steer or interrupt that turn.
      io.assertReplicaFresh(db);
      await io.sendToThread(threadId, res.note, { clientRequestId: incident.id, mode: 'queue' });
      progress.noteSent = true;
      progress.deliveredDelegated = [...new Set([...(progress.deliveredDelegated ?? []),
        ...lost.filter((l) => l.kind === 'delegated').map((l) => l.subagentId)])];
      save();
    }
    if (queued.length && !progress.queueOk) {
      io.assertReplicaFresh(db);
      await io.dispatchCommand({ type: 'queue.resume', commandId: `${incident.id}:resume:${threadId}`, threadId });
      progress.queueOk = res.queueOk = true;
      save();
    }
  } catch (err) {
    if (err.code === 'REPLICA_UNAVAILABLE' || isRecoveryPaused(err)) throw err;
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
  lostSubs: (r.lostSubs ?? []).map((l) => ({ status: l.status, title: l.title ?? null, sessionId: l.sessionId ?? null, subagentId: l.subagentId,
    kind: l.kind, childThreadId: l.childThreadId ?? null, taskRef: l.taskRef ?? null })),
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
function stallInterrupted(state, ses, cancelMs, threadId = null) {
  return Object.values(state.stalls ?? {}).some(
    (s) => ((ses && s.ses === ses) || (threadId && s.threadId === threadId))
      && (s.action === "opencode" || s.action === "robob") && Math.abs(cancelMs - s.interruptedAt) < 15 * 60_000,
  );
}

export async function restartScan({ db, state, now, sinceIso, floorMs, dryRun = false, seed = false, verbose = false, log }, io = realIo) {
  assertRecoveryActive(io);
  io = guardRecoveryIo(io);
  io.assertReplicaFresh(db);
  state.servers = trackServer(state.servers, io.serverRuntime(), now);
  state.servers = trackServer(state.servers, io.openCodeRuntime(), now);
  const nativeSubs = io.cancelledSubagentsSince(db, sinceIso)
    .filter((s) => !stallInterrupted(state, sessionFromProviderThread(s.provider_thread_id), toMs(s.completed_at)));
  const delegatedSubs = io.cancelledDelegatedTasksSince(db, sinceIso)
    .filter((s) => !stallInterrupted(state, io.childNativeSession(db, s.childThreadId), toMs(s.completed_at), s.childThreadId));
  const subs = [...nativeSubs, ...delegatedSubs];
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
  // A missing or malformed status is not permission to send a second resume.
  const cutover = !seed && incidents.length ? await io.harnessCutoverStatus() : null;
  let robobUp = null;
  for (const incident of incidents) {
    if (incident.serverStart) incident.serverStart.incidentId = incident.id;
    assertRecoveryActive(io);
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
    robobUp ??= await io.robobHealthy();
    if (!robobUp) {
      log(`${incident.id}: Robob is not reachable, retrying next scan`);
      continue;
    }
    let active;
    const getActive = async () => active ??= await io.activeSessions();
    const byThread = new Map();
    for (const r of incident.runs) byThread.set(r.thread_id, []);
    for (const s of incident.subagents) byThread.set(s.parentThreadId, [...(byThread.get(s.parentThreadId) ?? []), s]);
    // A later failure can share the restart window with an already briefed
    // cut. Suppress the claimed rows, not that thread's unrelated newer run.
    const recoveryIncident = { ...incident,
      runs: incident.runs.filter((r) => !cutoverOwns(cutover, r.thread_id, [r.run_id])),
      subagents: incident.subagents.filter((s) => !cutoverOwns(cutover, s.parentThreadId, [s.run_id])),
    };
    const server = incident.serverStart ? `, server pid ${incident.serverStart.pid} ready ${hhmm(incident.serverStart.readyMs)}` : "";
    log(`${incident.id}: restart at ${hhmm(incident.startMs)} (${incident.reason}${server}), ${incident.runs.length} own turns, ${incident.subagents.length} subagents cancelled in ${byThread.size} threads${dryRun ? " (dry run)" : ""}`);

    const results = [];
    const all = [];
    const entry = { ...prev, incident, at: isoOf(now), threads: { ...prev?.threads } };
    const windowStart = resumeWindowStart(incident);
    const save = () => {
      if (!dryRun) {
        state.handled[incident.id] = entry;
        io.saveState(state, now);
      }
    };
    for (const threadId of byThread.keys()) {
      assertRecoveryActive(io);
      const list = recoveryIncident.subagents.filter((s) => s.parentThreadId === threadId);
      if (!list.length && !recoveryIncident.runs.some((r) => r.thread_id === threadId)) {
        const res = ownedResult(threadId);
        if (!dryRun) {
          entry.threads[threadId] = { done: true, result: summaryResult(res) };
          save();
        }
        results.push(res); all.push(res);
        continue;
      }
      if (entry.threads[threadId]?.done || entry.threads[threadId]?.lateOnly) {
        const progress = entry.threads[threadId];
        if (progress.lateExhausted) {
          all.push(progress.result);
          continue;
        }
        const seen = new Set(progress.deliveredDelegated ?? []);
        // State written by the previous version did not record delivered IDs.
        if (!progress.deliveredDelegated) {
          for (const s of prev?.incident?.subagents ?? []) {
            if (s.kind === 'delegated' && s.parentThreadId === threadId) seen.add(s.subagent_id);
          }
          if (!dryRun) progress.deliveredDelegated = [...seen];
        }
        const pendingTasks = list.filter((s) => s.kind === 'delegated' && !seen.has(s.subagent_id));
        let failed = null;
        let failedTask = null;
        for (const sub of pendingTasks) {
          try {
            await handleLateDelegated({ io, db, incident: recoveryIncident, threadId, sub, dryRun, progress, save });
            assertRecoveryActive(io);
            if (!dryRun) progress.lateFailures = 0;
          } catch (err) {
            if (err.code === 'REPLICA_UNAVAILABLE' || isRecoveryPaused(err)) throw err;
            failed = errText(err);
            failedTask = sub;
            break;
          }
        }
        assertRecoveryActive(io);
        if (failed) {
          if (!dryRun) {
            progress.done = false;
            progress.lateOnly = true;
            progress.lateFailures = (progress.lateFailures ?? 0) + 1;
            if (progress.lateFailures >= MAX_ATTEMPTS) {
              progress.done = true;
              progress.lateExhausted = true;
              progress.result = { plan: { threadId, title: progress.result?.plan?.title ?? threadId, action: 'skip', reason: 'error' },
                ok: false, error: `delegated task ${failedTask.taskRef} not noted: ${failed}`, lostSubs: [] };
            }
            save();
          }
          const res = progress.lateExhausted ? progress.result
            : { plan: { threadId, title: progress.result?.plan?.title ?? threadId, action: 'skip', reason: 'error' }, ok: false, error: failed, lostSubs: [] };
          results.push(res); all.push(res);
          continue;
        }
        if (!dryRun) {
          progress.done = true;
          progress.lateOnly = false;
          save();
        }
        // Threads settled by an older version carry no stored result.
        all.push(progress.result
          ?? { plan: { threadId, title: threadId, action: "skip", reason: "handled earlier" }, ok: true, lostSubs: [], error: null });
        continue;
      }
      let res;
      const progress = entry.threads[threadId] ??= {};
      try {
        res = await handleThread({ io, db, incident: recoveryIncident, threadId, subs: list, getActive, dryRun, now, windowStart, progress, save });
        assertRecoveryActive(io);
        if (res?.ok && !res.deferred && !dryRun) {
          progress.done = true;
          if (!progress.initialDelegated) {
            progress.deliveredDelegated ??= list.filter((s) => s.kind === 'delegated').map((s) => s.subagent_id);
          }
        }
      } catch (err) {
        if (err.code === 'REPLICA_UNAVAILABLE' || isRecoveryPaused(err)) throw err;
        assertRecoveryActive(io);
        res = { plan: { threadId, title: threadId, action: "skip", reason: "error" }, ok: false, error: errText(err), lostSubs: [] };
      }
      // A sent initial note can be recovered from its receipt even when the
      // state write was lost. Only the IDs captured before that send belong to
      // it; anything discovered since must take the incremental path.
      if (!dryRun && res?.ok && !res.deferred && progress.done && progress.initialDelegated) {
        progress.deliveredDelegated ??= [...progress.initialDelegated];
        const seen = new Set(progress.deliveredDelegated);
        const late = list.some((s) => s.kind === 'delegated' && !seen.has(s.subagent_id));
        if (late) { progress.done = false; progress.lateOnly = true; }
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
    assertRecoveryActive(io);
    io.assertReplicaFresh(db);
    const summary = buildRestartSummary({ incident, results: all });
    // Archiving several threads at once also cancels their subagents; that is
    // not worth a ping.
    const quiet = all.length > 0 && all.every((r) => ['archived', 'harness cutover owns continuation'].includes(r.plan.reason));
    // One summary per restart, sent once every thread is settled (held-back
    // threads settle within RESTART_RESUME_WINDOW_MS), so it names them all.
    const pending = dryRun ? [] : [...byThread.keys()].filter((id) => !entry.threads[id]?.done);
    // Acting 20s after the last cancel can come before the restart window
    // closes. Keep the incident open until then so a late cut joins it.
    const windowOpen = !dryRun && Number.isFinite(incident.windowTo) && now < incident.windowTo + RESTART_SETTLE_MS;
    if (windowOpen && !pending.length) pending.push("(restart window still open)");
    if (dryRun) {
      log(`summary (${quiet ? "not sent, no recovery action" : summary.severity}):\n${summary.text}`);
    } else if (quiet && !pending.length) {
      state.handled[incident.id] = { at: isoOf(now), done: true, summary: 'only archived or cutover-owned threads, no action' };
    } else if (pending.length) {
      log(`${incident.id}: ${pending.length} thread(s) not settled yet, summary waits`);
      state.handled[incident.id] = { ...entry, at: isoOf(now), done: false };
    } else {
      let sent = true;
      try {
        io.telegram({ text: summary.text, severity: summary.severity, key: `stream-recovery:${incident.id}` });
      } catch (err) {
        if (isRecoveryPaused(err)) throw err;
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
