#!/usr/bin/env node
// stream-recovery: detect OpenCode event-stream drops in Robob and resume the
// threads they knocked out. Run `scan` every minute (LaunchAgent) or by hand.
import {
  findIncidents, planThread, buildNote, buildSummary, lostMessages, invisibleReply,
  assistantText, orphanStatus, sessionFromProviderThread, isNestedThreadId,
  providerThreadFor, robobNativeMessageId, truncate, toMs, hhmm,
} from './lib/detect.mjs';
import { assertRecoveryActive, guardRecoveryIo, isRecoveryPaused, recoveryElapsed, recoveryFloor, controlStatus, pauseRecovery, resumeRecovery, parseDuration } from './lib/pause.mjs';
import * as realIo from './lib/io.mjs';
import { pathToFileURL } from 'node:url';
import { openCodeSession, recoveryOwned } from './lib/harness.mjs';
import { stallScan } from './lib/stallwatch.mjs';
import { restartScan } from './lib/restartwatch.mjs';

const SETTLE_MS = 90_000;
const STALE_HELD_MS = 24 * 3600_000;
const MAX_ATTEMPTS = 3;
const RESTART_LOOKBACK_MS = 3 * 3600_000;
const STALL_EVERY_MS = 55_000;

function parseArgs(argv) {
  const [cmd = 'scan', ...rest] = argv;
  const opts = { cmd, dryRun: false, since: null, maxAgeHours: 6, seed: false, json: false, verbose: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--seed') opts.seed = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--verbose') opts.verbose = true;
    else if (a === '--for') { opts.durationMs = parseDuration(rest[++i]); }
    else if (a === '--reason') {
      if (rest[i + 1] === undefined || rest[i + 1].startsWith('--')) throw new Error('missing --reason');
      opts.reason = rest[++i];
    }
    else if (a === '--since') opts.since = rest[++i];
    else if (a === '--max-age-hours') opts.maxAgeHours = Number(rest[++i]);
    else if (a === '--help' || a === '-h') opts.cmd = 'help';
    else throw new Error(`unknown option ${a}`);
  }
  if (opts.cmd !== 'pause' && (opts.durationMs !== undefined || opts.reason !== undefined)) throw new Error('--for and --reason require pause');
  if (opts.since && Number.isNaN(Date.parse(opts.since))) throw new Error(`bad --since ${opts.since}`);
  if (!(opts.maxAgeHours > 0)) throw new Error('bad --max-age-hours');
  return opts;
}

// With --json the report owns stdout, so log lines go to stderr.
let logToStderr = false;
const log = (...parts) => (logToStderr ? console.error : console.log)(new Date().toISOString(), ...parts);

function topParent(io, db, threadId) {
  let t = threadId;
  const seen = new Set();
  while (t && isNestedThreadId(t) && !seen.has(t)) {
    seen.add(t);
    t = io.subagentParent(db, providerThreadFor(t));
  }
  return t && !isNestedThreadId(t) ? t : null;
}

async function safe(fn, fallback) {
  try { return await fn(); } catch { return fallback; }
}

