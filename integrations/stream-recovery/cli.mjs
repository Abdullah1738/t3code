#!/usr/bin/env node
// stream-recovery: detect OpenCode event-stream drops in Robob and resume the
// threads they knocked out. Run `scan` every minute (LaunchAgent) or by hand.
import {
  findIncidents, planThread, buildNote, buildSummary, lostMessages, invisibleReply,
  assistantText, orphanStatus, sessionFromProviderThread, isNestedThreadId,
  providerThreadFor, robobNativeMessageId, truncate, toMs, hhmm,
} from './lib/detect.mjs';
import * as io from './lib/io.mjs';
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
    else if (a === '--since') opts.since = rest[++i];
    else if (a === '--max-age-hours') opts.maxAgeHours = Number(rest[++i]);
    else if (a === '--help' || a === '-h') opts.cmd = 'help';
    else throw new Error(`unknown option ${a}`);
  }
  if (opts.since && Number.isNaN(Date.parse(opts.since))) throw new Error(`bad --since ${opts.since}`);
  if (!(opts.maxAgeHours > 0)) throw new Error('bad --max-age-hours');
  return opts;
}

// With --json the report owns stdout, so log lines go to stderr.
let logToStderr = false;
const log = (...parts) => (logToStderr ? console.error : console.log)(new Date().toISOString(), ...parts);

function topParent(db, threadId) {
  let t = threadId;
  for (let i = 0; i < 5 && t && isNestedThreadId(t); i++) t = io.subagentParent(db, providerThreadFor(t));
  return t && !isNestedThreadId(t) ? t : null;
}

async function safe(fn, fallback) {
  try { return await fn(); } catch { return fallback; }
}

async function gatherThread({ db, incident, threadId, active, now, verbose }) {
  const thread = await io.getThread(threadId);
  if (!thread) return null;
  const failed = incident.runs.filter((r) => r.thread_id === threadId);
  const maxOrdinal = failed.reduce((m, r) => Math.max(m, r.ordinal), -1);
  const recovered = failed.length > 0
    && io.laterRuns(db, threadId, maxOrdinal).some((r) => r.status === 'running' || r.status === 'completed');
  const queued = io.queuedRuns(db, threadId).filter((r) => r.held);
  const staleHeld = queued.filter((r) => toMs(r.requested_at) < incident.startMs - STALE_HELD_MS);
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

  const ses = thread.nativeSessionId || null;
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
  return { thread, plan, failed, recovered, held, staleHeld, lost, reply, orphans, forms };
}

async function act({ db, incident, g, dryRun }) {
  const { plan } = g;
  const res = { plan, ok: true, queueOk: null, lost: g.lost, reply: g.reply, forms: g.forms, error: null };
  if (plan.action === 'skip' || plan.action === 'report') {
    if (!plan.resumeQueue) return res;
  }
  if (dryRun) return res;
  try {
    io.assertReplicaFresh(db);
    const fresh = await io.getThread(plan.threadId);
    if (!fresh || fresh.archived || fresh.latestRunId !== g.thread.latestRunId
      || fresh.nativeSessionId !== g.thread.nativeSessionId || fresh.pendingRequest) {
      throw new Error('thread changed during recovery; retry next scan');
    }
    io.assertThreadInReplica(db, fresh);
    if (plan.resumeQueue || g.staleHeld.length) {
      for (const r of g.staleHeld) {
        io.assertReplicaFresh(db);
        await io.dispatchCommand({ type: 'queued-run.cancel', commandId: `${incident.id}:cancel:${r.run_id}`, threadId: plan.threadId, runId: r.run_id });
      }
      if (g.held.length) {
        io.assertReplicaFresh(db);
        await io.dispatchCommand({ type: 'queue.resume', commandId: `${incident.id}:resume:${plan.threadId}`, threadId: plan.threadId });
      }
      res.queueOk = true;
    }
    if (plan.action === 'note') {
      const text = buildNote({
        incident, plan, lost: g.lost, reply: g.reply, orphans: g.orphans, forms: g.forms,
        held: g.held, recovered: g.recovered, ocUrl: io.OC_URL,
      });
      io.assertReplicaFresh(db);
      await io.sendToThread(plan.threadId, text, { clientRequestId: incident.id, mode: 'queue' });
    }
  } catch (err) {
    if (err.code === 'REPLICA_UNAVAILABLE') throw err;
    res.ok = false;
    res.error = String(err?.message || err).slice(0, 300);
    if (res.queueOk === null && (plan.resumeQueue || g.staleHeld.length)) res.queueOk = false;
  }
  return res;
}