export async function gatherThread({ db, incident, threadId, active, now, verbose }, io = realIo) {
  const thread = await io.getThread(threadId);
  if (!thread) return null;
  const failed = incident.runs.filter((r) => r.thread_id === threadId);
  const sourceRuns = [...failed, ...incident.subagents.filter((s) => s.parentThreadId === threadId)].map((r) => r.run_id);
  const owned = await recoveryOwned(io, threadId, sourceRuns);
  if (owned || !openCodeSession(thread)) {
    return { thread, sourceRuns, plan: { threadId, title: thread.title, action: 'skip', resumeQueue: false,
      reason: owned ? 'harness cutover owns continuation' : 'not a current OpenCode session' },
    lost: [], reply: null, forms: [], orphans: [], held: [], staleHeld: [] };
  }
  const maxOrdinal = failed.reduce((m, r) => Math.max(m, r.ordinal), -1);
  const recovered = failed.length > 0
    && io.laterRuns(db, threadId, maxOrdinal).some((r) => r.status === 'running' || r.status === 'completed');
  const queued = io.queuedRuns(db, threadId).filter((r) => r.held);
  const staleHeld = queued.filter((r) => recoveryElapsed(io, toMs(r.requested_at), incident.startMs) > STALE_HELD_MS
    && r.user_message_id?.startsWith(`ardud-control:send:${threadId}:coord%3A`)
    && /^\[coord[\] ]/.test(io.messageText(db, r.user_message_id) ?? ''));
  const held = queued.filter((r) => !staleHeld.includes(r))
    .map((r) => ({ ...r, text: io.messageText(db, r.user_message_id) }));

  // Archived threads need no OpenCode reads (the slow part of a scan).
  if (thread.archived) {
    const plan = planThread({
      thread: { threadId, title: thread.title, origin: thread.origin, archived: thread.archived, nativeSessionId: thread.nativeSessionId },
      failedRuns: failed.map((r) => ({ completedAt: r.completed_at })),
      recovered, held,
    });
    return { thread, plan, failed, recovered, held, staleHeld, lost: [], reply: null, orphans: [], forms: [] };
  }

  const ses = openCodeSession(thread);
  let session = null;
  let lost = [];
  let reply = null;
  if (ses) {
    const info = await safe(() => io.ocSession(ses), null);
    session = { active: active.has(ses), updatedMs: toMs(info?.time?.updated) || null };
    if (failed.length) {
      const firstReq = Math.min(...failed.map((r) => toMs(r.requested_at)));
      const oc = await safe(() => io.ocMessages(ses, { type: 'user', stopBeforeMs: firstReq - 60_000 }), null);
      if (oc?.complete) {
        const ocUser = oc.messages.map((m) => ({ id: m.id, text: m.text ?? assistantText(m) }));
        for (const run of failed) {
          // Provider-made user rows (subagent/shell completions) live in OpenCode as
          // synthetic messages, not prompts, so they can never be "lost".
          const robobMessages = io.runMessages(db, run.run_id)
            .filter((m) => m.role === 'user' && m.creation_source !== 'provider' && !String(m.text || '').startsWith('<subagent '))
            .map((m) => ({ messageId: m.message_id, text: m.text, createdAt: m.created_at, primary: m.message_id === run.user_message_id }));
          lost.push(...lostMessages({ sessionId: ses, attemptId: run.attempt, robobMessages, ocUserMessages: ocUser }));
        }
      } else if (verbose) log(`  ${threadId}: OpenCode history incomplete, lost-message check skipped`);
    }
    if (!session.active) {
      const sinceMs = incident.startMs - 15 * 60_000;
      const oc = await safe(() => io.ocMessages(ses, { type: 'assistant', stopBeforeMs: sinceMs, maxPages: 2 }), null);
      if (oc) {
        const ids = new Set(io.threadMessageIdsSince(db, threadId, new Date(sinceMs).toISOString())
          .map(robobNativeMessageId).filter(Boolean));
        reply = invisibleReply({ ocMessages: oc.messages, sinceMs, untilMs: now, robobNativeIds: ids });
      }
    }
  }

  const orphans = [];
  for (const sub of incident.subagents) {
    if (sub.parentThreadId !== threadId) continue;
    const child = sessionFromProviderThread(sub.provider_thread_id);
    if (!child) continue;
    const info = await safe(() => io.ocSession(child), null);
    const updatedMs = toMs(info?.time?.updated) || null;
    const status = orphanStatus({ active: active.has(child), updatedMs, failAllMs: incident.failAllMs });
    let excerpt = null;
    if (status === 'finished') {
      const oc = await safe(() => io.ocMessages(child, { type: 'assistant', limit: 5, maxPages: 1 }), null);
      const last = oc?.messages.find((m) => assistantText(m).trim());
      excerpt = last ? truncate(assistantText(last).trim(), 400) : null;
    }
    orphans.push({
      sessionId: child, title: sub.title, status, updatedMs, excerpt,
      nestedUnder: isNestedThreadId(sub.thread_id) ? sessionFromProviderThread(sub.thread_id) : null,
    });
  }

  const forms = [];
  const formSessions = [ses, ...orphans.filter((o) => o.status === 'running').map((o) => o.sessionId)].filter(Boolean);
  for (const s of formSessions) {
    for (const f of await safe(() => io.ocForms(s), [])) {
      forms.push({
        sessionId: s, formId: f.id, title: f.title ?? f.fields?.[0]?.title ?? 'question',
        fields: (f.fields || []).map((x) => ({ key: x.key, title: x.title, description: x.description, options: x.options || [] })),
      });
    }
  }

  const plan = planThread({
    thread: { threadId, title: thread.title, origin: thread.origin, archived: thread.archived, nativeSessionId: ses },
    failedRuns: failed.map((r) => ({ completedAt: r.completed_at })),
    recovered, session, lost, reply, orphans, forms, held,
  });
  return { thread, sourceRuns, plan, failed, recovered, held, staleHeld, lost, reply, orphans, forms };
}

export async function act({ db, incident, g, dryRun, progress = {}, save = () => {} }, io = realIo) {
  assertRecoveryActive(io);
  io = guardRecoveryIo(io);
  const { plan } = g;
  const res = { plan, ok: true, queueOk: progress.queueOk ?? null, lost: g.lost, reply: g.reply, forms: g.forms, error: null };
  if (plan.action === 'skip' || plan.action === 'report') {
    if (!plan.resumeQueue) return res;
  }
  if (dryRun) return res;
  try {
    if (await recoveryOwned(io, plan.threadId, g.sourceRuns)) {
      res.plan = { ...plan, action: 'skip', resumeQueue: false, reason: 'harness cutover owns continuation' };
      return res;
    }
    io.assertReplicaFresh(db);
    const fresh = await io.getThread(plan.threadId);
    if (!fresh || openCodeSession(fresh) !== openCodeSession(g.thread)) {
      res.plan = { ...plan, action: 'skip', resumeQueue: false, reason: 'provider changed during recovery' };
      return res;
    }
    if (fresh.archived || fresh.latestRunId !== g.thread.latestRunId
      || fresh.nativeSessionId !== g.thread.nativeSessionId || fresh.pendingRequest) {
      throw new Error('thread changed during recovery; retry next scan');
    }
    io.assertThreadInReplica(db, fresh);
    if (await recoveryOwned(io, plan.threadId, g.sourceRuns)) {
      res.plan = { ...plan, action: 'skip', resumeQueue: false, reason: 'harness cutover owns continuation' };
      return res;
    }
    if (!progress.queueOk && (plan.resumeQueue || g.staleHeld.length)) {
      for (const r of g.staleHeld) {
        io.assertReplicaFresh(db);
        await io.dispatchCommand({ type: 'queued-run.cancel', commandId: `${incident.id}:cancel:${r.run_id}`, threadId: plan.threadId, runId: r.run_id });
      }
      if (g.held.length) {
        io.assertReplicaFresh(db);
        await io.dispatchCommand({ type: 'queue.resume', commandId: `${incident.id}:resume:${plan.threadId}`, threadId: plan.threadId });
      }
      progress.queueOk = res.queueOk = true;
      save();
    }
    if (plan.action === 'note' && !progress.noteSent) {
      const text = buildNote({
        incident, plan, lost: g.lost, reply: g.reply, orphans: g.orphans, forms: g.forms,
        held: g.held, recovered: g.recovered, ocUrl: io.OC_URL,
      });
      io.assertReplicaFresh(db);
      await io.sendToThread(plan.threadId, text, { clientRequestId: incident.id, mode: 'queue' });
      progress.noteSent = true;
      save();
    }
  } catch (err) {
    if (err.code === 'REPLICA_UNAVAILABLE' || isRecoveryPaused(err)) throw err;
    res.ok = false;
    res.error = String(err?.message || err).slice(0, 300);
    if (res.queueOk === null && (plan.resumeQueue || g.staleHeld.length)) res.queueOk = false;
  }
  return res;
}