async function recoveryScan({ opts, state, now }) {
  let db;
  try {
    const report = [];
    const floor = now - opts.maxAgeHours * 3600_000;
    const last = state.lastScan ? Date.parse(state.lastScan) - 60 * 60_000 : floor;
    const sinceMs = opts.since ? Date.parse(opts.since) : Math.max(floor, last);
    const sinceIso = new Date(sinceMs).toISOString();
    db = io.openDb(io.PATHS.db);
    // Restart recovery owns failures inside its window. Do it first so a
    // failed run cannot get both a stream-loss note and a restart note.
    const restartSince = opts.since ? sinceIso
      : new Date(Math.max(floor, state.lastScan ? Date.parse(state.lastScan) - RESTART_LOOKBACK_MS : floor)).toISOString();
    const restarts = await restartScan({
      db, state, now, sinceIso: restartSince, floorMs: floor, dryRun: opts.dryRun, seed: opts.seed, verbose: opts.verbose, log,
    });
    const runs = io.failedRunsSince(db, sinceIso);
    const subs = io.failedSubagentsSince(db, sinceIso);
    const signals = [
      ...runs.filter((r) => !restarts.runIds.has(r.run_id)).map((r) => ({ ...r, kind: 'run', at: r.completed_at, threadId: r.thread_id })),
      ...subs.filter((s) => !restarts.runIds.has(s.run_id)).map((s) => ({ ...s, kind: 'subagent', at: s.completed_at })),
    ];
    const incidents = findIncidents(signals);
    if (opts.verbose) log(`since ${sinceIso}: ${runs.length} failed runs, ${subs.length} failed subagents, ${incidents.length} incident(s)`);
    for (const incident of incidents) {
      const prev = state.handled[incident.id];
      if (prev?.done) { if (opts.verbose) log(`${incident.id}: already handled`); continue; }
      if (now - incident.endMs < SETTLE_MS) { log(`${incident.id}: still settling`); continue; }
      if (incident.endMs < floor) {
        if (!opts.dryRun) state.handled[incident.id] = { at: new Date(now).toISOString(), done: true, summary: 'too old, skipped' };
        continue;
      }
      if (opts.seed) {
        state.handled[incident.id] = { at: new Date(now).toISOString(), done: true, summary: 'seeded' };
        log(`${incident.id}: seeded (no action)`);
        continue;
      }
      for (const s of incident.subagents) s.parentThreadId = topParent(db, s.thread_id);
      const threadIds = [...new Set([
        ...incident.runs.map((r) => r.thread_id),
        ...incident.subagents.map((s) => s.parentThreadId).filter(Boolean),
      ])];
      const active = await safe(() => io.activeSessions(), new Set());
      log(`${incident.id}: drop at ${hhmm(incident.failAllMs)}, ${incident.runs.length} runs, ${incident.subagents.length} subagents, ${threadIds.length} threads${opts.dryRun ? ' (dry run)' : ''}`);
      const results = [];
      for (const threadId of threadIds) {
        let g = null;
        try {
          g = await gatherThread({ db, incident, threadId, active, now, verbose: opts.verbose });
        } catch (err) {
          if (err.code === 'REPLICA_UNAVAILABLE') throw err;
          results.push({ plan: { threadId, title: threadId, action: 'skip', reason: 'error' }, ok: false, error: String(err?.message || err).slice(0, 300), lost: [], forms: [] });
          log(`  ${threadId}: gather failed: ${err?.message || err}`);
          continue;
        }
        if (!g) { if (opts.verbose) log(`  ${threadId}: not found in Robob`); continue; }
        const res = await act({ db, incident, g, dryRun: opts.dryRun });
        results.push(res);
        const p = g.plan;
        log(`  ${p.action.padEnd(7)} ${threadId} | ${truncate(p.title || '', 60)} | ${p.reason}`
          + `${g.lost.length ? ` | lost ${g.lost.length}` : ''}${g.orphans.length ? ` | orphans ${g.orphans.map((o) => o.status).join(',')}` : ''}`
          + `${g.forms.length ? ` | forms ${g.forms.length}` : ''}${g.held.length ? ` | held ${g.held.length}` : ''}${g.staleHeld.length ? ` | stale held ${g.staleHeld.length}` : ''}`
          + `${g.reply ? ' | invisible reply' : ''}${res.error ? ` | ERROR ${res.error}` : ''}`);
      }
      io.assertReplicaFresh(db);
      const summary = buildSummary({ incident, results });
      if (opts.dryRun) {
        log(`summary (${summary.severity}):\n${summary.text}`);
      } else {
        let sent = true;
        try { io.telegram({ text: summary.text, severity: summary.severity, key: `stream-recovery:${incident.id}` }); }
        catch (err) { sent = false; log(`telegram failed: ${err?.message || err}`); }
        const errors = results.filter((r) => r.error).length;
        const attempts = (prev?.attempts || 0) + 1;
        state.handled[incident.id] = {
          at: new Date(now).toISOString(), attempts, errors, telegram: sent,
          done: (errors === 0 && sent) || attempts >= MAX_ATTEMPTS,
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

async function scan(opts) {
  const now = Date.now();
  const release = opts.dryRun ? () => {} : io.acquireLock(now);
  if (!release) { log('another scan is running, skipping'); return; }
  try {
    const state = io.loadState();
    let recovery = { incidents: [], restarts: [] }, recoveryError = null;
    try {
      recovery = await recoveryScan({ opts, state, now });
    } catch (err) {
      recoveryError = err;
      log(`recovery deferred: ${err?.message || err}`);
    }
    let stalls = [];
    // Scans run every 15s so restarts are picked up fast; the stall watch reads
    // every active OpenCode session, so it keeps its once-a-minute pace.
    const stallDue = !state.lastStallScan || now - Date.parse(state.lastStallScan) >= STALL_EVERY_MS;
    if (!opts.seed && (stallDue || opts.dryRun)) {
      try {
        if (!opts.dryRun) state.lastStallScan = new Date(now).toISOString();
        stalls = await stallScan({ state, now, dryRun: opts.dryRun, verbose: opts.verbose, log });
      } catch (err) {
        log(`stall watch failed: ${err?.message || err}`);
      }
    }
    if (!opts.dryRun) {
      if (!recoveryError) state.lastScan = new Date(now).toISOString();
      io.saveState(state, now);
    }
    if (opts.json) console.log(JSON.stringify({ ...recovery, stalls,
      ...(recoveryError ? { recoveryError: String(recoveryError?.message || recoveryError) } : {}) }, null, 2));
    if (recoveryError) throw recoveryError;
  } finally {
    release();
  }
}

function status() {
  const state = io.loadState();
  console.log(`last scan: ${state.lastScan || 'never'}`);
  for (const [id, h] of Object.entries(state.handled).sort()) {
    console.log(`${id}  ${h.done ? 'done' : 'retrying'}  ${h.at}  ${h.summary || ''}`);
  }
  for (const [id, s] of Object.entries(state.stalls).sort()) {
    console.log(`${id}  ${s.done ? s.outcome : 'following up'}  ${s.at}  ${s.summary || `${s.action} | ${s.title}`}`);
  }
}

const HELP = `usage: stream-recovery scan [--dry-run] [--since ISO] [--max-age-hours N] [--seed] [--json] [--verbose]
       stream-recovery status`;

try {
  const opts = parseArgs(process.argv.slice(2));
  logToStderr = opts.json;
  if (opts.cmd === 'scan') await scan(opts);
  else if (opts.cmd === 'status') status();
  else { console.log(HELP); process.exitCode = opts.cmd === 'help' ? 0 : 2; }
} catch (err) {
  console.error(new Date().toISOString(), 'stream-recovery error:', err?.stack || err);
  process.exitCode = 1;
}