export async function recoveryScan({ opts, state, now }, io = realIo) {
  assertRecoveryActive(io);
  io = guardRecoveryIo(io);
  let db;
  try {
    const report = [];
    const floor = recoveryFloor(io, now, opts.maxAgeHours * 3600_000);
    const last = state.lastScan ? recoveryFloor(io, Date.parse(state.lastScan), 60 * 60_000) : floor;
    const sinceMs = opts.since ? Date.parse(opts.since) : Math.max(floor, last);
    const sinceIso = new Date(sinceMs).toISOString();
    db = io.openDb(io.PATHS.db);
    // Restart recovery owns failures inside its window. Do it first so a
    // failed run cannot get both a stream-loss note and a restart note.
    const restartSince = opts.since ? sinceIso
      : new Date(Math.max(floor, state.lastScan ? recoveryFloor(io, Date.parse(state.lastScan), RESTART_LOOKBACK_MS) : floor)).toISOString();
    const restarts = await restartScan({
      db, state, now, sinceIso: restartSince, floorMs: floor, dryRun: opts.dryRun, seed: opts.seed, verbose: opts.verbose, log,
    }, io);
    const runs = io.failedRunsSince(db, sinceIso);
    const subs = io.failedSubagentsSince(db, sinceIso);
    const signals = [
      ...runs.filter((r) => !restarts.runIds.has(r.run_id)).map((r) => ({ ...r, kind: 'run', at: r.completed_at, threadId: r.thread_id })),
      ...subs.filter((s) => !restarts.runIds.has(s.run_id)).map((s) => ({ ...s, kind: 'subagent', at: s.completed_at })),
    ];
    const incidents = findIncidents(signals);
    for (const [id, entry] of Object.entries(state.handled)) {
      if (!id.startsWith('rs-') && !entry.done && entry.incident && !incidents.some((i) => i.id === id)) incidents.push(entry.incident);
    }
    if (opts.verbose) log(`since ${sinceIso}: ${runs.length} failed runs, ${subs.length} failed subagents, ${incidents.length} incident(s)`);
    for (const incident of incidents) {
      assertRecoveryActive(io);
      const prev = state.handled[incident.id];
      if (prev?.done) { if (opts.verbose) log(`${incident.id}: already handled`); continue; }
      if (now - incident.endMs < SETTLE_MS) { log(`${incident.id}: still settling`); continue; }
      if (incident.endMs < floor && !prev?.incident) {
        if (!opts.dryRun) state.handled[incident.id] = { at: new Date(now).toISOString(), done: true, summary: 'too old, skipped' };
        continue;
      }
      if (opts.seed) {
        state.handled[incident.id] = { at: new Date(now).toISOString(), done: true, summary: 'seeded' };
        log(`${incident.id}: seeded (no action)`);
        continue;
      }
      for (const s of incident.subagents) s.parentThreadId = topParent(io, db, s.thread_id);
      const threadIds = [...new Set([
        ...incident.runs.map((r) => r.thread_id),
        ...incident.subagents.map((s) => s.parentThreadId).filter(Boolean),
      ])];
      const active = await safe(() => io.activeSessions(), new Set());
      log(`${incident.id}: drop at ${hhmm(incident.failAllMs)}, ${incident.runs.length} runs, ${incident.subagents.length} subagents, ${threadIds.length} threads${opts.dryRun ? ' (dry run)' : ''}`);
      const results = [];
      const entry = { ...prev, incident, threads: { ...prev?.threads }, at: new Date(now).toISOString() };
      const save = () => { if (!opts.dryRun) { state.handled[incident.id] = entry; io.saveState(state, now); } };
      save();
      for (const threadId of threadIds) {
        const progress = entry.threads[threadId] ??= {};
        if (progress.done) { results.push(progress.result); continue; }
        let g = null;
        try {
          g = await gatherThread({ db, incident, threadId, active, now, verbose: opts.verbose }, io);
        } catch (err) {
          if (err.code === 'REPLICA_UNAVAILABLE' || isRecoveryPaused(err)) throw err;
          results.push({ plan: { threadId, title: threadId, action: 'skip', reason: 'error' }, ok: false, error: String(err?.message || err).slice(0, 300), lost: [], forms: [] });
          log(`  ${threadId}: gather failed: ${err?.message || err}`);
          continue;
        }
        if (!g) { if (opts.verbose) log(`  ${threadId}: not found in Robob`); continue; }
        const res = await act({ db, incident, g, dryRun: opts.dryRun, progress, save }, io);
        assertRecoveryActive(io);
        if (!opts.dryRun && res.ok) { progress.done = true; progress.result = res; save(); }
        results.push(res);
        const p = g.plan;
        log(`  ${p.action.padEnd(7)} ${threadId} | ${truncate(p.title || '', 60)} | ${p.reason}`
          + `${g.lost.length ? ` | lost ${g.lost.length}` : ''}${g.orphans.length ? ` | orphans ${g.orphans.map((o) => o.status).join(',')}` : ''}`
          + `${g.forms.length ? ` | forms ${g.forms.length}` : ''}${g.held.length ? ` | held ${g.held.length}` : ''}${g.staleHeld.length ? ` | stale held ${g.staleHeld.length}` : ''}`
          + `${g.reply ? ' | invisible reply' : ''}${res.error ? ` | ERROR ${res.error}` : ''}`);
      }
      assertRecoveryActive(io);
      io.assertReplicaFresh(db);
      const summary = buildSummary({ incident, results });
      if (opts.dryRun) {
        log(`summary (${summary.severity}):\n${summary.text}`);
      } else {
        let sent = true;
        try { io.telegram({ text: summary.text, severity: summary.severity, key: `stream-recovery:${incident.id}` }); }
        catch (err) { if (isRecoveryPaused(err)) throw err; sent = false; log(`telegram failed: ${err?.message || err}`); }
        const errors = results.filter((r) => r.error).length;
        const attempts = (prev?.attempts || 0) + 1;
        const done = (errors === 0 && sent) || attempts >= MAX_ATTEMPTS;
        state.handled[incident.id] = {
          ...(done ? {} : entry), at: new Date(now).toISOString(), attempts, errors, telegram: sent,
          done,
          summary: summary.text.split('\n')[0],
        };
      }
      report.push({ incident: { id: incident.id, startMs: incident.startMs, endMs: incident.endMs, failAllMs: incident.failAllMs }, results });
    }
    io.assertReplicaFresh(db);
    return { incidents: report, restarts };
  } finally {
    db?.close();
  }
}

export async function scan(opts, io = realIo) {
  const now = io.now?.() ?? Date.now();
  const release = opts.dryRun ? () => {} : io.acquireLock(now);
  if (!release) { log('another scan is running, skipping'); return; }
  try {
    const state = io.loadState();
    try { assertRecoveryActive(io); } catch (err) {
      if (!isRecoveryPaused(err)) throw err;
      log(err.message);
      if (opts.json) console.log(JSON.stringify({ paused: true }));
      return;
    }
    let recovery = { incidents: [], restarts: [] }, recoveryError = null;
    try {
      recovery = await recoveryScan({ opts, state, now }, io);
    } catch (err) {
      recoveryError = err;
      log(`recovery deferred: ${err?.message || err}${isRecoveryPaused(err) ? "; already-sent mutations may complete; pending work retained" : ""}`);
    }
    let stalls = [];
    // Scans run every 15s so restarts are picked up fast; the stall watch reads
    // every active OpenCode session, so it keeps its once-a-minute pace.
    const stallDue = !state.lastStallScan || now - Date.parse(state.lastStallScan) >= STALL_EVERY_MS;
    if (!isRecoveryPaused(recoveryError) && !opts.seed && (stallDue || opts.dryRun)) {
      try {
        if (!opts.dryRun) state.lastStallScan = new Date(now).toISOString();
        stalls = await stallScan({ state, now, dryRun: opts.dryRun, verbose: opts.verbose, log }, io);
      } catch (err) {
        if (isRecoveryPaused(err)) recoveryError = err;
        log(`stall watch failed: ${err?.message || err}`);
      }
    }
    if (!opts.dryRun) {
      if (!recoveryError) state.lastScan = new Date(now).toISOString();
      io.saveState(state, now);
    }
    if (opts.json) console.log(JSON.stringify({ ...recovery, stalls,
      ...(recoveryError ? { recoveryError: String(recoveryError?.message || recoveryError) } : {}) }, null, 2));
    if (recoveryError && !isRecoveryPaused(recoveryError)) throw recoveryError;
  } finally {
    release();
  }
}

function status(opts, io = realIo) {
  const state = io.loadState();
  const control = controlStatus(io.readControl());
  const pending = Object.values(state.handled).filter((h) => !h.done);
  const pendingStalls = Object.values(state.stalls).filter((s) => !s.done);
  if (opts.json) {
    const pendingIds = pending.flatMap((h) => [...new Set([
      ...Object.keys(h.threads ?? {}), ...(h.incident?.runs ?? []).map((r) => r.thread_id),
      ...(h.incident?.subagents ?? []).map((s) => s.parentThreadId),
    ])].filter((id) => id && !h.threads?.[id]?.done));
    console.log(JSON.stringify({ ...control, pendingIncidents: pending.length + pendingStalls.length,
      pendingThreads: new Set([...pendingIds, ...pendingStalls.map((s) => s.threadId)].filter(Boolean)).size, lastSuccessfulScan: state.lastScan }));
    return;
  }
  console.log(`automatic recovery: ${control.paused ? `paused${control.until ? ` until ${control.until}` : " indefinitely"}${control.reason ? ` (${control.reason})` : ""}` : "enabled"}`);
  console.log(`last scan: ${state.lastScan || 'never'}`);
  for (const [id, h] of Object.entries(state.handled).sort()) {
    console.log(`${id}  ${h.done ? 'done' : 'retrying'}  ${h.at}  ${h.summary || ''}`);
  }
  for (const [id, s] of Object.entries(state.stalls).sort()) {
    console.log(`${id}  ${s.done ? s.outcome : 'following up'}  ${s.at}  ${s.summary || `${s.action} | ${s.title}`}`);
  }
}

const HELP = `usage: stream-recovery scan [--dry-run] [--since ISO] [--max-age-hours N] [--seed] [--json] [--verbose]
       stream-recovery pause [--for 30m|2h|1d] [--reason TEXT]
       stream-recovery resume
       stream-recovery status [--json]`;

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) try {
  const opts = parseArgs(process.argv.slice(2));
  logToStderr = opts.json;
  if (opts.cmd === 'scan') await scan(opts);
  else if (opts.cmd === 'status') status(opts);
  else if (opts.cmd === 'pause') {
    await pauseRecovery(realIo.PATHS.dataDir, { durationMs: opts.durationMs, reason: opts.reason });
    status(opts);
  } else if (opts.cmd === 'resume') {
    await resumeRecovery(realIo.PATHS.dataDir);
    status(opts);
  }
  else { console.log(HELP); process.exitCode = opts.cmd === 'help' ? 0 : 2; }
} catch (err) {
  console.error(new Date().toISOString(), 'stream-recovery error:', err?.stack || err);
  process.exitCode = 1;
}
